/**
 * Collect results from completed party-disambiguation batch.
 * One-time use — the main script crashed after batch completion.
 */

import { writeFileSync, readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

const state = JSON.parse(readFileSync("data/audit-party-disambiguation-2026-03-22.state.json", "utf-8"));
const batchId = state.batchId;
const model = state.model;

const client = new Anthropic();

console.log(`Collecting results for batch ${batchId}...`);

const results = [];
let succeeded = 0, failed = 0;
let inputTokens = 0, outputTokens = 0;

for await (const event of await client.messages.batches.results(batchId)) {
  const customId = event.custom_id;

  if (event.result?.type !== "succeeded") {
    failed++;
    results.push({ customId, error: event.result?.error || "unknown" });
    continue;
  }

  succeeded++;
  const msg = event.result.message;
  inputTokens += msg.usage?.input_tokens || 0;
  outputTokens += msg.usage?.output_tokens || 0;

  const toolBlock = msg.content?.find(b => b.type === "tool_use");
  if (toolBlock?.input) {
    results.push({ customId, data: toolBlock.input });
  } else {
    failed++;
    results.push({ customId, error: "no tool call" });
  }
}

console.log(`  Succeeded: ${succeeded}, Failed: ${failed}`);

const RATES = { "claude-sonnet-4-20250514": { input: 1.50, output: 7.50 } };
const rate = RATES[model] || { input: 1.50, output: 7.50 };
const cost = ((inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output).toFixed(2);

const output = {
  meta: {
    mode: "party-disambiguation",
    model,
    batchId,
    requestCount: state.requestCount,
    successCount: succeeded,
    errorCount: failed,
    inputTokens,
    outputTokens,
    estimatedCost: cost,
    createdAt: state.createdAt,
  },
  results,
};

const outputPath = "data/audit-party-disambiguation-2026-03-22.json";
writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`\nResults written to ${outputPath}`);

// Report
const actionDist = {};
let totalDisambig = 0;
let totalReplacements = 0;

for (const r of results) {
  if (r.error) continue;
  for (const d of r.data.disambiguations || []) {
    totalDisambig++;
    actionDist[d.action] = (actionDist[d.action] || 0) + 1;
    totalReplacements += (d.replacement_parties || []).length;
  }
}

console.log(`\n${"═".repeat(60)}`);
console.log(`\n## Party Disambiguation (${totalDisambig} events)\n`);
console.log(`| Action | Count |`);
console.log(`|--------|-------|`);
for (const [action, count] of Object.entries(actionDist).sort((a, b) => b[1] - a[1])) {
  console.log(`| ${action} | ${count} |`);
}
console.log(`\n| Metric | Value |`);
console.log(`|--------|-------|`);
console.log(`| Total replacement parties | ${totalReplacements} |`);
console.log(`| Input tokens | ${inputTokens.toLocaleString()} |`);
console.log(`| Output tokens | ${outputTokens.toLocaleString()} |`);
console.log(`| Estimated cost | $${cost} |`);

console.log(`\n### Samples\n`);
let shown = 0;
for (const r of results) {
  if (r.error) continue;
  for (const d of r.data.disambiguations || []) {
    if (shown >= 15) break;
    const parties = (d.replacement_parties || []).map(p => `${p.name} [${p.position}]`).join(" + ");
    console.log(`- **${r.data.object_number}** seq ${d.event_sequence}: "${(d.original_text || "").slice(0, 60)}" → ${d.action}: ${parties || "(deleted)"} (${(d.confidence * 100).toFixed(0)}%)`);
    shown++;
  }
  if (shown >= 15) break;
}
