#!/usr/bin/env node
/**
 * test-live-schema-drift.mjs — upstream-contract drift detector.
 *
 * Calls each network-backed tool for real (live IIIF / OAI-PMH / rijksmuseum.nl
 * upstreams) through a real MCP client, then `.parse()`s the response's
 * structuredContent against the tool's own EXPORTED zod output shape. If an
 * upstream changes shape, a parse here fails — the cheapest early warning.
 * (GLOBALISE originated the pattern in scripts/test-live-api.ts; the SDK's
 * registration-layer validation does not replace the explicit `.parse()`.)
 *
 * Prereqs: built dist/, vocab + embeddings DBs, network. Run:
 *   node scripts/tests/test-live-schema-drift.mjs
 */
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const schemas = await import(join(ROOT, "dist", "registration", "outputSchemas.js"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "dist", "index.js")],
  env: { ...process.env, MCP_SKIP_STARTUP_WARM: "1", ENABLE_FIND_SIMILAR: "true" },
  stderr: "ignore",
});
const client = new Client({ name: "schema-drift-test", version: "0.0.0" });
await client.connect(transport);

let passed = 0;
let failed = 0;

async function callAndParse(name, args, shape) {
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    if (result.isError) {
      failed++;
      const text = result.content?.find((c) => c.type === "text")?.text ?? "";
      console.error(`  FAIL: ${name} returned isError: ${text.slice(0, 200)}`);
      return;
    }
    if (!result.structuredContent) {
      failed++;
      console.error(`  FAIL: ${name} returned no structuredContent`);
      return;
    }
    z.object(shape).parse(result.structuredContent);
    passed++;
    console.log(`  ok: ${name} response parses against its exported output schema`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name} schema drift — ${err.message?.slice(0, 500)}`);
  }
}

// Live IIIF (iiif.micr.io): info.json → viewer payload
await callAndParse("get_artwork_image", { objectNumber: "SK-C-5" }, schemas.ImageInfoOutput);

// Live IIIF: region fetch → base64 inspection payload (small size to be polite)
await callAndParse(
  "inspect_artwork_image",
  { objectNumber: "SK-C-5", size: 400 },
  schemas.InspectImageOutput
);

// Live OAI-PMH (data.rijksmuseum.nl): delta feed over the last week
const until = new Date().toISOString().slice(0, 10);
const from = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
await callAndParse(
  "get_recent_changes",
  { from, until, identifiersOnly: true },
  schemas.RecentChangesOutput
);

// find_similar: mostly local channels, but the Visual channel makes a live
// best-effort call to rijksmuseum.nl — parse the full multi-channel payload
await callAndParse("find_similar", { objectNumber: "SK-A-1718" }, schemas.FindSimilarOutput);

await client.close();

console.log(`live-schema-drift: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
