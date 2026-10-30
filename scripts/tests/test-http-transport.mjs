/**
 * HTTP framing, body handling and the response guard around the SDK's
 * toNodeHandler, on the fixture DB.
 *
 * Failure modes: a Content-Length forwarded beside a gzipped body truncates it;
 * a small JSON answer gzipped because compression never learned its length; SSE
 * compressed or buffered, so a listen stream's first frame never arrives; a
 * body-less 202 that won't decode; a non-JSON body read before it is refused, so
 * a slow upload holds the request; compressed request bodies accepted again (they
 * must stay off zlib); a body express.json rejects answered in HTML, or its stack
 * written to bare stderr, which Railway tags level=error; client text from a bad
 * body in the logs; a blocked Origin able to write those log lines; another
 * route's error reported as a JSON-RPC parse error; /debug/memory losing
 * heapAfterMajorGc, the leak signal after a deploy.
 *
 * withResponseGuard (real createMcpHandler and toNodeHandler over real HTTP,
 * since the adapter's unconditional writeHead and its abort path are the hazards):
 * a stuck call never answered; a 504 that leaves the tool running; a 504 without
 * the request's JSON-RPC id; a 2025-era SSE call with no deadline; a late result
 * crashing the adapter or going unhandled; a listen stream cut at the deadline;
 * a late SSE body left unread, so its keep-alive runs forever (#427); a handler
 * throw hidden behind the 504; an adapter failure swallowed by the guard's catch;
 * a finished result cut while a slow client downloads it; a stalled download
 * held open forever; a late SSE body missed because the abort came after the
 * framing layer looked; an upstream timeout the deadline hides; a tool's upstream
 * call left running after the deadline, or logged as a server error.
 *
 * Mounting the error handler app-wide is an equivalent mutation: it is registered
 * before the page routes, so their errors never reach it.
 *
 * Run:  node scripts/tests/test-http-transport.mjs
 * Requires: npm run build
 */
import { spawn } from "node:child_process";
import http from "node:http";
import zlib from "node:zlib";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { withResponseFraming, withResponseGuard } from "../../dist/utils/responseGuard.js";
import { OaiPmhClient } from "../../dist/api/OaiPmhClient.js";
import { RijksmuseumApiClient } from "../../dist/api/RijksmuseumApiClient.js";
import { VocabularyDb } from "../../dist/api/VocabularyDb.js";
import { createLogger } from "../../dist/registration/helpers.js";
import { registerProvenanceTools } from "../../dist/registration/tools/provenance.js";
import { registerSimilarTools } from "../../dist/registration/tools/similar.js";
import { registerViewerTools } from "../../dist/registration/tools/viewer.js";
import axios from "axios";
import compression from "compression";
import { randomBytes } from "node:crypto";
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

function boot(port, nodeArgs = []) {
  const child = spawn("node", [...nodeArgs, "dist/index.js"], {
    env: { ...process.env, PORT: String(port), ENABLE_FIND_SIMILAR: "true", MCP_SKIP_STARTUP_WARM: "1", VOCAB_DB_PATH: buildFixture(`fixture-http-transport-${port}.db`) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  process.once("exit", () => child.kill("SIGKILL"));
  const handle = { child, stderr: "" };
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`HTTP server didn't start\n${handle.stderr.slice(-2000)}`)), 30_000);
    child.stderr.on("data", (c) => {
      handle.stderr += c;
      if (handle.stderr.includes("listening on http://")) { clearTimeout(t); resolve(handle); }
    });
  });
}

