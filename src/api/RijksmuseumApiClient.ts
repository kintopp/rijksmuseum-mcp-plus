import axios, { AxiosInstance } from "axios";
import {
  AAT,
  LinkedArtObject,
  ReferredToBy,
  SearchApiResponse,
  SearchParams,
  ArtworkSummary,
  ArtworkDetail,
  ArtworkImageInfo,
  VisualItem,
  DigitalObject,
  IIIFInfoResponse,
} from "../types.js";

// ─── Helpers ────────────────────────────────────────────────────────

/** Check if a classified_as array contains a given AAT URI */
function hasClassification(
  classifiedAs: ({ id?: string } | string)[] | undefined,
  aatUri: string
): boolean {
  if (!classifiedAs) return false;
  return classifiedAs.some((c) =>
    typeof c === "string" ? c === aatUri : c.id === aatUri
  );
}

/** Get language AAT URI from a language array */
function getLangId(langs: { id: string }[] | undefined): string | undefined {
  return langs?.[0]?.id;
}

/** Extract IIIF identifier from a full IIIF URL */
function extractIiifId(url: string): string | null {
  // https://iiif.micr.io/PJEZO/full/max/0/default.jpg → PJEZO
  const match = url.match(/iiif\.micr\.io\/([^/]+)/);
  return match ? match[1] : null;
}

// ─── Client ─────────────────────────────────────────────────────────

export class RijksmuseumApiClient {
  private http: AxiosInstance;

  private static readonly SEARCH_URL =
    "https://data.rijksmuseum.nl/search/collection";
  private static readonly ID_BASE = "https://id.rijksmuseum.nl";
  private static readonly IIIF_BASE = "https://iiif.micr.io";
  private static readonly WEB_BASE = "https://www.rijksmuseum.nl/en/collection";

  constructor() {
    this.http = axios.create({
      headers: { Accept: "application/ld+json" },
      timeout: 15_000,
    });
  }

  // ── Search ──────────────────────────────────────────────────────

  async search(params: SearchParams): Promise<SearchApiResponse> {
    const query: Record<string, string> = {};
    if (params.title) query.title = params.title;
    if (params.creator) query.creator = params.creator;
    if (params.objectNumber) query.objectNumber = params.objectNumber;
    if (params.type) query.type = params.type;
    if (params.material) query.material = params.material;
    if (params.technique) query.technique = params.technique;
    if (params.creationDate) query.creationDate = params.creationDate;
    if (params.pageToken) query.pageToken = params.pageToken;

    const { data } = await this.http.get<SearchApiResponse>(
      RijksmuseumApiClient.SEARCH_URL,
      { params: query }
    );
    return data;
  }

  // ── Resolve ─────────────────────────────────────────────────────

  async resolveObject(uri: string): Promise<LinkedArtObject> {
    const { data } = await this.http.get<LinkedArtObject>(uri);
    return data;
  }

  /** Search by objectNumber and resolve the first result */
  async findByObjectNumber(
    objectNumber: string
  ): Promise<{ uri: string; object: LinkedArtObject }> {
    const searchResult = await this.search({ objectNumber });
    const item = searchResult.orderedItems[0];
    if (!item) {
      throw new Error(`No object found with objectNumber: ${objectNumber}`);
    }
    const object = await this.resolveObject(item.id);
    return { uri: item.id, object };
  }

  // ── Image Chain ─────────────────────────────────────────────────

  /**
   * Follow the 4-step image discovery chain:
   * Object.shows → VisualItem.digitally_shown_by → DigitalObject.access_point → IIIF URL
   */
  async getImageInfo(object: LinkedArtObject): Promise<ArtworkImageInfo | null> {
    try {
      // Step 1: Get VisualItem reference from object
      const visualItemRef = object.shows?.[0];
      if (!visualItemRef?.id) return null;

      // Step 2: Resolve VisualItem to get DigitalObject reference
      const visualItem = await this.http.get<VisualItem>(visualItemRef.id);
      const digitalObjectRef = visualItem.data.digitally_shown_by?.[0];
      if (!digitalObjectRef?.id) return null;

      // Step 3: Resolve DigitalObject to get IIIF access point
      const digitalObject = await this.http.get<DigitalObject>(
        digitalObjectRef.id
      );
      const accessPoint = digitalObject.data.access_point?.[0];
      if (!accessPoint?.id) return null;

      // Step 4: Extract IIIF ID and fetch info.json
      const iiifId = extractIiifId(accessPoint.id);
      if (!iiifId) return null;

      const iiifInfoUrl = `${RijksmuseumApiClient.IIIF_BASE}/${iiifId}/info.json`;
      const { data: info } = await this.http.get<IIIFInfoResponse>(iiifInfoUrl);

      return {
        iiifId,
        iiifInfoUrl,
        thumbnailUrl: `${RijksmuseumApiClient.IIIF_BASE}/${iiifId}/full/!400,400/0/default.jpg`,
        fullUrl: `${RijksmuseumApiClient.IIIF_BASE}/${iiifId}/full/max/0/default.jpg`,
        width: info.width,
        height: info.height,
      };
    } catch {
      return null;
    }
  }

