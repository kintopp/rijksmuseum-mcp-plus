import axios, { AxiosInstance } from "axios";
import {
  AAT,
  AAT_UNIT_LABELS,
  LinkedArtObject,
  ReferredToBy,
  SearchApiResponse,
  SearchParams,
  ArtworkSummary,
  ArtworkDetail,
  ArtworkDetailEnriched,
  ArtworkImageInfo,
  TitleVariant,
  StructuredDimension,
  RelatedObject,
  ResolvedTerm,
  ProductionParticipant,
  BibliographyEntry,
  BibliographyResult,
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

    // Map 'query' to 'title' — the API has no general full-text search,
    // and title is the most intuitive match for free-text queries.
    // Explicit 'title' takes precedence over 'query'.
    if (params.title) query.title = params.title;
    else if (params.query) query.title = params.query;

    if (params.creator) query.creator = params.creator;
    if (params.objectNumber) query.objectNumber = params.objectNumber;
    if (params.type) query.type = params.type;
    if (params.material) query.material = params.material;
    if (params.technique) query.technique = params.technique;
    if (params.creationDate) query.creationDate = params.creationDate;
    if (params.description) query.description = params.description;
    if (params.pageToken) query.pageToken = params.pageToken;

    // Guard against unfiltered searches — the API returns the entire
    // collection (837K+ items) when no filters are provided.
    const hasFilter = Object.keys(query).some((k) => k !== "pageToken");
    if (!hasFilter) {
      throw new Error(
        "At least one search filter is required (e.g. title, creator, type, material, technique, creationDate, or description). " +
        "Searching without any filter would return the entire collection."
      );
    }

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

  // ── Group A Parsers (no HTTP) ─────────────────────────────────

  /** Extract all title variants with language and qualifier */
  static parseTitles(obj: LinkedArtObject): TitleVariant[] {
    return (obj.identified_by ?? [])
      .filter((i) => i.type === "Name")
      .map((n) => {
        const langId = getLangId(n.language);
        const language: TitleVariant["language"] =
          langId === AAT.LANG_EN ? "en" : langId === AAT.LANG_NL ? "nl" : "other";

        const isBrief =
          hasClassification(n.classified_as, AAT.BRIEF_TEXT) ||
          hasClassification(n.classified_as, AAT.TITLE_TYPE);
        const isFull = hasClassification(n.classified_as, AAT.FULL_TITLE);
        const qualifier: TitleVariant["qualifier"] = isBrief
          ? "brief"
          : isFull
            ? "full"
            : "other";

        return { title: n.content, language, qualifier };
      });
  }

  /** Extract curatorial narrative (museum wall text) in EN and NL */
  static parseNarrative(obj: LinkedArtObject): {
    en: string | null;
    nl: string | null;
  } {
    let en: string | null = null;
    let nl: string | null = null;

    for (const s of obj.subject_of ?? []) {
      // Language is on the parent subject_of entry, not on parts
      const langId = getLangId(s.language);
      const isEn = langId === AAT.LANG_EN;
      const isNl = langId === AAT.LANG_NL;
      if (!isEn && !isNl) continue;

      // Find the narrative part classified as AAT description (300048722)
      for (const p of s.part ?? []) {
        if (
          p.content &&
          hasClassification(p.classified_as, AAT.NARRATIVE)
        ) {
          if (isEn && !en) en = p.content;
          if (isNl && !nl) nl = p.content;
        }
      }
    }
    return { en, nl };
  }

  /** Extract license/rights URI (e.g. CC0) */
  static parseLicense(obj: LinkedArtObject): string | null {
    for (const s of obj.subject_of ?? []) {
      for (const st of s.subject_to ?? []) {
        if (st.classified_as?.[0]) {
          const cls = st.classified_as[0];
          const uri = typeof cls === "string" ? cls : cls.id;
          if (uri) return uri;
        }
      }
    }
    return null;
  }

  /** Extract web page URL from subject_of with digitally_carried_by */
  static parseWebPage(obj: LinkedArtObject): string | null {
    for (const s of obj.subject_of ?? []) {
      for (const d of s.digitally_carried_by ?? []) {
        if (d.format === "text/html" && d.access_point?.[0]?.id) {
          return d.access_point[0].id;
        }
      }
    }
    return null;
  }

  /** Extract structured numeric dimensions (value + unit + label) */
  static parseDimensions(obj: LinkedArtObject): StructuredDimension[] {
    return (obj.dimension ?? [])
      .filter((d) => d.value != null)
      .map((d) => {
        const unitUri = d.unit?.id ?? d.unit?._label ?? "";
        const unit = AAT_UNIT_LABELS[unitUri] ?? unitUri;
        const typeUri = d.classified_as?.[0]?.id ?? "";
        const note = d.referred_to_by?.[0]?.content ?? null;
        return { type: typeUri, value: d.value!, unit, note };
      });
  }

  /** Extract related object references from attributed_by */
  static parseRelatedObjects(obj: LinkedArtObject): RelatedObject[] {
    const results: RelatedObject[] = [];
    for (const a of obj.attributed_by ?? []) {
      // Prefer English label
      const labels = a.identified_by ?? [];
      const enLabel = labels.find(
        (l) => getLangId(l.language) === AAT.LANG_EN
      );
      const label = enLabel?.content ?? labels[0]?.content ?? "related";
      const uri = a.assigned?.[0]?.id;
      if (uri) results.push({ relationship: label, objectUri: uri });
    }
    // Deduplicate by URI (EN and NL labels create duplicate entries)
    const seen = new Set<string>();
    return results.filter((r) => {
      if (seen.has(r.objectUri)) return false;
      seen.add(r.objectUri);
      return true;
    });
  }

  /** Extract persistent identifier (handle.net) from equivalent */
  static parsePersistentId(obj: LinkedArtObject): string | null {
    return obj.equivalent?.[0]?.id ?? null;
  }

  /** Count bibliography entries (for discoverability) */
  static parseBibliographyCount(obj: LinkedArtObject): number {
    return (obj.assigned_by ?? []).filter((a) =>
      hasClassification(a.classified_as, AAT.CITATION)
    ).length;
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

  // ── Vocabulary Resolution (Group B) ───────────────────────────

  /**
   * Resolve a Rijksmuseum vocabulary URI to extract the English label
   * and external equivalents (AAT, Wikidata).
   */
  async resolveVocabTerm(uri: string): Promise<ResolvedTerm> {
    const { data } = await this.http.get(uri);

    // Extract English label, falling back to Dutch, then _label, then URI
    const names = ((data.identified_by ?? []) as any[]).filter(
      (i: any) => i.type === "Name"
    );
    const enName = names.find(
      (n: any) => getLangId(n.language) === AAT.LANG_EN
    );
    const nlName = names.find(
      (n: any) => getLangId(n.language) === AAT.LANG_NL
    );
    const label =
      enName?.content ?? nlName?.content ?? data._label ?? uri.split("/").pop() ?? uri;

    // Extract external equivalents (AAT, Wikidata)
    const equivalents: Record<string, string> = {};
    for (const eq of (data.equivalent ?? []) as any[]) {
      const eqId: string = eq.id ?? "";
      if (eqId.includes("vocab.getty.edu")) equivalents.aat = eqId;
      else if (eqId.includes("wikidata.org")) equivalents.wikidata = eqId;
    }

    return {
      id: uri,
      label,
      ...(Object.keys(equivalents).length > 0 ? { equivalents } : {}),
    };
  }

  /**
   * Batch-resolve all vocabulary URIs from a Linked Art object.
   * Returns resolved terms for object types, materials, production
   * participants, collection sets, and dimension types.
   */
  async resolveVocabulary(obj: LinkedArtObject): Promise<{
    objectTypes: ResolvedTerm[];
    materials: ResolvedTerm[];
    production: ProductionParticipant[];
    collectionSetLabels: ResolvedTerm[];
    dimensionTypeLabels: Map<string, string>;
  }> {
    // Collect all URIs that need resolution
    const typeUris = (obj.classified_as ?? [])
      .map((c) => (typeof c === "string" ? c : c.id))
      .filter(Boolean) as string[];
    const materialUris = (obj.made_of ?? [])
      .map((m) => m.id)
      .filter(Boolean);
    const collectionUris = (obj.member_of ?? [])
      .map((m) => m.id)
      .filter(Boolean);

    // Production parts: collect actor, technique, place URIs
    const prodParts = obj.produced_by?.part ?? [];
    const actorUris = prodParts.flatMap(
      (p) => (p.carried_out_by ?? []).map((a) => a.id).filter(Boolean)
    );
    const techniqueUris = prodParts.flatMap(
      (p) => (p.technique ?? []).map((t) => t.id).filter(Boolean)
    );
    const placeUris = prodParts.flatMap(
      (p) => (p.took_place_at ?? []).map((pl) => pl.id).filter(Boolean)
    );

    // Dimension type URIs (Rijksmuseum vocabulary)
    const dimTypeUris = [
      ...new Set(
        (obj.dimension ?? [])
          .map((d) => d.classified_as?.[0]?.id)
          .filter(Boolean) as string[]
      ),
    ];

    // Deduplicate all URIs for batch resolution
    const allUris = [
      ...new Set([
        ...typeUris,
        ...materialUris,
        ...collectionUris,
        ...actorUris,
        ...techniqueUris,
        ...placeUris,
        ...dimTypeUris,
      ]),
    ];

    // Resolve all in parallel
    const settled = await Promise.allSettled(
      allUris.map((uri) => this.resolveVocabTerm(uri))
    );
    const resolved = new Map<string, ResolvedTerm>();
    for (let i = 0; i < allUris.length; i++) {
      const result = settled[i];
      if (result.status === "fulfilled") {
        resolved.set(allUris[i], result.value);
      }
    }

    // Map results back to categories
    const objectTypes = typeUris
      .map((u) => resolved.get(u))
      .filter(Boolean) as ResolvedTerm[];
    const materials = materialUris
      .map((u) => resolved.get(u))
      .filter(Boolean) as ResolvedTerm[];
    const collectionSetLabels = collectionUris
      .map((u) => resolved.get(u))
      .filter(Boolean) as ResolvedTerm[];

    // Build production participants
    const production: ProductionParticipant[] = prodParts.map((p) => {
      const actorUri = p.carried_out_by?.[0]?.id ?? "";
      const actor = resolved.get(actorUri);
      const tech = p.technique?.[0]?.id
        ? resolved.get(p.technique[0].id)
        : undefined;
      const place = p.took_place_at?.[0]?.id
        ? resolved.get(p.took_place_at[0].id)
        : undefined;

      return {
        name: actor?.label ?? "Unknown",
        role: tech?.label ?? null,
        place: place?.label ?? null,
        actorUri,
      };
    });

    // Build dimension type label lookup
    const dimensionTypeLabels = new Map<string, string>();
    for (const uri of dimTypeUris) {
      const term = resolved.get(uri);
      if (term) dimensionTypeLabels.set(uri, term.label);
    }

    return {
      objectTypes,
      materials,
      production,
      collectionSetLabels,
      dimensionTypeLabels,
    };
  }

  /**
   * Full enriched detail: static parsing + vocabulary resolution.
   * Returns all 24 metadata categories (everything except bibliography).
   */
  async toDetailEnriched(
    obj: LinkedArtObject,
    uri: string
  ): Promise<ArtworkDetailEnriched> {
    const base = RijksmuseumApiClient.toDetail(obj, uri);

    // Group A: static parsing
    const titles = RijksmuseumApiClient.parseTitles(obj);
    const curatorialNarrative = RijksmuseumApiClient.parseNarrative(obj);
    const license = RijksmuseumApiClient.parseLicense(obj);
    const webPage = RijksmuseumApiClient.parseWebPage(obj);
    const rawDimensions = RijksmuseumApiClient.parseDimensions(obj);
    const relatedObjects = RijksmuseumApiClient.parseRelatedObjects(obj);
    const persistentId = RijksmuseumApiClient.parsePersistentId(obj);
    const bibliographyCount =
      RijksmuseumApiClient.parseBibliographyCount(obj);

    // Group B: vocabulary resolution
    const vocab = await this.resolveVocabulary(obj);

    // Enrich dimensions with resolved type labels
    const dimensions = rawDimensions.map((d) => ({
      ...d,
      type: vocab.dimensionTypeLabels.get(d.type) ?? d.type,
    }));

    return {
      ...base,
      titles,
      curatorialNarrative,
      license,
      webPage,
      dimensions,
      relatedObjects,
      persistentId,
      objectTypes: vocab.objectTypes,
      materials: vocab.materials,
      production: vocab.production,
      collectionSetLabels: vocab.collectionSetLabels,
      bibliographyCount,
    };
  }

  // ── Bibliography ──────────────────────────────────────────────

  /**
   * Resolve a Schema.org Book URI (publication or BIBFRAME Instance).
   * Returns author, title, place, year, ISBN, WorldCat, library URL.
   */
  private async resolveSchemaOrgBook(
    uri: string
  ): Promise<Record<string, any> | null> {
    try {
      const { data } = await this.http.get(uri);
      return data;
    } catch {
      return null;
    }
  }

  /** Format a Schema.org Book record as a plaintext citation */
  private static formatBookCitation(
    book: Record<string, any>,
    pages?: string
  ): string {
    const parts: string[] = [];

    if (book.creditText) parts.push(book.creditText);
    if (book.name) parts.push(book.name);

    const pub = book.publication?.[0];
    const locParts: string[] = [];
    if (pub?.location?.name) locParts.push(pub.location.name);
    if (pub?.startDate) locParts.push(pub.startDate);
    if (locParts.length > 0) parts.push(`(${locParts.join(", ")})`);

    if (pages) parts.push(pages);

    return parts.join(", ");
  }

  /** Generate a BibTeX key from author + year or fallback */
  private static makeBibtexKey(
    book: Record<string, any> | null,
    index: number
  ): string {
    if (book?.creditText) {
      const first = book.creditText.split(/[,;]/)[0].trim();
      const surname = first.split(/\s+/).pop()?.replace(/[^a-zA-Z]/g, "") ?? "";
      const year = book.publication?.[0]?.startDate ?? "";
      if (surname) return `${surname}${year}`.toLowerCase();
    }
    return `ref_${index}`;
  }

  /** Escape special BibTeX characters */
  private static bibtexEscape(s: string): string {
    return s.replace(/[&%$#_{}~^\\]/g, (c) => `\\${c}`);
  }

  /** Format a Schema.org Book as a BibTeX entry */
  private static formatBibtex(
    book: Record<string, any> | null,
    pages: string | undefined,
    index: number,
    citationString?: string
  ): string {
    // If no resolved book data, fall back to @misc with citation string
    if (!book) {
      const key = `ref_${index}`;
      const note = RijksmuseumApiClient.bibtexEscape(citationString ?? "");
      return `@misc{${key},\n  note = {${note}}\n}`;
    }

    const key = RijksmuseumApiClient.makeBibtexKey(book, index);
    const entryType = pages ? "incollection" : "book";
    const fields: string[] = [];

    if (book.creditText)
      fields.push(
        `  author = {${RijksmuseumApiClient.bibtexEscape(book.creditText)}}`
      );
    if (book.name)
      fields.push(
        `  title = {${RijksmuseumApiClient.bibtexEscape(book.name)}}`
      );

    const pub = book.publication?.[0];
    if (pub?.publishedBy?.name)
      fields.push(
        `  publisher = {${RijksmuseumApiClient.bibtexEscape(pub.publishedBy.name)}}`
      );
    if (pub?.location?.name)
      fields.push(
        `  address = {${RijksmuseumApiClient.bibtexEscape(pub.location.name)}}`
      );
    if (pub?.startDate) fields.push(`  year = {${pub.startDate}}`);

    if (book.isbn) fields.push(`  isbn = {${book.isbn}}`);
    if (pages)
      fields.push(
        `  pages = {${pages.replace(/^p\.\s*/, "").replace(/-/g, "--")}}`
      );
    if (book.url)
      fields.push(`  url = {${book.url}}`);

    return `@${entryType}{${key},\n${fields.join(",\n")}\n}`;
  }

  /**
   * Get bibliography for a Linked Art object.
   * Parses assigned_by entries, optionally resolves publication URIs.
   * @param limit Max entries to return (0 = all)
   */
  async getBibliography(
    obj: LinkedArtObject,
    options: { limit?: number; format?: "text" | "bibtex" } = {}
  ): Promise<BibliographyResult> {
    const { limit = 0, format = "text" } = options;
    const objectNumber = RijksmuseumApiClient.parseObjectNumber(obj);

    // Filter to citation entries only
    const citationEntries = (obj.assigned_by ?? []).filter((a: any) =>
      hasClassification(a.classified_as, AAT.CITATION)
    );
    const total = citationEntries.length;

    // Apply limit (0 = all)
    const entries = limit > 0 ? citationEntries.slice(0, limit) : citationEntries;

    // Categorize entries and collect URIs to resolve
    interface ParsedEntry {
      type: "A" | "B" | "C";
      sequence: number | null;
      citationString?: string;
      pages?: string;
      resolveUri?: string;
    }

    const parsed: ParsedEntry[] = entries.map((entry: any) => {
      const assigned = entry.assigned?.[0];
      const seq = entry.identified_by
        ?.find((i: any) =>
          hasClassification(
            i.classified_as,
            "http://vocab.getty.edu/aat/300456575"
          )
        )
        ?.content;
      const sequence = seq ? parseInt(seq) : null;

      if (!assigned) {
        return { type: "B" as const, sequence, citationString: "" };
      }

      // Type B: has inline citation string
      const citId = assigned.identified_by?.find((i: any) =>
        hasClassification(
          i.classified_as,
          "http://vocab.getty.edu/aat/300311705"
        )
      );
      const citationString = citId?.content ?? citId?.part?.[0]?.content;

      // Type A: has part_of (publication reference)
      if (assigned.part_of?.[0]?.id) {
        const pages = assigned.identified_by
          ?.find((i: any) =>
            hasClassification(
              i.classified_as,
              "http://vocab.getty.edu/aat/300311705"
            )
          )
          ?.part?.[0]?.content;
        return {
          type: "A" as const,
          sequence,
          pages,
          resolveUri: assigned.part_of[0].id,
        };
      }

      // Type C: BIBFRAME Instance (bare URI)
      if (
        assigned.type === "http://id.loc.gov/ontologies/bibframe/Instance" &&
        assigned.id
      ) {
        return {
          type: "C" as const,
          sequence,
          resolveUri: assigned.id,
        };
      }

      // Type B: inline citation string
      return { type: "B" as const, sequence, citationString };
    });

    // Resolve all publication URIs in parallel
    const urisToResolve = [
      ...new Set(
        parsed
          .map((p) => p.resolveUri)
          .filter(Boolean) as string[]
      ),
    ];

    const resolved = new Map<string, Record<string, any>>();
    if (urisToResolve.length > 0) {
      const settled = await Promise.allSettled(
        urisToResolve.map((uri) => this.resolveSchemaOrgBook(uri))
      );
      for (let i = 0; i < urisToResolve.length; i++) {
        const result = settled[i];
        if (result.status === "fulfilled" && result.value) {
          resolved.set(urisToResolve[i], result.value);
        }
      }
    }

    // Build output entries
    const bibEntries: BibliographyEntry[] = parsed.map((p, i) => {
      const book = p.resolveUri ? resolved.get(p.resolveUri) ?? null : null;

      let citation: string;
      if (format === "bibtex") {
        citation = RijksmuseumApiClient.formatBibtex(
          book,
          p.pages,
          i + 1,
          p.citationString
        );
      } else if (p.type === "B" && p.citationString) {
        citation = p.citationString;
      } else if (book) {
        citation = RijksmuseumApiClient.formatBookCitation(book, p.pages);
      } else {
        citation = p.citationString ?? "(unresolvable reference)";
      }

      const entry: BibliographyEntry = {
        sequence: p.sequence,
        citation,
      };

      // Add enrichment fields from resolved book
      if (book) {
        if (p.resolveUri) entry.publicationUri = p.resolveUri;
        if (p.pages) entry.pages = p.pages;
        if (book.isbn) entry.isbn = book.isbn;
        if (book.sameAs) entry.worldcatUri = book.sameAs;
        if (book.url) entry.libraryUrl = book.url;
      }

      return entry;
    });

    // Sort by sequence number where available
    bibEntries.sort((a, b) => (a.sequence ?? 9999) - (b.sequence ?? 9999));

    return { objectNumber, total, entries: bibEntries };
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
