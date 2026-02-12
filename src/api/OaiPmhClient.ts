import axios, { AxiosInstance } from "axios";
import { XMLParser } from "fast-xml-parser";
import type {
  OaiSet,
  OaiRecordHeader,
  OaiCreator,
  OaiParsedRecord,
  OaiSubject,
  OaiListResult,
} from "../types.js";

// ─── Constants ───────────────────────────────────────────────────

const OAI_BASE_URL = "https://data.rijksmuseum.nl/oai";
const EDM_PREFIX = "edm";

// Elements that may appear once or many times in OAI-PMH / EDM responses.
// fast-xml-parser needs to know which tags to always wrap in arrays.
const ARRAY_TAGS = new Set([
  "set",
  "record",
  "header",
  "setSpec",
  "dc:title",
  "dc:description",
  "dc:subject",
  "dc:type",
  "dc:creator",
  "dc:identifier",
  "dcterms:isPartOf",
  "dcterms:medium",
  "dcterms:extent",
  "dcterms:isReferencedBy",
  "dcterms:created",
  "rdf:Description",
  "skos:Concept",
  "owl:sameAs",
  "skos:prefLabel",
  "skos:altLabel",
  "edm:WebResource",
  "ore:Aggregation",
  "edm:ProvidedCHO",
  "edm:Place",
  "edm:Agent",
  "svcs:has_service",
]);

// ─── Client ──────────────────────────────────────────────────────

export class OaiPmhClient {
  private http: AxiosInstance;
  private parser: XMLParser;

