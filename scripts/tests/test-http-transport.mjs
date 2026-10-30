/**
 * HTTP framing, body limits and the response timeout around the SDK's
 * toNodeHandler, on the fixture DB.
 *
 * Failure modes: a Content-Length forwarded beside a gzipped body truncates it;
 * SSE compressed or buffered, so a listen stream's first frame never arrives; a
 * body-less 202 that won't decode; express.json and the adapter disagreeing on
 * the size limit (the adapter alone sees non-JSON bodies); compressed request
 * bodies accepted again (they must stay off zlib); a body express.json rejects
 * answered in HTML, or its stack written to bare stderr, which Railway tags
 * level=error.
 *
 * withResponseTimeout (through toNodeHandler over real HTTP, since its
 * unconditional writeHead is the hazard): a stuck call never answered; the 504
 * written twice or crashing the adapter; a late response's SSE body left unread,
 * so its keep-alive runs forever; a late rejection going unhandled, which kills
 * the process; a stream cut because it outlived the timeout; a handler throw
 * hidden behind the 504.
 *
 * The handler's own maxRequestBodySize is an equivalent mutation: the adapter's
 * bound applies first and express.json has already checked parsed bodies.
 *
 * Run:  node scripts/tests/test-http-transport.mjs
 * Requires: npm run build
 */
import { spawn } from "node:child_process";
import http from "node:http";
import zlib from "node:zlib";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { withResponseTimeout } from "../../dist/utils/responseTimeout.js";
import { buildFixture } from "./build-fixture-vocab-db.mjs";
import { EXPECTED_TOOL_COUNT as TOOL_COUNT } from "./fixture-client.mjs";

const PORT = process.env.TEST_PORT ?? "31341";
const LIMIT = 1024 * 1024;
const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";

let failed = 0, passed = 0;
const check = (cond, msg) => { if (cond) passed++; else failed++; console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`); return cond; };
const eq = (actual, expected, msg) => check(actual === expected, actual === expected ? msg : `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Raw node:http, because fetch hides the wire: it decodes gzip and has no way to send a chosen Content-Length. */
function raw(url, { method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const wire = Buffer.concat(chunks);
        const gzipped = res.headers["content-encoding"] === "gzip";
        resolve({ status: res.statusCode, headers: res.headers, wire, text: (gzipped ? zlib.gunzipSync(wire) : wire).toString() });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

const JSON_POST = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "transport-test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
const modernHeaders = (method) => ({ ...JSON_POST, "mcp-protocol-version": MODERN, "mcp-method": method });
const modernBody = (method, params = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: MODERN_META } });
const legacyJson = { ...JSON_POST, "mcp-protocol-version": LEGACY };
const paddedJson = (size) => {
  const empty = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { pad: "" } } });
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { pad: "x".repeat(size - empty.length) } } });
};

// ── Server under test ─────────────────────────────────────────────
const child = spawn("node", ["dist/index.js"], {
  env: { ...process.env, PORT, ENABLE_FIND_SIMILAR: "true", MCP_SKIP_STARTUP_WARM: "1", VOCAB_DB_PATH: buildFixture("fixture-http-transport.db") },
  stdio: ["ignore", "ignore", "pipe"],
});
process.once("exit", () => child.kill("SIGKILL"));
let stderr = "";
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`HTTP server didn't start\n${stderr.slice(-2000)}`)), 30_000);
  child.stderr.on("data", (c) => {
    stderr += c;
    if (stderr.includes("listening on http://")) { clearTimeout(t); resolve(); }
  });
});
const url = `http://127.0.0.1:${PORT}/mcp`;

