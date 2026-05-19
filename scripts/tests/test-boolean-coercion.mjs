#!/usr/bin/env node
/**
 * test-boolean-coercion.mjs — verify #359 hedge:
 *   the server's stripNullCoerceBool preprocessor accepts string-form booleans
 *   ("true"/"false") on all input-schema boolean fields, so any client wrapper
 *   that serializes booleans as strings is silently handled instead of failing
 *   with `invalid_type: Expected boolean, received string`.
 *
 * Defence-in-depth — the upstream bug shape is reported but unreproduced.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "boolean-coercion-test", version: "1.0" });
await client.connect(transport);
console.log("Connected\n");

let passed = 0, failed = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function call(name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) return { _error: r.content?.[0]?.text ?? "" };
    return r.structuredContent ?? (r.content?.[0]?.text ? JSON.parse(r.content[0].text) : r);
  } catch (e) {
    return { _zodError: e.message ?? String(e) };
  }
}

// ── 1. The canonical bug shape from the original transcript ────────────
console.log("1. search_artwork — sameRowMatching as string 'true' (the bug shape)");
{
  const r = await call("search_artwork", {
    creator: "Rembrandt van Rijn",
    productionRole: "painter",
    sameRowMatching: "true",   // ← STRING, not boolean
    maxResults: 1,
    compact: true,
  });
  check("string 'true' accepted (no Zod error)", !r._error && !r._zodError,
    r._error || r._zodError);
  // If the coercion worked, this should match the same-row autograph count.
  // Real boolean true returns 28 paintings; string 'true' should return the same.
  check("returns row-aware autograph count", (r?.totalResults ?? 0) >= 25 && (r?.totalResults ?? 0) <= 35,
    `totalResults=${r?.totalResults}`);
}

console.log("\n2. search_artwork — sameRowMatching as string 'false'");
{
  const r = await call("search_artwork", {
    creator: "Rembrandt van Rijn",
    productionRole: "painter",
    sameRowMatching: "false",
    maxResults: 1,
    compact: true,
  });
  check("string 'false' accepted", !r._error && !r._zodError, r._error || r._zodError);
  // 'false' = default; should match the cross-row count (34 for Rembrandt painter)
  check("returns cross-row count", (r?.totalResults ?? 0) >= 30 && (r?.totalResults ?? 0) <= 40,
    `totalResults=${r?.totalResults}`);
}

console.log("\n3. search_artwork — imageAvailable as string 'true'");
{
  const r = await call("search_artwork", {
    type: "painting",
    imageAvailable: "true",
    maxResults: 1,
    compact: true,
  });
  check("string 'true' accepted on imageAvailable", !r._error && !r._zodError,
    r._error || r._zodError);
  check("results returned", (r?.totalResults ?? 0) > 0);
}

console.log("\n4. search_artwork — hasProvenance as string 'true'");
{
  const r = await call("search_artwork", {
    type: "painting",
    hasProvenance: "true",
    maxResults: 1,
    compact: true,
  });
  check("string 'true' accepted on hasProvenance", !r._error && !r._zodError,
    r._error || r._zodError);
  check("results returned", (r?.totalResults ?? 0) > 0);
}

console.log("\n5. search_artwork — compact as string 'true'");
{
  const r = await call("search_artwork", {
    type: "painting",
    compact: "true",
  });
  check("string 'true' accepted on compact", !r._error && !r._zodError,
    r._error || r._zodError);
  check("returned ids (compact shape)", Array.isArray(r?.ids));
}

// ── 2. collection_stats boolean params ────────────────────────────────
console.log("\n6. collection_stats — sameRowMatching as string 'true'");
{
  const r = await call("collection_stats", {
    dimension: "type",
    creator: "Rembrandt van Rijn",
    productionRole: "painter",
    sameRowMatching: "true",
    topN: 5,
  });
  check("string 'true' accepted", !r._error && !r._zodError, r._error || r._zodError);
  check("autograph count returned", (r?.total ?? 0) >= 25 && (r?.total ?? 0) <= 35,
    `total=${r?.total}`);
}

// ── 3. Strict canonical form — non-canonical strings still fail ────────
console.log("\n7. Non-canonical 'True' (capital) should be REJECTED");
{
  const r = await call("search_artwork", {
    creator: "Rembrandt van Rijn",
    productionRole: "painter",
    sameRowMatching: "True",   // ← capital T, NOT coerced
    maxResults: 1,
  });
  check("string 'True' rejected by Zod", !!r._error || !!r._zodError);
}

console.log("\n8. Numeric 1 / 0 should be REJECTED (not coerced)");
{
  const r = await call("search_artwork", {
    type: "painting",
    imageAvailable: 1,
    maxResults: 1,
  });
  check("number 1 rejected by Zod", !!r._error || !!r._zodError);
}

// ── 4. Literal booleans still work (no regression) ────────────────────
console.log("\n9. Literal boolean true still works");
{
  const r = await call("search_artwork", {
    creator: "Rembrandt van Rijn",
    productionRole: "painter",
    sameRowMatching: true,
    maxResults: 1,
    compact: true,
  });
  check("literal true accepted", !r._error && !r._zodError, r._error || r._zodError);
  check("same result as string 'true' (28 paintings)",
    (r?.totalResults ?? 0) >= 25 && (r?.totalResults ?? 0) <= 35,
    `totalResults=${r?.totalResults}`);
}

await client.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
