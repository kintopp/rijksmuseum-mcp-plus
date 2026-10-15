import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { VocabularyDb, formatDateRange, FILTER_ART_IDS_KEYS } from "../../api/VocabularyDb.js";
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
import { MultimodalSearchOutput } from "../outputSchemas.js";
import { multimodalSearchCache, multimodalInflight } from "../state.js";

const CHANNELS = ["metadata", "image", "iconclass"] as const;
type Channel = typeof CHANNELS[number];

/** Reciprocal-rank-fusion constant (the usual 60): damps the gap between rank 1 and rank 2. */
const RRF_K = 60;
/** Nearest notations that feed the Iconclass channel. */
const ICONCLASS_NOTATIONS = 3;
/** Per-channel KNN depth. Fixed so every page is cut from the same fused list. */
const CHANNEL_DEPTH = 250;

const CHANNEL_TAG: Record<Channel, string> = { metadata: "meta", image: "img", iconclass: "ic" };

type Output = InferOutput<typeof MultimodalSearchOutput>;

export function registerMultimodalTools(
  server: McpServer,
  gemmaDb: GemmaDb | null,
  gemmaModel: GemmaModel | null,
  vocabDb: VocabularyDb | null,
  withLogging: ReturnType<typeof createLogger>,
  stats?: UsageStats
): void {
  if (!gemmaDb?.available || !gemmaModel?.available || !vocabDb?.available) return;

  server.registerTool(
    "multimodal_search",
    {
      title: "Multimodal Search",
      annotations: ANN_READ_CLOSED,
      description:
        "Find artworks by what they show, ranked over metadata, images and Iconclass. " +
        "One query is matched in three channels of a shared multilingual embedding space: " +
        "'metadata' (title, inscriptions, description and curatorial narrative), " +
        "'image' (the artwork's photograph itself — finds depictions the catalogue never mentions), and " +
        "'iconclass' (the nearest Iconclass notations, then the artworks tagged with them). " +
        "Results are fused by reciprocal rank; each carries its rank and similarity per channel plus matchedBy.\n\n" +
        "Reading the channels: a hit in several channels is the strongest evidence; an image-only hit is " +
        "often an uncatalogued depiction (verify with inspect_artwork_image); a metadata-only hit is described " +
        "but may not be visually central. Similarities are comparable only within one channel — image scores " +
        "run lower than text scores. To see one channel's own ranking (e.g. image-only discoveries pushed below " +
        "the fused cut), pass channels: ['image']. iconclassNotations lists the notations the Iconclass channel " +
        "used; pass a fitting one to search_artwork(iconclass) for the complete tagged set.\n\n" +
        "Best for visual and scene descriptions ('children playing in the street', 'red umbrella', " +
        "'horseman in the snow') and abstract concepts. Weak on artist names and named historical periods — " +
        "use search_artwork filters (creator, creationDate, type) for those, here as pre-filters or there directly. " +
        "Not for artwork-to-artwork similarity — use find_similar. Not for counts — use collection_stats.",
      inputSchema: z.object({
        query: z.string().describe("What the artwork shows or is about (e.g. 'children playing outside on the street')"),
        channels: z.array(z.enum(CHANNELS)).min(1).optional()
          .describe("Channels to run and fuse (default all three). A single channel returns that channel's own ranking."),
        type: stringOrArray().optional().describe("Pre-filter by object type (e.g. 'painting', 'print')."),
        material: stringOrArray().optional().describe("Pre-filter by material."),
        technique: stringOrArray().optional().describe("Pre-filter by technique."),
        creationDate: optStr().optional().describe("Pre-filter by date — exact year ('1642') or wildcard ('16*')"),
        dateMatch: z.preprocess(stripNull,
          z.enum(["overlaps", "within", "midpoint"]).optional(),
        ).describe("Date matching mode — see search_artwork for details."),
        creator: stringOrArray().optional().describe("Pre-filter by artist name."),
        subject: stringOrArray().optional().describe("Pre-filter by subject."),
        iconclass: stringOrArray().optional().describe("Pre-filter by Iconclass notation."),
        depictedPerson: stringOrArray().optional().describe("Pre-filter by depicted person."),
        depictedPlace: stringOrArray().optional().describe("Pre-filter by depicted place."),
        productionPlace: stringOrArray().optional().describe("Pre-filter by production place."),
        collectionSet: stringOrArray().optional().describe("Pre-filter by collection set."),
        aboutActor: optStr().optional().describe("Pre-filter by person (depicted or creator)"),
        imageAvailable: z.preprocess(stripNullCoerceBool, z.boolean().optional()).describe("Pre-filter by digitisation: true = only artworks with images, false = only those without"),
        maxResults: z.number().int().min(1).max(TOOL_LIMITS.multimodal_search.max).default(TOOL_LIMITS.multimodal_search.default).optional()
          .describe("Number of fused results to return (default 15)."),
        offset: z.number().int().min(0).default(0).optional()
          .describe("Skip this many fused results (for pagination). Use with maxResults."),
      }).strict(),
      ...withOutputSchema(MultimodalSearchOutput),
    },
    withLogging("multimodal_search", async (args) => {
      const cacheKey = `${gemmaDb.buildId}|${canonicalInputKey(args)}`;
      return getOrComputeWithInflight(multimodalSearchCache, multimodalInflight, cacheKey, async () => {
        const maxResults = args.maxResults ?? TOOL_LIMITS.multimodal_search.default;
        const offset = args.offset ?? 0;
        const channels: Channel[] = args.channels ? [...new Set(args.channels)] : [...CHANNELS];
        const warnings: string[] = [];

        const tEmbed = performance.now();
        const query = gemmaDb.quantize(await gemmaModel.embed(args.query));
        stats?.recordPhase("multimodal_search", "embed", performance.now() - tEmbed);

        const filterParams: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(args)) {
          if (val !== undefined && FILTER_ART_IDS_KEYS.has(key)) filterParams[key] = val;
        }
        let candidates: number[] | undefined;
        if (Object.keys(filterParams).length > 0) {
          const ids = vocabDb.filterArtIds(filterParams);
          if (ids === null) {
            warnings.push("Metadata filters ignored: none of them is an effective filter. Results are unfiltered.");
          } else if (ids.length === 0) {
            const empty: Output = {
              searchMode: "multimodal+filtered", query: args.query, channels, returnedCount: 0, results: [],
              warnings: ["No artworks match the specified filters."],
            };
            return structuredResponse(empty, `0 multimodal matches for "${args.query}" (no filter matches)`);
          } else {
            candidates = ids;
          }
        }

        const tScan = performance.now();
        const hits = new Map<Channel, GemmaHit[]>();
        if (channels.includes("metadata")) hits.set("metadata", gemmaDb.search("metadata", query, CHANNEL_DEPTH, candidates));
        if (channels.includes("image")) hits.set("image", gemmaDb.search("images", query, CHANNEL_DEPTH, candidates));

        let notations: { notation: string; label: string; similarity: number }[] = [];
        const notationOf = new Map<number, number>(); // art_id → index into notations
        if (channels.includes("iconclass")) {
          notations = gemmaDb.nearestNotations(query, ICONCLASS_NOTATIONS);
          const tagged = vocabDb.artIdsByNotations(notations.map(n => n.notation));
          let ids = [...tagged.keys()];
          if (candidates) {
            const allowed = new Set(candidates);
            ids = ids.filter(id => allowed.has(id));
          }
          // Tagged artworks are ranked by their metadata similarity to the query.
          const ranked = gemmaDb.search("metadata", query, CHANNEL_DEPTH, ids);
          hits.set("iconclass", ranked);
          for (const h of ranked) notationOf.set(h.artId, tagged.get(h.artId)!);
          if (ids.length === 0) {
            warnings.push("Iconclass channel: no artworks carry the nearest notations" + (candidates ? " within the filters." : "."));
          }
        }
        stats?.recordPhase("multimodal_search", "scan", performance.now() - tScan);

        // Reciprocal rank fusion across the channels that ran.
        const fused = new Map<number, { score: number; ranks: Partial<Record<Channel, { rank: number; similarity: number }>> }>();
        for (const [channel, list] of hits) {
          list.forEach((h, i) => {
            const entry = fused.get(h.artId) ?? { score: 0, ranks: {} };
            entry.score += 1 / (RRF_K + i + 1);
            entry.ranks[channel] = {
              rank: i + 1,
              similarity: channel === "iconclass" ? notations[notationOf.get(h.artId)!].similarity : h.similarity,
            };
            fused.set(h.artId, entry);
          });
        }
        const page = [...fused.entries()]
          .sort((a, b) => b[1].score - a[1].score)
          .slice(offset, offset + maxResults);

        const artIds = page.map(([id]) => id);
        const metaMap = vocabDb.batchLookupByArtId(artIds);
        const typeMap = vocabDb.lookupTypes(artIds.map(id => metaMap.get(id)?.objectNumber ?? "").filter(Boolean));
        const round = (x: number) => Math.round(x * 1000) / 1000;

        const results: Output["results"] = [];
        for (const [artId, { ranks }] of page) {
          const meta = metaMap.get(artId);
          if (!meta) continue;
          const date = formatDateRange(meta.dateEarliest, meta.dateLatest);
          const ic = ranks.iconclass;
          results.push({
            rank: offset + results.length + 1,
            objectNumber: meta.objectNumber,
            title: meta.title,
            creator: meta.creator,
            ...(date && { date }),
            ...(typeMap.has(meta.objectNumber) && { type: typeMap.get(meta.objectNumber) }),
            matchedBy: CHANNELS.filter(c => ranks[c]),
            ...(ranks.metadata && { metadata: { rank: ranks.metadata.rank, similarity: round(ranks.metadata.similarity) } }),
            ...(ranks.image && { image: { rank: ranks.image.rank, similarity: round(ranks.image.similarity) } }),
            ...(ic && { iconclass: { rank: ic.rank, similarity: round(ic.similarity), notation: notations[notationOf.get(artId)!].notation } }),
            url: `https://www.rijksmuseum.nl/en/collection/${meta.objectNumber}`,
          });
        }

        const clusterNote = detectComponentClustering(results.map(r => r.objectNumber));
        if (clusterNote) warnings.push(clusterNote);

        const searchMode = candidates ? "multimodal+filtered" : "multimodal";
        const lines = results.map((r, i) => {
          const tags = CHANNELS.flatMap(c => {
            const h = r[c];
            if (!h) return [];
            return [`${CHANNEL_TAG[c]} #${h.rank} ${c === "iconclass" ? r.iconclass!.notation : h.similarity.toFixed(2)}`];
          });
          return formatSearchLine(r, offset + i) + `  [${tags.join(" · ")}]`;
        });
        const textParts = [`${results.length} multimodal matches for "${args.query}" (${searchMode}; channels: ${channels.join(", ")})`];
        if (notations.length) {
          textParts.push("Iconclass: " + notations.map(n => `${n.notation} ${n.label} [${n.similarity.toFixed(2)}]`).join("; "));
        }
        if (lines.length) textParts.push("\n" + lines.join("\n"));

        const data: Output = {
          searchMode,
          query: args.query,
          channels,
          returnedCount: results.length,
          ...(notations.length > 0 && {
            iconclassNotations: notations.map(n => ({ ...n, similarity: round(n.similarity) })),
          }),
          results,
          ...(warnings.length > 0 && { warnings }),
        };
        return structuredResponse(data, textParts.join("\n"));
      });
    })
  );
}
