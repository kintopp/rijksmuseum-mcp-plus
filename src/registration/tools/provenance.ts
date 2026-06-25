import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { OaiPmhClient } from "../../api/OaiPmhClient.js";
import { VocabularyDb, pluralize, type ProvenanceSearchParams } from "../../api/VocabularyDb.js";
import { UsageStats } from "../../utils/UsageStats.js";
import { SAFE_RESULT_BUDGET } from "../../utils/responseShape.js";
import {
  ANN_READ_CLOSED,
  TOOL_LIMITS,
  PROVENANCE_EVENT_ONLY_FILTERS,
  PROVENANCE_PERIOD_ONLY_FILTERS,
  PROVENANCE_SHARED_FILTERS,
  PROVENANCE_ALL_FILTERS,
  stripNull,
  stripNullCoerceBool,
  normalizeStringOrArray,
  optStr,
  type InferOutput,
  PROVENANCE_TEXT_RESERVE,
  EMIT_STRUCTURED,
  errorResponse,
  structuredResponse,
  withOutputSchema,
  formatRecordLine,
  addPercentages,
  formatFacets,
  compactMethodTag,
  provenanceCompactSummary,
  provenanceMatchedEvents,
  createLogger,
  paginatedResponse,
  drainOaiBuffer,
  resolveOaiBuffer,
} from "../helpers.js";
import {
  RecentChangesOutput,
} from "../outputSchemas.js";
import { generateEnrichmentReviewHtml, isLlmEnrichedEvent, isLlmEnrichedParty, type EnrichmentReviewData } from "../../enrichmentReviewHtml.js";
import { enrichmentReviewPages } from "../state.js";

const PROVENANCE_TRANSFER_TYPES = [
  "sale", "inheritance", "by_descent", "widowhood", "bequest", "commission",
  "confiscation", "theft", "looting", "recuperation", "restitution",
  "loan", "transfer", "collection", "gift",
  "deposit", "exchange", "inventory",
  "unknown",
] as const;

