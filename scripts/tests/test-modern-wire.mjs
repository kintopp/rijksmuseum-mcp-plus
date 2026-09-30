/**
 * Coverage for the 2026-07-28 ("modern") MCP wire, over HTTP and stdio.
 *
 * The v1 client used by the other tests caps at 2025-11-25, so this is raw
 * fetch / raw stdio on purpose — don't "simplify" it into the v1 SDK client.
 * Modern requests carry MCP-Protocol-Version + Mcp-Method (+ Mcp-Name for
 * tools/call) headers and a params._meta envelope; there is no initialize.
 *
 * Run:  node scripts/tests/test-modern-wire.mjs
 * Requires: npm run build, data/vocabulary.db
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PORT = process.env.TEST_PORT ?? "31339";
const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";
let failed = 0, passed = 0;
const check = (cond, msg) => { if (cond) passed++; else failed++; console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`); };

const envelope = (version = MODERN) => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientInfo": { name: "modern-wire-test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
});
const parse = (text) => { try { return JSON.parse(text.replace(/^event:.*\ndata: /m, "")); } catch { return null; } };

// ── HTTP ──────────────────────────────────────────────────────────
const child = spawn("node", ["dist/index.js"], {
  env: { ...process.env, PORT, ENABLE_FIND_SIMILAR: "true" },
  stdio: ["ignore", "ignore", "pipe"],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("HTTP server didn't start")), 30_000);
  child.stderr.on("data", (c) => { if (String(c).includes("listening on http://")) { clearTimeout(t); resolve(); } });
});
const URL_ = `http://127.0.0.1:${PORT}/mcp`;
async function post(headers, body) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, type: r.headers.get("content-type"), body: parse(await r.text()) };
}
const modern = (method, params, extra = {}) =>
  post({ "mcp-protocol-version": MODERN, "mcp-method": method, ...extra },
    { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: envelope() } });
const call = (name, args) => modern("tools/call", { name, arguments: args }, { "mcp-name": name });

try {
  console.log("HTTP, modern wire");
  const d = await modern("server/discover", { supportedVersions: [MODERN] });
  check(d.status === 200 && d.body?.result?.supportedVersions?.includes(MODERN), "server/discover advertises 2026-07-28");
  check(d.body?.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name === "rijksmuseum-mcp+", "serverInfo relocated into _meta");

  const list = await modern("tools/list", {});
  const names = list.body?.result?.tools?.map((t) => t.name) ?? [];
  check(list.status === 200 && names.length === 19, `tools/list returns 19 tools (got ${names.length})`);
  check(!JSON.stringify(list.body?.result ?? {}).includes("$ref"), "schemas stay $ref-free");
  const img = list.body?.result?.tools?.find((t) => t.name === "get_artwork_image");
  check(img?._meta?.ui?.resourceUri === "ui://rijksmuseum/artwork-viewer.html", "get_artwork_image keeps its ui.resourceUri");

  const s = await call("search_artwork", { creator: "Rembrandt van Rijn", type: "painting", maxResults: 3 });
  check(!s.body?.result?.isError && s.body?.result?.structuredContent?.results?.length > 0, "search_artwork returns structuredContent");

  const det = await call("get_artwork_details", { objectNumber: "SK-C-5" });
  check(det.body?.result?.structuredContent?.objectNumber === "SK-C-5", "get_artwork_details over modern wire");

  const bad = await call("get_artwork_details", { objectNumber: "SK-C-5", bogus: 1 });
  check(bad.body?.result?.isError || bad.body?.error, "strict schemas still reject unknown params");

  const res = await modern("resources/read", { uri: "ui://rijksmuseum/artwork-viewer.html" },
    { "mcp-name": "ui://rijksmuseum/artwork-viewer.html" }); // Mcp-Name carries params.uri here
  const c = res.body?.result?.contents?.[0];
  check(c?.mimeType === "text/html;profile=mcp-app" && c?.text?.length > 100_000, "viewer resource readable over modern wire");
  check(c?._meta?.ui?.csp?.connectDomains?.[0] === "https://iiif.micr.io", "viewer resource keeps CSP meta");

  const fut = await post({ "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/list" },
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: envelope("2099-01-01") } });
  check(fut.status === 400 && fut.body?.error?.data?.supported?.includes(MODERN), "unknown revision refused with supported list");

  const o = await fetch(URL_, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json", "mcp-protocol-version": MODERN, "mcp-method": "tools/list" }, body: "{}" });
  check(o.status === 403, "Origin allowlist still enforced ahead of the handler");

  const g = await fetch(URL_);
  check(g.status === 405, "GET /mcp still 405");

  // Concurrency: the ChatGPT bridge fires overlapping calls.
  const many = await Promise.all(Array.from({ length: 8 }, () => modern("tools/list", {})));
  check(many.every((r) => r.status === 200), "8 concurrent modern requests all succeed");

  console.log("HTTP, legacy wire");
  const init = await post({}, { jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  check(init.body?.result?.protocolVersion === LEGACY, "legacy initialize negotiates 2025-11-25");
  const ll = await post({ "mcp-protocol-version": LEGACY }, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  check(ll.body?.result?.tools?.length === 19, "legacy tools/list returns 19 tools");
} finally {
  child.kill();
}

// ── stdio ─────────────────────────────────────────────────────────
console.log("stdio, modern wire");
const sp = spawn("node", ["dist/index.js"], {
  env: { ...process.env, ENABLE_FIND_SIMILAR: "true", MCP_SKIP_STARTUP_WARM: "1" },
  stdio: ["pipe", "pipe", "ignore"],
});
const pending = new Map();
createInterface({ input: sp.stdout }).on("line", (l) => {
  const m = parse(l); if (m?.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const req = (msg) => new Promise((r) => { pending.set(msg.id, r); sp.stdin.write(JSON.stringify(msg) + "\n"); });
try {
  const d = await req({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { supportedVersions: [MODERN], _meta: envelope() } });
  check(d.result?.supportedVersions?.includes(MODERN), "stdio server/discover pins 2026-07-28");
  const l = await req({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: envelope() } });
  check(l.result?.tools?.length === 19, "stdio modern tools/list returns 19 tools");
  const c = await req({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_artwork_details", arguments: { objectNumber: "SK-C-5" }, _meta: envelope() } });
  check(c.result?.structuredContent?.objectNumber === "SK-C-5", "stdio modern tools/call returns structuredContent");
} finally {
  sp.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