  /** Download a small IIIF thumbnail and return as base64 data URI */
  async fetchThumbnailBase64(
    iiifId: string,
    width: number = 200
  ): Promise<string> {
    const url = `${RijksmuseumApiClient.IIIF_BASE}/${iiifId}/full/!${width},${width}/0/default.jpg`;
    const { data } = await this.http.get(url, {
      responseType: "arraybuffer",
    });
    const base64 = Buffer.from(data).toString("base64");
    return base64;
  }

  // ── Parsers (static) ───────────────────────────────────────────

  /** Extract the preferred English title (brief text), falling back to any English name */
  static parseTitle(obj: LinkedArtObject): string {
    const names = (obj.identified_by ?? []).filter((i) => i.type === "Name");

    // Prefer English brief title
    const enBrief = names.find(
      (n) =>
        hasClassification(n.classified_as, AAT.BRIEF_TEXT) &&
        getLangId(n.language) === AAT.LANG_EN
    );
    if (enBrief) return enBrief.content;

    // Fallback: any English name
    const enName = names.find(
      (n) => getLangId(n.language) === AAT.LANG_EN
    );
    if (enName) return enName.content;

    // Fallback: Dutch brief title
    const nlBrief = names.find(
      (n) =>
        hasClassification(n.classified_as, AAT.BRIEF_TEXT) &&
        getLangId(n.language) === AAT.LANG_NL
    );
    if (nlBrief) return nlBrief.content;

    // Fallback: first name
    return names[0]?.content ?? "Untitled";
  }

  /** Extract object number from identified_by */
  static parseObjectNumber(obj: LinkedArtObject): string {
    const identifier = (obj.identified_by ?? []).find(
      (i) =>
        i.type === "Identifier" &&
        hasClassification(i.classified_as, AAT.OBJECT_NUMBER)
    );
    return identifier?.content ?? "";
  }

  /** Extract creator name from produced_by.referred_to_by (English creator statement) */
  static parseCreator(obj: LinkedArtObject): string {
    // Look in produced_by.referred_to_by for creator statement (AAT 300435416)
    const statements = obj.produced_by?.referred_to_by ?? [];
    const enCreator = statements.find(
      (s) =>
        hasClassification(s.classified_as, AAT.CREATOR_DESCRIPTION) &&
        getLangId(s.language) === AAT.LANG_EN
    );
    if (enCreator) return enCreator.content;

    // Fallback: English creator statement (300435416 has longer form like "painter: Rembrandt van Rijn, Amsterdam")
    const enStatement = statements.find(
      (s) =>
        hasClassification(s.classified_as, AAT.CREATOR_STATEMENT) &&
        getLangId(s.language) === AAT.LANG_EN
    );
    if (enStatement) return enStatement.content;

    // Fallback: any creator statement
    const anyCreator = statements.find(
      (s) =>
        hasClassification(s.classified_as, AAT.CREATOR_DESCRIPTION) ||
        hasClassification(s.classified_as, AAT.CREATOR_STATEMENT)
    );
    return anyCreator?.content ?? "Unknown";
  }

  /** Extract creation date from produced_by.timespan */
  static parseDate(obj: LinkedArtObject): string {
    const timespan = obj.produced_by?.timespan;
    if (!timespan) return "Unknown";

    // Prefer English date label
    const enDate = timespan.identified_by?.find(
      (i) => getLangId(i.language) === AAT.LANG_EN
    );
    if (enDate) return enDate.content;

    // Fallback: any date label
    const anyDate = timespan.identified_by?.[0];
    if (anyDate) return anyDate.content;

    // Fallback: extract year from begin_of_the_begin
    if (timespan.begin_of_the_begin) {
      return timespan.begin_of_the_begin.substring(0, 4);
    }

    return "Unknown";
  }

  /** Find a referred_to_by statement matching a given AAT classification, preferring English */
  private static findStatement(
    statements: ReferredToBy[] | undefined,
    aatUri: string
  ): string | null {
    if (!statements) return null;

    const matching = statements.filter((s) =>
      hasClassification(s.classified_as, aatUri)
    );

    // Prefer English
    const en = matching.find(
      (s) => getLangId(s.language) === AAT.LANG_EN
    );
    if (en) return en.content;

    return matching[0]?.content ?? null;
  }

  /** Find all referred_to_by statements matching a given AAT classification (English preferred) */
  private static findAllStatements(
    statements: ReferredToBy[] | undefined,
    aatUri: string
  ): string[] {
    if (!statements) return [];
    const matching = statements.filter((s) =>
      hasClassification(s.classified_as, aatUri)
    );

    // Prefer English versions, deduplicate
    const enItems = matching.filter(
      (s) => getLangId(s.language) === AAT.LANG_EN
    );
    if (enItems.length > 0) return enItems.map((s) => s.content);
    return matching.map((s) => s.content);
  }

