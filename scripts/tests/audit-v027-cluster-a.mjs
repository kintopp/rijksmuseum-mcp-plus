/**
 * One-shot empirical audit of v0.27 cluster A surface against the v0.26 DB.
 * Captures response sizes + key inventories for documentation. Not part of any test suite.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "audit", version: "0.1" });
await client.connect(transport);

for (const obj of ["SK-C-5", "SK-A-4969", "SK-A-3953", "KOG-MP-2-2061-2"]) {
  const r = await client.callTool({ name: "get_artwork_details", arguments: { objectNumber: obj } });
  const d = r.structuredContent ?? JSON.parse(r.content[0].text);
  const json = JSON.stringify(d);
  const keys = Object.keys(d).sort();
  console.log(`\n=== ${obj} ===`);
  console.log(`title          : ${(d.title ?? "").slice(0, 80)}`);
  console.log(`structuredBytes: ${json.length}`);
  console.log(`keyCount       : ${keys.length}`);
  console.log(`themes         : ${d.themes?.length}/${d.themesTotalCount}`);
  console.log(`exhibitions    : ${d.exhibitions?.length}/${d.exhibitionsTotalCount}`);
  console.log(`attribEvidence : ${d.attributionEvidence?.length}`);
  console.log(`dimensions     : ${d.dimensions.map(x => x.type).join(",")}`);
  console.log(`dateDisplay    : ${d.dateDisplay ?? "(null)"}`);
  console.log(`extentText     : ${(d.extentText ?? "(null)").slice(0, 70)}`);
  console.log(`recordCreated  : ${d.recordCreated ?? "(null)"}`);
  console.log(`recordModified : ${d.recordModified ?? "(null)"}`);
  console.log(`location       : ${JSON.stringify(d.location)}`);
  console.log(`externalIds    : handle=${d.externalIds?.handle ? "yes" : "no"} other=${d.externalIds?.other?.length ?? 0}`);
}
await client.close();
