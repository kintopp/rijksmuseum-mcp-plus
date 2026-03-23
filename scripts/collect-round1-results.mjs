/**
 * Collect round 1 batch results from API (still available) and save
 * to distinct filenames so they don't get overwritten.
 */

import { writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

async function collectBatch(batchId, mode, outputPath) {
  console.log(`\nCollecting ${mode} (${batchId})...`);
  const results = [];
  let succeeded = 0, failed = 0;
  let inputTokens = 0, outputTokens = 0;

  for await (const event of await client.messages.batches.results(batchId)) {
    if (event.result?.type !== "succeeded") {
      failed++;
      results.push({ customId: event.custom_id, error: event.result?.error || "unknown" });
      continue;
    }
    succeeded++;
    const msg = event.result.message;
    inputTokens += msg.usage?.input_tokens || 0;
    outputTokens += msg.usage?.output_tokens || 0;

    const toolBlock = msg.content?.find(b => b.type === "tool_use");
    if (toolBlock?.input) {
      results.push({ customId: event.custom_id, data: toolBlock.input });
    } else {
      failed++;
      results.push({ customId: event.custom_id, error: "no tool call" });
    }
  }

  const cost = ((inputTokens / 1_000_000) * 1.50 + (outputTokens / 1_000_000) * 7.50).toFixed(2);

  const output = {
    meta: {
      mode,
      model: "claude-sonnet-4-20250514",
      batchId,
      successCount: succeeded,
      errorCount: failed,
      inputTokens,
      outputTokens,
      estimatedCost: cost,
    },
    results,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`  Succeeded: ${succeeded}, Failed: ${failed} → ${outputPath}`);
}

await collectBatch(
  "msgbatch_019BsSjpVnxxDX8QJumqiWxw",
  "position-enrichment",
  "data/audit-position-enrichment-r1.json"
);

await collectBatch(
  "msgbatch_01DbNPMdgRHfv9h2ZgHttz6b",
  "party-disambiguation",
  "data/audit-party-disambiguation-r1.json"
);

console.log("\nDone.");