try {
  console.log("Response framing behind compression");
  {
    const r = await raw(url, { headers: { ...modernHeaders("tools/list"), "accept-encoding": "gzip" }, body: modernBody("tools/list") });
    eq(r.status, 200, "tools/list returns 200");
    eq(r.headers["content-encoding"], "gzip", "a response over the 1 KB threshold is compressed");
    eq(r.headers["content-length"], undefined, "no Content-Length describes the uncompressed size");
    eq(JSON.parse(r.text).result?.tools?.length, TOOL_COUNT, "the gunzipped body is the complete tool list");
  }
  {
    const r = await raw(url, { headers: modernHeaders("tools/list"), body: modernBody("tools/list") });
    eq(r.headers["content-encoding"], undefined, "without Accept-Encoding the response is plain");
    eq(JSON.parse(r.text).result?.tools?.length, TOOL_COUNT, "the plain body is the complete tool list");
    if (r.headers["content-length"] !== undefined) {
      eq(Number(r.headers["content-length"]), r.wire.length, "a Content-Length matches the bytes sent");
    }
  }
  {
    const r = await raw(url, {
      headers: { ...modernHeaders("tools/list"), "mcp-protocol-version": "2099-01-01", "accept-encoding": "gzip" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { ...MODERN_META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } } }),
    });
    eq(r.status, 400, "an unsupported revision returns 400");
    eq(JSON.parse(r.text).error?.code, -32022, "a small error body survives framing with gzip accepted");
  }
  {
    const r = await raw(url, {
      headers: { ...JSON_POST, "accept-encoding": "gzip" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    eq(r.status, 200, "legacy initialize returns 200");
    check(String(r.headers["content-type"]).includes("text/event-stream"), "legacy initialize answers as SSE");
    eq(r.headers["content-encoding"], undefined, "SSE stays uncompressed");
    check(r.text.includes(`"protocolVersion":"${LEGACY}"`), "the SSE frame carries the result");
  }
  {
    const r = await raw(url, {
      headers: { ...legacyJson, "accept-encoding": "gzip" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    eq(r.status, 202, "a legacy notification returns 202");
    eq(r.text, "", "the decoded 202 body is empty");
  }
  {
    const first = await new Promise((resolve, reject) => {
      const req = http.request(url, { method: "POST", headers: { ...modernHeaders("subscriptions/listen"), "accept-encoding": "gzip" } }, (res) => {
        res.once("data", (chunk) => {
          resolve({ encoding: res.headers["content-encoding"], frame: chunk.toString() });
          req.destroy();
        });
      });
      req.on("error", reject);
      req.end(modernBody("subscriptions/listen", { notifications: { toolsListChanged: true } }));
    });
    eq(first.encoding, undefined, "a listen stream is not compressed");
    check(first.frame.includes("notifications/subscriptions/acknowledged"), "its acknowledgement arrives while the stream is open");
  }

  console.log("Request body limits");
  const LIMIT_MESSAGE = `Payload Too Large: Request body must not exceed ${LIMIT} bytes`;
  {
    const at = await raw(url, { headers: legacyJson, body: paddedJson(LIMIT) });
    eq(at.status, 200, "a JSON body of exactly 1 MiB is served");
    const over = await raw(url, { headers: legacyJson, body: paddedJson(LIMIT + 1) });
    eq(over.status, 413, "a JSON body one byte over is refused");
    const err = JSON.parse(over.text);
    eq(err.error?.code, -32000, "the JSON 413 is a JSON-RPC error");
    eq(err.error?.message, LIMIT_MESSAGE, "the JSON 413 names the limit, as the adapter's does");
  }
  {
    const at = await raw(url, { headers: { "content-type": "text/plain" }, body: "x".repeat(LIMIT) });
    eq(at.status, 415, "a text/plain body at the limit reaches the content-type check");
    eq(JSON.parse(at.text).error?.message, "Unsupported Media Type: Content-Type must be application/json", "that 415 says what's wrong");
    const over = await raw(url, { headers: { "content-type": "text/plain" }, body: "x".repeat(LIMIT + 1) });
    eq(over.status, 413, "a text/plain body one byte over is refused by the adapter");
    eq(JSON.parse(over.text).error?.message, LIMIT_MESSAGE, "the adapter's 413 names the limit");
  }
  {
    const body = zlib.gzipSync(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    const r = await raw(url, { headers: { ...legacyJson, "content-encoding": "gzip" }, body });
    eq(r.status, 415, "Content-Encoding on a JSON request returns 415");
    eq(JSON.parse(r.text).error?.message, "Unsupported Media Type: compressed or non-UTF-8 request bodies are not accepted", "that 415 says what's wrong");
  }
  {
    const r = await raw(url, { headers: legacyJson, body: "{not json" });
    eq(r.status, 400, "malformed JSON returns 400");
    const err = JSON.parse(r.text);
    eq(err.error?.code, -32700, "the code is -32700 (parse error)");
    eq(err.error?.message, "Parse error: the request body is not valid JSON", "the message names the parse failure");
    eq(err.id, null, "the id is null, since the body couldn't be read");
  }
  {
    const lines = stderr.split("\n").filter(Boolean);
    const bare = lines.filter((l) => {
      try { return typeof JSON.parse(l).level !== "string"; } catch { return true; }
    });
    eq(bare.join("\n").slice(0, 200), "", "every stderr line is JSON with a level");
    const warns = lines.filter((l) => l.includes('"message":"Rejected MCP request body"'));
    eq(warns.length, 3, "the 413, the 415 and the parse error each log one line");
    check(warns.every((l) => JSON.parse(l).level === "warn"), "rejected input is logged at warn, not error");
    check(warns.every((l) => !l.includes('"stack"')), "a rejected body logs no stack");
  }
  {
    const r = await raw(url, { method: "GET", headers: { accept: "text/event-stream" } });
    eq(r.status, 405, "GET returns 405");
    eq(r.headers.allow, "POST", "Allow names POST");
  }
} finally {
  child.kill();
}

// ── withResponseTimeout through toNodeHandler ─────────────────────
console.log("withResponseTimeout");
{
  const TIMEOUT_MS = 50;
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);

  /** Serve one stubbed fetch over real HTTP; the adapter's errors are collected. */
  const serve = async (fetchStub) => {
    const adapterErrors = [];
    const handle = toNodeHandler(withResponseTimeout({ fetch: fetchStub }, TIMEOUT_MS), {
      onerror: (e) => adapterErrors.push(e.message),
    });
    const rejections = [];
    const server = http.createServer((req, res) => {
      handle(req, res).catch((e) => { rejections.push(e.message); res.destroy(); });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const stubUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    return { url: stubUrl, adapterErrors, rejections, close: () => { server.closeAllConnections(); server.close(); } };
  };
  const post = (u) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

  {
    let cancelled = false;
    const late = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(": keepalive\n\n")); },
      cancel() { cancelled = true; },
    });
    const s = await serve(async () => {
      await sleep(TIMEOUT_MS * 3);
      return new Response(late, { headers: { "content-type": "text/event-stream" } });
    });
    try {
      const r = await post(s.url);
      eq(r.status, 504, "a stuck call is answered 504");
      eq(await r.text(), '{"error":"Request timeout"}', "the 504 body names the timeout");
      await sleep(TIMEOUT_MS * 4);
      check(cancelled, "the late response's body is cancelled");
      eq(s.rejections.length, 0, "the adapter doesn't throw (no ERR_HTTP_HEADERS_SENT)");
    } finally { s.close(); }
  }
  {
    const s = await serve(async () => { await sleep(TIMEOUT_MS * 3); return new Response("late"); });
    try {
      const ac = new AbortController();
      const pending = fetch(s.url, { method: "POST", body: "{}", signal: ac.signal }).catch((e) => e.name);
      await sleep(TIMEOUT_MS / 5);
      ac.abort();
      eq(await pending, "AbortError", "a client can leave during a stuck call");
      await sleep(TIMEOUT_MS * 4);
      eq(s.rejections.length, 0, "the adapter survives writing to the closed response");
    } finally { s.close(); }
  }
  {
    const s = await serve(async () => { await sleep(TIMEOUT_MS * 2); throw new Error("late failure"); });
    try {
      eq((await post(s.url)).status, 504, "a call that fails late is answered 504");
      await sleep(TIMEOUT_MS * 3);
      eq(unhandled.length, 0, "its late rejection stays handled");
    } finally { s.close(); }
  }
  {
    const s = await serve(async () => new Response(new ReadableStream({
      async start(c) {
        c.enqueue(new TextEncoder().encode("first,"));
        await sleep(TIMEOUT_MS * 3);
        c.enqueue(new TextEncoder().encode("last"));
        c.close();
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    try {
      const r = await post(s.url);
      eq(r.status, 200, "a stream keeps its status");
      eq(await r.text(), "first,last", "a stream runs to its end, past the timeout");
    } finally { s.close(); }
  }
  {
    const s = await serve(async () => new Response("ok", { status: 201, headers: { "x-test": "1" } }));
    try {
      const r = await post(s.url);
      eq(r.status, 201, "a timely response keeps its status");
      eq(r.headers.get("x-test"), "1", "and its headers");
      eq(await r.text(), "ok", "and its body");
    } finally { s.close(); }
  }
  {
    const s = await serve(async () => { throw new Error("boom"); });
    try {
      const r = await post(s.url);
      eq(r.status, 500, "a handler throw becomes the adapter's 500, not the 504");
      eq((await r.json()).error?.message, "Internal server error", "the 500 is the adapter's JSON-RPC error");
      eq(s.adapterErrors.join(), "boom", "the adapter's onerror sees the cause");
    } finally { s.close(); }
  }

  process.off("unhandledRejection", onUnhandled);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
