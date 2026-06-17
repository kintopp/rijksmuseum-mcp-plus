import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { VocabularyDb, formatDateRange } from "../../api/VocabularyDb.js";
import { EmbeddingsDb } from "../../api/EmbeddingsDb.js";
import { UsageStats } from "../../utils/UsageStats.js";
import {
  ANN_READ_CLOSED,
  TOOL_LIMITS,
  stripNull,
  type InferOutput,
  errorResponse,
  structuredResponse,
  withOutputSchema,
  truncate,
  truncateSnippet,
  createLogger,
} from "../helpers.js";
import {
  FindSimilarOutput,
  buildSimilarTextSummary,
} from "../outputSchemas.js";
import {
  resolveObjectNodeId,
  fetchVisualSimilar,
} from "../visualSearch.js";
import { generateSimilarHtml, computePooled, type SimilarCandidate, type SimilarPageData } from "../../similarHtml.js";
import { similarPages, similarTempFiles } from "../state.js";
import type { DepictedSimilarResult } from "../../api/VocabularyDb.js";

export function registerSimilarTools(
  server: McpServer,
  vocabDb: VocabularyDb | null,
  embeddingsDb: EmbeddingsDb | null,
  publicBaseUrl: string | undefined,
  withLogging: ReturnType<typeof createLogger>,
  _stats?: UsageStats
): void {
  const vocabAvailable = vocabDb?.available ?? false;

  if (vocabAvailable && process.env.ENABLE_FIND_SIMILAR !== "false") {
    server.registerTool(
      "find_similar",
      {
        title: "Find Similar Artworks",
        annotations: ANN_READ_CLOSED,
        description:
          "Given one artwork's objectNumber, finds others like it across 9 similarity channels plus a pooled consensus. " +
          "Generates an HTML comparison page with IIIF thumbnails across all 9 channels: " +
          "Visual (image-embedding nearest neighbours), Related Variant (creator-invariant curator-declared edges: pendants, production stadia, different examples), " +
          "Related Object (other curator-declared edges: pairs, sets, recto/verso, reproductions, general related-object links — tiered weights), " +
          "Lineage (creator + assignment-qualifier overlap), Iconclass (subject-notation overlap), Description (Dutch-description embedding similarity), " +
          "Theme (curatorial-theme set overlap, IDF-weighted), Depicted Person, and Depicted Place — plus a Pooled column blending all nine.\n\n" +
          "Not for free-text concept queries — use semantic_search. " +
          "Not for filter-based search — use search_artwork. " +
          "Not for aggregate counts or distributions — use collection_stats.\n\n" +
          "IMPORTANT: The result is a file path or URL to an HTML page. " +
          "Your ONLY job is to show the user the path/URL so they can open it in a browser. " +
          "Do NOT attempt to open, read, fetch, summarise, or characterise the page contents. " +
          "Do NOT make additional tool calls to look up the same artworks. " +
          "Simply present the link and explain that it contains a visual comparison page. " +
          "(The full per-channel results are also returned as structuredContent for programmatic/CLI clients; " +
          "chat hosts should ignore that payload and present only the link.)",
        inputSchema: z.object({
          objectNumber: z.string().describe("Object number of the artwork to find similar works for (e.g. 'SK-A-1718')."),
          maxResults: z.preprocess(stripNull, z.number().int().min(1).max(TOOL_LIMITS.find_similar.max).default(TOOL_LIMITS.find_similar.default).optional())
            .describe("Number of results per signal mode (default 20, max 50)."),
        }).strict(),
        // structuredContent carries the full per-channel payload (#379); text channel stays URL + counts.
        ...withOutputSchema(FindSimilarOutput),
      },
      withLogging("find_similar", async (args) => {
        const maxResults = args.maxResults ?? 20;

        // Resolve query artwork metadata + iiif_id
        const artRow = vocabDb!.lookupArtId(args.objectNumber);
        if (!artRow) return errorResponse(`Artwork "${args.objectNumber}" not found.`);
        const queryMeta = vocabDb!.batchLookupByArtId([artRow.artId]);
        const queryInfo = queryMeta.get(artRow.artId);
        const queryTypeMap = vocabDb!.batchLookupTypesByArtId([artRow.artId]);
        const queryDescMap = vocabDb!.batchLookupDescriptionsByArtId([artRow.artId]);

        const queryDate = formatDateRange(queryInfo?.dateEarliest, queryInfo?.dateLatest);

        // Start visual search HTTP resolution concurrently with sync DB work
        const nodeIdPromise = resolveObjectNodeId(args.objectNumber);

        // ── Run all 4 signals ──────────────────────────────────────

        // Iconclass
        const icResult = vocabDb!.findSimilarByIconclass(args.objectNumber, maxResults);
        const icCandidates: SimilarCandidate[] = (icResult?.results ?? []).map(r => ({
          objectNumber: r.objectNumber,
          title: r.title,
          creator: r.creator,
          ...(r.date && { date: r.date }),
          ...(r.type && { type: r.type }),
          iiifId: r.iiifId,
          score: r.score,
          url: r.url,
          detail: r.sharedMotifs.map(m => `${m.notation} ${m.label}`).join(", "),
          sharedNotations: r.sharedMotifs.map(m => m.notation),
        }));

        // Lineage
        const liResult = vocabDb!.findSimilarByLineage(args.objectNumber, maxResults);
        const liCandidates: SimilarCandidate[] = (liResult?.results ?? []).map(r => {
          const primary = r.sharedLineage[0]; // highest-strength qualifier (sorted by VocabularyDb)
          return {
            objectNumber: r.objectNumber,
            title: r.title,
            creator: r.creator,
            ...(r.date && { date: r.date }),
            ...(r.type && { type: r.type }),
            iiifId: r.iiifId,
            score: r.score,
            url: r.url,
            detail: r.sharedLineage.map(l => `${l.qualifierLabel} ${l.creatorLabel}`).join(", "),
            ...(primary && {
              qualifierLabel: primary.qualifierLabel,
              qualifierUri: primary.qualifierUri,
              qualifierCreator: primary.creatorLabel,
            }),
          };
        });

        // Description — needs its own batch lookups (descriptions not in findSimilarBy* results)
        let descCandidates: SimilarCandidate[] = [];
        if (embeddingsDb?.descriptionAvailable) {
          const descResults = embeddingsDb.searchDescriptionSimilar(artRow.artId, maxResults);
          if (descResults.length > 0) {
            const descArtIds = descResults.map(r => r.artId);
            const descMeta = vocabDb!.batchLookupByArtId(descArtIds);
            const descTypes = vocabDb!.batchLookupTypesByArtId(descArtIds);
            const descTexts = vocabDb!.batchLookupDescriptionsByArtId(descArtIds);
            descCandidates = descResults.map(r => {
              const m = descMeta.get(r.artId);
              const date = formatDateRange(m?.dateEarliest, m?.dateLatest);
              return {
                objectNumber: r.objectNumber,
                title: m?.title ?? "",
                creator: m?.creator ?? "",
                ...(date && { date }),
                ...(descTypes.has(r.artId) && { type: descTypes.get(r.artId) }),
                iiifId: m?.iiifId ?? undefined,
                score: r.similarity,
                url: `https://www.rijksmuseum.nl/en/collection/${r.objectNumber}`,
                detail: truncate(descTexts.get(r.artId) ?? "", 200),
                descSnippet: truncateSnippet(descTexts.get(r.artId), 160),
              };
            });
          }
        }

        // Depicted Person & Place — map directly from enriched findSimilarBy* results
        function toDepictedCandidates(result: DepictedSimilarResult | null): SimilarCandidate[] {
          return (result?.results ?? []).map(r => ({
            objectNumber: r.objectNumber,
            title: r.title,
            creator: r.creator,
            ...(r.date && { date: r.date }),
            ...(r.type && { type: r.type }),
            iiifId: r.iiifId,
            score: r.score,
            url: r.url,
            detail: r.sharedTerms.map(t => t.label).join(", "),
            sharedTerms: r.sharedTerms.map(t => ({
              label: t.label,
              ...(t.wikidataUri && { wikidataUri: t.wikidataUri }),
            })),
          }));
        }

        const dpResult = vocabDb!.findSimilarByDepictedPerson(args.objectNumber, maxResults);
        const dpCandidates = toDepictedCandidates(dpResult);

        const dplResult = vocabDb!.findSimilarByDepictedPlace(args.objectNumber, maxResults);
        const dplCandidates = toDepictedCandidates(dplResult);

        // Theme (#294) — gated to allow disabling without taking down find_similar
        const themeEnabled = process.env.ENABLE_THEME_SIMILAR !== "false";
        const thResult = themeEnabled
          ? vocabDb!.findSimilarByTheme(args.objectNumber, maxResults)
          : null;
        const thCandidates = toDepictedCandidates(thResult);

        // Related Variant (#293) — creator-invariant curator-declared edges
        // ('different example' / 'production stadia' / 'pendant'), fixed score=10
        const rvResult = vocabDb!.findSimilarByRelatedVariant(args.objectNumber, maxResults);
        const rvCandidates = toDepictedCandidates(rvResult);

        // Related Object — other curator-declared edges (pair / set / recto|verso /
        // reproduction / catch-all related object), tiered scores 2-6.
        const roResult = vocabDb!.findSimilarByRelatedObject(args.objectNumber, maxResults);
        const roCandidates = toDepictedCandidates(roResult);

        // Visual (Rijksmuseum website API — best-effort, never blocks other signals)
        // nodeIdPromise was started concurrently with the sync DB signals above
        let visualCandidates: SimilarCandidate[] = [];
        let visualSearchUrl: string | undefined;
        let visualTotalResults: number | undefined;
        try {
          const nodeId = await nodeIdPromise;
          if (nodeId) {
            const visual = await fetchVisualSimilar(nodeId, maxResults);
            visualCandidates = visual.candidates;
            visualSearchUrl = visual.searchUrl;
            visualTotalResults = visual.totalResults;
          }
        } catch {
          // Visual search is best-effort — silently continue without it
        }

        // ── Generate HTML page ─────────────────────────────────────

        const pageData: SimilarPageData = {
          query: {
            objectNumber: args.objectNumber,
            title: artRow.title,
            creator: artRow.creator,
            date: queryDate,
            type: queryTypeMap.get(artRow.artId),
            iiifId: queryInfo?.iiifId ?? undefined,
            description: queryDescMap.get(artRow.artId),
            iconclassCodes: icResult?.queryNotations.map(n => ({ notation: n.notation, label: n.label })),
            lineageQualifiers: liResult?.queryLineage.map(q => ({
              label: q.qualifierLabel,
              aatUri: q.qualifierUri,
              creator: q.creatorLabel,
            })),
            depictedPersons: dpResult?.queryTerms.map(t => ({ label: t.label, ...(t.wikidataUri && { wikidataUri: t.wikidataUri }) })),
            depictedPlaces: dplResult?.queryTerms.map(t => ({ label: t.label, ...(t.wikidataUri && { wikidataUri: t.wikidataUri }) })),
            themes: thResult?.queryTerms.map(t => t.label),
            relatedVariantLabels: rvResult?.queryTerms.map(t => t.label),
            relatedObjectLabels: roResult?.queryTerms.map(t => t.label),
          },
          modes: {
            iconclass: icCandidates,
            lineage: liCandidates,
            description: descCandidates,
            ...(visualCandidates.length > 0 && { visual: visualCandidates }),
            ...(thCandidates.length > 0 && { theme: thCandidates }),
            ...(rvCandidates.length > 0 && { relatedVariant: rvCandidates }),
            ...(roCandidates.length > 0 && { relatedObject: roCandidates }),
            ...(dpCandidates.length > 0 && { depictedPerson: dpCandidates }),
            ...(dplCandidates.length > 0 && { depictedPlace: dplCandidates }),
          },
          poolThreshold: 4,
          generatedAt: new Date().toISOString().slice(0, 16).replace("T", " "),
          ...(visualSearchUrl && { visualSearchUrl }),
          ...(visualTotalResults && { visualTotalResults }),
        };

        const html = generateSimilarHtml(pageData);

        // Build response URL or file path
        let pageLocation: string;
        const pageUUID = randomUUID();
        if (publicBaseUrl) {
          // HTTP mode — store in memory, serve at /similar/:uuid
          similarPages.set(pageUUID, { html, lastAccess: Date.now() });
          pageLocation = `${publicBaseUrl}/similar/${pageUUID}`;
        } else {
          // stdio mode — write to OS temp directory (no HTTP server to serve from)
          const filePath = path.join(os.tmpdir(), `rijksmuseum-similar-${pageUUID}.html`);
          fs.writeFileSync(filePath, html, "utf-8");
          similarTempFiles.set(filePath, Date.now());
          pageLocation = filePath;
        }

        // Summary counts
        const counts = [
          ...(visualCandidates.length > 0 ? [`Visual: ${visualCandidates.length}`] : []),
          `Related Variant: ${rvCandidates.length}`,
          `Related Object: ${roCandidates.length}`,
          `Lineage: ${liCandidates.length}`,
          `Iconclass: ${icCandidates.length}`,
          `Description: ${descCandidates.length}`,
          `Theme: ${thCandidates.length}`,
          `Person: ${dpCandidates.length}`,
          `Place: ${dplCandidates.length}`,
        ];
        const poolThreshold = pageData.poolThreshold;
        // Pooled list — shared with the HTML renderer via computePooled (#379),
        // replacing the previous standalone pooled-count loop.
        const { pooled } = computePooled(pageData.modes, poolThreshold);
        const pooledN = pooled.length;

        const textLines = [
          `Similar to "${artRow.title}" (${args.objectNumber})`,
          counts.join(" | ") + ` | Pooled (${poolThreshold}+): ${pooledN}`,
          "",
          pageLocation,
        ];

        // Structured output (#379): the full per-channel data a programmatic/CLI
        // client needs, on structuredContent. The text channel carries the prose
        // link + counts (block[0]) AND a trimmed comparison summary (block[1], via
        // jsonTextData) so text-only LLM hosts can answer about the comparison
        // without reading structuredContent or fetching the HTML page.
        const structured: InferOutput<typeof FindSimilarOutput> = {
          query: pageData.query,
          modes: pageData.modes,
          pooled,
          poolThreshold,
          pageUrl: pageLocation,
          generatedAt: pageData.generatedAt,
          ...(pageData.visualSearchUrl && { visualSearchUrl: pageData.visualSearchUrl }),
          ...(pageData.visualTotalResults && { visualTotalResults: pageData.visualTotalResults }),
        };

        return structuredResponse(structured, textLines.join("\n"), {
          jsonText: true,
          jsonTextData: buildSimilarTextSummary(structured),
          maxJsonTextBytes: 50_000,
        });
      })
    );
  }
}
