// ─── Getty AAT Classification URIs ──────────────────────────────────
// Used throughout Linked Art JSON-LD to classify content types

export const AAT = {
  // Languages
  LANG_EN: "http://vocab.getty.edu/aat/300388277",
  LANG_NL: "http://vocab.getty.edu/aat/300388256",

  // Name classifications
  BRIEF_TEXT: "http://vocab.getty.edu/aat/300404670",
  TITLE_TYPE: "http://vocab.getty.edu/aat/300417207",
  FULL_TITLE: "http://vocab.getty.edu/aat/300417200",

  // Identifier classifications
  OBJECT_NUMBER: "http://vocab.getty.edu/aat/300312355",

  // referred_to_by statement types
  DESCRIPTION: "http://vocab.getty.edu/aat/300435452",
  TECHNIQUE_STATEMENT: "http://vocab.getty.edu/aat/300435429",
  DIMENSION_STATEMENT: "http://vocab.getty.edu/aat/300435430",
  PROVENANCE: "http://vocab.getty.edu/aat/300444174",
  CREDIT_LINE: "http://vocab.getty.edu/aat/300026687",
  INSCRIPTIONS: "http://vocab.getty.edu/aat/300435414",
  CREATOR_STATEMENT: "http://vocab.getty.edu/aat/300435416",
  CREATOR_DESCRIPTION: "http://vocab.getty.edu/aat/300435417",

  // subject_of classifications
  NARRATIVE: "http://vocab.getty.edu/aat/300048722",
  WEB_RESOURCES: "http://vocab.getty.edu/aat/300379475",

  // Bibliography classifications
  CITATION: "http://vocab.getty.edu/aat/300311954",
} as const;

/** Static map of common AAT unit URIs to human-readable abbreviations */
export const AAT_UNIT_LABELS: Record<string, string> = {
  "http://vocab.getty.edu/aat/300379098": "cm",
  "http://vocab.getty.edu/aat/300379226": "kg",
  "http://vocab.getty.edu/aat/300379097": "mm",
  "http://vocab.getty.edu/aat/300379100": "m",
  "http://vocab.getty.edu/aat/300379225": "g",
};

// ─── Linked Art Primitives ──────────────────────────────────────────

export interface LinkedArtRef {
  id: string;
  type: string;
  _label?: string;
  classified_as?: (LinkedArtRef | string)[];
}

export interface LanguageRef {
  id: string;
  type: "Language";
}

export interface IdentifiedBy {
  type: "Name" | "Identifier";
  id?: string;
  content: string;
  classified_as?: (LinkedArtRef | string)[];
  identified_by?: IdentifiedBy[];
  language?: LanguageRef[];
}

export interface ReferredToBy {
  type: "LinguisticObject";
  content: string;
  classified_as?: (LinkedArtRef | string)[];
  language?: LanguageRef[];
}

export interface Timespan {
  type: "TimeSpan";
  identified_by?: IdentifiedBy[];
  begin_of_the_begin?: string;
  end_of_the_end?: string;
}

export interface ProductionPart {
  type: "Production";
  carried_out_by?: LinkedArtRef[];
  classified_as?: (LinkedArtRef | string)[];
  technique?: LinkedArtRef[];
  referred_to_by?: ReferredToBy[];
  took_place_at?: LinkedArtRef[];
  identified_by?: IdentifiedBy[];
}

export interface Production {
  type: "Production";
  timespan?: Timespan;
  referred_to_by?: ReferredToBy[];
  part?: ProductionPart[];
}

export interface CurrentLocation {
  type: "Place";
  identified_by?: IdentifiedBy[];
}

export interface DimensionEntry {
  type: "Dimension";
  classified_as?: LinkedArtRef[];
  referred_to_by?: ReferredToBy[];
  value?: number;
  unit?: LinkedArtRef;
}

// ─── subject_of structures ──────────────────────────────────────────

export interface SubjectOfPart {
  type: string;
  content?: string;
  classified_as?: (LinkedArtRef | string)[];
  language?: LanguageRef[];
}

export interface SubjectTo {
  type: string;
  classified_as?: ({ id: string; type?: string } | string)[];
}

export interface DigitalCarrier {
  type: string;
  format?: string;
  access_point?: LinkedArtRef[];
}

export interface SubjectOf {
  type: string;
  classified_as?: (LinkedArtRef | string)[];
  language?: LanguageRef[];
  part?: SubjectOfPart[];
  subject_to?: SubjectTo[];
  digitally_carried_by?: DigitalCarrier[];
}

// ─── attributed_by (related objects) ────────────────────────────────

export interface AttributedBy {
  type: string;
  identified_by?: IdentifiedBy[];
  assigned?: LinkedArtRef[];
}

// ─── Full Linked Art Object ─────────────────────────────────────────

export interface LinkedArtObject {
  "@context"?: string;
  id: string;
  type: string;
  identified_by?: IdentifiedBy[];
  referred_to_by?: ReferredToBy[];
  produced_by?: Production;
  shows?: LinkedArtRef[];
  member_of?: LinkedArtRef[];
  current_location?: CurrentLocation;
  dimension?: DimensionEntry[];
  subject_of?: SubjectOf[];
  classified_as?: (LinkedArtRef | string)[];
  made_of?: LinkedArtRef[];
  equivalent?: LinkedArtRef[];
  attributed_by?: AttributedBy[];
  assigned_by?: any[];
}

// ─── Search API Types ───────────────────────────────────────────────

export interface SearchResultItem {
  id: string;
  type: string;
}

