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

export interface ArtworkImageInfo {
  iiifId: string;
  iiifInfoUrl: string;
  thumbnailUrl: string;
  width: number;
  height: number;
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
