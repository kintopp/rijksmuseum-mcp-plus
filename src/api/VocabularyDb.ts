import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import { escapeFts5, expandFtsQuery, resolveDbPath } from "../utils/db.js";

// ─── Types ───────────────────────────────────────────────────────────

/** Single value or array of values (array = AND/intersection). */
type StringOrArray = string | string[];

/** Allowed languages on a title variant. Unknown values collapse to "other". */
export const TITLE_LANGUAGES = ["en", "nl", "other"] as const;
export type TitleLanguage = (typeof TITLE_LANGUAGES)[number];

/** Allowed qualifiers on a title variant. Unknown values collapse to "other". */
export const TITLE_QUALIFIERS = ["brief", "full", "display", "former", "other"] as const;
export type TitleQualifier = (typeof TITLE_QUALIFIERS)[number];

/** Allowed structured-dimension types. */
export const DIMENSION_TYPES = ["height", "width", "depth", "weight", "diameter"] as const;
export type DimensionType = (typeof DIMENSION_TYPES)[number];

const TITLE_LANGUAGES_SET = new Set<TitleLanguage>(TITLE_LANGUAGES);
const TITLE_QUALIFIERS_SET = new Set<TitleQualifier>(TITLE_QUALIFIERS);

export interface PersonInfo {
  birthYear: number | null;
  deathYear: number | null;
  gender: string | null;
  wikidataId: string | null;
}

/** Full artwork detail assembled from vocab DB — replaces ArtworkDetailEnriched from Linked Art. */
export interface ArtworkDetailFromDb {
  id: string;
  objectNumber: string;
  title: string;
  creator: string;
  date: string;
  type?: string;
  url: string;
  description: string | null;
  techniqueStatement: string | null;
  dimensionStatement: string | null;
  provenance: string | null;
  creditLine: string | null;
  inscriptions: string[];
  /** Resolved museum room (current_location → museum_rooms join). Null when not on display or unmatched. */
  location: { roomId: string; floor: string | null; roomName: string | null } | null;
  collectionSets: string[];
  externalIds: { handle: string | null; other: string[] };
  titles: {
    title: string;
    language: TitleLanguage;
    qualifier: TitleQualifier;
  }[];
  /** Parent records (e.g. the sketchbook this folio belongs to). Empty for top-level objects. */
  parents: { objectNumber: string; title: string }[];
  /** Total count of child records (e.g. folios for a sketchbook parent). */
  childCount: number;
  /** Up to {@link CHILD_PREVIEW_LIMIT} child records, ordered by object_number. */
  children: { objectNumber: string; title: string }[];
  curatorialNarrative: { en: string | null; nl: string | null };
  license: string | null;
  webPage: string | null;
  dimensions: { type: DimensionType; value: number; unit: string; note: string | null }[];
  relatedObjects: {
    relationship: string;
    objectNumber: string | null;
    title: string | null;
    objectUri: string;
    iiifId: string | null;
  }[];
  /** Total related-object count before capping at {@link RELATED_PREVIEW_LIMIT}. */
  relatedObjectsTotalCount: number;
  persistentId: string | null;
  objectTypes: VocabTerm[];
  materials: VocabTerm[];
  production: {
    name: string; role: string | null; attributionQualifier: string | null;
    place: string | null; actorUri: string;
    personInfo?: PersonInfo;
  }[];
  collectionSetLabels: VocabTerm[];
  subjects: {
    iconclass: VocabTerm[];
    depictedPersons: VocabTerm[];
    depictedPlaces: VocabTerm[];
  };
  /** Free-text Rijksmuseum-formatted display date (e.g. "1642", "c. 1665-1667"). */
  dateDisplay: string | null;
  /** Free-text extent / dimensions string (dcterms:extent). */
  extentText: string | null;
  /** ISO 8601 timestamp of catalogue record creation. */
  recordCreated: string | null;
  /** ISO 8601 timestamp of catalogue record's most recent modification. */
  recordModified: string | null;
  /** Curatorial thematic tags (theme field). */
  themes: VocabTerm[];
  themesTotalCount: number;
  /** Exhibitions this artwork has appeared in. */
  exhibitions: {
    exhibitionId: number;
    titleEn: string | null;
    titleNl: string | null;
    dateStart: string | null;
    dateEnd: string | null;
  }[];
  exhibitionsTotalCount: number;
  /** Evidence supporting attribution claims (signatures, inscriptions, monograms, …). Artwork-level — partIndex is preserved for upstream correlation, but not assumed to map to production[] index. */
  attributionEvidence: {
    partIndex: number;
    evidenceTypeAat: string | null;
    carriedByUri: string | null;
    labelText: string | null;
  }[];
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
    artId: number;
    objectNumber: string;
    title: string;
    creator: string;
    date?: string;
    type?: string;
    iiifId?: string;
    score: number;
    sharedMotifs: SharedMotif[];
    url: string;
  }[];
  warnings?: string[];
}

export interface SharedLineage {
  qualifierLabel: string;
  qualifierUri: string;
  creatorLabel: string;
  strength: number;
}

export interface LineageSimilarResult {
  queryObjectNumber: string;
  queryTitle: string;
  queryLineage: { qualifierLabel: string; qualifierUri: string; creatorLabel: string; strength: number }[];
  results: {
    artId: number;
    objectNumber: string;
    title: string;
    creator: string;
    date?: string;
    type?: string;
    iiifId?: string;
    score: number;
    sharedLineage: SharedLineage[];
    url: string;
  }[];
  warnings?: string[];
}

export interface DepictedSimilarResult {
  queryObjectNumber: string;
  queryTitle: string;
  queryTerms: { label: string; artworks: number; wikidataUri?: string }[];
  results: {
    artId: number;
    objectNumber: string;
    title: string;
    creator: string;
    date?: string;
    type?: string;
    iiifId?: string;
    score: number;
    sharedTerms: { label: string; weight: number; wikidataUri?: string }[];
    url: string;
  }[];
  warnings?: string[];
}

/** AAT qualifier URIs that carry visual-similarity signal, with strength weights. */
export const LINEAGE_QUALIFIERS: ReadonlyMap<string, number> = new Map([
  ["http://vocab.getty.edu/aat/300404286", 3.0],  // after
  ["http://vocab.getty.edu/aat/300404287", 3.0],  // copyist of
  ["http://vocab.getty.edu/aat/300404274", 2.0],  // workshop of
  ["http://vocab.getty.edu/aat/300404269", 1.5],  // attributed to
  ["http://vocab.getty.edu/aat/300404283", 1.0],  // circle of (kring van)
  ["http://vocab.getty.edu/aat/300404284", 1.0],  // circle of (omgeving van) / school of
  ["http://vocab.getty.edu/aat/300404282", 1.0],  // follower of
]);

/** Resolve a Wikidata URI from external_id (harvest) or wikidata_id (enrichment). */
function toWikidataUri(row: { external_id: string | null; wikidata_id: string | null }): string | undefined {
  return row.external_id ?? (row.wikidata_id ? `http://www.wikidata.org/entity/${row.wikidata_id}` : undefined);
}

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

/** Format height/width in cm as a dimension statement (e.g. "h 379.5 cm × w 453.5 cm"). */
export function formatDimensions(heightCm: number | null | undefined, widthCm: number | null | undefined): string | null {
  const parts: string[] = [];
  if (heightCm != null) parts.push(`h ${heightCm} cm`);
  if (widthCm != null) parts.push(`w ${widthCm} cm`);
  return parts.length > 0 ? parts.join(" × ") : null;
}

/** A vocabulary term reference (id + label). */
export interface VocabTerm {
  id: string;
  label: string;
}

export interface VocabSearchParams {
  subject?: StringOrArray;
  iconclass?: StringOrArray;
  depictedPerson?: StringOrArray;
  depictedPlace?: StringOrArray;
  productionPlace?: StringOrArray;
  material?: StringOrArray;
  technique?: StringOrArray;
  type?: StringOrArray;
  creator?: StringOrArray;
  collectionSet?: StringOrArray;
  theme?: StringOrArray;
  sourceType?: StringOrArray;
  license?: string;
  // Tier 2 fields (require vocabulary DB v1.0+)
  description?: string;
  inscription?: string;
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
  // Place hierarchy expansion
  expandPlaceHierarchy?: boolean;
  // Cross-domain
  hasProvenance?: boolean;
  // Record-modified date range (require record_modified column)
  modifiedAfter?: string;
  modifiedBefore?: string;
  // Result ordering. Overrides BM25 / geo-proximity / importance defaults.
  // recordModified requires record_modified column (v0.27+ DB).
  sortBy?: "height" | "width" | "dateEarliest" | "dateLatest" | "recordModified";
  sortOrder?: "asc" | "desc";
  maxResults?: number;
  offset?: number;
  facets?: string[];
  facetLimit?: number;
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
    /** Set on parent records when search post-processing collapses children into them (groupBy=parent). */
    groupedChildCount?: number;
  }[];
  source: "vocabulary";
  warnings?: string[];
  facets?: Record<string, Array<{ label: string; count: number }>>;
}

// ─── Person search types ────────────────────────────────────────────

export interface PersonSearchParams {
  name?: string;
  gender?: string;
  bornAfter?: number;
  bornBefore?: number;
  birthPlace?: StringOrArray;
  deathPlace?: StringOrArray;
  profession?: StringOrArray;
  hasArtworks?: boolean;
  maxResults?: number;
  offset?: number;
}

export interface PersonResult {
  vocabId: string;
  label: string;
  labelEn: string | null;
  labelNl: string | null;
  birthYear: number | null;
  deathYear: number | null;
  gender: string | null;
  artworkCount?: number;
  wikidataId: string | null;
}

export interface PersonSearchResult {
  totalResults: number;
  persons: PersonResult[];
  warnings?: string[];
}

// ─── Provenance search types ────────────────────────────────────────

export interface ProvenanceSearchParams {
  party?: string;
  transferType?: string | string[];
  excludeTransferType?: string | string[];
  location?: string;
  dateFrom?: number;
  dateTo?: number;
  objectNumber?: string;
  creator?: string;
  currency?: string;
  hasPrice?: boolean;
  hasGap?: boolean;
  relatedTo?: string;
  maxResults?: number;
  offset?: number;
  sortBy?: "price" | "dateYear" | "eventCount" | "duration";
  sortOrder?: "asc" | "desc";
  // Method filters
  categoryMethod?: string;
  positionMethod?: string;
  // Facets
  facets?: boolean;
  // Layer 2 (periods) params
  layer?: "events" | "periods";
  ownerName?: string;
  acquisitionMethod?: string;
  minDuration?: number;
  maxDuration?: number;
  periodLocation?: string;
}

/** Raw DB row shape from provenance_events JOIN artworks. */
interface ProvenanceEventDbRow {
  artwork_id: number;
  sequence: number;
  raw_text: string;
  gap: number;
  transfer_type: string;
  unsold: number;
  batch_price: number;
  transfer_category?: string | null;
  uncertain: number;
  parties: string;
  date_expression: string | null;
  date_year: number | null;
  date_qualifier: string | null;
  location: string | null;
  price_amount: number | null;
  price_currency: string | null;
  sale_details: string | null;
  citations: string;
  is_cross_ref: number;
  cross_ref_target: string | null;
  // #268: fine-axis literals are written by scripts/provenance-enrichment-methods.mjs
  // (and its Python twin); runtime treats these as opaque strings — see
  // registration.ts parseMethod enum for the canonical set.
  parse_method: string;
  category_method: string | null;
  correction_method: string | null;
  enrichment_reasoning: string | null;
  // Joined from artworks
  object_number: string;
  title: string;
  creator_label: string;
  date_earliest: number | null;
  date_latest: number | null;
}

export interface ProvenanceEventRow {
  sequence: number;
  rawText: string;
  gap: boolean;
  transferType: string;
  unsold: boolean;
  batchPrice: boolean;
  transferCategory: "ownership" | "custody" | "ambiguous" | null;
  uncertain: boolean;
  parties: { name: string; dates: string | null; uncertain: boolean; role: string | null; position: "sender" | "receiver" | "agent" | null; positionMethod?: string | null; enrichmentReasoning?: string | null }[];
  dateExpression: string | null;
  dateYear: number | null;
  dateQualifier: string | null;
  location: string | null;
  price: { amount: number; currency: string } | null;
  saleDetails: string | null;
  citations: { text: string }[];
  isCrossRef: boolean;
  crossRefTarget: string | null;
  parseMethod: "peg" | "regex_fallback" | "cross_ref" | "credit_line" | "llm_structural";
  categoryMethod: string | null;
  correctionMethod: string | null;
  enrichmentReasoning: string | null;
  matched: boolean;
}

/** Raw DB row shape from provenance_periods JOIN artworks. */
interface ProvenancePeriodDbRow {
  artwork_id: number;
  sequence: number;
  owner_name: string | null;
  owner_dates: string | null;
  location: string | null;
  acquisition_method: string | null;
  acquisition_from: string | null;
  begin_year: number | null;
  begin_year_latest: number | null;
  end_year: number | null;
  derivation: string;
  uncertain: number;
  citations: string;
  source_events: string;
  // Joined from artworks:
  object_number: string;
  title: string;
  creator_label: string;
  date_earliest: number | null;
  date_latest: number | null;
}

export interface ProvenancePeriodRow {
  sequence: number;
  ownerName: string | null;
  ownerDates: string | null;
  location: string | null;
  acquisitionMethod: string | null;
  acquisitionFrom: string | null;
  beginYear: number | null;
  beginYearLatest: number | null;
  endYear: number | null;
  duration: number | null;
  derivation: Record<string, string>;
  uncertain: boolean;
  citations: { text: string }[];
  sourceEvents: number[];
  matched: boolean;
}

export interface ProvenanceArtworkResult {
  objectNumber: string;
  title: string;
  creator: string;
  date?: string;
  url: string;
  eventCount: number;
  matchedEventCount: number;
  events: ProvenanceEventRow[];
  periods?: ProvenancePeriodRow[];
  periodCount?: number;
  matchedPeriodCount?: number;
}

export interface ProvenanceSearchResult {
  totalArtworks: number;
  totalArtworksCapped?: boolean;
  results: ProvenanceArtworkResult[];
  facets?: Record<string, Array<{ label: string; count: number }>>;
  warnings?: string[];
}

// ─── Collection stats types ─────────────────────────────────────────

export interface CollectionStatsParams {
  dimension: string;
  topN?: number;
  offset?: number;
  binWidth?: number;
  /** Override per-dimension default ordering. Vocab/exhibition default to count_desc; ordinal dims default to label_asc. */
  sortBy?: "count" | "label";
  // Artwork filters
  type?: string;
  material?: string;
  technique?: string;
  creator?: string;
  productionPlace?: string;
  depictedPerson?: string;
  depictedPlace?: string;
  subject?: string;
  iconclass?: string;
  collectionSet?: string;
  theme?: string;
  sourceType?: string;
  imageAvailable?: boolean;
  creationDateFrom?: number;
  creationDateTo?: number;
  // Provenance filters — names mirror their dimension counterparts (provenanceDecade, provenanceLocation).
  transferType?: string;
  provenanceLocation?: string;
  party?: string;
  provenanceDateFrom?: number;
  provenanceDateTo?: number;
  hasProvenance?: boolean;
  categoryMethod?: string;
  positionMethod?: string;
}

export interface StatsEntry {
  label: string | number;
  count: number;
  percentage?: number;
}

export interface CollectionStatsResult {
  dimension: string;
  /** Artwork pool size after filters (always artwork-scoped, even for provenance dimensions). */
  total: number;
  /** Always "artwork" — explicit signal that count/total = artwork-share, never event-share or party-share. */
  denominatorScope: "artwork";
  /** When true, an artwork can match multiple buckets, so Σ(percentage) can exceed 100%. */
  multiValued: boolean;
  /** How rows are collapsed into entries:
   *  - "label"           — vocab/string dims group by display label (creator, material, …)
   *  - "entity"          — exhibition groups by exhibition_id
   *  - "computed_bucket" — ordinal dims group by a SELECT-time expression (decade, century, height, width, decadeModified) */
  groupingKey: "label" | "entity" | "computed_bucket";
  /** Effective ordering of `entries`. */
  ordering: "count_desc" | "label_asc";
  /** Unit for `bucketWidth` (year for date dims, cm for height/width). Omitted for non-binned dims. */
  bucketUnit?: "year" | "cm";
  /** Effective bin width for binned dims (echoes `binWidth` param). Omitted for non-binned dims. */
  bucketWidth?: number;
  /** Inclusive `min` / exclusive `maxExclusive` window for clamped dims (e.g. decadeModified 1990–2030). */
  bucketDomain?: { min?: number; maxExclusive?: number };
  /** Coverage residual for the filtered pool. `withBucket + withoutBucket === total`.
   *  withoutBucket explains the gap to 100% on single-valued dims (missing source value, out-of-range, etc.). */
  coverage: { withBucket: number; withoutBucket: number };
  /** Number of distinct buckets in the filtered pool (under the dimension's groupingKey). Replaces the old `totalDistinct`. */
  totalBuckets: number;
  offset: number;
  entries: StatsEntry[];
  /** Round-trip echo of accepted filter args (excluding control params like topN/offset/binWidth/sortBy/dimension). */
  appliedFilters: Record<string, unknown>;
  warnings?: string[];
}

export type CuratedSetCategory =
  | "object_type"
  | "iconographic"
  | "album"
  | "sub_collection"
  | "umbrella";

export interface CuratedSetMeta {
  setSpec: string;
  name: string;
  lodUri: string;
  memberCount: number;
  dominantTypes: { label: string; count: number }[];
  dominantCenturies: { century: string; count: number }[];
  category: CuratedSetCategory | null;
}

export interface CuratedSetsQuery {
  query?: string;
  sortBy?: "name" | "size" | "size_desc";
  minMembers?: number;
  maxMembers?: number;
  includeStats?: boolean;
}

export interface BrowseSetRecord {
  objectNumber: string;
  title: string;
  creator: string;
  date: string;
  description?: string;
  dimensions?: string;
  datestamp?: string;
  hasImage: boolean;
  imageUrl?: string;
  iiifServiceUrl?: string;
  edmType?: string;
  lodUri: string;
  url: string;
}

/** Vocab dimension → DB field + optional type filter. Shared by computeFacets and artworkDimensionSql. */
const VOCAB_DIMENSION_DEFS: ReadonlyArray<{ label: string; field: string; vocabType?: string }> = [
  { label: "type",           field: "type" },
  { label: "material",       field: "material" },
  { label: "technique",      field: "technique" },
  { label: "creator",        field: "creator" },
  { label: "depictedPerson", field: "subject", vocabType: "person" },
  { label: "depictedPlace",  field: "subject", vocabType: "place" },
  { label: "productionPlace",field: "spatial" },
  { label: "sourceType",     field: "source_type" },
];

/** Provenance dimension → table/column. Shared by provenanceDimensionSql and computeProvenanceFacets. */
const PROV_DIMENSION_DEFS: ReadonlyArray<{
  label: string;
  table: "events" | "parties";
  col: string;
  notNull?: boolean;
}> = [
  { label: "transferType",      table: "events",  col: "transfer_type" },
  { label: "transferCategory",  table: "events",  col: "transfer_category",  notNull: true },
  { label: "provenanceLocation",table: "events",  col: "location",           notNull: true },
  { label: "currency",          table: "events",  col: "price_currency",     notNull: true },
  { label: "categoryMethod",    table: "events",  col: "category_method",    notNull: true },
  { label: "parseMethod",       table: "events",  col: "parse_method" },
  { label: "party",             table: "parties", col: "party_name" },
  { label: "partyPosition",     table: "parties", col: "party_position",     notNull: true },
  { label: "positionMethod",    table: "parties", col: "position_method",    notNull: true },
];

/** All valid dimension names for collection_stats. Derived from the data-driven defs above + special cases. */
export const STATS_DIMENSION_NAMES = [
  ...VOCAB_DIMENSION_DEFS.map(d => d.label),
  "century", "decade",                    // artwork date-based
  "height", "width",                      // artwork physical dimensions (cm, binned by binWidth)
  "provenanceDecade",                     // provenance date-based
  "theme",                                // thematic vocab (NL labels until #300 backfill)
  "exhibition",                           // top exhibitions by member count
  "decadeModified",                       // record_modified bucketed by decade (1990s–2020s)
  ...PROV_DIMENSION_DEFS.map(d => d.label),
] as const;

/** Per-dimension classification. Drives the structured-output fields that disclose the
 *  implicit contract a consumer otherwise couldn't recover from the schema alone:
 *  - multiValued: artwork can match >1 bucket (Σ percentage may exceed 100%)
 *  - groupingKey: how rows are collapsed into entries
 *  - defaultOrdering: ORDER BY used when no explicit sortBy is passed
 *  - bucketUnit/bucketDomain: only for binned/clamped dims
 */
interface StatsDimensionMeta {
  multiValued: boolean;
  groupingKey: "label" | "entity" | "computed_bucket";
  defaultOrdering: "count_desc" | "label_asc";
  bucketUnit?: "year" | "cm";
  /** Fixed bucket width. Omit on binned dims that use the caller-supplied `binWidth`. */
  bucketWidth?: number;
  bucketDomain?: { min?: number; maxExclusive?: number };
}

const STATS_DIMENSION_META: Record<string, StatsDimensionMeta> = {
  // Single-valued artwork attributes — one row per artwork in the source data.
  // Note: century defaults to count_desc (preserved from pre-v0.31 behaviour; the rest of the
  // ordinal dims default to label_asc). Pass sortBy:"label" to override.
  century:         { multiValued: false, groupingKey: "computed_bucket", defaultOrdering: "count_desc", bucketUnit: "year", bucketWidth: 100 },
  decade:          { multiValued: false, groupingKey: "computed_bucket", defaultOrdering: "label_asc", bucketUnit: "year" },
  height:          { multiValued: false, groupingKey: "computed_bucket", defaultOrdering: "label_asc", bucketUnit: "cm" },
  width:           { multiValued: false, groupingKey: "computed_bucket", defaultOrdering: "label_asc", bucketUnit: "cm" },
  decadeModified:  {
    multiValued: false, groupingKey: "computed_bucket", defaultOrdering: "label_asc", bucketUnit: "year", bucketWidth: 10,
    bucketDomain: { min: 1990, maxExclusive: 2030 },
  },
  // Multi-valued artwork attributes — vocabulary fan-out via mappings.
  type:            { multiValued: true,  groupingKey: "label",           defaultOrdering: "count_desc" },
  material:        { multiValued: true,  groupingKey: "label",           defaultOrdering: "count_desc" },
  technique:       { multiValued: true,  groupingKey: "label",           defaultOrdering: "count_desc" },
  creator:         { multiValued: true,  groupingKey: "label",           defaultOrdering: "count_desc" },
  depictedPerson:  { multiValued: true,  groupingKey: "label",           defaultOrdering: "count_desc" },
  depictedPlace:   { multiValued: true,  groupingKey: "label",           defaultOrdering: "count_desc" },
  productionPlace: { multiValued: true,  groupingKey: "label",           defaultOrdering: "count_desc" },
  subject:         { multiValued: true,  groupingKey: "label",           defaultOrdering: "count_desc" },
  sourceType:      { multiValued: true,  groupingKey: "label",           defaultOrdering: "count_desc" },
  theme:           { multiValued: true,  groupingKey: "label",           defaultOrdering: "count_desc" },
  exhibition:      { multiValued: true,  groupingKey: "entity",          defaultOrdering: "count_desc" },
  // Provenance dimensions — count = distinct artworks with ≥1 event/party matching this bucket.
  // Multi-valued because one artwork can have multiple events/parties (so it can hit multiple buckets).
  provenanceDecade:  { multiValued: true, groupingKey: "computed_bucket", defaultOrdering: "label_asc", bucketUnit: "year" },
  transferType:      { multiValued: true, groupingKey: "label",           defaultOrdering: "count_desc" },
  transferCategory:  { multiValued: true, groupingKey: "label",           defaultOrdering: "count_desc" },
  provenanceLocation:{ multiValued: true, groupingKey: "label",           defaultOrdering: "count_desc" },
  currency:          { multiValued: true, groupingKey: "label",           defaultOrdering: "count_desc" },
  categoryMethod:    { multiValued: true, groupingKey: "label",           defaultOrdering: "count_desc" },
  parseMethod:       { multiValued: true, groupingKey: "label",           defaultOrdering: "count_desc" },
  party:             { multiValued: true, groupingKey: "label",           defaultOrdering: "count_desc" },
  partyPosition:     { multiValued: true, groupingKey: "label",           defaultOrdering: "count_desc" },
  positionMethod:    { multiValued: true, groupingKey: "label",           defaultOrdering: "count_desc" },
};

// ─── Filter definitions ─────────────────────────────────────────────
// Each entry maps a VocabSearchParams key to the SQL constraints used
// in a mapping subquery.  `fields` restricts m.field, `vocabType`
// restricts v.type, and `matchMode` controls exact vs LIKE matching.

const ALLOWED_FIELDS = new Set([
  "subject", "spatial", "material", "technique", "type", "creator",
  "collection_set",
  "production_role", "attribution_qualifier",
  "theme", "source_type",
]);
const ALLOWED_VOCAB_TYPES = new Set(["person", "place", "classification", "set"]);

