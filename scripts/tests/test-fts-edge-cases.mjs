#!/usr/bin/env node
/**
 * test-fts-edge-cases.mjs — Probe FTS5 query escaping with tricky inputs.
 *
 * Tests that punctuation, FTS5 operators, diacritics, and degenerate inputs
 * don't cause syntax errors or crashes in search_artwork.
 * Every call should either return results or a clean "no results" — never
 * an FTS5 syntax error.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});

const client = new Client({ name: "fts-edge-test", version: "1.0" });
await client.connect(transport);
console.log("Connected\n");

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { console.log(`  \u2713 ${label}`); passed++; }
  else { console.log(`  \u2717 ${label}`); failed++; }
}

async function call(name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) {
      const msg = r.content?.[0]?.text ?? "";
      return { _error: msg };
    }
    return r.structuredContent ?? (r.content?.[0]?.text ? JSON.parse(r.content[0].text) : r);
  } catch (e) {
    return { _error: e.message };
  }
}

function noFtsError(result) {
  if (!result?._error) return true;
  return !result._error.includes("fts5") && !result._error.includes("syntax error");
}

// ── Periods in names ──────────────────────────────────────────────────
console.log("1. Periods in creator names");
let r = await call("search_artwork", { creator: "Pieter Jansz. Saenredam", type: "painting" });
check("Jansz. — no FTS error", noFtsError(r));
check("Jansz. — has results", (r.results?.length ?? 0) > 0);

r = await call("search_artwork", { creator: "Jan van der Heyden Jr." });
check("Trailing period — no FTS error", noFtsError(r));

r = await call("search_artwork", { creator: "R.P. Bonington" });
check("Initials with periods — no FTS error", noFtsError(r));

// ── Commas and semicolons ─────────────────────────────────────────────
console.log("\n2. Commas and semicolons");
r = await call("search_artwork", { inscription: "fecit, anno 1642" });
check("Comma in inscription — no FTS error", noFtsError(r));

r = await call("search_artwork", { description: "oil; canvas" });
check("Semicolon in description — no FTS error", noFtsError(r));

// ── Apostrophes and hyphens ───────────────────────────────────────────
console.log("\n3. Apostrophes and hyphens");
r = await call("search_artwork", { subject: "shepherd's crook" });
check("Apostrophe in subject — no FTS error", noFtsError(r));

r = await call("search_artwork", { creator: "Henri de Toulouse-Lautrec" });
check("Hyphen in creator — no FTS error", noFtsError(r));

r = await call("search_artwork", { subject: "self-portrait" });
check("Hyphenated subject — no FTS error", noFtsError(r));

// ── FTS5 operator keywords as search terms ────────────────────────────
console.log("\n4. FTS5 operator keywords as values");
r = await call("search_artwork", { subject: "AND" });
check("Literal 'AND' — no FTS error", noFtsError(r));

r = await call("search_artwork", { subject: "OR" });
check("Literal 'OR' — no FTS error", noFtsError(r));

r = await call("search_artwork", { subject: "NOT" });
check("Literal 'NOT' — no FTS error", noFtsError(r));

r = await call("search_artwork", { inscription: "NEAR" });
check("Literal 'NEAR' — no FTS error", noFtsError(r));

// ── FTS5 special syntax injection ─────────────────────────────────────
console.log("\n5. FTS5 syntax injection attempts");
r = await call("search_artwork", { subject: 'dog OR cat' });
check("OR injection — no FTS error", noFtsError(r));

r = await call("search_artwork", { subject: 'dog NOT cat' });
check("NOT injection — no FTS error", noFtsError(r));

r = await call("search_artwork", { subject: 'dog NEAR/3 cat' });
check("NEAR/N injection — no FTS error", noFtsError(r));

r = await call("search_artwork", { inscription: '"quoted phrase"' });
check("Embedded quotes — no FTS error", noFtsError(r));

r = await call("search_artwork", { subject: "landscape*" });
check("Trailing asterisk — no FTS error", noFtsError(r));

r = await call("search_artwork", { subject: "^painting" });
check("Caret prefix — no FTS error", noFtsError(r));

r = await call("search_artwork", { subject: "{landscape}" });
check("Curly braces — no FTS error", noFtsError(r));

r = await call("search_artwork", { subject: "(dog)" });
check("Parentheses — no FTS error", noFtsError(r));

// ── Diacritics and Unicode ────────────────────────────────────────────
console.log("\n6. Diacritics and Unicode");
r = await call("search_artwork", { creator: "Albrecht Dürer" });
check("Umlaut — no FTS error", noFtsError(r));

r = await call("search_artwork", { depictedPerson: "François" });
check("Cedilla — no FTS error", noFtsError(r));

r = await call("search_artwork", { creator: "Katsushika Hokusai" });
check("Romanized Japanese — no FTS error", noFtsError(r));

// ── Degenerate and boundary inputs ────────────────────────────────────
console.log("\n7. Degenerate inputs");
r = await call("search_artwork", { subject: "." });
check("Just a period — no FTS error", noFtsError(r));

r = await call("search_artwork", { subject: "..." });
check("Ellipsis — no FTS error", noFtsError(r));

r = await call("search_artwork", { subject: "***" });
check("Only asterisks — no FTS error", noFtsError(r));

r = await call("search_artwork", { inscription: '""' });
check("Only quotes — no FTS error", noFtsError(r));

r = await call("search_artwork", { subject: " " });
check("Only whitespace — no FTS error", noFtsError(r));

r = await call("search_artwork", { subject: "a" });
check("Single char — no FTS error", noFtsError(r));

// ── Mixed filters with tricky text ────────────────────────────────────
console.log("\n9. Tricky text combined with vocab filters");
r = await call("search_artwork", { creator: "Jansz.", type: "painting", subject: "church" });
check("Period creator + vocab filters — no FTS error", noFtsError(r));

r = await call("search_artwork", { title: "De N.V. ...", subject: "factory" });
check("Periods and ellipsis in title + subject — no FTS error", noFtsError(r));

console.log(`\n${"=".repeat(50)}`);
console.log(`  Passed: ${passed}  Failed: ${failed}`);
console.log(`${"=".repeat(50)}\n`);

await client.close();
process.exit(failed > 0 ? 1 : 0);