const ProvenanceSearchOutput = {
  totalArtworks: z.number().int()
    .describe("Number of artworks with matching provenance events/periods. Capped at 50,000 — see totalArtworksCapped."),
  totalArtworksCapped: z.boolean().optional()
    .describe("True when the actual total reaches the 50,000 cap. Narrow the search to bring the total under the cap if you need an exact figure."),
  results: z.array(z.object({
    objectNumber: z.string(),
    title: z.string(),
    creator: z.string(),
    date: z.string().optional(),
    url: z.string(),
    eventCount: z.number().int(),
    matchedEventCount: z.number().int(),
    events: z.array(z.object({
      sequence: z.number().int(),
      rawText: z.string(),
      gap: z.boolean(),
      transferType: z.string(),
      unsold: z.boolean()
        .describe("True if this sale event was unsold, bought in, or withdrawn at auction. Only meaningful when transferType is 'sale'."),
      batchPrice: z.boolean()
        .describe("True if the price is a batch/en bloc total for multiple artworks, not an individual price. Filter these out when ranking by price."),
      transferCategory: z.enum(["ownership", "custody", "ambiguous"]).nullable()
        .describe("Whether this transfer involves ownership change, custody change, or is ambiguous."),
      uncertain: z.boolean(),
      parties: z.array(z.object({
        name: z.string(),
        dates: z.string().nullable(),
        uncertain: z.boolean(),
        role: z.string().nullable(),
        position: z.enum(["sender", "receiver", "agent"]).nullable()
          .describe("Party's position in the transfer: sender (relinquishes), receiver (acquires), agent (facilitates)."),
        positionMethod: z.string().nullable().optional()
          .describe("How position was determined: role_mapping (parser), llm_enrichment (LLM-classified), llm_disambiguation (LLM-decomposed from merged text)."),
        enrichmentReasoning: z.string().nullable().optional()
          .describe("LLM reasoning for position assignment (only present for llm_enrichment/llm_disambiguation)."),
      })),
      dateExpression: z.string().nullable(),
      dateYear: z.number().int().nullable(),
      dateQualifier: z.string().nullable(),
      location: z.string().nullable(),
      price: z.object({
        amount: z.number(),
        currency: z.string(),
      }).nullable(),
      saleDetails: z.string().nullable(),
      citations: z.array(z.object({ text: z.string() })),
      isCrossRef: z.boolean(),
      crossRefTarget: z.string().nullable(),
      // #268: the fine-axis literals below mirror scripts/provenance-enrichment-methods.mjs
      // (and its Python twin scripts/provenance_enrichment_methods.py). Any rename or
      // addition must be made there first; the writebacks are the source of truth for
      // what lands in the DB.
      parseMethod: z.enum(["peg", "regex_fallback", "cross_ref", "credit_line", "llm_structural"]),
      categoryMethod: z.string().nullable().optional()
        .describe("How transfer_category was determined: type_mapping (parser), llm_enrichment, rule:transfer_is_ownership."),
      correctionMethod: z.string().nullable().optional()
        .describe("LLM structural correction applied: llm_structural:#149 (location), llm_structural:#87 (reclassification), llm_structural:#125 (event split), etc."),
      enrichmentReasoning: z.string().nullable().optional()
        .describe("LLM reasoning for type/category classification or structural correction."),
      matched: z.boolean().describe("True if this event matched the search criteria."),
    })).optional().describe("Full event chain. Present in full mode; omitted when compact=true."),
    summary: z.object({
      eventCount: z.number().int(),
      matchedEventCount: z.number().int(),
      yearSpan: z.array(z.number().int().nullable())
        .describe("[earliest, latest] event year across the chain; either element may be null."),
      transferTypes: z.array(z.string()).describe("Distinct transfer types in the chain, excluding unknown/non_provenance."),
      firstOwner: z.string().nullable(),
      lastOwner: z.string().nullable(),
      hasGap: z.boolean(),
      hasPrice: z.boolean(),
    }).optional().describe("Compact-mode fixed-size rollup of the full chain (present only when compact=true)."),
    matchedEvents: z.array(z.object({
      sequence: z.number().int(),
      transferType: z.string(),
      parties: z.array(z.string()).describe("Party names, with the role (buyer/seller/consignor/…) annotated in parentheses when known, e.g. 'Jacques Goudstikker (seller)'."),
      dateExpression: z.string().nullable(),
      location: z.string().nullable(),
      price: z.object({ amount: z.number(), currency: z.string() }).nullable(),
      rawText: z.string().describe("Trimmed 'why it matched' phrase for this event."),
    })).optional().describe("Compact-mode matched-event one-liners (present only when compact=true)."),
    periods: z.array(z.object({
      sequence: z.number().int(),
      ownerName: z.string().nullable(),
      ownerDates: z.string().nullable(),
      location: z.string().nullable(),
      acquisitionMethod: z.string().nullable(),
      acquisitionFrom: z.string().nullable(),
      beginYear: z.number().int().nullable(),
      beginYearLatest: z.number().int().nullable(),
      endYear: z.number().int().nullable(),
      duration: z.number().int().nullable().describe("Ownership duration in years (endYear - beginYear), null if unknown."),
      derivation: z.record(z.string(), z.string()).describe("How each field was derived from source events."),
      uncertain: z.boolean(),
      citations: z.array(z.object({ text: z.string() })),
      sourceEvents: z.array(z.number().int()),
      matched: z.boolean().describe("True if this period matched the search criteria."),
    })).optional().describe("Ownership periods (Layer 2 interpretation). Present when layer='periods'."),
    periodCount: z.number().int().optional(),
    matchedPeriodCount: z.number().int().optional(),
  })),
  facets: z.record(z.string(), z.array(z.object({
    label: z.string(),
    count: z.number().int(),
    percentage: z.number().optional(),
  }))).optional().describe("Provenance facets when facets=true. Dimensions: transferType, decade, location, transferCategory, partyPosition."),
  creditLineResults: z.array(z.object({
    objectNumber: z.string(),
    title: z.string(),
    creator: z.string(),
    date: z.string().optional(),
    url: z.string(),
    creditLine: z.string(),
  })).optional().describe(
    "UNSTRUCTURED fallback matches from the artwork credit-line field (acquisition/funding statements), " +
    "returned only when creditLineQuery is used, and only for artworks that have NO parsed provenance. " +
    "These are NOT curated provenance chains — they describe how the museum acquired the work (often just a " +
    "funding body), with no parsed parties, dates, or transfer types. When presenting these to the user you " +
    "MUST state that the answer derives from unstructured credit-line text, not parsed provenance.",
  ),
  warnings: z.array(z.string()).optional(),
  autoCompacted: z.boolean().optional()
    .describe("True when the server returned compact summaries because the full (compact=false) result would exceed the per-result size limit. You requested full mode; re-query with fewer artworks (maxResults ≤ 10) or a single objectNumber for full event-by-event chains."),
  error: z.string().optional(),
};

