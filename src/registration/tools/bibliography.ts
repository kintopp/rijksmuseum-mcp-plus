import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VocabularyDb, type BibliographyFromDb } from "../../api/VocabularyDb.js";
import { UsageStats } from "../../utils/UsageStats.js";
import {
  ANN_READ_CLOSED, stripNullCoerceBool, errorResponse, structuredResponse, withOutputSchema, createLogger,
} from "../helpers.js";
import { BibliographyOutput } from "../outputSchemas.js";

function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

function formatBibliographySummary(d: BibliographyFromDb & { warnings?: string[] }): string {
  const lines: string[] = [`${d.objectNumber} — ${d.total} bibliography ${d.total === 1 ? "entry" : "entries"}`];
  d.entries.forEach((e, i) => {
    let line = `${i + 1}. ${truncate(e.citation, 100)}`;
    if (e.pages) line += ` ${e.pages}`;
    lines.push(line);
  });
  return lines.join("\n");
}

export function registerBibliographyTools(
  server: McpServer,
  vocabDb: VocabularyDb | null,
  withLogging: ReturnType<typeof createLogger>,
  _stats?: UsageStats,
): void {
  server.registerTool(
    "get_artwork_bibliography",
    {
      title: "Get Artwork Bibliography",
      annotations: ANN_READ_CLOSED,
      description:
        "Scholarly references for ONE artwork by objectNumber: citations, with linked publication, pages, ISBN where known. " +
        "Follows a search_artwork / get_artwork_details result. By default returns the first 5 plus a total count; " +
        "set full=true for all entries (major works can have 100+ — mind the context window). " +
        "Not for general metadata — use get_artwork_details. Not for library-catalogue search.",
      inputSchema: z.object({
        objectNumber: z.string().min(1)
          .describe("The object number of the artwork (e.g. 'SK-C-5')."),
        full: z.preprocess(stripNullCoerceBool, z.boolean().optional())
          .describe("If true, return ALL entries (may be 100+). Default: first 5 + total count."),
      }).strict(),
      ...withOutputSchema(BibliographyOutput),
    },
    withLogging("get_artwork_bibliography", async (args) => {
      if (!vocabDb?.available) {
        return errorResponse("get_artwork_bibliography requires the vocabulary database.");
      }
      const data = vocabDb.getBibliography(args.objectNumber, { limit: args.full ? 0 : 5 });
      if (!data) throw new Error(`No artwork found: ${args.objectNumber}`);

      const warnings: string[] = [];
      if (data.total === 0) {
        warnings.push(`No bibliography for ${args.objectNumber} (or bibliography data not yet harvested into this database).`);
      }
      const enriched = { ...data, warnings };
      return structuredResponse(enriched, formatBibliographySummary(enriched));
    }),
  );
}
