#!/usr/bin/env node
/**
 * test-removed-demographic-filters.mjs — verify #305: the 6 demographic filters
 * (creatorGender, creatorBornAfter, creatorBornBefore, birthPlace, deathPlace, profession)
 * are removed from search_artwork. Each call returns a Zod-strict rejection.
 *
 * Migration target: search_persons → search_artwork({creator: <vocabId>}).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "removed-demographic-test", version: "1.0" });
await client.connect(transport);
console.log("Connected\n");

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

async function expectReject(args, key) {
  try {
    const r = await client.callTool({ name: "search_artwork", arguments: args });
    const errText = r?.isError ? (r.content?.[0]?.text ?? "") : "";
    check(`${key}: rejected`, !!r?.isError);
    check(`${key}: error mentions Unrecognized key`, /Unrecognized|unrecognized/i.test(errText));
  } catch (e) {
    check(`${key}: rejected (thrown)`, /Unrecognized|unrecognized/i.test(e.message));
  }
}

console.log("All 6 removed demographic filters should be rejected:\n");
await expectReject({ type: "painting", creatorGender: "female" }, "creatorGender");
await expectReject({ type: "painting", creatorBornAfter: 1850 }, "creatorBornAfter");
await expectReject({ type: "painting", creatorBornBefore: 1900 }, "creatorBornBefore");
await expectReject({ type: "painting", birthPlace: "Amsterdam" }, "birthPlace");
await expectReject({ type: "painting", deathPlace: "Paris" }, "deathPlace");
await expectReject({ type: "painting", profession: "painter" }, "profession");

console.log("\nMigration target search_persons works:");
const sp = await client.callTool({ name: "search_persons", arguments: { profession: "painter", maxResults: 1 } });
const ok = !sp.isError;
check("search_persons({profession: 'painter'}) is callable", ok);

await client.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