/** Safety cap — actual per-tool limits are defined in TOOL_LIMITS (registration.ts). */
const INTERNAL_MAX_RESULTS_CAP = 100;

/**
 * Provenance-search count cap. Sits comfortably above the 48,535 distinct
 * provenance-bearing artworks (and the 28,664 distinct period-bearing artworks)
 * — acts as a safety guard against future growth while keeping the count query
 * bounded.
 */
const PROVENANCE_COUNT_CAP = 50000;

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
  { param: "material",       fields: ["material"],              matchMode: "like",                               ftsUpgrade: true },
  { param: "technique",      fields: ["technique"],             matchMode: "like",                               ftsUpgrade: true },
  { param: "type",           fields: ["type"],                  matchMode: "like",                               ftsUpgrade: true },
  { param: "creator",        fields: ["creator"],               matchMode: "like",                               ftsUpgrade: true },
  { param: "collectionSet",  fields: ["collection_set"],        matchMode: "like", vocabType: "set",            ftsUpgrade: true },
  { param: "theme",          fields: ["theme"],                 matchMode: "like",                               ftsUpgrade: true },
  { param: "sourceType",     fields: ["source_type"],           matchMode: "like",                               ftsUpgrade: true },
  { param: "productionRole",fields: ["production_role"],        matchMode: "like",                               ftsUpgrade: true },
  { param: "attributionQualifier", fields: ["attribution_qualifier"], matchMode: "like",                       ftsUpgrade: true },
  { param: "aboutActor",   fields: ["subject", "creator"],    matchMode: "like", vocabType: "person",         ftsUpgrade: true },
];

/** Simplified vocab filter definition for collection_stats. */
interface StatsVocabFilter {
  key: keyof CollectionStatsParams;
  fields: string[];
  vocabType?: string;
  /** Match on `notation` column instead of `label_en` (for Iconclass codes). */
  exactNotation?: boolean;
}

/** Vocab filters available on collection_stats. Subset of VOCAB_FILTERS with simpler matching. */
const STATS_VOCAB_FILTERS: readonly StatsVocabFilter[] = [
  { key: "type",            fields: ["type"] },
  { key: "material",        fields: ["material"] },
  { key: "technique",       fields: ["technique"] },
  { key: "creator",         fields: ["creator"] },
  { key: "productionPlace", fields: ["spatial"],            vocabType: "place" },
  { key: "depictedPerson",  fields: ["subject"],            vocabType: "person" },
  { key: "depictedPlace",   fields: ["subject", "spatial"], vocabType: "place" },
  { key: "subject",         fields: ["subject"] },
  { key: "iconclass",       fields: ["subject"],  exactNotation: true },
  { key: "collectionSet",   fields: ["collection_set"],     vocabType: "set" },
  { key: "theme",           fields: ["theme"] },
  { key: "sourceType",      fields: ["source_type"] },
];

/**
 * Maximum art_ids returned by filterArtIds(). The chunked vec_distance_cosine path
 * in EmbeddingsDb scales linearly (~3ms/1K) up to this limit; beyond it, pure KNN
 * + post-filter (~1.5s) kicks in. Benchmarked at ~600ms for 200K candidates.
 */
export const FILTER_ART_IDS_LIMIT = 200_000;

/**
 * Parameter keys eligible for filterArtIds — all VOCAB_FILTERS params plus direct-column filters.
 * Used by semantic_search to forward structured filters. Excludes text FTS, geo, and dimensions.
 */
export const FILTER_ART_IDS_KEYS: ReadonlySet<string> = new Set([
  ...VOCAB_FILTERS.map(f => f.param),
  "imageAvailable",
  "creationDate",
  "dateMatch",
]);

/**
 * Get-or-create with insertion-order LRU eviction. Re-inserts an existing entry
 * to bump it to most-recent; evicts the least-recently-used (first) entry once
 * size exceeds `cap`. Used by `filterArtIds` (#79) — exported for tests.
 */
export function lruGetOrCreate<K, V>(
  map: Map<K, V>,
  key: K,
  factory: () => V,
  cap: number,
): V {
  const existing = map.get(key);
  if (existing !== undefined) {
    map.delete(key);
    map.set(key, existing);
    return existing;
  }
  const value = factory();
  map.set(key, value);
  if (map.size > cap) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  return value;
}

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

/** Shape returned by VocabularyDb.batchLookupByArtId (one entry per artwork). */
export interface ArtworkMeta {
  objectNumber: string;
  title: string;
  creator: string;
  dateEarliest: number | null;
  dateLatest: number | null;
  iiifId: string | null;
}

// ─── VocabularyDb ────────────────────────────────────────────────────

export class VocabularyDb {
  /** Resolve title from primary title + fallback title_all_text (first line). */
  private static resolveTitle(title: string | null, titleAllText: string | null, fallback = ""): string {
    return title || titleAllText?.split("\n")[0] || fallback;
  }

  private db: DatabaseType | null = null;
  private dbPath_: string | null = null;
  private hasFts5 = false;
  private hasTextFts = false;
  private hasDimensions = false;
  private hasDates = false;
  private hasNormLabels = false;
  private hasCoordinates = false;

  private hasRightsLookup = false;
  private hasPersonNames = false;
  private hasEntityAltNames = false;
  private hasImageColumn = false;
  private hasRecordModified_ = false;
  private hasImportance = false;
  private hasProvenanceTables_ = false;
  private hasProvenancePeriods_ = false;
  private hasPartyTable_ = false;
  private hasPartyPosition_ = false;
  private hasTransferCategory_ = false;
  private hasPartyEnrichmentReasoning_ = false;
  private stmtPartyEnrichment_: Statement | null = null;
  private fieldIdMap = new Map<string, number>();
  private stmtLookupArtwork: Statement | null = null;
  private stmtLookupPersonInfo: Statement | null = null;
  private stmtLookupIiifId: Statement | null = null;
  private stmtImageMetadata: Statement | null = null;
  private stmtArtworkRow: Statement | null = null;
  private stmtArtworkMappings: Statement | null = null;
  private stmtArtworkTitleVariants: Statement | null = null;
  private stmtArtworkParents: Statement | null = null;
  private stmtArtworkChildCount: Statement | null = null;
  private stmtArtworkChildrenPreview: Statement | null = null;
  private stmtArtworkRelatedCount: Statement | null = null;
  private stmtArtworkRelatedPreview: Statement | null = null;
  private stmtArtworkExternalIds: Statement | null = null;
  private stmtArtworkAttributionEvidence: Statement | null = null;
  private stmtArtworkExhibitions: Statement | null = null;
  private stmtBrowseSetLookup: Statement | null = null;
  private stmtBrowseSetCount: Statement | null = null;
  private stmtBrowseSetPage: Statement | null = null;
  private museumRooms: Map<string, { roomId: string; floor: string | null; roomName: string | null }> | null = null;
  private hasTitleVariants_ = false;
  private hasArtworkParent_ = false;
  private hasRelatedObjects_ = false;
  /** Maximum child records included inline on a parent's detail view. */
  private static readonly CHILD_PREVIEW_LIMIT = 25;
  /** Maximum related-object peers included inline on a detail view. */
  private static readonly RELATED_PREVIEW_LIMIT = 25;
  /** Maximum themes / exhibitions included inline on a detail view. */
  private static readonly DETAIL_PREVIEW_LIMIT = 25;
  /** Keep in sync with `RijksmuseumApiClient.IIIF_BASE`. Duplicated here to avoid
   *  a DB → API client dependency. */
  private static readonly IIIF_BASE = "https://iiif.micr.io";
  // LRU-capped — SQL shape varies with IN-list length per filter (#79).
  // 256 entries × ~8KB compiled-statement worst case ≈ 2MB ceiling.
  private static readonly FILTER_ART_IDS_CACHE_CAP = 256;
  private stmtFilterArtIds = new Map<string, Statement>();
  // Chunk-size-keyed statement caches (like EmbeddingsDb.stmtFilteredKnn)
  private stmtLookupTypesCache = new Map<number, Statement>();
  private stmtReconstructSourceCache = new Map<number, Statement>();
  private stmtBatchByArtIdCache = new Map<number, Statement>();
  private stmtBatchTypesByArtIdCache = new Map<number, Statement>();
  private stmtBatchDescByArtIdCache = new Map<number, Statement>();
  private stmtBatchImportanceByArtIdCache = new Map<number, Statement>();
  /** Column list for batchLookupByArtId — resolved once at construction so the
   *  chunk-size-keyed statement cache doesn't need hasIiif in its key. */
  private batchByArtIdCols = "";

  private stmtObjectNumberByArtId: Statement | null = null;
  // ── find_similar shared ──
  private stmtLookupArtId: Statement | null = null; // cached: art_id + title + creator_label by object_number
  /** Shared prepared statement: SELECT artwork_id FROM mappings WHERE field_id = ? AND vocab_rowid = ? */
  private stmtMappingsByFieldVocab: Statement | null = null;
  // ── find_similar caches (initialised lazily on first call) ──
  private notationDf: Map<number, number> | null = null; // vocab_rowid → document frequency
  private iconclassN = 0; // total artworks with any Iconclass notation
  private lineageCreatorDf: Map<string, number> | null = null; // creator vocabulary.id → df
  private lineageN = 0; // total artworks with any visual-lineage qualifier
  private lineageQualifierMap: Map<string, { label: string; strength: number; aatUri: string }> | null = null; // vocabulary.id → info
  private stmtLineageShared: Statement | null = null; // cached: artwork_id by (qualifier_id, creator_id) — assignment_pairs
  private hasAssignmentPairs = false; // #144: v0.24+ harvest persists qualifier↔creator assignments
  private iconclassNoiseIds: Set<number> | null = null; // vocab_rowids to exclude
  // Depicted person cache
  private personDf: Map<number, number> | null = null; // person vocab_rowid → document frequency
  private personN = 0; // total artworks with depicted persons
  // Depicted place cache
  private placeDf: Map<number, number> | null = null; // place vocab_rowid → document frequency
  private placeN = 0; // total artworks with depicted places (after filtering)
  private placeExcluded: Set<number> | null = null; // vocab_rowids excluded (TGN + broad places)
  // Theme cache (#294)
  private themeDf: Map<number, number> | null = null; // theme vocab_rowid → document frequency
  private themeN = 0; // total artworks with at least one theme
  // Related Co-Production cache (#293) — curator-declared peer edges where
  // the creator is invariant (~94-97% empirically) and the link describes
  // another instantiation, stage, or deliberate companion of the same
  // artistic conception. Score is fixed (each edge is a curatorial assertion,
  // not a probabilistic match).
  private coProductionByArtId: Map<number, { peerArtId: number; label: string }[]> | null = null;
  private static readonly CO_PRODUCTION_LABELS = [
    "different example", "production stadia", "pendant",
  ] as const;

  // Related Object cache — derivative works by other hands (B1) and
  // multi-object groupings (B3) from the related_objects vocabulary. Tiered
  // weights below: tighter groupings score higher than the catch-all.
  private relatedObjectByArtId: Map<number, { peerArtId: number; label: string }[]> | null = null;
  private static readonly RELATED_OBJECT_LABELS = [
    "pair", "pair (weapons)", "set", "recto | verso", "product line",
    "original | reproduction", "related object",
  ] as const;
  private static readonly RELATED_OBJECT_TIER_WEIGHT: Record<string, number> = {
    "pair": 6,
    "pair (weapons)": 6,
    "set": 6,
    "recto | verso": 6,
    "product line": 6,
    "original | reproduction": 4,
    "related object": 2,
  };

  /** Look up a field_id by name, throwing if missing. */
  private requireFieldId(name: string): number {
    const id = this.fieldIdMap.get(name);
    if (id === undefined) throw new Error(`field_lookup missing entry for "${name}"`);
    return id;
  }

  /** Lazily prepare the shared mappings-lookup statement (used by Iconclass, Person, Place signals). */
  private ensureMappingsStmt(): void {
    if (this.stmtMappingsByFieldVocab || !this.db) return;
    this.stmtMappingsByFieldVocab = this.db.prepare(
      `SELECT artwork_id FROM mappings WHERE field_id = ? AND vocab_rowid = ?`
    );
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
    const fieldIds = fields.map((f) => this.requireFieldId(f));
    const col = noFieldIndex ? "+m.field_id" : "m.field_id";
    return fieldIds.length === 1
      ? { clause: `${col} = ?`, bindings: fieldIds }
      : { clause: `${col} IN (${fieldIds.map(() => "?").join(", ")})`, bindings: fieldIds };
  }

