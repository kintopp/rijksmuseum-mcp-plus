import Database, { type Database as DatabaseType } from "better-sqlite3";
import { escapeFts5, resolveDbPath } from "../utils/db.js";

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
  inscription?: string;
  provenance?: string;
  creditLine?: string;
  narrative?: string;
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
  maxResults?: number;
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
];

/** Row shape returned by place-candidate queries (findPlaceCandidates, resolveMultiWordPlace). */
type PlaceCandidateRow = {
  id: string;
  label_en: string | null;
  label_nl: string | null;
  lat: number | null;
  lon: number | null;
};

/** Haversine distance in km between two lat/lon points. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
    Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** Pluralize a count: `pluralize(3, "place") → "3 places"`. */
function pluralize(n: number, noun: string): string {
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

/**
 * Build a warning message for multi-word place interpretation.
 * Three variants: geo-filtered (with context coords), unresolved context, no context.
 */
function buildMultiWordPlaceWarning(
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

function emptyResult(warnings?: string[]): VocabSearchResult {
  return {
    totalResults: 0,
    results: [],
    source: "vocabulary",
    ...(warnings && warnings.length > 0 && { warnings }),
  };
}

/**
 * Parse a creationDate wildcard string into an integer year range.
 * - "1642"  → { earliest: 1642, latest: 1642 }
 * - "164*"  → { earliest: 1640, latest: 1649 }
 * - "16*"   → { earliest: 1600, latest: 1699 }
 * - "-5*"   → { earliest: -5999, latest: -5000 } (BCE, 4-digit convention)
 */
function parseDateFilter(creationDate: string): { earliest: number; latest: number } | null {
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

      const features = [
        this.hasFts5 && "vocabFTS5",
        this.hasTextFts && "textFTS5",
        this.hasDimensions && "dimensions",
        this.hasDates && "dates",
        this.hasNormLabels && "normLabels",
        this.hasCoordinates && "coordinates",
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

    const CHUNK = 500;
    for (let i = 0; i < objectNumbers.length; i += CHUNK) {
      const chunk = objectNumbers.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db.prepare(
        `SELECT m.object_number, COALESCE(v.label_en, v.label_nl, '') AS label
         FROM mappings m JOIN vocabulary v ON m.vocab_id = v.id
         WHERE m.object_number IN (${placeholders}) AND m.field = 'type'`
      ).all(...chunk) as { object_number: string; label: string }[];
      for (const r of rows) {
        if (r.label && !map.has(r.object_number)) map.set(r.object_number, r.label);
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

  /** Search artworks by vocabulary criteria. Multiple params are intersected (AND). */
  search(params: VocabSearchParams): VocabSearchResult {
    if (!this.db) {
      return emptyResult();
    }

    // Work on a shallow copy so we never mutate the caller's object
    const effective = { ...params };

    const conditions: string[] = [];
    const bindings: unknown[] = [];
    const warnings: string[] = [];
    let geoResult: { placeIds: number[]; referencePlace: string; refLat: number; refLon: number } | null = null;

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

        const placeholders = geoResult.placeIds.map(() => "?").join(", ");
        conditions.push(`a.object_number IN (
          SELECT m.object_number FROM mappings m
          WHERE m.field IN ('subject', 'spatial') AND m.vocab_id IN (${placeholders})
        )`);
        bindings.push(...geoResult.placeIds);
      }
    }

    for (const filter of VOCAB_FILTERS) {
      const value = effective[filter.param];
      if (value === undefined) continue;

      for (const f of filter.fields) {
        if (!ALLOWED_FIELDS.has(f)) throw new Error(`Invalid vocab field: ${f}`);
      }
      if (filter.vocabType && !ALLOWED_VOCAB_TYPES.has(filter.vocabType)) {
        throw new Error(`Invalid vocab type: ${filter.vocabType}`);
      }

      const fieldPlaceholders = filter.fields.map(() => "?").join(", ");
      const fieldClause = filter.fields.length === 1
        ? `m.field = ?`
        : `m.field IN (${fieldPlaceholders})`;

      const typeClause = filter.vocabType ? ` AND type = ?` : "";
      const typeBindings: unknown[] = filter.vocabType ? [filter.vocabType] : [];

      const useFts = this.hasFts5 && filter.ftsUpgrade && filter.matchMode !== "exact-notation";

      if (useFts) {
        let vocabIds = this.findVocabIdsFts(String(value), typeClause, typeBindings);

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
              warnings.push(buildMultiWordPlaceWarning(
                prefix, resolved.namePart, resolved.contextPart,
                resolved.candidates.length,
                { filteredCount: ids.length, geocodedCount },
              ));
            } else {
              vocabIds = resolved.candidates.map((c) => c.id);
              warnings.push(buildMultiWordPlaceWarning(
                prefix, resolved.namePart, resolved.contextPart,
                vocabIds.length,
              ));
            }
          }
        }

        if (vocabIds.length === 0) {
          return emptyResult(warnings);
        }
        const placeholders = vocabIds.map(() => "?").join(", ");
        conditions.push(`a.object_number IN (
          SELECT m.object_number FROM mappings m
          WHERE ${fieldClause} AND m.vocab_id IN (${placeholders})
        )`);
        bindings.push(...filter.fields, ...vocabIds);
      } else {
        const { where: vocabWhere, bindings: matchBindings } = this.buildVocabMatch(filter.matchMode, value);
        conditions.push(`a.object_number IN (
          SELECT m.object_number FROM mappings m
          WHERE ${fieldClause} AND m.vocab_id IN (
            SELECT id FROM vocabulary WHERE ${vocabWhere}${typeClause}
          )
        )`);
        bindings.push(...filter.fields, ...matchBindings, ...typeBindings);
      }
    }

    // Direct column filter: license matches against artworks.rights_uri
    if (effective.license) {
      conditions.push("a.rights_uri LIKE ?");
      bindings.push(`%${effective.license}%`);
    }

    // Tier 2: Text FTS filters (inscription, provenance, creditLine, narrative)
    const TEXT_FILTERS: [keyof VocabSearchParams, string][] = [
      ["inscription", "inscription_text"],
      ["provenance", "provenance_text"],
      ["creditLine", "credit_line"],
      ["narrative", "narrative_text"],
      ["title", "title_all_text"],
    ];
    const requestedTextFilters = TEXT_FILTERS.filter(([param]) => typeof effective[param] === "string");
    if (requestedTextFilters.length > 0) {
      if (this.hasTextFts) {
        for (const [param, column] of requestedTextFilters) {
          const ftsPhrase = escapeFts5(effective[param] as string);
          if (!ftsPhrase) continue; // skip empty-after-stripping queries
          conditions.push(`a.rowid IN (SELECT rowid FROM artwork_texts_fts WHERE ${column} MATCH ?)`);
          bindings.push(ftsPhrase);
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

    // Creation date range filter
    if (effective.creationDate) {
      if (this.hasDates) {
        const range = parseDateFilter(effective.creationDate);
        if (range) {
          // Overlap test: artwork range [date_earliest, date_latest] overlaps query range [earliest, latest]
          conditions.push("a.date_earliest IS NOT NULL AND a.date_latest >= ? AND a.date_earliest <= ?");
          bindings.push(range.earliest, range.latest);
        } else {
          warnings.push(`Could not parse creationDate "${effective.creationDate}". Expected a year ("1642") or wildcard ("164*", "16*").`);
        }
      } else {
        warnings.push("Date filtering requires a vocabulary DB with date columns (re-run harvest Phase 4). This filter was ignored.");
      }
    }

    if (conditions.length === 0) {
      return emptyResult(warnings);
    }

    const where = conditions.join(" AND ");
    const limit = Math.min(effective.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP);

    // COUNT is expensive for cross-filter queries (multiple IN-subquery intersections
    // can scan tens of thousands of rows). Only compute it for single-filter queries.
    const totalResults = conditions.length === 1
      ? (this.db.prepare(`SELECT COUNT(*) as n FROM artworks a WHERE ${where}`).get(...bindings) as { n: number }).n
      : undefined;

    const sql = `SELECT a.object_number, a.title, a.creator_label, a.date_earliest, a.date_latest FROM artworks a WHERE ${where} LIMIT ?`;
    const rows = this.db.prepare(sql).all(...bindings, limit) as {
      object_number: string;
      title: string;
      creator_label: string;
      date_earliest: number | null;
      date_latest: number | null;
    }[];

    // When nearPlace is active, enrich results with nearest place + distance
    let distanceMap: Map<string, { place: string; dist: number }> | undefined;
    if (geoResult && rows.length > 0) {
      const objNums = rows.map((r) => r.object_number);
      const objPlaceholders = objNums.map(() => "?").join(", ");
      const distRows = this.db.prepare(
        `SELECT m.object_number, v.label_en, v.label_nl,
                haversine_km(?, ?, v.lat, v.lon) AS dist
         FROM mappings m JOIN vocabulary v ON m.vocab_id = v.id
         WHERE m.object_number IN (${objPlaceholders})
           AND m.field IN ('subject', 'spatial')
           AND v.lat IS NOT NULL
         ORDER BY dist`
      ).all(geoResult.refLat, geoResult.refLon, ...objNums) as {
        object_number: string;
        label_en: string | null;
        label_nl: string | null;
        dist: number;
      }[];

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

    // Enrich results with object type from mappings
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
      ...(warnings.length > 0 && { warnings }),
    };
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
  private findVocabIdsFts(value: string, typeClause: string, typeBindings: unknown[]): string[] {
    const ftsPhrase = escapeFts5(value);
    if (!ftsPhrase) return [];
    const rows = this.db!.prepare(
      `SELECT id FROM vocabulary WHERE rowid IN (SELECT rowid FROM vocabulary_fts WHERE vocabulary_fts MATCH ?)${typeClause}`
    ).all(ftsPhrase, ...typeBindings) as { id: string }[];

    if (rows.length > 0) return rows.map((r) => r.id);

    // FTS5 found nothing — try LIKE on space-stripped normalized labels
    if (this.hasNormLabels) {
      const normValue = `%${value.toLowerCase().replace(/ /g, "")}%`;
      const fallbackRows = this.db!.prepare(
        `SELECT id FROM vocabulary WHERE (label_en_norm LIKE ? OR label_nl_norm LIKE ?)${typeClause}`
      ).all(normValue, normValue, ...typeBindings) as { id: string }[];
      return fallbackRows.map((r) => r.id);
    }

    return [];
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
  ): { placeIds: number[]; refPlace: string; refLat: number; refLon: number } | null {
    const ref = this.resolvePlaceCoordinates(placeName, warnings);
    if (!ref) return null;

    const placeIds = this.findPlaceIdsNearCoords(ref.lat, ref.lon, radiusKm);
    return { placeIds, refPlace: ref.label, refLat: ref.lat, refLon: ref.lon };
  }

  /** Find all place vocab IDs within radiusKm of the given coordinates (bounding box + Haversine). */
  private findPlaceIdsNearCoords(lat: number, lon: number, radiusKm: number): number[] {
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
    ) as { id: number }[];

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