// ── Server under test ─────────────────────────────────────────────
const server = await boot(PORT);
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
    eq(Number(r.headers["content-length"]), r.wire.length, "its Content-Length matches the bytes sent");
  }
  {
    const r = await raw(url, {
      headers: { ...modernHeaders("tools/list"), "mcp-protocol-version": "2099-01-01", "accept-encoding": "gzip" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { ...MODERN_META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } } }),
    });
    eq(r.status, 400, "an unsupported revision returns 400");
    eq(JSON.parse(r.text).error?.code, -32022, "a small error body survives framing");
    eq(r.headers["content-encoding"], undefined, "a small JSON answer stays under the threshold, uncompressed");
    eq(Number(r.headers["content-length"]), r.wire.length, "and keeps a matching Content-Length");
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

  console.log("Request bodies");
  const NOT_JSON = "Unsupported Media Type: Content-Type must be application/json";
  {
    const at = await raw(url, { headers: legacyJson, body: paddedJson(LIMIT) });
    eq(at.status, 200, "a JSON body of exactly 1 MiB is served");
    const over = await raw(url, { headers: legacyJson, body: paddedJson(LIMIT + 1) });
    eq(over.status, 413, "a JSON body one byte over is refused");
    const err = JSON.parse(over.text);
    eq(err.error?.code, -32000, "the 413 is a JSON-RPC error");
    eq(err.error?.message, `Payload Too Large: Request body must not exceed ${LIMIT} bytes`, "the 413 names the limit");
  }
  {
    const r = await raw(url, { headers: { "content-type": "text/plain" }, body: "x" });
    eq(r.status, 415, "a text/plain body is refused");
    eq(JSON.parse(r.text).error?.message, NOT_JSON, "that 415 says what's wrong");
    const none = await raw(url, { headers: { "transfer-encoding": "chunked" }, body: "x" });
    eq(none.status, 415, "a body with no Content-Type is refused");
  }
  {
    // The body never finishes, so an answer proves it wasn't read first.
    const answer = await new Promise((resolve, reject) => {
      const req = http.request(url, { method: "POST", headers: { "content-type": "text/plain", "content-length": 1000 } }, (res) => {
        resolve(res.statusCode);
        req.destroy();
      });
      req.on("error", reject);
      req.write("x");
      setTimeout(() => reject(new Error("no answer while the body was unfinished")), 5000).unref();
    });
    eq(answer, 415, "an unfinished non-JSON upload is answered without waiting for it");
  }
  {
    const secret = "secretword";
    const r = await raw(url, { headers: legacyJson, body: `[${secret}` });
    eq(r.status, 400, "malformed JSON returns 400");
    const err = JSON.parse(r.text);
    eq(err.error?.code, -32700, "the code is -32700 (parse error)");
    eq(err.error?.message, "Parse error: the request body is not valid JSON", "the message names the parse failure");
    eq(err.id, null, "the id is null, since the body couldn't be read");
    check(!server.stderr.includes(secret), "client text from a bad body stays out of the logs");
  }
  {
    const body = zlib.gzipSync(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    const r = await raw(url, { headers: { ...legacyJson, "content-encoding": "gzip" }, body });
    eq(r.status, 415, "Content-Encoding on a JSON request returns 415");
    eq(JSON.parse(r.text).error?.message, "Unsupported Media Type: compressed or non-UTF-8 request bodies are not accepted", "that 415 says what's wrong");
  }
  {
    const r = await raw(url, { headers: { ...legacyJson, origin: "https://evil.example" }, body: "{not json" });
    eq(r.status, 403, "a disallowed Origin is refused before its body is parsed");
  }
  {
    const lines = server.stderr.split("\n").filter(Boolean);
    const bare = lines.filter((l) => {
      try { return typeof JSON.parse(l).level !== "string"; } catch { return true; }
    });
    // The Origin gate's own [mcp-origin] line predates this and is throttled.
    const unexpected = bare.filter((l) => !l.startsWith("[mcp-origin]"));
    eq(unexpected.join("\n").slice(0, 200), "", "every other stderr line is JSON with a level");
    const warns = lines.filter((l) => l.includes('"message":"Rejected MCP request body"'));
    eq(warns.length, 3, "only the 413, the parse error and the gzip 415 log a rejected body");
    check(warns.every((l) => JSON.parse(l).level === "warn"), "rejected input is logged at warn, not error");
    check(warns.every((l) => !l.includes('"stack"')), "a rejected body logs no stack");
  }
  {
    const r = await raw(url, { method: "GET", headers: { accept: "text/event-stream" } });
    eq(r.status, 405, "GET returns 405");
    eq(r.headers.allow, "POST", "Allow names POST");
  }
  {
    const page = await raw(url.replace("/mcp", "/similar/%ZZ"), { method: "GET" });
    eq(page.status, 400, "a bad page URL stays a 400");
    check(!page.text.includes("Parse error"), "another route's error isn't reported as a JSON-RPC parse error");
    const before = server.stderr.split('"message":"Rejected MCP request body"').length;
    const health = await raw(url.replace("/mcp", "/health"), { headers: JSON_POST, body: "{not json" });
    eq(health.status, 404, "POST /health isn't parsed as an MCP body");
    eq(server.stderr.split('"message":"Rejected MCP request body"').length, before, "and logs no rejected MCP body");
  }
} finally {
  server.child.kill();
}