  constructor() {
    const dbPath = resolveDbPath("VOCAB_DB_PATH", "vocabulary.db");
    if (!dbPath) {
      console.error("Vocabulary DB not found — vocabulary search disabled");
      return;
    }

    try {
      this.db = new Database(dbPath, { readonly: true });
      this.dbPath_ = dbPath;
      this.db.pragma("mmap_size = 1073741824"); // 1 GB — empirical working set is ~700 MB across all observed query paths (issue #272)
      // Word-boundary matching for subject search (e.g. "cat" must not match "Catharijnekerk").
      // Memoize the compiled RegExp — pattern is identical for every row within a single query,
      // so this avoids O(rows) allocations on broad subject scans. Safe because SQLite executes
      // UDFs synchronously on a single thread; no concurrent access to the closure variables.
      let cachedPattern = "";
      let cachedRegex: RegExp | null = null;
      this.db.function("regexp_word", (pattern: string, value: string) => {
        if (pattern !== cachedPattern) {
          const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          cachedRegex = new RegExp(`\\b${escaped}\\b`, "i");
          cachedPattern = pattern;
        }
        return cachedRegex!.test(value) ? 1 : 0;
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
      // Integer-encoded mappings (field_lookup + art_id) — required since v0.13
      const fieldRows = this.db.prepare("SELECT id, name FROM field_lookup").all() as { id: number; name: string }[];
      for (const r of fieldRows) this.fieldIdMap.set(r.name, r.id);
      this.hasRightsLookup = this.tableExists("rights_lookup");
      this.hasPersonNames = this.tableExists("person_names_fts");
      this.hasEntityAltNames = this.tableExists("entity_alt_names_fts");
      this.hasTitleVariants_ = this.tableExists("title_variants");
      this.hasArtworkParent_ = this.tableExists("artwork_parent");
      this.hasRelatedObjects_ = this.tableExists("related_objects");
      this.hasImageColumn = this.columnExists("artworks", "has_image");
      this.hasRecordModified_ = this.columnExists("artworks", "record_modified");
      this.hasImportance = this.columnExists("artworks", "importance");
      this.hasProvenanceTables_ = this.tableExists("provenance_events");
      this.hasProvenancePeriods_ = this.tableExists("provenance_periods");
      this.hasPartyTable_ = this.tableExists("provenance_parties");
      this.hasPartyPosition_ = this.hasPartyTable_ && this.columnExists("provenance_parties", "party_position");
      this.hasTransferCategory_ = this.hasProvenanceTables_ && this.columnExists("provenance_events", "transfer_category");
      this.hasPartyEnrichmentReasoning_ = this.hasPartyTable_ && this.columnExists("provenance_parties", "enrichment_reasoning");
      if (this.hasPartyEnrichmentReasoning_) {
        this.stmtPartyEnrichment_ = this.db.prepare(`
          SELECT sequence, party_idx, position_method, enrichment_reasoning
          FROM provenance_parties
          WHERE artwork_id = ? AND position_method LIKE 'llm%'
        `);
      }

      // #144: detect v0.24+ assignment_pairs table for the lineage similarity rewrite
      this.hasAssignmentPairs = this.tableExists("assignment_pairs");

      // Warn if performance-critical indexes are missing (must be created during harvest/enrichment — DB is read-only)
      if (this.hasCoordinates) {
        this.warnIfIndexMissing("idx_vocab_lat_lon", "nearPlace queries may be slower. Re-run harvest Phase 3 to create it.");
      }
      this.warnIfIndexMissing("idx_vocab_broader_id", "expandPlaceHierarchy will be slow. Run enrichment script to create it.");
      if (this.hasAssignmentPairs) {
        this.warnIfIndexMissing("idx_assignment_pairs_qualifier", "find_similar mode=lineage IDF aggregation will be slower. Re-run harvest to create it.");
      }

      // Cache frequently-used prepared statements
      this.stmtLookupArtwork = this.db.prepare(
        "SELECT title, title_all_text, creator_label, date_earliest, date_latest FROM artworks WHERE object_number = ?"
      );
      this.stmtLookupArtId = this.db.prepare(
        "SELECT art_id, title, creator_label FROM artworks WHERE object_number = ?"
      );
      this.stmtObjectNumberByArtId = this.db.prepare(
        "SELECT object_number FROM artworks WHERE art_id = ?"
      );

      // Detect person enrichment columns (birth_year, death_year, gender, wikidata_id)
      if (this.columnExists("vocabulary", "birth_year") && this.columnExists("vocabulary", "gender")) {
        this.stmtLookupPersonInfo = this.db.prepare(
          "SELECT id, birth_year, death_year, gender, wikidata_id FROM vocabulary WHERE id = ? AND type = 'person'"
        );
      }

      // Pre-harvested IIIF identifiers (eliminates 3-step Linked Art image chain)
      if (this.columnExists("artworks", "iiif_id")) {
        this.stmtLookupIiifId = this.db.prepare(
          "SELECT iiif_id FROM artworks WHERE object_number = ?"
        );
      }

      // Cached statements for getArtworkDetail / lookupImageMetadata
      if (this.hasRightsLookup) {
        this.stmtImageMetadata = this.db.prepare(`
          SELECT a.object_number, a.title, a.title_all_text, a.creator_label,
                 a.date_earliest, a.date_latest, a.iiif_id,
                 a.height_cm, a.width_cm, rl.uri AS rights_uri
          FROM artworks a
          LEFT JOIN rights_lookup rl ON a.rights_id = rl.id
          WHERE a.object_number = ?
        `);
        this.stmtArtworkRow = this.db.prepare(`
          SELECT a.object_number, a.art_id, a.title, a.title_all_text, a.creator_label,
                 a.date_earliest, a.date_latest, a.description_text, a.inscription_text,
                 a.provenance_text, a.credit_line, a.narrative_text,
                 a.height_cm, a.width_cm, a.iiif_id,
                 ${this.detailColExpr("depth_cm")},
                 ${this.detailColExpr("weight_g")},
                 ${this.detailColExpr("diameter_cm")},
                 ${this.detailColExpr("current_location")},
                 ${this.detailColExpr("date_display")},
                 ${this.detailColExpr("record_created")},
                 ${this.detailColExpr("record_modified")},
                 ${this.detailColExpr("extent_text")},
                 rl.uri AS rights_uri
          FROM artworks a
          LEFT JOIN rights_lookup rl ON a.rights_id = rl.id
          WHERE a.object_number = ?
        `);
      } else {
        this.stmtImageMetadata = this.db.prepare(`
          SELECT a.object_number, a.title, a.title_all_text, a.creator_label,
                 a.date_earliest, a.date_latest, a.iiif_id,
                 a.height_cm, a.width_cm, a.rights_uri
          FROM artworks a
          WHERE a.object_number = ?
        `);
        this.stmtArtworkRow = this.db.prepare(`
          SELECT a.object_number, a.art_id, a.title, a.title_all_text, a.creator_label,
                 a.date_earliest, a.date_latest, a.description_text, a.inscription_text,
                 a.provenance_text, a.credit_line, a.narrative_text,
                 a.height_cm, a.width_cm, a.iiif_id,
                 ${this.detailColExpr("depth_cm")},
                 ${this.detailColExpr("weight_g")},
                 ${this.detailColExpr("diameter_cm")},
                 ${this.detailColExpr("current_location")},
                 ${this.detailColExpr("date_display")},
                 ${this.detailColExpr("record_created")},
                 ${this.detailColExpr("record_modified")},
                 ${this.detailColExpr("extent_text")},
                 a.rights_uri
          FROM artworks a
          WHERE a.object_number = ?
        `);
      }
      // Person-enrichment columns may be absent on a bare-harvest DB that
      // hasn't been through enrichment. Emit NULL placeholders so the
      // statement still compiles and downstream callers get the same
      // result shape. Mirrors the guard on stmtLookupPersonInfo above. #243.
      const hasPersonEnrichment =
        this.columnExists("vocabulary", "birth_year") &&
        this.columnExists("vocabulary", "gender");
      const personEnrichmentCols = hasPersonEnrichment
        ? "v.birth_year, v.death_year, v.gender, v.wikidata_id"
        : "NULL AS birth_year, NULL AS death_year, NULL AS gender, NULL AS wikidata_id";
      this.stmtArtworkMappings = this.db.prepare(`
        SELECT f.name AS field, v.label_en, v.label_nl, v.id AS vocab_id,
               v.notation, v.external_id, v.type AS vocab_type,
               ${personEnrichmentCols}
        FROM mappings m
        JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
        JOIN field_lookup f ON m.field_id = f.id
        WHERE m.artwork_id = ?
      `);

      // title_variants harvested in v0.24+; gracefully absent on older DBs.
      if (this.hasTitleVariants_) {
        this.stmtArtworkTitleVariants = this.db.prepare(`
          SELECT title_text, language, qualifier
          FROM title_variants
          WHERE art_id = ?
          ORDER BY seq
        `);
      }

      // related_objects harvested in v0.24+; peer artwork relations (recto/verso, frame/painting, pendant…).
      if (this.hasRelatedObjects_) {
        const coProductionPlaceholdersForCount = VocabularyDb.CO_PRODUCTION_LABELS.map(() => "?").join(", ");
        this.stmtArtworkRelatedCount = this.db.prepare(
          `SELECT COUNT(*) AS n FROM related_objects
             WHERE art_id = ? AND relationship_en IN (${coProductionPlaceholdersForCount})`
        );
        // Viewer-side relatedObjects[] is restricted to the same 3 creator-
        // invariant types used by find_similar's Related Co-Production
        // channel ('different example' / 'production stadia' / 'pendant').
        // Other relationship types are surfaced through find_similar's
        // Related Object channel rather than the viewer.
        const coProductionPlaceholders = VocabularyDb.CO_PRODUCTION_LABELS.map(() => "?").join(", ");
        this.stmtArtworkRelatedPreview = this.db.prepare(`
          SELECT ro.relationship_en, ro.related_la_uri, a.object_number, a.title, a.title_all_text, a.iiif_id
          FROM related_objects ro
          LEFT JOIN artworks a ON a.art_id = ro.related_art_id
          WHERE ro.art_id = ?
            AND ro.relationship_en IN (${coProductionPlaceholders})
          ORDER BY ro.relationship_en, a.object_number
          LIMIT ?
        `);
      }

      if (this.tableExists("artwork_external_ids")) {
        this.stmtArtworkExternalIds = this.db.prepare(
          `SELECT authority, uri FROM artwork_external_ids WHERE art_id = ? ORDER BY authority, uri`
        );
      }

      // part_index is preserved on each row but does NOT correlate with production[] index —
      // see fetchAttributionEvidence and the 2026-05-01 plan revision for the data evidence.
      if (this.tableExists("attribution_evidence")) {
        this.stmtArtworkAttributionEvidence = this.db.prepare(
          `SELECT part_index, evidence_type_aat, carried_by_uri, label_text
           FROM attribution_evidence
           WHERE art_id = ?
           ORDER BY part_index, evidence_type_aat, carried_by_uri`
        );
      }

      if (this.tableExists("artwork_exhibitions") && this.tableExists("exhibitions")) {
        this.stmtArtworkExhibitions = this.db.prepare(`
          SELECT e.exhibition_id, e.title_en, e.title_nl, e.date_start, e.date_end
          FROM artwork_exhibitions ae
          JOIN exhibitions e ON e.exhibition_id = ae.exhibition_id
          WHERE ae.art_id = ?
          ORDER BY e.date_start IS NULL, e.date_start DESC, e.exhibition_id
        `);
      }

      // museum_rooms is 75 rows keyed by room_hash (no index on room_id) — preload once
      // into a Map to avoid a per-call table scan from lookupMuseumRoom.
      if (this.tableExists("museum_rooms")) {
        const rows = this.db.prepare(
          `SELECT room_id, floor, room_name FROM museum_rooms`
        ).all() as { room_id: string; floor: string | null; room_name: string | null }[];
        this.museumRooms = new Map(rows.map((r) => [r.room_id, { roomId: r.room_id, floor: r.floor, roomName: r.room_name }]));
      }

      // artwork_parent harvested in v0.24+; surfaces sketchbook/album hierarchy (#28).
      if (this.hasArtworkParent_) {
        this.stmtArtworkParents = this.db.prepare(`
          SELECT a.object_number, a.title, a.title_all_text
          FROM artwork_parent ap
          JOIN artworks a ON a.art_id = ap.parent_art_id
          WHERE ap.art_id = ?
        `);
        this.stmtArtworkChildCount = this.db.prepare(
          `SELECT COUNT(*) AS n FROM artwork_parent WHERE parent_art_id = ?`
        );
        this.stmtArtworkChildrenPreview = this.db.prepare(`
          SELECT a.object_number, a.title, a.title_all_text
          FROM artwork_parent ap
          JOIN artworks a ON a.art_id = ap.art_id
          WHERE ap.parent_art_id = ?
          ORDER BY a.object_number
          LIMIT ?
        `);
      }

      // Resolve batchLookupByArtId column list once (hasIiif is now fixed for the process lifetime)
      this.batchByArtIdCols = this.stmtLookupIiifId
        ? "art_id, object_number, title, title_all_text, creator_label, date_earliest, date_latest, iiif_id"
        : "art_id, object_number, title, title_all_text, creator_label, date_earliest, date_latest";

      const features = [
        this.hasFts5 && "vocabFTS5",
        this.hasTextFts && "textFTS5",
        this.hasDimensions && "dimensions",
        this.hasDates && "dates",
        this.hasNormLabels && "normLabels",
        this.hasCoordinates && "coordinates",
        "intMappings",
        this.hasPersonNames && "personNames",
        this.hasImageColumn && "hasImage",
        this.hasImportance && "importance",
        this.stmtLookupPersonInfo && "personEnrichment",
        this.stmtLookupIiifId && "iiifIds",
        this.hasProvenanceTables_ && "provenance",
        this.hasProvenancePeriods_ && "provenancePeriods",
        this.hasPartyTable_ && "provenanceParties",
        this.hasPartyPosition_ && "partyPosition",
        this.hasTransferCategory_ && "transferCategory",
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

  /** Resolved on-disk path of the vocabulary DB (or null if unavailable). */
  get dbPath(): string | null {
    return this.dbPath_;
  }

  /** Underlying better-sqlite3 handle for pragma queries (memory observability). */
  get rawDb(): DatabaseType | null {
    return this.db;
  }

  get hasProvenanceTables(): boolean {
    return this.hasProvenanceTables_;
  }

  get hasProvenancePeriods(): boolean {
    return this.hasProvenancePeriods_;
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
      let stmt = this.stmtLookupTypesCache.get(chunk.length);
      if (!stmt) {
        const placeholders = chunk.map(() => "?").join(", ");
        const sql = `SELECT a.object_number, COALESCE(v.label_en, v.label_nl, '') AS label
             FROM mappings m
             JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
             JOIN artworks a ON m.artwork_id = a.art_id
             WHERE a.object_number IN (${placeholders}) AND ${fieldClause}`;
        stmt = this.db.prepare(sql);
        this.stmtLookupTypesCache.set(chunk.length, stmt);
      }
      const rows = stmt.all(...chunk, ...fieldBindings) as { object_number: string; label: string }[];
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
    return { title: VocabularyDb.resolveTitle(row.title, row.title_all_text), creator: row.creator_label || "", dateEarliest: row.date_earliest, dateLatest: row.date_latest };
  }

  /** Look up enriched person info (birth/death/gender/wikidata) by vocab IDs. */
  lookupPersonInfo(vocabIds: string[]): Map<string, PersonInfo> {
    const map = new Map<string, PersonInfo>();
    if (!this.stmtLookupPersonInfo || vocabIds.length === 0) return map;
    for (const id of vocabIds) {
      const row = this.stmtLookupPersonInfo.get(id) as {
        id: string; birth_year: number | null; death_year: number | null;
        gender: string | null; wikidata_id: string | null;
      } | undefined;
      if (row && (row.birth_year != null || row.death_year != null || row.gender || row.wikidata_id)) {
        map.set(id, {
          birthYear: row.birth_year, deathYear: row.death_year,
          gender: row.gender, wikidataId: row.wikidata_id,
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
   * Look up lightweight image metadata for an artwork. Used by get_artwork_image
   * and inspect_artwork_image — replaces the Linked Art resolver for metadata.
   */
  lookupImageMetadata(objectNumber: string): {
    objectNumber: string; title: string; creator: string; date: string;
    iiifId: string | null; heightCm: number | null; widthCm: number | null;
    license: string | null;
  } | null {
    if (!this.stmtImageMetadata) return null;
    const row = this.stmtImageMetadata.get(objectNumber) as {
      object_number: string; title: string | null; title_all_text: string | null;
      creator_label: string | null; date_earliest: number | null; date_latest: number | null;
      iiif_id: string | null; height_cm: number | null; width_cm: number | null;
      rights_uri: string | null;
    } | undefined;
    if (!row) return null;
    return {
      objectNumber: row.object_number,
      title: VocabularyDb.resolveTitle(row.title, row.title_all_text, "Untitled"),
      creator: row.creator_label || "Unknown",
      date: formatDateRange(row.date_earliest, row.date_latest) ?? "",
      iiifId: row.iiif_id,
      heightCm: row.height_cm,
      widthCm: row.width_cm,
      license: row.rights_uri,
    };
  }

  /**
   * Resolve a numeric art_id to its object_number, or return null if not found.
   * Used by get_artwork_details to support URI-based lookups (e.g. https://id.rijksmuseum.nl/8095).
   */
  getObjectNumberByArtId(artId: number): string | null {
    if (!this.stmtObjectNumberByArtId) return null;
    const row = this.stmtObjectNumberByArtId.get(artId) as { object_number: string } | undefined;
    return row?.object_number ?? null;
  }

  /**
   * Resolve a Linked Art URI to its peer artwork's object_number when the URI
   * appears as a `related_la_uri` (related_objects) or `parent_la_uri`
   * (artwork_parent) value. The numeric tail of these URIs is an upstream
   * Rijksmuseum entity ID — a different ID space from local `art_id`. Without
   * this fallback, get_artwork_details(uri=...) fails for URIs surfaced via
   * relatedObjects or parents on get_artwork_details responses.
   */
  getObjectNumberByLinkedArtUri(uri: string): string | null {
    if (!this.db) return null;
    if (this.hasRelatedObjects_) {
      const row = this.db.prepare(`
        SELECT a.object_number FROM related_objects ro
        JOIN artworks a ON a.art_id = ro.related_art_id
        WHERE ro.related_la_uri = ? LIMIT 1
      `).get(uri) as { object_number: string } | undefined;
      if (row) return row.object_number;
    }
    if (this.hasArtworkParent_) {
      const row = this.db.prepare(`
        SELECT a.object_number FROM artwork_parent ap
        JOIN artworks a ON a.art_id = ap.parent_art_id
        WHERE ap.parent_la_uri = ? LIMIT 1
      `).get(uri) as { object_number: string } | undefined;
      if (row) return row.object_number;
    }
    return null;
  }

  /**
   * Full artwork detail from the vocab DB — replaces the Linked Art resolver +
   * toDetailEnriched() for get_artwork_details. Two queries: artwork row + mappings.
   */
  getArtworkDetail(objectNumber: string): ArtworkDetailFromDb | null {
    if (!this.stmtArtworkRow || !this.stmtArtworkMappings) return null;

    // Query 1: artwork row
    const row = this.stmtArtworkRow.get(objectNumber) as {
      object_number: string; art_id: number; title: string | null; title_all_text: string | null;
      creator_label: string | null; date_earliest: number | null; date_latest: number | null;
      description_text: string | null; inscription_text: string | null;
      provenance_text: string | null; credit_line: string | null; narrative_text: string | null;
      height_cm: number | null; width_cm: number | null; iiif_id: string | null;
      depth_cm: number | null; weight_g: number | null; diameter_cm: number | null;
      current_location: string | null; date_display: string | null;
      record_created: string | null; record_modified: string | null;
      extent_text: string | null;
      rights_uri: string | null;
    } | undefined;
    if (!row) return null;

    // Query 2: all vocabulary mappings for this artwork
    const mappings = this.stmtArtworkMappings.all(row.art_id) as {
      field: string; label_en: string | null; label_nl: string | null; vocab_id: string;
      notation: string | null; external_id: string | null; vocab_type: string | null;
      birth_year: number | null; death_year: number | null; gender: string | null;
      wikidata_id: string | null;
    }[];

    // Group mappings by field
    const byField = new Map<string, typeof mappings>();
    for (const m of mappings) {
      let arr = byField.get(m.field);
      if (!arr) { arr = []; byField.set(m.field, arr); }
      arr.push(m);
    }

    const label = (m: typeof mappings[0]) => m.label_en || m.label_nl || "";
    const toTerm = (m: typeof mappings[0]) => ({ id: m.vocab_id, label: label(m) });

    // Object types
    const objectTypes = (byField.get("type") ?? []).map(toTerm);
    // Materials
    const materials = (byField.get("material") ?? []).map(toTerm);
    // Techniques
    const techniques = (byField.get("technique") ?? []).map(toTerm);
    // Collection sets
    const collectionSetMappings = byField.get("collection_set") ?? [];
    const collectionSets = collectionSetMappings.map((m) => m.vocab_id);
    const collectionSetLabels = collectionSetMappings.map(toTerm);

    // Subjects: split by type
    const subjectMappings = byField.get("subject") ?? [];
    const iconclass = subjectMappings
      .filter((m) => m.notation != null)
      .map((m) => ({ id: m.notation!, label: label(m) }));
    const depictedPersons = subjectMappings
      .filter((m) => m.vocab_type === "person")
      .map(toTerm);
    const depictedPlaces = subjectMappings
      .filter((m) => m.vocab_type === "place")
      .map(toTerm);

    // Production participants: positional matching of creator/role/qualifier
    // Only zip positionally when array lengths match (1:1 correspondence).
    // When lengths differ, the mappings table lacks join keys to pair them
    // correctly (#144), so we leave unmatched fields null to avoid fabrication.
    const creators = byField.get("creator") ?? [];
    const roles = byField.get("production_role") ?? [];
    const qualifiers = byField.get("attribution_qualifier") ?? [];
    const birthPlaces = byField.get("birth_place") ?? [];
    const spatials = byField.get("spatial") ?? [];

    const safeRoles = roles.length === creators.length ? roles : [];
    const safeQualifiers = qualifiers.length === creators.length ? qualifiers : [];
    const safeSpatials = spatials.length === creators.length ? spatials : [];
    const safeBirthPlaces = birthPlaces.length === creators.length ? birthPlaces : [];

    const production = creators.map((c, i) => {
      const personInfo = (c.birth_year != null || c.death_year != null || c.gender || c.wikidata_id)
        ? { birthYear: c.birth_year, deathYear: c.death_year, gender: c.gender, wikidataId: c.wikidata_id }
        : undefined;
      return {
        name: label(c),
        role: safeRoles[i] ? label(safeRoles[i]) : null,
        attributionQualifier: safeQualifiers[i] ? label(safeQualifiers[i]) : null,
        place: safeSpatials[i] ? label(safeSpatials[i]) : (safeBirthPlaces[i] ? label(safeBirthPlaces[i]) : null),
        actorUri: c.vocab_id,
        personInfo,
      };
    });

    // Assemble date string
    const date = formatDateRange(row.date_earliest, row.date_latest) ?? "";

    const dimensionStatement = formatDimensions(row.height_cm, row.width_cm);

    // Dimensions structured
    const dimensions: { type: DimensionType; value: number; unit: string; note: string | null }[] = [];
    if (row.height_cm != null) dimensions.push({ type: "height", value: row.height_cm, unit: "cm", note: null });
    if (row.width_cm != null) dimensions.push({ type: "width", value: row.width_cm, unit: "cm", note: null });
    if (row.depth_cm != null) dimensions.push({ type: "depth", value: row.depth_cm, unit: "cm", note: null });
    if (row.weight_g != null) dimensions.push({ type: "weight", value: row.weight_g, unit: "g", note: null });
    if (row.diameter_cm != null) dimensions.push({ type: "diameter", value: row.diameter_cm, unit: "cm", note: null });

    // Themes piggy-back on the byField lookup we already loaded.
    const themeRows = byField.get("theme") ?? [];
    const themesTotalCount = themeRows.length;
    const themes = themeRows.slice(0, VocabularyDb.DETAIL_PREVIEW_LIMIT).map(toTerm);

    // Technique statement from techniques
    const techniqueStatement = techniques.length > 0
      ? techniques.map((t) => t.label).join(", ")
      : null;

    return {
      id: `https://id.rijksmuseum.nl/${row.art_id}`,
      objectNumber: row.object_number,
      title: VocabularyDb.resolveTitle(row.title, row.title_all_text, "Untitled"),
      creator: row.creator_label || "Unknown",
      date,
      type: objectTypes[0]?.label,
      url: `https://www.rijksmuseum.nl/en/collection/${row.object_number}`,
      description: row.description_text,
      techniqueStatement,
      dimensionStatement,
      provenance: row.provenance_text,
      creditLine: row.credit_line,
      inscriptions: row.inscription_text ? row.inscription_text.split(" | ") : [],
      location: this.lookupMuseumRoom(row.current_location),
      collectionSets,
      externalIds: this.fetchArtworkExternalIds(row.art_id),
      // Group A
      titles: this.fetchTitleVariants(row.art_id),
      ...this.fetchArtworkLineage(row.art_id),
      curatorialNarrative: { en: row.narrative_text, nl: null },
      license: row.rights_uri,
      webPage: `https://www.rijksmuseum.nl/en/collection/${row.object_number}`,
      dimensions,
      ...this.fetchRelatedObjects(row.art_id),
      persistentId: row.art_id ? `http://hdl.handle.net/10934/RM0001.COLLECT.${row.art_id}` : null,
      // Group B
      objectTypes,
      materials,
      production,
      collectionSetLabels,
      // Group C
      subjects: { iconclass, depictedPersons, depictedPlaces },
      // Group D — v0.27 (#291)
      dateDisplay: row.date_display,
      extentText: row.extent_text,
      recordCreated: row.record_created,
      recordModified: row.record_modified,
      themes,
      themesTotalCount,
      ...this.fetchExhibitions(row.art_id),
      attributionEvidence: this.fetchAttributionEvidence(row.art_id),
    };
  }

  /**
   * Generic count-then-preview fetch. Short-circuits when count=0 so empty
   * artworks don't pay the preview round-trip. Returns empty when either
   * statement is null (table absent on older harvests).
   */
  private fetchCountAndPreview<TRow, TOut>(
    countStmt: Statement | null,
    previewStmt: Statement | null,
    artId: number,
    limit: number,
    mapRow: (r: TRow) => TOut,
  ): { items: TOut[]; total: number } {
    if (!countStmt || !previewStmt) return { items: [], total: 0 };
    const total = (countStmt.get(artId) as { n: number }).n;
    if (total === 0) return { items: [], total: 0 };
    const rows = previewStmt.all(artId, limit) as TRow[];
    return { items: rows.map(mapRow), total };
  }

  /** Sketchbook/album hierarchy (#28). Parents have no cap (avg ≤1.1); children are capped. */
  private fetchArtworkLineage(
    artId: number,
  ): Pick<ArtworkDetailFromDb, "parents" | "childCount" | "children"> {
    if (!this.stmtArtworkParents) return { parents: [], childCount: 0, children: [] };
    const parents = (this.stmtArtworkParents.all(artId) as {
      object_number: string; title: string | null; title_all_text: string | null;
    }[]).map(p => ({
      objectNumber: p.object_number,
      title: VocabularyDb.resolveTitle(p.title, p.title_all_text, "Untitled"),
    }));

    const { items: children, total: childCount } = this.fetchCountAndPreview<
      { object_number: string; title: string | null; title_all_text: string | null },
      { objectNumber: string; title: string }
    >(
      this.stmtArtworkChildCount,
      this.stmtArtworkChildrenPreview,
      artId,
      VocabularyDb.CHILD_PREVIEW_LIMIT,
      c => ({
        objectNumber: c.object_number,
        title: VocabularyDb.resolveTitle(c.title, c.title_all_text, "Untitled"),
      }),
    );

    return { parents, childCount, children };
  }

  /** Peer artwork relations (recto/verso, frame/painting, pendant, …). */
  private fetchRelatedObjects(
    artId: number,
  ): Pick<ArtworkDetailFromDb, "relatedObjects" | "relatedObjectsTotalCount"> {
    if (!this.stmtArtworkRelatedCount || !this.stmtArtworkRelatedPreview) {
      return { relatedObjects: [], relatedObjectsTotalCount: 0 };
    }
    // Both prepared statements bind the 3 CO_PRODUCTION_LABELS as label
    // filters in addition to artId / limit.
    const labels = VocabularyDb.CO_PRODUCTION_LABELS;
    const total = (this.stmtArtworkRelatedCount.get(artId, ...labels) as { n: number }).n;
    if (total === 0) return { relatedObjects: [], relatedObjectsTotalCount: 0 };

    const rows = this.stmtArtworkRelatedPreview.all(
      artId, ...labels, VocabularyDb.RELATED_PREVIEW_LIMIT,
    ) as {
      relationship_en: string; related_la_uri: string;
      object_number: string | null; title: string | null; title_all_text: string | null;
      iiif_id: string | null;
    }[];

    const items: ArtworkDetailFromDb["relatedObjects"] = rows.map(r => ({
      relationship: r.relationship_en,
      objectNumber: r.object_number,
      title: r.object_number
        ? VocabularyDb.resolveTitle(r.title, r.title_all_text, "Untitled")
        : null,
      objectUri: r.related_la_uri,
      iiifId: r.iiif_id,
    }));
    return { relatedObjects: items, relatedObjectsTotalCount: total };
  }

  /**
   * Given a set of object numbers from a search result, return only those whose
   * parent is also in the same set — i.e. the children that should collapse
   * into a parent already visible in the result. Used by `groupBy=parent`.
   */
  findParentGroupings(objectNumbers: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (!this.db || !this.hasArtworkParent_ || objectNumbers.length === 0) return out;
    const placeholders = objectNumbers.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT child.object_number AS child_obj, parent.object_number AS parent_obj
      FROM artwork_parent ap
      JOIN artworks child  ON child.art_id  = ap.art_id
      JOIN artworks parent ON parent.art_id = ap.parent_art_id
      WHERE child.object_number IN (${placeholders})
        AND parent.object_number IN (${placeholders})
    `).all(...objectNumbers, ...objectNumbers) as { child_obj: string; parent_obj: string }[];
    for (const r of rows) out.set(r.child_obj, r.parent_obj);
    return out;
  }

  /** Splits handle from 'other' authority. */
  private fetchArtworkExternalIds(artId: number): ArtworkDetailFromDb["externalIds"] {
    if (!this.stmtArtworkExternalIds) return { handle: null, other: [] };
    const rows = this.stmtArtworkExternalIds.all(artId) as { authority: string; uri: string }[];
    let handle: string | null = null;
    const other: string[] = [];
    for (const r of rows) {
      if (r.authority === "handle") handle = r.uri;
      else other.push(r.uri);
    }
    return { handle, other };
  }

  /** Artwork-level — partIndex is preserved but does NOT map to production[] index (only 36% agreement empirically). */
  private fetchAttributionEvidence(artId: number): ArtworkDetailFromDb["attributionEvidence"] {
    if (!this.stmtArtworkAttributionEvidence) return [];
    const rows = this.stmtArtworkAttributionEvidence.all(artId) as {
      part_index: number; evidence_type_aat: string | null;
      carried_by_uri: string | null; label_text: string | null;
    }[];
    return rows.map((r) => ({
      partIndex: r.part_index,
      evidenceTypeAat: r.evidence_type_aat,
      carriedByUri: r.carried_by_uri,
      labelText: r.label_text,
    }));
  }

  /** Most-recent first. Max observed in v0.26 is 5 rows/artwork — no cap applied. */
  private fetchExhibitions(artId: number): Pick<ArtworkDetailFromDb, "exhibitions" | "exhibitionsTotalCount"> {
    if (!this.stmtArtworkExhibitions) return { exhibitions: [], exhibitionsTotalCount: 0 };
    const rows = this.stmtArtworkExhibitions.all(artId) as {
      exhibition_id: number; title_en: string | null; title_nl: string | null;
      date_start: string | null; date_end: string | null;
    }[];
    const exhibitions = rows.map((r) => ({
      exhibitionId: r.exhibition_id,
      titleEn: r.title_en,
      titleNl: r.title_nl,
      dateStart: r.date_start,
      dateEnd: r.date_end,
    }));
    return { exhibitions, exhibitionsTotalCount: exhibitions.length };
  }

  /**
   * Resolve a `current_location` code (e.g. "HG-2.20-03") to its museum_rooms row.
   * Strips the `HG-` prefix, takes the leading dotted-decimal segment up to the
   * next hyphen, and looks up `room_id`. Returns null when unmatched (~3.2% of rows).
   */
  private lookupMuseumRoom(currentLocation: string | null): ArtworkDetailFromDb["location"] {
    if (!currentLocation || !this.museumRooms) return null;
    const stripped = currentLocation.startsWith("HG-") ? currentLocation.slice(3) : currentLocation;
    const dashIdx = stripped.indexOf("-");
    const roomId = dashIdx >= 0 ? stripped.slice(0, dashIdx) : stripped;
    return this.museumRooms.get(roomId) ?? null;
  }

  /**
   * Fetch title variants for one artwork, normalising language and qualifier
   * codes onto the values declared in the public ArtworkDetailFromDb shape.
   * Unknown languages (a handful of AAT URIs and NULLs) collapse to "other".
   */
  private fetchTitleVariants(artId: number): ArtworkDetailFromDb["titles"] {
    if (!this.stmtArtworkTitleVariants) return [];
    const rows = this.stmtArtworkTitleVariants.all(artId) as {
      title_text: string; language: string | null; qualifier: string | null;
    }[];
    return rows.map((r) => ({
      title: r.title_text,
      language: TITLE_LANGUAGES_SET.has(r.language as TitleLanguage)
        ? (r.language as TitleLanguage) : "other",
      qualifier: TITLE_QUALIFIERS_SET.has(r.qualifier as TitleQualifier)
        ? (r.qualifier as TitleQualifier) : "other",
    }));
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
    if (!this.db || artIds.length === 0) return result;

    const CHUNK = 500;

    for (let i = 0; i < artIds.length; i += CHUNK) {
      const chunk = artIds.slice(i, i + CHUNK);
      let stmt = this.stmtReconstructSourceCache.get(chunk.length);
      if (!stmt) {
        const placeholders = chunk.map(() => "?").join(", ");
        stmt = this.db.prepare(
          `SELECT art_id, title, narrative_text, inscription_text, description_text
           FROM artworks WHERE art_id IN (${placeholders})`
        );
        this.stmtReconstructSourceCache.set(chunk.length, stmt);
      }
      // Query 1: artwork fields
      const artRows = stmt.all(...chunk) as {
        art_id: number;
        title: string | null;
        narrative_text: string | null;
        inscription_text: string | null;
        description_text: string | null;
      }[];

      // Assemble composite text in same format as embedding generation (no-subjects strategy)
      for (const row of artRows) {
        const fields: [string, string | null | undefined][] = [
          ["Title", row.title],
          ["Inscriptions", row.inscription_text],
          ["Description", row.description_text],
          ["Narrative", row.narrative_text],
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
    if (this.notationDf || !this.db) return;
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
      WHERE m.field_id = ? AND v.notation IS NOT NULL
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
      WHERE m.field_id = ? AND v.notation IS NOT NULL
    `).get(subjectFieldId) as { n: number };
    this.iconclassN = countRow.n;
    this.ensureMappingsStmt();
    console.error(`[find_similar] Iconclass IDF cache: ${this.notationDf.size} notations, ${this.iconclassN.toLocaleString()} artworks`);
  }

  /**
   * Find artworks similar to a given artwork by shared Iconclass notations.
   * Scores by depth × IDF weighted overlap.
   */
  findSimilarByIconclass(objectNumber: string, maxResults: number): IconclassSimilarResult | null {
    if (!this.db) return null;
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
      WHERE m.artwork_id = ? AND +m.field_id = ? AND v.notation IS NOT NULL
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

      const rows = this.stmtMappingsByFieldVocab!.all(subjectFieldId, qn.vocab_rowid) as { artwork_id: number }[];
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
        artId,
        objectNumber: meta?.objectNumber ?? `art_id:${artId}`,
        title: meta?.title ?? "",
        creator: meta?.creator ?? "",
        ...(date && { date }),
        ...(typeMap.has(artId) && { type: typeMap.get(artId) }),
        ...(meta?.iiifId && { iiifId: meta.iiifId }),
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

  /** Lazily initialise lineage qualifier map and creator IDF cache.
   *  Reads from `assignment_pairs` (v0.24+) — preserves the actual qualifier↔creator
   *  assignment. The pre-v0.24 mappings self-JOIN fabricated cartesian pairs whenever
   *  an artwork had multiple qualifiers AND multiple creators (issue #144). */
  private ensureLineageCache(): void {
    if (this.lineageQualifierMap || !this.db) return;
    if (!this.hasAssignmentPairs) return; // #144: gracefully handled by findSimilarByLineage

    // Resolve AAT URIs → vocabulary.id (TEXT) for lineage qualifiers
    this.lineageQualifierMap = new Map();
    for (const [uri, strength] of LINEAGE_QUALIFIERS) {
      const row = this.db.prepare(
        "SELECT id, COALESCE(label_en, label_nl, '') as label FROM vocabulary WHERE external_id = ?"
      ).get(uri) as { id: string; label: string } | undefined;
      if (row) {
        this.lineageQualifierMap.set(row.id, { label: row.label, strength, aatUri: uri });
      }
    }
    const qualIds = [...this.lineageQualifierMap.keys()];
    if (qualIds.length === 0) return;

    // Creator IDF: for each creator that co-appears with a visual-lineage qualifier
    // on the SAME assignment (not just the same artwork). Uses idx_assignment_pairs_qualifier.
    this.lineageCreatorDf = new Map();
    const placeholders = qualIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT creator_id, COUNT(DISTINCT artwork_id) as df
      FROM assignment_pairs
      WHERE qualifier_id IN (${placeholders})
      GROUP BY creator_id
    `).all(...qualIds) as { creator_id: string; df: number }[];

    for (const r of rows) this.lineageCreatorDf.set(r.creator_id, r.df);

    // Total artworks with any visual-lineage qualifier
    const countRow = this.db.prepare(`
      SELECT COUNT(DISTINCT artwork_id) as n FROM assignment_pairs
      WHERE qualifier_id IN (${placeholders})
    `).get(...qualIds) as { n: number };
    this.lineageN = countRow.n;
    // Cache the per-pair candidate lookup statement (called N times per query).
    // PK is (artwork_id, qualifier_id, creator_id) — each artwork appears at
    // most once per (qualifier_id, creator_id), so no DISTINCT needed.
    this.stmtLineageShared = this.db.prepare(`
      SELECT artwork_id FROM assignment_pairs
      WHERE qualifier_id = ? AND creator_id = ?
    `);
    console.error(`[find_similar] Lineage IDF cache: ${this.lineageCreatorDf.size} creators, ${this.lineageN.toLocaleString()} artworks`);
  }

  /**
   * Find artworks similar to a given artwork by shared visual-style lineage.
   * Scores by qualifier-strength × creator-IDF.
   */
  findSimilarByLineage(objectNumber: string, maxResults: number): LineageSimilarResult | null {
    if (!this.db) return null;
    if (!this.hasAssignmentPairs) {
      // #144: pre-v0.24 DBs lack the assignment_pairs table. Returning a graceful
      // warning is preferable to running the old self-JOIN that fabricated cartesian
      // pairs for multi-attribution artworks.
      const artRow = this.stmtLookupArtId!.get(objectNumber) as { art_id: number; title: string; creator_label: string } | undefined;
      return {
        queryObjectNumber: objectNumber,
        queryTitle: artRow?.title ?? "",
        queryLineage: [],
        results: [],
        warnings: ["Lineage similarity requires vocabulary DB v0.24+ (assignment_pairs table). The deployed DB does not include it."],
      };
    }
    this.ensureLineageCache();
    if (!this.lineageQualifierMap || !this.lineageCreatorDf) return null;

    // 1. Resolve art_id
    const artRow = this.stmtLookupArtId!.get(objectNumber) as { art_id: number; title: string; creator_label: string } | undefined;
    if (!artRow) return null;
    const queryArtId = artRow.art_id;

    // 2. Get query artwork's actual (qualifier, creator) assignments from v0.24+
    //    assignment_pairs. Only visual-similarity qualifiers (not "primary",
    //    "attributed to", etc.).
    const qualIds = [...this.lineageQualifierMap.keys()];
    const qualPlaceholders = qualIds.map(() => "?").join(", ");

    const queryPairs = this.db.prepare(`
      SELECT ap.qualifier_id, ap.creator_id,
             COALESCE(v.label_en, v.label_nl, '') as creator_label
      FROM assignment_pairs ap
      JOIN vocabulary v ON v.id = ap.creator_id
      WHERE ap.artwork_id = ? AND ap.qualifier_id IN (${qualPlaceholders})
    `).all(queryArtId, ...qualIds) as {
      qualifier_id: string; creator_id: string; creator_label: string;
    }[];

    if (queryPairs.length === 0) {
      // Check if the artwork has any assignment pairs at all (to give an informative message)
      const anyAssignment = this.db.prepare(
        "SELECT 1 FROM assignment_pairs WHERE artwork_id = ? LIMIT 1"
      ).get(queryArtId);
      const msg = anyAssignment
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
        qualifierUri: qualInfo.aatUri,
        creatorLabel: pair.creator_label,
        strength: qualInfo.strength,
      };

      // Warn about anonymous/unknown creators with near-zero IDF
      if (creatorIdf < 0.5 && pair.creator_label.toLowerCase().match(/^(anonymous|unknown|onbekend)/)) {
        warnings.push(`"${qualInfo.label} ${pair.creator_label}" — anonymous creator, results may be less distinctive.`);
      }

      // Find artworks sharing this (qualifier, creator) pair
      const rows = this.stmtLineageShared!.all(pair.qualifier_id, pair.creator_id) as { artwork_id: number }[];

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
        artId,
        objectNumber: meta?.objectNumber ?? `art_id:${artId}`,
        title: meta?.title ?? "",
        creator: meta?.creator ?? "",
        ...(date && { date }),
        ...(typeMap.has(artId) && { type: typeMap.get(artId) }),
        ...(meta?.iiifId && { iiifId: meta.iiifId }),
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
        return { qualifierLabel: qi.label, qualifierUri: qi.aatUri, creatorLabel: p.creator_label, strength: qi.strength };
      }),
      results,
      ...(warnings.length > 0 && { warnings }),
    };
  }

  // ── find_similar: Depicted Person overlap ────────────────────────────

  /** Lazily initialise the depicted person IDF cache. */
  private ensurePersonCache(): void {
    if (this.personDf || !this.db) return;
    const subjectFieldId = this.requireFieldId("subject");

    // IDF: count artworks per depicted person
    this.personDf = new Map();
    const rows = this.db.prepare(`
      SELECT m.vocab_rowid, COUNT(DISTINCT m.artwork_id) as df
      FROM mappings m
      JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.field_id = ? AND v.type = 'person'
      GROUP BY m.vocab_rowid
    `).all(subjectFieldId) as { vocab_rowid: number; df: number }[];

    for (const r of rows) this.personDf.set(r.vocab_rowid, r.df);

    const countRow = this.db.prepare(`
      SELECT COUNT(DISTINCT m.artwork_id) as n
      FROM mappings m JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.field_id = ? AND v.type = 'person'
    `).get(subjectFieldId) as { n: number };
    this.personN = countRow.n;
    this.ensureMappingsStmt();
    console.error(`[find_similar] Person IDF cache: ${this.personDf.size} persons, ${this.personN.toLocaleString()} artworks`);
  }

  /**
   * Shared implementation for depicted-person and depicted-place similarity.
   * Scores by IDF-weighted overlap of query terms against candidates.
   */
  private findSimilarByDepictedTerms(
    objectNumber: string,
    maxResults: number,
    queryTerms: { vocab_rowid: number; label: string; external_id: string | null; wikidata_id: string | null }[],
    dfMap: Map<number, number>,
    N: number,
    fieldId: number,
    artRow: { art_id: number; title: string },
    emptyWarning: string,
  ): DepictedSimilarResult {
    if (queryTerms.length === 0) {
      return {
        queryObjectNumber: objectNumber,
        queryTitle: artRow.title || "",
        queryTerms: [],
        results: [],
        warnings: [emptyWarning],
      };
    }

    const queryArtId = artRow.art_id;
    const candidates = new Map<number, { totalWeight: number; sharedTerms: { label: string; weight: number; wikidataUri?: string }[] }>();

    for (const term of queryTerms) {
      const df = dfMap.get(term.vocab_rowid) ?? 1;
      const idf = Math.log(N / df);
      const weight = Math.round(idf * 100) / 100;
      const wikidataUri = toWikidataUri(term);

      const rows = this.stmtMappingsByFieldVocab!.all(fieldId, term.vocab_rowid) as { artwork_id: number }[];
      for (const r of rows) {
        if (r.artwork_id === queryArtId) continue;
        const entry = candidates.get(r.artwork_id);
        if (entry) {
          entry.totalWeight += idf;
          entry.sharedTerms.push({ label: term.label, weight, ...(wikidataUri && { wikidataUri }) });
        } else {
          candidates.set(r.artwork_id, { totalWeight: idf, sharedTerms: [{ label: term.label, weight, ...(wikidataUri && { wikidataUri }) }] });
        }
      }
    }

    const sorted = [...candidates.entries()]
      .sort((a, b) => b[1].totalWeight - a[1].totalWeight)
      .slice(0, maxResults);

    const artIds = sorted.map(([artId]) => artId);
    const metaMap = this.batchLookupByArtId(artIds);
    const typeMap = this.batchLookupTypesByArtId(artIds);

    const results = sorted.map(([artId, data]) => {
      const meta = metaMap.get(artId);
      const date = formatDateRange(meta?.dateEarliest, meta?.dateLatest);
      data.sharedTerms.sort((a, b) => b.weight - a.weight);
      return {
        artId,
        objectNumber: meta?.objectNumber ?? `art_id:${artId}`,
        title: meta?.title ?? "",
        creator: meta?.creator ?? "",
        ...(date && { date }),
        ...(typeMap.has(artId) && { type: typeMap.get(artId) }),
        ...(meta?.iiifId && { iiifId: meta.iiifId }),
        score: Math.round(data.totalWeight * 100) / 100,
        sharedTerms: data.sharedTerms,
        url: `https://www.rijksmuseum.nl/en/collection/${meta?.objectNumber ?? ""}`,
      };
    });

    return {
      queryObjectNumber: objectNumber,
      queryTitle: artRow.title || "",
      queryTerms: queryTerms.map(t => {
        const wikidataUri = toWikidataUri(t);
        return { label: t.label, artworks: dfMap.get(t.vocab_rowid) ?? 0, ...(wikidataUri && { wikidataUri }) };
      }),
      results,
    };
  }

  /**
   * Find artworks similar to a given artwork by shared depicted persons.
   * Scores by IDF-weighted overlap.
   */
  findSimilarByDepictedPerson(objectNumber: string, maxResults: number): DepictedSimilarResult | null {
    if (!this.db) return null;
    this.ensurePersonCache();
    if (!this.personDf) return null;

    const subjectFieldId = this.requireFieldId("subject");
    const artRow = this.stmtLookupArtId!.get(objectNumber) as { art_id: number; title: string; creator_label: string } | undefined;
    if (!artRow) return null;

    const queryPersons = this.db.prepare(`
      SELECT m.vocab_rowid, COALESCE(v.label_en, v.label_nl, '') as label,
             v.external_id, v.wikidata_id
      FROM mappings m
      JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.artwork_id = ? AND +m.field_id = ? AND v.type = 'person'
    `).all(artRow.art_id, subjectFieldId) as { vocab_rowid: number; label: string; external_id: string | null; wikidata_id: string | null }[];

    return this.findSimilarByDepictedTerms(
      objectNumber, maxResults, queryPersons,
      this.personDf, this.personN, subjectFieldId, artRow,
      "This artwork has no depicted persons to search by.",
    );
  }

  // ── find_similar: Depicted Place overlap ─────────────────────────────

  /** Maximum children count for a place to be included as a depicted-place signal. */
  private static readonly PLACE_CHILDREN_THRESHOLD = 20;

  /** Lazily initialise the depicted place IDF cache with breadth-based filtering. */
  private ensurePlaceCache(): void {
    if (this.placeDf || !this.db) return;
    const subjectFieldId = this.requireFieldId("subject");

    // Exclude broad regions (>20 children in vocabulary hierarchy).
    // TGN-linked places are NOT blanket-excluded — only genuinely broad ones.
    this.placeExcluded = new Set<number>();

    const broadRows = this.db.prepare(`
      SELECT v.vocab_int_id
      FROM vocabulary v
      JOIN (
        SELECT broader_id, COUNT(*) as child_count
        FROM vocabulary WHERE broader_id IS NOT NULL
        GROUP BY broader_id
      ) cc ON cc.broader_id = v.id
      WHERE v.type = 'place' AND cc.child_count > ?
    `).all(VocabularyDb.PLACE_CHILDREN_THRESHOLD) as { vocab_int_id: number }[];
    for (const r of broadRows) this.placeExcluded.add(r.vocab_int_id);

    // IDF: count artworks per depicted place (excluding noise)
    this.placeDf = new Map();
    const rows = this.db.prepare(`
      SELECT m.vocab_rowid, COUNT(DISTINCT m.artwork_id) as df
      FROM mappings m
      JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.field_id = ? AND v.type = 'place'
      GROUP BY m.vocab_rowid
    `).all(subjectFieldId) as { vocab_rowid: number; df: number }[];

    for (const r of rows) {
      if (this.placeExcluded.has(r.vocab_rowid)) continue;
      this.placeDf.set(r.vocab_rowid, r.df);
    }

    // Count distinct artworks with at least one non-excluded place.
    // We can't sum DFs (artworks have multiple places), so query with a temp table.
    this.db.exec("CREATE TEMP TABLE IF NOT EXISTS _place_vocab_ids (id INTEGER PRIMARY KEY)");
    this.db.exec("DELETE FROM _place_vocab_ids");
    const insertStmt = this.db.prepare("INSERT INTO _place_vocab_ids (id) VALUES (?)");
    const insertMany = this.db.transaction((ids: number[]) => { for (const id of ids) insertStmt.run(id); });
    insertMany([...this.placeDf.keys()]);
    const countRow = this.db.prepare(`
      SELECT COUNT(DISTINCT m.artwork_id) as n
      FROM mappings m
      WHERE m.field_id = ? AND m.vocab_rowid IN (SELECT id FROM _place_vocab_ids)
    `).get(subjectFieldId) as { n: number };
    this.placeN = countRow.n;
    this.db.exec("DROP TABLE IF EXISTS _place_vocab_ids");

    this.ensureMappingsStmt();
    console.error(`[find_similar] Place IDF cache: ${this.placeDf.size} places (${this.placeExcluded.size} excluded), ${this.placeN.toLocaleString()} artworks`);
  }

  /**
   * Find artworks similar to a given artwork by shared depicted places.
   * Scores by IDF-weighted overlap. Excludes broad regions (>20 children in hierarchy).
   */
  findSimilarByDepictedPlace(objectNumber: string, maxResults: number): DepictedSimilarResult | null {
    if (!this.db) return null;
    this.ensurePlaceCache();
    if (!this.placeDf) return null;

    const subjectFieldId = this.requireFieldId("subject");
    const artRow = this.stmtLookupArtId!.get(objectNumber) as { art_id: number; title: string; creator_label: string } | undefined;
    if (!artRow) return null;

    const queryPlacesRaw = this.db.prepare(`
      SELECT m.vocab_rowid, COALESCE(v.label_en, v.label_nl, '') as label,
             v.external_id, v.wikidata_id
      FROM mappings m
      JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.artwork_id = ? AND +m.field_id = ? AND v.type = 'place'
    `).all(artRow.art_id, subjectFieldId) as { vocab_rowid: number; label: string; external_id: string | null; wikidata_id: string | null }[];

    const queryPlaces = queryPlacesRaw.filter(p => !this.placeExcluded!.has(p.vocab_rowid));

    const emptyWarning = queryPlacesRaw.length > 0
      ? "This artwork's depicted places are too broad (countries/regions) to search by."
      : "This artwork has no depicted places to search by.";

    return this.findSimilarByDepictedTerms(
      objectNumber, maxResults, queryPlaces,
      this.placeDf, this.placeN, subjectFieldId, artRow,
      emptyWarning,
    );
  }

  // ── find_similar: Theme overlap (#294) ───────────────────────────────

  /** Lazily initialise the theme IDF cache. */
  private ensureThemeCache(): void {
    if (this.themeDf || !this.db) return;
    if (!this.fieldIdMap.has("theme")) {
      this.themeDf = new Map();
      return;
    }
    const themeFieldId = this.requireFieldId("theme");

    this.themeDf = new Map();
    const rows = this.db.prepare(`
      SELECT vocab_rowid, COUNT(DISTINCT artwork_id) as df
      FROM mappings WHERE field_id = ?
      GROUP BY vocab_rowid
    `).all(themeFieldId) as { vocab_rowid: number; df: number }[];
    for (const r of rows) this.themeDf.set(r.vocab_rowid, r.df);

    const countRow = this.db.prepare(
      `SELECT COUNT(DISTINCT artwork_id) as n FROM mappings WHERE field_id = ?`
    ).get(themeFieldId) as { n: number };
    this.themeN = countRow.n;
    this.ensureMappingsStmt();
    console.error(`[find_similar] Theme IDF cache: ${this.themeDf.size} themes, ${this.themeN.toLocaleString()} artworks`);
  }

  /**
   * Find artworks similar to a given artwork by shared themes.
   * IDF set-overlap: Σ log(N/DF(t)) over shared themes.
   * Requires the seed to carry ≥2 themes; tertiary tie-break by artworks.importance.
   * Themes do not carry Wikidata identifiers, so sharedTerms[] omits wikidataUri.
   */
  findSimilarByTheme(objectNumber: string, maxResults: number): DepictedSimilarResult | null {
    if (!this.db) return null;
    this.ensureThemeCache();
    if (!this.themeDf) return null;
    if (!this.fieldIdMap.has("theme")) return null;

    const themeFieldId = this.requireFieldId("theme");
    const artRow = this.stmtLookupArtId!.get(objectNumber) as
      { art_id: number; title: string; creator_label: string } | undefined;
    if (!artRow) return null;

    const queryThemes = this.db.prepare(`
      SELECT m.vocab_rowid, COALESCE(v.label_en, v.label_nl, '') as label
      FROM mappings m
      JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE m.artwork_id = ? AND +m.field_id = ?
    `).all(artRow.art_id, themeFieldId) as { vocab_rowid: number; label: string }[];

    if (queryThemes.length < 2) {
      return {
        queryObjectNumber: objectNumber,
        queryTitle: artRow.title || "",
        queryTerms: queryThemes.map(t => ({
          label: t.label,
          artworks: this.themeDf!.get(t.vocab_rowid) ?? 0,
        })),
        results: [],
        warnings: ["This artwork has fewer than 2 themes — Theme channel requires ≥2 to suppress noise."],
      };
    }

    const queryArtId = artRow.art_id;
    const candidates = new Map<number, { totalWeight: number; sharedTerms: { label: string; weight: number }[] }>();

    for (const term of queryThemes) {
      const df = this.themeDf.get(term.vocab_rowid) ?? 1;
      const idf = Math.log(this.themeN / df);
      const weight = Math.round(idf * 100) / 100;

      const rows = this.stmtMappingsByFieldVocab!.all(themeFieldId, term.vocab_rowid) as { artwork_id: number }[];
      for (const r of rows) {
        if (r.artwork_id === queryArtId) continue;
        const entry = candidates.get(r.artwork_id);
        if (entry) {
          entry.totalWeight += idf;
          entry.sharedTerms.push({ label: term.label, weight });
        } else {
          candidates.set(r.artwork_id, { totalWeight: idf, sharedTerms: [{ label: term.label, weight }] });
        }
      }
    }

    const allCandidates = [...candidates.entries()];
    const importanceMap = this.batchLookupImportanceByArtId(allCandidates.map(([artId]) => artId));

    const sorted = allCandidates
      .sort((a, b) => {
        if (b[1].totalWeight !== a[1].totalWeight) return b[1].totalWeight - a[1].totalWeight;
        return (importanceMap.get(b[0]) ?? 0) - (importanceMap.get(a[0]) ?? 0);
      })
      .slice(0, maxResults);

    const artIds = sorted.map(([artId]) => artId);
    const metaMap = this.batchLookupByArtId(artIds);
    const typeMap = this.batchLookupTypesByArtId(artIds);

    const results = sorted.map(([artId, data]) => {
      const meta = metaMap.get(artId);
      const date = formatDateRange(meta?.dateEarliest, meta?.dateLatest);
      data.sharedTerms.sort((a, b) => b.weight - a.weight);
      return {
        artId,
        objectNumber: meta?.objectNumber ?? `art_id:${artId}`,
        title: meta?.title ?? "",
        creator: meta?.creator ?? "",
        ...(date && { date }),
        ...(typeMap.has(artId) && { type: typeMap.get(artId) }),
        ...(meta?.iiifId && { iiifId: meta.iiifId }),
        score: Math.round(data.totalWeight * 100) / 100,
        sharedTerms: data.sharedTerms,
        url: `https://www.rijksmuseum.nl/en/collection/${meta?.objectNumber ?? ""}`,
      };
    });

    return {
      queryObjectNumber: objectNumber,
      queryTitle: artRow.title || "",
      queryTerms: queryThemes.map(t => ({
        label: t.label,
        artworks: this.themeDf!.get(t.vocab_rowid) ?? 0,
      })),
      results,
    };
  }

  // ── find_similar: Related Co-Production curator-declared edges (#293) ───────

  /**
   * Build a Map<art_id, [{peerArtId, label}]> by scanning related_objects for
   * edges whose relationship_en sits in `labels`. Edges with NULL
   * related_art_id (peer not in our DB) are skipped — the v0.26 dataset has
   * zero such rows in either label scope, so an "external peer" placeholder
   * isn't rendered.
   *
   * Shared by ensureCoProductionCache (3 creator-invariant types) and
   * ensureRelatedObjectCache (7 derivative + grouping types).
   */
  private buildRelationshipCache(
    labels: ReadonlyArray<string>,
    logName: string,
  ): Map<number, { peerArtId: number; label: string }[]> {
    const cache = new Map<number, { peerArtId: number; label: string }[]>();
    if (!this.db || !this.hasRelatedObjects_) return cache;

    const placeholders = labels.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT art_id, related_art_id, relationship_en
      FROM related_objects
      WHERE relationship_en IN (${placeholders}) AND related_art_id IS NOT NULL
    `).all(...labels) as {
      art_id: number; related_art_id: number; relationship_en: string;
    }[];

    for (const r of rows) {
      const list = cache.get(r.art_id) ?? [];
      list.push({ peerArtId: r.related_art_id, label: r.relationship_en });
      cache.set(r.art_id, list);
    }
    console.error(`[find_similar] ${logName} cache: ${cache.size} seeds, ${rows.length} edges`);
    return cache;
  }

  private ensureCoProductionCache(): void {
    if (this.coProductionByArtId || !this.db) return;
    this.coProductionByArtId = this.buildRelationshipCache(
      VocabularyDb.CO_PRODUCTION_LABELS, "Co-Production",
    );
  }

  private ensureRelatedObjectCache(): void {
    if (this.relatedObjectByArtId || !this.db) return;
    this.relatedObjectByArtId = this.buildRelationshipCache(
      VocabularyDb.RELATED_OBJECT_LABELS, "Related Object",
    );
  }

  /**
   * Find artworks declared as co-productions of the seed via curator-asserted
   * edges ('different example' / 'production stadia' / 'pendant'). Score is
   * fixed at 10 — these are explicit assertions, not probabilistic matches.
   * Multi-label collisions on the same peer collapse into one result whose
   * sharedTerms[] carries every label.
   */
  findSimilarByCoProduction(objectNumber: string, maxResults: number): DepictedSimilarResult | null {
    if (!this.db) return null;
    this.ensureCoProductionCache();
    if (!this.coProductionByArtId) return null;

    const artRow = this.stmtLookupArtId!.get(objectNumber) as
      { art_id: number; title: string; creator_label: string } | undefined;
    if (!artRow) return null;

    const edges = this.coProductionByArtId.get(artRow.art_id) ?? [];
    if (edges.length === 0) {
      return {
        queryObjectNumber: objectNumber,
        queryTitle: artRow.title || "",
        queryTerms: [],
        results: [],
        warnings: ["No declared co-production edges (different example / production stadia / pendant) on this artwork."],
      };
    }

    return this.assembleRelatedResults(objectNumber, artRow.title, edges, maxResults, () => 10);
  }

  /**
   * Find artworks declared as Related Objects of the seed — derivative works
   * (original | reproduction, related object) and multi-object groupings
   * (pair / pair (weapons) / set / recto | verso / product line). Score is
   * tiered per relationship type (RELATED_OBJECT_TIER_WEIGHT). When a peer
   * has multiple edges to the seed, the highest tier wins for the score and
   * sharedTerms[] carries every label.
   */
  findSimilarByRelatedObject(objectNumber: string, maxResults: number): DepictedSimilarResult | null {
    if (!this.db) return null;
    this.ensureRelatedObjectCache();
    if (!this.relatedObjectByArtId) return null;

    const artRow = this.stmtLookupArtId!.get(objectNumber) as
      { art_id: number; title: string; creator_label: string } | undefined;
    if (!artRow) return null;

    const edges = this.relatedObjectByArtId.get(artRow.art_id) ?? [];
    if (edges.length === 0) {
      return {
        queryObjectNumber: objectNumber,
        queryTitle: artRow.title || "",
        queryTerms: [],
        results: [],
        warnings: ["No declared Related Object edges (pair / set / recto | verso / reproduction / general related object / …) on this artwork."],
      };
    }

    return this.assembleRelatedResults(
      objectNumber, artRow.title, edges, maxResults,
      labels => Math.max(...labels.map(l => VocabularyDb.RELATED_OBJECT_TIER_WEIGHT[l] ?? 1)),
    );
  }

  /** Shared assembly path for both Co-Production and Related Object channels.
   *  scoreFn receives the distinct labels for a peer and returns the score. */
  private assembleRelatedResults(
    objectNumber: string,
    queryTitle: string,
    edges: { peerArtId: number; label: string }[],
    maxResults: number,
    scoreFn: (labels: string[]) => number,
  ): DepictedSimilarResult {
    const byPeer = new Map<number, Set<string>>();
    for (const e of edges) {
      const labels = byPeer.get(e.peerArtId);
      if (labels) labels.add(e.label);
      else byPeer.set(e.peerArtId, new Set([e.label]));
    }

    const peerIds = [...byPeer.keys()].slice(0, maxResults);
    const metaMap = this.batchLookupByArtId(peerIds);
    const typeMap = this.batchLookupTypesByArtId(peerIds);

    const results = peerIds.map(peerArtId => {
      const labels = [...(byPeer.get(peerArtId) ?? new Set<string>())];
      const meta = metaMap.get(peerArtId);
      const date = formatDateRange(meta?.dateEarliest, meta?.dateLatest);
      const score = scoreFn(labels);
      return {
        artId: peerArtId,
        objectNumber: meta?.objectNumber ?? `art_id:${peerArtId}`,
        title: meta?.title ?? "",
        creator: meta?.creator ?? "",
        ...(date && { date }),
        ...(typeMap.has(peerArtId) && { type: typeMap.get(peerArtId) }),
        ...(meta?.iiifId && { iiifId: meta.iiifId }),
        score,
        sharedTerms: labels.map(label => ({ label, weight: score })),
        url: `https://www.rijksmuseum.nl/en/collection/${meta?.objectNumber ?? ""}`,
      };
    });

    const distinctLabels = [...new Set(edges.map(e => e.label))];
    return {
      queryObjectNumber: objectNumber,
      queryTitle: queryTitle || "",
      queryTerms: distinctLabels.map(label => ({ label, artworks: 0 })),
      results,
    };
  }

  // ── find_similar: batch metadata helpers ───────────────────────────

  /** Look up art_id, title, creator by object number. Returns null if not found. */
  lookupArtId(objectNumber: string): { artId: number; title: string; creator: string } | null {
    if (!this.stmtLookupArtId) return null;
    const row = this.stmtLookupArtId.get(objectNumber) as { art_id: number; title: string; creator_label: string } | undefined;
    if (!row) return null;
    return { artId: row.art_id, title: row.title || "", creator: row.creator_label || "" };
  }

  /** Batch-lookup artwork metadata by art_id. Includes iiif_id when available. Chunks at 500. */
  batchLookupByArtId(artIds: number[]): Map<number, ArtworkMeta> {
    const map = new Map<number, ArtworkMeta>();
    if (!this.db || artIds.length === 0) return map;
    const CHUNK = 500;
    for (let i = 0; i < artIds.length; i += CHUNK) {
      const chunk = artIds.slice(i, i + CHUNK);
      let stmt = this.stmtBatchByArtIdCache.get(chunk.length);
      if (!stmt) {
        const placeholders = chunk.map(() => "?").join(", ");
        stmt = this.db.prepare(
          `SELECT ${this.batchByArtIdCols} FROM artworks WHERE art_id IN (${placeholders})`
        );
        this.stmtBatchByArtIdCache.set(chunk.length, stmt);
      }
      const rows = stmt.all(...chunk) as {
        art_id: number; object_number: string; title: string; title_all_text: string | null;
        creator_label: string; date_earliest: number | null; date_latest: number | null;
        iiif_id?: string | null;
      }[];
      for (const r of rows) {
        map.set(r.art_id, {
          objectNumber: r.object_number,
          title: VocabularyDb.resolveTitle(r.title, r.title_all_text),
          creator: r.creator_label || "",
          dateEarliest: r.date_earliest,
          dateLatest: r.date_latest,
          iiifId: r.iiif_id ?? null,
        });
      }
    }
    return map;
  }

  /** Batch-lookup artwork types by art_id. Chunks at 500. */
  batchLookupTypesByArtId(artIds: number[]): Map<number, string> {
    const map = new Map<number, string>();
    if (!this.db || artIds.length === 0) return map;
    const typeFieldId = this.requireFieldId("type");
    const CHUNK = 500;
    for (let i = 0; i < artIds.length; i += CHUNK) {
      const chunk = artIds.slice(i, i + CHUNK);
      let stmt = this.stmtBatchTypesByArtIdCache.get(chunk.length);
      if (!stmt) {
        const placeholders = chunk.map(() => "?").join(", ");
        stmt = this.db.prepare(`
          SELECT m.artwork_id, COALESCE(v.label_en, v.label_nl, '') as label
          FROM mappings m
          JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
          WHERE m.artwork_id IN (${placeholders}) AND +m.field_id = ?
        `);
        this.stmtBatchTypesByArtIdCache.set(chunk.length, stmt);
      }
      const rows = stmt.all(...chunk, typeFieldId) as { artwork_id: number; label: string }[];
      for (const r of rows) {
        if (r.label && !map.has(r.artwork_id)) map.set(r.artwork_id, r.label);
      }
    }
    return map;
  }

  /** Batch-lookup artwork importance scores by art_id. Returns empty map if the
   *  importance column isn't present. Used by Theme channel for tertiary tie-break. */
  batchLookupImportanceByArtId(artIds: number[]): Map<number, number> {
    const map = new Map<number, number>();
    if (!this.db || artIds.length === 0 || !this.hasImportance) return map;
    const CHUNK = 500;
    for (let i = 0; i < artIds.length; i += CHUNK) {
      const chunk = artIds.slice(i, i + CHUNK);
      let stmt = this.stmtBatchImportanceByArtIdCache.get(chunk.length);
      if (!stmt) {
        const placeholders = chunk.map(() => "?").join(", ");
        stmt = this.db.prepare(
          `SELECT art_id, importance FROM artworks WHERE art_id IN (${placeholders})`
        );
        this.stmtBatchImportanceByArtIdCache.set(chunk.length, stmt);
      }
      const rows = stmt.all(...chunk) as { art_id: number; importance: number | null }[];
      for (const r of rows) map.set(r.art_id, r.importance ?? 0);
    }
    return map;
  }

  /** Batch-lookup description texts by art_id. Chunks at 500. */
  batchLookupDescriptionsByArtId(artIds: number[]): Map<number, string> {
    const map = new Map<number, string>();
    if (!this.db || artIds.length === 0) return map;
    const CHUNK = 500;
    for (let i = 0; i < artIds.length; i += CHUNK) {
      const chunk = artIds.slice(i, i + CHUNK);
      let stmt = this.stmtBatchDescByArtIdCache.get(chunk.length);
      if (!stmt) {
        const placeholders = chunk.map(() => "?").join(", ");
        stmt = this.db.prepare(`
          SELECT art_id, description_text
          FROM artworks WHERE art_id IN (${placeholders}) AND description_text IS NOT NULL
        `);
        this.stmtBatchDescByArtIdCache.set(chunk.length, stmt);
      }
      const rows = stmt.all(...chunk) as { art_id: number; description_text: string }[];
      for (const r of rows) {
        if (r.description_text) map.set(r.art_id, r.description_text);
      }
    }
    return map;
  }

  /** Page in critical mmap regions so the first real query is fast.
   *  Touches FTS index, mappings B-tree, and artworks table. */
  warmCorePages(): void {
    if (!this.db) return;
    const t0 = Date.now();
    try {
      // FTS index pages
      if (this.hasFts5) {
        this.db.prepare("SELECT rowid FROM vocabulary_fts WHERE vocabulary_fts MATCH 'painting' LIMIT 1").get();
      }
      // Mappings B-tree — a narrow vocab→artwork lookup (the hot path for search)
      this.db.prepare(
        "SELECT artwork_id FROM mappings WHERE field_id = 1 AND vocab_rowid = 1 LIMIT 1"
      ).get();
      // Artworks table — a single row fetch
      this.db.prepare("SELECT art_id FROM artworks LIMIT 1").get();
      console.error(`  Vocab DB core pages warmed in ${Date.now() - t0}ms`);
    } catch (err) {
      console.error(`  Vocab DB warmup failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Eagerly build all caches used by find_similar.
   *  Safe to call multiple times — each ensure* method no-ops if already built. */
  warmSimilarCaches(): void {
    if (!this.db) return;
    this.ensureIconclassCache();
    this.ensureLineageCache();
    this.ensurePersonCache();
    this.ensurePlaceCache();
    this.ensureThemeCache();
    this.ensureCoProductionCache();
    this.ensureRelatedObjectCache();
  }

  // ── Curated sets cache (used by list_curated_sets) ─────────────────
  //
  // Built once at startup via three bulk GROUP-BY queries (memberCount,
  // dominantTypes, dominantCenturies) — each scans the mappings table once
  // and uses ROW_NUMBER() OVER (PARTITION BY set) to keep top-N per set.
  // Cheaper than a per-set 3-query loop (193 sets × 3 = 579 statements).

  private curatedSetsCache: Map<string, CuratedSetMeta> | null = null;

  private classifySetCategory(
    name: string,
    memberCount: number,
    types: { label: string; count: number }[],
  ): CuratedSetCategory | null {
    const n = name.toLowerCase();
    if (memberCount >= 500_000) return "umbrella";
    if (n.startsWith("album ")) return "album";
    if (types[0]) {
      const topLabel = types[0].label.toLowerCase();
      if (topLabel === n || (memberCount > 0 && types[0].count >= memberCount * 0.95)) {
        return "object_type";
      }
    }
    const iconographic = [
      "portret", "portrait",
      "landschap", "landscape",
      "stilleven", "still life",
      "religieus", "religious",
      "mythologisch", "mythological",
      "historisch", "historical",
    ];
    if (iconographic.some(kw => n.includes(kw))) return "iconographic";
    return "sub_collection";
  }

  ensureCuratedSetsCache(): void {
    if (this.curatedSetsCache || !this.db) return;
    const t0 = Date.now();
    const collectionSetFieldId = this.requireFieldId("collection_set");
    const typeFieldId = this.requireFieldId("type");

    const sets = this.db.prepare(`
      SELECT v.id AS set_spec, v.vocab_int_id AS set_int_id,
             COALESCE(v.label_en, v.label_nl, v.id) AS name
      FROM vocabulary v WHERE v.type = 'set'
    `).all() as { set_spec: string; set_int_id: number; name: string }[];

    const memberRows = this.db.prepare(`
      SELECT vocab_rowid AS set_int_id, COUNT(DISTINCT artwork_id) AS n
      FROM mappings WHERE field_id = ?
      GROUP BY vocab_rowid
    `).all(collectionSetFieldId) as { set_int_id: number; n: number }[];
    const memberById = new Map<number, number>();
    for (const r of memberRows) memberById.set(r.set_int_id, r.n);

    // Top-3 dominant types per set. ROW_NUMBER over PARTITION BY set is what
    // makes the "top-N per group" tractable in a single pass; without it we'd
    // need 193 correlated subqueries.
    const typeRows = this.db.prepare(`
      WITH set_type_counts AS (
        SELECT m1.vocab_rowid AS set_int_id,
               m2.vocab_rowid AS type_int_id,
               COUNT(*) AS cnt
        FROM mappings m1
        JOIN mappings m2 ON m2.artwork_id = m1.artwork_id AND m2.field_id = ?
        WHERE m1.field_id = ?
        GROUP BY m1.vocab_rowid, m2.vocab_rowid
      ),
      ranked AS (
        SELECT set_int_id, type_int_id, cnt,
               ROW_NUMBER() OVER (PARTITION BY set_int_id ORDER BY cnt DESC) AS rn
        FROM set_type_counts
      )
      SELECT r.set_int_id, COALESCE(v.label_en, v.label_nl, '') AS label, r.cnt
      FROM ranked r
      JOIN vocabulary v ON v.vocab_int_id = r.type_int_id
      WHERE r.rn <= 3
      ORDER BY r.set_int_id, r.cnt DESC
    `).all(typeFieldId, collectionSetFieldId) as { set_int_id: number; label: string; cnt: number }[];
    const typesById = new Map<number, { label: string; count: number }[]>();
    for (const r of typeRows) {
      if (!r.label) continue;
      const arr = typesById.get(r.set_int_id) ?? [];
      arr.push({ label: r.label, count: r.cnt });
      typesById.set(r.set_int_id, arr);
    }

    // Top-2 centuries per set. Negative dates (BC) bin via floor division to
    // keep monotonic ordering across the BC/AD boundary.
    const centuryRows = this.db.prepare(`
      WITH set_century_counts AS (
        SELECT m.vocab_rowid AS set_int_id,
               (CASE WHEN a.date_earliest >= 0
                     THEN (a.date_earliest / 100) * 100
                     ELSE -((-a.date_earliest - 1) / 100 + 1) * 100 END) AS bin,
               COUNT(*) AS cnt
        FROM mappings m
        JOIN artworks a ON a.art_id = m.artwork_id
        WHERE m.field_id = ? AND a.date_earliest IS NOT NULL
        GROUP BY m.vocab_rowid, bin
      ),
      ranked AS (
        SELECT set_int_id, bin, cnt,
               ROW_NUMBER() OVER (PARTITION BY set_int_id ORDER BY cnt DESC) AS rn
        FROM set_century_counts
      )
      SELECT set_int_id, bin, cnt
      FROM ranked WHERE rn <= 2
      ORDER BY set_int_id, cnt DESC
    `).all(collectionSetFieldId) as { set_int_id: number; bin: number; cnt: number }[];
    const centuriesById = new Map<number, { century: string; count: number }[]>();
    for (const r of centuryRows) {
      const arr = centuriesById.get(r.set_int_id) ?? [];
      arr.push({ century: `${r.bin}s`, count: r.cnt });
      centuriesById.set(r.set_int_id, arr);
    }

    // Assemble cache
    this.curatedSetsCache = new Map();
    for (const s of sets) {
      const memberCount = memberById.get(s.set_int_id) ?? 0;
      const dominantTypes = typesById.get(s.set_int_id) ?? [];
      const dominantCenturies = centuriesById.get(s.set_int_id) ?? [];
      const category = this.classifySetCategory(s.name, memberCount, dominantTypes);
      this.curatedSetsCache.set(s.set_spec, {
        setSpec: s.set_spec,
        name: s.name,
        lodUri: `https://id.rijksmuseum.nl/${s.set_spec}`,
        memberCount,
        dominantTypes,
        dominantCenturies,
        category,
      });
    }
    console.error(`  Curated sets cache: ${this.curatedSetsCache.size} sets in ${Date.now() - t0}ms`);
  }

  listCuratedSets(opts: CuratedSetsQuery = {}): {
    totalSets: number;
    filteredFrom?: number;
    query?: string;
    sets: Array<Omit<CuratedSetMeta, "memberCount" | "dominantTypes" | "dominantCenturies" | "category"> & Partial<Pick<CuratedSetMeta, "memberCount" | "dominantTypes" | "dominantCenturies" | "category">>>;
  } {
    this.ensureCuratedSetsCache();
    const cache = this.curatedSetsCache!;
    const includeStats = opts.includeStats ?? true;

    let entries = Array.from(cache.values());
    const allCount = entries.length;
    const q = opts.query?.toLowerCase();
    if (q) entries = entries.filter(s => s.name.toLowerCase().includes(q));
    if (opts.minMembers != null) entries = entries.filter(s => s.memberCount >= opts.minMembers!);
    if (opts.maxMembers != null) entries = entries.filter(s => s.memberCount <= opts.maxMembers!);

    const sortBy = opts.sortBy ?? "name";
    if (sortBy === "name") {
      entries.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === "size") {
      entries.sort((a, b) => a.memberCount - b.memberCount);
    } else {
      entries.sort((a, b) => b.memberCount - a.memberCount);
    }

    const sets = entries.map(s => includeStats
      ? { ...s }
      : { setSpec: s.setSpec, name: s.name, lodUri: s.lodUri });

    const filtered = q != null || opts.minMembers != null || opts.maxMembers != null;
    return {
      totalSets: sets.length,
      ...(filtered ? { filteredFrom: allCount, query: opts.query } : {}),
      sets,
    };
  }

  /** Page through a curated set's members (used by browse_set).
   *  Pure single-SELECT projection from the artworks table — no extra JOINs
   *  for type/material/subjects (callers requiring those should follow up
   *  with get_artwork_details on the objectNumber).
   *  Reuses `memberCount` from the curated-sets cache, avoiding a per-page
   *  COUNT(DISTINCT) scan over all collection_set mappings. */
  browseSet(
    setSpec: string, maxResults: number, offset: number,
  ): { records: BrowseSetRecord[]; totalInSet: number } {
    if (!this.db) return { records: [], totalInSet: 0 };
    const collectionSetFieldId = this.requireFieldId("collection_set");

    if (!this.stmtBrowseSetLookup) {
      this.stmtBrowseSetLookup = this.db.prepare(
        "SELECT vocab_int_id FROM vocabulary WHERE id = ? AND type = 'set'",
      );
    }
    const setRow = this.stmtBrowseSetLookup.get(setSpec) as { vocab_int_id: number } | undefined;
    if (!setRow) return { records: [], totalInSet: 0 };

    let totalInSet: number;
    this.ensureCuratedSetsCache();
    const cached = this.curatedSetsCache?.get(setSpec);
    if (cached) {
      totalInSet = cached.memberCount;
    } else {
      if (!this.stmtBrowseSetCount) {
        this.stmtBrowseSetCount = this.db.prepare(
          "SELECT COUNT(DISTINCT artwork_id) AS n FROM mappings WHERE field_id = ? AND vocab_rowid = ?",
        );
      }
      totalInSet = (this.stmtBrowseSetCount.get(collectionSetFieldId, setRow.vocab_int_id) as { n: number }).n;
    }
    if (totalInSet === 0) return { records: [], totalInSet: 0 };

    if (!this.stmtBrowseSetPage) {
      this.stmtBrowseSetPage = this.db.prepare(`
        SELECT a.art_id, a.object_number, a.title, a.title_all_text, a.creator_label,
               a.date_earliest, a.date_latest, a.date_display,
               a.iiif_id, a.has_image, a.description_text, a.extent_text, a.record_modified
        FROM mappings m
        JOIN artworks a ON a.art_id = m.artwork_id
        WHERE m.field_id = ? AND m.vocab_rowid = ?
        ORDER BY a.object_number
        LIMIT ? OFFSET ?
      `);
    }
    const rows = this.stmtBrowseSetPage.all(
      collectionSetFieldId, setRow.vocab_int_id, maxResults, offset,
    ) as Array<{
      art_id: number; object_number: string; title: string | null; title_all_text: string | null;
      creator_label: string | null; date_earliest: number | null; date_latest: number | null;
      date_display: string | null; iiif_id: string | null; has_image: number;
      description_text: string | null; extent_text: string | null; record_modified: string | null;
    }>;

    const records: BrowseSetRecord[] = rows.map(r => {
      const hasImage = r.has_image === 1;
      const iiifId = r.iiif_id ?? undefined;
      return {
        objectNumber: r.object_number,
        title: VocabularyDb.resolveTitle(r.title, r.title_all_text, "Untitled"),
        creator: r.creator_label ?? "",
        date: r.date_display ?? formatDateRange(r.date_earliest, r.date_latest) ?? "",
        ...(r.description_text && { description: r.description_text }),
        ...(r.extent_text && { dimensions: r.extent_text }),
        ...(r.record_modified && { datestamp: r.record_modified }),
        hasImage,
        ...(iiifId && {
          imageUrl: `${VocabularyDb.IIIF_BASE}/${iiifId}/full/!1024,1024/0/default.jpg`,
          iiifServiceUrl: `${VocabularyDb.IIIF_BASE}/${iiifId}/info.json`,
        }),
        ...(hasImage && { edmType: "IMAGE" }),
        lodUri: `https://id.rijksmuseum.nl/${r.art_id}`,
        url: `https://www.rijksmuseum.nl/en/collection/${r.object_number}`,
      };
    });

    return { records, totalInSet };
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

  /** Emit `a.<col>` if `artworks.<col>` exists, else `NULL AS <col>`. Lets stmtArtworkRow open against older harvest schemas. */
  private detailColExpr(col: string): string {
    return this.columnExists("artworks", col) ? `a.${col}` : `NULL AS ${col}`;
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
   * Search persons (artists, depicted figures, donors, …) by demographic and
   * structural criteria. Returns vocab IDs that can be passed to
   * search_artwork({creator: <vocabId>}) for works by them, or to
   * search_artwork({aboutActor: <name>}) for works depicting them.
   *
   * Filter behaviour:
   *  - `name`: phrase match on person_names_fts, with token-AND fallback (BM25 ranked).
   *  - `birthPlace` / `deathPlace` / `profession`: pivot through the creator field —
   *    matches persons who have ≥1 artwork whose denormalised birth_place /
   *    death_place / profession mapping points at the named vocab term. Multi-value AND.
   *  - `gender`, `bornAfter`, `bornBefore`: column predicates against vocabulary.
   *    These return zero rows on a DB without person enrichment (NULL columns).
   *  - `hasArtworks` (default true): restrict to persons appearing as creator
   *    on ≥1 artwork.
   *
   * Ranking: BM25 order from person_names_fts when `name` is supplied, else
   * artworkCount DESC then label COLLATE NOCASE.
   *
   * Note on the v0.26 schema: birth_place / death_place / profession mappings
   * are denormalised onto the artwork (mappings.artwork_id is always an artwork
   * art_id). We resolve "person born in X" as "person whose creator-mapped
   * artwork has birth_place=X" — semantically equivalent in practice because
   * an artist's birth_place is constant across their works.
   */
  searchPersons(params: PersonSearchParams): PersonSearchResult {
    if (!this.db) return { totalResults: 0, persons: [] };

    const warnings: string[] = [];
    const limit = Math.min(params.maxResults ?? 25, 100);
    const offset = params.offset ?? 0;
    const hasArtworks = params.hasArtworks !== false; // default true

    const creatorFieldId = this.fieldIdMap.get("creator");
    const birthPlaceFieldId = this.fieldIdMap.get("birth_place");
    const deathPlaceFieldId = this.fieldIdMap.get("death_place");
    const professionFieldId = this.fieldIdMap.get("profession");

    // Step 1: resolve candidate person ids via FTS + mappings (artwork-pivot).
    let candidateIds: Set<string> | null = null;
    let nameOrder: Map<string, number> | null = null;

    if (params.name && this.hasPersonNames) {
      const ids = this.findPersonIdsFts(params.name);
      if (ids.length === 0) return { totalResults: 0, persons: [] };
      candidateIds = new Set(ids);
      nameOrder = new Map(ids.map((id, i) => [id, i]));
    }

    const intersect = (next: string[]): boolean => {
      if (next.length === 0) {
        candidateIds = new Set();
        return false;
      }
      if (candidateIds === null) {
        candidateIds = new Set(next);
      } else {
        const nextSet = new Set(next);
        candidateIds = new Set([...candidateIds].filter(id => nextSet.has(id)));
      }
      return candidateIds.size > 0;
    };

    /** Pivot: persons whose creator-mapped artworks share a denormalised attribute. */
    const personsByDenormAttr = (
      attrFieldId: number,
      attrVocabRowids: number[],
    ): string[] => {
      if (creatorFieldId === undefined || attrVocabRowids.length === 0) return [];
      const ph = attrVocabRowids.map(() => "?").join(", ");
      const rows = this.db!.prepare(
        `SELECT DISTINCT cv.id AS person_id
         FROM mappings cm
         JOIN vocabulary cv ON cv.vocab_int_id = cm.vocab_rowid AND cv.type = 'person'
         WHERE cm.field_id = ?
           AND cm.artwork_id IN (
             SELECT artwork_id FROM mappings
             WHERE field_id = ? AND vocab_rowid IN (${ph})
           )`
      ).all(creatorFieldId, attrFieldId, ...attrVocabRowids) as { person_id: string }[];
      return rows.map(r => r.person_id);
    };

    const applyVocabAttrFilter = (
      rawValue: StringOrArray,
      attrFieldId: number | undefined,
      vocabType: string,
    ): boolean => {
      if (attrFieldId === undefined) return false;
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const value of values) {
        const vocabIds = this.findVocabIdsFts(String(value), " AND type = ?", [vocabType]);
        if (vocabIds.length === 0) {
          intersect([]);
          return false;
        }
        const rowids = this.vocabIdsToRowids(vocabIds);
        const persons = personsByDenormAttr(attrFieldId, rowids);
        if (!intersect(persons)) return false;
      }
      return true;
    };

    if (params.birthPlace) {
      if (!applyVocabAttrFilter(params.birthPlace, birthPlaceFieldId, "place")) {
        return { totalResults: 0, persons: [], ...(warnings.length && { warnings }) };
      }
    }
    if (params.deathPlace) {
      if (!applyVocabAttrFilter(params.deathPlace, deathPlaceFieldId, "place")) {
        return { totalResults: 0, persons: [], ...(warnings.length && { warnings }) };
      }
    }
    if (params.profession) {
      if (!applyVocabAttrFilter(params.profession, professionFieldId, "classification")) {
        return { totalResults: 0, persons: [], ...(warnings.length && { warnings }) };
      }
    }

    // Step 2: build SQL on the candidate set + column filters + hasArtworks.
    const conditions: string[] = ["v.type = 'person'"];
    const bindings: unknown[] = [];

    if (candidateIds !== null) {
      const idsArr = Array.from(candidateIds);
      if (idsArr.length === 0) return { totalResults: 0, persons: [], ...(warnings.length && { warnings }) };
      // Stay under SQLite default variable limit (999) by chunking via a temp table.
      if (idsArr.length > 900) {
        // For very large candidate sets, fall back to using a subquery with chunked
        // INSERTs into a temp table — but this is rare for person search.
        warnings.push(`Candidate set (${idsArr.length}) clipped to first 900 by ranking.`);
        idsArr.length = 900;
      }
      const ph = idsArr.map(() => "?").join(", ");
      conditions.push(`v.id IN (${ph})`);
      bindings.push(...idsArr);
    }

    if (params.gender) {
      conditions.push("v.gender = ?");
      bindings.push(params.gender);
    }
    if (params.bornAfter != null) {
      conditions.push("v.birth_year >= ?");
      bindings.push(params.bornAfter);
    }
    if (params.bornBefore != null) {
      conditions.push("v.birth_year <= ?");
      bindings.push(params.bornBefore);
    }

    if (hasArtworks && creatorFieldId !== undefined) {
      conditions.push(
        `EXISTS (SELECT 1 FROM mappings m WHERE m.field_id = ? AND m.vocab_rowid = v.vocab_int_id)`
      );
      bindings.push(creatorFieldId);
    }

    const where = conditions.join(" AND ");

    const totalResults = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM vocabulary v WHERE ${where}`
    ).get(...bindings) as { n: number }).n;

    if (totalResults === 0) {
      return { totalResults: 0, persons: [], ...(warnings.length && { warnings }) };
    }

    // Step 3: fetch the page.
    type PageRow = {
      id: string;
      vocab_int_id: number;
      label_en: string | null;
      label_nl: string | null;
      birth_year: number | null;
      death_year: number | null;
      gender: string | null;
      wikidata_id: string | null;
    };
    const baseColumns =
      `v.id, v.vocab_int_id, v.label_en, v.label_nl, v.birth_year, v.death_year, v.gender, v.wikidata_id`;

    let pageRows: PageRow[];
    if (nameOrder) {
      // FTS-rank order requires sorting in JS. Defer per-row artworkCount to a
      // single page-only batch below — for broad name searches the candidate
      // set can be 10K+ persons, and a correlated subquery per row is wasteful
      // when only ~25 are returned.
      const allRows = this.db.prepare(
        `SELECT ${baseColumns} FROM vocabulary v WHERE ${where}`
      ).all(...bindings) as PageRow[];
      allRows.sort((a, b) => (nameOrder!.get(a.id) ?? 0) - (nameOrder!.get(b.id) ?? 0));
      pageRows = allRows.slice(offset, offset + limit);
    } else {
      // No name FTS — order by artworkCount in SQL (no JS post-processing needed).
      const artworkCountSql = creatorFieldId !== undefined
        ? `(SELECT COUNT(*) FROM mappings mc WHERE mc.field_id = ${creatorFieldId} AND mc.vocab_rowid = v.vocab_int_id)`
        : "0";
      pageRows = this.db.prepare(
        `SELECT ${baseColumns}, ${artworkCountSql} AS artwork_count
         FROM vocabulary v
         WHERE ${where}
         ORDER BY artwork_count DESC, COALESCE(v.label_en, v.label_nl) COLLATE NOCASE
         LIMIT ? OFFSET ?`
      ).all(...bindings, limit, offset) as (PageRow & { artwork_count: number })[];
    }

    // Resolve artworkCount in one batch query for the page.
    const artworkCountMap = new Map<number, number>();
    if (hasArtworks && creatorFieldId !== undefined && nameOrder && pageRows.length > 0) {
      const intIds = pageRows.map(r => r.vocab_int_id);
      const ph = intIds.map(() => "?").join(", ");
      const countRows = this.db.prepare(
        `SELECT vocab_rowid, COUNT(*) AS cnt FROM mappings
         WHERE field_id = ? AND vocab_rowid IN (${ph})
         GROUP BY vocab_rowid`
      ).all(creatorFieldId, ...intIds) as { vocab_rowid: number; cnt: number }[];
      for (const r of countRows) artworkCountMap.set(r.vocab_rowid, r.cnt);
    }

    const persons: PersonResult[] = pageRows.map(r => {
      const artworkCount = nameOrder
        ? (artworkCountMap.get(r.vocab_int_id) ?? 0)
        : (r as PageRow & { artwork_count: number }).artwork_count;
      return {
        vocabId: r.id,
        label: r.label_en ?? r.label_nl ?? r.id,
        labelEn: r.label_en,
        labelNl: r.label_nl,
        birthYear: r.birth_year,
        deathYear: r.death_year,
        gender: r.gender,
        ...(hasArtworks && { artworkCount }),
        wikidataId: r.wikidata_id,
      };
    });

    return {
      totalResults,
      persons,
      ...(warnings.length && { warnings }),
    };
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
    facetLimit = 5,
  ): Record<string, Array<{ label: string; count: number }>> {
    if (!this.db) return {};
    const result: Record<string, Array<{ label: string; count: number }>> = {};
    const limit = Math.max(1, Math.min(facetLimit, 50));

    const where = conditions.length > 0 ? conditions.join(" AND ") : "1";
    const allBindings = ftsJoinBinding != null ? [ftsJoinBinding, ...bindings] : [...bindings];

    for (const facetDef of VOCAB_DIMENSION_DEFS) {
      if (!requestedFields.has(facetDef.label)) continue;
      const fieldId = this.fieldIdMap.get(facetDef.field);
      if (fieldId === undefined) continue;
      const typeFilter = facetDef.vocabType ? ` AND v.type = '${facetDef.vocabType}'` : "";
      // Suppress areal regions (continents, oceans, empires) from place-typed facets — their
      // recorded coordinates are meaningless centroids and they pollute "what places appear" rollups.
      const arealFilter = facetDef.vocabType === "place" ? " AND v.is_areal IS NOT 1" : "";
      // fieldId binding must come after ftsJoinBinding (if any) but before WHERE bindings,
      // matching the positional order of ? in the SQL: JOIN fts... JOIN fm.field_id=? WHERE ...
      const facetBindings = ftsJoinBinding != null
        ? [ftsJoinBinding, fieldId, ...bindings, limit]
        : [fieldId, ...bindings, limit];
      const sql =
        `SELECT COALESCE(v.label_en, v.label_nl) AS label, COUNT(DISTINCT fm.artwork_id) AS cnt ` +
        `FROM artworks a ${ftsJoinClause} ` +
        `JOIN mappings fm ON fm.artwork_id = a.art_id AND +fm.field_id = ? ` +
        `JOIN vocabulary v ON fm.vocab_rowid = v.vocab_int_id ` +
        `WHERE ${where} AND v.label_en IS NOT NULL${typeFilter}${arealFilter} ` +
        `GROUP BY label ORDER BY cnt DESC LIMIT ?`;
      const rows = this.db.prepare(sql).all(...facetBindings) as { label: string; cnt: number }[];
      if (rows.length > 0) {
        result[facetDef.label] = rows.map(r => ({ label: r.label, count: r.cnt }));
      }
    }

    // Theme facet — special-cased (not in VOCAB_DIMENSION_DEFS) because most theme rows
    // lack label_en. Falls back to NL via COALESCE in both SELECT and WHERE.
    if (requestedFields.has("theme")) {
      const themeFieldId = this.fieldIdMap.get("theme");
      if (themeFieldId !== undefined) {
        const facetBindings = ftsJoinBinding != null
          ? [ftsJoinBinding, themeFieldId, ...bindings, limit]
          : [themeFieldId, ...bindings, limit];
        const sql =
          `SELECT COALESCE(v.label_en, v.label_nl) AS label, COUNT(DISTINCT fm.artwork_id) AS cnt ` +
          `FROM artworks a ${ftsJoinClause} ` +
          `JOIN mappings fm ON fm.artwork_id = a.art_id AND +fm.field_id = ? ` +
          `JOIN vocabulary v ON fm.vocab_rowid = v.vocab_int_id ` +
          `WHERE ${where} AND (v.label_en IS NOT NULL OR v.label_nl IS NOT NULL) ` +
          `GROUP BY label ORDER BY cnt DESC LIMIT ?`;
        const rows = this.db.prepare(sql).all(...facetBindings) as { label: string; cnt: number }[];
        if (rows.length > 0) {
          result["theme"] = rows.map(r => ({ label: r.label, count: r.cnt }));
        }
      }
    }

    // Century facet (computed from date_earliest)
    if (requestedFields.has("century") && this.hasDates) {
      const sql =
        `SELECT (CASE WHEN a.date_earliest >= 0 THEN (a.date_earliest / 100 + 1) ELSE -((-a.date_earliest - 1) / 100 + 1) END) AS century, ` +
        `COUNT(*) AS cnt ` +
        `FROM artworks a ${ftsJoinClause} ` +
        `WHERE ${where} AND a.date_earliest IS NOT NULL ` +
        `GROUP BY century ORDER BY cnt DESC LIMIT ?`;
      const rows = this.db.prepare(sql).all(...allBindings, limit) as { century: number; cnt: number }[];
      if (rows.length > 0) {
        result["century"] = rows.map(r => ({
          label: r.century > 0 ? `${ordinal(r.century)} century` : `${ordinal(-r.century)} century BCE`,
          count: r.cnt,
        }));
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

  /** Compute provenance facets over matching events. Uses a CTE to avoid redundant JOINs. */
  private computeProvenanceFacets(
    conditions: string[],
    bindings: unknown[],
  ): Record<string, Array<{ label: string; count: number }>> {
    if (!this.db || !this.hasProvenanceTables_) return {};
    const result: Record<string, Array<{ label: string; count: number }>> = {};
    const where = conditions.length > 0 ? conditions.join(" AND ") : "1";

    // Single CTE materialises the matched event set; all facets read from it.
    const cte = `WITH matched AS (
      SELECT pe.artwork_id, pe.sequence, pe.transfer_type, pe.date_year, pe.location, pe.transfer_category
      FROM provenance_events pe JOIN artworks a ON a.art_id = pe.artwork_id
      WHERE ${where}
    )`;

    // Single query: all facets in one UNION ALL so the CTE is evaluated once.
    // Party branch uses EXISTS with sequence to restrict to parties on matched events (#194).
    const partyBranch = this.hasPartyTable_
      ? `UNION ALL
      SELECT 'partyPosition', pp.party_position, COUNT(DISTINCT pp.artwork_id)
      FROM provenance_parties pp
      WHERE EXISTS (SELECT 1 FROM matched m WHERE m.artwork_id = pp.artwork_id AND m.sequence = pp.sequence)
        AND pp.party_position IS NOT NULL
      GROUP BY pp.party_position`
      : "";

    const unionRows = this.db.prepare(`${cte}
      SELECT 'transferType' AS facet, transfer_type AS label, COUNT(DISTINCT artwork_id) AS cnt
      FROM matched GROUP BY transfer_type
      UNION ALL
      SELECT 'decade', CAST((date_year / 10) * 10 AS TEXT), COUNT(DISTINCT artwork_id)
      FROM matched WHERE date_year IS NOT NULL GROUP BY (date_year / 10) * 10
      UNION ALL
      SELECT 'location', location, COUNT(DISTINCT artwork_id)
      FROM matched WHERE location IS NOT NULL GROUP BY location
      UNION ALL
      SELECT 'transferCategory', transfer_category, COUNT(DISTINCT artwork_id)
      FROM matched WHERE transfer_category IS NOT NULL GROUP BY transfer_category
      ${partyBranch}
    `).all(...bindings) as { facet: string; label: string; cnt: number }[];

    for (const row of unionRows) {
      if (!result[row.facet]) result[row.facet] = [];
      result[row.facet].push({ label: row.facet === "decade" ? `${row.label}s` : row.label, count: row.cnt });
    }
    // Sort: decade chronologically, others by count desc; limit location to top 20
    for (const [key, entries] of Object.entries(result)) {
      entries.sort(key === "decade" ? (a, b) => a.label.localeCompare(b.label) : (a, b) => b.count - a.count);
    }
    if (result["location"]?.length > 20) result["location"] = result["location"].slice(0, 20);

    return result;
  }

  // ── Collection-wide stats ─────────────────────────────────────────

  /** Artwork-domain dimensions: count artworks grouped by a vocab field or date.
   *  `ordering` selects ORDER BY: "count_desc" → cnt DESC, "label_asc" → label. */
  private artworkDimensionSql(
    dim: string, topN: number, offset: number, binWidth: number,
    ordering: "count_desc" | "label_asc",
  ): { sql: string; extraBindings: unknown[] } | null {
    const orderBy = ordering === "count_desc" ? "cnt DESC" : "label";
    const vocabDef = VOCAB_DIMENSION_DEFS.find(d => d.label === dim);
    if (vocabDef) {
      const fieldId = this.fieldIdMap.get(vocabDef.field);
      if (fieldId === undefined) return null;
      const typeFilter = vocabDef.vocabType ? ` AND v.type = '${vocabDef.vocabType}'` : "";
      // Suppress areal regions (continents, oceans, empires) from place-typed dimensions —
      // their meaningless centroid coords would otherwise dominate top-N place rollups.
      const arealFilter = vocabDef.vocabType === "place" ? " AND v.is_areal IS NOT 1" : "";
      return {
        sql: `SELECT COALESCE(v.label_en, v.label_nl) AS label, COUNT(DISTINCT m.artwork_id) AS cnt
          FROM mappings m
          JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
          WHERE +m.field_id = ? AND v.label_en IS NOT NULL${typeFilter}${arealFilter}
          AND m.artwork_id IN (SELECT art_id FROM _stats_artworks)
          GROUP BY label ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        extraBindings: [fieldId, topN, offset],
      };
    }

    if (dim === "century") {
      return {
        sql: `SELECT (CASE WHEN a.date_earliest >= 0 THEN (a.date_earliest / 100 + 1) * 100 - 100
                ELSE -((-a.date_earliest - 1) / 100 + 1) * 100 END) AS label,
              COUNT(*) AS cnt
          FROM _stats_artworks sa JOIN artworks a ON a.art_id = sa.art_id
          WHERE a.date_earliest IS NOT NULL
          GROUP BY label ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        extraBindings: [topN, offset],
      };
    }

    if (dim === "decade") {
      return {
        sql: `SELECT (a.date_earliest / ?) * ? AS label, COUNT(*) AS cnt
          FROM _stats_artworks sa JOIN artworks a ON a.art_id = sa.art_id
          WHERE a.date_earliest IS NOT NULL
          GROUP BY label ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        extraBindings: [binWidth, binWidth, topN, offset],
      };
    }

    // Physical dimension binning (cm) — excludes 0.0 sentinels
    const dimCol = dim === "height" ? "a.height_cm" : dim === "width" ? "a.width_cm" : null;
    if (dimCol && this.hasDimensions) {
      return {
        sql: `SELECT CAST((${dimCol} / ?) * ? AS INTEGER) AS label, COUNT(*) AS cnt
          FROM _stats_artworks sa JOIN artworks a ON a.art_id = sa.art_id
          WHERE ${dimCol} > 0
          GROUP BY label ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        extraBindings: [binWidth, binWidth, topN, offset],
      };
    }

    // Theme vocab — special-cased (not in VOCAB_DIMENSION_DEFS) because most theme rows lack
    // label_en (~14% EN coverage). Falls back to NL via COALESCE in both SELECT and WHERE.
    if (dim === "theme") {
      const fieldId = this.fieldIdMap.get("theme");
      if (fieldId === undefined) return null;
      return {
        sql: `SELECT COALESCE(v.label_en, v.label_nl) AS label, COUNT(DISTINCT m.artwork_id) AS cnt
          FROM mappings m
          JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
          WHERE +m.field_id = ? AND (v.label_en IS NOT NULL OR v.label_nl IS NOT NULL)
            AND m.artwork_id IN (SELECT art_id FROM _stats_artworks)
          GROUP BY label ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        extraBindings: [fieldId, topN, offset],
      };
    }

    // Exhibitions — JOINs through artwork_exhibitions, no vocab table involved.
    if (dim === "exhibition") {
      return {
        sql: `SELECT COALESCE(e.title_en, e.title_nl) AS label, COUNT(*) AS cnt
          FROM artwork_exhibitions ae
          JOIN exhibitions e ON e.exhibition_id = ae.exhibition_id
          WHERE ae.art_id IN (SELECT art_id FROM _stats_artworks)
            AND (e.title_en IS NOT NULL OR e.title_nl IS NOT NULL)
          GROUP BY ae.exhibition_id ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        extraBindings: [topN, offset],
      };
    }

    // record_modified bucketed by decade. Filter to 1990–2030 — the column has sentinel
    // values spanning year 0001 → 2107 that would otherwise produce bogus tail buckets.
    if (dim === "decadeModified") {
      return {
        sql: `SELECT (CAST(SUBSTR(a.record_modified, 1, 4) AS INTEGER) / 10) * 10 AS label,
              COUNT(*) AS cnt
          FROM _stats_artworks sa JOIN artworks a ON a.art_id = sa.art_id
          WHERE a.record_modified IS NOT NULL
            AND a.record_modified >= '1990-01-01'
            AND a.record_modified <  '2030-01-01'
          GROUP BY label ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        extraBindings: [topN, offset],
      };
    }

    return null;
  }

  /** Provenance-domain dimensions: count artworks grouped by event/party attribute.
   *  eventConditions/partyConditions filter at the row level so that only matching
   *  events/parties contribute to the dimension counts (not all events for matching artworks).
   *  `ordering` selects ORDER BY: "count_desc" → cnt DESC, "label_asc" → label. */
  private provenanceDimensionSql(
    dim: string, topN: number, offset: number, binWidth: number,
    ordering: "count_desc" | "label_asc",
    eventConditions?: { conds: string[]; bindings: unknown[] },
    partyConditions?: { conds: string[]; bindings: unknown[] },
  ): { sql: string; extraBindings: unknown[] } | null {
    if (!this.hasProvenanceTables_) return null;
    const orderBy = ordering === "count_desc" ? "cnt DESC" : "label";

    // Build event-level WHERE fragment
    const evExtra = eventConditions?.conds.length
      ? " AND " + eventConditions.conds.join(" AND ")
      : "";
    const evBindings = eventConditions?.bindings ?? [];

    // Build party-level WHERE fragment
    const ppExtra = partyConditions?.conds.length
      ? " AND " + partyConditions.conds.join(" AND ")
      : "";
    const ppBindings = partyConditions?.bindings ?? [];

    // Special case: provenanceDecade uses arithmetic binning
    if (dim === "provenanceDecade") {
      return {
        sql: `SELECT (pe.date_year / ?) * ? AS label, COUNT(DISTINCT pe.artwork_id) AS cnt
          FROM provenance_events pe
          WHERE pe.artwork_id IN (SELECT art_id FROM _stats_artworks)
            AND pe.date_year IS NOT NULL${evExtra}
          GROUP BY label ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        extraBindings: [binWidth, binWidth, ...evBindings, topN, offset],
      };
    }

    // Data-driven lookup for all other provenance dimensions
    const def = PROV_DIMENSION_DEFS.find(d => d.label === dim);
    if (!def) return null;
    if (def.table === "parties" && !this.hasPartyTable_) return null;

    const tbl = def.table === "events" ? "provenance_events" : "provenance_parties";
    const alias = def.table === "events" ? "pe" : "pp";
    const notNull = def.notNull ? `AND ${alias}.${def.col} IS NOT NULL` : "";
    const rowFilter = def.table === "events" ? evExtra : ppExtra;
    const rowBindings = def.table === "events" ? evBindings : ppBindings;

    return {
      sql: `SELECT ${alias}.${def.col} AS label, COUNT(DISTINCT ${alias}.artwork_id) AS cnt
        FROM ${tbl} ${alias}
        WHERE ${alias}.artwork_id IN (SELECT art_id FROM _stats_artworks)
          ${notNull}${rowFilter}
        GROUP BY ${alias}.${def.col} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      extraBindings: [...rowBindings, topN, offset],
    };
  }

  /** Coverage count: artworks in the filtered pool that have ≥1 value for the given dimension.
   *  Used to populate the structured-output `coverage.withBucket` field, which lets a consumer
   *  reconstruct the residual to 100% without per-dim NULL knowledge. */
  private dimensionCoverageCount(
    dim: string,
    eventConditions?: { conds: string[]; bindings: unknown[] },
    partyConditions?: { conds: string[]; bindings: unknown[] },
  ): number {
    if (!this.db) return 0;
    const evExtra = eventConditions?.conds.length ? " AND " + eventConditions.conds.join(" AND ") : "";
    const evBindings = eventConditions?.bindings ?? [];
    const ppExtra = partyConditions?.conds.length ? " AND " + partyConditions.conds.join(" AND ") : "";
    const ppBindings = partyConditions?.bindings ?? [];

    // Vocab-backed dim: count artworks with ≥1 mapping for this field.
    const vocabDef = VOCAB_DIMENSION_DEFS.find(d => d.label === dim);
    if (vocabDef) {
      const fieldId = this.fieldIdMap.get(vocabDef.field);
      if (fieldId === undefined) return 0;
      const typeFilter = vocabDef.vocabType ? ` AND v.type = '${vocabDef.vocabType}'` : "";
      const arealFilter = vocabDef.vocabType === "place" ? " AND v.is_areal IS NOT 1" : "";
      const row = this.db.prepare(
        `SELECT COUNT(DISTINCT m.artwork_id) AS cnt FROM mappings m
         JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
         WHERE +m.field_id = ? AND v.label_en IS NOT NULL${typeFilter}${arealFilter}
           AND m.artwork_id IN (SELECT art_id FROM _stats_artworks)`,
      ).get(fieldId) as { cnt: number };
      return row.cnt;
    }

    if (dim === "century" || dim === "decade") {
      const row = this.db.prepare(
        `SELECT COUNT(*) AS cnt FROM _stats_artworks sa JOIN artworks a ON a.art_id = sa.art_id
         WHERE a.date_earliest IS NOT NULL`,
      ).get() as { cnt: number };
      return row.cnt;
    }

    if ((dim === "height" || dim === "width") && this.hasDimensions) {
      const col = dim === "height" ? "a.height_cm" : "a.width_cm";
      const row = this.db.prepare(
        `SELECT COUNT(*) AS cnt FROM _stats_artworks sa JOIN artworks a ON a.art_id = sa.art_id
         WHERE ${col} > 0`,
      ).get() as { cnt: number };
      return row.cnt;
    }

    if (dim === "theme") {
      const fieldId = this.fieldIdMap.get("theme");
      if (fieldId === undefined) return 0;
      const row = this.db.prepare(
        `SELECT COUNT(DISTINCT m.artwork_id) AS cnt FROM mappings m
         JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
         WHERE +m.field_id = ? AND (v.label_en IS NOT NULL OR v.label_nl IS NOT NULL)
           AND m.artwork_id IN (SELECT art_id FROM _stats_artworks)`,
      ).get(fieldId) as { cnt: number };
      return row.cnt;
    }

    if (dim === "exhibition") {
      const row = this.db.prepare(
        `SELECT COUNT(DISTINCT ae.art_id) AS cnt FROM artwork_exhibitions ae
         JOIN exhibitions e ON e.exhibition_id = ae.exhibition_id
         WHERE ae.art_id IN (SELECT art_id FROM _stats_artworks)
           AND (e.title_en IS NOT NULL OR e.title_nl IS NOT NULL)`,
      ).get() as { cnt: number };
      return row.cnt;
    }

    if (dim === "decadeModified") {
      const row = this.db.prepare(
        `SELECT COUNT(*) AS cnt FROM _stats_artworks sa JOIN artworks a ON a.art_id = sa.art_id
         WHERE a.record_modified IS NOT NULL
           AND a.record_modified >= '1990-01-01'
           AND a.record_modified <  '2030-01-01'`,
      ).get() as { cnt: number };
      return row.cnt;
    }

    if (!this.hasProvenanceTables_) return 0;

    if (dim === "provenanceDecade") {
      const row = this.db.prepare(
        `SELECT COUNT(DISTINCT pe.artwork_id) AS cnt FROM provenance_events pe
         WHERE pe.artwork_id IN (SELECT art_id FROM _stats_artworks)
           AND pe.date_year IS NOT NULL${evExtra}`,
      ).get(...evBindings) as { cnt: number };
      return row.cnt;
    }

    const def = PROV_DIMENSION_DEFS.find(d => d.label === dim);
    if (!def) return 0;
    if (def.table === "parties" && !this.hasPartyTable_) return 0;

    const tbl = def.table === "events" ? "provenance_events" : "provenance_parties";
    const alias = def.table === "events" ? "pe" : "pp";
    const notNull = def.notNull ? `AND ${alias}.${def.col} IS NOT NULL` : "";
    const rowFilter = def.table === "events" ? evExtra : ppExtra;
    const rowBindings = def.table === "events" ? evBindings : ppBindings;
    const row = this.db.prepare(
      `SELECT COUNT(DISTINCT ${alias}.artwork_id) AS cnt FROM ${tbl} ${alias}
       WHERE ${alias}.artwork_id IN (SELECT art_id FROM _stats_artworks)
         ${notNull}${rowFilter}`,
    ).get(...rowBindings) as { cnt: number };
    return row.cnt;
  }

  /** Echo of accepted filter args for round-trip in structuredContent. Excludes control params. */
  private buildAppliedFilters(params: CollectionStatsParams): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const keys: (keyof CollectionStatsParams)[] = [
      "type", "material", "technique", "creator", "productionPlace",
      "depictedPerson", "depictedPlace", "subject", "iconclass",
      "collectionSet", "theme", "sourceType", "imageAvailable",
      "creationDateFrom", "creationDateTo",
      "hasProvenance", "transferType", "provenanceLocation", "party",
      "provenanceDateFrom", "provenanceDateTo", "categoryMethod", "positionMethod",
    ];
    for (const k of keys) {
      const v = params[k];
      if (v != null) out[k] = v;
    }
    return out;
  }

  computeCollectionStats(params: CollectionStatsParams): CollectionStatsResult {
    // Resolve dim metadata once — drives structured-output fields + default ordering.
    const meta = STATS_DIMENSION_META[params.dimension];
    const groupingKey = meta?.groupingKey ?? "label";
    const multiValued = meta?.multiValued ?? false;
    const ordering: "count_desc" | "label_asc" =
      params.sortBy === "count" ? "count_desc" :
      params.sortBy === "label" ? "label_asc" :
      meta?.defaultOrdering ?? "count_desc";
    const appliedFilters = this.buildAppliedFilters(params);
    const baseShape = {
      dimension: params.dimension,
      denominatorScope: "artwork" as const,
      multiValued, groupingKey, ordering,
      ...(meta?.bucketUnit && { bucketUnit: meta.bucketUnit }),
      ...(meta?.bucketDomain && { bucketDomain: meta.bucketDomain }),
      appliedFilters,
    };

    if (!this.db) {
      return { ...baseShape, total: 0, coverage: { withBucket: 0, withoutBucket: 0 }, totalBuckets: 0, offset: 0, entries: [] };
    }

    const topN = Math.min(params.topN ?? 25, 500);
    const offset = params.offset ?? 0;
    const binWidth = params.binWidth ?? 10;
    const warnings: string[] = [];

    // Build artwork filter conditions
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    // Artwork vocab filters — data-driven to avoid copy-paste.
    // Uses FTS5 when available (50-100x faster than LIKE '%...%' on 194K vocab terms).
    // All paths use the two-step subquery pattern (narrow vocab first, then index-lookup on mappings).
    for (const { key, fields, vocabType, exactNotation } of STATS_VOCAB_FILTERS) {
      const val = params[key];
      if (val == null || typeof val !== "string") continue;

      const typeClause = vocabType ? " AND type = ?" : "";
      const typeBindings: unknown[] = vocabType ? [vocabType] : [];

      if (exactNotation) {
        // Exact notation match (Iconclass codes) — two-step subquery, no FTS
        const filter = this.mappingFilterSubquery(fields, `notation = ?${typeClause}`, [val, ...typeBindings]);
        conditions.push(filter.condition);
        bindings.push(...filter.bindings);
      } else if (this.hasFts5) {
        // FTS5 path: resolve vocab IDs first, then use direct mapping filter
        const vocabIds = vocabType === "person" && this.hasPersonNames
          ? this.findPersonIdsFts(val)
          : this.findVocabIdsFts(val, typeClause, typeBindings);
        if (vocabIds.length === 0) {
          // Filter matched zero vocab terms → no artworks can match → return empty immediately
          return { ...baseShape, total: 0, coverage: { withBucket: 0, withoutBucket: 0 }, totalBuckets: 0, offset: 0, entries: [],
            warnings: [`No vocabulary matches found for ${key}="${val}". No artworks match this filter.`] };
        }
        const ftsFilter = this.mappingFilterDirect(fields, vocabIds);
        conditions.push(ftsFilter.condition);
        bindings.push(...ftsFilter.bindings);
      } else {
        // LIKE fallback — two-step subquery
        const filter = this.mappingFilterSubquery(
          fields,
          `(label_en LIKE '%' || ? || '%' COLLATE NOCASE OR label_nl LIKE '%' || ? || '%' COLLATE NOCASE)${typeClause}`,
          [val, val, ...typeBindings],
        );
        conditions.push(filter.condition);
        bindings.push(...filter.bindings);
      }
    }
    // Image availability
    if (params.imageAvailable === true && this.hasImageColumn) {
      conditions.push("a.has_image = 1");
    }
    if (params.creationDateFrom != null) {
      conditions.push("a.date_earliest >= ?");
      bindings.push(params.creationDateFrom);
    }
    if (params.creationDateTo != null) {
      conditions.push("a.date_latest <= ?");
      bindings.push(params.creationDateTo);
    }

    // Provenance-domain filters — merge event conditions into a single EXISTS to avoid N separate scans.
    // Event/party conditions are also saved for provenanceDimensionSql so dimension queries
    // filter at the row level (not just the artwork level).
    let provEventConds: { conds: string[]; bindings: unknown[] } | undefined;
    let provPartyConds: { conds: string[]; bindings: unknown[] } | undefined;
    if (this.hasProvenanceTables_) {
      const evConds: string[] = [];
      const evBindings: unknown[] = [];
      if (params.transferType) { evConds.push("pe.transfer_type = ?"); evBindings.push(params.transferType); }
      if (params.provenanceLocation) { evConds.push("pe.location LIKE '%' || ? || '%'"); evBindings.push(params.provenanceLocation); }
      if (params.provenanceDateFrom != null) { evConds.push("pe.date_year >= ?"); evBindings.push(params.provenanceDateFrom); }
      if (params.provenanceDateTo != null) { evConds.push("pe.date_year <= ?"); evBindings.push(params.provenanceDateTo); }
      if (params.categoryMethod) { evConds.push("pe.category_method = ?"); evBindings.push(params.categoryMethod); }

      if (evConds.length > 0) {
        provEventConds = { conds: evConds, bindings: evBindings };
        conditions.push(`EXISTS (SELECT 1 FROM provenance_events pe WHERE pe.artwork_id = a.art_id AND ${evConds.join(" AND ")})`);
        bindings.push(...evBindings);
      } else if (params.hasProvenance) {
        conditions.push("EXISTS (SELECT 1 FROM provenance_events WHERE artwork_id = a.art_id)");
      }

      // Party filters must compose on the same pp row — separate EXISTS clauses let party and
      // positionMethod match on different rows for the same artwork, inflating `total` beyond `entries`.
      const ppConds: string[] = [];
      const ppBindings: unknown[] = [];
      if (params.party && this.hasPartyTable_) {
        ppConds.push("pp.party_name LIKE '%' || ? || '%'");
        ppBindings.push(params.party);
      }
      if (params.positionMethod && this.hasPartyTable_) {
        ppConds.push("pp.position_method = ?");
        ppBindings.push(params.positionMethod);
      }
      if (ppConds.length > 0) {
        provPartyConds = { conds: ppConds, bindings: ppBindings };
        conditions.push(`EXISTS (SELECT 1 FROM provenance_parties pp WHERE pp.artwork_id = a.art_id AND ${ppConds.join(" AND ")})`);
        bindings.push(...ppBindings);
      }
    }
    const where = conditions.length > 0 ? conditions.join(" AND ") : "1";

    // Unique temp table name to avoid collisions if requests overlap
    const tableId = `_stats_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const filtered = conditions.length > 0;

    let total: number;
    if (filtered) {
      this.db.prepare(`CREATE TEMP TABLE "${tableId}" AS SELECT a.art_id FROM artworks a WHERE ${where}`)
        .run(...bindings);
      total = (this.db.prepare(`SELECT COUNT(*) AS cnt FROM "${tableId}"`).get() as { cnt: number }).cnt;
    } else {
      // Unfiltered: skip 832K-row temp table copy — use artworks directly
      total = (this.db.prepare("SELECT COUNT(*) AS cnt FROM artworks").get() as { cnt: number }).cnt;
    }

    if (total === 0) {
      if (filtered) this.db.exec(`DROP TABLE IF EXISTS "${tableId}"`);
      return { ...baseShape, total: 0, coverage: { withBucket: 0, withoutBucket: 0 }, totalBuckets: 0, offset, entries: [],
        ...(warnings.length > 0 && { warnings }) };
    }

    // _stats_artworks is referenced inside dimension SQL fragments.
    // For unfiltered queries, alias artworks directly (no temp table needed).
    // Wrap in try/finally so temp table + view are always cleaned up, even on SQL errors.
    this.db.exec(`DROP VIEW IF EXISTS _stats_artworks`);
    this.db.exec(filtered
      ? `CREATE TEMP VIEW _stats_artworks AS SELECT art_id FROM "${tableId}"`
      : `CREATE TEMP VIEW _stats_artworks AS SELECT art_id FROM artworks`);
    try {
      const dimQuery = this.artworkDimensionSql(params.dimension, topN, offset, binWidth, ordering)
        || this.provenanceDimensionSql(params.dimension, topN, offset, binWidth, ordering, provEventConds, provPartyConds);

      if (!dimQuery) {
        return {
          ...baseShape,
          total,
          coverage: { withBucket: 0, withoutBucket: total },
          totalBuckets: 0,
          offset,
          entries: [],
          warnings: [`Unknown dimension: '${params.dimension}'. Available: ${STATS_DIMENSION_NAMES.join(", ")}.`],
        };
      }

      // Run the dimension query (with LIMIT/OFFSET)
      const rows = this.db.prepare(dimQuery.sql).all(...dimQuery.extraBindings) as { label: string | number; cnt: number }[];
      const entries: StatsEntry[] = rows.map(r => ({
        label: r.label,
        count: r.cnt,
        percentage: Math.round((r.cnt / total) * 1000) / 10,
      }));

      // Count total distinct buckets (only when paging, to avoid unnecessary work)
      let totalBuckets = entries.length + offset;
      if (entries.length === topN) {
        // There may be more — run a count query (reuse the same SQL shape without LIMIT/OFFSET)
        const countSql = dimQuery.sql.replace(/\sORDER BY.*$/s, "");
        const countResult = this.db.prepare(`SELECT COUNT(*) AS cnt FROM (${countSql})`).get(
          ...dimQuery.extraBindings.slice(0, -2),  // strip topN + offset bindings
        ) as { cnt: number };
        totalBuckets = countResult.cnt;
      }

      // Coverage: artworks in the filtered pool that have ≥1 row in this dimension's source.
      // Lets a consumer reconstruct the gap to 100% on single-valued dims without per-dim
      // NULL/clamp knowledge.
      const withBucket = this.dimensionCoverageCount(params.dimension, provEventConds, provPartyConds);
      const withoutBucket = Math.max(0, total - withBucket);

      // Fixed width from meta, else binWidth for binned dims, else undefined.
      const bucketWidth = meta?.bucketWidth ?? (meta?.bucketUnit ? binWidth : undefined);

      return {
        ...baseShape,
        total,
        coverage: { withBucket, withoutBucket },
        totalBuckets,
        offset,
        entries,
        ...(bucketWidth !== undefined && { bucketWidth }),
        ...(warnings.length > 0 && { warnings }),
      };
    } finally {
      this.db.exec(`DROP VIEW IF EXISTS _stats_artworks`);
      if (filtered) this.db.exec(`DROP TABLE IF EXISTS "${tableId}"`);
    }
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

    // Tier 2: Text FTS filters (inscription, creditLine, curatorialNarrative)
    // (provenance text filter dropped in v0.27 — use search_provenance instead.)
    const TEXT_FILTERS: [keyof VocabSearchParams, string][] = [
      ["description", "description_text"],
      ["inscription", "inscription_text"],
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
          // Exclude 0.0 sentinel values (meaning "unknown") from upper-bound filters
          if (op === "<=") {
            conditions.push(`${col} > 0 AND ${col} ${op} ?`);
          } else {
            conditions.push(`${col} ${op} ?`);
          }
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
    const limit = Math.min(effective.maxResults ?? 25, INTERNAL_MAX_RESULTS_CAP);
    const userOffset = effective.offset ?? 0;

    // sortBy overrides BM25 / geo-proximity / importance defaults.
    // NULLIF on dimension columns folds the 0.0 "unknown" sentinels to NULL so
    // they fall to the end under NULLS LAST regardless of sort direction.
    const SORT_COLUMN_MAP: Record<NonNullable<VocabSearchParams["sortBy"]>, string> = {
      height: "NULLIF(a.height_cm, 0)",
      width: "NULLIF(a.width_cm, 0)",
      dateEarliest: "a.date_earliest",
      dateLatest: "a.date_latest",
      recordModified: "a.record_modified",
    };
    let sortByActive = false;
    let sortByClause = "";
    if (effective.sortBy) {
      if (effective.sortBy === "recordModified" && !this.hasRecordModified_) {
        warnings.push("sortBy: 'recordModified' requires vocabulary DB v0.27+. Sort was ignored.");
      } else if ((effective.sortBy === "height" || effective.sortBy === "width") && !this.hasDimensions) {
        warnings.push(`sortBy: '${effective.sortBy}' requires vocabulary DB v1.0+. Sort was ignored.`);
      } else {
        const expr = SORT_COLUMN_MAP[effective.sortBy];
        const dir = effective.sortOrder === "asc" ? "ASC" : "DESC";
        sortByClause = `${expr} ${dir} NULLS LAST`;
        sortByActive = true;
      }
    }

    // When geo is active and neither BM25 nor sortBy is ordering, use a larger
    // internal limit so distance ordering (applied post-query) sees the true
    // top-N nearest artworks, not just the most-important ones. Cap at 2000.
    // Always fetch limit + offset rows so post-query offset works correctly.
    const geoExpansion = geoResult && !ftsRankOrder && !sortByActive;
    const fetchLimit = geoExpansion ? Math.max((limit + userOffset) * 10, 2000) : limit + userOffset;

    // All ordering paths get a deterministic tiebreaker on a.art_id ASC so
    // pagination is stable across pages even within heavy importance ties
    // (550K+ artworks share importance=7 — see #321).
    const tiebreaker = ", a.art_id ASC";
    const orderBy = sortByActive
      ? `ORDER BY ${sortByClause}${tiebreaker}`
      : ftsRankOrder
        ? `ORDER BY fts.rank${tiebreaker}`
        : this.hasImportance
          ? `ORDER BY a.importance DESC${tiebreaker}`
          : `ORDER BY a.art_id ASC`;
    const sql = `SELECT a.object_number, a.title, a.title_all_text, a.creator_label, a.date_earliest, a.date_latest FROM artworks a ${ftsJoinClause} WHERE ${where} ${orderBy} LIMIT ?`;
    const rows = this.db.prepare(sql).all(
      ...(ftsJoinBinding != null ? [ftsJoinBinding, ...bindings, fetchLimit] : [...bindings, fetchLimit]),
    ) as {
      object_number: string;
      title: string;
      title_all_text: string | null;
      creator_label: string;
      date_earliest: number | null;
      date_latest: number | null;
    }[];

    // Compute total count only when results are truncated (rows.length === fetchLimit).
    // When results fit within the limit, rows.length IS the total — no extra scan needed.
    // Worst case (gender scans) adds ~850ms, but only when the count is informative.
    const totalResults = rows.length < fetchLimit
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

      const distSql = `SELECT a.object_number, v.label_en, v.label_nl,
                  haversine_km(?, ?, v.lat, v.lon) AS dist
           FROM mappings m
           JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
           JOIN artworks a ON m.artwork_id = a.art_id
           WHERE a.object_number IN (${objPlaceholders})
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

    // Sort by distance when geo is active and neither BM25 nor sortBy is ordering
    if (distanceMap && distanceMap.size > 0 && !ftsRankOrder && !sortByActive) {
      rows.sort((a, b) => {
        const da = distanceMap!.get(a.object_number)?.dist ?? Infinity;
        const db = distanceMap!.get(b.object_number)?.dist ?? Infinity;
        return da - db;
      });
    }

    // Apply offset then truncate to user's requested limit (post-query for geo-expansion + distance sort)
    if (userOffset > 0) rows.splice(0, userOffset);
    if (rows.length > limit) rows.splice(limit);

    // Faceted counts: compute requested dimensions when results are truncated
    let facets: Record<string, Array<{ label: string; count: number }>> | undefined;
    if (effective.facets && effective.facets.length > 0 && rows.length >= limit) {
      // Only compute requested dimensions, minus those already filtered on
      const requested = new Set(effective.facets);
      if (effective.type) requested.delete("type");
      if (effective.material) requested.delete("material");
      if (effective.technique) requested.delete("technique");
      if (effective.creationDate) requested.delete("century");
      if (effective.license) requested.delete("rights");
      if (effective.imageAvailable != null) requested.delete("imageAvailable");
      if (effective.creator) requested.delete("creator");
      if (effective.depictedPerson) requested.delete("depictedPerson");
      if (effective.depictedPlace) requested.delete("depictedPlace");
      if (effective.productionPlace) requested.delete("productionPlace");
      if (requested.size > 0) {
        facets = this.computeFacets(conditions, bindings, ftsJoinClause, ftsJoinBinding, requested, effective.facetLimit);
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
          title: VocabularyDb.resolveTitle(r.title, r.title_all_text),
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

          // Extend `creator` reach into organisation/group alt-names. NOT applied
          // to aboutActor (per design — aboutActor stays person-only).
          if (this.hasEntityAltNames && filter.param === "creator") {
            const orgIds = this.findOrgIdsFts(String(value));
            if (orgIds.length > 0) {
              vocabIds = Array.from(new Set([...vocabIds, ...orgIds]));
            }
          }

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

    // Record-modified date range (requires record_modified column from v0.27+ DB)
    if (effective.modifiedAfter) {
      if (this.hasRecordModified_) {
        conditions.push("a.record_modified >= ?");
        bindings.push(effective.modifiedAfter);
      } else {
        warnings?.push("modifiedAfter requires vocabulary DB v0.27+. This filter was ignored.");
      }
    }
    if (effective.modifiedBefore) {
      if (this.hasRecordModified_) {
        conditions.push("a.record_modified <= ?");
        bindings.push(effective.modifiedBefore);
      } else {
        warnings?.push("modifiedBefore requires vocabulary DB v0.27+. This filter was ignored.");
      }
    }

    // Cross-domain: provenance existence filter
    if (effective.hasProvenance === true && this.hasProvenanceTables_) {
      conditions.push("EXISTS (SELECT 1 FROM provenance_events WHERE artwork_id = a.art_id)");
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
   * Returns up to FILTER_ART_IDS_LIMIT art_ids.
   * Returns null if the DB is unavailable or no effective filters are present.
   */
  filterArtIds(params: Partial<VocabSearchParams>): number[] | null {
    if (!this.db) return null;

    const vocabResult = this.buildVocabConditions(params as Record<string, unknown>);
    if (vocabResult === null) return []; // a filter matched zero vocab terms
    if (vocabResult.conditions.length === 0) return null; // no effective filters — fall back to unfiltered

    const sql = `SELECT a.art_id FROM artworks a WHERE ${vocabResult.conditions.join(" AND ")} LIMIT ${FILTER_ART_IDS_LIMIT}`;
    const stmt = lruGetOrCreate<string, Statement>(
      this.stmtFilterArtIds,
      sql,
      () => this.db!.prepare(sql),
      VocabularyDb.FILTER_ART_IDS_CACHE_CAP,
    );
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
  /**
   * Two-tier FTS lookup against an alt-name FTS table: phrase MATCH first,
   * then token AND fallback (with optional stop-word stripping).
   * Used by findPersonIdsFts and findOrgIdsFts.
   *
   * Identifier interpolation in the SQL is safe — `cfg.contentTable`,
   * `cfg.ftsTable`, `cfg.idColumn`, `cfg.alias` are all hardcoded constants
   * passed by the call sites, never user input.
   */
  private findIdsViaFts2Tier(
    value: string,
    cfg: {
      contentTable: string;
      ftsTable: string;
      idColumn: string;
      alias: string;
      extraWhere?: string;
      stopWords?: ReadonlySet<string>;
    },
  ): string[] {
    const phrase = escapeFts5(value);
    if (!phrase) return [];

    const baseSql =
      `SELECT DISTINCT ${cfg.alias}.${cfg.idColumn} AS id
       FROM ${cfg.contentTable} ${cfg.alias}
       WHERE ${cfg.alias}.rowid IN (
         SELECT rowid FROM ${cfg.ftsTable} WHERE ${cfg.ftsTable} MATCH ?
       )${cfg.extraWhere ?? ""}`;

    const tier1 = this.db!.prepare(baseSql).all(phrase) as { id: string }[];
    if (tier1.length > 0) return tier1.map((r) => r.id);

    const tokens = value
      .split(/\s+/)
      .filter((t) => t.length > 0 && !cfg.stopWords?.has(t.toLowerCase()));
    if (tokens.length === 0) return [];

    const ftsTokens = tokens
      .map((t) => escapeFts5(t))
      .filter((x): x is string => x !== null);
    if (ftsTokens.length === 0) return [];

    const tier2 = this.db!.prepare(baseSql).all(ftsTokens.join(" AND ")) as { id: string }[];
    return tier2.map((r) => r.id);
  }

  private findPersonIdsFts(value: string): string[] {
    return this.findIdsViaFts2Tier(value, {
      contentTable: "person_names",
      ftsTable: "person_names_fts",
      idColumn: "person_id",
      alias: "pn",
      stopWords: VocabularyDb.PERSON_STOP_WORDS,
    });
  }

  /**
   * Find organisation/group vocab IDs via the entity_alt_names_fts table.
   * No stop-word stripping — organisation names aren't shaped like personal names.
   * The 'group' clause is forward-proofing: today entity_alt_names is 100%
   * organisation-typed, but the schema and creator field already accept groups.
   */
  private findOrgIdsFts(value: string): string[] {
    return this.findIdsViaFts2Tier(value, {
      contentTable: "entity_alt_names",
      ftsTable: "entity_alt_names_fts",
      idColumn: "entity_id",
      alias: "ean",
      extraWhere: " AND ean.entity_type IN ('organisation', 'group')",
    });
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
    return {
      condition: `a.art_id IN (
        SELECT m.artwork_id FROM mappings m
        WHERE ${fieldClause} AND m.vocab_rowid IN (
          SELECT vocab_int_id FROM vocabulary WHERE ${vocabWhere}
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
       WHERE type = 'place' AND lat IS NOT NULL AND is_areal IS NOT 1
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
           WHERE id IN (${placeholders}) AND lat IS NOT NULL AND is_areal IS NOT 1
           ORDER BY LENGTH(COALESCE(label_en, label_nl, ''))
           LIMIT 1`
        ).get(...vocabIds) as PlaceRow | undefined;
      }
    } else {
      row = this.db!.prepare(
        `SELECT label_en, label_nl, lat, lon FROM vocabulary
         WHERE type = 'place' AND lat IS NOT NULL AND is_areal IS NOT 1
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
        `SELECT id, label_en, label_nl, lat, lon FROM vocabulary
         WHERE id IN (${placeholders}) AND is_areal IS NOT 1`
      ).all(...vocabIds) as PlaceCandidateRow[];
    }

    // Non-FTS fallback (capped to avoid huge IN-lists from short generic terms)
    return this.db!.prepare(
      `SELECT id, label_en, label_nl, lat, lon FROM vocabulary
       WHERE type = 'place' AND is_areal IS NOT 1
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
       WHERE type = 'place' AND lat IS NOT NULL AND is_areal IS NOT 1
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
           WHERE id IN (${placeholders}) AND lat IS NOT NULL AND is_areal IS NOT 1
           ORDER BY LENGTH(COALESCE(label_en, label_nl, ''))
           LIMIT 1`
        ).get(...vocabIds) as CoordRow | undefined;
        if (row) return row;
      }
    }

    return null;
  }

  // ── Provenance search ──────────────────────────────────────────────

  /** Convert a raw provenance_events DB row into a ProvenanceEventRow. */
  private buildProvenanceEvent(
    row: ProvenanceEventDbRow,
    matched: boolean,
  ): ProvenanceEventRow {
    let parties: ProvenanceEventRow["parties"] = [];
    try {
      const raw = JSON.parse(row.parties ?? "[]") as { name: string; dates?: string | null; uncertain?: boolean; role?: string | null; position?: string | null }[];
      parties = raw.map(p => ({
        name: p.name,
        dates: p.dates ?? null,
        uncertain: p.uncertain ?? false,
        role: p.role ?? null,
        position: (p.position as "sender" | "receiver" | "agent" | null) ?? null,
      }));
    } catch { /* empty */ }
    let citations: ProvenanceEventRow["citations"] = [];
    try { citations = JSON.parse(row.citations ?? "[]"); } catch { /* empty */ }
    return {
      sequence: row.sequence,
      rawText: row.raw_text,
      gap: row.gap === 1,
      transferType: row.transfer_type,
      unsold: (row.unsold ?? 0) === 1,
      batchPrice: (row.batch_price ?? 0) === 1,
      transferCategory: (row.transfer_category as "ownership" | "custody" | "ambiguous" | null) ?? null,
      uncertain: row.uncertain === 1,
      parties,
      dateExpression: row.date_expression,
      dateYear: row.date_year,
      dateQualifier: row.date_qualifier,
      location: row.location,
      price: row.price_amount != null
        ? { amount: row.price_amount, currency: row.price_currency ?? "unknown" }
        : null,
      saleDetails: row.sale_details,
      citations,
      isCrossRef: row.is_cross_ref === 1,
      crossRefTarget: row.cross_ref_target,
      parseMethod: row.parse_method as ProvenanceEventRow["parseMethod"],
      categoryMethod: row.category_method ?? null,
      correctionMethod: row.correction_method ?? null,
      enrichmentReasoning: row.enrichment_reasoning ?? null,
      matched,
    };
  }

  // SYNC: conditions here must mirror the SQL WHERE clauses in searchProvenance().
  /** Check whether a single event matches the given provenance search filters. */
  private eventMatchesFilters(
    row: ProvenanceEventDbRow,
    params: ProvenanceSearchParams,
  ): boolean {
    if (params.party) {
      if (this.hasPartyTable_) {
        // Match on party name only (not dates/role) via parsed JSON
        let parties: { name: string }[] = [];
        try { parties = JSON.parse(row.parties ?? "[]"); } catch { /* empty */ }
        if (!parties.some(p => p.name.toLowerCase().includes(params.party!.toLowerCase()))) return false;
      } else {
        if (!row.parties.toLowerCase().includes(params.party.toLowerCase())) return false;
      }
    }
    if (params.transferType) {
      const types = Array.isArray(params.transferType) ? params.transferType : [params.transferType];
      if (!types.includes(row.transfer_type)) return false;
    }
    // excludeTransferType is an artwork-level filter, not per-event — handled in SQL
    if (params.location) {
      if (!(row.location ?? "").toLowerCase().includes(params.location.toLowerCase())) return false;
    }
    if (params.dateFrom != null && (row.date_year == null || row.date_year < params.dateFrom)) return false;
    if (params.dateTo != null && (row.date_year == null || row.date_year > params.dateTo)) return false;
    if (params.currency && row.price_currency !== params.currency) return false;
    if (params.hasPrice && row.price_amount == null) return false;
    if (params.hasGap && row.gap !== 1) return false;
    if (params.relatedTo && row.cross_ref_target !== params.relatedTo) return false;
    if (params.categoryMethod && row.category_method !== params.categoryMethod) return false;
    // positionMethod is an artwork-level filter (via provenance_parties table), not per-event — handled in SQL
    return true;
  }

  /** Build a ProvenanceArtworkResult from grouped rows for one artwork. */
  private buildProvenanceArtwork(
    rows: ProvenanceEventDbRow[],
    allMatched: boolean,
    params?: ProvenanceSearchParams,
  ): ProvenanceArtworkResult {
    const first = rows[0];
    let matchedCount = 0;
    const events = rows.map(r => {
      const matched = allMatched || (params ? this.eventMatchesFilters(r, params) : false);
      if (matched) matchedCount++;
      return this.buildProvenanceEvent(r, matched);
    });

    // Enrich parties with provenance_parties reasoning (position_method, enrichment_reasoning).
    // The query self-filters on position_method LIKE 'llm%', so it's cheap for artworks without enrichment.
    if (this.stmtPartyEnrichment_) {
      const partyRows = this.stmtPartyEnrichment_.all(first.artwork_id) as {
        sequence: number; party_idx: number; position_method: string | null; enrichment_reasoning: string | null;
      }[];
      for (const pr of partyRows) {
        if (!pr.position_method?.startsWith("llm")) continue;
        const event = events.find(e => e.sequence === pr.sequence);
        if (!event || pr.party_idx >= event.parties.length) continue;
        event.parties[pr.party_idx].positionMethod = pr.position_method;
        event.parties[pr.party_idx].enrichmentReasoning = pr.enrichment_reasoning;
      }
    }

    // Post-enrichment: re-evaluate positionMethod matching per event.
    // positionMethod can't be checked in eventMatchesFilters() because position_method
    // is only available after party enrichment above. Demote events that don't have
    // any party with the requested positionMethod. When `party` is also set, the same
    // party row must satisfy both filters (#347) — mirrors the same-row SQL conjunction
    // and keeps `matched` aligned with the rows the SQL admitted.
    if (!allMatched && params?.positionMethod) {
      const partyNeedle = params.party?.toLowerCase();
      matchedCount = 0;
      for (const event of events) {
        if (event.matched) {
          const hasMatch = event.parties.some(p =>
            p.positionMethod === params.positionMethod &&
            (partyNeedle == null || p.name.toLowerCase().includes(partyNeedle)),
          );
          if (!hasMatch) {
            event.matched = false;
          } else {
            matchedCount++;
          }
        }
      }
    }

    return {
      objectNumber: first.object_number,
      title: first.title ?? "",
      creator: first.creator_label ?? "",
      date: formatDateRange(first.date_earliest, first.date_latest),
      url: `https://www.rijksmuseum.nl/en/collection/${first.object_number}`,
      eventCount: events.length,
      matchedEventCount: allMatched ? events.length : matchedCount,
      events,
    };
  }

  /**
   * Search provenance events across artworks.
   *
   * Returns full provenance chains grouped by artwork, with matching events
   * flagged via `matched: true`. At least one filter is required.
   */
  searchProvenance(params: ProvenanceSearchParams): ProvenanceSearchResult {
    if (!this.db || !this.hasProvenanceTables_) {
      return { totalArtworks: 0, results: [] };
    }

    const maxResults = Math.min(params.maxResults ?? 10, 50);
    const warnings: string[] = [];

    // sortBy=duration only applies to layer='periods'
    if (params.sortBy === "duration") {
      warnings.push("sortBy='duration' is only supported with layer='periods'. Sort ignored; results are in default order.");
    }

    // ── objectNumber fast path ──
    if (params.objectNumber) {
      const rows = this.db.prepare(`
        SELECT pe.*, a.object_number, a.title, a.creator_label, a.date_earliest, a.date_latest
        FROM provenance_events pe
        JOIN artworks a ON a.art_id = pe.artwork_id
        WHERE a.object_number = ?
        ORDER BY pe.sequence
      `).all(params.objectNumber) as ProvenanceEventDbRow[];
      if (rows.length === 0) return { totalArtworks: 0, results: [], ...(warnings.length > 0 && { warnings }) };
      return { totalArtworks: 1, results: [this.buildProvenanceArtwork(rows, false, params)], ...(warnings.length > 0 && { warnings }) };
    }

    // SYNC: conditions here must mirror eventMatchesFilters() for matched-flag accuracy.
    // ── Build WHERE conditions ──
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    // When both `party` and `positionMethod` are present, the two filters must compose on
    // the same provenance_parties row of the same event (#347) — otherwise two parties on
    // the same event can each satisfy one filter and falsely pass. Linkage: provenance_parties
    // PK (artwork_id, sequence, party_idx) shares (artwork_id, sequence) with provenance_events,
    // and party_idx maps 1:1 onto positions in pe.parties JSON (relied on by stmtPartyEnrichment_).
    const sameRowPartyConjunction = !!params.party && !!params.positionMethod && this.hasPartyTable_;
    if (sameRowPartyConjunction) {
      conditions.push("EXISTS (SELECT 1 FROM provenance_parties pp WHERE pp.artwork_id = pe.artwork_id AND pp.sequence = pe.sequence AND pp.party_name LIKE '%' || ? || '%' AND pp.position_method = ?)");
      bindings.push(params.party, params.positionMethod);
    } else if (params.party) {
      // Event-level filter: match on the event's own parties JSON, not artwork-level EXISTS.
      // Artwork-level EXISTS would return events from artworks where the party appears
      // *somewhere* in the chain, causing false positives when combined with event-level
      // filters like transferType (the party might be on a different event).
      conditions.push("pe.parties LIKE '%' || ? || '%'");
      bindings.push(params.party);
    }
    if (params.transferType) {
      const types = Array.isArray(params.transferType) ? params.transferType : [params.transferType];
      if (types.length === 1) {
        conditions.push("pe.transfer_type = ?");
        bindings.push(types[0]);
      } else {
        conditions.push(`pe.transfer_type IN (${types.map(() => "?").join(", ")})`);
        bindings.push(...types);
      }
    }
    if (params.excludeTransferType) {
      const excl = Array.isArray(params.excludeTransferType) ? params.excludeTransferType : [params.excludeTransferType];
      conditions.push(`NOT EXISTS (SELECT 1 FROM provenance_events pe_excl WHERE pe_excl.artwork_id = pe.artwork_id AND pe_excl.transfer_type IN (${excl.map(() => "?").join(", ")}))`);
      bindings.push(...excl);
    }
    if (params.location) {
      conditions.push("pe.location LIKE '%' || ? || '%'");
      bindings.push(params.location);
    }
    if (params.dateFrom != null) {
      conditions.push("pe.date_year >= ?");
      bindings.push(params.dateFrom);
    }
    if (params.dateTo != null) {
      conditions.push("pe.date_year <= ?");
      bindings.push(params.dateTo);
    }
    if (params.creator) {
      conditions.push("a.creator_label LIKE '%' || ? || '%'");
      bindings.push(params.creator);
    }
    if (params.currency) {
      conditions.push("pe.price_currency = ?");
      bindings.push(params.currency);
    }
    if (params.hasPrice) {
      conditions.push("pe.price_amount IS NOT NULL");
    }
    if (params.hasGap) {
      // Artwork-level filter: at least one gap event exists in the chain
      conditions.push("pe.artwork_id IN (SELECT artwork_id FROM provenance_events WHERE gap = 1)");
    }
    if (params.relatedTo) {
      conditions.push("pe.cross_ref_target = ?");
      bindings.push(params.relatedTo);
    }
    if (params.categoryMethod) {
      conditions.push("pe.category_method = ?");
      bindings.push(params.categoryMethod);
    }
    if (params.positionMethod && !sameRowPartyConjunction) {
      if (this.hasPartyTable_) {
        conditions.push("pe.artwork_id IN (SELECT pp2.artwork_id FROM provenance_parties pp2 WHERE pp2.position_method = ?)");
      } else {
        // Fallback for DBs without party table — filter on category_method instead (best effort)
        conditions.push("pe.category_method = ?");
      }
      bindings.push(params.positionMethod);
    }

    if (conditions.length === 0) {
      return { totalArtworks: 0, results: [] };
    }

    const where = conditions.join(" AND ");

    // Step 1: Build ORDER BY + CTEs for sortBy
    // Sort CTEs apply the same WHERE filters as the outer query (#192)
    // so sort values come only from matching events, not unrelated ones.
    let orderBy = "";
    let sortCte = "";
    let sortJoin = "";
    let sortBindings: unknown[] = [];
    const dir = params.sortOrder === "asc" ? "ASC" : "DESC";
    if (params.sortBy === "price") {
      sortCte = `WITH sort_agg AS (SELECT pe2.artwork_id, MAX(pe2.price_amount) AS sort_val FROM provenance_events pe2 JOIN artworks a2 ON a2.art_id = pe2.artwork_id WHERE pe2.price_amount IS NOT NULL AND ${where.replace(/\bpe\./g, "pe2.").replace(/\ba\./g, "a2.")} GROUP BY pe2.artwork_id)`;
      sortJoin = "LEFT JOIN sort_agg sa ON sa.artwork_id = pe.artwork_id";
      orderBy = `ORDER BY sa.sort_val ${dir} NULLS LAST`;
      sortBindings = [...bindings];
    } else if (params.sortBy === "eventCount") {
      sortCte = `WITH sort_agg AS (SELECT pe2.artwork_id, COUNT(*) AS sort_val FROM provenance_events pe2 JOIN artworks a2 ON a2.art_id = pe2.artwork_id WHERE ${where.replace(/\bpe\./g, "pe2.").replace(/\ba\./g, "a2.")} GROUP BY pe2.artwork_id)`;
      sortJoin = "LEFT JOIN sort_agg sa ON sa.artwork_id = pe.artwork_id";
      orderBy = `ORDER BY sa.sort_val ${dir}`;
      sortBindings = [...bindings];
    } else if (params.sortBy === "dateYear") {
      sortCte = `WITH sort_agg AS (SELECT pe2.artwork_id, MIN(pe2.date_year) AS sort_val FROM provenance_events pe2 JOIN artworks a2 ON a2.art_id = pe2.artwork_id WHERE pe2.date_year IS NOT NULL AND ${where.replace(/\bpe\./g, "pe2.").replace(/\ba\./g, "a2.")} GROUP BY pe2.artwork_id)`;
      sortJoin = "LEFT JOIN sort_agg sa ON sa.artwork_id = pe.artwork_id";
      orderBy = `ORDER BY sa.sort_val ${dir} NULLS LAST`;
      sortBindings = [...bindings];
    }

    const offset = params.offset ?? 0;

    // Find matching artwork_ids (limited + offset)
    // Binding order: sortCte bindings (filtered), then outer WHERE bindings, then LIMIT/OFFSET
    const artworkIds = (this.db.prepare(`
      ${sortCte}
      SELECT DISTINCT pe.artwork_id
      FROM provenance_events pe
      JOIN artworks a ON a.art_id = pe.artwork_id
      ${sortJoin}
      WHERE ${where}
      ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...sortBindings, ...bindings, maxResults, offset) as { artwork_id: number }[]).map(r => r.artwork_id);

    if (artworkIds.length === 0) return { totalArtworks: 0, results: [] };

    const totalArtworks = (this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT DISTINCT pe.artwork_id
        FROM provenance_events pe
        JOIN artworks a ON a.art_id = pe.artwork_id
        WHERE ${where}
        LIMIT ?
      )
    `).get(...bindings, PROVENANCE_COUNT_CAP) as { cnt: number }).cnt;

    // Step 2: Fetch full chains for matched artworks
    const placeholders = artworkIds.map(() => "?").join(", ");
    const allRows = this.db.prepare(`
      SELECT pe.*, a.object_number, a.title, a.creator_label, a.date_earliest, a.date_latest
      FROM provenance_events pe
      JOIN artworks a ON a.art_id = pe.artwork_id
      WHERE pe.artwork_id IN (${placeholders})
      ORDER BY pe.artwork_id, pe.sequence
    `).all(...artworkIds) as ProvenanceEventDbRow[];

    // Group by artwork_id, preserving the order from step 1
    const grouped = new Map<number, ProvenanceEventDbRow[]>();
    for (const row of allRows) {
      if (!grouped.has(row.artwork_id)) grouped.set(row.artwork_id, []);
      grouped.get(row.artwork_id)!.push(row);
    }

    let results: ProvenanceArtworkResult[] = [];
    for (const artworkId of artworkIds) {
      const rows = grouped.get(artworkId);
      if (!rows) continue;
      results.push(this.buildProvenanceArtwork(rows, false, params));
    }

    const capped = totalArtworks >= PROVENANCE_COUNT_CAP;

    // Compute provenance facets if requested
    let facets: Record<string, Array<{ label: string; count: number }>> | undefined;
    if (params.facets) {
      facets = this.computeProvenanceFacets(conditions, bindings);
      if (Object.keys(facets).length === 0) facets = undefined;
    }

    return { totalArtworks, totalArtworksCapped: capped || undefined, results, ...(facets && { facets }), ...(warnings.length > 0 && { warnings }) };
  }

  // ── Layer 2: Provenance Periods ───────────────────────────────────

  /** Convert a raw provenance_periods DB row into a ProvenancePeriodRow. */
  private buildProvenancePeriod(
    row: ProvenancePeriodDbRow,
    matched: boolean,
  ): ProvenancePeriodRow {
    let derivation: Record<string, string> = {};
    try { derivation = JSON.parse(row.derivation ?? "{}"); } catch { /* empty */ }
    let citations: { text: string }[] = [];
    try { citations = JSON.parse(row.citations ?? "[]"); } catch { /* empty */ }
    let sourceEvents: number[] = [];
    try { sourceEvents = JSON.parse(row.source_events ?? "[]"); } catch { /* empty */ }
    const duration = (row.begin_year != null && row.end_year != null)
      ? row.end_year - row.begin_year
      : null;
    return {
      sequence: row.sequence,
      ownerName: row.owner_name,
      ownerDates: row.owner_dates,
      location: row.location,
      acquisitionMethod: row.acquisition_method,
      acquisitionFrom: row.acquisition_from,
      beginYear: row.begin_year,
      beginYearLatest: row.begin_year_latest,
      endYear: row.end_year,
      duration,
      derivation,
      uncertain: row.uncertain === 1,
      citations,
      sourceEvents,
      matched,
    };
  }

  /** Check whether a single period matches the given search filters. */
  private periodMatchesFilters(
    row: ProvenancePeriodDbRow,
    params: ProvenanceSearchParams,
  ): boolean {
    const ownerFilter = params.ownerName ?? params.party;
    if (ownerFilter) {
      if (!(row.owner_name ?? "").toLowerCase().includes(ownerFilter.toLowerCase())) return false;
    }
    if (params.acquisitionMethod && row.acquisition_method !== params.acquisitionMethod) return false;
    if (params.location) {
      if (!(row.location ?? "").toLowerCase().includes(params.location.toLowerCase())) return false;
    }
    if (params.periodLocation) {
      if (!(row.location ?? "").toLowerCase().includes(params.periodLocation.toLowerCase())) return false;
    }
    if (params.dateFrom != null && (row.begin_year == null || row.begin_year < params.dateFrom)) return false;
    if (params.dateTo != null && (row.end_year == null || row.end_year > params.dateTo)) return false;
    if (params.minDuration != null || params.maxDuration != null) {
      if (row.begin_year == null || row.end_year == null) return false;
      const dur = row.end_year - row.begin_year;
      if (params.minDuration != null && dur < params.minDuration) return false;
      if (params.maxDuration != null && dur > params.maxDuration) return false;
    }
    return true;
  }

  /** Build a ProvenanceArtworkResult (with periods) from grouped period rows. */
  private buildProvenanceArtworkPeriods(
    rows: ProvenancePeriodDbRow[],
    allMatched: boolean,
    params?: ProvenanceSearchParams,
  ): ProvenanceArtworkResult {
    const first = rows[0];
    let matchedCount = 0;
    const periods = rows.map(r => {
      const matched = allMatched || (params ? this.periodMatchesFilters(r, params) : false);
      if (matched) matchedCount++;
      return this.buildProvenancePeriod(r, matched);
    });
    return {
      objectNumber: first.object_number,
      title: first.title ?? "",
      creator: first.creator_label ?? "",
      date: formatDateRange(first.date_earliest, first.date_latest),
      url: `https://www.rijksmuseum.nl/en/collection/${first.object_number}`,
      eventCount: 0,
      matchedEventCount: 0,
      events: [],
      periods,
      periodCount: periods.length,
      matchedPeriodCount: allMatched ? periods.length : matchedCount,
    };
  }

  /**
   * Search provenance periods (Layer 2) across artworks.
   *
   * Same two-stage pattern as searchProvenance(): find artwork IDs, then
   * fetch full period chains with matched flags.
   */
  searchProvenancePeriods(params: ProvenanceSearchParams): ProvenanceSearchResult {
    if (!this.db || !this.hasProvenancePeriods_) {
      return { totalArtworks: 0, results: [], warnings: ["Provenance periods table not available."] };
    }

    const maxResults = Math.min(params.maxResults ?? 10, 50);

    // ── objectNumber fast path ──
    if (params.objectNumber) {
      const rows = this.db.prepare(`
        SELECT pp.*, a.object_number, a.title, a.creator_label, a.date_earliest, a.date_latest
        FROM provenance_periods pp
        JOIN artworks a ON a.art_id = pp.artwork_id
        WHERE a.object_number = ?
        ORDER BY pp.sequence
      `).all(params.objectNumber) as ProvenancePeriodDbRow[];
      if (rows.length === 0) return { totalArtworks: 0, results: [] };
      return { totalArtworks: 1, results: [this.buildProvenanceArtworkPeriods(rows, false, params)] };
    }

    // ── Build WHERE conditions ──
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    // ownerName and party both target the same column — ownerName takes precedence.
    // Always filter on pp.owner_name (the period's inferred owner), not provenance_parties
    // (event-level table), to avoid false-positive matches at the period layer.
    const ownerFilter = params.ownerName ?? params.party;
    if (ownerFilter) {
      conditions.push("pp.owner_name LIKE '%' || ? || '%'");
      bindings.push(ownerFilter);
    }
    if (params.acquisitionMethod) {
      conditions.push("pp.acquisition_method = ?");
      bindings.push(params.acquisitionMethod);
    }
    if (params.location) {
      conditions.push("pp.location LIKE '%' || ? || '%'");
      bindings.push(params.location);
    }
    if (params.periodLocation) {
      conditions.push("pp.location LIKE '%' || ? || '%'");
      bindings.push(params.periodLocation);
    }
    if (params.dateFrom != null) {
      conditions.push("pp.begin_year >= ?");
      bindings.push(params.dateFrom);
    }
    if (params.dateTo != null) {
      conditions.push("pp.end_year <= ?");
      bindings.push(params.dateTo);
    }
    if (params.creator) {
      conditions.push("a.creator_label LIKE '%' || ? || '%'");
      bindings.push(params.creator);
    }
    if (params.minDuration != null || params.maxDuration != null) {
      conditions.push("pp.end_year IS NOT NULL AND pp.begin_year IS NOT NULL");
      if (params.minDuration != null) {
        conditions.push("(pp.end_year - pp.begin_year) >= ?");
        bindings.push(params.minDuration);
      }
      if (params.maxDuration != null) {
        conditions.push("(pp.end_year - pp.begin_year) <= ?");
        bindings.push(params.maxDuration);
      }
    }

    // Duration sort uses aggregate (MAX for desc, MIN for asc) to avoid
    // nondeterministic results when artworks have multiple periods (#193).
    const sortByDuration = params.sortBy === "duration";
    if (sortByDuration) {
      conditions.push("pp.end_year IS NOT NULL AND pp.begin_year IS NOT NULL AND (pp.end_year - pp.begin_year) >= 0");
    }

    if (conditions.length === 0) {
      return { totalArtworks: 0, results: [] };
    }

    const where = conditions.join(" AND ");
    const offset = params.offset ?? 0;

    // Find matching artwork_ids
    let artworkIds: number[];
    if (sortByDuration) {
      const dir = params.sortOrder === "asc" ? "ASC" : "DESC";
      const agg = params.sortOrder === "asc" ? "MIN" : "MAX";
      artworkIds = (this.db.prepare(`
        SELECT artwork_id FROM (
          SELECT pp.artwork_id, ${agg}(pp.end_year - pp.begin_year) AS max_dur
          FROM provenance_periods pp
          JOIN artworks a ON a.art_id = pp.artwork_id
          WHERE ${where}
          GROUP BY pp.artwork_id
        ) sub
        ORDER BY sub.max_dur ${dir}
        LIMIT ? OFFSET ?
      `).all(...bindings, maxResults, offset) as { artwork_id: number }[]).map(r => r.artwork_id);
    } else {
      artworkIds = (this.db.prepare(`
        SELECT DISTINCT pp.artwork_id
        FROM provenance_periods pp
        JOIN artworks a ON a.art_id = pp.artwork_id
        WHERE ${where}
        LIMIT ? OFFSET ?
      `).all(...bindings, maxResults, offset) as { artwork_id: number }[]).map(r => r.artwork_id);
    }

    if (artworkIds.length === 0) return { totalArtworks: 0, results: [] };

    const totalArtworks = (this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT DISTINCT pp.artwork_id
        FROM provenance_periods pp
        JOIN artworks a ON a.art_id = pp.artwork_id
        WHERE ${where}
        LIMIT ?
      )
    `).get(...bindings, PROVENANCE_COUNT_CAP) as { cnt: number }).cnt;

    // Fetch full period chains
    const placeholders = artworkIds.map(() => "?").join(", ");
    const allRows = this.db.prepare(`
      SELECT pp.*, a.object_number, a.title, a.creator_label, a.date_earliest, a.date_latest
      FROM provenance_periods pp
      JOIN artworks a ON a.art_id = pp.artwork_id
      WHERE pp.artwork_id IN (${placeholders})
      ORDER BY pp.artwork_id, pp.sequence
    `).all(...artworkIds) as ProvenancePeriodDbRow[];

    // Group by artwork_id
    const grouped = new Map<number, ProvenancePeriodDbRow[]>();
    for (const row of allRows) {
      if (!grouped.has(row.artwork_id)) grouped.set(row.artwork_id, []);
      grouped.get(row.artwork_id)!.push(row);
    }

    const results: ProvenanceArtworkResult[] = [];
    for (const artworkId of artworkIds) {
      const rows = grouped.get(artworkId);
      if (!rows) continue;
      results.push(this.buildProvenanceArtworkPeriods(rows, false, params));
    }

    const capped = totalArtworks >= PROVENANCE_COUNT_CAP;
    return { totalArtworks, totalArtworksCapped: capped || undefined, results };
  }

}
