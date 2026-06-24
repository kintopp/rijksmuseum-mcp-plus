// ─── Output Schemas (Zod raw shapes for outputSchema) ───────────────

import { z } from "zod";
import { TITLE_LANGUAGES, TITLE_QUALIFIERS, DIMENSION_TYPES } from "../api/VocabularyDb.js";
import { type InferOutput } from "./helpers.js";

/** Factory — each call returns a unique Zod instance so zod-to-json-schema
 *  won't deduplicate into $ref pointers (which claude.ai cannot resolve). */
export const ResolvedTermShape = () => z.object({
  id: z.string(),
  label: z.string(),
  equivalents: z.record(z.string(), z.string()).optional(),
});

export const SearchResultOutput = {
  totalResults: z.number().int().nullable().optional()
    .describe("Total matching artworks (always present when vocabulary DB is available). Use with compact=true for efficient counting."),
  results: z.array(z.object({
    objectNumber: z.string(),
    title: z.string(),
    creator: z.string(),
    date: z.string().optional(),
    type: z.string().optional(),
    url: z.string(),
    nearestPlace: z.string().optional(),
    distance_km: z.number().optional(),
    groupedChildCount: z.number().int().positive().optional()
      .describe("Set on parent records when groupBy='parent' collapses children into them."),
  })).optional().describe("Artwork summaries. Absent when compact=true."),
  ids: z.array(z.string()).optional().describe("Object numbers (compact mode)."),
  source: z.literal("vocabulary").optional(),
  referencePlace: z.string().optional(),
  facets: z.record(z.string(), z.array(z.object({
    label: z.string(),
    count: z.number().int(),
    percentage: z.number().optional(),
  }))).optional().describe("Counts per dimension (configurable via facetLimit, default top-5). Computed when results are truncated and facets is set."),
  warnings: z.array(z.string()).optional(),
  error: z.string().optional(),
};

// ── find_similar output schema (#379) ──
// SimilarCandidate is reused across 9+ channels, so it MUST be a factory:
// each call mints a fresh Zod instance, preventing zod-to-json-schema from
// deduplicating into $ref pointers claude.ai cannot resolve.

export const LabeledTermShape = () => z.object({
  label: z.string(),
  wikidataUri: z.string().optional(),
});

/** Factory — one fresh instance per channel to avoid $ref dedup. */
export const SimilarCandidateShape = () => z.object({
  objectNumber: z.string(),
  title: z.string(),
  creator: z.string(),
  date: z.string().optional(),
  type: z.string().optional(),
  iiifId: z.string().optional(),
  score: z.number().describe("Channel-native similarity score. Visual has no score (0); not comparable across channels."),
  url: z.string(),
  detail: z.string().optional().describe("Human-readable 'why' line (shared motifs, lineage pairs, etc.)."),
  // Channel-specific extras (present only on the relevant channel):
  sharedNotations: z.array(z.string()).optional().describe("Iconclass: shared notation codes."),
  qualifierLabel: z.string().optional().describe("Lineage: primary assignment-qualifier label."),
  qualifierUri: z.string().optional().describe("Lineage: Getty AAT URI for the qualifier."),
  qualifierCreator: z.string().optional().describe("Lineage: creator referenced by the qualifier."),
  descSnippet: z.string().optional().describe("Description: truncated matching description text."),
  sharedTerms: z.array(LabeledTermShape()).optional().describe("Depicted Person/Place, Theme, Related*: shared terms."),
});

export const PooledCandidateShape = () => SimilarCandidateShape().extend({
  sources: z.array(z.string()).describe("Channels this artwork appeared in."),
  matchCount: z.number().int().describe("Number of channels that matched (= sources.length)."),
});

