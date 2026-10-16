import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { VocabularyDb, formatDateRange, FILTER_ART_IDS_KEYS, type ArtworkMeta } from "../../api/VocabularyDb.js";
import { GemmaDb, type GemmaHit } from "../../api/GemmaDb.js";
import { GemmaModel } from "../../api/GemmaModel.js";
import { UsageStats } from "../../utils/UsageStats.js";
import { getOrComputeWithInflight } from "../../utils/inflightCache.js";
import {
  ANN_READ_CLOSED,
  TOOL_LIMITS,
  stripNull,
  stripNullCoerceBool,
  optStr,
  stringOrArray,
  type InferOutput,
  structuredResponse,
  withOutputSchema,
  formatSearchLine,
  detectComponentClustering,
  canonicalInputKey,
  createLogger,
} from "../helpers.js";
import { SemanticSearchOutput } from "../outputSchemas.js";
import { semanticSearchCache, semanticInflight } from "../state.js";

export function registerSemanticTools(
  server: McpServer,
  gemmaDb: GemmaDb | null,
  gemmaModel: GemmaModel | null,
  vocabDb: VocabularyDb | null,
  withLogging: ReturnType<typeof createLogger>,
  stats?: UsageStats
): void {
  if (gemmaDb?.available && gemmaModel?.available) {
    server.registerTool(
      "semantic_search",
      {
        title: "Semantic Search",
        annotations: ANN_READ_CLOSED,
        description:
          "Free-text concept search by embedding similarity. " +
          "For ideas like 'solitude' or 'vanitas' that resist metadata. " +
          "Ranks by multilingual embedding similarity over a composite of each artwork's title, inscriptions, " +
          "description and curatorial narrative, and returns that source text for grounding — " +
          "use it to explain why results are relevant or to flag false positives.\n\n" +
          "Not for queries expressible as structured metadata (specific artists, dates, places, materials) — use search_artwork for those. " +
          "Not for artwork-to-artwork similarity — use find_similar with an objectNumber. " +
          "Not for aggregate counts or distributions — use collection_stats.\n\n" +
          "Best for concepts that resist structured metadata: atmospheric qualities ('sense of loneliness'), compositional descriptions " +
          "('artist gazing directly at the viewer'), art-historical concepts ('cultural exchange under VOC trade'), or cross-language queries. " +
          "Results are most reliable when the Rijksmuseum's curatorial narrative texts discuss the relevant concept explicitly; " +
          "purely emotional or stylistic concepts (e.g. chiaroscuro, desolation) may yield lower precision because catalogue descriptions " +
          "often do not use that language.\n\n" +
          "Filter notes: supports pre-filtering by subject, depictedPerson, depictedPlace, productionPlace, collectionSet, aboutActor, iconclass, and imageAvailable " +
          "in addition to type, material, technique, creator, and creationDate. " +
          "Use type: 'painting' to restrict to the paintings collection. Do NOT use technique: 'painting' — it matches painted decoration on any object type " +
          "(ceramics, textiles, frames) and will return unexpected results. " +
          "A single very broad filter (e.g. type: 'print' or material: 'paper' alone) is ranked approximately and may miss equally-relevant works — " +
          "pair it with a narrower filter (e.g. type: 'print', subject: 'landscape') for exact ranking.\n\n" +
          "Painting queries: paintings are underrepresented (prints and drawings outnumber them ~77:1), and missing key works are not visible in the returned list. " +
          "When paintings are the expected result type, pre-filter with type: 'painting' here or pair this with " +
          "search_artwork(type: 'painting', subject: …) / search_artwork(type: 'painting', creator: …).\n\n" +
          "Multilingual: queries in Dutch, German, French and other languages are supported but may benefit from a wider result window " +
          "or English reformulation if canonical works are missing.",
        inputSchema: z.object({
          query: z.string().describe("Natural language concept query (e.g. 'winter landscape with ice skating')"),
          type: stringOrArray().optional().describe("Filter by object type (e.g. 'painting', 'print')."),
          material: stringOrArray().optional().describe("Filter by material (e.g. 'canvas', 'paper')."),
          technique: stringOrArray().optional().describe("Filter by technique (e.g. 'etching', 'oil painting')."),
          creationDate: optStr().optional().describe("Filter by date — exact year ('1642') or wildcard ('16*')"),
          dateMatch: z.preprocess(stripNull,
            z.enum(["overlaps", "within", "midpoint"]).optional(),
          ).describe("Date matching mode — see search_artwork for details."),
          creator: stringOrArray().optional().describe("Filter by artist name."),
          subject: stringOrArray().optional().describe("Pre-filter by subject before semantic ranking."),
          iconclass: stringOrArray().optional().describe("Pre-filter by Iconclass notation before semantic ranking."),
          depictedPerson: stringOrArray().optional().describe("Pre-filter by depicted person before semantic ranking."),
          depictedPlace: stringOrArray().optional().describe("Pre-filter by depicted place before semantic ranking."),
          productionPlace: stringOrArray().optional().describe("Pre-filter by production place before semantic ranking."),
          collectionSet: stringOrArray().optional().describe("Pre-filter by collection set before semantic ranking."),
          aboutActor: optStr().optional().describe("Pre-filter by person (depicted or creator) before semantic ranking"),
          imageAvailable: z.preprocess(stripNullCoerceBool, z.boolean().optional()).describe("Pre-filter by digitisation: true = only artworks with images, false = only those without"),
          maxResults: z.number().int().min(1).max(TOOL_LIMITS.semantic_search.max).default(TOOL_LIMITS.semantic_search.default).optional()
            .describe("Number of results to return (default 15). Similarity scores plateau after ~15 results; request more only if needed."),
          offset: z.number().int().min(0).default(0).optional()
            .describe("Skip this many results (for pagination). Use with maxResults."),
        }).strict(),
        ...withOutputSchema(SemanticSearchOutput),
      },
      withLogging("semantic_search", async (args) => {
        // #378 Step 4: cache + in-flight de-dup keyed on DB build-id + canonical args.
        // semantic_search awaits embed() before its sync scan, so two identical concurrent
        // queries would each pay the scan; cache hits skip the body entirely.
        const cacheKey = `${gemmaDb!.buildId}|${canonicalInputKey(args)}`;
        return getOrComputeWithInflight(semanticSearchCache, semanticInflight, cacheKey, async () => {
        const maxResults = args.maxResults ?? TOOL_LIMITS.semantic_search.default;
        const userOffset = args.offset ?? 0;
        const fetchLimit = maxResults + userOffset;

        // 1. Embed query text
        const tEmbed = performance.now();
        const queryVec = gemmaDb!.quantize(await gemmaModel!.embed(args.query));
        stats?.recordPhase("semantic_search", "embed", performance.now() - tEmbed);

        // 2. Choose search path based on filters
        const tScan = performance.now();
        const filterParams: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(args)) {
          if (val !== undefined && FILTER_ART_IDS_KEYS.has(key)) {
            filterParams[key] = val;
          }
        }
        const hasFilters = Object.keys(filterParams).length > 0;
        let candidates: GemmaHit[];
        let filtersApplied = false;
        const warnings: string[] = [];

        if (hasFilters && vocabDb?.available) {
          // FILTERED PATH: pre-filter via vocab DB, then distance-rank
          const candidateArtIds = vocabDb.filterArtIds(filterParams);
          if (candidateArtIds === null) {
            // No effective filters — fall back to pure KNN
            candidates = gemmaDb!.search("metadata", queryVec, fetchLimit);
            warnings.push("Metadata filters ignored: vocabulary DB does not support filtered search. Results ranked by semantic similarity only.");
          } else if (candidateArtIds.length === 0) {
            const emptyData: InferOutput<typeof SemanticSearchOutput> = {
              searchMode: "semantic+filtered", query: args.query, returnedCount: 0, results: [],
              warnings: ["No artworks match the specified filters."],
            };
            return structuredResponse(
              emptyData,
              `0 semantic matches for "${args.query}" (no filter matches)`
            );
          } else {
            candidates = gemmaDb!.search("metadata", queryVec, fetchLimit, candidateArtIds);
            filtersApplied = true;
          }
        } else {
          candidates = gemmaDb!.search("metadata", queryVec, fetchLimit);
          if (hasFilters) {
            warnings.push("Metadata filters ignored: vocabulary DB is not available. Results ranked by semantic similarity only.");
          }
        }
        stats?.recordPhase("semantic_search", "scan", performance.now() - tScan);

        // Apply offset + truncate to user's requested page
        if (userOffset > 0) candidates.splice(0, userOffset);
        if (candidates.length > maxResults) candidates.splice(maxResults);

        // 3. Batch-resolve metadata + source text (grounding context) from the vocab DB.
        // Gemma vectors carry only art_ids, so a hit without a vocab row has no objectNumber and is dropped.
        const allArtIds = candidates.map(c => c.artId);
        const metaMap = vocabDb?.available
          ? vocabDb.batchLookupByArtId(allArtIds)
          : new Map<number, ArtworkMeta>();
        const sourceTextMap = vocabDb?.available
          ? vocabDb.reconstructSourceText(allArtIds)
          : new Map<number, string>();
        const typeMap = vocabDb?.available
          ? vocabDb.lookupTypes([...metaMap.values()].map(m => m.objectNumber))
          : new Map<string, string>();

        const results = candidates.flatMap(c => {
          const meta = metaMap.get(c.artId);
          if (!meta) return [];
          const date = formatDateRange(meta.dateEarliest, meta.dateLatest);
          return [{
            objectNumber: meta.objectNumber,
            title: meta.title || "",
            creator: meta.creator || "",
            ...(date && { date }),
            ...(typeMap.has(meta.objectNumber) && { type: typeMap.get(meta.objectNumber) }),
            similarityScore: Math.round(c.similarity * 1000) / 1000,
            sourceText: sourceTextMap.get(c.artId),
            url: `https://www.rijksmuseum.nl/en/collection/${meta.objectNumber}`,
          }];
        }).map((r, i) => ({ rank: i + 1, ...r }));

        // 5. Build text channel
        const mode = filtersApplied ? "semantic+filtered" : "semantic";
        const header = `${results.length} semantic matches for "${args.query}" (${mode} mode)`;

        const resultLines = results.map((r, i) => {
          const oneLiner = formatSearchLine(r, i) + `  [${r.similarityScore.toFixed(2)}]`;
          const sourceText = r.sourceText;
          return sourceText ? `${oneLiner}\n   ${sourceText}` : oneLiner;
        });

        const textParts = [header];
        if (resultLines.length) textParts.push("\n" + resultLines.join("\n\n"));

        // Detect component-record clustering (sketchbook folios, album pages, etc.)
        const clusterNote = detectComponentClustering(results.map(r => r.objectNumber));
        if (clusterNote) warnings.push(clusterNote);

        // 6. Return dual-channel response
        const data: InferOutput<typeof SemanticSearchOutput> = {
          searchMode: mode,
          query: args.query,
          returnedCount: results.length,
          results,
          ...(warnings.length > 0 && { warnings }),
        };
        return structuredResponse(data, textParts.join("\n"));
        });
      })
    );
  }
}
