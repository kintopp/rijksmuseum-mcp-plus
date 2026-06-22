import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VocabularyDb, type BibliographyFromDb } from "../../api/VocabularyDb.js";
import { UsageStats } from "../../utils/UsageStats.js";
import {
  ANN_READ_CLOSED, stripNullCoerceBool, errorResponse, structuredResponse, withOutputSchema, createLogger, truncate,
} from "../helpers.js";
import { BibliographyOutput, PublicationArtworksOutput } from "../outputSchemas.js";

function formatBibliographySummary(d: BibliographyFromDb): string {
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
      return structuredResponse({ ...data, warnings }, formatBibliographySummary(data));
    }),
  );

  server.registerTool(
    "find_artworks_citing_publication",
    {
      title: "Find Artworks Citing a Publication",
      annotations: ANN_READ_CLOSED,
      description:
        "Reverse bibliography lookup: artworks whose references cite a given publication, by its URI or id. " +
        "Use the publicationUri from get_artwork_bibliography (e.g. 'https://id.rijksmuseum.nl/301154354') or the bare id. " +
        "Local and resolver-free. Not for topic search of the library catalogue.",
      inputSchema: z.object({
        publication: z.string().min(1)
          .describe("Publication URI (https://id.rijksmuseum.nl/301…) or the bare publication id."),
        full: z.preprocess(stripNullCoerceBool, z.boolean().optional())
          .describe("If true, return ALL citing artworks. Default: first 20 + total count."),
      }).strict(),
      ...withOutputSchema(PublicationArtworksOutput),
    },
    withLogging("find_artworks_citing_publication", async (args) => {
      if (!vocabDb?.available) return errorResponse("find_artworks_citing_publication requires the vocabulary database.");
      const m = String(args.publication).match(/(\d+)\s*$/);
      if (!m) throw new Error(`Could not parse a publication id from: ${args.publication}`);
      const publicationId = Number(m[1]);
      const data = vocabDb.getArtworksCitingPublication(publicationId, { limit: args.full ? 0 : 20 });
      const warnings: string[] = [];
      if (data.total === 0) {
        warnings.push(`No artworks cite publication ${publicationId} (or bibliography data not yet harvested).`);
      }
      const header = `${data.total} artwork(s) cite ${data.publicationUri}`;
      const lines = data.artworks.map((a, i) => `${i + 1}. ${a.objectNumber} — ${a.title}${a.creator ? `, ${a.creator}` : ""}`);
      return structuredResponse({ ...data, warnings }, [header, ...lines].join("\n"));
    }),
  );
}
