import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import { escapeFts5, expandFtsQuery, resolveDbPath } from "../utils/db.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface VocabSearchParams {
  subject?: string;
  iconclass?: string;
  depictedPerson?: string;
  depictedPlace?: string;
  productionPlace?: string;
  birthPlace?: string;
  deathPlace?: string;
  profession?: string;
  material?: string;
  technique?: string;
  type?: string;
  creator?: string;
  collectionSet?: string;
  license?: string;
  // Tier 2 fields (require vocabulary DB v1.0+)
  description?: string;
  inscription?: string;
  provenance?: string;
  creditLine?: string;
  curatorialNarrative?: string;
  productionRole?: string;
  minHeight?: number;
  maxHeight?: number;
  minWidth?: number;
  maxWidth?: number;
  // Date and title filters (require vocabulary DB with date/title columns)
  creationDate?: string;
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
  maxResults?: number;
  facets?: boolean;
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
  private stmtFilterArtIds = new Map<string, Statement>();

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

      // Warn if geo index is missing (must be created during harvest, not at runtime — DB is read-only)
      if (this.hasCoordinates) {
        try {
          const hasGeoIdx = this.db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_vocab_lat_lon'"
          ).get();
          if (!hasGeoIdx) {
            console.error("Warning: idx_vocab_lat_lon index missing — nearPlace queries may be slower. Re-run harvest Phase 3 to create it.");
          }
        } catch { /* ignore */ }
      }

      // Cache frequently-used prepared statements
      this.stmtLookupArtwork = this.db.prepare(
        "SELECT title, creator_label, date_earliest, date_latest FROM artworks WHERE object_number = ?"
      );

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
    const row = this.stmtLookupArtwork.get(objectNumber) as { title: string; creator_label: string; date_earliest: number | null; date_latest: number | null } | undefined;
    if (!row) return null;
    return { title: row.title || "", creator: row.creator_label || "", dateEarliest: row.date_earliest, dateLatest: row.date_latest };
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
  searchCompact(params: VocabSearchParams): { totalResults?: number; ids: string[]; source: "vocabulary"; warnings?: string[] } {
    if (!this.db) return { ids: [], source: "vocabulary" };
    // Delegate to search with compact flag — the internal implementation checks this
    const result = this.searchInternal(params, true);
    return {
      ...(result.totalResults != null && { totalResults: result.totalResults }),
      ids: result.results.map((r) => r.objectNumber),
      source: "vocabulary",
      ...(result.warnings && result.warnings.length > 0 && { warnings: result.warnings }),
    };
  }

  /** Search artworks by vocabulary criteria. Multiple params are intersected (AND). */
  search(params: VocabSearchParams): VocabSearchResult {
    return this.searchInternal(params, false);
  }

  /**
   * Compute top-5 faceted counts across type, material, technique, and century.
   * Runs GROUP BY queries using the same WHERE clause as the main search.
   * Skips dimensions the user already filtered on.
   */
  private computeFacets(
    conditions: string[],
    bindings: unknown[],
    ftsJoinClause: string,
    ftsJoinBinding: unknown | null,
    excludeFields: Set<string>,
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
      if (excludeFields.has(label)) continue;
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
        `JOIN mappings fm ON fm.artwork_id = a.art_id AND fm.field_id = ? ` +
        `JOIN vocabulary v ON fm.vocab_rowid = v.vocab_int_id ` +
        `WHERE ${where} AND v.label_en IS NOT NULL ` +
        `GROUP BY label ORDER BY cnt DESC LIMIT 5`;
      const rows = this.db.prepare(sql).all(...facetBindings) as { label: string; cnt: number }[];
      if (rows.length > 0) {
        result[label] = rows.map(r => ({ label: r.label, count: r.cnt }));
      }
    }

    // Century facet (computed from date_earliest)
    if (!excludeFields.has("century") && this.hasDates) {
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

    // COUNT is expensive for cross-filter queries (multiple IN-subquery intersections
    // can scan tens of thousands of rows). Only compute it for single-filter queries
    // (plus the optional FTS JOIN which is cheap).
    const countFilterCount = conditions.length + (ftsJoinClause ? 1 : 0);
    const totalResults = countFilterCount === 1
      ? (this.db.prepare(`SELECT COUNT(*) as n FROM artworks a ${ftsJoinClause} WHERE ${where}`).get(
          ...(ftsJoinBinding != null ? [ftsJoinBinding, ...bindings] : bindings),
        ) as { n: number }).n
      : undefined;

    const orderBy = ftsRankOrder
      ? "ORDER BY fts.rank"
      : this.hasImportance
        ? "ORDER BY a.importance DESC"
        : "";
    const sql = `SELECT a.object_number, a.title, a.creator_label, a.date_earliest, a.date_latest FROM artworks a ${ftsJoinClause} WHERE ${where} ${orderBy} LIMIT ?`;
    const rows = this.db.prepare(sql).all(
      ...(ftsJoinBinding != null ? [ftsJoinBinding, ...bindings, limit] : [...bindings, limit]),
    ) as {
      object_number: string;
      title: string;
      creator_label: string;
      date_earliest: number | null;
      date_latest: number | null;
    }[];

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

    // Faceted counts: compute when requested, results were truncated, and not compact
    let facets: Record<string, Array<{ label: string; count: number }>> | undefined;
    if (effective.facets && !compact && rows.length >= limit) {
      const excludeFields = new Set<string>();
      if (effective.type) excludeFields.add("type");
      if (effective.material) excludeFields.add("material");
      if (effective.technique) excludeFields.add("technique");
      if (effective.creationDate) excludeFields.add("century");
      facets = this.computeFacets(conditions, bindings, ftsJoinClause, ftsJoinBinding, excludeFields);
      if (Object.keys(facets).length === 0) facets = undefined;
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
          title: r.title || "",
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
      const value = effective[filter.param];
      if (value === undefined) continue;

      for (const f of filter.fields) {
        if (!ALLOWED_FIELDS.has(f)) throw new Error(`Invalid vocab field: ${f}`);
      }
      if (filter.vocabType && !ALLOWED_VOCAB_TYPES.has(filter.vocabType)) {
        throw new Error(`Invalid vocab type: ${filter.vocabType}`);
      }

      const typeClause = filter.vocabType ? ` AND type = ?` : "";
      const typeBindings: unknown[] = filter.vocabType ? [filter.vocabType] : [];

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

        if (vocabIds.length === 0) {
          return null; // signal: zero matches for this filter
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
          conditions.push("a.date_earliest IS NOT NULL AND a.date_latest >= ? AND a.date_earliest <= ?");
          bindings.push(range.earliest, range.latest);
        } else {
          warnings?.push(`Could not parse creationDate "${effective.creationDate}". Expected a year ("1642") or wildcard ("164*", "16*").`);
        }
      } else {
        warnings?.push("Date filtering requires a vocabulary DB with date columns (re-run harvest Phase 4). This filter was ignored.");
      }
    }

    return { conditions, bindings };
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
    if (vocabResult.conditions.length === 0) return [];

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
