import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OaiPmhClient } from "../../api/OaiPmhClient.js";
import { VocabularyDb } from "../../api/VocabularyDb.js";
import { UsageStats } from "../../utils/UsageStats.js";
import {
  ANN_READ_CLOSED,
  TOOL_LIMITS,
  stripNull,
  stripNullCoerceBool,
  optStr,
  type InferOutput,
  errorResponse,
  structuredResponse,
  withOutputSchema,
  formatSetLine,
  encodeBrowseSetToken,
  decodeBrowseSetToken,
  formatBrowseSetRecord,
  createLogger,
} from "../helpers.js";
import {
  CuratedSetsOutput,
  BrowseSetOutput,
} from "../outputSchemas.js";

export function registerSetsTools(
  server: McpServer,
  _oai: OaiPmhClient,
  vocabDb: VocabularyDb | null,
  withLogging: ReturnType<typeof createLogger>,
  _stats?: UsageStats
): void {
  // ── list_curated_sets ───────────────────────────────────────────

  server.registerTool(
    "list_curated_sets",
    {
      title: "List Curated Sets",
      annotations: ANN_READ_CLOSED,
      description:
        "Browse thematic and sub-collection groupings curated by Rijksmuseum staff (drawings, paintings, iconographic sets). " +
        "Each result carries memberCount, top dominantTypes, top dominantCenturies by membership, and a category heuristic " +
        "(object_type / iconographic / album / sub_collection / umbrella) so you can pick the right scope. " +
        "Use minMembers: 100, maxMembers: 200000 to avoid umbrella sets when the user wants a substantive subset. " +
        "Pair with browse_set(setSpec) to enumerate members. " +
        "Not for keyword search across artworks — use search_artwork. Not for aggregate counts — use collection_stats.",
      inputSchema: z.object({
        query: optStr()
          .optional()
          .describe(
            "Filter sets by name (case-insensitive substring match). E.g. 'painting', 'Rembrandt', 'Japanese'"
          ),
        sortBy: z.preprocess(stripNull, z.enum(["name", "size", "size_desc"]).optional())
          .describe("Sort order: 'name' (alphabetical, default), 'size' (smallest first), 'size_desc' (largest first)."),
        minMembers: z.preprocess(stripNull, z.number().int().min(0).optional())
          .describe("Filter to sets with at least this many members."),
        maxMembers: z.preprocess(stripNull, z.number().int().min(0).optional())
          .describe("Filter to sets with at most this many members. Use ~100,000 to exclude umbrella sets like 'Alle gepubliceerde objecten' (834K) and 'Entire Public Domain Set' (732K)."),
        includeStats: z.preprocess(stripNullCoerceBool, z.boolean().optional())
          .describe("Include memberCount, dominantTypes, dominantCenturies, category. Default true. Set false for the lightweight legacy shape."),
      }).strict(),
      ...withOutputSchema(CuratedSetsOutput),
    },
    withLogging("list_curated_sets", async (args) => {
      const result = vocabDb!.listCuratedSets({
        query: args.query,
        sortBy: args.sortBy,
        minMembers: args.minMembers,
        maxMembers: args.maxMembers,
        includeStats: args.includeStats,
      });

      const data: InferOutput<typeof CuratedSetsOutput> = result;
      const headerParts: string[] = [`${result.totalSets} sets`];
      if (result.filteredFrom != null) {
        const filters: string[] = [];
        if (args.query) filters.push(`query: "${args.query}"`);
        if (args.minMembers != null) filters.push(`minMembers=${args.minMembers}`);
        if (args.maxMembers != null) filters.push(`maxMembers=${args.maxMembers}`);
        headerParts.push(`filtered from ${result.filteredFrom}` + (filters.length > 0 ? `, ${filters.join(", ")}` : ""));
      }
      const header = headerParts.length > 1
        ? `${headerParts[0]} (${headerParts.slice(1).join("; ")})`
        : headerParts[0];
      const lines = result.sets.map((s, i) => formatSetLine(s, i));
      return structuredResponse(data, [header, ...lines].join("\n"));
    })
  );

  // ── browse_set ──────────────────────────────────────────────────

  server.registerTool(
    "browse_set",
    {
      title: "Browse Set",
      annotations: ANN_READ_CLOSED,
      description:
        "Enumerate the member artworks of one curated set by setSpec (from list_curated_sets). " +
        "DB-backed (warm calls in tens of ms). " +
        "Returns DB-direct records with objectNumber, title, creator, date (display + earliest/latest), description, dimensions, datestamp, image/IIIF URLs, and a stable lodUri. " +
        "For multi-row vocab (subjects, materials, type taxonomy, full set memberships), follow up with get_artwork_details on the returned objectNumber. " +
        "Supports pagination via resumptionToken (stateless base64; not portable across server upgrades). " +
        "Not for set discovery — use list_curated_sets first.",
      inputSchema: z.object({
        setSpec: optStr()
          .optional()
          .describe(
            "Set identifier from list_curated_sets (e.g. '26121'). Required for initial request, ignored when resumptionToken is provided."
          ),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(TOOL_LIMITS.browse_set.max)
          .default(TOOL_LIMITS.browse_set.default)
          .describe(`Maximum records to return (1-${TOOL_LIMITS.browse_set.max}, default ${TOOL_LIMITS.browse_set.default})`),
        resumptionToken: optStr()
          .optional()
          .describe(
            "Pagination token from a previous browse_set result. When provided, setSpec is ignored."
          ),
        includeExtentText: z.preprocess(stripNullCoerceBool, z.boolean().optional())
          .describe("Include the verbose extentText (dcterms:extent) per record. Default false — it is large and not rendered in the text channel."),
      }).strict(),
      ...withOutputSchema(BrowseSetOutput),
    },
    withLogging("browse_set", async (args) => {
      if (!args.resumptionToken && !args.setSpec) {
        return errorResponse("Either setSpec or resumptionToken is required.");
      }

      let setSpec: string;
      let offset: number;
      if (args.resumptionToken) {
        const decoded = decodeBrowseSetToken(args.resumptionToken);
        if (!decoded) {
          return errorResponse(
            "Invalid resumptionToken. Tokens are not portable across server restarts or upgrades. " +
            "Re-issue the original setSpec call to get a fresh token.",
          );
        }
        setSpec = decoded.setSpec;
        offset = decoded.offset;
      } else {
        setSpec = args.setSpec!;
        offset = 0;
      }

      const result = vocabDb!.browseSet(setSpec, args.maxResults, offset, args.includeExtentText === true);
      const nextOffset = offset + result.records.length;
      const hasMore = nextOffset < result.totalInSet;
      const resumptionToken = hasMore ? encodeBrowseSetToken(setSpec, nextOffset) : undefined;

      const data = {
        records: result.records,
        totalInSet: result.totalInSet,
        ...(resumptionToken && { resumptionToken }),
      };
      const headerBits = [`${result.records.length} records`];
      if (result.totalInSet > 0) headerBits.push(`offset ${offset}–${nextOffset - 1} of ${result.totalInSet}`);
      const header = headerBits.join(" — ");
      const lines = result.records.map((r, i) => formatBrowseSetRecord(r, offset + i));
      // jsonText: per-record description + extentText are dropped from the Tier-2
      // one-liner; expose them as a JSON copy for LLM/JSON clients (the CLI already
      // reads structuredContent). Guarded — degrades to a marker over the cap.
      return structuredResponse(data, [header, ...lines].join("\n"), { jsonText: true });
    })
  );
}
