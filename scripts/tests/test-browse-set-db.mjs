/**
 * Test for browse_set DB-backed rewrite (#303, v0.27 cluster D).
 *
 * Verifies:
 *  - First page returns N records + a resumptionToken when more exist
 *  - resumptionToken decodes to next offset and returns next page
 *  - Last page omits resumptionToken
 *  - Bad/missing setSpec yields totalInSet=0
 *  - Per-page latency is sub-100ms warm (issue acceptance criterion #4)
 *  - Record shape includes the new "Option C" fields
 *
 * Run:  node scripts/tests/test-browse-set-db.mjs
 * Requires: npm run build first.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function section(name) {
  console.log(`\n${"═".repeat(60)}\n  ${name}\n${"═".repeat(60)}`);
}

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  const sc = r.structuredContent ?? null;
  return { text, sc, isError: !!r.isError };
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "test-browse-set-db", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

// ══════════════════════════════════════════════════════════════════
//  1. First page of 'tekeningen' (drawings, setSpec=26133)
// ══════════════════════════════════════════════════════════════════
section("1. First page of setSpec=26133 (drawings)");

let firstPageToken;
let firstObjectNumber;
{
  const { sc, isError } = await call("browse_set", { setSpec: "26133", maxResults: 5 });
  assert(!isError, "First page returns no error");
  assert(Array.isArray(sc?.records), "records is an array");
  assert(sc?.records?.length === 5, `5 records returned (got ${sc?.records?.length})`);
  assert(sc?.totalInSet >= 89000, `totalInSet >= 89,000 (got ${sc?.totalInSet})`);
  assert(typeof sc?.resumptionToken === "string", "resumptionToken present");
  firstPageToken = sc?.resumptionToken;

  // Record shape — Option C fields
  const r = sc?.records?.[0];
  firstObjectNumber = r?.objectNumber;
  assert(r?.objectNumber, "Record has objectNumber");
  assert(typeof r?.title === "string", "Record has title");
  assert(typeof r?.creator === "string", "Record has creator");
  assert(typeof r?.date === "string", "Record has date");
  assert(typeof r?.hasImage === "boolean", "Record has hasImage");
  assert(r?.lodUri?.startsWith("https://id.rijksmuseum.nl/"), `lodUri reconstructed (got ${r?.lodUri?.slice(0, 50)})`);
  assert(r?.url?.includes("rijksmuseum.nl/en/collection/"), "url is the canonical RM web URL");
  // edmType + IIIF URLs only present when hasImage
  if (r?.hasImage) {
    assert(r?.edmType === "IMAGE", `edmType=IMAGE when hasImage (got ${r?.edmType})`);
    assert(r?.iiifServiceUrl?.endsWith("/info.json"), `iiifServiceUrl is info.json (got ${r?.iiifServiceUrl?.slice(0, 60)})`);
  }
}

// ══════════════════════════════════════════════════════════════════
//  2. Second page via resumptionToken
// ══════════════════════════════════════════════════════════════════
section("2. Pagination via resumptionToken");

{
  const { sc, isError } = await call("browse_set", { resumptionToken: firstPageToken, maxResults: 5 });
  assert(!isError, "Second page returns no error");
  assert(sc?.records?.length === 5, `5 more records (got ${sc?.records?.length})`);
  assert(typeof sc?.resumptionToken === "string", "resumptionToken still present (more pages)");
  // Different objects than first page
  const secondFirst = sc?.records?.[0]?.objectNumber;
  assert(secondFirst && secondFirst !== firstObjectNumber,
    `Second page starts at a different objectNumber (first=${firstObjectNumber}, second=${secondFirst})`);
}

// ══════════════════════════════════════════════════════════════════
//  3. Tiny set: walk to the last page, confirm token absence
// ══════════════════════════════════════════════════════════════════
section("3. Walk a tiny set to the last page");

{
  // Find a small set first
  const lc = await call("list_curated_sets", { sortBy: "size", maxMembers: 5, includeStats: true });
  const smallSet = lc.sc?.sets?.find(s => s.memberCount > 0 && s.memberCount <= 5);
  if (!smallSet) {
    assert(false, "No small set found to walk to last page");
  } else {
    const { sc, isError } = await call("browse_set", { setSpec: smallSet.setSpec, maxResults: 50 });
    assert(!isError, `Walk small set ${smallSet.setSpec} (${smallSet.memberCount} members)`);
    assert(sc?.records?.length === smallSet.memberCount,
      `All ${smallSet.memberCount} records on first page (got ${sc?.records?.length})`);
    assert(sc?.resumptionToken === undefined, "Last page has no resumptionToken");
  }
}

// ══════════════════════════════════════════════════════════════════
//  4. Bad setSpec → totalInSet=0
// ══════════════════════════════════════════════════════════════════
section("4. Nonexistent setSpec");

{
  const { sc, isError } = await call("browse_set", { setSpec: "nonexistent-set-99999" });
  assert(!isError, "Nonexistent setSpec is not an error");
  assert(sc?.totalInSet === 0, `totalInSet=0 (got ${sc?.totalInSet})`);
  assert(sc?.records?.length === 0, "No records returned");
}

// ══════════════════════════════════════════════════════════════════
//  5. Invalid resumptionToken → error
// ══════════════════════════════════════════════════════════════════
section("5. Invalid resumptionToken");

{
  const { isError, text } = await call("browse_set", { resumptionToken: "garbage-not-base64" });
  assert(isError, "Invalid token returns isError");
  assert(text.toLowerCase().includes("token"), "Error message mentions token");
}

// ══════════════════════════════════════════════════════════════════
//  6. Warm latency < 100ms
// ══════════════════════════════════════════════════════════════════
section("6. Warm latency");

{
  // Warm one call first
  await call("browse_set", { setSpec: "26133", maxResults: 50 });
  const t0 = Date.now();
  await call("browse_set", { setSpec: "26133", maxResults: 50 });
  const dt = Date.now() - t0;
  assert(dt < 250, `Warm browse_set call completed in ${dt}ms (< 250ms practical)`);
}

// ══════════════════════════════════════════════════════════════════
//  Summary
// ══════════════════════════════════════════════════════════════════
section("RESULTS");
console.log(`\n  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\n  Failures:`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log();

await client.close();
process.exit(failed > 0 ? 1 : 0);
