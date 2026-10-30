/**
 * creditLineQuery warns only about filters the caller actually sent.
 *
 * Failure modes:
 *  - a default or an explicit compact:false reads as a caller filter, so the call warns falsely
 *  - an explicit compact:true or a real filter stops being reported
 *
 * Run:  node scripts/tests/test-credit-line-warnings.mjs
 * Requires: npm run build.
 */
import { strict as assert } from "node:assert";
import { connectFixtureClient } from "./fixture-client.mjs";

const client = await connectFixtureClient("credit-line-warnings");

let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
};
const warningsFor = async (args) =>
  (await client.callTool({ name: "search_provenance", arguments: args })).structuredContent.warnings ?? [];
const ignoredWarning = (filter) =>
  `creditLineQuery runs a standalone unstructured search; these filters were ignored: ${filter}. ` +
  "Run them in a separate structured search_provenance call.";

console.log("\ncreditLineQuery warnings\n");

await check("no warning when only creditLineQuery is sent", async () => {
  assert.deepEqual(await warningsFor({ creditLineQuery: "gift" }), []);
});

await check("an explicit compact:false is not reported", async () => {
  assert.deepEqual(await warningsFor({ creditLineQuery: "gift", compact: false }), []);
});

await check("an explicit compact:true is reported", async () => {
  assert.ok((await warningsFor({ creditLineQuery: "gift", compact: true })).includes(ignoredWarning("compact")));
});

await check("a real filter is reported", async () => {
  assert.ok((await warningsFor({ creditLineQuery: "gift", transferType: "sale" })).includes(ignoredWarning("transferType")));
});

await client.close();
console.log(`\n${failed === 0 ? "All passed" : `${failed} failed`}\n`);
process.exit(failed > 0 ? 1 : 0);