export const FindSimilarOutput = {
  query: z.object({
    objectNumber: z.string(),
    title: z.string(),
    creator: z.string(),
    date: z.string().optional(),
    type: z.string().optional(),
    iiifId: z.string().optional(),
    description: z.string().optional(),
    iconclassCodes: z.array(z.object({ notation: z.string(), label: z.string() })).optional(),
    lineageQualifiers: z.array(z.object({ label: z.string(), aatUri: z.string(), creator: z.string() })).optional(),
    depictedPersons: z.array(LabeledTermShape()).optional(),
    depictedPlaces: z.array(LabeledTermShape()).optional(),
    themes: z.array(z.string()).optional(),
    relatedVariantLabels: z.array(z.string()).optional(),
    relatedObjectLabels: z.array(z.string()).optional(),
  }).describe("Query artwork metadata plus the per-channel terms that explain why each channel matched."),

  // Required channels always present; best-effort/optional channels mirror SimilarPageData.modes optionality.
  modes: z.object({
    iconclass: z.array(SimilarCandidateShape()),
    lineage: z.array(SimilarCandidateShape()),
    description: z.array(SimilarCandidateShape()),
    visual: z.array(SimilarCandidateShape()).optional().describe("Best-effort (Rijksmuseum website API); absent on failure or no image."),
    theme: z.array(SimilarCandidateShape()).optional(),
    relatedVariant: z.array(SimilarCandidateShape()).optional(),
    relatedObject: z.array(SimilarCandidateShape()).optional(),
    depictedPerson: z.array(SimilarCandidateShape()).optional(),
    depictedPlace: z.array(SimilarCandidateShape()).optional(),
  }).describe("Up to 9 independent similarity channels. Each channel is independently ranked; scores are not cross-comparable."),

  pooled: z.array(PooledCandidateShape())
    .describe("Artworks appearing in >= poolThreshold channels, sorted by matchCount desc. The cross-channel consensus signal."),
  poolThreshold: z.number().int().describe("Minimum channel count for the pooled list (currently 4)."),

  pageUrl: z.string().describe("URL (HTTP mode) or file path (stdio mode) of the rendered HTML comparison page. Same value as the text channel."),
  generatedAt: z.string(),
  visualSearchUrl: z.string().optional().describe("Link to full visual-search results on rijksmuseum.nl."),
  visualTotalResults: z.number().int().optional(),
  error: z.string().optional(),
};

// ── find_similar text-channel trim (plan json-text-compat-rollout §E) ──
// The Claude model on claude.ai/Desktop reads content[].text (not
// structuredContent) and can't fetch the HTML page, so it gets a trimmed,
// answer-shaped summary in the text block while structuredContent keeps the full
// per-channel depth (maxResults) for the CLI. No client reads both into the model.
const SIMILAR_TEXT_OVERALL_CAP = 72;   // total candidates across ALL channels
const SIMILAR_TEXT_POOLED_CAP = 16;    // pooled consensus list, capped separately

type TrimCandidate = z.infer<ReturnType<typeof SimilarCandidateShape>>;
type TrimPooled = z.infer<ReturnType<typeof PooledCandidateShape>>;

/** Keep schema-required fields + the per-candidate "why"; drop viewer/URI plumbing. */
function leanSimilarCandidate(c: TrimCandidate): Record<string, unknown> {
  const out: Record<string, unknown> = {
    objectNumber: c.objectNumber, title: c.title, creator: c.creator, score: c.score, url: c.url,
  };
  if (c.date) out.date = c.date;
  if (c.type) out.type = c.type;
  if (c.detail) out.detail = c.detail;
  if (c.sharedNotations) out.sharedNotations = c.sharedNotations;
  if (c.qualifierLabel) out.qualifierLabel = c.qualifierLabel;
  if (c.qualifierCreator) out.qualifierCreator = c.qualifierCreator;
  if (c.descSnippet) out.descSnippet = c.descSnippet;
  if (c.sharedTerms) out.sharedTerms = c.sharedTerms;
  return out;
}

/**
 * Trimmed comparison summary for the text channel: seed core + per-channel
 * {total, top} bounded to SIMILAR_TEXT_OVERALL_CAP candidates OVERALL via
 * rank-interleave (rank-1 of every present channel, then rank-2, …; an exhausted
 * channel is skipped so its budget flows to the others), plus the pooled
 * consensus list capped separately. pageUrl serializes first.
 */