// ── /debug/memory ─────────────────────────────────────────────────
console.log("/debug/memory");
{
  // --gc-global makes every GC a major one, so a few requests guarantee one.
  const port = String(Number(PORT) + 1);
  const gcServer = await boot(port, ["--gc-global"]);
  try {
    for (let i = 0; i < 3; i++) await raw(`http://127.0.0.1:${port}/mcp`, { headers: modernHeaders("tools/list"), body: modernBody("tools/list") });
    const gc = JSON.parse((await raw(`http://127.0.0.1:${port}/debug/memory`, { method: "GET" })).text).heapAfterMajorGc;
    if (check(gc !== null && typeof gc === "object", "heapAfterMajorGc is recorded after a major GC")) {
      check(gc.usedBytes > 0, `heapAfterMajorGc.usedBytes > 0 (got ${gc.usedBytes})`);
      check(!Number.isNaN(Date.parse(gc.at)), `heapAfterMajorGc.at is a timestamp (got ${gc.at})`);
    }
  } finally {
    gcServer.child.kill();
  }
}

// ── withResponseGuard through toNodeHandler ───────────────────────
console.log("withResponseGuard");
{
  const TIMEOUT_MS = 100;
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);

  /** Serve a real handler with one tool that waits until released, recording its abort signal. */
  const serveHanging = async () => {
    const state = { signal: null, release: null, errors: [], rejections: [] };
    const factory = () => {
      const s = new McpServer({ name: "guard-test", version: "0" });
      s.registerTool("hang", { inputSchema: z.object({}) }, async (_args, ctx) => {
        state.signal = ctx.mcpReq.signal;
        await new Promise((r) => { state.release = r; });
        return { content: [{ type: "text", text: "late" }] };
      });
      return s;
    };
    const handle = withResponseGuard(
      toNodeHandler(withResponseFraming(createMcpHandler(factory, { onerror: (e) => state.errors.push(e.message) })), { onerror: (e) => state.errors.push(e.message) }),
      TIMEOUT_MS
    );
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        handle(req, res, JSON.parse(Buffer.concat(chunks).toString())).catch((e) => { state.rejections.push(e.message); res.destroy(); });
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    state.url = `http://127.0.0.1:${server.address().port}/mcp`;
    state.close = () => { server.closeAllConnections(); server.close(); };
    return state;
  };
  const callHang = (id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "hang", arguments: {} } });

  {
    const s = await serveHanging();
    try {
      const r = await raw(s.url, {
        headers: { ...modernHeaders("tools/call"), "mcp-name": "hang" },
        body: JSON.stringify({ ...callHang(7), params: { ...callHang(7).params, _meta: MODERN_META } }),
      });
      eq(r.status, 504, "a stuck 2026-07-28 call is answered 504");
      const err = JSON.parse(r.text);
      eq(err.error?.message, "Request timeout", "the 504 names the timeout");
      eq(err.error?.code, -32000, "the 504 is a JSON-RPC error");
      eq(err.id, 7, "the 504 carries the request's id");
      eq(Number(r.headers["content-length"]), r.wire.length, "the 504 is framed");
      await sleep(50);
      eq(s.signal?.aborted, true, "the stuck tool's signal is aborted");
      s.release();
      await sleep(TIMEOUT_MS);
      eq(s.rejections.join(), "", "a late result doesn't throw out of the guard");
      eq(s.errors.join(), "", "and neither the handler nor the adapter reports an error");
      eq(unhandled.length, 0, "and nothing goes unhandled");
    } finally { s.close(); }
  }
  {
    const s = await serveHanging();
    try {
      const outcome = await Promise.race([
        raw(s.url, { headers: legacyJson, body: JSON.stringify(callHang(8)) }).then((r) => `answered ${r.status}`, (e) => e.code),
        sleep(TIMEOUT_MS * 20).then(() => "still open"),
      ]);
      eq(outcome, "ECONNRESET", "a stuck 2025-era SSE call, headers already sent, is cut at the deadline");
      await sleep(50);
      eq(s.signal?.aborted, true, "its tool's signal is aborted");
      s.release();
      await sleep(TIMEOUT_MS);
      eq(s.rejections.join(), "", "its late result doesn't throw out of the guard");
      eq(s.errors.join(), "", "and neither the handler nor the adapter reports an error");
    } finally { s.close(); }
  }

  /** Serve one stubbed fetch through the guard; the adapter's errors are collected. */
  const serveStub = async (fetchStub) => {
    const adapterErrors = [];
    const handle = withResponseGuard(toNodeHandler(withResponseFraming({ fetch: fetchStub }), {
      onerror: (e) => adapterErrors.push(e.message),
    }), TIMEOUT_MS);
    const rejections = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        handle(req, res, JSON.parse(Buffer.concat(chunks).toString() || "{}")).catch((e) => { rejections.push(e.message); res.destroy(); });
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${server.address().port}/mcp`, adapterErrors, rejections, close: () => { server.closeAllConnections(); server.close(); } };
  };
  const post = (u, body = "{}") => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body });

  {
    let cancelled = false;
    const late = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(": keepalive\n\n")); },
      cancel() { cancelled = true; },
    });
    const s = await serveStub(async () => {
      await sleep(TIMEOUT_MS * 3);
      return new Response(late, { headers: { "content-type": "text/event-stream" } });
    });
    try {
      eq((await post(s.url)).status, 504, "a call whose SSE body arrives late is answered 504");
      await sleep(TIMEOUT_MS * 4);
      check(cancelled, "the late body is cancelled");
      eq(s.rejections.join(), "", "the guard absorbs the adapter's ERR_HTTP_HEADERS_SENT");
    } finally { s.close(); }
  }
  {
    const s = await serveStub(async () => { await sleep(TIMEOUT_MS * 2); throw new Error("late failure"); });
    try {
      eq((await post(s.url)).status, 504, "a call that fails late is answered 504");
      await sleep(TIMEOUT_MS * 3);
      eq(unhandled.length, 0, "its late rejection stays handled");
      eq(s.rejections.join(), "", "and doesn't throw out of the guard");
    } finally { s.close(); }
  }
  {
    const s = await serveStub(async () => new Response(new ReadableStream({
      async start(c) {
        c.enqueue(new TextEncoder().encode("first,"));
        await sleep(TIMEOUT_MS * 3);
        c.enqueue(new TextEncoder().encode("last"));
        c.close();
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    try {
      const r = await post(s.url, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "subscriptions/listen", params: {} }));
      eq(r.status, 200, "a listen stream keeps its status");
      eq(await r.text(), "first,last", "a listen stream runs past the deadline");
    } finally { s.close(); }
  }
  {
    const s = await serveStub(async () => new Response("ok", { status: 201, headers: { "x-test": "1" } }));
    try {
      const r = await post(s.url);
      eq(r.status, 201, "a timely response keeps its status");
      eq(r.headers.get("x-test"), "1", "and its headers");
      eq(await r.text(), "ok", "and its body");
      await sleep(TIMEOUT_MS * 2);
      eq(s.rejections.join(), "", "and the timer is cleared once it's done");
    } finally { s.close(); }
  }
  {
    const s = await serveStub(async () => { throw new Error("boom"); });
    try {
      const r = await post(s.url);
      eq(r.status, 500, "a handler throw becomes the adapter's 500, not the 504");
      eq((await r.json()).error?.message, "Internal server error", "the 500 is the adapter's JSON-RPC error");
      eq(s.adapterErrors.join(), "boom", "the adapter's onerror sees the cause");
    } finally { s.close(); }
  }
  {
    // A stub, not toNodeHandler: only an adapter that itself rejects reaches the guard's catch.
    const failing = (delay) => withResponseGuard(async () => {
      await sleep(delay);
      throw new Error("adapter failed");
    }, TIMEOUT_MS)({}, new http.ServerResponse({ method: "POST" }), {});
    const outcome = (p) => p.then(() => "swallowed", (e) => e.message);
    eq(await outcome(failing(0)), "adapter failed", "an adapter failure before the deadline reaches the caller");
    eq(await outcome(failing(TIMEOUT_MS * 2)), "adapter failed", "and so does one after it");
  }

  // Large enough to outlast the socket buffers, so the client's pace decides when it finishes.
  {
    const DEADLINE = 1500;
    const payload = randomBytes(15 * 1024 * 1024).toString("base64");
    const large = (contentType) => async () => new Response(payload, { headers: { "content-type": contentType } });
    const stuckStream = async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(": keepalive\n\n")); },
    }), { headers: { "content-type": "text/event-stream" } });

    /** Serve one response through the guard and record when the server closes it. */
    const serveTimed = async (fetchStub, compress) => {
      const handle = withResponseGuard(toNodeHandler(withResponseFraming({ fetch: fetchStub })), DEADLINE);
      const state = { closedAfter: null };
      const server = http.createServer((req, res) => {
        const start = Date.now();
        res.once("close", () => { state.closedAfter = Date.now() - start; });
        const run = () => handle(req, res, {}).catch(() => res.destroy());
        if (compress) compression()(req, res, run);
        else run();
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      state.url = `http://127.0.0.1:${server.address().port}/mcp`;
      state.close = () => { server.closeAllConnections(); server.close(); };
      return state;
    };
    /** Start reading only after `readAfter`; with none, never read at all. */
    const download = (url, readAfter) => new Promise((resolve) => {
      const req = http.request(url, { method: "POST", headers: { "accept-encoding": "gzip", "content-length": 0 } }, (res) => {
        if (readAfter === undefined) return;
        setTimeout(() => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("error", () => resolve("cut"));
          res.on("end", () => {
            const wire = Buffer.concat(chunks);
            resolve(res.headers["content-encoding"] === "gzip" ? zlib.gunzipSync(wire).toString() : wire.toString());
          });
        }, readAfter);
      });
      req.on("error", () => resolve("cut"));
      req.end();
    });

    const servers = await Promise.all([
      serveTimed(large("application/json")),
      serveTimed(large("text/event-stream")),
      serveTimed(large("application/json"), true),
      serveTimed(large("application/json")),
      serveTimed(stuckStream),
    ]);
    const [json, sse, gzipped, stalled, stuck] = servers;
    try {
      const reads = Promise.all([json, sse, gzipped].map((s) => download(s.url, DEADLINE * 1.2)));
      download(stalled.url);
      download(stuck.url, 0);
      const [jsonBody, sseBody, gzipBody] = await reads;
      check(jsonBody === payload, "a JSON result still downloading at the deadline arrives whole");
      check(sseBody === payload, "so does an SSE result");
      check(gzipBody === payload, "and a compressed one");
      await sleep(DEADLINE * 1.2);
      check(stuck.closedAfter !== null && stuck.closedAfter < DEADLINE * 1.5, "a stuck stream is still cut at the first deadline, keep-alives or not");
      check(stalled.closedAfter !== null && stalled.closedAfter >= DEADLINE * 1.5 && stalled.closedAfter < DEADLINE * 3, "a client that never reads is cut after one more deadline");
    } finally { servers.forEach((s) => s.close()); }
  }

  {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const framing = withResponseFraming({
      fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    });
    await framing.fetch(new Request("http://x/mcp", { method: "POST", signal: controller.signal }));
    controller.abort();
    await sleep(0);
    check(cancelled, "a body returned just before the abort is cancelled by it");
  }

  check(new OaiPmhClient().http.defaults.timeout < 30_000, "the OAI timeout fires before the 30 s response guard, so its own error reaches the caller");

  {
    const DEADLINE = 300;
    process.env.VOCAB_DB_PATH = buildFixture("fixture-http-transport.db");
    const vocabDb = new VocabularyDb();
    const answers = (url) => {
      if (url.endsWith("/info.json")) return { width: 100, height: 80 };
      if (url.endsWith("/collection/search")) return { artObjects: [{ objectNumber: "FX-1", objectNodeId: "node-1" }] };
      return null;
    };
    const scenarios = [
      { tool: "get_recent_changes", args: { from: "2026-01-01" }, hangOn: "oai" },
      { tool: "get_artwork_image", args: { objectNumber: "FX-1" }, hangOn: "/info.json" },
      { tool: "inspect_artwork_image", args: { objectNumber: "FX-1" }, hangOn: ".jpg" },
      { tool: "find_similar", args: { objectNumber: "FX-1" }, hangOn: "/collection/search" },
      { tool: "find_similar", args: { objectNumber: "FX-1" }, hangOn: "/collection/visualsearch" },
    ];
    const originalAdapter = axios.defaults.adapter;
    const originalConsoleError = console.error;
    const logged = [];
    console.error = (line) => logged.push(String(line));
    try {
      for (const [i, { tool, args, hangOn }] of scenarios.entries()) {
        let hung = null;
        axios.defaults.adapter = (config) => {
          const url = `${config.baseURL ?? ""}${config.url}`;
          const answer = answers(url);
          if (!url.includes(hangOn) && answer) return Promise.resolve({ data: answer, status: 200, statusText: "OK", headers: {}, config });
          hung = config;
          return new Promise((_, reject) => {
            config.signal?.addEventListener("abort", () => reject(new axios.CanceledError()), { once: true });
          });
        };
        const oai = new OaiPmhClient();
        const api = new RijksmuseumApiClient();
        const withLogging = createLogger();
        const factory = () => {
          const s = new McpServer({ name: "abort-test", version: "0" });
          registerProvenanceTools(s, oai, vocabDb, undefined, withLogging);
          registerViewerTools(s, api, vocabDb, undefined, withLogging);
          registerSimilarTools(s, vocabDb, null, "http://127.0.0.1", withLogging);
          return s;
        };
        const handle = withResponseGuard(toNodeHandler(withResponseFraming(createMcpHandler(factory))), DEADLINE);
        const rejections = [];
        const server = http.createServer((req, res) => {
          const chunks = [];
          req.on("data", (c) => chunks.push(c));
          req.on("end", () => {
            handle(req, res, JSON.parse(Buffer.concat(chunks).toString())).catch((e) => { rejections.push(e.message); res.destroy(); });
          });
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        try {
          const label = `${tool} (${hangOn})`;
          logged.length = 0;
          const r = await raw(`http://127.0.0.1:${server.address().port}/mcp`, {
            headers: { ...modernHeaders("tools/call"), "mcp-name": tool },
            body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: tool, arguments: args, _meta: MODERN_META } }),
          });
          eq(r.status, 504, `${label}: a hung upstream call hits the deadline`);
          await sleep(100);
          check(hung?.signal?.aborted === true, `${label}: the deadline aborts the upstream call`);
          eq(logged.filter((l) => l.includes('"level":"error"')).join("\n").slice(0, 200), "", `${label}: an aborted call isn't logged as a server error`);
          eq(rejections.join(), "", `${label}: and nothing throws out of the guard`);
        } finally { server.closeAllConnections(); server.close(); }
      }
    } finally {
      console.error = originalConsoleError;
      axios.defaults.adapter = originalAdapter;
    }
  }

  process.off("unhandledRejection", onUnhandled);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