  constructor() {
    this.http = axios.create({
      baseURL: OAI_BASE_URL,
      timeout: 30_000,
      headers: { Accept: "text/xml" },
    });

    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@",
      removeNSPrefix: false,
      isArray: (tagName) => ARRAY_TAGS.has(tagName),
      trimValues: true,
    });
  }

  // ── Raw OAI request ──────────────────────────────────────────

  private async oaiRequest(
    params: Record<string, string>
  ): Promise<Record<string, any>> {
    const { data } = await this.http.get("", { params });
    const parsed = this.parser.parse(data);

    // The root element is OAI-PMH (or OAI-PMH with namespace prefix)
    const root =
      parsed["OAI-PMH"] ?? parsed["oai:OAI-PMH"] ?? parsed;

    OaiPmhClient.checkOaiError(root);
    return root;
  }

  // ── Error handling ───────────────────────────────────────────

  private static checkOaiError(root: Record<string, any>): void {
    const error = root.error;
    if (!error) return;

    const code =
      typeof error === "object" ? error["@code"] ?? "" : "";
    const message =
      typeof error === "object"
        ? error["#text"] ?? error["@code"] ?? "Unknown OAI-PMH error"
        : String(error);

    // noRecordsMatch is not really an error — it means the query
    // returned zero results, which is a valid empty response.
    if (code === "noRecordsMatch") return;

    throw new Error(`OAI-PMH error [${code}]: ${message}`);
  }

  // ── Shared OAI helpers ──────────────────────────────────────

  /**
   * Build OAI-PMH request params. A resumption token overrides all
   * other parameters per the OAI-PMH spec.
   */
  private static buildOaiParams(
    verb: string,
    opts: { set?: string; from?: string; until?: string; resumptionToken?: string }
  ): Record<string, string> {
    if (opts.resumptionToken) {
      return { verb, resumptionToken: opts.resumptionToken };
    }
    const params: Record<string, string> = { verb, metadataPrefix: EDM_PREFIX };
    if (opts.set) params.set = opts.set;
    if (opts.from) params.from = opts.from;
    if (opts.until) params.until = opts.until;
    return params;
  }

  /**
   * Extract records, resumptionToken, and completeListSize from an
   * OAI-PMH list response. Shared by ListRecords and ListIdentifiers.
   */
  private static parseListResponse<T>(
    root: Record<string, any>,
    responseKey: string,
    itemKey: string,
    parseItem: (raw: any) => T
  ): OaiListResult<T> {
    const empty: OaiListResult<T> = { records: [], completeListSize: null, resumptionToken: null };

    const container = root[responseKey];
    if (!container) return empty;

    const records = (container[itemKey] ?? []).map(parseItem);

    const token = container.resumptionToken;
    const resumptionToken =
      typeof token === "object" ? token["#text"] ?? null : token ?? null;
    const completeListSize =
      typeof token === "object" && token["@completeListSize"]
        ? parseInt(token["@completeListSize"])
        : null;

    return { records, completeListSize, resumptionToken };
  }

  // ── ListSets ─────────────────────────────────────────────────

  async listSets(): Promise<OaiSet[]> {
    const root = await this.oaiRequest({ verb: "ListSets" });
    const rawSets = root.ListSets?.set ?? [];

    return rawSets.map((s: any) => {
      const spec = String(s.setSpec ?? "");
      return {
        setSpec: spec,
        name: String(s.setName ?? ""),
        lodUri: `https://id.rijksmuseum.nl/${spec}`,
      };
    });
  }

  // ── ListRecords ──────────────────────────────────────────────

  async listRecords(opts: {
    set?: string;
    from?: string;
    until?: string;
    resumptionToken?: string;
  }): Promise<OaiListResult<OaiParsedRecord>> {
    const params = OaiPmhClient.buildOaiParams("ListRecords", opts);
    const root = await this.oaiRequest(params);
    return OaiPmhClient.parseListResponse(root, "ListRecords", "record", OaiPmhClient.parseEdmRecord);
  }

  // ── ListIdentifiers ──────────────────────────────────────────

  async listIdentifiers(opts: {
    set?: string;
    from?: string;
    until?: string;
    resumptionToken?: string;
  }): Promise<OaiListResult<OaiRecordHeader>> {
    const params = OaiPmhClient.buildOaiParams("ListIdentifiers", opts);
    const root = await this.oaiRequest(params);
    return OaiPmhClient.parseListResponse(root, "ListIdentifiers", "header", OaiPmhClient.parseHeader);
  }

  // ── Header parser ────────────────────────────────────────────

  private static parseHeader(header: any): OaiRecordHeader {
    const specs = header.setSpec ?? [];
    return {
      identifier: String(header.identifier ?? ""),
      datestamp: String(header.datestamp ?? ""),
      setSpecs: (Array.isArray(specs) ? specs : [specs]).map(String),
    };
  }

  // ── EDM Record Parser ───────────────────────────────────────

  private static parseEdmRecord(record: any): OaiParsedRecord {
    // Header (may be wrapped in array by isArray callback)
    const rawHeader = record.header;
    const header = Array.isArray(rawHeader) ? rawHeader[0] ?? {} : rawHeader ?? {};
    const datestamp = String(header.datestamp ?? "");
    const setSpecs = (header.setSpec ?? []).map(String);
    const identifier = String(header.identifier ?? "");

    // RDF container
    const metadata = record.metadata ?? {};
    const rdf = metadata["rdf:RDF"] ?? {};

    // Build entity map for resolving resource references
    const entityMap = OaiPmhClient.buildEntityMap(rdf);

    // Navigate: ore:Aggregation → edm:aggregatedCHO → edm:ProvidedCHO
    const aggArray = rdf["ore:Aggregation"] ?? [];
    const agg = aggArray[0] ?? {};
    const aggregatedCHO = agg["edm:aggregatedCHO"] ?? {};
    const choRaw = aggregatedCHO["edm:ProvidedCHO"] ?? [];
    const cho = Array.isArray(choRaw) ? choRaw[0] ?? {} : choRaw;

    // Extract identifiers — objectNumber is dc:identifier
    const dcIdentifiers = cho["dc:identifier"] ?? [];
    const objectNumber = OaiPmhClient.firstText(dcIdentifiers) ?? "";

    // lodUri: prefer the cho @rdf:about, fall back to header identifier
    const lodUri = cho["@rdf:about"] ?? identifier;

    // Title
    const title = OaiPmhClient.preferLang(cho["dc:title"]);

    // Description
    const description = OaiPmhClient.preferLang(cho["dc:description"]);

    // Date (language-tagged)
    const dates = cho["dcterms:created"] ?? [];
    const date = OaiPmhClient.preferLang(Array.isArray(dates) ? dates : [dates]);

    // Dimensions (language-tagged)
    const extents = cho["dcterms:extent"] ?? [];
    const dimensions = OaiPmhClient.preferLang(Array.isArray(extents) ? extents : [extents]);

    // Type — resolve first dc:type resource reference
    const typeEntity = OaiPmhClient.resolveFirstEntity(cho["dc:type"] ?? [], entityMap);
    const type = typeEntity ? OaiPmhClient.preferLangFromEntity(typeEntity) : null;

    // edm:type (plain text like "IMAGE")
    const rawEdmType = cho["edm:type"];
    const edmType = typeof rawEdmType === "string"
      ? rawEdmType
      : rawEdmType?.["#text"] ?? null;

    // Materials — resolve all dcterms:medium labels
    const materials = OaiPmhClient.resolveAllLabels(cho["dcterms:medium"] ?? [], entityMap);

    // Creator — resolve first dc:creator reference
    const creatorEntity = OaiPmhClient.resolveFirstEntity(cho["dc:creator"] ?? [], entityMap);
    const creator = creatorEntity ? OaiPmhClient.parseCreatorFromEntity(creatorEntity) : null;

    // Image URL from ore:Aggregation
    const imageUrl = OaiPmhClient.resourceUri(agg["edm:object"]);

    // IIIF service URL from ore:Aggregation → edm:isShownBy → edm:WebResource → svcs:has_service
    const iiifServiceUrl = OaiPmhClient.extractIiifServiceUrl(agg);

    // Rights from ore:Aggregation
    const rights = OaiPmhClient.resourceUri(agg["edm:rights"]);

    // Set memberships — resolve all dcterms:isPartOf labels
    const setMemberships = OaiPmhClient.resolveAllLabels(cho["dcterms:isPartOf"] ?? [], entityMap);

    // Subjects — resolve dc:subject references into typed entries
    const subjects = OaiPmhClient.resolveSubjects(cho["dc:subject"] ?? [], entityMap);

    return {
      lodUri,
      objectNumber,
      datestamp,
      title,
      description,
      date,
      dimensions,
      type,
      materials,
      edmType,
      creator,
      imageUrl,
      iiifServiceUrl,
      rights,
      setMemberships,
      subjects,
    };
  }

  // ── Entity Map & Resource Resolution ────────────────────────

  /**
   * Build a lookup map from rdf:about URIs to their entity objects.
   * EDM records embed rdf:Description and skos:Concept blocks that
   * are referenced by URI from ProvidedCHO fields.
   */
  private static buildEntityMap(rdf: any): Map<string, any> {
    const map = new Map<string, any>();

    for (const tag of ["rdf:Description", "skos:Concept", "edm:Place", "edm:Agent"]) {
      const entities = rdf[tag] ?? [];
      for (const entity of entities) {
        const about = entity["@rdf:about"];
        if (about) map.set(about, { ...entity, _entityTag: tag });
      }
    }

    return map;
  }

  /** Extract @rdf:resource from an element that may be a resource reference. */
  private static resourceUri(item: any): string | null {
    return typeof item === "object" ? item["@rdf:resource"] ?? null : null;
  }

  /**
   * Resolve the first entity from a list of resource references.
   * Returns the entity object, or null if none resolve.
   */
  private static resolveFirstEntity(
    items: any[],
    entityMap: Map<string, any>
  ): any | null {
    for (const item of items) {
      const uri = OaiPmhClient.resourceUri(item);
      if (uri) {
        const entity = entityMap.get(uri);
        if (entity) return entity;
      }
    }
    return null;
  }

  /**
   * Walk ore:Aggregation → edm:isShownBy → edm:WebResource → svcs:has_service
   * to find the IIIF service URL.
   */
  private static extractIiifServiceUrl(agg: any): string | null {
    const isShownBy = agg["edm:isShownBy"] ?? {};
    const webResources = isShownBy["edm:WebResource"] ?? [];
    const wrArray = Array.isArray(webResources) ? webResources : [webResources];

    for (const wr of wrArray) {
      if (!wr || typeof wr !== "object") continue;
      const services = wr["svcs:has_service"] ?? [];
      const svcArray = Array.isArray(services) ? services : [services];
      for (const svc of svcArray) {
        const uri = OaiPmhClient.resourceUri(svc);
        if (uri) return uri;
      }
    }
    return null;
  }

  /**
   * Resolve all labels from a list of resource references.
   * Returns an array of non-null preferred-language labels.
   */
  private static resolveAllLabels(
    items: any[],
    entityMap: Map<string, any>
  ): string[] {
    const labels: string[] = [];
    for (const item of items) {
      const uri = OaiPmhClient.resourceUri(item);
      if (uri) {
        const entity = entityMap.get(uri);
        if (entity) {
          const label = OaiPmhClient.preferLangFromEntity(entity);
          if (label) labels.push(label);
        }
      }
    }
    return labels;
  }

  // ── Language helpers ─────────────────────────────────────────

  /**
   * From an array of dc: text fields (which may have @xml:lang),
   * prefer English, then Dutch, then any.
   */
  private static preferLang(fields: any[] | undefined): string | null {
    if (!fields || fields.length === 0) return null;

    let en: string | null = null;
    let nl: string | null = null;
    let fallback: string | null = null;

    for (const f of fields) {
      // fast-xml-parser auto-converts numeric text (e.g. "1619") to numbers
      const raw = typeof f === "string" || typeof f === "number"
        ? f
        : f["#text"] ?? null;
      if (raw == null) continue;
      const text = String(raw);

      const lang = typeof f === "object" ? f["@xml:lang"] : null;
      if (lang === "en" && !en) en = text;
      else if (lang === "nl" && !nl) nl = text;
      else if (!fallback) fallback = text;
    }

    return en ?? nl ?? fallback;
  }

  /**
   * Extract preferred language label from a resolved entity
   * (rdf:Description or skos:Concept with skos:prefLabel).
   */
  private static preferLangFromEntity(entity: any): string | null {
    const labels = entity["skos:prefLabel"] ?? [];
    if (labels.length === 0) {
      // Fall back to rdfs:label or skos:altLabel
      const alt = entity["skos:altLabel"] ?? entity["rdfs:label"];
      if (alt) {
        const arr = Array.isArray(alt) ? alt : [alt];
        return OaiPmhClient.preferLang(arr);
      }
      return null;
    }
    return OaiPmhClient.preferLang(labels);
  }

  /** Extract the text from the first element in an array */
  private static firstText(fields: any[]): string | null {
    if (!fields || fields.length === 0) return null;
    const f = fields[0];
    return typeof f === "string" ? f : f["#text"] ?? null;
  }

  // ── Creator parser ──────────────────────────────────────────

  /**
   * Extract a text value from an XML field that may be a plain value
   * or an object with #text. Returns null for empty/missing values.
   */
  private static extractText(raw: any): string | null {
    if (raw == null) return null;
    const text = String(typeof raw === "object" ? raw["#text"] ?? "" : raw);
    return text || null;
  }

  /**
   * Resolve dc:subject references into typed OaiSubject entries.
   * Classifies each subject by entity tag (edm:Place, edm:Agent)
   * or as Iconclass for skos:Concept / rdf:Description entities.
   */
  private static resolveSubjects(
    subjectRefs: any[],
    entityMap: Map<string, any>
  ): OaiSubject[] {
    const subjects: OaiSubject[] = [];

    for (const ref of subjectRefs) {
      const uri = OaiPmhClient.resourceUri(ref);
      if (!uri) continue;

      const entity = entityMap.get(uri);
      if (!entity) continue;

      const label = OaiPmhClient.preferLangFromEntity(entity) ?? uri.split("/").pop() ?? uri;
      const tag: string = entity._entityTag ?? "";

      if (tag === "edm:Place" || tag === "edm:Agent") {
        const subject: OaiSubject = {
          label,
          type: tag === "edm:Place" ? "place" : "person",
        };
        const extUri = OaiPmhClient.extractSameAsUri(entity);
        if (extUri) subject.uri = extUri;
        subjects.push(subject);
      } else {
        // skos:Concept or rdf:Description — Iconclass subject
        const subject: OaiSubject = { label, type: "iconclass" };

        // Prefer Iconclass URI from owl:sameAs, fall back to any other
        const extUri = OaiPmhClient.extractSameAsUri(entity, "iconclass.org")
          ?? OaiPmhClient.extractSameAsUri(entity);
        if (extUri) subject.uri = extUri;

        // Extract Iconclass notation code from skos:altLabel (starts with digit)
        const altLabels = entity["skos:altLabel"] ?? [];
        const altArr = Array.isArray(altLabels) ? altLabels : [altLabels];
        const code = altArr
          .map((a: any) => (typeof a === "string" ? a : a["#text"] ?? ""))
          .find((t: string) => /^[0-9]/.test(t));
        if (code) subject.code = code;

        subjects.push(subject);
      }
    }

    return subjects;
  }

  /**
   * Extract an owl:sameAs URI from an entity.
   * If domainHint is provided, returns the first URI containing that string.
   * Otherwise returns the first available URI.
   */
  private static extractSameAsUri(entity: any, domainHint?: string): string | null {
    for (const sa of entity["owl:sameAs"] ?? []) {
      const uri = typeof sa === "object" ? sa["@rdf:resource"] : sa;
      if (!uri) continue;
      if (!domainHint || uri.includes(domainHint)) return uri;
    }
    return null;
  }

  private static parseCreatorFromEntity(entity: any): OaiCreator {
    const name =
      OaiPmhClient.preferLangFromEntity(entity) ??
      entity["@rdf:about"]?.split("/").pop() ??
      "Unknown";

    const dateOfBirth = OaiPmhClient.extractText(entity["rdaGr2:dateOfBirth"]);
    const dateOfDeath = OaiPmhClient.extractText(entity["rdaGr2:dateOfDeath"]);

    const authorityLinks: Record<string, string> = {};
    for (const sa of entity["owl:sameAs"] ?? []) {
      const uri = typeof sa === "object" ? sa["@rdf:resource"] : sa;
      if (!uri) continue;
      if (uri.includes("viaf.org")) authorityLinks.viaf = uri;
      else if (uri.includes("vocab.getty.edu/ulan")) authorityLinks.ulan = uri;
      else if (uri.includes("wikidata.org")) authorityLinks.wikidata = uri;
      else if (uri.includes("rkd.nl")) authorityLinks.rkd = uri;
    }

    return { name, dateOfBirth, dateOfDeath, authorityLinks };
  }
}
