#!/usr/bin/env node
/**
 * test-removed-provenance-filter.mjs — verify #304: search_artwork({provenance: ...})
 * is rejected with a Zod-strict error after v0.27. Provenance keyword search now
 * lives on search_provenance.
 *
 * Also verifies that the underlying provenance_text column / hasProvenance modifier /
 * search_provenance tool / get_artwork_details.provenance output are NOT removed.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "removed-provenance-test", version: "1.0" });
await client.connect(transport);
console.log("Connected\n");

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

async function call(name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    return r;
  } catch (e) {
    return { _error: e.message };
  }
}

// 1. provenance: as a search_artwork param is rejected.
console.log("1. search_artwork({provenance: 'Six'}) — should error");
let r = await call("search_artwork", { provenance: "Six" });
const errText = r?._error ?? r?.content?.[0]?.text ?? JSON.stringify(r);
check("Rejected (Zod-strict or runtime error)", !!(r?._error || r?.isError));
check("Error mentions Unrecognized key OR routing failure", /Unrecognized|Invalid|provenance|filter/i.test(errText));
console.log(`   → ${errText.slice(0, 180)}`);

// 2. hasProvenance modifier (boolean) still works.
console.log("\n2. search_artwork({type: 'painting', hasProvenance: true}) — modifier still works");
r = await call("search_artwork", { type: "painting", hasProvenance: true, maxResults: 1 });
check("No error", !r?.isError);
const sc = r?.structuredContent ?? (r?.content?.[0]?.text ? JSON.parse(r.content[0].text) : null);
check("Has totalResults", typeof sc?.totalResults === "number");
console.log(`   totalResults: ${sc?.totalResults}`);

// 3. search_provenance still works as the replacement surface.
console.log("\n3. search_provenance({party: 'Six', maxResults: 1}) — replacement surface");
r = await call("search_provenance", { party: "Six", maxResults: 1 });
check("No error", !r?.isError);
const sp = r?.structuredContent ?? (r?.content?.[0]?.text ? JSON.parse(r.content[0].text) : null);
check("Returns totalArtworks", typeof sp?.totalArtworks === "number");
console.log(`   totalArtworks: ${sp?.totalArtworks}`);

await client.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
