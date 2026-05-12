/**
 * MCP Apps metadata / conformance test for the artwork-viewer.
 *
 * Connects to the built server over stdio and asserts the wire-level shape of
 * the UI resource and the viewer-family tools against the MCP Apps (ext-apps)
 * spec — the bits hosts read at connection time to decide CSP, borders, and
 * which tools the model may see:
 *
 *   - UI resource: ui:// URI, text/html;profile=mcp-app mime, _meta.ui.csp
 *     (resourceDomains + connectDomains), prefersBorder:false
 *   - Render tool (get_artwork_image): _meta.ui.resourceUri points at the resource
 *   - App-only tools (remount_viewer, poll_viewer_commands): visibility:["app"],
 *     no ui.resourceUri (no template bound to a hidden tool)
 *   - No tool carries the deprecated bare flat _meta["ui/resourceUri"] in
 *     *addition to* a mismatched nested form (the SDK mirrors nested→flat for
 *     back-compat; the two must agree, and resource _meta must not carry it)
 *
 * Run:  node scripts/tests/test-app-conformance.mjs
 * Uses: @modelcontextprotocol/sdk Client + StdioClientTransport (stdio mode)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps/server";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VIEWER_URI = "ui://rijksmuseum/artwork-viewer.html";

let passed = 0;
let failed = 0;
const failures = [];

function check(msg, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${msg}`);
  } catch (err) {
    failed++;
    failures.push(`${msg}\n      ${err.message.split("\n")[0]}`);
    console.log(`  ✗ ${msg}\n      ${err.message.split("\n")[0]}`);
  }
}

function section(name) {
  console.log(`\n${"═".repeat(60)}\n  ${name}\n${"═".repeat(60)}`);
}

const uiMeta = (m) => m?.["io.modelcontextprotocol/ui"] ?? m?.ui ?? undefined;

// ── Connect ───────────────────────────────────────────────────────

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "test-app-conformance", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

// ── 1. UI resource ────────────────────────────────────────────────

section("1. UI resource (resources/list + resources/read)");

const { resources } = await client.listResources();
const listEntry = resources.find((r) => r.uri === VIEWER_URI);

check("resources/list contains the artwork-viewer ui:// resource", () => {
  assert.ok(listEntry, `no resource with uri ${VIEWER_URI} (got: ${resources.map((r) => r.uri).join(", ")})`);
});
check("resource URI uses the ui:// scheme", () => {
  assert.ok(listEntry.uri.startsWith("ui://"), `uri = ${listEntry.uri}`);
});
check(`resource mimeType is ${RESOURCE_MIME_TYPE}`, () => {
  assert.equal(listEntry.mimeType, RESOURCE_MIME_TYPE);
});

const listUi = uiMeta(listEntry._meta);
check("resources/list entry carries _meta.ui (so hosts can review CSP pre-connect)", () => {
  assert.ok(listUi, `_meta = ${JSON.stringify(listEntry._meta)}`);
});
check("resource _meta.ui.csp.resourceDomains is a non-empty array", () => {
  assert.ok(Array.isArray(listUi.csp?.resourceDomains) && listUi.csp.resourceDomains.length > 0,
    JSON.stringify(listUi.csp));
});
check("resource _meta.ui.csp.connectDomains is a non-empty array", () => {
  assert.ok(Array.isArray(listUi.csp?.connectDomains) && listUi.csp.connectDomains.length > 0,
    JSON.stringify(listUi.csp));
});
check("resource _meta.ui.prefersBorder === false", () => {
  assert.equal(listUi.prefersBorder, false);
});
check("resource _meta does NOT carry the flat ui/resourceUri key (resources don't bind templates)", () => {
  assert.equal(listEntry._meta?.[RESOURCE_URI_META_KEY], undefined,
    `flat key present: ${JSON.stringify(listEntry._meta?.[RESOURCE_URI_META_KEY])}`);
});

const read = await client.readResource({ uri: VIEWER_URI });
const content = read.contents?.[0];
check("resources/read returns one content item for the viewer", () => {
  assert.ok(content && content.uri === VIEWER_URI, JSON.stringify(read.contents));
});
check(`resources/read content mimeType is ${RESOURCE_MIME_TYPE}`, () => {
  assert.equal(content.mimeType, RESOURCE_MIME_TYPE);
});
check("resources/read content carries _meta.ui (authoritative copy)", () => {
  assert.ok(uiMeta(content._meta), JSON.stringify(content._meta));
});
check("resources/read content is a non-empty HTML document", () => {
  assert.ok(typeof content.text === "string" && content.text.includes("<html"), `len=${content.text?.length}`);
});

// ── 2. Viewer-family tools ────────────────────────────────────────

section("2. Viewer-family tools (tools/list)");

const { tools } = await client.listTools();
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

const render = byName["get_artwork_image"];
check("get_artwork_image (render tool) is listed", () => assert.ok(render));
check("get_artwork_image _meta.ui.resourceUri points at the viewer resource", () => {
  assert.equal(uiMeta(render._meta)?.resourceUri, VIEWER_URI, JSON.stringify(render._meta));
});
check("get_artwork_image: nested and flat resourceUri (if both present) agree", () => {
  const flat = render._meta?.[RESOURCE_URI_META_KEY];
  if (flat !== undefined) assert.equal(flat, VIEWER_URI, `flat=${flat}`);
});
check("get_artwork_image has an outputSchema (structured render payload)", () => {
  assert.ok(render.outputSchema && render.outputSchema.type === "object", JSON.stringify(render.outputSchema));
});

for (const appOnly of ["remount_viewer", "poll_viewer_commands"]) {
  const t = byName[appOnly];
  check(`${appOnly} is registered`, () => assert.ok(t));
  check(`${appOnly} _meta.ui.visibility === ["app"]`, () => {
    assert.deepEqual(uiMeta(t._meta)?.visibility, ["app"], JSON.stringify(t._meta));
  });
  check(`${appOnly} carries NO ui.resourceUri (no template bound to a hidden tool)`, () => {
    assert.equal(uiMeta(t._meta)?.resourceUri, undefined, JSON.stringify(t._meta));
    assert.equal(t._meta?.[RESOURCE_URI_META_KEY], undefined, JSON.stringify(t._meta));
  });
}

check("poll_viewer_commands has an outputSchema ({ commands })", () => {
  const t = byName["poll_viewer_commands"];
  assert.ok(t.outputSchema && t.outputSchema.type === "object" && t.outputSchema.properties?.commands,
    JSON.stringify(t.outputSchema));
});

check("no non-viewer tool advertises a ui.resourceUri", () => {
  const offenders = tools
    .filter((t) => t.name !== "get_artwork_image" && uiMeta(t._meta)?.resourceUri)
    .map((t) => t.name);
  assert.deepEqual(offenders, [], `offenders: ${offenders.join(", ")}`);
});

// ── Summary ───────────────────────────────────────────────────────

await client.close();

console.log(`\n${"═".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`${"═".repeat(60)}\n  FAILURES:`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log(`${"═".repeat(60)}`);