export interface SearchApiResponse {
  "@context"?: string;
  id: string;
  type: "OrderedCollectionPage";
  partOf?: {
    id: string;
    type: "OrderedCollection";
    totalItems: number;
    first?: { id: string; type: string };
    last?: { id: string; type: string };
  };
  next?: { id: string; type: string };
  prev?: { id: string; type: string };
  orderedItems: SearchResultItem[];
}

// ─── Image Chain Types ──────────────────────────────────────────────

export interface VisualItem {
  id: string;
  type: "VisualItem";
  digitally_shown_by?: LinkedArtRef[];
  represents_instance_of_type?: LinkedArtRef[];
  represents?: LinkedArtRef[];
}

export interface DigitalObject {
  id: string;
  type: "DigitalObject";
  access_point?: LinkedArtRef[];
  conforms_to?: LinkedArtRef[];
}

// ─── IIIF Types ─────────────────────────────────────────────────────

export interface IIIFTileInfo {
  scaleFactors: number[];
  width: number;
  height: number;
}

export interface IIIFInfoResponse {
  "@context"?: string;
  id: string;
  type?: string;
  protocol?: string;
  profile?: string;
  width: number;
  height: number;
  tiles?: IIIFTileInfo[];
  qualities?: string[];
  formats?: string[];
}

// ─── Parsed Output Types ────────────────────────────────────────────

export interface ArtworkSummary {
  id: string;
  objectNumber: string;
  title: string;
  creator: string;
  date: string;
  type?: string;
  url: string;
}

export interface ArtworkDetail extends ArtworkSummary {
  description: string | null;
  techniqueStatement: string | null;
  dimensionStatement: string | null;
  provenance: string | null;
  creditLine: string | null;
  inscriptions: string[];
  location: string | null;
  collectionSets: string[];
  externalIds: Record<string, string>;
}

// ─── Enriched Detail Types ──────────────────────────────────────────

export interface TitleVariant {
  title: string;
  language: "en" | "nl" | "other";
  qualifier: "brief" | "full" | "other";
}

export interface StructuredDimension {
  type: string;
  value: number;
  unit: string;
  note: string | null;
}

export interface RelatedObject {
  relationship: string;
  objectUri: string;
}

export interface ResolvedTerm {
  id: string;
  label: string;
  equivalents?: Record<string, string>;
}

export interface ProductionParticipant {
  name: string;
  role: string | null;
  place: string | null;
  actorUri: string;
}

export interface SubjectData {
  iconclass: ResolvedTerm[];
  depictedPersons: ResolvedTerm[];
  depictedPlaces: ResolvedTerm[];
}

export interface ArtworkDetailEnriched extends ArtworkDetail {
  // Group A: parsed from existing object (no HTTP)
  titles: TitleVariant[];
  curatorialNarrative: { en: string | null; nl: string | null };
  license: string | null;
  webPage: string | null;
  dimensions: StructuredDimension[];
  relatedObjects: RelatedObject[];
  persistentId: string | null;

  // Group B: resolved vocabulary terms (async HTTP)
  objectTypes: ResolvedTerm[];
  materials: ResolvedTerm[];
  production: ProductionParticipant[];
  collectionSetLabels: ResolvedTerm[];

  // Group C: subject annotations (from VisualItem)
  subjects: SubjectData;

  // Bibliography count (for discoverability — full data via separate tool)
  bibliographyCount: number;
}

// ─── Bibliography Types ─────────────────────────────────────────────

export interface BibliographyEntry {
  sequence: number | null;
  citation: string;
  publicationUri?: string;
  pages?: string;
  isbn?: string;
  worldcatUri?: string;
  libraryUrl?: string;
}

export interface BibliographyResult {
  objectNumber: string;
  total: number;
  entries: BibliographyEntry[];
}

export interface ArtworkImageInfo {
  iiifId: string;
  iiifInfoUrl: string;
  thumbnailUrl: string;
  fullUrl: string;
  width: number;
  height: number;
  viewerUrl?: string;
}

// ─── Search Parameters ──────────────────────────────────────────────

export interface SearchParams {
  query?: string;
  title?: string;
  creator?: string;
  aboutActor?: string;
  objectNumber?: string;
  type?: string;
  material?: string;
  technique?: string;
  creationDate?: string;
  description?: string;
  imageAvailable?: boolean;
  maxResults?: number;
  compact?: boolean;
  pageToken?: string;
}

// ─── OAI-PMH Types ─────────────────────────────────────────────

export interface OaiSet {
  setSpec: string;
  name: string;
  lodUri: string;
}

export interface OaiRecordHeader {
  identifier: string;
  datestamp: string;
  setSpecs: string[];
}

export interface OaiCreator {
  name: string;
  dateOfBirth: string | null;
  dateOfDeath: string | null;
  authorityLinks: Record<string, string>;
}

export interface OaiSubject {
  label: string;
  type: "iconclass" | "place" | "person";
  code?: string;
  uri?: string;
}

export interface OaiParsedRecord {
  lodUri: string;
  objectNumber: string;
  datestamp: string;
  title: string | null;
  description: string | null;
  date: string | null;
  dimensions: string | null;
  type: string | null;
  materials: string[];
  edmType: string | null;
  creator: OaiCreator | null;
  imageUrl: string | null;
  iiifServiceUrl: string | null;
  rights: string | null;
  setMemberships: string[];
  subjects: OaiSubject[];
}

export interface OaiListResult<T> {
  records: T[];
  completeListSize: number | null;
  resumptionToken: string | null;
}
