import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { VocabularyDb, formatDateRange } from "../../api/VocabularyDb.js";
import { GemmaDb } from "../../api/GemmaDb.js";
import { GemmaModel } from "../../api/GemmaModel.js";
import { UsageStats } from "../../utils/UsageStats.js";
import { getOrComputeWithInflight } from "../../utils/inflightCache.js";
import {
  ANN_READ_CLOSED,
  TOOL_LIMITS,
  vectorPrefilterShape,
  resolvePrefilter,
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
  // Gemma vectors carry only art_ids; the vocab DB supplies every result's metadata.
  if (!gemmaDb?.available || !gemmaModel?.available || !vocabDb?.available) return;

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
        ...vectorPrefilterShape(),
        maxResults: z.number().int().min(1).max(TOOL_LIMITS.semantic_search.max).default(TOOL_LIMITS.semantic_search.default).optional()
          .describe("Number of results to return (default 15). Similarity scores plateau after ~15 results; request more only if needed."),
        offset: z.number().int().min(0).default(0).optional()
          .describe("Skip this many results (for pagination). Use with maxResults."),
      }).strict(),
      ...withOutputSchema(SemanticSearchOutput),
    },
    withLogging("semantic_search", async (args) => {
      // semantic_search awaits embed() before its sync scan, so two identical concurrent
      // queries would each pay the scan; cache hits skip the body entirely.
      const cacheKey = `${gemmaDb.buildId}|${canonicalInputKey(args)}`;
      return getOrComputeWithInflight(semanticSearchCache, semanticInflight, cacheKey, async () => {
        const maxResults = args.maxResults ?? TOOL_LIMITS.semantic_search.default;
        const userOffset = args.offset ?? 0;
        const warnings: string[] = [];

        const tEmbed = performance.now();
        const queryVec = gemmaDb.quantize(await gemmaModel.embed(args.query));
        stats?.recordPhase("semantic_search", "embed", performance.now() - tEmbed);

        const tScan = performance.now();
        const { candidates: filterIds, warning } = resolvePrefilter(vocabDb, args);
        if (warning) warnings.push(warning);
        if (filterIds?.length === 0) {
          const emptyData: InferOutput<typeof SemanticSearchOutput> = {
            searchMode: "semantic+filtered", query: args.query, returnedCount: 0, results: [],
            warnings: ["No artworks match the specified filters."],
          };
          return structuredResponse(emptyData, `0 semantic matches for "${args.query}" (no filter matches)`);
        }
        const candidates = gemmaDb.search("metadata", queryVec, maxResults + userOffset, filterIds)
          .slice(userOffset, userOffset + maxResults);
        stats?.recordPhase("semantic_search", "scan", performance.now() - tScan);

        // A hit without a vocab row has no objectNumber and is dropped.
        const allArtIds = candidates.map(c => c.artId);
        const metaMap = vocabDb.batchLookupByArtId(allArtIds);
        const sourceTextMap = vocabDb.reconstructSourceText(allArtIds);
        const typeMap = vocabDb.batchLookupTypesByArtId(allArtIds);

        const results = candidates.flatMap(c => {
          const meta = metaMap.get(c.artId);
          if (!meta) return [];
          const date = formatDateRange(meta.dateEarliest, meta.dateLatest);
          const type = typeMap.get(c.artId);
          return [{
            objectNumber: meta.objectNumber,
            title: meta.title,
            creator: meta.creator,
            ...(date && { date }),
            ...(type && { type }),
            similarityScore: Math.round(c.similarity * 1000) / 1000,
            sourceText: sourceTextMap.get(c.artId),
            url: `https://www.rijksmuseum.nl/en/collection/${meta.objectNumber}`,
          }];
        }).map((r, i) => ({ rank: i + 1, ...r }));

        const mode = filterIds ? "semantic+filtered" : "semantic";
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
