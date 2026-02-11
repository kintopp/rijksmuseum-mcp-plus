// ─── Getty AAT Classification URIs ──────────────────────────────────
// Used throughout Linked Art JSON-LD to classify content types

export const AAT = {
  // Languages
  LANG_EN: "http://vocab.getty.edu/aat/300388277",
  LANG_NL: "http://vocab.getty.edu/aat/300388256",

  // Name classifications
  BRIEF_TEXT: "http://vocab.getty.edu/aat/300404670",
  TITLE_TYPE: "http://vocab.getty.edu/aat/300417207",

  // Identifier classifications
  OBJECT_NUMBER: "http://vocab.getty.edu/aat/300312355",
  ACCESSION_NUMBER: "http://vocab.getty.edu/aat/300312355",

  // referred_to_by statement types
  DESCRIPTION: "http://vocab.getty.edu/aat/300435452",
  TECHNIQUE_STATEMENT: "http://vocab.getty.edu/aat/300435429",
  DIMENSION_STATEMENT: "http://vocab.getty.edu/aat/300435430",
  PROVENANCE: "http://vocab.getty.edu/aat/300444174",
  CREDIT_LINE: "http://vocab.getty.edu/aat/300026687",
  INSCRIPTIONS: "http://vocab.getty.edu/aat/300435414",
  CREATOR_STATEMENT: "http://vocab.getty.edu/aat/300435416",
  CREATOR_DESCRIPTION: "http://vocab.getty.edu/aat/300435417",
} as const;

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
  subject_of?: any[];
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

export interface ArtworkImageInfo {
  iiifId: string;
  iiifInfoUrl: string;
  thumbnailUrl: string;
  fullUrl: string;
  width: number;
  height: number;
  viewerUrl?: string;
}

export interface TimelineEntry {
  year: string;
  title: string;
  objectNumber: string;
  creator: string;
  id: string;
  url: string;
}

// ─── Search Parameters ──────────────────────────────────────────────

export interface SearchParams {
  title?: string;
  creator?: string;
  objectNumber?: string;
  type?: string;
  material?: string;
  technique?: string;
  creationDate?: string;
  maxResults?: number;
  compact?: boolean;
  pageToken?: string;
}
