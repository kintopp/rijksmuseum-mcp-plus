/**
 * Smoke check for #341: confirms `url` is the only browser-page-URL field
 * on get_artwork_details and get_artwork_image, and that `webPage` and
 * `collectionUrl` no longer appear in structuredContent.
 *
 * Run:  npm run build  &&  node scripts/tests/test-url-rename-smoke.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(PROJECT_DIR, "dist/index.js")],
  env: { ...process.env },
});
const client = new Client({ name: "url-rename-smoke", version: "1.0" }, { capabilities: {} });
await client.connect(transport);

const objNum = "SK-C-5";
let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(cond ? `  ok   ${name}` : `  FAIL ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

const sc = (r) => r.structuredContent ?? JSON.parse(r.content?.find?.((c) => c.type === "text")?.text ?? "{}");

console.log("== #341: url consolidation ==");

const details = await client.callTool({ name: "get_artwork_details", arguments: { objectNumber: objNum } });
const d = sc(details);
check("get_artwork_details.url present", typeof d.url === "string" && d.url.includes(objNum), JSON.stringify(d.url));
check("get_artwork_details.webPage REMOVED", d.webPage === undefined, `got ${JSON.stringify(d.webPage)}`);

const image = await client.callTool({ name: "get_artwork_image", arguments: { objectNumber: objNum } });
const i = sc(image);
check("get_artwork_image.url present", typeof i.url === "string" && i.url.includes(objNum), JSON.stringify(i.url));
check("get_artwork_image.collectionUrl REMOVED", i.collectionUrl === undefined, `got ${JSON.stringify(i.collectionUrl)}`);
check("get_artwork_image.url === get_artwork_details.url", d.url === i.url);

await client.close();
console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
