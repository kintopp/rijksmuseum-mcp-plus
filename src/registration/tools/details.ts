import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { VocabularyDb, type ArtworkDetailFromDb } from "../../api/VocabularyDb.js";
import { UsageStats } from "../../utils/UsageStats.js";
import {
  ANN_READ_CLOSED,
  stripNullCoerceBool,
  optStr,
  type InferOutput,
  errorResponse,
  structuredResponse,
  withOutputSchema,
  createLogger,
} from "../helpers.js";
import {
  ArtworkDetailOutput,
} from "../outputSchemas.js";
import { parseInscriptions, summarizeInscriptions, type ParsedInscription, type InscriptionSummary } from "../../inscriptions.js";

// ─── Detail helpers (used by get_artwork_details) ───────────────────────────

type EnrichedDetail = (InferOutput<typeof ArtworkDetailOutput> | ArtworkDetailFromDb) & {
  parsedInscriptions?: ParsedInscription[];
  inscriptionSummary?: InscriptionSummary;
};

/** Format artwork detail as a compact key-value summary for LLM content (Tier 3). */
function formatDetailSummary(d: EnrichedDetail): string {
  const lines: string[] = [];
  lines.push(`${d.objectNumber} — ${d.title}`);
  lines.push(`${d.creator}${d.date ? `, ${d.date}` : ""}`);
  if (d.techniqueStatement || d.physicalDimensions) {
    lines.push([d.techniqueStatement, d.physicalDimensions].filter(Boolean).join(", "));
  }
  // Surface weight/depth from dimensions[] — invisible in the h×w physicalDimensions string.
  const extraDims = d.dimensions
    .filter((dim) => dim.type === "weight" || dim.type === "depth")
    .map((dim) => `${dim.type} ${dim.value} ${dim.unit}`);
  if (extraDims.length) lines.push(extraDims.join(", "));
  if (d.location) {
    const parts = [d.location.floor, d.location.roomName, `room ${d.location.roomId}`].filter(Boolean);
    lines.push(parts.join(", "));
  }
  lines.push("");

  const termLabels = (arr: { label: string }[], max = 5) => {
    const labels = arr.map((t) => t.label);
    return labels.length <= max ? labels.join(", ") : labels.slice(0, max).join(", ") + ` ...and ${labels.length - max} more`;
  };

  if (d.objectTypes.length) lines.push(`Types: ${termLabels(d.objectTypes)}`);
  if (d.materials.length) lines.push(`Materials: ${termLabels(d.materials)}`);
  if (d.collectionSetLabels.length) lines.push(`Collections: ${termLabels(d.collectionSetLabels)}`);
  if (d.subjects.iconclass.length) lines.push(`Iconclass: ${d.subjects.iconclass.map((t) => t.id).join(" | ")}`);
  if (d.subjects.depictedPersons.length) lines.push(`Depicted persons: ${termLabels(d.subjects.depictedPersons)}`);
  if (d.subjects.depictedPlaces.length) lines.push(`Depicted places: ${termLabels(d.subjects.depictedPlaces)}`);
  if (d.production.length) {
    const parts = d.production.map((p) => {
      let s = p.attributionQualifier && p.attributionQualifier !== "primary"
        ? `${p.attributionQualifier} ${p.name}` : p.name;
      const pi = p.personInfo;
      if (pi?.birthYear != null || pi?.deathYear != null) {
        s += ` (${pi.birthYear ?? "?"}–${pi.deathYear ?? "?"})`;
      }
      if (p.role) s += ` [${p.role}]`;
      if (p.place) s += `, ${p.place}`;
      return s;
    });
    lines.push(`Production: ${parts.join("; ")}`);
  }

  if (d.description) lines.push(`\n[Description] ${d.description}`);
  if (d.curatorialNarrative.en) lines.push(`[Narrative] ${d.curatorialNarrative.en}`);
  else if (d.curatorialNarrative.nl) lines.push(`[Narrative] ${d.curatorialNarrative.nl}`);
  if (d.inscriptions.length) lines.push(`[Inscriptions] ${d.inscriptions.join("; ")}`);
  // Inscription notes — separate artwork-borne text from ownership-stamp boilerplate
  // for clients that read the text channel rather than structuredContent.
  if (d.inscriptionSummary) {
    const isum = d.inscriptionSummary;
    const bits: string[] = [];
    if (isum.hasTranscribedText) bits.push("bears transcribed text");
    else if (isum.hasCollectorMarkOnly) bits.push("collector's marks only — no transcribed text");
    if (isum.collectorMarks.length) bits.push(`marks: ${isum.collectorMarks.join(", ")}`);
    if (bits.length) lines.push(`[Inscription notes] ${bits.join("; ")}`);
  }
  if (d.provenance) lines.push(`[Provenance] ${d.provenance}`);
  if (d.provenanceEventCount) {
    lines.push(`Provenance events: ${d.provenanceEventCount} parsed. Full chain: search_provenance(objectNumber="${d.objectNumber}")`);
  }
  if (d.creditLine) lines.push(`[Credit line] ${d.creditLine}`);

  // Track A: title variants beyond the primary
  if (d.titles && d.titles.length > 0) {
    const byQual = new Map<string, string[]>();
    for (const t of d.titles) {
      const key = `${t.qualifier}/${t.language}`;
      if (!byQual.has(key)) byQual.set(key, []);
      byQual.get(key)!.push(t.title);
    }
    const compact = [...byQual.entries()]
      .map(([k, ts]) => `${k}: ${ts[0]}${ts.length > 1 ? ` (+${ts.length - 1})` : ""}`)
      .join(" | ");
    lines.push(`[Titles] (${d.titles.length} variants) ${compact}`);
  }

  // Track B: parent / child hierarchy
  if (d.parents && d.parents.length > 0) {
    const ps = d.parents.map(p => `${p.objectNumber} — "${p.title}"`).join("; ");
    lines.push(`[Parent] ${ps}`);
  }
  if (d.childCount && d.childCount > 0 && d.children) {
    const preview = d.children.slice(0, 5).map(c => c.objectNumber).join(", ");
    const more = d.childCount > d.children.length ? ` ...and ${d.childCount - d.children.length} more` : "";
    const overflow = d.children.length > 5 ? ` (+${d.children.length - 5} in preview)` : "";
    lines.push(`[Children] (${d.childCount}) ${preview}${overflow}${more}`);
  }

  // Track C: peer artwork relations grouped by relationship type
  if (d.relatedObjectsTotalCount && d.relatedObjectsTotalCount > 0 && d.relatedObjects) {
    const byType = new Map<string, string[]>();
    for (const r of d.relatedObjects) {
      const handle = r.objectNumber ?? r.objectUri;
      if (!byType.has(r.relationship)) byType.set(r.relationship, []);
      byType.get(r.relationship)!.push(handle);
    }
    const groups = [...byType.entries()]
      .map(([rel, ids]) => `${rel}: ${ids.slice(0, 4).join(", ")}${ids.length > 4 ? ` (+${ids.length - 4})` : ""}`)
      .join(" | ");
    const cap = d.relatedObjectsTotalCount > d.relatedObjects.length
      ? ` (showing ${d.relatedObjects.length} of ${d.relatedObjectsTotalCount})` : "";
    lines.push(`[Related variants]${cap} ${groups}`);
  }

  if (d.bibliographyCount) lines.push(`\nBibliography: ${d.bibliographyCount} entries`);
  lines.push(`URL: ${d.url}`);

  return lines.join("\n");
}