export function registerProvenanceTools(
  server: McpServer,
  oai: OaiPmhClient,
  vocabDb: VocabularyDb | null,
  publicBaseUrl: string | undefined,
  withLogging: ReturnType<typeof createLogger>,
  _stats?: UsageStats
): void {
  const vocabAvailable = vocabDb?.available ?? false;

  // ── get_recent_changes ──────────────────────────────────────────

  server.registerTool(
    "get_recent_changes",
    {
      title: "Get Recent Changes",
      annotations: ANN_READ_CLOSED,
      description:
        "OAI-PMH delta feed — records changed within a date range since a known harvest checkpoint, paginated. " +
        "Use identifiersOnly=true for a lightweight listing (headers only, no full metadata). " +
        "Each record includes an objectNumber for follow-up calls to get_artwork_details or get_artwork_image. " +
        "Deleted records are flagged with deleted:true (marked [DELETED] in the listing) and carry only a LOD URI + datestamp, no metadata.",
      inputSchema: z.object({
        from: optStr()
          .optional()
          .describe(
            "Start date in ISO 8601 format (e.g. '2026-02-01T00:00:00Z' or '2026-02-01'). Required for initial request, ignored when resumptionToken is provided."
          ),
        until: optStr()
          .optional()
          .describe(
            "End date in ISO 8601 format (defaults to now)"
          ),
        setSpec: optStr()
          .optional()
          .describe("Restrict to changes within a specific set"),
        identifiersOnly: z.preprocess(stripNullCoerceBool, z.boolean().default(false))
          .describe(
            "If true, returns only record headers (identifier, datestamp, set memberships) — much faster. Preserved automatically across continuation pages."
          ),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(TOOL_LIMITS.get_recent_changes.max)
          .default(TOOL_LIMITS.get_recent_changes.default)
          .describe(`Maximum records to return (1-${TOOL_LIMITS.get_recent_changes.max}, default ${TOOL_LIMITS.get_recent_changes.default})`),
        resumptionToken: optStr()
          .optional()
          .describe(
            "Pagination token from a previous get_recent_changes result. When provided, all other filters are ignored."
          ),
      }).strict(),
      ...withOutputSchema(RecentChangesOutput),
    },
    withLogging("get_recent_changes", async (args) => {
      if (!args.resumptionToken && !args.from) {
        return errorResponse("Either from or resumptionToken is required.");
      }

      const fetchByMode = (token: string, identifiers?: boolean) =>
        identifiers
          ? oai.listIdentifiers({ resumptionToken: token })
          : oai.listRecords({ resumptionToken: token });

      const resolved = resolveOaiBuffer(args.resumptionToken, "get_recent_changes");
      if (resolved && "error" in resolved) return resolved.error;
      if (resolved) {
        const useIdentifiers = resolved.buffered.identifiersOnly ?? args.identifiersOnly;
        const extra = useIdentifiers ? { identifiersOnly: true } : undefined;
        return drainOaiBuffer(
          resolved.buffered, args.maxResults, "totalChanges", "get_recent_changes",
          (token) => fetchByMode(token, useIdentifiers),
          extra, formatRecordLine,
        );
      }

      const opts = {
        from: args.from,
        until: args.until,
        set: args.setSpec,
        resumptionToken: args.resumptionToken,
      };

      const useIdentifiers = args.identifiersOnly;
      const result = useIdentifiers
        ? await oai.listIdentifiers(opts)
        : await oai.listRecords(opts);

      const extra = useIdentifiers ? { identifiersOnly: true } : undefined;
      return paginatedResponse(result, args.maxResults, "totalChanges", "get_recent_changes", extra, formatRecordLine, useIdentifiers);
    })
  );

  // ── search_provenance (conditionally registered when provenance tables exist) ──

  if (vocabAvailable && vocabDb!.hasProvenanceTables) {
    server.registerTool(
      "search_provenance",
      {
        title: "Search Provenance",
        annotations: ANN_READ_CLOSED,
        description:
          "Ownership-history search across parsed provenance chains — collectors, sales, gifts, confiscations, restitutions. " +
          "Returns full provenance chains grouped by artwork, with matching events flagged.\n\n" +
          "Not for catalogue keyword search — use search_artwork. " +
          "Not for aggregate provenance counts — use collection_stats with provenance dimensions/filters. " +
          "periodLocation is a period-level location filter, preferred over location at layer='periods' for clarity.\n\n" +
          "Each chain tells the complete ownership story: collectors, sales, inheritances, gifts, confiscations, and restitutions, with dates, locations, prices, and citations.\n\n" +
          "Use objectNumber for a single artwork's chain (fast local lookup, no network). " +
          "Use party to trace a collector or dealer across artworks (e.g. 'Six', 'Rothschild'). " +
          "Use relatedTo for reverse cross-references — find all works sharing provenance with a given object " +
          "(pendants, album sheets, dollhouse contents). " +
          "Combine transferType, dateFrom/dateTo, location for pattern discovery " +
          "(e.g. confiscations 1940–1945, sales in Paris).\n\n" +
          "IMPORTANT flags on events:\n" +
          "- unsold: true means this sale event was unsold/bought-in/withdrawn at auction — no ownership transfer occurred. " +
          "Filter these when analysing actual sales.\n" +
          "- batchPrice: true means the price is an en bloc/batch total for multiple artworks, not an individual price. " +
          "Filter these when ranking or comparing prices — they massively distort rankings.\n\n" +
          "Every record carries provenance-of-provenance metadata: parseMethod shows how the event was parsed " +
          "(peg, regex_fallback, cross_ref, credit_line, llm_structural), categoryMethod/positionMethod show how classifications " +
          "and party positions were determined (type_mapping, role_mapping, llm_enrichment, llm_disambiguation, " +
          "rule:transfer_is_ownership), correctionMethod (llm_structural:#NNN) shows LLM structural corrections " +
          "(location fixes, event reclassification, event splitting), and enrichmentReasoning provides the LLM's reasoning " +
          "for any non-deterministic decision. Parties have position (sender/receiver/agent) indicating their role in the transfer.\n\n" +
          "IMPORTANT: When results contain LLM-enriched records, the response text ends with a REVIEW_URL or REVIEW_FILE line. " +
          "You MUST copy this URL or file path verbatim into your response as a clickable link or openable path. " +
          "Do NOT omit it, paraphrase it, summarise it, or refer to it indirectly (e.g. 'see the link above'). " +
          "The user cannot see tool output — if you do not include the path, they have no way to find the review page.\n\n" +
          "Use hasGap to find artworks with gaps in their provenance chain — red flags for wartime displacement or undocumented transfers. " +
          "Only the parsed provenance fields exposed below are searchable. " +
          "At least one filter is required.\n\n" +
          "FALLBACK — creditLineQuery: only ~48K artworks have parsed provenance, but many more carry an unstructured " +
          "credit-line field (acquisition/funding statements). Use creditLineQuery as a SECOND step: run a normal structured " +
          "search first; if the relevant artworks turn out to have no parsed provenance, offer to extend the search with " +
          "creditLineQuery. It runs a standalone free-text search over credit lines of artworks lacking parsed provenance, " +
          "returns matches in creditLineResults (not results), and ignores all other filters. Credit-line data is a weaker, " +
          "less reliable source (the museum's terminal acquisition channel, not prior ownership) — when you present these " +
          "results you MUST tell the user the answer derives from unstructured credit-line text, not structured provenance.",
        inputSchema: z.object({
          layer: z.preprocess(stripNull,
            z.enum(["events", "periods"]).default("events").optional(),
          ).describe("Data layer. 'events' (default): raw parsed provenance events (Layer 1). 'periods': interpreted ownership periods with durations (Layer 2)."),
          party: optStr().describe("Owner, collector, or dealer name (partial match, e.g. 'Six', 'Rothschild', 'Westendorp')."),
          transferType: z.preprocess(
            normalizeStringOrArray,
            z.union([z.enum(PROVENANCE_TRANSFER_TYPES), z.array(z.enum(PROVENANCE_TRANSFER_TYPES))]).optional(),
          ).describe("Type of ownership transfer (single or array). Use excludeTransferType for set difference (e.g. confiscated but never restituted). Well-populated: collection (18.5K), sale (15.6K — includes unsold, filter with unsold flag), by_descent (13.7K), gift (10.7K), transfer (6.2K), loan (6.3K), bequest (4.4K), widowhood (3.4K). Rare: recuperation, commission, deposit, restitution, confiscation, exchange, inventory, theft, looting. Generic: inheritance (when specific relationship unknown)."),
          excludeTransferType: z.preprocess(
            normalizeStringOrArray,
            z.union([z.enum(PROVENANCE_TRANSFER_TYPES), z.array(z.enum(PROVENANCE_TRANSFER_TYPES))]).optional(),
          ).describe("Exclude artworks that have ANY event of this type. Artwork-level negation (e.g. confiscated but never restituted)."),
          ownerName: optStr().describe("Owner name (partial match). Only used with layer='periods'."),
          acquisitionMethod: z.preprocess(stripNull,
            z.enum(PROVENANCE_TRANSFER_TYPES).optional(),
          ).describe("Acquisition method filter (exact match). Only used with layer='periods'."),
          location: optStr().describe("City or place name (partial match, e.g. 'Amsterdam', 'Paris', 'London')."),
          periodLocation: optStr().describe(
            "Place name on the ownership-period record (e.g. 'Amsterdam', 'Paris'). " +
            "Filters against provenance_periods.location (45% populated). " +
            "Preferred over location when scoping a periods-layer query — distinguishable from event-level location. " +
            "AND-combined with location when both are supplied. Only used with layer='periods'.",
          ),
          dateFrom: z.preprocess(stripNull, z.number().int().optional())
            .describe("Earliest year (inclusive) for provenance event/period dates."),
          dateTo: z.preprocess(stripNull, z.number().int().optional())
            .describe("Latest year (inclusive) for provenance event/period dates."),
          objectNumber: optStr().describe("Get full provenance chain for a specific artwork (e.g. 'SK-A-2344'). Fast local lookup."),
          creditLineQuery: optStr().describe(
            "UNSTRUCTURED fallback search. Free-text query against the artwork credit-line field (acquisition/funding " +
            "statements like 'Gift of F.G. Waller, Amsterdam' or 'Purchased with the support of the Mondriaan Fonds'), " +
            "restricted to artworks that have NO parsed provenance. Use this ONLY as a second step: run a normal " +
            "structured search first, and if relevant artworks turn out to have no parsed provenance, extend the search " +
            "here. The query is tokenized on whitespace and AND-combined (e.g. 'Waller Amsterdam' matches credit lines " +
            "containing both terms in any order). This is a standalone mode — when set, all other provenance filters are " +
            "ignored. Results are returned in creditLineResults (not results) and are NOT curated provenance; you MUST " +
            "tell the user the answer comes from unstructured credit-line text.",
          ),
          creator: optStr().describe("Artist name (partial match on creator, e.g. 'Rembrandt', 'Vermeer')."),
          currency: z.preprocess(stripNull,
            z.enum(["guilders", "euros", "pounds", "francs", "dollars", "livres", "napoléons", "deutschmarks", "reichsmarks", "swiss_francs", "guineas", "belgian_francs", "yen", "marks", "louis_d_or"]).optional(),
          ).describe("Price currency filter (exact match). Only used with layer='events'."),
          hasPrice: z.preprocess(stripNullCoerceBool, z.boolean().optional())
            .describe("If true, only events with recorded prices. Only used with layer='events'."),
          hasGap: z.preprocess(stripNullCoerceBool, z.boolean().optional())
            .describe("If true, only artworks with provenance gaps (undocumented periods). Only used with layer='events'."),
          relatedTo: optStr().describe("Reverse cross-reference: find all artworks whose provenance references this object number (e.g. 'BK-14656'). Only used with layer='events'."),
          categoryMethod: optStr().describe(
            "Filter events by how transfer_category was determined. Values: type_mapping (parser-assigned), " +
            "llm_enrichment (LLM-classified), rule:transfer_is_ownership (deterministic rule). " +
            "Use categoryMethod='llm_enrichment' to find artworks with LLM-mediated type classifications.",
          ),
          positionMethod: optStr().describe(
            "Filter by how party positions (sender/receiver/agent) were determined. Values: role_mapping (parser), " +
            "type_mapping (from transfer type), llm_enrichment (LLM-classified), llm_disambiguation (LLM-decomposed from merged text), rule:missing_receiver (deterministic tail-party backfill). " +
            "Use positionMethod='llm_enrichment' to find artworks with LLM-mediated party positions. " +
            "When combined with `party`, both filters must hold on the same party row of the same event — " +
            "useful for auditing whether a specific party's classification was deterministic vs LLM-mediated.",
          ),
          minDuration: z.preprocess(stripNull, z.number().int().min(1).optional())
            .describe("Minimum ownership years. Only used with layer='periods'."),
          maxDuration: z.preprocess(stripNull, z.number().int().min(1).optional())
            .describe("Maximum ownership years. Only used with layer='periods'."),
          sortBy: z.preprocess(stripNull,
            z.enum(["price", "dateYear", "eventCount", "duration"]).optional(),
          ).describe("Sort results by this dimension. Use sortBy to rank results (e.g. highest prices, longest ownership). 'duration' only works with layer='periods'."),
          sortOrder: z.preprocess(stripNull,
            z.enum(["asc", "desc"]).default("desc").optional(),
          ).describe("Sort direction (default 'desc')."),
          offset: z.preprocess(stripNull,
            z.number().int().min(0).default(0).optional(),
          ).describe("Skip this many artworks (for pagination). Use with maxResults."),
          maxResults: z.preprocess(stripNull,
            z.number().int().min(1).max(TOOL_LIMITS.search_provenance.max).default(TOOL_LIMITS.search_provenance.default).optional(),
          ).describe(`Maximum artworks to return (1–${TOOL_LIMITS.search_provenance.max}, default ${TOOL_LIMITS.search_provenance.default}). Each artwork includes its full chain.`),
          facets: z.preprocess(stripNullCoerceBool, z.boolean().optional())
            .describe("If true, compute provenance facets: transferType, decade, location, transferCategory, partyPosition."),
          compact: z.preprocess(stripNullCoerceBool, z.boolean().default(false))
            .describe("Compact per-artwork comparison mode: omit the full event/period arrays; return a fixed-size summary rollup plus matched-event one-liners per artwork. Use to compare a collector/dealer across many works in one call (full mode overflows the result cap past ~1 artwork). Raises the default maxResults to 12."),
        }).strict(),
        ...withOutputSchema(ProvenanceSearchOutput),
      },
      withLogging("search_provenance", async (args: Record<string, unknown>) => {
        const layer = (args.layer as string | undefined) ?? "events";
        const requestedCompact = args.compact === true;
        // effectiveCompact may flip to true below if a non-compact result would
        // exceed the host size ceiling (auto-downgrade, plan 029).
        let effectiveCompact = requestedCompact;
        let autoCompacted = false;

        // ── Credit-line fallback (standalone unstructured mode) ──
        // When creditLineQuery is set we ignore all structured provenance filters and
        // run a free-text search of the credit-line field, restricted to artworks with
        // no parsed provenance. Results are clearly fenced off as a lower-confidence source.
        if (args.creditLineQuery) {
          const clQuery = args.creditLineQuery as string;
          // searchCreditLineFallback owns the default (10 — credit-line rows are one line
          // each, unlike the structured default of 1) and the [1,max] clamp.
          const clResult = vocabDb!.searchCreditLineFallback(clQuery, {
            maxResults: args.maxResults as number | undefined,
            offset: (args.offset as number | undefined) ?? 0,
          });

          // Everything except the three params this branch honours is ignored.
          const ignored = Object.keys(args)
            .filter(k => !["creditLineQuery", "maxResults", "offset"].includes(k));
          const warnings: string[] = [];
          if (ignored.length > 0) {
            warnings.push(
              `creditLineQuery runs a standalone unstructured search; these filters were ignored: ${ignored.join(", ")}. ` +
              `Run them in a separate structured search_provenance call.`,
            );
          }

          const clLines: string[] = [];
          if (clResult.totalArtworksCapped) {
            clLines.push(`≥${clResult.totalArtworks.toLocaleString()} artworks matched on UNSTRUCTURED credit-line text (capped — narrow the query for an exact total)`);
          } else {
            clLines.push(`${pluralize(clResult.totalArtworks, "artwork")} matched on UNSTRUCTURED credit-line text`);
          }
          clLines.push(
            "SOURCE: artwork credit-line / acquisition-credit field — NOT curated provenance. " +
            "These artworks have no parsed provenance; credit lines record how the museum acquired the work " +
            "(often just a funding body), not prior ownership. You MUST tell the user this answer comes from " +
            "unstructured credit-line text, not structured provenance.",
          );
          for (const r of clResult.results) {
            clLines.push("");
            clLines.push(`${r.objectNumber} | "${r.title}" — ${r.creator}${r.date ? ` (${r.date})` : ""}`);
            clLines.push(`  ${r.url}`);
            clLines.push(`  Credit line: ${r.creditLine}`);
          }

          const clData: InferOutput<typeof ProvenanceSearchOutput> = {
            totalArtworks: clResult.totalArtworks,
            totalArtworksCapped: clResult.totalArtworksCapped,
            results: [],
            creditLineResults: clResult.results,
            ...(warnings.length > 0 && { warnings }),
          };
          return structuredResponse(clData, clLines.join("\n"));
        }

        const params: ProvenanceSearchParams = {
          // #386: compact mode defaults higher (per-artwork payload is tiny) so a single
          // call can compare many works; still clamped to the tool max.
          maxResults: (args.maxResults as number | undefined)
            ?? (requestedCompact ? Math.min(12, TOOL_LIMITS.search_provenance.max) : TOOL_LIMITS.search_provenance.default),
          layer: layer as "events" | "periods",
        };
        if (args.party) params.party = args.party as string;
        if (args.transferType) params.transferType = args.transferType as string | string[];
        if (args.excludeTransferType) params.excludeTransferType = args.excludeTransferType as string | string[];
        if (args.ownerName) params.ownerName = args.ownerName as string;
        if (args.acquisitionMethod) params.acquisitionMethod = args.acquisitionMethod as string;
        if (args.location) params.location = args.location as string;
        if (args.periodLocation) params.periodLocation = args.periodLocation as string;
        if (args.dateFrom != null) params.dateFrom = args.dateFrom as number;
        if (args.dateTo != null) params.dateTo = args.dateTo as number;
        if (args.objectNumber) params.objectNumber = args.objectNumber as string;
        if (args.creator) params.creator = args.creator as string;
        if (args.currency) params.currency = args.currency as string;
        if (args.hasPrice != null) params.hasPrice = args.hasPrice as boolean;
        if (args.hasGap != null) params.hasGap = args.hasGap as boolean;
        if (args.relatedTo) params.relatedTo = args.relatedTo as string;
        if (args.categoryMethod) params.categoryMethod = args.categoryMethod as string;
        if (args.positionMethod) params.positionMethod = args.positionMethod as string;
        if (args.minDuration != null) params.minDuration = args.minDuration as number;
        if (args.maxDuration != null) params.maxDuration = args.maxDuration as number;
        if (args.sortBy) params.sortBy = args.sortBy as ProvenanceSearchParams["sortBy"];
        if (args.sortOrder) params.sortOrder = args.sortOrder as "asc" | "desc";
        if (args.offset != null) params.offset = args.offset as number;
        if (args.facets) params.facets = true;

        // At least one substantive filter required
        const hasFilter = PROVENANCE_ALL_FILTERS
          .some(k => (params as Record<string, unknown>)[k] !== undefined);
        if (!hasFilter) {
          return errorResponse(
            "At least one search filter is required (e.g. party, transferType, location, dateFrom/dateTo, creator, objectNumber, " +
            "ownerName, acquisitionMethod, minDuration). Modifiers like sortBy, sortOrder, maxResults, offset, and layer do not count. " +
            "Tip: use a broad filter such as dateFrom: 1400 for collection-wide ranking.",
          );
        }

        // Reject filters that the chosen layer does not implement
        const ignoredFilters = (layer === "periods" ? PROVENANCE_EVENT_ONLY_FILTERS : PROVENANCE_PERIOD_ONLY_FILTERS)
          .filter(k => (params as Record<string, unknown>)[k] !== undefined);
        if (ignoredFilters.length > 0) {
          return errorResponse(
            `The "${layer}" layer does not support these filters: ${ignoredFilters.join(", ")}. ` +
            (layer === "periods"
              ? `Switch to layer="events" for event-level filters, or use: ${[...PROVENANCE_SHARED_FILTERS, ...PROVENANCE_PERIOD_ONLY_FILTERS].join(", ")}.`
              : `Switch to layer="periods" for period-level filters, or use: ${[...PROVENANCE_SHARED_FILTERS, ...PROVENANCE_EVENT_ONLY_FILTERS].join(", ")}.`),
          );
        }

        // Route on layer
        const result = layer === "periods"
          ? vocabDb!.searchProvenancePeriods(params)
          : vocabDb!.searchProvenance(params);

        // Auto-downgrade guard (plan 029): a non-compact events result at high
        // maxResults can exceed the host's ~150K-char per-result ceiling, driven
        // by structuredContent (which claude.ai meters but never reads). Measure
        // the would-be non-compact structuredContent exactly; if it + the reserved
        // text budget would breach SAFE_RESULT_BUDGET, return compact instead.
        if (!requestedCompact && EMIT_STRUCTURED && layer === "events") {
          const structuredBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
          if (structuredBytes > SAFE_RESULT_BUDGET - PROVENANCE_TEXT_RESERVE) {
            effectiveCompact = true;
            autoCompacted = true;
          }
        }

        // #386: in compact mode, project each artwork to header + fixed-size summary +
        // matched-event one-liners (omit the full event/period arrays). Computed once and
        // shared by the structured and text channels.
        const compactResults = effectiveCompact
          ? result.results.map(art => ({
              objectNumber: art.objectNumber,
              title: art.title,
              creator: art.creator,
              ...(art.date != null ? { date: art.date } : {}),
              url: art.url,
              eventCount: art.eventCount,
              matchedEventCount: art.matchedEventCount,
              summary: provenanceCompactSummary(art),
              matchedEvents: provenanceMatchedEvents(art),
            }))
          : null;

        // Text channel
        const lines: string[] = [];
        if (result.totalArtworksCapped) {
          lines.push(`≥${result.totalArtworks.toLocaleString()} artworks with matching provenance (capped — narrow the query for an exact total)`);
        } else {
          lines.push(`${pluralize(result.totalArtworks, "artwork")} with matching provenance`);
        }
        for (const [i, artwork] of result.results.entries()) {
          lines.push("");
          lines.push(`${artwork.objectNumber} | "${artwork.title}" — ${artwork.creator}${artwork.date ? ` (${artwork.date})` : ""}`);
          lines.push(`  ${artwork.url}`);

          if (effectiveCompact) {
            // Reuse the projection already built for the structured channel.
            const { summary: s, matchedEvents } = compactResults![i];
            const rollup: string[] = [`${s.matchedEventCount}/${s.eventCount} events matched`];
            if (s.yearSpan[0] != null || s.yearSpan[1] != null) rollup.push(`${s.yearSpan[0] ?? "?"}–${s.yearSpan[1] ?? "?"}`);
            if (s.transferTypes.length) rollup.push(s.transferTypes.join(", "));
            if (s.firstOwner) rollup.push(`owners: ${s.firstOwner}${s.lastOwner && s.lastOwner !== s.firstOwner ? ` … ${s.lastOwner}` : ""}`);
            if (s.hasGap) rollup.push("has gap");
            if (s.hasPrice) rollup.push("has price");
            lines.push(`  ${rollup.join(" | ")}`);
            for (const e of matchedEvents) {
              const parts: string[] = [];
              if (e.transferType !== "unknown") parts.push(e.transferType);
              if (e.parties.length) parts.push(e.parties.join(", "));
              if (e.dateExpression) parts.push(e.dateExpression);
              if (e.location) parts.push(e.location);
              if (e.price) parts.push(`${e.price.currency} ${e.price.amount.toLocaleString()}`);
              lines.push(`  >>> ${e.sequence}. ${parts.length ? parts.join(" | ") : e.rawText}`);
            }
          } else if (layer === "periods" && artwork.periods) {
            // Format periods
            for (const p of artwork.periods) {
              const marker = p.matched ? ">>>" : "   ";
              const parts: string[] = [];
              if (p.ownerName) parts.push(p.ownerName);
              if (p.acquisitionMethod) parts.push(p.acquisitionMethod);
              const yearRange = p.beginYear != null || p.endYear != null
                ? `${p.beginYear ?? "?"}–${p.endYear ?? "?"}`
                : null;
              if (yearRange) {
                const durStr = p.duration != null ? ` (${p.duration} yrs)` : "";
                parts.push(yearRange + durStr);
              }
              if (p.location) parts.push(p.location);
              lines.push(`  ${marker} ${p.sequence}. ${parts.join(" | ")}`);
            }
          } else {
            // Format events
            for (const e of artwork.events) {
              const marker = e.matched ? ">>>" : "   ";
              // Surface buyer/seller direction: a clean 2-party sender→receiver
              // pair renders as "sender→receiver"; otherwise list "name (role)"
              // so the role (buyer/seller/consignor/…) disambiguates each party.
              const senders = e.parties.filter(p => p.position === "sender");
              const receivers = e.parties.filter(p => p.position === "receiver");
              const partyNames = e.parties.length === 2 && senders.length === 1 && receivers.length === 1
                ? `${senders[0].name}→${receivers[0].name}`
                : e.parties.map(p => (p.role ? `${p.name} (${p.role})` : p.name)).join(", ");
              const parts: string[] = [];
              if (e.transferType !== "unknown") parts.push(e.unsold ? `${e.transferType} (unsold)` : e.transferType);
              if (partyNames) parts.push(partyNames);
              if (e.dateExpression) parts.push(e.dateExpression);
              else if (e.dateYear) parts.push(String(e.dateYear));
              if (e.location) parts.push(e.location);
              if (e.price) parts.push(`${e.price.currency} ${e.price.amount.toLocaleString()}${e.batchPrice ? " (batch)" : ""}`);
              if (e.isCrossRef && e.crossRefTarget) parts.push(`→ see ${e.crossRefTarget}`);
              const srcRef = e.citations?.[0]?.text;
              if (srcRef) parts.push(`src: ${srcRef.length > 60 ? srcRef.slice(0, 57) + "..." : srcRef}`);
              const meta: string[] = [];
              const parseT = compactMethodTag(e.parseMethod, "peg");
              if (parseT) meta.push(`parse=${parseT}`);
              if (e.transferCategory) {
                const catT = compactMethodTag(e.categoryMethod, "type_mapping");
                meta.push(catT ? `cat=${e.transferCategory}/${catT}` : `cat=${e.transferCategory}`);
              }
              const fixT = compactMethodTag(e.correctionMethod);
              if (fixT) meta.push(`fix=${fixT}`);
              const partyPosTags: string[] = [];
              for (const p of e.parties) {
                const posT = compactMethodTag(p.positionMethod, "role_mapping");
                if (posT) partyPosTags.push(`${p.name}@${posT}`);
              }
              if (partyPosTags.length) meta.push(`pos:${partyPosTags.join(",")}`);
              const suffix = meta.length ? `  [${meta.join(" | ")}]` : "";
              lines.push(`  ${marker} ${e.sequence}. ${parts.length > 0 ? parts.join(" | ") : e.rawText}${suffix}`);
            }
          }
        }

        // Enrichment review: only generate page when LLM-mediated items exist,
        // but include rule-based enrichments on the page for context
        if (layer === "events") {
          let llmEvents = 0;
          let llmParties = 0;
          for (const art of result.results) {
            for (const e of art.events) {
              if (isLlmEnrichedEvent(e)) llmEvents++;
              for (const p of e.parties) {
                if (isLlmEnrichedParty(p)) llmParties++;
              }
            }
          }

          if (llmEvents > 0 || llmParties > 0) {
            // Build query summary for display
            const queryParts: string[] = [];
            if (params.party) queryParts.push(`party="${params.party}"`);
            if (params.transferType) queryParts.push(`type=${Array.isArray(params.transferType) ? params.transferType.join(",") : params.transferType}`);
            if (params.location) queryParts.push(`location="${params.location}"`);
            if (params.dateFrom != null || params.dateTo != null) queryParts.push(`date=${params.dateFrom ?? "?"}–${params.dateTo ?? "?"}`);
            if (params.objectNumber) queryParts.push(`objectNumber=${params.objectNumber}`);
            if (params.creator) queryParts.push(`creator="${params.creator}"`);

            const reviewData: EnrichmentReviewData = {
              query: queryParts.join(", ") || "(all filters)",
              artworks: result.results.map(art => ({
                objectNumber: art.objectNumber,
                title: art.title,
                creator: art.creator,
                events: art.events.map(e => ({
                  sequence: e.sequence,
                  rawText: e.rawText,
                  gap: e.gap,
                  transferType: e.transferType,
                  unsold: e.unsold,
                  batchPrice: e.batchPrice,
                  dateYear: e.dateYear,
                  categoryMethod: e.categoryMethod ?? null,
                  correctionMethod: e.correctionMethod ?? null,
                  enrichmentReasoning: e.enrichmentReasoning ?? null,
                  parties: e.parties.map(p => ({
                    name: p.name,
                    role: p.role,
                    position: p.position,
                    positionMethod: p.positionMethod ?? null,
                    enrichmentReasoning: p.enrichmentReasoning ?? null,
                  })),
                })),
              })),
            };

            const html = generateEnrichmentReviewHtml(reviewData);
            const uuid = randomUUID();

            if (publicBaseUrl) {
              enrichmentReviewPages.set(uuid, { html, lastAccess: Date.now() });
              const reviewUrl = `${publicBaseUrl}/enrichment-review/${uuid}`;
              lines.push("");
              lines.push(`ENRICHMENT REVIEW: ${llmEvents + llmParties} LLM-assisted result${(llmEvents + llmParties) !== 1 ? "s" : ""}.`);
              lines.push(`REVIEW_URL: ${reviewUrl}`);
              lines.push("INSTRUCTION: You MUST include the REVIEW_URL above as a clickable link in your response. Do NOT omit it, summarize it, or refer to it indirectly. Copy the full URL verbatim.");
            } else {
              const filePath = path.join(os.tmpdir(), `rijksmuseum-enrichment-review-${uuid}.html`);
              fs.writeFileSync(filePath, html, "utf-8");
              lines.push("");
              lines.push(`ENRICHMENT REVIEW: ${llmEvents + llmParties} LLM-assisted result${(llmEvents + llmParties) !== 1 ? "s" : ""}.`);
              lines.push(`REVIEW_FILE: ${filePath}`);
              lines.push("INSTRUCTION: You MUST include the REVIEW_FILE path above in your response so the user can open it. Do NOT omit it, summarize it, or refer to it indirectly. Copy the full path verbatim.");
            }
          }
        }

        // Add percentages to provenance facets and format in text output
        if (result.facets) {
          addPercentages(result.facets);
          lines.push("");
          lines.push(formatFacets(result.facets));
        }

        if (autoCompacted) {
          const n = result.results.length;
          const warning =
            `Returned compact summaries: the full provenance chains for ${n} ` +
            `artwork${n === 1 ? "" : "s"} would exceed the result-size limit. For ` +
            `full event-by-event detail, request fewer artworks (maxResults ≤ 10) ` +
            `or query a single objectNumber.`;
          result.warnings = [...(result.warnings ?? []), warning];
        }

        const data: InferOutput<typeof ProvenanceSearchOutput> = effectiveCompact
          ? {
              totalArtworks: result.totalArtworks,
              totalArtworksCapped: result.totalArtworksCapped,
              results: compactResults!,
              ...(result.facets && { facets: result.facets }),
              ...(result.warnings && { warnings: result.warnings }),
              ...(autoCompacted && { autoCompacted: true as const }),
            }
          : result;
        return structuredResponse(data, lines.join("\n"));
      })
    );
  }
}
