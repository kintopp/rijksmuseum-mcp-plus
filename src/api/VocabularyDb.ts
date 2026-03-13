import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import { escapeFts5, expandFtsQuery, resolveDbPath } from "../utils/db.js";

// ─── Types ───────────────────────────────────────────────────────────

/** Single value or array of values (array = AND/intersection). */
type StringOrArray = string | string[];

export interface PersonInfo {
  birthYear: number | null;
  deathYear: number | null;
  gender: string | null;
  bio: string | null;
  wikidataId: string | null;
}

// ─── find_similar types ──────────────────────────────────────────────

export interface SharedMotif {
  notation: string;
  label: string;
  weight: number;
}

export interface IconclassSimilarResult {
  queryObjectNumber: string;
  queryTitle: string;
  queryNotations: { notation: string; label: string; depth: number }[];
  results: {
    objectNumber: string;
    title: string;
    creator: string;
    date?: string;
    type?: string;
    score: number;
    sharedMotifs: SharedMotif[];
    url: string;
  }[];
  warnings?: string[];
}

export interface SharedLineage {
  qualifierLabel: string;
  creatorLabel: string;
  strength: number;
}

export interface LineageSimilarResult {
  queryObjectNumber: string;
  queryTitle: string;
  queryLineage: { qualifierLabel: string; creatorLabel: string; strength: number }[];
  results: {
    objectNumber: string;
    title: string;
    creator: string;
    date?: string;
    type?: string;
    score: number;
    sharedLineage: SharedLineage[];
    url: string;
  }[];
  warnings?: string[];
}

export interface SharedPerson {
  label: string;
  weight: number;
}

export interface DepictedPersonSimilarResult {
  queryObjectNumber: string;
  queryTitle: string;
  queryPersons: { label: string }[];
  results: {
    objectNumber: string;
    title: string;
    creator: string;
    date?: string;
    type?: string;
    score: number;
    sharedPersons: SharedPerson[];
    url: string;
  }[];
  warnings?: string[];
}

/** AAT qualifier URIs that carry visual-similarity signal, with strength weights.
 *  URI set is a subset of AAT_QUALIFIER_LABELS in types.ts — keep in sync. */
const LINEAGE_QUALIFIERS: ReadonlyMap<string, number> = new Map([
  ["http://vocab.getty.edu/aat/300404286", 3.0],  // after
  ["http://vocab.getty.edu/aat/300404287", 3.0],  // copyist of
  ["http://vocab.getty.edu/aat/300404274", 2.0],  // workshop of
  ["http://vocab.getty.edu/aat/300404283", 1.0],  // circle of (kring van)
  ["http://vocab.getty.edu/aat/300404284", 1.0],  // circle of (omgeving van) / school of
  ["http://vocab.getty.edu/aat/300404282", 1.0],  // follower of
]);

/** Iconclass noise labels to exclude — high-frequency categorical artefacts, not iconographic signals. */
const ICONCLASS_NOISE_LABELS = new Set([
  "historical persons",
  "historical persons - BB - woman",
  "adult man",
  "adult woman",
]);

/** Format earliest/latest date integers into a display string (e.g. "1642" or "1640–1650"). */
export function formatDateRange(earliest: number | null | undefined, latest: number | null | undefined): string | undefined {
  if (earliest == null) return undefined;
  return earliest === latest ? String(earliest) : `${earliest}–${latest}`;
}

export interface VocabSearchParams {
  subject?: StringOrArray;
  iconclass?: StringOrArray;
  depictedPerson?: StringOrArray;
  depictedPlace?: StringOrArray;
  productionPlace?: StringOrArray;
  birthPlace?: StringOrArray;
  deathPlace?: StringOrArray;
  profession?: StringOrArray;
  material?: StringOrArray;
  technique?: StringOrArray;
  type?: StringOrArray;
  creator?: StringOrArray;
  collectionSet?: StringOrArray;
  license?: string;
  // Tier 2 fields (require vocabulary DB v1.0+)
  description?: string;
  inscription?: string;
  provenance?: string;
  creditLine?: string;
  curatorialNarrative?: string;
  productionRole?: StringOrArray;
  attributionQualifier?: StringOrArray;
  minHeight?: number;
  maxHeight?: number;
  minWidth?: number;
  maxWidth?: number;
  // Date and title filters (require vocabulary DB with date/title columns)
  creationDate?: string;
  dateMatch?: "overlaps" | "within" | "midpoint";
  title?: string;
  // Geo proximity search (require geocoded vocabulary DB)
  nearPlace?: string;
  nearLat?: number;
  nearLon?: number;
  nearPlaceRadius?: number;
  // Image availability (requires vocabulary DB v0.19+ with has_image column)
  imageAvailable?: boolean;
  // Broad person search (searches both depicted persons and creators)
  aboutActor?: string;
  // Creator demographic filters (require person enrichment columns)
  creatorGender?: string;
  creatorBornAfter?: number;
  creatorBornBefore?: number;
  // Place hierarchy expansion
  expandPlaceHierarchy?: boolean;
  maxResults?: number;
  facets?: string[];
}

export interface VocabSearchResult {
  totalResults?: number;
  referencePlace?: string;
  results: {
    objectNumber: string;
    title: string;
    creator: string;
    date?: string;
    type?: string;
    url: string;
    nearestPlace?: string;
    distance_km?: number;
  }[];
  source: "vocabulary";
  warnings?: string[];
  facets?: Record<string, Array<{ label: string; count: number }>>;
}

// ─── Filter definitions ─────────────────────────────────────────────
// Each entry maps a VocabSearchParams key to the SQL constraints used
// in a mapping subquery.  `fields` restricts m.field, `vocabType`
// restricts v.type, and `matchMode` controls exact vs LIKE matching.

const ALLOWED_FIELDS = new Set([
  "subject", "spatial", "material", "technique", "type", "creator",
  "birth_place", "death_place", "profession", "collection_set",
  "production_role", "attribution_qualifier",
]);
const ALLOWED_VOCAB_TYPES = new Set(["person", "place", "classification", "set"]);

const DEFAULT_MAX_RESULTS = 25;
const MAX_RESULTS_CAP = 100;

interface VocabFilter {
  param: keyof VocabSearchParams;
  fields: string[];
  vocabType?: string;
  matchMode: "like" | "like-word" | "exact-notation";
  /** When FTS5 is available, upgrade this mode to FTS5 instead. */
  ftsUpgrade?: boolean;
}

const VOCAB_FILTERS: VocabFilter[] = [
  { param: "iconclass",      fields: ["subject"],               matchMode: "exact-notation" },
  { param: "subject",        fields: ["subject"],               matchMode: "like-word",  ftsUpgrade: true },
  { param: "depictedPerson", fields: ["subject"],               matchMode: "like", vocabType: "person",         ftsUpgrade: true },
  { param: "depictedPlace",  fields: ["subject", "spatial"],    matchMode: "like", vocabType: "place",          ftsUpgrade: true },
  { param: "productionPlace",fields: ["spatial"],               matchMode: "like", vocabType: "place",          ftsUpgrade: true },
  { param: "birthPlace",     fields: ["birth_place"],           matchMode: "like", vocabType: "place",          ftsUpgrade: true },
  { param: "deathPlace",     fields: ["death_place"],           matchMode: "like", vocabType: "place",          ftsUpgrade: true },
  { param: "profession",     fields: ["profession"],            matchMode: "like", vocabType: "classification", ftsUpgrade: true },
  { param: "material",       fields: ["material"],              matchMode: "like",                               ftsUpgrade: true },
  { param: "technique",      fields: ["technique"],             matchMode: "like",                               ftsUpgrade: true },
  { param: "type",           fields: ["type"],                  matchMode: "like",                               ftsUpgrade: true },
  { param: "creator",        fields: ["creator"],               matchMode: "like",                               ftsUpgrade: true },
  { param: "collectionSet",  fields: ["collection_set"],        matchMode: "like", vocabType: "set",            ftsUpgrade: true },
  { param: "productionRole",fields: ["production_role"],        matchMode: "like",                               ftsUpgrade: true },
  { param: "attributionQualifier", fields: ["attribution_qualifier"], matchMode: "like",                       ftsUpgrade: true },
  { param: "aboutActor",   fields: ["subject", "creator"],    matchMode: "like", vocabType: "person",         ftsUpgrade: true },
];

/**
 * Parameter keys eligible for filterArtIds — all VOCAB_FILTERS params plus direct-column filters.
 * Used by semantic_search to forward structured filters. Excludes text FTS, geo, and dimensions.
 */
export const FILTER_ART_IDS_KEYS: ReadonlySet<string> = new Set([
  ...VOCAB_FILTERS.map(f => f.param),
  "imageAvailable",
  "creationDate",
  "creatorGender",
  "creatorBornAfter",
  "creatorBornBefore",
]);

/** Row shape returned by place-candidate queries (findPlaceCandidates, resolveMultiWordPlace). */
type PlaceCandidateRow = {
  id: string;
  label_en: string | null;
  label_nl: string | null;
  lat: number | null;
  lon: number | null;
};