export function buildSimilarTextSummary(s: InferOutput<typeof FindSimilarOutput>): Record<string, unknown> {
  const present = Object.entries(s.modes)
    .filter(([, arr]) => Array.isArray(arr) && arr.length > 0) as [string, TrimCandidate[]][];
  const picked = new Map<string, TrimCandidate[]>(present.map(([k]) => [k, []]));
  let taken = 0;
  for (let rank = 0; taken < SIMILAR_TEXT_OVERALL_CAP; rank++) {
    let progressed = false;
    for (const [ch, arr] of present) {
      if (rank < arr.length) {
        picked.get(ch)!.push(arr[rank]);
        taken++;
        progressed = true;
        if (taken >= SIMILAR_TEXT_OVERALL_CAP) break;
      }
    }
    if (!progressed) break;
  }

  const channels: Record<string, unknown> = {};
  for (const [ch, arr] of present) {
    channels[ch] = { total: arr.length, top: picked.get(ch)!.map(leanSimilarCandidate) };
  }

  const seed: Record<string, unknown> = {
    objectNumber: s.query.objectNumber, title: s.query.title, creator: s.query.creator,
  };
  if (s.query.date) seed.date = s.query.date;
  if (s.query.type) seed.type = s.query.type;

  const pooledTop = s.pooled.slice(0, SIMILAR_TEXT_POOLED_CAP).map((p: TrimPooled) => ({
    ...leanSimilarCandidate(p),
    sources: p.sources,
    matchCount: p.matchCount,
  }));

  return {
    pageUrl: s.pageUrl,
    seed,
    poolThreshold: s.poolThreshold,
    channels,
    pooled: { total: s.pooled.length, top: pooledTop },
  };
}

// Shared by ArtworkDetailOutput + ConservationHistoryOutput — the count shape is identical;
// each schema applies its own outer .describe() (a Zod clone, so the two do not alias).
const attributionMarksShape = z.object({
  signatures: z.number().int().nonnegative()
    .describe("Count of recorded signature marks (Getty AAT 300028702)."),
  inscriptions: z.number().int().nonnegative()
    .describe("Count of recorded inscription marks (Getty AAT 300028705)."),
  total: z.number().int().nonnegative()
    .describe("Total attribution-evidence rows; if greater than signatures+inscriptions an unmapped evidence type is present (not silently dropped)."),
});