export function registerDetailsTools(
  server: McpServer,
  vocabDb: VocabularyDb | null,
  withLogging: ReturnType<typeof createLogger>,
  _stats?: UsageStats
): void {
  // ── get_artwork_details ─────────────────────────────────────────

  server.registerTool(
    "get_artwork_details",
    {
      title: "Get Artwork Details",
      annotations: ANN_READ_CLOSED,
      description:
        "Full metadata for ONE artwork by objectNumber. " +
        "Covers creator, dates, materials, provenance, inscriptions, related objects. " +
        "Typically follows a search_artwork / semantic_search / find_similar result, or a user-named objectNumber. " +
        "Provide exactly one of objectNumber (e.g. 'SK-C-5' for The Night Watch) or uri (a Linked Art URI from relatedObjects).\n\n" +
        "Returns metadata including titles (primary plus the full set of variants with language and qualifier — Dutch/English brief/full/display/former), " +
        "creator, date, dateDisplay (free-text form), description, curatorial narrative, dimensions (text + structured: height/width/depth/weight/diameter where present), " +
        "extentText, materials, object type, production details (with creator life dates, gender, and Wikidata ID where available), raw provenance text (structured chain: search_provenance), credit line, inscriptions, license, " +
        "related objects (each carrying objectNumber + iiifId for in-viewer navigation), themes, exhibitions, attributionMarks (signature/inscription counts), externalIds (handle + other), " +
        "location (museum room when on display, as { roomId, floor, roomName }), recordCreated/recordModified timestamps, plus collection sets and reference metadata. " +
        "Authority IDs appear at two levels: work-level under externalIds (handle + other), and entity-level under equivalents[] arrays on objectTypes, materials, production entries, subjects.depictedPersons / subjects.depictedPlaces, collectionSetLabels and themes — each entry a { authority, id, uri } triple (VIAF/ULAN/RKD/Getty TGN+AAT/GeoNames/Wikidata), and one entity can carry several, so read every entry (iconclass terms have none). " +
        "The relatedObjects field carries each peer's objectNumber (canonical handle) plus a Linked Art objectUri; pass either form back here, objectNumber preferred.\n\n" +
        "Not for filter-based discovery — use search_artwork. Not for similarity discovery — use find_similar. Not for aggregate counts — use collection_stats.",
      inputSchema: z.object({
        objectNumber: optStr()
          .optional()
          .describe(
            "The object number of the artwork (e.g. 'SK-C-5', 'SK-A-3262')"
          ),
        uri: z
          .string()
          .url()
          .optional()
          .describe(
            "A Linked Art URI (e.g. 'https://id.rijksmuseum.nl/200666460')"
          ),
        verboseExtent: z.preprocess(stripNullCoerceBool, z.boolean().optional())
          .describe("Include the verbose free-text extentText (dcterms:extent). Default false; the structured dimensions[] and physicalDimensions cover the headline measurements."),
      }).strict(),
      ...withOutputSchema(ArtworkDetailOutput),
    },
    withLogging("get_artwork_details", async (args) => {
      if (!vocabDb?.available) {
        return errorResponse("get_artwork_details requires the vocabulary database.");
      }
      const count = (args.objectNumber ? 1 : 0) + (args.uri ? 1 : 0);
      if (count !== 1) throw new Error("Provide exactly one of objectNumber or uri.");

      let objNum: string;
      if (args.objectNumber) {
        objNum = args.objectNumber;
      } else {
        const segment = args.uri!.split("/").pop()!;
        // Two URI flavours land here. (a) URIs minted by this server in the `id`
        // field of get_artwork_details — segment = local art_id. (b) URIs harvested
        // from upstream Linked Art payloads (related_la_uri / parent_la_uri) —
        // segment = upstream entity ID, a different ID space. Try (a) first; fall
        // back to (b) by probing the harvest tables for the URI.
        if (/^\d+$/.test(segment)) {
          const resolved = vocabDb.getObjectNumberByArtId(Number(segment))
            ?? vocabDb.getObjectNumberByLinkedArtUri(args.uri!);
          if (!resolved) throw new Error(`No artwork found for URI: ${args.uri}`);
          objNum = resolved;
        } else {
          objNum = segment;
        }
      }
      const detail = vocabDb.getArtworkDetail(objNum);
      if (!detail) throw new Error(`No artwork found: ${objNum}`);

      // Runtime inscription parse — lossless per-segment structure plus a rollup,
      // parsed here from the already-split `inscriptions` segments, no harvest
      // dependency.
      const parsedInscriptions = parseInscriptions(detail.inscriptions);
      const inscriptionSummary = summarizeInscriptions(parsedInscriptions);

      const enriched = {
        ...detail,
        extentText: args.verboseExtent === true ? detail.extentText : null,
        parsedInscriptions,
        inscriptionSummary,
      };
      const text = formatDetailSummary(enriched);
      return structuredResponse(enriched, text);
    })
  );
}
