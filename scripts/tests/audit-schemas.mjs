/**
 * Schema audit: check all outputSchemas for structural risk factors.
 *
 * 1. anyOf / oneOf at top level of outputSchema
 * 2. anyOf / oneOf anywhere (for awareness)
 * 3. $ref / $defs usage
 * 4. Maximum nesting depth
 */
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";

// ── Re-import the Zod shapes from registration.ts ──
// We can't import them directly (they're not exported), so we'll
// use the MCP SDK to get the actual tool schemas from the server.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, ENABLE_FIND_SIMILAR: "true" },
});

const client = new Client({ name: "schema-audit", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();

console.log(`\n=== Schema Audit: ${tools.length} tools ===\n`);

// ── Helper: find all occurrences of a keyword in a JSON object ──
function findKeyword(obj, keyword, path = "") {
  const results = [];
  if (obj && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = path ? `${path}.${key}` : key;
      if (key === keyword) {
        results.push({ path: currentPath, value });
      }
      if (typeof value === "object" && value !== null) {
        results.push(...findKeyword(value, keyword, currentPath));
      }
    }
  }
  return results;
}

// ── Helper: max nesting depth of "properties" ──
function maxDepth(obj, depth = 0) {
  if (!obj || typeof obj !== "object") return depth;
  let max = depth;
  if (obj.properties) {
    for (const val of Object.values(obj.properties)) {
      max = Math.max(max, maxDepth(val, depth + 1));
    }
  }
  if (obj.items) {
    max = Math.max(max, maxDepth(obj.items, depth + 1));
  }
  if (obj.anyOf) {
    for (const branch of obj.anyOf) {
      max = Math.max(max, maxDepth(branch, depth));
    }
  }
  if (obj.additionalProperties && typeof obj.additionalProperties === "object") {
    max = Math.max(max, maxDepth(obj.additionalProperties, depth + 1));
  }
  return max;
}

let issues = 0;

for (const tool of tools) {
  const schema = tool.outputSchema;
  const name = tool.name;

  if (!schema) {
    console.log(`  ${name}: no outputSchema (text-only) — OK`);
    continue;
  }

  const size = JSON.stringify(schema).length;
  const sizeKb = (size / 1024).toFixed(2);

  // Check 1: anyOf/oneOf at top level
  const topLevelAnyOf = schema.anyOf || schema.oneOf;
  // Check 2: anyOf/oneOf anywhere
  const allAnyOf = findKeyword(schema, "anyOf");
  const allOneOf = findKeyword(schema, "oneOf");
  // Check 3: $ref / $defs
  const allRefs = findKeyword(schema, "$ref");
  const allDefs = findKeyword(schema, "$defs");
  // Check 4: nesting depth
  const depth = maxDepth(schema);

  const problems = [];
  if (topLevelAnyOf) problems.push("⚠️  TOP-LEVEL anyOf/oneOf");
  if (allRefs.length > 0) problems.push(`⚠️  $ref (${allRefs.length}x)`);
  if (allDefs.length > 0) problems.push(`⚠️  $defs (${allDefs.length}x)`);

  const info = [];
  if (allAnyOf.length > 0) info.push(`anyOf: ${allAnyOf.length}x`);
  if (allOneOf.length > 0) info.push(`oneOf: ${allOneOf.length}x`);
  info.push(`depth: ${depth}`);

  const status = problems.length > 0 ? "RISK" : "OK";
  if (problems.length > 0) issues++;

  console.log(`  ${name} (${sizeKb} KB, ${status})`);
  for (const p of problems) console.log(`    ${p}`);
  for (const i of info) console.log(`    ${i}`);

  // Show anyOf locations for awareness
  if (allAnyOf.length > 0) {
    for (const a of allAnyOf) {
      // Show path but truncate value
      const isTopLevel = !a.path.includes(".");
      const flag = isTopLevel ? " ← TOP LEVEL" : "";
      console.log(`    anyOf at: ${a.path}${flag}`);
    }
  }
}

console.log(`\n=== Summary: ${issues} tools with risks, ${tools.length} total ===\n`);

await client.close();
process.exit(issues > 0 ? 1 : 0);