export const ArtworkDetailOutput = {
  // ArtworkSummary base
  id: z.string(),
  objectNumber: z.string(),
  title: z.string(),
  creator: z.string(),
  date: z.string(),
  type: z.string().optional()
    .describe("Primary object type — convenience sugar equal to objectTypes[0]?.label when present. objectTypes[] is the authoritative structured form (label + vocabulary id)."),
  url: z.string(),
  // ArtworkDetail fields
  description: z.string().nullable(),
  techniqueStatement: z.string().nullable(),
  physicalDimensions: z.string().nullable().describe("Short reconstructed dimensions string (e.g. \"h 379.5 cm × w 453.5 cm\") from formatDimensions(height, width). Same value and key the viewer tools (get_artwork_image / remount_viewer) emit. For the full structured measurements use dimensions[]; for verbose cataloguer prose use extentText."),
  provenance: z.string().nullable(),
  provenanceChain: z.array(z.object({
    sequence: z.number().int(),
    gap: z.boolean(),
    uncertain: z.boolean(),
    transferType: z.string().describe("Normalized transfer type: sale, inheritance, by_descent, widowhood, bequest, commission, confiscation, theft, looting, recuperation, loan, transfer, collection, gift, exchange, deposit, restitution, inventory, or unknown."),
    party: z.object({
      name: z.string(),
    }).nullable(),
    location: z.string().nullable(),
    date: z.object({
      year: z.number().int().nullable().describe("Best-effort single year; null if the date couldn't be reduced to a year."),
      text: z.string().describe("Original date expression as it appeared in the source."),
    }).nullable(),
    price: z.object({
      currency: z.string(),
      amount: z.number().nullable(),
      text: z.string(),
    }).nullable(),
  })).nullable()
    .describe("Parsed provenance events derived from the raw `provenance` string via the project's PEG parser. Null when no provenance text is available. Clients can re-derive counts, gaps, year spans, transfer-type histograms, and earliest-known-owner from this array; the text channel renders a summary built from the same data."),
  creditLine: z.string().nullable(),
  inscriptions: z.array(z.string()),
  parsedInscriptions: z.array(z.object({
    sequence: z.number().int(),
    raw: z.string(),
    language: z.enum(["nl", "en", "unknown"]).describe("Inferred only from which vocabulary the type/qualifier tokens came from; value-only and collector-mark-only segments are legitimately 'unknown'."),
    type: z.string().nullable().describe("Raw type token as catalogued (first comma-field of the header)."),
    normalizedType: z.string().nullable().describe("Canonical type bucket (e.g. \"collector's mark\", \"signature\", \"inscription\", \"number\"), or null when the raw token is outside the documented set. Open string, not a closed enum — preserve raw `type` alongside."),
    placement: z.string().nullable().describe("Raw placement qualifier text (e.g. \"verso linksonder\")."),
    normalizedPlacement: z.string().nullable().describe("Coarse surface bucket: \"recto\" | \"verso\" | null. Finer positions stay in raw `placement`."),
    technique: z.string().nullable().describe("Raw technique qualifier text (e.g. \"gestempeld\")."),
    normalizedTechnique: z.string().nullable().describe("Canonical technique bucket (e.g. \"stamped\", \"handwritten\", \"printed\"), or null."),
    value: z.string().nullable().describe("Raw post-colon text; null when the segment is a bare type label."),
    transcribedText: z.array(z.string()).describe("Quoted strings only — text actually transcribed *on* the work (signatures, captions, dates). Empty does NOT mean the object bears no text: coverage is uneven by object type (high for prints, low for coins/medals/posters)."),
    collectorMarks: z.array(z.object({ catalogue: z.string(), number: z.string() })).describe("Collector-mark catalogue references (Lugt N) found in the value."),
    unknownQualifiers: z.array(z.string()).describe("Header comma-fields that matched no known placement/technique vocabulary."),
    isCollectorMark: z.boolean(),
    isPlaceholder: z.boolean().describe("Type-label-only row with no value/quote/mark (e.g. `datum | date`) — a data-entry placeholder, not artwork-borne text."),
  })).describe("Structured parse of the raw `inscriptions` blob (each physical mark is recorded twice — a detailed Dutch form and an English gloss; both are preserved here losslessly, one entry per segment). This is catalogue-entered inscription/mark data — NOT OCR and NOT an exhaustive transcription of visible text. The field is dominated by verso collector's-mark stamps; the artist-/image-applied text is a real but minority component. Use transcribedText to find what is actually written on the work; use isCollectorMark/isPlaceholder to filter ownership-stamp boilerplate."),
  inscriptionSummary: z.object({
    hasTranscribedText: z.boolean().describe("At least one segment carries a quoted transcription."),
    hasCollectorMarkOnly: z.boolean().describe("Has collector marks and no transcribed text — pure ownership-stamp boilerplate."),
    collectorMarks: z.array(z.string()).describe("Deduped collector marks (e.g. \"Lugt 2228\")."),
    types: z.array(z.string()).describe("Distinct normalized types present."),
    placements: z.array(z.string()).describe("Distinct normalized placements present (recto/verso)."),
    techniques: z.array(z.string()).describe("Distinct normalized techniques present."),
  }).describe("Per-artwork rollup over parsedInscriptions — lets a client distinguish 'object bears text' from 'verso collector stamp boilerplate' at a glance."),
  location: z.object({
    roomId: z.string(),
    floor: z.string().nullable(),
    roomName: z.string().nullable(),
  }).nullable().describe("Current museum room (resolved via current_location → museum_rooms join). Null if not on display."),
  collectionSets: z.array(z.string()),
  externalIds: z.object({
    handle: z.string().nullable().describe("Persistent handle URI (hdl.handle.net)."),
    other: z.array(z.string()).describe("Non-handle external IDs (rare — handful of rows DB-wide)."),
  }),
  // Enriched Group A
  titles: z.array(z.object({
    title: z.string(),
    language: z.enum(TITLE_LANGUAGES),
    qualifier: z.enum(TITLE_QUALIFIERS),
  })),
  curatorialNarrative: z.object({ en: z.string().nullable(), nl: z.string().nullable() }),
  license: z.string().nullable(),
  dimensions: z.array(z.object({
    type: z.enum(DIMENSION_TYPES), value: z.union([z.number(), z.string()]), unit: z.string(), note: z.string().nullable(),
  })),
  relatedObjects: z.array(z.object({
    relationship: z.string().describe("English relationship label: 'different example', 'production stadia', or 'pendant'."),
    objectNumber: z.string().nullable().describe("Peer artwork's object number when it resolves to a row in our DB; null for unresolved Linked Art URIs."),
    title: z.string().nullable().describe("Peer artwork's title when resolved; null otherwise."),
    objectUri: z.string().describe("Original Linked Art URI from the harvest. Pass to get_artwork_details(uri=…) for full peer metadata."),
    iiifId: z.string().nullable().describe("Peer artwork's IIIF identifier when resolved and the peer carries an image; null otherwise. Powers in-viewer prev/next navigation."),
  })).describe("Related-variant peer relations — creator-invariant curator-declared edges ('different example' / 'production stadia' / 'pendant'). Other curator-declared relationships (pair, set, recto|verso, original|reproduction, related object) are exposed via find_similar's Related Object channel rather than here. Capped at 25 entries — see relatedObjectsTotalCount."),
  relatedObjectsTotalCount: z.number().int().nonnegative().describe("Total related-variant peer-relation count before capping. Equals relatedObjects.length when ≤ 25."),
  parents: z.array(z.object({
    objectNumber: z.string(),
    title: z.string(),
  })).describe("Parent records (e.g. the sketchbook this folio belongs to). Empty for top-level objects."),
  childCount: z.number().int().nonnegative().describe("Total number of child records (e.g. folios in a sketchbook). 0 for non-parent objects."),
  children: z.array(z.object({
    objectNumber: z.string(),
    title: z.string(),
  })).describe("Up to 25 child records, ordered by object_number. Use search_artwork to enumerate the full set."),
  persistentId: z.string().nullable(),
  // Enriched Group B
  objectTypes: z.array(ResolvedTermShape()),
  materials: z.array(ResolvedTermShape()),
  production: z.array(z.object({
    name: z.string(), role: z.string().nullable(), attributionQualifier: z.string().nullable(), place: z.string().nullable(), actorUri: z.string(),
    personInfo: z.object({
      birthYear: z.number().int().nullable(),
      deathYear: z.number().int().nullable(),
      gender: z.string().nullable(),
      wikidataId: z.string().nullable(),
    }).optional(),
  })),
  collectionSetLabels: z.array(ResolvedTermShape()),
  // Enriched Group C
  subjects: z.object({
    iconclass: z.array(ResolvedTermShape()),
    depictedPersons: z.array(ResolvedTermShape()),
    depictedPlaces: z.array(ResolvedTermShape()),
  }),
  // Enriched Group D — v0.27 (#291)
  dateDisplay: z.string().nullable()
    .describe("Free-text Rijksmuseum-formatted display date (e.g. '1642', 'c. 1665-1667'). Use this for prose; date for ISO-shaped output."),
  extentText: z.string().nullable()
    .describe("Free-text extent / dimensions string (dcterms:extent). Verbose human-readable form."),
  recordCreated: z.string().nullable()
    .describe("ISO 8601 timestamp of catalogue record creation."),
  recordModified: z.string().nullable()
    .describe("ISO 8601 timestamp of catalogue record's most recent modification."),
  themes: z.array(ResolvedTermShape())
    .describe("Curatorial thematic tags (overseas history, political history, costume, …)."),
  themesTotalCount: z.number().int().nonnegative(),
  exhibitions: z.array(z.object({
    exhibitionId: z.number().int(),
    titleEn: z.string().nullable(),
    titleNl: z.string().nullable(),
    dateStart: z.string().nullable(),
    dateEnd: z.string().nullable(),
  })).describe("Exhibitions this artwork has appeared in. Most-recent first."),
  exhibitionsTotalCount: z.number().int().nonnegative(),
  attributionMarks: attributionMarksShape.describe("Presence of signature/inscription marks only — a count, not content. The harvested rows carry no transcribed text and their carrier URIs do not resolve; use parsedInscriptions / search_inscriptions for the actual transcriptions."),
  bibliographyCount: z.number().int().nullable()
    .describe("Citation count for this artwork — call get_artwork_bibliography for the entries. Null when bibliography data isn't present in this database."),
  error: z.string().optional(),
};

