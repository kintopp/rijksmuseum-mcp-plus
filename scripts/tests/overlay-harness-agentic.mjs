/**
 * Phase B agentic harness — stub.
 *
 * Exercises the MCP-tool-using agent loop with one (feature, condition) to verify
 * the scaffold works end-to-end. When P1/P7 prototypes are ready, this file grows to
 * support multi-run Hungarian matching; see `NOTE(agentic-extensions)` marker below.
 *
 * Run: node scripts/tests/overlay-harness-agentic.mjs <experiment-dir> --feature <label>
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { loadExperiment } from "./overlay-config.mjs";
import { loadAnthropicKey } from "./overlay-harness-fixed-crop.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "../..");

const args = process.argv.slice(2);
const expDir = args[0] ? path.resolve(args[0]) : null;
const fi = args.indexOf("--feature");
const featureLabel = fi >= 0 ? args[fi + 1] : null;

if (!expDir || !featureLabel) {
  console.error("usage: overlay-harness-agentic.mjs <experiment-dir> --feature <label>");
  process.exit(2);
}

const experiment = await loadExperiment(path.join(expDir, "config.mjs"));
const gt = JSON.parse(await readFile(experiment.case.groundTruthFile, "utf8"));
const feature = gt.features.find((f) => f.label === featureLabel);
if (!feature) throw new Error(`No feature with label "${featureLabel}" in ground truth`);

const anthropic = new Anthropic({ apiKey: await loadAnthropicKey() });

const transport = new StdioClientTransport({
  command: "node", args: ["dist/index.js"], cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "overlay-agentic-stub", version: "0.1" });
await client.connect(transport);

const toolList = await client.listTools();
const toolSpecs = toolList.tools
  .filter((t) => ["inspect_artwork_image", "navigate_viewer", "get_artwork_image", "get_artwork_details"].includes(t.name))
  .map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

const trace = { turns: [], overlays: [] };
let messages = [{
  role: "user",
  content: `Please annotate the ${featureLabel.toLowerCase()} in ${experiment.case.objectNumber}. Use inspect_artwork_image to locate it, then navigate_viewer with action "add_overlay" to place a box around it.`,
}];

for (let turn = 0; turn < 8; turn++) {
  const resp = await anthropic.messages.create({
    model: experiment.model, max_tokens: 1024, tools: toolSpecs, messages,
  });
  trace.turns.push({ turn, stop_reason: resp.stop_reason, content: resp.content });
  if (resp.stop_reason !== "tool_use") break;

  const toolUses = resp.content.filter((c) => c.type === "tool_use");
  const toolResults = [];
  for (const tu of toolUses) {
    if (tu.name === "navigate_viewer") {
      const cmds = Array.isArray(tu.input.commands) ? tu.input.commands : [];
      for (const cmd of cmds) if (cmd.action === "add_overlay") trace.overlays.push(cmd);
    }
    try {
      const out = await client.callTool({ name: tu.name, arguments: tu.input });
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 4000) });
    } catch (err) {
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: String(err?.message ?? err) });
    }
  }
  messages = [
    ...messages,
    { role: "assistant", content: resp.content },
    { role: "user", content: toolResults },
  ];
}
await transport.close();

// NOTE(agentic-extensions): when extending for multi-feature experiments (P1/P7),
// collect all overlays from trace.overlays, convert each cmd.region to full-image pct,
// then use Hungarian assignment on the IoU matrix against ground-truth features.
const overlayCount = trace.overlays.length;
console.log(`Agentic stub complete. Overlay commands emitted: ${overlayCount}`);
if (overlayCount === 0) {
  console.error("WARNING: no add_overlay commands in the trace — smoke test failed.");
  process.exit(1);
}

const outDir = path.join(expDir, "results");
await mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, `stub-agentic-${Date.now()}.json`);
await writeFile(outPath, JSON.stringify({ feature, trace }, null, 2) + "\n");
console.log(`Trace written: ${outPath}`);
