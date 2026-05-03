#!/usr/bin/env node
/**
 * Smoke test: find_similar against SK-A-1115 (Battle of Waterloo) confirms
 *  - Co-Production channel surfaces the 4 production-stadia peers
 *  - new Related Object channel surfaces NG-NM-12989-A, NG-1171-A, NG-408
 *    (the works that were invisible under the old hard 3-type filter)
 *  - pool threshold is 4
 *
 * Reads the HTML output of find_similar, looks for the expected object
 * numbers in the Co-Production and Related Object rows.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});
const client = new Client({ name: "smoke-coprod-vs-related", version: "1.0.0" }, {});
await client.connect(transport);

const result = await client.callTool({
  name: "find_similar",
  arguments: { objectNumber: "SK-A-1115", maxResults: 50 },
});

const text = (result.content?.[0])?.text ?? "";
console.log("--- find_similar text response ---");
console.log(text);

const pathMatch = text.match(/(\/[^\s]+\.html|https?:\/\/[^\s]+)$/m);
if (!pathMatch) { console.error("no HTML location found"); process.exit(1); }
const loc = pathMatch[1];

let html;
if (loc.startsWith("/")) {
  html = readFileSync(loc, "utf8");
} else {
  const res = await fetch(loc);
  html = await res.text();
}

const checks = [
  { needle: "Related Co-Production",  desc: "Co-Production row label rendered" },
  { needle: "Related Object",         desc: "Related Object row label rendered" },
  { needle: "RP-T-1964-99",           desc: "Co-Production peer #1 (production stadia)" },
  { needle: "RP-T-1964-101A",         desc: "Co-Production peer #2 (production stadia)" },
  { needle: "RP-T-1964-102A",         desc: "Co-Production peer #3 (production stadia)" },
  { needle: "RP-T-1964-103",          desc: "Co-Production peer #4 (production stadia)" },
  { needle: "NG-NM-12989-A",          desc: "Related Object: original|reproduction (Sijthoff)" },
  { needle: "NG-1171-A",              desc: "Related Object: related object (Met & Meylink drawing)" },
  { needle: "NG-408",                 desc: "Related Object: related object (anonymous plaquette)" },
  { needle: "pooled: 4+",             desc: "subtitle reflects new pool threshold of 4" },
];

let failed = 0;
for (const c of checks) {
  const ok = html.includes(c.needle);
  console.log(`${ok ? "✓" : "✗"} ${c.desc}: ${c.needle}`);
  if (!ok) failed++;
}

await client.close();
process.exit(failed === 0 ? 0 : 1);
