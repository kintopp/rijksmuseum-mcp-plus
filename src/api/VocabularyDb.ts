import Database, { type Database as DatabaseType } from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

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

/** Escape a value for safe FTS5 phrase matching: strip operators, escape quotes. */
function escapeFts5(value: string): string {
  return `"${value.replace(/[*^():]/g, "").replace(/"/g, '""')}"`;
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
    const dbPath = this.resolveDbPath();
    if (!dbPath) {
      console.error("Vocabulary DB not found — vocabulary search disabled");
      return;
    }

    try {
      this.db = new Database(dbPath, { readonly: true });
      // Word-boundary matching for subject search (e.g. "cat" must not match "Catharijnekerk")
      this.db.function("regexp_word", (pattern: string, value: string) => {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped}\\b`, "i").test(value) ? 1 : 0;
      });
      // Haversine distance in km for geo proximity search
      this.db.function("haversine_km", (lat1: number, lon1: number, lat2: number, lon2: number) => {
        const toRad = Math.PI / 180;
        const dLat = (lat2 - lat1) * toRad;
        const dLon = (lon2 - lon1) * toRad;
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
          Math.sin(dLon / 2) ** 2;
        return 6371 * 2 * Math.asin(Math.sqrt(a));
      });
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
          const resolved = this.findNearbyPlaceIds(effective.nearPlace!, radiusKm);

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
        const vocabIds = this.findVocabIdsFts(String(value), typeClause, typeBindings);
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
          conditions.push(`a.rowid IN (SELECT rowid FROM artwork_texts_fts WHERE ${column} MATCH ?)`);
          bindings.push(escapeFts5(effective[param] as string));
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

    const sql = `SELECT a.object_number, a.title, a.creator_label FROM artworks a WHERE ${where} LIMIT ?`;
    const rows = this.db.prepare(sql).all(...bindings, limit) as {
      object_number: string;
      title: string;
      creator_label: string;
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

    return {
      totalResults,
      ...(geoResult && { referencePlace: geoResult.referencePlace }),
      results: rows.map((r) => {
        const d = distanceMap?.get(r.object_number);
        return {
          objectNumber: r.object_number,
          title: r.title || "",
          creator: r.creator_label || "",
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
    radiusKm: number
  ): { placeIds: number[]; refPlace: string; refLat: number; refLon: number } | null {
    const ref = this.resolvePlaceCoordinates(placeName);
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

  /** Resolve a place name to its label and coordinates. Returns null if not found. */
  private resolvePlaceCoordinates(
    placeName: string
  ): { label: string; lat: number; lon: number } | null {
    type PlaceRow = { label_en: string | null; label_nl: string | null; lat: number; lon: number };

    let row: PlaceRow | undefined;

    if (this.hasFts5) {
      const vocabIds = this.findVocabIdsFts(placeName, " AND type = ?", ["place"]);
      if (vocabIds.length > 0) {
        const placeholders = vocabIds.map(() => "?").join(", ");
        row = this.db!.prepare(
          `SELECT label_en, label_nl, lat, lon FROM vocabulary
           WHERE id IN (${placeholders}) AND lat IS NOT NULL
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

    if (!row) return null;
    return { label: row.label_en || row.label_nl || placeName, lat: row.lat, lon: row.lon };
  }

  private resolveDbPath(): string | null {
    // 1. Explicit env var
    const envPath = process.env.VOCAB_DB_PATH;
    if (envPath && fs.existsSync(envPath)) return envPath;

    // 2. Default ./data/vocabulary.db
    const defaultPath = path.join(process.cwd(), "data", "vocabulary.db");
    if (fs.existsSync(defaultPath)) return defaultPath;

    return null;
  }
}