export const ConservationHistoryOutput = {
  objectNumber: z.string(),
  title: z.string().nullable(),
  creator: z.string().nullable(),
  examinations: z.array(z.object({
    examiner: z.string().nullable()
      .describe("Name of the examiner / lab, when recorded."),
    reportTypeId: z.string()
      .describe("Rijksmuseum report-type concept URI."),
    reportTypeLabel: z.string().nullable()
      .describe("English label of the report type (e.g. 'infrared photography', 'dendrochronology'). Null on DBs where the label backfill has not been applied — fall back to reportTypeId."),
    date: z.string().nullable(),
    dateBegin: z.string().nullable(),
    dateEnd: z.string().nullable(),
  })).describe("Technical examinations / forensic reports (X-ray, dendrochronology, paint samples, infrared, …). Most-recent first."),
  examinationsTotalCount: z.number().int().nonnegative(),
  conservationHistory: z.array(z.object({
    modifierUri: z.string().nullable()
      .describe("Linked Art URI of the conservator / agent. Conservator names are not resolved — surface the description, which carries the substance."),
    description: z.string().nullable()
      .describe("Free-text treatment description (e.g. 'complete restoration', 'canvas lined')."),
    date: z.string().nullable(),
    dateBegin: z.string().nullable(),
    dateEnd: z.string().nullable(),
  })).describe("Restoration / conservation treatment events. Most-recent first."),
  conservationHistoryTotalCount: z.number().int().nonnegative(),
  attributionMarks: attributionMarksShape.describe("Presence of signature/inscription marks only — a count, not content. The harvested rows carry no transcribed text and their carrier URIs do not resolve; use get_artwork_details.parsedInscriptions / search_inscriptions for the actual transcriptions."),
  provenanceTextSummary: z.string().nullable()
    .describe("Short excerpt of the raw provenance text, for forensic cross-reference. Null when absent."),
  warnings: z.array(z.string()).optional(),
  error: z.string().optional(),
};

