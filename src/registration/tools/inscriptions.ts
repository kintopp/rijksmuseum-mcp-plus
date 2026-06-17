import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VocabularyDb, pluralize, type InscriptionSearchParams } from "../../api/VocabularyDb.js";
import { UsageStats } from "../../utils/UsageStats.js";
import {
  ANN_READ_CLOSED,
  TOOL_LIMITS,
  stripNull,
  stripNullCoerceBool,
  normalizeStringOrArray,
  optMinStr,
  type InferOutput,
  structuredResponse,
  withOutputSchema,
  createLogger,
} from "../helpers.js";

const InscriptionSearchOutput = {
  totalCandidates: z.number().int()
    .describe("FTS candidates before parse-confirm — the Stage-A narrow count. A large value with few confirmed results means the facet combo was broad; add a narrowing term."),
  candidatesCapped: z.boolean()
    .describe("True when candidates exceeded the internal parse cap, so results are PARTIAL. Narrow the query (add transcribedText, collectorMark, or another facet) for complete results."),
  totalConfirmed: z.number().int()
    .describe("Artworks confirmed after parsing the candidate window. Page through with offset/maxResults."),
  results: z.array(z.object({
    objectNumber: z.string(),
    title: z.string(),
    creator: z.string(),
    date: z.string().optional(),
    url: z.string(),
    matchedInscriptions: z.array(z.object({
      normalizedType: z.string().nullable()
        .describe("Canonical type bucket (open string, not a closed enum), or null when outside the documented set."),
      value: z.string().nullable()
        .describe("Normalized transcribed value; null for value-less marks (collector marks, placeholders)."),
      collectorMark: z.object({ catalogue: z.string(), number: z.string() }).optional(),
      occurrences: z.array(z.object({
        placement: z.string().nullable().describe("recto | verso | null."),
        technique: z.string().nullable(),
        language: z.string().describe("nl | en | unknown."),
      })).describe("One entry per distinct physical mark. The NL detail and EN gloss of a single mark are merged; a mark stamped on both recto and verso yields two occurrences."),
      raw: z.array(z.string()).describe("Underlying raw segments — honest provenance of the match."),
    })).describe("The inscription segments that matched, gloss-deduped — shows exactly why this artwork matched."),
  })),
  warnings: z.array(z.string()).optional(),
};