// Exported for testing
/** Haversine distance in km between two lat/lon points. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
    Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// Exported for testing
/** Pluralize a count: `pluralize(3, "place") → "3 places"`. */
export function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : (noun.endsWith("ch") || noun.endsWith("s") ? "es" : "s")}`;
}

/**
 * Rank place candidates by distance to a reference point, keeping only those
 * within `radiusKm`. If none are within radius, the closest candidate is kept.
 * Returns IDs of the surviving candidates.
 */
function rankByProximity(
  candidates: PlaceCandidateRow[],
  refLat: number,
  refLon: number,
  radiusKm: number = 100,
): { ids: string[]; geocodedCount: number } {
  const ranked = candidates
    .filter((c) => c.lat != null && c.lon != null)
    .map((c) => ({
      id: c.id,
      dist: haversineKm(refLat, refLon, c.lat!, c.lon!),
    }))
    .sort((a, b) => a.dist - b.dist);

  if (ranked.length === 0) return { ids: [], geocodedCount: 0 };

  const withinRadius = ranked.filter((r) => r.dist <= radiusKm).map((r) => r.id);
  const ids = withinRadius.length > 0 ? withinRadius : [ranked[0].id];
  return { ids, geocodedCount: ranked.length };
}

// Exported for testing
/**
 * Build a warning message for multi-word place interpretation.
 * Three variants: geo-filtered (with context coords), unresolved context, no context.
 */
export function buildMultiWordPlaceWarning(
  prefix: string,
  namePart: string,
  contextPart: string,
  candidateCount: number,
  geo?: { filteredCount: number; geocodedCount: number },
): string {
  const base = `${prefix} → No exact match. Interpreted as "${namePart}"`;

  if (geo) {
    return `${base} near "${contextPart}" — filtered to ${geo.filteredCount} of ${pluralize(geo.geocodedCount, "geocoded place")}.`;
  }
  if (contextPart) {
    return `${base} (could not resolve context "${contextPart}"). ${pluralize(candidateCount, "ambiguous match")}.`;
  }
  return `${base}. ${pluralize(candidateCount, "match")}.`;
}

/** Format a number with ordinal suffix: 1→"1st", 2→"2nd", 17→"17th". */
function ordinal(n: number): string {
  const abs = Math.abs(n);
  const suffixes = ["th", "st", "nd", "rd"];
  const v = abs % 100;
  return `${abs}${suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]}`;
}

function emptyResult(warnings?: string[]): VocabSearchResult {
  return {
    totalResults: 0,
    results: [],
    source: "vocabulary",
    ...(warnings && warnings.length > 0 && { warnings }),
  };
}

// Exported for testing
/**
 * Parse a creationDate wildcard string into an integer year range.
 * - "1642"  → { earliest: 1642, latest: 1642 }
 * - "164*"  → { earliest: 1640, latest: 1649 }
 * - "16*"   → { earliest: 1600, latest: 1699 }
 * - "-5*"   → { earliest: -5999, latest: -5000 } (BCE, 4-digit convention)
 */
export function parseDateFilter(creationDate: string): { earliest: number; latest: number } | null {
  const trimmed = creationDate.trim();
  if (!trimmed) return null;

  if (trimmed.endsWith("*")) {
    const prefix = trimmed.slice(0, -1);
    if (!prefix || !/^-?\d+$/.test(prefix)) return null;
    const isNegative = prefix.startsWith("-");
    const magnitude = isNegative ? prefix.slice(1) : prefix;
    if (!magnitude) return null;
    const wildcardDigits = 4 - magnitude.length;
    if (wildcardDigits <= 0) return null;
    const multiplier = 10 ** wildcardDigits;
    const magNum = parseInt(magnitude, 10);
    const posEarliest = magNum * multiplier;
    const posLatest = posEarliest + multiplier - 1;
    if (isNegative) {
      // BCE: -5* covers -59 to -50 (algebraically: earliest is more negative)
      return { earliest: -posLatest, latest: -posEarliest };
    }
    return { earliest: posEarliest, latest: posLatest };
  }

  // Exact year
  if (/^-?\d+$/.test(trimmed)) {
    const year = parseInt(trimmed, 10);
    return { earliest: year, latest: year };
  }

  return null;
}

// ─── VocabularyDb ────────────────────────────────────────────────────

export class VocabularyDb {
  private db: DatabaseType | null = null;
  private hasFts5 = false;
  private hasTextFts = false;
  private hasDimensions = false;
  private hasDates = false;
  private hasNormLabels = false;
  private hasCoordinates = false;
  private hasIntMappings = false;
  private hasRightsLookup = false;
  private hasPersonNames = false;
  private hasImageColumn = false;
  private hasImportance = false;
  private fieldIdMap = new Map<string, number>();
  private stmtLookupArtwork: Statement | null = null;
  private stmtLookupPersonInfo: Statement | null = null;
  private stmtLookupIiifId: Statement | null = null;
  private stmtFilterArtIds = new Map<string, Statement>();

  // ── find_similar shared ──
  private stmtLookupArtId: Statement | null = null; // cached: art_id + title + creator_label by object_number
  // ── find_similar caches (initialised lazily on first call) ──
  private notationDf: Map<number, number> | null = null; // vocab_rowid → document frequency
  private iconclassN = 0; // total artworks with any Iconclass notation
  private stmtIconclassShared: Statement | null = null; // cached: artwork_id by field_id+vocab_rowid
  private lineageCreatorDf: Map<number, number> | null = null; // creator vocab_rowid → df
  private lineageN = 0; // total artworks with any visual-lineage qualifier
  private lineageQualifierMap: Map<number, { label: string; strength: number }> | null = null; // vocab_rowid → info
  private stmtLineageShared: Statement | null = null; // cached: artwork_id by qualifier+creator pair
  private iconclassNoiseIds: Set<number> | null = null; // vocab_rowids to exclude
  // ── depicted person caches ──
  private personDf: Map<number, number> | null = null; // person vocab_rowid → df
  private personN = 0; // total artworks with any depicted person
  private stmtPersonShared: Statement | null = null;

  /** Look up a field_id by name, throwing if missing. */
  private requireFieldId(name: string): number {
    const id = this.fieldIdMap.get(name);
    if (id === undefined) throw new Error(`field_lookup missing entry for "${name}"`);
    return id;
  }

  /**
   * Build a SQL field filter clause with bindings for either integer or text mappings.
   * Returns e.g. `m.field_id = ?` or `m.field_id IN (?, ?)` for int path,
   * or `m.field = ?` / `m.field IN (?, ?)` for text path.
   *
   * When `noFieldIndex` is true, prefixes the column with `+` to prevent SQLite
   * from using any field_id-leading index. This forces PK prefix scans on the
   * mappings table, which is 9,000-17,000x faster for enrichment queries that
   * look up a small set of artwork_ids across all fields.
   */
  private buildFieldClause(fields: string[], noFieldIndex = false): { clause: string; bindings: (string | number)[] } {
    if (this.hasIntMappings) {
      const fieldIds = fields.map((f) => this.requireFieldId(f));
      const col = noFieldIndex ? "+m.field_id" : "m.field_id";
      return fieldIds.length === 1
        ? { clause: `${col} = ?`, bindings: fieldIds }
        : { clause: `${col} IN (${fieldIds.map(() => "?").join(", ")})`, bindings: fieldIds };
    }
    return fields.length === 1
      ? { clause: "m.field = ?", bindings: fields }
      : { clause: `m.field IN (${fields.map(() => "?").join(", ")})`, bindings: fields };
  }

  constructor() {
    const dbPath = resolveDbPath("VOCAB_DB_PATH", "vocabulary.db");
    if (!dbPath) {
      console.error("Vocabulary DB not found — vocabulary search disabled");
      return;
    }

    try {
      this.db = new Database(dbPath, { readonly: true });
      this.db.pragma("mmap_size = 3221225472"); // 3 GB — eliminates double-buffering via OS page cache
      // Word-boundary matching for subject search (e.g. "cat" must not match "Catharijnekerk")
      this.db.function("regexp_word", (pattern: string, value: string) => {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped}\\b`, "i").test(value) ? 1 : 0;
      });
      // Haversine distance in km for geo proximity search
      this.db.function("haversine_km", haversineKm);
      const count = (this.db.prepare("SELECT COUNT(*) as n FROM artworks").get() as { n: number }).n;

      // Feature-detect optional DB capabilities (vary by DB version)
      this.hasFts5 = this.tableExists("vocabulary_fts");
      this.hasTextFts = this.tableExists("artwork_texts_fts");
      this.hasDimensions = this.columnExists("artworks", "height_cm");
      this.hasDates = this.columnExists("artworks", "date_earliest");
      this.hasNormLabels = this.columnExists("vocabulary", "label_en_norm")
        && this.columnExists("vocabulary", "label_nl_norm");
      this.hasCoordinates = this.columnExists("vocabulary", "lat") && this.hasGeocodedData();
      this.hasIntMappings = this.tableExists("field_lookup") && this.columnExists("artworks", "art_id");
      if (this.hasIntMappings) {
        const fieldRows = this.db.prepare("SELECT id, name FROM field_lookup").all() as { id: number; name: string }[];
        for (const r of fieldRows) this.fieldIdMap.set(r.name, r.id);
      }
      this.hasRightsLookup = this.tableExists("rights_lookup");
      this.hasPersonNames = this.tableExists("person_names_fts");
      this.hasImageColumn = this.columnExists("artworks", "has_image");
      this.hasImportance = this.columnExists("artworks", "importance");

      // Warn if performance-critical indexes are missing (must be created during harvest/enrichment — DB is read-only)
      if (this.hasCoordinates) {
        this.warnIfIndexMissing("idx_vocab_lat_lon", "nearPlace queries may be slower. Re-run harvest Phase 3 to create it.");
      }
      this.warnIfIndexMissing("idx_vocab_broader_id", "expandPlaceHierarchy will be slow. Run enrichment script to create it.");

      // Cache frequently-used prepared statements
      this.stmtLookupArtwork = this.db.prepare(
        "SELECT title, title_all_text, creator_label, date_earliest, date_latest FROM artworks WHERE object_number = ?"
      );
      if (this.hasIntMappings) {
        this.stmtLookupArtId = this.db.prepare(
          "SELECT art_id, title, creator_label FROM artworks WHERE object_number = ?"
        );
      }

      // Detect person enrichment columns (birth_year, death_year, gender, bio, wikidata_id)
      if (this.columnExists("vocabulary", "birth_year") && this.columnExists("vocabulary", "gender")) {
        this.stmtLookupPersonInfo = this.db.prepare(
          "SELECT id, birth_year, death_year, gender, bio, wikidata_id FROM vocabulary WHERE id = ? AND type = 'person'"
        );
      }

      // Pre-harvested IIIF identifiers (eliminates 3-step Linked Art image chain)
      if (this.columnExists("artworks", "iiif_id")) {
        this.stmtLookupIiifId = this.db.prepare(
          "SELECT iiif_id FROM artworks WHERE object_number = ?"
        );
      }

      const features = [
        this.hasFts5 && "vocabFTS5",
        this.hasTextFts && "textFTS5",
        this.hasDimensions && "dimensions",
        this.hasDates && "dates",
        this.hasNormLabels && "normLabels",
        this.hasCoordinates && "coordinates",
        this.hasIntMappings && "intMappings",
        this.hasPersonNames && "personNames",
        this.hasImageColumn && "hasImage",
        this.hasImportance && "importance",
        this.stmtLookupPersonInfo && "personEnrichment",
        this.stmtLookupIiifId && "iiifIds",
      ].filter(Boolean).join(", ");
      console.error(`Vocabulary DB loaded: ${dbPath} (${count.toLocaleString()} artworks, ${features || "basic"})`);
    } catch (err) {
      console.error(`Failed to open vocabulary DB: ${err instanceof Error ? err.message : err}`);
      this.db = null;
    }
  }

  get available(): boolean {
    return this.db !== null;
  }

  /** Check if an index exists and warn if missing. */
  private warnIfIndexMissing(indexName: string, context: string): void {
    if (!this.db) return;
    try {
      const exists = this.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?"
      ).get(indexName);
      if (!exists) console.error(`Warning: ${indexName} index missing — ${context}`);
    } catch { /* ignore */ }
  }

  /** Batch-lookup object types from the mappings table. Returns objectNumber → label map.
   *  Processes in chunks of 500 to stay within SQLite's 999-variable limit. */
  lookupTypes(objectNumbers: string[]): Map<string, string> {
    const map = new Map<string, string>();
    if (!this.db || objectNumbers.length === 0) return map;

    const { clause: fieldClause, bindings: fieldBindings } = this.buildFieldClause(["type"], true);
    const CHUNK = 500;

    for (let i = 0; i < objectNumbers.length; i += CHUNK) {
      const chunk = objectNumbers.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");

      const sql = this.hasIntMappings
        ? `SELECT a.object_number, COALESCE(v.label_en, v.label_nl, '') AS label
           FROM mappings m
           JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
           JOIN artworks a ON m.artwork_id = a.art_id
           WHERE a.object_number IN (${placeholders}) AND ${fieldClause}`
        : `SELECT m.object_number, COALESCE(v.label_en, v.label_nl, '') AS label
           FROM mappings m JOIN vocabulary v ON m.vocab_id = v.id
           WHERE m.object_number IN (${placeholders}) AND ${fieldClause}`;

      const rows = this.db.prepare(sql).all(...chunk, ...fieldBindings) as { object_number: string; label: string }[];
      for (const r of rows) {
        if (r.label && !map.has(r.object_number)) map.set(r.object_number, r.label);
      }
    }
    return map;
  }

  /** Look up basic metadata for a single artwork by object number. */
  lookupArtwork(objectNumber: string): { title: string; creator: string; dateEarliest: number | null; dateLatest: number | null } | null {
    if (!this.db || !this.stmtLookupArtwork) return null;
    const row = this.stmtLookupArtwork.get(objectNumber) as { title: string; title_all_text: string | null; creator_label: string; date_earliest: number | null; date_latest: number | null } | undefined;
    if (!row) return null;
    return { title: row.title || row.title_all_text?.split("\n")[0] || "", creator: row.creator_label || "", dateEarliest: row.date_earliest, dateLatest: row.date_latest };
  }

  /** Look up enriched person info (birth/death/gender/bio/wikidata) by vocab IDs. */
  lookupPersonInfo(vocabIds: string[]): Map<string, PersonInfo> {
    const map = new Map<string, PersonInfo>();
    if (!this.stmtLookupPersonInfo || vocabIds.length === 0) return map;
    for (const id of vocabIds) {
      const row = this.stmtLookupPersonInfo.get(id) as {
        id: string; birth_year: number | null; death_year: number | null;
        gender: string | null; bio: string | null; wikidata_id: string | null;
      } | undefined;
      if (row && (row.birth_year != null || row.death_year != null || row.gender || row.bio || row.wikidata_id)) {
        map.set(id, {
          birthYear: row.birth_year, deathYear: row.death_year,
          gender: row.gender, bio: row.bio, wikidataId: row.wikidata_id,
        });
      }
    }
    return map;
  }

  /** Look up pre-harvested IIIF identifier for an artwork. Returns null if not available. */
  lookupIiifId(objectNumber: string): string | null {
    if (!this.stmtLookupIiifId) return null;
    const row = this.stmtLookupIiifId.get(objectNumber) as { iiif_id: string | null } | undefined;
    return row?.iiif_id ?? null;
  }

  /**
   * Reconstruct the composite source text that was embedded, in the same format
   * as generate-embeddings-v2.py. Used to provide grounding context for semantic
   * search results without storing source_text in the embeddings DB.
   *
   * Requires integer-encoded mappings (v0.13+). Returns empty map for text-schema DBs.
   */
  reconstructSourceText(artIds: number[]): Map<number, string> {
    const result = new Map<number, string>();
    if (!this.db || !this.hasIntMappings || artIds.length === 0) return result;

    const CHUNK = 500;

    for (let i = 0; i < artIds.length; i += CHUNK) {
      const chunk = artIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");

      // Query 1: artwork fields
      const artRows = this.db.prepare(
        `SELECT art_id, title_all_text, creator_label, narrative_text, inscription_text, description_text
         FROM artworks WHERE art_id IN (${placeholders})`
      ).all(...chunk) as {
        art_id: number;
        title_all_text: string | null;
        creator_label: string | null;
        narrative_text: string | null;
        inscription_text: string | null;
        description_text: string | null;
      }[];

      // Assemble composite text in same format as embedding generation (no-subjects strategy)
      for (const row of artRows) {
        const fields: [string, string | null | undefined][] = [
          ["Title", row.title_all_text],
          ["Creator", row.creator_label],
          ["Narrative", row.narrative_text],
          ["Inscriptions", row.inscription_text],
          ["Description", row.description_text],
        ];
        const text = fields
          .filter(([, v]) => v)
          .map(([l, v]) => `[${l}] ${v}`)
          .join(" ");
        if (text) result.set(row.art_id, text);
      }
    }

    return result;
  }

  // ── find_similar: Iconclass overlap ──────────────────────────────────

  /** Lazily initialise the Iconclass IDF cache. ~2s cold, <0.5s warm. */
  private ensureIconclassCache(): void {
    if (this.notationDf || !this.db || !this.hasIntMappings) return;
    const subjectFieldId = this.requireFieldId("subject");

    // Build noise ID set
    this.iconclassNoiseIds = new Set<number>();
    const noiseRows = this.db.prepare(
      `SELECT vocab_int_id FROM vocabulary WHERE label_en IN (${[...ICONCLASS_NOISE_LABELS].map(() => "?").join(", ")})`
    ).all(...ICONCLASS_NOISE_LABELS) as { vocab_int_id: number }[];
    for (const r of noiseRows) this.iconclassNoiseIds.add(r.vocab_int_id);

    // IDF: count artworks per notation
    this.notationDf = new Map();
    const rows = this.db.prepare(`
      SELECT m.vocab_rowid, COUNT(DISTINCT m.artwork_id) as df
      FROM mappings m
      JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.field_id = ? AND v.notation IS NOT NULL AND v.notation NOT LIKE 'POINT(%'
      GROUP BY m.vocab_rowid
    `).all(subjectFieldId) as { vocab_rowid: number; df: number }[];

    for (const r of rows) {
      if (this.iconclassNoiseIds.has(r.vocab_rowid)) continue;
      this.notationDf.set(r.vocab_rowid, r.df);
    }
    // Count total unique artworks with Iconclass
    const countRow = this.db.prepare(`
      SELECT COUNT(DISTINCT m.artwork_id) as n
      FROM mappings m
      JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.field_id = ? AND v.notation IS NOT NULL AND v.notation NOT LIKE 'POINT(%'
    `).get(subjectFieldId) as { n: number };
    this.iconclassN = countRow.n;
    // Cache the per-notation candidate lookup statement (called N times per query)
    this.stmtIconclassShared = this.db.prepare(
      `SELECT artwork_id FROM mappings WHERE field_id = ? AND vocab_rowid = ?`
    );
    console.error(`[find_similar] Iconclass IDF cache: ${this.notationDf.size} notations, ${this.iconclassN.toLocaleString()} artworks`);
  }

  /**
   * Find artworks similar to a given artwork by shared Iconclass notations.
   * Scores by depth × IDF weighted overlap.
   */
  findSimilarByIconclass(objectNumber: string, maxResults: number): IconclassSimilarResult | null {
    if (!this.db || !this.hasIntMappings) return null;
    this.ensureIconclassCache();
    if (!this.notationDf) return null;

    const subjectFieldId = this.requireFieldId("subject");

    // 1. Resolve art_id
    const artRow = this.stmtLookupArtId!.get(objectNumber) as { art_id: number; title: string; creator_label: string } | undefined;
    if (!artRow) return null;
    const queryArtId = artRow.art_id;

    // 2. Get query artwork's Iconclass notations
    const queryNotationsRaw = this.db.prepare(`
      SELECT m.vocab_rowid, v.notation, COALESCE(v.label_en, v.label_nl, '') as label
      FROM mappings m
      JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.artwork_id = ? AND m.field_id = ? AND v.notation IS NOT NULL AND v.notation NOT LIKE 'POINT(%'
    `).all(queryArtId, subjectFieldId) as { vocab_rowid: number; notation: string; label: string }[];

    // Filter noise labels
    const queryNotations = queryNotationsRaw.filter(n => !this.iconclassNoiseIds!.has(n.vocab_rowid));
    if (queryNotations.length === 0) {
      return {
        queryObjectNumber: objectNumber,
        queryTitle: artRow.title || "",
        queryNotations: [],
        results: [],
        warnings: ["This artwork has no Iconclass notations to search by."],
      };
    }

    // 3. For each notation, find candidate artworks and accumulate scores
    const candidates = new Map<number, { totalWeight: number; sharedMotifs: SharedMotif[] }>();

    for (const qn of queryNotations) {
      const depth = qn.notation.length;
      const df = this.notationDf.get(qn.vocab_rowid) ?? 1;
      const weight = depth * Math.log(this.iconclassN / df);
      const motif: SharedMotif = { notation: qn.notation, label: qn.label, weight };

      const rows = this.stmtIconclassShared!.all(subjectFieldId, qn.vocab_rowid) as { artwork_id: number }[];
      for (const r of rows) {
        if (r.artwork_id === queryArtId) continue; // exclude self
        const entry = candidates.get(r.artwork_id);
        if (entry) {
          entry.totalWeight += weight;
          entry.sharedMotifs.push(motif);
        } else {
          candidates.set(r.artwork_id, { totalWeight: weight, sharedMotifs: [motif] });
        }
      }
    }

    // 3b. Filter single-notation matches unless the notation is specific (depth ≥ 5)
    const MIN_SOLO_NOTATION_DEPTH = 5;
    for (const [artId, data] of candidates) {
      if (data.sharedMotifs.length === 1 && data.sharedMotifs[0].notation.length < MIN_SOLO_NOTATION_DEPTH) {
        candidates.delete(artId);
      }
    }

    // 4. Sort by totalWeight, take top maxResults
    const sorted = [...candidates.entries()]
      .sort((a, b) => b[1].totalWeight - a[1].totalWeight)
      .slice(0, maxResults);

    // 5. Batch-resolve metadata
    const artIds = sorted.map(([artId]) => artId);
    const metaMap = this.batchLookupByArtId(artIds);
    const typeMap = this.batchLookupTypesByArtId(artIds);

    const results = sorted.map(([artId, data]) => {
      const meta = metaMap.get(artId);
      const date = formatDateRange(meta?.dateEarliest, meta?.dateLatest);
      // Sort shared motifs by weight descending
      data.sharedMotifs.sort((a, b) => b.weight - a.weight);
      return {
        objectNumber: meta?.objectNumber ?? `art_id:${artId}`,
        title: meta?.title ?? "",
        creator: meta?.creator ?? "",
        ...(date && { date }),
        ...(typeMap.has(artId) && { type: typeMap.get(artId) }),
        score: Math.round(data.totalWeight * 10) / 10, // 1dp — iconclass scores are coarse (depth × IDF)
        sharedMotifs: data.sharedMotifs,
        url: `https://www.rijksmuseum.nl/en/collection/${meta?.objectNumber ?? ""}`,
      };
    });

    return {
      queryObjectNumber: objectNumber,
      queryTitle: artRow.title || "",
      queryNotations: queryNotations.map(n => ({
        notation: n.notation,
        label: n.label,
        depth: n.notation.length,
      })),
      results,
    };
  }

  // ── find_similar: Attribution lineage ──────────────────────────────

  /** Lazily initialise lineage qualifier map and creator IDF cache. */
  private ensureLineageCache(): void {
    if (this.lineageQualifierMap || !this.db || !this.hasIntMappings) return;
    const qualFieldId = this.requireFieldId("attribution_qualifier");
    const creatorFieldId = this.requireFieldId("creator");

    // Resolve AAT URIs → vocab_int_id for lineage qualifiers
    this.lineageQualifierMap = new Map();
    for (const [uri, strength] of LINEAGE_QUALIFIERS) {
      const row = this.db.prepare(
        "SELECT vocab_int_id, COALESCE(label_en, label_nl, '') as label FROM vocabulary WHERE external_id = ?"
      ).get(uri) as { vocab_int_id: number; label: string } | undefined;
      if (row) {
        this.lineageQualifierMap.set(row.vocab_int_id, { label: row.label, strength });
      }
    }
    const qualIds = [...this.lineageQualifierMap.keys()];
    if (qualIds.length === 0) return;

    // Creator IDF: for each creator that appears alongside a visual qualifier
    this.lineageCreatorDf = new Map();
    const placeholders = qualIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT m_c.vocab_rowid as creator_id, COUNT(DISTINCT m_c.artwork_id) as df
      FROM mappings m_q
      JOIN mappings m_c ON m_c.artwork_id = m_q.artwork_id AND m_c.field_id = ?
      WHERE m_q.field_id = ? AND m_q.vocab_rowid IN (${placeholders})
      GROUP BY m_c.vocab_rowid
    `).all(creatorFieldId, qualFieldId, ...qualIds) as { creator_id: number; df: number }[];

    for (const r of rows) this.lineageCreatorDf.set(r.creator_id, r.df);

    // Total artworks with any visual-lineage qualifier
    const countRow = this.db.prepare(`
      SELECT COUNT(DISTINCT artwork_id) as n FROM mappings
      WHERE field_id = ? AND vocab_rowid IN (${placeholders})
    `).get(qualFieldId, ...qualIds) as { n: number };
    this.lineageN = countRow.n;
    // Cache the per-pair candidate lookup statement (called N times per query)
    this.stmtLineageShared = this.db.prepare(`
      SELECT DISTINCT m_q.artwork_id
      FROM mappings m_q
      JOIN mappings m_c ON m_c.artwork_id = m_q.artwork_id AND m_c.field_id = ?
      WHERE m_q.field_id = ? AND m_q.vocab_rowid = ? AND m_c.vocab_rowid = ?
    `);
    console.error(`[find_similar] Lineage IDF cache: ${this.lineageCreatorDf.size} creators, ${this.lineageN.toLocaleString()} artworks`);
  }

  /**
   * Find artworks similar to a given artwork by shared visual-style lineage.
   * Scores by qualifier-strength × creator-IDF.
   */
  findSimilarByLineage(objectNumber: string, maxResults: number): LineageSimilarResult | null {
    if (!this.db || !this.hasIntMappings) return null;
    this.ensureLineageCache();
    if (!this.lineageQualifierMap || !this.lineageCreatorDf) return null;

    const qualFieldId = this.requireFieldId("attribution_qualifier");
    const creatorFieldId = this.requireFieldId("creator");

    // 1. Resolve art_id
    const artRow = this.stmtLookupArtId!.get(objectNumber) as { art_id: number; title: string; creator_label: string } | undefined;
    if (!artRow) return null;
    const queryArtId = artRow.art_id;

    // 2. Get query artwork's (qualifier, creator) pairs
    //    Only visual-similarity qualifiers (not "primary", "attributed to", etc.)
    const qualIds = [...this.lineageQualifierMap.keys()];
    const qualPlaceholders = qualIds.map(() => "?").join(", ");

    const queryPairs = this.db.prepare(`
      SELECT m_q.vocab_rowid as qualifier_id, m_c.vocab_rowid as creator_id,
             COALESCE(v_c.label_en, v_c.label_nl, '') as creator_label
      FROM mappings m_q
      JOIN mappings m_c ON m_c.artwork_id = m_q.artwork_id AND m_c.field_id = ?
      JOIN vocabulary v_c ON v_c.vocab_int_id = m_c.vocab_rowid
      WHERE m_q.artwork_id = ? AND m_q.field_id = ? AND m_q.vocab_rowid IN (${qualPlaceholders})
    `).all(creatorFieldId, queryArtId, qualFieldId, ...qualIds) as {
      qualifier_id: number; creator_id: number; creator_label: string;
    }[];

    if (queryPairs.length === 0) {
      // Check if artwork has any qualifiers at all (to give informative message)
      const anyQual = this.db.prepare(
        "SELECT 1 FROM mappings WHERE artwork_id = ? AND field_id = ? LIMIT 1"
      ).get(queryArtId, qualFieldId);
      const msg = anyQual
        ? "This artwork has direct attribution — no visual-lineage qualifiers to search by."
        : "No attribution qualifiers found for this artwork.";
      return {
        queryObjectNumber: objectNumber,
        queryTitle: artRow.title || "",
        queryLineage: [],
        results: [],
        warnings: [msg],
      };
    }

    // 3. For each (qualifier, creator) pair, find candidate artworks
    const candidates = new Map<number, { totalWeight: number; sharedLineage: SharedLineage[] }>();
    const warnings: string[] = [];

    for (const pair of queryPairs) {
      const qualInfo = this.lineageQualifierMap.get(pair.qualifier_id)!;
      const creatorDf = this.lineageCreatorDf.get(pair.creator_id) ?? 1;
      const creatorIdf = Math.log(this.lineageN / creatorDf);
      const weight = qualInfo.strength * creatorIdf;
      const lineage: SharedLineage = {
        qualifierLabel: qualInfo.label,
        creatorLabel: pair.creator_label,
        strength: qualInfo.strength,
      };

      // Warn about anonymous/unknown creators with near-zero IDF
      if (creatorIdf < 0.5 && pair.creator_label.toLowerCase().match(/^(anonymous|unknown|onbekend)/)) {
        warnings.push(`"${qualInfo.label} ${pair.creator_label}" — anonymous creator, results may be less distinctive.`);
      }

      // Find artworks sharing this (qualifier, creator) pair
      const rows = this.stmtLineageShared!.all(creatorFieldId, qualFieldId, pair.qualifier_id, pair.creator_id) as { artwork_id: number }[];

      for (const r of rows) {
        if (r.artwork_id === queryArtId) continue;
        const entry = candidates.get(r.artwork_id);
        if (entry) {
          entry.totalWeight += weight;
          entry.sharedLineage.push(lineage);
        } else {
          candidates.set(r.artwork_id, { totalWeight: weight, sharedLineage: [lineage] });
        }
      }
    }

    // 4. Sort by totalWeight, take top maxResults
    const sorted = [...candidates.entries()]
      .sort((a, b) => b[1].totalWeight - a[1].totalWeight)
      .slice(0, maxResults);

    // 5. Batch-resolve metadata
    const artIds = sorted.map(([artId]) => artId);
    const metaMap = this.batchLookupByArtId(artIds);
    const typeMap = this.batchLookupTypesByArtId(artIds);

    const results = sorted.map(([artId, data]) => {
      const meta = metaMap.get(artId);
      const date = formatDateRange(meta?.dateEarliest, meta?.dateLatest);
      data.sharedLineage.sort((a, b) => b.strength - a.strength);
      return {
        objectNumber: meta?.objectNumber ?? `art_id:${artId}`,
        title: meta?.title ?? "",
        creator: meta?.creator ?? "",
        ...(date && { date }),
        ...(typeMap.has(artId) && { type: typeMap.get(artId) }),
        score: Math.round(data.totalWeight * 100) / 100, // 2dp — lineage IDF values are finer-grained
        sharedLineage: data.sharedLineage,
        url: `https://www.rijksmuseum.nl/en/collection/${meta?.objectNumber ?? ""}`,
      };
    });

    return {
      queryObjectNumber: objectNumber,
      queryTitle: artRow.title || "",
      queryLineage: queryPairs.map(p => {
        const qi = this.lineageQualifierMap!.get(p.qualifier_id)!;
        return { qualifierLabel: qi.label, creatorLabel: p.creator_label, strength: qi.strength };
      }),
      results,
      ...(warnings.length > 0 && { warnings }),
    };
  }

  // ── find_similar: Depicted person ─────────────────────────────────

  /** Lazily initialise depicted-person IDF cache. */
  private ensurePersonCache(): void {
    if (this.personDf || !this.db || !this.hasIntMappings) return;
    const subjectFieldId = this.requireFieldId("subject");

    // Single CTE scan: per-person DFs + total distinct artworks in one pass
    const rows = this.db.prepare(`
      WITH person_mappings AS (
        SELECT m.vocab_rowid, m.artwork_id
        FROM mappings m
        JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
        WHERE m.field_id = ? AND v.type = 'person' AND v.notation IS NULL
      )
      SELECT vocab_rowid, COUNT(DISTINCT artwork_id) as df,
             (SELECT COUNT(DISTINCT artwork_id) FROM person_mappings) as n
      FROM person_mappings
      GROUP BY vocab_rowid
    `).all(subjectFieldId) as { vocab_rowid: number; df: number; n: number }[];

    // Build local state before assigning to instance fields (atomic init)
    const df = new Map<number, number>();
    let totalN = 0;
    for (const r of rows) {
      totalN = r.n; // same on every row
      if (this.iconclassNoiseIds?.has(r.vocab_rowid)) continue;
      df.set(r.vocab_rowid, r.df);
    }

    const stmt = this.db.prepare(
      `SELECT artwork_id FROM mappings WHERE field_id = ? AND vocab_rowid = ?`
    );

    // Assign all fields atomically — personDf is the "initialized" sentinel, set last
    this.personN = totalN;
    this.stmtPersonShared = stmt;
    this.personDf = df;
    console.error(`[find_similar] Person IDF cache: ${df.size} persons, ${totalN.toLocaleString()} artworks`);
  }

  /**
   * Find artworks similar to a given artwork by shared depicted persons.
   * Scores by IDF-weighted person overlap.
   */
  findSimilarByDepictedPerson(objectNumber: string, maxResults: number): DepictedPersonSimilarResult | null {
    if (!this.db || !this.hasIntMappings) return null;
    this.ensureIconclassCache(); // needed for noise IDs
    this.ensurePersonCache();
    if (!this.personDf || this.personN === 0) return null;

    const subjectFieldId = this.requireFieldId("subject");

    // 1. Resolve art_id
    const artRow = this.stmtLookupArtId!.get(objectNumber) as { art_id: number; title: string; creator_label: string } | undefined;
    if (!artRow) return null;
    const queryArtId = artRow.art_id;

    // 2. Get query artwork's depicted persons
    const queryPersons = this.db.prepare(`
      SELECT m.vocab_rowid, COALESCE(v.label_en, v.label_nl, '') as label
      FROM mappings m
      JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.artwork_id = ? AND m.field_id = ? AND v.type = 'person' AND v.notation IS NULL
    `).all(queryArtId, subjectFieldId) as { vocab_rowid: number; label: string }[];

    // Filter noise
    const filteredPersons = queryPersons.filter(p =>
      !this.iconclassNoiseIds!.has(p.vocab_rowid) && this.personDf!.has(p.vocab_rowid)
    );

    if (filteredPersons.length === 0) {
      return {
        queryObjectNumber: objectNumber,
        queryTitle: artRow.title || "",
        queryPersons: [],
        results: [],
        warnings: ["This artwork has no depicted persons to search by."],
      };
    }

    // 3. For each person, find candidate artworks and accumulate scores
    const candidates = new Map<number, { totalWeight: number; sharedPersons: SharedPerson[] }>();

    for (const qp of filteredPersons) {
      const df = this.personDf.get(qp.vocab_rowid) ?? 1;
      const weight = Math.log(this.personN / df);
      const person: SharedPerson = { label: qp.label, weight };

      const rows = this.stmtPersonShared!.all(subjectFieldId, qp.vocab_rowid) as { artwork_id: number }[];
      for (const r of rows) {
        if (r.artwork_id === queryArtId) continue;
        const entry = candidates.get(r.artwork_id);
        if (entry) {
          entry.totalWeight += weight;
          entry.sharedPersons.push(person);
        } else {
          candidates.set(r.artwork_id, { totalWeight: weight, sharedPersons: [person] });
        }
      }
    }

    // 4. Sort by totalWeight, take top maxResults
    const sorted = [...candidates.entries()]
      .sort((a, b) => b[1].totalWeight - a[1].totalWeight)
      .slice(0, maxResults);

    // 5. Batch-resolve metadata
    const artIds = sorted.map(([artId]) => artId);
    const metaMap = this.batchLookupByArtId(artIds);
    const typeMap = this.batchLookupTypesByArtId(artIds);

    const results = sorted.map(([artId, data]) => {
      const meta = metaMap.get(artId);
      const date = formatDateRange(meta?.dateEarliest, meta?.dateLatest);
      data.sharedPersons.sort((a, b) => b.weight - a.weight);
      return {
        objectNumber: meta?.objectNumber ?? `art_id:${artId}`,
        title: meta?.title ?? "",
        creator: meta?.creator ?? "",
        ...(date && { date }),
        ...(typeMap.has(artId) && { type: typeMap.get(artId) }),
        score: Math.round(data.totalWeight * 100) / 100,
        sharedPersons: data.sharedPersons,
        url: `https://www.rijksmuseum.nl/en/collection/${meta?.objectNumber ?? ""}`,
      };
    });

    return {
      queryObjectNumber: objectNumber,
      queryTitle: artRow.title || "",
      queryPersons: filteredPersons.map(p => ({ label: p.label })),
      results,
    };
  }

  // ── find_similar: batch metadata helpers ───────────────────────────

  /** Batch-lookup artwork metadata by art_id. Chunks at 500. */
  private batchLookupByArtId(artIds: number[]): Map<number, { objectNumber: string; title: string; creator: string; dateEarliest: number | null; dateLatest: number | null }> {
    const map = new Map<number, { objectNumber: string; title: string; creator: string; dateEarliest: number | null; dateLatest: number | null }>();
    if (!this.db || artIds.length === 0) return map;
    const CHUNK = 500;
    for (let i = 0; i < artIds.length; i += CHUNK) {
      const chunk = artIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db.prepare(`
        SELECT art_id, object_number, title, creator_label, date_earliest, date_latest
        FROM artworks WHERE art_id IN (${placeholders})
      `).all(...chunk) as { art_id: number; object_number: string; title: string; creator_label: string; date_earliest: number | null; date_latest: number | null }[];
      for (const r of rows) {
        map.set(r.art_id, {
          objectNumber: r.object_number,
          title: r.title || "",
          creator: r.creator_label || "",
          dateEarliest: r.date_earliest,
          dateLatest: r.date_latest,
        });
      }
    }
    return map;
  }

  /** Batch-lookup artwork types by art_id. Chunks at 500. */
  private batchLookupTypesByArtId(artIds: number[]): Map<number, string> {
    const map = new Map<number, string>();
    if (!this.db || !this.hasIntMappings || artIds.length === 0) return map;
    const typeFieldId = this.requireFieldId("type");
    const CHUNK = 500;
    for (let i = 0; i < artIds.length; i += CHUNK) {
      const chunk = artIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db.prepare(`
        SELECT m.artwork_id, COALESCE(v.label_en, v.label_nl, '') as label
        FROM mappings m
        JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
        WHERE m.artwork_id IN (${placeholders}) AND +m.field_id = ?
      `).all(...chunk, typeFieldId) as { artwork_id: number; label: string }[];
      for (const r of rows) {
        if (r.label && !map.has(r.artwork_id)) map.set(r.artwork_id, r.label);
      }
    }
    return map;
  }

  private tableExists(name: string): boolean {
    try {
      this.db!.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get();
      return true;
    } catch {
      return false;
    }
  }

  private columnExists(table: string, column: string): boolean {
    try {
      this.db!.prepare(`SELECT ${column} FROM ${table} LIMIT 1`).get();
      return true;
    } catch {
      return false;
    }
  }

  /** Compact search: returns only object numbers and total count, no enrichment.
   *  Uses the same filter logic as search() but skips lookupTypes/distance enrichment. */
  searchCompact(params: VocabSearchParams): { totalResults?: number; ids: string[]; source: "vocabulary"; warnings?: string[]; facets?: Record<string, Array<{ label: string; count: number }>> } {
    if (!this.db) return { ids: [], source: "vocabulary" };
    // Delegate to search with compact flag — the internal implementation checks this
    const result = this.searchInternal(params, true);
    return {
      ...(result.totalResults != null && { totalResults: result.totalResults }),
      ids: result.results.map((r) => r.objectNumber),
      source: "vocabulary",
      ...(result.warnings && result.warnings.length > 0 && { warnings: result.warnings }),
      ...(result.facets && { facets: result.facets }),
    };
  }

  /** Search artworks by vocabulary criteria. Multiple params are intersected (AND). */
  search(params: VocabSearchParams): VocabSearchResult {
    return this.searchInternal(params, false);
  }

  /**
   * Compute top-5 faceted counts for requested dimensions.
   * Runs GROUP BY queries using the same WHERE clause as the main search.
   * Only computes dimensions present in `requestedFields`.
   */
  private computeFacets(
    conditions: string[],
    bindings: unknown[],
    ftsJoinClause: string,
    ftsJoinBinding: unknown | null,
    requestedFields: Set<string>,
  ): Record<string, Array<{ label: string; count: number }>> {
    if (!this.db || !this.hasIntMappings) return {};
    const result: Record<string, Array<{ label: string; count: number }>> = {};

    const where = conditions.length > 0 ? conditions.join(" AND ") : "1";
    const allBindings = ftsJoinBinding != null ? [ftsJoinBinding, ...bindings] : [...bindings];

    // Vocab-based facets: type, material, technique
    const VOCAB_FACETS: [string, string][] = [
      ["type", "type"],
      ["material", "material"],
      ["technique", "technique"],
    ];
    for (const [label, fieldName] of VOCAB_FACETS) {
      if (!requestedFields.has(label)) continue;
      const fieldId = this.fieldIdMap.get(fieldName);
      if (fieldId === undefined) continue;
      // fieldId binding must come after ftsJoinBinding (if any) but before WHERE bindings,
      // matching the positional order of ? in the SQL: JOIN fts... JOIN fm.field_id=? WHERE ...
      const facetBindings = ftsJoinBinding != null
        ? [ftsJoinBinding, fieldId, ...bindings]
        : [fieldId, ...bindings];
      const sql =
        `SELECT COALESCE(v.label_en, v.label_nl) AS label, COUNT(DISTINCT fm.artwork_id) AS cnt ` +
        `FROM artworks a ${ftsJoinClause} ` +
        `JOIN mappings fm ON fm.artwork_id = a.art_id AND +fm.field_id = ? ` +
        `JOIN vocabulary v ON fm.vocab_rowid = v.vocab_int_id ` +
        `WHERE ${where} AND v.label_en IS NOT NULL ` +
        `GROUP BY label ORDER BY cnt DESC LIMIT 5`;
      const rows = this.db.prepare(sql).all(...facetBindings) as { label: string; cnt: number }[];
      if (rows.length > 0) {
        result[label] = rows.map(r => ({ label: r.label, count: r.cnt }));
      }
    }

    // Century facet (computed from date_earliest)
    if (requestedFields.has("century") && this.hasDates) {
      const sql =
        `SELECT (CASE WHEN a.date_earliest >= 0 THEN (a.date_earliest / 100 + 1) ELSE -((-a.date_earliest - 1) / 100 + 1) END) AS century, ` +
        `COUNT(*) AS cnt ` +
        `FROM artworks a ${ftsJoinClause} ` +
        `WHERE ${where} AND a.date_earliest IS NOT NULL ` +
        `GROUP BY century ORDER BY cnt DESC LIMIT 5`;
      const rows = this.db.prepare(sql).all(...allBindings) as { century: number; cnt: number }[];
      if (rows.length > 0) {
        result["century"] = rows.map(r => ({
          label: r.century > 0 ? `${ordinal(r.century)} century` : `${ordinal(-r.century)} century BCE`,
          count: r.cnt,
        }));
      }
    }

    // Creator gender facet (computed from vocabulary.gender via creator mappings)
    if (requestedFields.has("creatorGender") && this.stmtLookupPersonInfo && this.hasIntMappings) {
      const creatorFieldId = this.fieldIdMap.get("creator");
      if (creatorFieldId != null) {
        const genderBindings = ftsJoinBinding != null
          ? [ftsJoinBinding, creatorFieldId, ...bindings]
          : [creatorFieldId, ...bindings];
        const sql =
          `SELECT v.gender AS gender, COUNT(DISTINCT fm.artwork_id) AS cnt ` +
          `FROM artworks a ${ftsJoinClause} ` +
          `JOIN mappings fm ON fm.artwork_id = a.art_id AND +fm.field_id = ? ` +
          `JOIN vocabulary v ON fm.vocab_rowid = v.vocab_int_id ` +
          `WHERE ${where} AND v.gender IS NOT NULL ` +
          `GROUP BY gender ORDER BY cnt DESC`;
        const rows = this.db.prepare(sql).all(...genderBindings) as { gender: string; cnt: number }[];
        if (rows.length > 0) {
          result["creatorGender"] = rows.map(r => ({ label: r.gender, count: r.cnt }));
        }
      }
    }

    // Rights facet (direct column — no mapping JOIN)
    if (requestedFields.has("rights") && this.hasRightsLookup) {
      const rightsSql =
        `SELECT rl.uri AS label, COUNT(*) AS cnt ` +
        `FROM artworks a ${ftsJoinClause} ` +
        `JOIN rights_lookup rl ON a.rights_id = rl.id ` +
        `WHERE ${where} ` +
        `GROUP BY rl.uri ORDER BY cnt DESC`;
      const rows = this.db.prepare(rightsSql).all(...allBindings) as { label: string; cnt: number }[];
      if (rows.length > 0) {
        result["rights"] = rows.map(r => ({
          label: r.label.includes("publicdomain/mark") ? "Public Domain"
            : r.label.includes("publicdomain/zero") ? "CC0"
            : r.label.includes("InC") ? "In Copyright"
            : r.label,
          count: r.cnt,
        }));
      }
    }

    // Image availability facet (direct column — no mapping JOIN)
    if (requestedFields.has("imageAvailable") && this.hasImageColumn) {
      const imgSql =
        `SELECT CASE WHEN a.has_image = 1 THEN 'yes' ELSE 'no' END AS label, COUNT(*) AS cnt ` +
        `FROM artworks a ${ftsJoinClause} ` +
        `WHERE ${where} ` +
        `GROUP BY label ORDER BY cnt DESC`;
      const rows = this.db.prepare(imgSql).all(...allBindings) as { label: string; cnt: number }[];
      if (rows.length > 0) {
        result["imageAvailable"] = rows.map(r => ({ label: r.label, count: r.cnt }));
      }
    }

    return result;
  }

  private searchInternal(params: VocabSearchParams, compact: boolean): VocabSearchResult {
    if (!this.db) {
      return emptyResult();
    }

    // Work on a shallow copy so we never mutate the caller's object
    const effective = { ...params };

    const conditions: string[] = [];
    const bindings: unknown[] = [];
    const warnings: string[] = [];
    let geoResult: { placeIds: string[]; referencePlace: string; refLat: number; refLon: number } | null = null;

    // Handle geo proximity filter: nearLat/nearLon (coordinates) or nearPlace (name)
    const hasCoordPair = effective.nearLat != null && effective.nearLon != null;
    const hasPartialCoord = (effective.nearLat != null) !== (effective.nearLon != null);

    if (hasPartialCoord) {
      warnings.push("Both nearLat and nearLon are required for coordinate search. The incomplete pair was ignored.");
    }

    if (hasCoordPair || effective.nearPlace) {
      if (!this.hasCoordinates) {
        warnings.push("Proximity search requires a vocabulary DB with geocoded places. This filter was ignored.");
      } else {
        if (effective.depictedPlace || effective.productionPlace) {
          warnings.push(
            "Proximity search cannot be combined with depictedPlace/productionPlace. " +
            "Using proximity search; the other place filters were ignored."
          );
          delete effective.depictedPlace;
          delete effective.productionPlace;
        }

        const radiusKm = Math.min(Math.max(effective.nearPlaceRadius ?? 25, 0.1), 500);

        if (hasCoordPair) {
          if (effective.nearPlace) {
            warnings.push("Both nearLat/nearLon and nearPlace provided. Using coordinates; nearPlace was ignored.");
          }
          const lat = effective.nearLat!;
          const lon = effective.nearLon!;
          const placeIds = this.findPlaceIdsNearCoords(lat, lon, radiusKm);

          if (placeIds.length === 0) {
            warnings.push(`No geocoded places found within ${radiusKm}km of (${lat}, ${lon}).`);
            return emptyResult(warnings);
          }

          geoResult = {
            placeIds,
            referencePlace: `(${lat}, ${lon})`,
            refLat: lat,
            refLon: lon,
          };
        } else {
          const resolved = this.findNearbyPlaceIds(effective.nearPlace!, radiusKm, warnings);

          if (!resolved || resolved.placeIds.length === 0) {
            warnings.push(`Could not find geocoded place matching "${effective.nearPlace}".`);
            return emptyResult(warnings);
          }

          geoResult = {
            placeIds: resolved.placeIds,
            referencePlace: `${resolved.refPlace} (${resolved.refLat.toFixed(4)}, ${resolved.refLon.toFixed(4)})`,
            refLat: resolved.refLat,
            refLon: resolved.refLon,
          };
        }

        const geoFilter = this.mappingFilterDirect(
          ["subject", "spatial"],
          geoResult.placeIds,
        );
        conditions.push(geoFilter.condition);
        bindings.push(...geoFilter.bindings);
      }
    }

    // Vocab mapping filters, license, imageAvailable, date range
    const vocabResult = this.buildVocabConditions(effective, warnings);
    if (vocabResult === null) return emptyResult(warnings);
    conditions.push(...vocabResult.conditions);
    bindings.push(...vocabResult.bindings);

    // Tier 2: Text FTS filters (inscription, provenance, creditLine, curatorialNarrative)
    const TEXT_FILTERS: [keyof VocabSearchParams, string][] = [
      ["description", "description_text"],
      ["inscription", "inscription_text"],
      ["provenance", "provenance_text"],
      ["creditLine", "credit_line"],
      ["curatorialNarrative", "narrative_text"],
      ["title", "title_all_text"],
    ];
    const requestedTextFilters = TEXT_FILTERS.filter(([param]) => typeof effective[param] === "string");
    // BM25 ranking: the first text FTS filter is promoted to a JOIN so we can
    // ORDER BY fts.rank. Additional text filters remain as IN-subqueries.
    let ftsJoinClause = "";
    let ftsJoinBinding: unknown | null = null;
    let ftsRankOrder = false;
    if (requestedTextFilters.length > 0) {
      if (this.hasTextFts) {
        let isFirst = true;
        for (const [param, column] of requestedTextFilters) {
          const ftsPhrase = escapeFts5(effective[param] as string);
          if (!ftsPhrase) continue; // skip empty-after-stripping queries
          if (isFirst) {
            // JOIN for BM25 rank access
            ftsJoinClause = `JOIN artwork_texts_fts fts ON fts.rowid = a.rowid AND fts.${column} MATCH ?`;
            ftsJoinBinding = ftsPhrase;
            ftsRankOrder = true;
            isFirst = false;
          } else {
            conditions.push(`a.rowid IN (SELECT rowid FROM artwork_texts_fts WHERE ${column} MATCH ?)`);
            bindings.push(ftsPhrase);
          }
        }
      } else {
        warnings.push(
          `Text search filters (${requestedTextFilters.map(([p]) => p).join(", ")}) require vocabulary DB v1.0+. These filters were ignored.`
        );
      }
    }

    // Tier 2: Dimension range filters
    const DIM_FILTERS: [keyof VocabSearchParams, string, string][] = [
      ["minHeight", "a.height_cm", ">="],
      ["maxHeight", "a.height_cm", "<="],
      ["minWidth", "a.width_cm", ">="],
      ["maxWidth", "a.width_cm", "<="],
    ];
    const requestedDimFilters = DIM_FILTERS.filter(([param]) => effective[param] != null);
    if (requestedDimFilters.length > 0) {
      if (this.hasDimensions) {
        for (const [param, col, op] of requestedDimFilters) {
          conditions.push(`${col} ${op} ?`);
          bindings.push(effective[param]!);
        }
      } else {
        warnings.push("Dimension range filters require vocabulary DB v1.0+. These filters were ignored.");
      }
    }

    if (conditions.length === 0 && !ftsJoinClause) {
      return emptyResult(warnings);
    }

    const where = conditions.length > 0 ? conditions.join(" AND ") : "1";
    const limit = Math.min(effective.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP);

    const orderBy = ftsRankOrder
      ? "ORDER BY fts.rank"
      : this.hasImportance
        ? "ORDER BY a.importance DESC"
        : "";
    const sql = `SELECT a.object_number, a.title, a.title_all_text, a.creator_label, a.date_earliest, a.date_latest FROM artworks a ${ftsJoinClause} WHERE ${where} ${orderBy} LIMIT ?`;
    const rows = this.db.prepare(sql).all(
      ...(ftsJoinBinding != null ? [ftsJoinBinding, ...bindings, limit] : [...bindings, limit]),
    ) as {
      object_number: string;
      title: string;
      title_all_text: string | null;
      creator_label: string;
      date_earliest: number | null;
      date_latest: number | null;
    }[];

    // Compute total count only when results are truncated (rows.length === limit).
    // When results fit within the limit, rows.length IS the total — no extra scan needed.
    // Worst case (gender scans) adds ~850ms, but only when the count is informative.
    const totalResults = rows.length < limit
      ? rows.length
      : (this.db.prepare(
          `SELECT COUNT(*) as n FROM artworks a ${ftsJoinClause} WHERE ${where}`,
        ).get(
          ...(ftsJoinBinding != null ? [ftsJoinBinding, ...bindings] : bindings),
        ) as { n: number }).n;

    // When nearPlace is active, enrich results with nearest place + distance
    // Skip enrichment in compact mode (only IDs needed)
    let distanceMap: Map<string, { place: string; dist: number }> | undefined;
    if (!compact && geoResult && rows.length > 0) {
      const objNums = rows.map((r) => r.object_number);
      const objPlaceholders = objNums.map(() => "?").join(", ");
      const { clause: geoFieldClause, bindings: geoFieldBindings } = this.buildFieldClause(["subject", "spatial"], true);

      const distSql = this.hasIntMappings
        ? `SELECT a.object_number, v.label_en, v.label_nl,
                  haversine_km(?, ?, v.lat, v.lon) AS dist
           FROM mappings m
           JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
           JOIN artworks a ON m.artwork_id = a.art_id
           WHERE a.object_number IN (${objPlaceholders})
             AND ${geoFieldClause} AND v.lat IS NOT NULL
           ORDER BY dist`
        : `SELECT m.object_number, v.label_en, v.label_nl,
                  haversine_km(?, ?, v.lat, v.lon) AS dist
           FROM mappings m JOIN vocabulary v ON m.vocab_id = v.id
           WHERE m.object_number IN (${objPlaceholders})
             AND ${geoFieldClause} AND v.lat IS NOT NULL
           ORDER BY dist`;

      const distRows = this.db.prepare(distSql).all(
        geoResult.refLat, geoResult.refLon, ...objNums, ...geoFieldBindings,
      ) as { object_number: string; label_en: string | null; label_nl: string | null; dist: number }[];

      distanceMap = new Map();
      for (const dr of distRows) {
        if (!distanceMap.has(dr.object_number)) {
          distanceMap.set(dr.object_number, {
            place: dr.label_en || dr.label_nl || "",
            dist: Math.round(dr.dist * 10) / 10,
          });
        }
      }
    }

    // Sort by distance when geo is active and BM25 isn't already ordering
    if (distanceMap && distanceMap.size > 0 && !ftsRankOrder) {
      rows.sort((a, b) => {
        const da = distanceMap!.get(a.object_number)?.dist ?? Infinity;
        const db = distanceMap!.get(b.object_number)?.dist ?? Infinity;
        return da - db;
      });
    }

    // Faceted counts: compute requested dimensions when results are truncated
    let facets: Record<string, Array<{ label: string; count: number }>> | undefined;
    if (effective.facets && effective.facets.length > 0 && rows.length >= limit) {
      // Only compute requested dimensions, minus those already filtered on
      const requested = new Set(effective.facets);
      if (effective.type) requested.delete("type");
      if (effective.material) requested.delete("material");
      if (effective.technique) requested.delete("technique");
      if (effective.creationDate) requested.delete("century");
      if (effective.creatorGender) requested.delete("creatorGender");
      if (effective.license) requested.delete("rights");
      if (effective.imageAvailable != null) requested.delete("imageAvailable");
      if (requested.size > 0) {
        facets = this.computeFacets(conditions, bindings, ftsJoinClause, ftsJoinBinding, requested);
        if (Object.keys(facets).length === 0) facets = undefined;
      }
    }

    // In compact mode, skip all enrichment — only IDs needed
    if (compact) {
      return {
        totalResults,
        results: rows.map((r) => ({
          objectNumber: r.object_number,
          title: "",
          creator: "",
          url: "",
        })),
        source: "vocabulary" as const,
        ...(facets && { facets }),
        ...(warnings.length > 0 && { warnings }),
      };
    }

    const typeMap = this.lookupTypes(rows.map((r) => r.object_number));

    return {
      totalResults,
      ...(geoResult && { referencePlace: geoResult.referencePlace }),
      results: rows.map((r) => {
        const d = distanceMap?.get(r.object_number);
        const t = typeMap?.get(r.object_number);
        let date: string | undefined;
        if (r.date_earliest != null) {
          date = r.date_earliest === r.date_latest
            ? String(r.date_earliest)
            : `${r.date_earliest}–${r.date_latest}`;
        }
        return {
          objectNumber: r.object_number,
          title: r.title || r.title_all_text?.split("\n")[0] || "",
          creator: r.creator_label || "",
          ...(date && { date }),
          ...(t && { type: t }),
          url: `https://www.rijksmuseum.nl/en/collection/${r.object_number}`,
          ...(d && { nearestPlace: d.place, distance_km: d.dist }),
        };
      }),
      source: "vocabulary",
      ...(facets && { facets }),
      ...(warnings.length > 0 && { warnings }),
    };
  }

  /**
   * Build conditions for vocab mapping filters, license, imageAvailable, and date range.
   * Shared by searchInternal() and filterArtIds() to avoid duplicating complex filter logic
   * (FTS5 upgrade, person name matching, multi-word place resolution, etc.).
   *
   * Returns null if any filter produced zero vocab matches (caller should return empty result).
   * Returns { conditions: [], bindings: [] } if no applicable filters were found.
   */
  private buildVocabConditions(
    effective: Record<string, unknown>,
    warnings?: string[],
  ): { conditions: string[]; bindings: unknown[] } | null {
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    for (const filter of VOCAB_FILTERS) {
      const rawValue = effective[filter.param];
      if (rawValue === undefined) continue;

      for (const f of filter.fields) {
        if (!ALLOWED_FIELDS.has(f)) throw new Error(`Invalid vocab field: ${f}`);
      }
      if (filter.vocabType && !ALLOWED_VOCAB_TYPES.has(filter.vocabType)) {
        throw new Error(`Invalid vocab type: ${filter.vocabType}`);
      }

      const typeClause = filter.vocabType ? ` AND type = ?` : "";
      const typeBindings: unknown[] = filter.vocabType ? [filter.vocabType] : [];

      // Multi-value AND: each array element becomes a separate AND condition
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];

      for (const value of values) {
        const useFts = this.hasFts5 && filter.ftsUpgrade && filter.matchMode !== "exact-notation";

        if (useFts) {
          // Person name matching: use person_names_fts (two-tier) when available
          let vocabIds = filter.vocabType === "person" && this.hasPersonNames
            ? this.findPersonIdsFts(String(value))
            : this.findVocabIdsFts(String(value), typeClause, typeBindings);

          // Multi-word place fallback: split "Oude Kerk Amsterdam" → "Oude Kerk" near "Amsterdam"
          if (vocabIds.length === 0 && filter.vocabType === "place") {
            const resolved = this.resolveMultiWordPlace(String(value));
            if (resolved && resolved.candidates.length > 0) {
              const hasContext = resolved.contextLat != null && resolved.contextLon != null;
              const prefix = `${filter.param}:"${value}"`;

              if (hasContext && resolved.candidates.length > 1) {
                const { ids, geocodedCount } = rankByProximity(
                  resolved.candidates, resolved.contextLat!, resolved.contextLon!,
                );
                vocabIds = ids;
                warnings?.push(buildMultiWordPlaceWarning(
                  prefix, resolved.namePart, resolved.contextPart,
                  resolved.candidates.length,
                  { filteredCount: ids.length, geocodedCount },
                ));
              } else {
                vocabIds = resolved.candidates.map((c) => c.id);
                warnings?.push(buildMultiWordPlaceWarning(
                  prefix, resolved.namePart, resolved.contextPart,
                  vocabIds.length,
                ));
              }
            }
          }

          // Place hierarchy expansion: include children of matched places
          if (vocabIds.length > 0 && filter.vocabType === "place" && effective.expandPlaceHierarchy) {
            const before = vocabIds.length;
            vocabIds = this.expandPlaceChildren(vocabIds);
            if (vocabIds.length > before) {
              warnings?.push(`${filter.param}: expanded ${before} place(s) to ${vocabIds.length} via hierarchy.`);
            }
          }

          if (vocabIds.length === 0) {
            return null; // signal: zero matches for this filter element
          }
          const ftsFilter = this.mappingFilterDirect(filter.fields, vocabIds);
          conditions.push(ftsFilter.condition);
          bindings.push(...ftsFilter.bindings);
        } else {
          const { where: vocabWhere, bindings: matchBindings } = this.buildVocabMatch(filter.matchMode, value);
          const nonFtsFilter = this.mappingFilterSubquery(
            filter.fields,
            `${vocabWhere}${typeClause}`,
            [...matchBindings, ...typeBindings],
          );
          conditions.push(nonFtsFilter.condition);
          bindings.push(...nonFtsFilter.bindings);
        }
      }
    }

    // Direct column filter: license matches against artworks.rights_uri (or rights_lookup)
    if (effective.license) {
      if (this.hasRightsLookup) {
        conditions.push("a.rights_id IN (SELECT id FROM rights_lookup WHERE uri LIKE ?)");
      } else {
        conditions.push("a.rights_uri LIKE ?");
      }
      bindings.push(`%${effective.license}%`);
    }

    // Image availability filter (requires has_image column from v0.19+ DB)
    if (effective.imageAvailable === true) {
      if (this.hasImageColumn) {
        conditions.push("a.has_image = 1");
      } else {
        warnings?.push("imageAvailable requires vocabulary DB v0.19+. This filter was ignored.");
      }
    }

    // Creation date range filter
    if (effective.creationDate) {
      if (this.hasDates) {
        const range = parseDateFilter(effective.creationDate as string);
        if (range) {
          const mode = (effective.dateMatch as string) || "overlaps";
          if (mode === "within") {
            // Artwork range must fall entirely within the query range
            conditions.push("a.date_earliest IS NOT NULL AND a.date_earliest >= ? AND a.date_latest <= ?");
            bindings.push(range.earliest, range.latest);
          } else if (mode === "midpoint") {
            // Midpoint of artwork range must fall within query range — each artwork in exactly one bin.
            // Uses sum BETWEEN 2*lo AND 2*hi to evaluate the expression once per row (integer-exact).
            conditions.push("a.date_earliest IS NOT NULL AND (a.date_earliest + a.date_latest) BETWEEN ? AND ?");
            bindings.push(range.earliest * 2, range.latest * 2);
          } else {
            // "overlaps" (default): artwork range overlaps the query range
            conditions.push("a.date_earliest IS NOT NULL AND a.date_latest >= ? AND a.date_earliest <= ?");
            bindings.push(range.earliest, range.latest);
          }
        } else {
          warnings?.push(`Could not parse creationDate "${effective.creationDate}". Expected a year ("1642") or wildcard ("164*", "16*").`);
        }
      } else {
        warnings?.push("Date filtering requires a vocabulary DB with date columns (re-run harvest Phase 4). This filter was ignored.");
      }
    }

    // Creator demographic filters (gender, birth year range) — require person enrichment + integer mappings
    const hasCreatorDemographic = effective.creatorGender != null || effective.creatorBornAfter != null || effective.creatorBornBefore != null;
    if (hasCreatorDemographic) {
      if (this.stmtLookupPersonInfo && this.hasIntMappings) {
        const creatorFieldId = this.fieldIdMap.get("creator");
        if (creatorFieldId != null) {
          const vocabConds: string[] = ["v.type = 'person'"];
          const vocabBindings: unknown[] = [];
          if (effective.creatorGender != null) {
            vocabConds.push("v.gender = ?");
            vocabBindings.push(effective.creatorGender);
          }
          if (effective.creatorBornAfter != null) {
            vocabConds.push("v.birth_year >= ?");
            vocabBindings.push(effective.creatorBornAfter);
          }
          if (effective.creatorBornBefore != null) {
            vocabConds.push("v.birth_year <= ?");
            vocabBindings.push(effective.creatorBornBefore);
          }
          conditions.push(
            `a.art_id IN (SELECT m.artwork_id FROM mappings m ` +
            `JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id ` +
            `WHERE m.field_id = ? AND ${vocabConds.join(" AND ")})`
          );
          bindings.push(creatorFieldId, ...vocabBindings);
        }
      } else {
        warnings?.push("Creator demographic filters (creatorGender, creatorBornAfter, creatorBornBefore) require vocabulary DB with person enrichment. These filters were ignored.");
      }
    }

    return { conditions, bindings };
  }

  /**
   * Expand a set of place vocab IDs to include children (places whose broader_id
   * points to one of the given IDs). Uses a recursive CTE limited to 10 levels deep,
   * capped at 10,000 descendants to prevent pathological expansions.
   *
   * Performance: requires idx_vocab_broader_id index. The recursive step omits
   * `AND type = 'place'` — with a type filter, SQLite uses idx_vocab_type (full
   * scan of all places) instead of idx_vocab_broader_id (index lookup per parent).
   * This is safe: only places have broader_id pointing to other places.
   */
  private expandPlaceChildren(placeIds: string[]): string[] {
    if (!this.db || placeIds.length === 0) return placeIds;
    const placeholders = placeIds.map(() => "?").join(", ");
    const sql = `
      WITH RECURSIVE descendants(id, depth) AS (
        SELECT id, 0 FROM vocabulary WHERE id IN (${placeholders}) AND type = 'place'
        UNION ALL
        SELECT v.id, d.depth + 1
        FROM descendants d JOIN vocabulary v ON v.broader_id = d.id
        WHERE d.depth < 10
      )
      SELECT DISTINCT id FROM descendants LIMIT 10000`;
    const rows = this.db.prepare(sql).all(...placeIds) as { id: string }[];
    return rows.map(r => r.id);
  }

  /**
   * Return art_ids matching metadata filters, for use as candidates in semantic search.
   * Supports all structured vocab filters (not text search, geo, or dimensions).
   * Returns up to 50,000 art_ids — beyond that, pure KNN + post-filter is faster.
   * Returns null if the DB lacks integer mappings (text-schema backward compat).
   */
  filterArtIds(params: Partial<VocabSearchParams>): number[] | null {
    if (!this.db) return null;
    if (!this.hasIntMappings) return null;

    const vocabResult = this.buildVocabConditions(params as Record<string, unknown>);
    if (vocabResult === null) return []; // a filter matched zero vocab terms
    if (vocabResult.conditions.length === 0) return null; // no effective filters — fall back to unfiltered

    const sql = `SELECT a.art_id FROM artworks a WHERE ${vocabResult.conditions.join(" AND ")} LIMIT 50000`;
    let stmt = this.stmtFilterArtIds.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtFilterArtIds.set(sql, stmt);
    }
    const rows = stmt.all(...vocabResult.bindings) as { art_id: number }[];
    return rows.map(r => r.art_id);
  }

  /** Return the URIs of the N most frequently referenced vocabulary terms. */
  topTermUris(limit: number = 200): string[] {
    if (!this.db) return [];
    // Requires pre-computed vocab_term_counts table (~14ms).
    // Without it, the GROUP BY over 7.3M rows takes ~41s and blocks the event loop.
    try {
      const rows = this.db.prepare(
        `SELECT vocab_id FROM vocab_term_counts ORDER BY cnt DESC LIMIT ?`
      ).all(limit) as { vocab_id: string }[];
      return rows.map((r) => `https://id.rijksmuseum.nl/${r.vocab_id}`);
    } catch {
      return [];
    }
  }

  /** Look up a vocabulary term by Iconclass notation. */
  lookupByNotation(code: string): { id: string; labelEn: string; labelNl: string } | null {
    if (!this.db) return null;
    const row = this.db
      .prepare("SELECT id, label_en, label_nl FROM vocabulary WHERE notation = ?")
      .get(code) as { id: string; label_en: string; label_nl: string } | undefined;
    if (!row) return null;
    return { id: row.id, labelEn: row.label_en || "", labelNl: row.label_nl || "" };
  }

  /**
   * Find vocabulary IDs via FTS5, falling back to LIKE on normalized labels
   * for compound word variants (e.g. "printmaker" vs "print maker").
   */
  private queryVocabFts(match: string, typeClause: string, typeBindings: unknown[]): string[] {
    return (this.db!.prepare(
      `SELECT id FROM vocabulary WHERE rowid IN (SELECT rowid FROM vocabulary_fts WHERE vocabulary_fts MATCH ?)${typeClause}`
    ).all(match, ...typeBindings) as { id: string }[]).map((r) => r.id);
  }

  private findVocabIdsFts(value: string, typeClause: string, typeBindings: unknown[]): string[] {
    const ftsPhrase = escapeFts5(value);
    if (!ftsPhrase) return [];
    const ids = this.queryVocabFts(ftsPhrase, typeClause, typeBindings);
    if (ids.length > 0) return ids;

    // Tier 1.5: FTS5 morphological expansion (English stems)
    const expanded = expandFtsQuery(value);
    if (expanded) {
      const morphIds = this.queryVocabFts(expanded, typeClause, typeBindings);
      if (morphIds.length > 0) return morphIds;
    }

    // Tier 2: FTS5 found nothing — try LIKE on space-stripped normalized labels
    if (this.hasNormLabels) {
      const normValue = `%${value.toLowerCase().replace(/ /g, "")}%`;
      const fallbackRows = this.db!.prepare(
        `SELECT id FROM vocabulary WHERE (label_en_norm LIKE ? OR label_nl_norm LIKE ?)${typeClause}`
      ).all(normValue, normValue, ...typeBindings) as { id: string }[];
      return fallbackRows.map((r) => r.id);
    }

    return [];
  }

  /** Stop words for person name token-AND fallback (common name prepositions). */
  private static readonly PERSON_STOP_WORDS = new Set([
    "van", "von", "de", "di", "du", "of", "zu",
    "het", "the", "la", "le", "el", "den", "der", "ten", "ter", "della",
  ]);

  /**
   * Find person vocab IDs via the person_names_fts table (two-tier).
   * Tier 1: Exact phrase match across all name variants.
   * Tier 2: Token AND fallback (stripping name prepositions) if Tier 1 returns 0.
   */
  private findPersonIdsFts(value: string): string[] {
    // Tier 1: phrase match
    const ftsPhrase = escapeFts5(value);
    if (!ftsPhrase) return [];

    const rows = this.db!.prepare(
      `SELECT DISTINCT pn.person_id AS id
       FROM person_names pn
       WHERE pn.rowid IN (
         SELECT rowid FROM person_names_fts WHERE person_names_fts MATCH ?
       )`
    ).all(ftsPhrase) as { id: string }[];

    if (rows.length > 0) return rows.map((r) => r.id);

    // Tier 2: token AND with stop-word removal
    const tokens = value
      .split(/\s+/)
      .filter((t) => t.length > 0 && !VocabularyDb.PERSON_STOP_WORDS.has(t.toLowerCase()));
    if (tokens.length === 0) return [];

    const ftsTokens = tokens
      .map((t) => escapeFts5(t))
      .filter((x): x is string => x !== null);
    if (ftsTokens.length === 0) return [];

    const ftsQuery = ftsTokens.join(" AND ");
    const fallbackRows = this.db!.prepare(
      `SELECT DISTINCT pn.person_id AS id
       FROM person_names pn
       WHERE pn.rowid IN (
         SELECT rowid FROM person_names_fts WHERE person_names_fts MATCH ?
       )`
    ).all(ftsQuery) as { id: string }[];

    return fallbackRows.map((r) => r.id);
  }

  /** Build vocab WHERE clause and bindings for the non-FTS path. */
  private buildVocabMatch(matchMode: VocabFilter["matchMode"], value: unknown): { where: string; bindings: unknown[] } {
    switch (matchMode) {
      case "exact-notation":
        return { where: "notation = ?", bindings: [value] };
      case "like-word":
        return { where: "(regexp_word(?, label_en) OR regexp_word(?, label_nl))", bindings: [value, value] };
      default:
        return { where: "(label_en LIKE ? COLLATE NOCASE OR label_nl LIKE ? COLLATE NOCASE)", bindings: [`%${value}%`, `%${value}%`] };
    }
  }

  /**
   * Convert text vocab IDs to integer `vocab_int_id` values.
   * Chunks at 500 to stay within SQLite's variable limit.
   */
  private vocabIdsToRowids(textIds: string[]): number[] {
    const CHUNK = 500;
    const result: number[] = [];
    for (let i = 0; i < textIds.length; i += CHUNK) {
      const chunk = textIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db!.prepare(
        `SELECT vocab_int_id FROM vocabulary WHERE id IN (${placeholders})`
      ).all(...chunk) as { vocab_int_id: number }[];
      for (const r of rows) result.push(r.vocab_int_id);
    }
    return result;
  }

  /**
   * Build a mapping filter for the FTS/geo paths where vocab IDs are already resolved.
   * Returns SQL condition + bindings for use in a WHERE clause on `artworks a`.
   */
  private mappingFilterDirect(
    fields: string[],
    vocabTextIds: string[],
  ): { condition: string; bindings: unknown[] } {
    const { clause: fieldClause, bindings: fieldBindings } = this.buildFieldClause(fields);

    if (this.hasIntMappings) {
      const rowids = this.vocabIdsToRowids(vocabTextIds);
      if (rowids.length === 0) return { condition: "0", bindings: [] };
      const placeholders = rowids.map(() => "?").join(", ");
      return {
        condition: `a.art_id IN (
          SELECT m.artwork_id FROM mappings m
          WHERE ${fieldClause} AND m.vocab_rowid IN (${placeholders})
        )`,
        bindings: [...fieldBindings, ...rowids],
      };
    }

    const placeholders = vocabTextIds.map(() => "?").join(", ");
    return {
      condition: `a.object_number IN (
        SELECT m.object_number FROM mappings m
        WHERE ${fieldClause} AND m.vocab_id IN (${placeholders})
      )`,
      bindings: [...fieldBindings, ...vocabTextIds],
    };
  }

  /**
   * Build a mapping filter for the non-FTS path with a vocabulary subquery.
   * Returns SQL condition + bindings for use in a WHERE clause on `artworks a`.
   */
  private mappingFilterSubquery(
    fields: string[],
    vocabWhere: string,
    vocabBindings: unknown[],
  ): { condition: string; bindings: unknown[] } {
    const { clause: fieldClause, bindings: fieldBindings } = this.buildFieldClause(fields);
    const [artworkCol, vocabIdCol] = this.hasIntMappings
      ? ["a.art_id", "vocab_int_id"]
      : ["a.object_number", "id"];
    const [mappingArtCol, mappingVocabCol] = this.hasIntMappings
      ? ["m.artwork_id", "m.vocab_rowid"]
      : ["m.object_number", "m.vocab_id"];

    return {
      condition: `${artworkCol} IN (
        SELECT ${mappingArtCol} FROM mappings m
        WHERE ${fieldClause} AND ${mappingVocabCol} IN (
          SELECT ${vocabIdCol} FROM vocabulary WHERE ${vocabWhere}
        )
      )`,
      bindings: [...fieldBindings, ...vocabBindings],
    };
  }

  /** Check if there's actual geocoded data (not just an empty lat column). */
  private hasGeocodedData(): boolean {
    try {
      const row = this.db!.prepare(
        "SELECT 1 FROM vocabulary WHERE lat IS NOT NULL LIMIT 1"
      ).get();
      return row !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a place name to coordinates, then find all nearby place vocab IDs.
   * Returns null if the place cannot be resolved or has no coordinates.
   */
  private findNearbyPlaceIds(
    placeName: string,
    radiusKm: number,
    warnings?: string[]
  ): { placeIds: string[]; refPlace: string; refLat: number; refLon: number } | null {
    const ref = this.resolvePlaceCoordinates(placeName, warnings);
    if (!ref) return null;

    const placeIds = this.findPlaceIdsNearCoords(ref.lat, ref.lon, radiusKm);
    return { placeIds, refPlace: ref.label, refLat: ref.lat, refLon: ref.lon };
  }

  /** Find all place vocab IDs within radiusKm of the given coordinates (bounding box + Haversine). */
  private findPlaceIdsNearCoords(lat: number, lon: number, radiusKm: number): string[] {
    const toRad = Math.PI / 180;
    const latDelta = radiusKm / 111.0;
    const lonDelta = radiusKm / (111.0 * Math.cos(lat * toRad));

    const rows = this.db!.prepare(
      `SELECT id FROM vocabulary
       WHERE type = 'place' AND lat IS NOT NULL
         AND lat BETWEEN ? AND ?
         AND lon BETWEEN ? AND ?
         AND haversine_km(?, ?, lat, lon) <= ?`
    ).all(
      lat - latDelta, lat + latDelta,
      lon - lonDelta, lon + lonDelta,
      lat, lon, radiusKm
    ) as { id: string }[];

    return rows.map((r) => r.id);
  }

  /**
   * Resolve a place name to its label and coordinates.
   * Supports multi-word queries like "Oude Kerk Amsterdam" via progressive
   * token splitting and geo-disambiguation.
   *
   * Returns null if the place cannot be resolved.
   * `warnings` array receives interpretation notes when input is split.
   */
  private resolvePlaceCoordinates(
    placeName: string,
    warnings?: string[]
  ): { label: string; lat: number; lon: number } | null {
    type PlaceRow = { label_en: string | null; label_nl: string | null; lat: number; lon: number };

    // Fast path: direct FTS/LIKE phrase match
    let row: PlaceRow | undefined;

    if (this.hasFts5) {
      const vocabIds = this.findVocabIdsFts(placeName, " AND type = ?", ["place"]);
      if (vocabIds.length > 0) {
        const placeholders = vocabIds.map(() => "?").join(", ");
        row = this.db!.prepare(
          `SELECT label_en, label_nl, lat, lon FROM vocabulary
           WHERE id IN (${placeholders}) AND lat IS NOT NULL
           ORDER BY LENGTH(COALESCE(label_en, label_nl, ''))
           LIMIT 1`
        ).get(...vocabIds) as PlaceRow | undefined;
      }
    } else {
      row = this.db!.prepare(
        `SELECT label_en, label_nl, lat, lon FROM vocabulary
         WHERE type = 'place' AND lat IS NOT NULL
           AND (label_en LIKE ? COLLATE NOCASE OR label_nl LIKE ? COLLATE NOCASE)
         LIMIT 1`
      ).get(`%${placeName}%`, `%${placeName}%`) as PlaceRow | undefined;
    }

    if (row) {
      return { label: row.label_en || row.label_nl || placeName, lat: row.lat, lon: row.lon };
    }

    // Multi-word fallback: split input and geo-disambiguate
    const resolved = this.resolveMultiWordPlace(placeName);
    if (!resolved || resolved.candidates.length === 0) return null;

    const hasContext = resolved.contextLat != null && resolved.contextLon != null;
    const prefix = `nearPlace:"${placeName}"`;

    // Pick best candidate: if context provided coords, pick nearest; otherwise first with coords
    let best: PlaceCandidateRow & { lat: number; lon: number } | undefined;
    if (hasContext) {
      const { ids } = rankByProximity(resolved.candidates, resolved.contextLat!, resolved.contextLon!);
      // ids[0] is the closest — find its full candidate record
      const bestId = ids[0];
      best = bestId != null
        ? resolved.candidates.find(
            (c): c is PlaceCandidateRow & { lat: number; lon: number } => c.id === bestId,
          )
        : undefined;
      if (best && warnings) {
        const label = best.label_en || best.label_nl || "";
        warnings.push(
          `${prefix} → Interpreted as "${resolved.namePart}" near "${resolved.contextPart}" ` +
          `(${resolved.contextLat!.toFixed(4)}, ${resolved.contextLon!.toFixed(4)}). ` +
          `Matched "${label}" (${pluralize(resolved.candidates.length, "candidate")}).`
        );
      }
    } else {
      best = resolved.candidates.find(
        (c): c is PlaceCandidateRow & { lat: number; lon: number } => c.lat != null && c.lon != null,
      );
      if (best && warnings) {
        warnings.push(buildMultiWordPlaceWarning(
          prefix, resolved.namePart, resolved.contextPart,
          resolved.candidates.length,
        ));
      }
    }

    if (!best) return null;
    return { label: best.label_en || best.label_nl || placeName, lat: best.lat, lon: best.lon };
  }

  /**
   * Progressive token splitting for multi-word place queries.
   *
   * Tries to split "Oude Kerk Amsterdam" into name="Oude Kerk" + context="Amsterdam",
   * resolves name candidates via FTS, then optionally resolves context to coordinates
   * for geo-disambiguation.
   */
  private resolveMultiWordPlace(input: string): {
    namePart: string;
    contextPart: string;
    candidates: PlaceCandidateRow[];
    contextLat?: number;
    contextLon?: number;
  } | null {
    let namePart = "";
    let contextPart = "";
    let candidates: PlaceCandidateRow[] = [];

    // Strategy 1: comma-split
    const commaIdx = input.indexOf(",");
    if (commaIdx !== -1) {
      namePart = input.slice(0, commaIdx).trim();
      contextPart = input.slice(commaIdx + 1).trim();
      if (namePart) {
        candidates = this.findPlaceCandidates(namePart);
      }
    }

    // Strategy 2: progressive right-token dropping (also used as fallback when comma-split yields 0)
    if (candidates.length === 0) {
      const normalized = input.replace(/,/g, " ").trim();
      const tokens = normalized.split(/\s+/);
      if (tokens.length < 2) return null; // single word — nothing to split

      namePart = "";
      contextPart = "";

      for (let i = tokens.length - 1; i >= 1; i--) {
        const tryName = tokens.slice(0, i).join(" ");
        const tryContext = tokens.slice(i).join(" ");
        const tryCandidates = this.findPlaceCandidates(tryName);
        if (tryCandidates.length > 0) {
          namePart = tryName;
          contextPart = tryContext;
          candidates = tryCandidates;
          break;
        }
      }
    }

    if (candidates.length === 0) return null;

    // If only 1 candidate with coords, skip context resolution
    const geocoded = candidates.filter((c) => c.lat != null);
    if (geocoded.length <= 1) {
      return { namePart, contextPart, candidates };
    }

    // Resolve context to coordinates for disambiguation
    if (contextPart) {
      const ctx = this.resolveContextCoordinates(contextPart);
      if (ctx) {
        return { namePart, contextPart, candidates, contextLat: ctx.lat, contextLon: ctx.lon };
      }
    }

    return { namePart, contextPart, candidates };
  }

  /**
   * Find place vocabulary entries matching a name via FTS phrase match.
   * Returns all matches (not just first), with coordinates where available.
   */
  private findPlaceCandidates(name: string): PlaceCandidateRow[] {
    if (this.hasFts5) {
      const vocabIds = this.findVocabIdsFts(name, " AND type = ?", ["place"]);
      if (vocabIds.length === 0) return [];
      const placeholders = vocabIds.map(() => "?").join(", ");
      return this.db!.prepare(
        `SELECT id, label_en, label_nl, lat, lon FROM vocabulary WHERE id IN (${placeholders})`
      ).all(...vocabIds) as PlaceCandidateRow[];
    }

    // Non-FTS fallback (capped to avoid huge IN-lists from short generic terms)
    return this.db!.prepare(
      `SELECT id, label_en, label_nl, lat, lon FROM vocabulary
       WHERE type = 'place'
         AND (label_en LIKE ? COLLATE NOCASE OR label_nl LIKE ? COLLATE NOCASE)
       LIMIT 200`
    ).all(`%${name}%`, `%${name}%`) as PlaceCandidateRow[];
  }

  /**
   * Resolve a context string (e.g. "Amsterdam", "Den Haag") to coordinates.
   * Prefers exact label match over FTS to avoid false positives like
   * "Le Touquet-Paris-Plage" matching "Paris".
   */
  private resolveContextCoordinates(context: string): { lat: number; lon: number } | null {
    type CoordRow = { lat: number; lon: number };

    // Step 1: exact label match (case-insensitive)
    const exact = this.db!.prepare(
      `SELECT lat, lon FROM vocabulary
       WHERE type = 'place' AND lat IS NOT NULL
         AND (label_en = ? COLLATE NOCASE OR label_nl = ? COLLATE NOCASE)
       LIMIT 1`
    ).get(context, context) as CoordRow | undefined;

    if (exact) return exact;

    // Step 2: FTS phrase match, prefer shortest label (avoids "Le Touquet-Paris-Plage" for "Paris")
    if (this.hasFts5) {
      const vocabIds = this.findVocabIdsFts(context, " AND type = ?", ["place"]);
      if (vocabIds.length > 0) {
        const placeholders = vocabIds.map(() => "?").join(", ");
        const row = this.db!.prepare(
          `SELECT lat, lon FROM vocabulary
           WHERE id IN (${placeholders}) AND lat IS NOT NULL
           ORDER BY LENGTH(COALESCE(label_en, label_nl, ''))
           LIMIT 1`
        ).get(...vocabIds) as CoordRow | undefined;
        if (row) return row;
      }
    }

    return null;
  }

}