export const BibliographyOutput = {
  objectNumber: z.string(),
  total: z.number().int().nonnegative()
    .describe("Total citations for the artwork (full count, even when only the first few entries are returned)."),
  entries: z.array(z.object({
    sequence: z.number().int().nullable()
      .describe("Citation order as catalogued; null when unsequenced."),
    citation: z.string()
      .describe("Human-readable reference: an inline citation string, or 'author, title, journal, volume(year) pages, locus' composed at harvest time from the linked publication's creditText/name/isPartOf/pagination fields."),
    publicationUri: z.string().nullable()
      .describe("Linked publication record URI (https://id.rijksmuseum.nl/301{biblionumber}); null for inline-only citations. The 301{biblionumber} matches the library catalogue's SRU rijkspid."),
    pages: z.string().nullable(),
    isbn: z.string().nullable(),
    worldcatUri: z.string().nullable(),
    libraryUrl: z.string().nullable(),
  })).describe("Scholarly references for the artwork. Empty when none were harvested."),
  warnings: z.array(z.string()).optional(),
  error: z.string().optional(),
};

export const PublicationArtworksOutput = {
  publicationUri: z.string(),
  publicationId: z.number().int(),
  total: z.number().int().nonnegative(),
  artworks: z.array(z.object({
    objectNumber: z.string(),
    title: z.string(),
    creator: z.string().nullable(),
  })).describe("Artworks whose bibliography cites this publication. Empty when none (or bibliography not harvested)."),
  warnings: z.array(z.string()).optional(),
  error: z.string().optional(),
};

export const ImageInfoOutput = {
  objectNumber: z.string(),
  title: z.string().optional(),
  creator: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  license: z.string().nullable().optional(),
  physicalDimensions: z.string().nullable().optional(),
  url: z.string().optional(),
  iiifInfoUrl: z.string().optional(),
  viewUUID: z.string().optional().describe("Viewer session ID for use with navigate_viewer."),
  error: z.string().optional(),
};