export function registerInscriptionsTools(
  server: McpServer,
  vocabDb: VocabularyDb | null,
  withLogging: ReturnType<typeof createLogger>,
  _stats?: UsageStats
): void {
  const vocabAvailable = vocabDb?.available ?? false;

  if (vocabAvailable && vocabDb!.hasTextSearch) {
    server.registerTool(
      "search_inscriptions",
      {
        title: "Search Inscriptions (Marks, Signatures, Transcribed Text)",
        annotations: ANN_READ_CLOSED,
        description:
          "Structured search over artwork inscriptions — collector's marks, signatures, dates, numbers, transcribed text.\n\n" +
          "IMPORTANT — what this field is: catalogue-entered inscription/mark data, NOT OCR and NOT an exhaustive transcription of " +
          "visible text. It is dominated by VERSO collector's-mark stamps (the Rijksprentenkabinet's own mark and former-owner stamps " +
          "account for a large share of all records); genuine artist-/image-applied text (signatures, captions, addresses) is a real but " +
          "MINORITY component. Coverage is uneven by object type: high for prints and drawings, low for coins, medals, and posters that are " +
          "covered in legend text never entered here. An empty transcribedText does NOT mean the object bears no text.\n\n" +
          "Use transcribedText to find what is actually written ON the work (matched against the quoted strings only). " +
          "Use collectorMark to find works bearing a given Lugt number (e.g. 'Lugt 240' or '240'). " +
          "Combine inscriptionType / placement / technique for facet queries (e.g. a handwritten signature on the recto). " +
          "Use excludeCollectorMarkOnly or hasTranscribedText:true to strip ownership-stamp boilerplate. " +
          "Use text for a blunt full-text match over the whole inscription blob.\n\n" +
          "Each result carries matchedInscriptions — the segments that matched, with the NL/EN gloss merged — so you can see exactly why " +
          "it matched. Facets combine within a single segment (a signature AND recto AND handwritten must be the same mark).\n\n" +
          "Runtime parse with no derived index: a query must include at least one narrowing filter, and a broad single facet " +
          "(e.g. inscriptionType:\"collector's mark\", roughly half the corpus) will trip the candidate cap and return PARTIAL results " +
          "(candidatesCapped:true) — add a narrowing term. For free-text keyword search across the whole catalogue use search_artwork; " +
          "search_artwork({inscription}) is a raw FTS over the same field, whereas this tool adds the structured facets and gloss-deduped matches.",
        inputSchema: z.object({
          text: optMinStr().describe("Blunt full-text match over the entire inscription_text blob (all segments, marks included). Use transcribedText for on-object text only."),
          transcribedText: optMinStr().describe("Find works whose transcribed (quoted) text contains this string — signatures, captions, dates actually written on the work. Substring match, case-insensitive."),
          inscriptionType: z.preprocess(
            normalizeStringOrArray,
            z.union([z.string(), z.array(z.string())]).optional(),
          ).describe("Normalized inscription type (single or array, OR-combined). Documented values include: collector's mark, signature, signature and date, inscription, annotation, number, date, title, name, monogram, watermark, stamp, maker's mark, seal, circumscription. Open set — values outside this list (including Dutch surface forms like 'signatuur') are matched against the raw catalogued type token and used as a literal FTS narrowing term."),
          placement: z.preprocess(
            normalizeStringOrArray,
            z.union([z.string(), z.array(z.string())]).optional(),
          ).describe("Surface placement: 'recto' or 'verso' (single or array). ~⅔ of inscriptions are on the verso (stamps & annotations)."),
          technique: z.preprocess(
            normalizeStringOrArray,
            z.union([z.string(), z.array(z.string())]).optional(),
          ).describe("Normalized technique (single or array, OR-combined). Documented values include: stamped, handwritten, printed, engraved, etched, pencil, pen, chalk, embossed, struck, typed."),
          collectorMark: optMinStr().describe("Lugt collector-mark catalogue reference — 'Lugt 240', 'Lugt 2228', or just the number '240'. Matches works bearing that mark."),
          hasTranscribedText: z.preprocess(stripNullCoerceBool, z.boolean().optional())
            .describe("If true, only works with at least one transcribed (quoted) string. If false, only works without."),
          excludeCollectorMarkOnly: z.preprocess(stripNullCoerceBool, z.boolean().optional())
            .describe("If true, drop works whose inscriptions are pure collector-mark boilerplate (marks but no transcribed text)."),
          isPlaceholder: z.preprocess(stripNullCoerceBool, z.boolean().optional())
            .describe("Filter on type-label-only placeholder rows (e.g. `datum | date` with no value). true = only matches that are placeholders; false = exclude placeholder-only matches."),
          offset: z.preprocess(stripNull, z.number().int().min(0).default(0).optional())
            .describe("Skip this many confirmed artworks (pagination)."),
          maxResults: z.preprocess(stripNull,
            z.number().int().min(1).max(TOOL_LIMITS.search_inscriptions.max).default(TOOL_LIMITS.search_inscriptions.default).optional(),
          ).describe(`Maximum artworks to return (1–${TOOL_LIMITS.search_inscriptions.max}, default ${TOOL_LIMITS.search_inscriptions.default}).`),
        }).strict(),
        ...withOutputSchema(InscriptionSearchOutput),
      },
      withLogging("search_inscriptions", async (args: Record<string, unknown>) => {
        const params: InscriptionSearchParams = {
          maxResults: (args.maxResults as number | undefined) ?? TOOL_LIMITS.search_inscriptions.default,
        };
        if (args.text) params.text = args.text as string;
        if (args.transcribedText) params.transcribedText = args.transcribedText as string;
        if (args.inscriptionType) params.inscriptionType = args.inscriptionType as string | string[];
        if (args.placement) params.placement = args.placement as string | string[];
        if (args.technique) params.technique = args.technique as string | string[];
        if (args.collectorMark) params.collectorMark = args.collectorMark as string;
        if (args.hasTranscribedText != null) params.hasTranscribedText = args.hasTranscribedText as boolean;
        if (args.excludeCollectorMarkOnly != null) params.excludeCollectorMarkOnly = args.excludeCollectorMarkOnly as boolean;
        if (args.isPlaceholder != null) params.isPlaceholder = args.isPlaceholder as boolean;
        if (args.offset != null) params.offset = args.offset as number;

        const result = vocabDb!.searchInscriptions(params);

        const lines: string[] = [];
        if (result.candidatesCapped) {
          lines.push(`${result.totalCandidates.toLocaleString()} candidates matched (partial — only the first window was parsed); ${result.totalConfirmed.toLocaleString()} confirmed so far.`);
        } else {
          lines.push(`${pluralize(result.totalConfirmed, "artwork")} with matching inscriptions (from ${result.totalCandidates.toLocaleString()} text candidates).`);
        }
        for (const r of result.results) {
          lines.push("");
          lines.push(`${r.objectNumber} | "${r.title}" — ${r.creator}${r.date ? ` (${r.date})` : ""}`);
          lines.push(`  ${r.url}`);
          for (const m of r.matchedInscriptions) {
            const where = m.occurrences
              .map(o => [o.placement, o.technique].filter(Boolean).join(" "))
              .filter(Boolean);
            const label = m.collectorMark ? `${m.collectorMark.catalogue} ${m.collectorMark.number}` : (m.value ?? "(no value)");
            const typ = m.normalizedType ? `${m.normalizedType}: ` : "";
            lines.push(`  • ${typ}${label}${where.length ? ` [${[...new Set(where)].join("; ")}]` : ""}`);
          }
        }

        const data: InferOutput<typeof InscriptionSearchOutput> = result;
        return structuredResponse(data, lines.join("\n"));
      }),
    );
  }
}
