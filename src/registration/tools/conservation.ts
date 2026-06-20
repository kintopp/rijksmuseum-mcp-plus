import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VocabularyDb, type ConservationHistoryFromDb } from "../../api/VocabularyDb.js";
import { UsageStats } from "../../utils/UsageStats.js";
import {
  ANN_READ_CLOSED, errorResponse, structuredResponse, withOutputSchema, createLogger,
} from "../helpers.js";
import { ConservationHistoryOutput } from "../outputSchemas.js";

function formatConservationSummary(d: ConservationHistoryFromDb & { warnings?: string[] }): string {
  const lines: string[] = [];
  lines.push(`${d.objectNumber} — ${d.title ?? "Untitled"}${d.creator ? `, ${d.creator}` : ""}`);
  lines.push("");
  if (d.examinations.length) {
    lines.push(`Technical examinations (${d.examinationsTotalCount}):`);
    for (const e of d.examinations) {
      const what = e.reportTypeLabel ?? e.reportTypeId;
      lines.push(`  • ${what}${e.date ? ` (${e.date})` : ""}${e.examiner ? ` — ${e.examiner}` : ""}`);
    }
  }
  if (d.conservationHistory.length) {
    lines.push(`Conservation history (${d.conservationHistoryTotalCount}):`);
    for (const m of d.conservationHistory) {
      lines.push(`  • ${m.description ?? "treatment"}${m.date ? ` (${m.date})` : ""}`);
    }
  }
  const marks = d.attributionMarks;
  if (marks.total) {
    const bits: string[] = [];
    if (marks.signatures) bits.push(`${marks.signatures} signature mark(s)`);
    if (marks.inscriptions) bits.push(`${marks.inscriptions} inscription mark(s)`);
    const other = marks.total - marks.signatures - marks.inscriptions;
    if (other > 0) bits.push(`${other} other mark(s)`);
    lines.push(`Attribution marks: ${bits.join(", ")} recorded — use search_inscriptions for transcriptions.`);
  }
  if (d.provenanceTextSummary) lines.push(`\n[Provenance excerpt] ${d.provenanceTextSummary}`);
  return lines.join("\n");
}

export function registerConservationTools(
  server: McpServer,
  vocabDb: VocabularyDb | null,
  withLogging: ReturnType<typeof createLogger>,
  _stats?: UsageStats,
): void {
  server.registerTool(
    "get_conservation_history",
    {
      title: "Get Conservation History",
      annotations: ANN_READ_CLOSED,
      description:
        "Conservation/forensics record for ONE artwork: technical examinations and restoration treatment history. " +
        "Follows get_artwork_details / a search result, by objectNumber. " +
        "Returns technical examinations (X-ray, dendrochronology, paint samples, infrared), conservation/restoration " +
        "treatment events, a count of recorded signature/inscription marks (use search_inscriptions for the actual " +
        "transcriptions), and a short provenance excerpt. " +
        "Not for general metadata — use get_artwork_details. Not for transcribed inscriptions — use search_inscriptions. " +
        "Not for aggregate counts — use collection_stats.",
      inputSchema: z.object({
        objectNumber: z.string().min(1)
          .describe("The object number of the artwork (e.g. 'SK-C-5', 'SK-A-4878')."),
      }).strict(),
      ...withOutputSchema(ConservationHistoryOutput),
    },
    withLogging("get_conservation_history", async (args) => {
      if (!vocabDb?.available) {
        return errorResponse("get_conservation_history requires the vocabulary database.");
      }
      const data = vocabDb.getConservationHistory(args.objectNumber);
      if (!data) throw new Error(`No artwork found: ${args.objectNumber}`);

      const warnings: string[] = [];
      if (!data.examinations.length && !data.conservationHistory.length && !data.attributionMarks.total) {
        warnings.push(`No conservation, examination, or attribution-evidence records for ${args.objectNumber}.`);
      }
      const enriched = { ...data, warnings };
      return structuredResponse(enriched, formatConservationSummary(enriched));
    }),
  );
}