export const InspectImageOutput = {
  objectNumber: z.string(),
  region: z.string(),
  requestedSize: z.number().int(),
  nativeWidth: z.number().int().optional(),
  nativeHeight: z.number().int().optional(),
  cropPixelWidth: z.number().int().optional()
    .describe("Actual width in pixels of the returned inspect image/crop. Use with cropPixelHeight for crop-local pixel overlays."),
  cropPixelHeight: z.number().int().optional()
    .describe("Actual height in pixels of the returned inspect image/crop. Use with cropPixelWidth for crop-local pixel overlays."),
  cropRegion: z.string().optional()
    .describe("Normalized IIIF region used for the fetch; crop_pixels: inputs are normalized to plain IIIF pixel regions."),
  rotation: z.number().int(),
  quality: z.string(),
  fetchTimeMs: z.number().int().optional().describe("Time spent fetching from IIIF server (ms)"),
  viewUUID: z.string().optional().describe("Active viewer session ID (if a viewer is open for this artwork)"),
  viewerNavigated: z.boolean().optional().describe("Whether the viewer was auto-navigated to the inspected region"),
  overlaysRendered: z.number().int().optional().describe("Number of viewer overlays composited onto the returned image (show_overlays only)"),
  overlaysSkipped: z.number().int().optional().describe("Number of viewer overlays that fell outside the inspected region and were not drawn (show_overlays only)"),
  overlaysError: z.string().optional().describe("Reason the composite couldn't proceed when show_overlays was requested (e.g. 'no_active_viewer', 'compositor_failed')"),
  error: z.string().optional(),
};

export const PaginatedBase = {
  returnedCount: z.number().int(),
  records: z.array(z.record(z.string(), z.unknown())),
  resumptionToken: z.string().optional(),
  hint: z.string().optional(),
  error: z.string().optional(),
};

export const BrowseSetOutput = {
  records: z.array(z.object({
    objectNumber: z.string(),
    title: z.string(),
    creator: z.string(),
    date: z.string(),
    description: z.string().optional(),
    extentText: z.string().optional()
      .describe("Verbose free-text extent/dimensions string (dcterms:extent) — the same shape as get_artwork_details.extentText. (Renamed from `dimensions` in v0.60; that key collided with get_artwork_details.dimensions[], which is a structured array.)"),
    datestamp: z.string().optional(),
    hasImage: z.boolean(),
    imageUrl: z.string().optional(),
    iiifServiceUrl: z.string().optional(),
    edmType: z.string().optional(),
    lodUri: z.string(),
    url: z.string(),
  })),
  totalInSet: z.number().int().optional(),
  resumptionToken: z.string().optional(),
  error: z.string().optional(),
};

export const RecentChangesOutput = {
  ...PaginatedBase,
  totalChanges: z.number().int().optional(),
  identifiersOnly: z.boolean().optional(),
};

export const SemanticSearchOutput = {
  searchMode: z.enum(["semantic", "semantic+filtered"]),
  query: z.string(),
  returnedCount: z.number().int(),
  results: z.array(z.object({
    rank: z.number().int(),
    objectNumber: z.string(),
    title: z.string(),
    creator: z.string(),
    date: z.string().optional(),
    type: z.string().optional(),
    similarityScore: z.number(),
    sourceText: z.string().optional(),
    url: z.string(),
  })),
  warnings: z.array(z.string()).optional(),
  error: z.string().optional(),
};

export const CuratedSetsOutput = {
  totalSets: z.number().int(),
  filteredFrom: z.number().int().optional(),
  query: z.string().optional(),
  sets: z.array(z.object({
    setSpec: z.string(),
    name: z.string(),
    lodUri: z.string(),
    memberCount: z.number().int().optional(),
    dominantTypes: z.array(z.object({
      label: z.string(),
      count: z.number().int(),
    })).optional(),
    dominantCenturies: z.array(z.object({
      century: z.string(),
      count: z.number().int(),
    })).optional(),
    category: z.enum(["object_type", "iconographic", "album", "sub_collection", "umbrella"]).nullable().optional(),
  })),
  error: z.string().optional(),
};