  /** Parse location from current_location */
  static parseLocation(obj: LinkedArtObject): string | null {
    const loc = obj.current_location;
    if (!loc?.identified_by) return null;

    // Collect all identifier parts
    const parts: string[] = [];
    for (const id of loc.identified_by) {
      if (id.content) {
        parts.push(id.content);
      } else if ((id as any).part) {
        for (const p of (id as any).part) {
          if (p.content) parts.push(p.content);
        }
      }
    }
    return parts.length > 0 ? parts.join("-") : null;
  }

  // ── Mappers ────────────────────────────────────────────────────

  static toSummary(obj: LinkedArtObject, uri: string): ArtworkSummary {
    const objectNumber = RijksmuseumApiClient.parseObjectNumber(obj);
    return {
      id: uri,
      objectNumber,
      title: RijksmuseumApiClient.parseTitle(obj),
      creator: RijksmuseumApiClient.parseCreator(obj),
      date: RijksmuseumApiClient.parseDate(obj),
      url: objectNumber
        ? `${RijksmuseumApiClient.WEB_BASE}/${objectNumber}`
        : uri,
    };
  }

  static toDetail(obj: LinkedArtObject, uri: string): ArtworkDetail {
    const summary = RijksmuseumApiClient.toSummary(obj, uri);
    const statements = obj.referred_to_by;

    return {
      ...summary,
      description: RijksmuseumApiClient.findStatement(
        statements,
        AAT.DESCRIPTION
      ),
      techniqueStatement: RijksmuseumApiClient.findStatement(
        statements,
        AAT.TECHNIQUE_STATEMENT
      ),
      dimensionStatement: RijksmuseumApiClient.findStatement(
        statements,
        AAT.DIMENSION_STATEMENT
      ),
      provenance: RijksmuseumApiClient.findStatement(
        statements,
        AAT.PROVENANCE
      ),
      creditLine: RijksmuseumApiClient.findStatement(
        statements,
        AAT.CREDIT_LINE
      ),
      inscriptions: RijksmuseumApiClient.findAllStatements(
        statements,
        AAT.INSCRIPTIONS
      ),
      location: RijksmuseumApiClient.parseLocation(obj),
      collectionSets: (obj.member_of ?? []).map((m) => m.id),
      externalIds: Object.fromEntries(
        (obj.identified_by ?? [])
          .filter((i) => i.type === "Identifier")
          .map((i) => [i.content, i.classified_as?.[0] && typeof i.classified_as[0] !== "string" ? i.classified_as[0].id ?? "" : ""])
      ),
    };
  }

  // ── High-level methods for tools ──────────────────────────────

  /** Search and resolve results to summaries */
  async searchAndResolve(params: SearchParams): Promise<{
    totalResults: number;
    results: ArtworkSummary[];
    nextPageToken?: string;
  }> {
    const searchResponse = await this.search(params);
    const totalResults = searchResponse.partOf?.totalItems ?? searchResponse.orderedItems.length;
    const maxResults = params.maxResults ?? 10;

    // Take only up to maxResults items
    const items = searchResponse.orderedItems.slice(0, maxResults);

    // Resolve all items concurrently
    const resolved = await Promise.all(
      items.map(async (item) => {
        try {
          const obj = await this.resolveObject(item.id);
          return RijksmuseumApiClient.toSummary(obj, item.id);
        } catch {
          // If resolution fails, return a minimal summary
          return {
            id: item.id,
            objectNumber: "",
            title: "Unable to resolve",
            creator: "Unknown",
            date: "Unknown",
            url: item.id,
          } as ArtworkSummary;
        }
      })
    );

    // Extract next page token from URL if present
    let nextPageToken: string | undefined;
    if (searchResponse.next?.id) {
      const url = new URL(searchResponse.next.id);
      nextPageToken = url.searchParams.get("pageToken") ?? undefined;
    }

    return { totalResults, results: resolved, nextPageToken };
  }

  /** Search in compact mode — returns just count + IDs, no resolution */
  async searchCompact(params: SearchParams): Promise<{
    totalResults: number;
    ids: string[];
    nextPageToken?: string;
  }> {
    const searchResponse = await this.search(params);
    const totalResults = searchResponse.partOf?.totalItems ?? searchResponse.orderedItems.length;

    let nextPageToken: string | undefined;
    if (searchResponse.next?.id) {
      const url = new URL(searchResponse.next.id);
      nextPageToken = url.searchParams.get("pageToken") ?? undefined;
    }

    return {
      totalResults,
      ids: searchResponse.orderedItems.map((i) => i.id),
      nextPageToken,
    };
  }
}
