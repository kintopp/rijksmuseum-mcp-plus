#!/usr/bin/env node
// Wake-timing probe — verifies that HTTP mode answers /health + the MCP
// `initialize` handshake BEFORE the background warm-up finishes. This is the
// property that makes Railway scale-to-zero (App Sleeping) viable: a cold wake
// must answer the client's connect handshake within its timeout, not be held
// for the ~13s warm-up.
//
// Spawns `node dist/index.js` in HTTP mode, then from t0 (spawn) measures:
//   - t(/health 200)            — should be small (a few seconds, post-listen)
//   - t(initialize 200)         — handshake works while still warming
//   - t(/ready → "warm")        — background warm-up completion (informational)
//   - t("Background warmup complete") from stderr
//
// PASS criterion: /health and initialize both succeed, and both land well
// before warm-up completion. Re-runnable; needs a built ./dist + local DBs.
//
//   node scripts/tests/test-wake-timing.mjs

import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;

const t0 = Date.now();
const ms = () => Date.now() - t0;

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${pathname}`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("timeout")));
  });
}

function initialize() {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "wake-probe", version: "1.0" },
    },
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${BASE}/mcp`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.write(payload);
    req.end();
  });
}

const sleep = (n) => new Promise((r) => setTimeout(r, n));

async function pollUntil(fn, label, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fn();
      if (r) return r;
    } catch {
      /* not up yet */
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const child = spawn(process.execPath, [path.join(ROOT, "dist", "index.js")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), MCP_ALLOWED_ORIGINS: "*", MCP_SKIP_STARTUP_WARM: "" },
  stdio: ["ignore", "pipe", "pipe"],
});

const marks = {};
let listeningAt = null;
let warmCompleteAt = null;

function watch(stream) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.includes("listening on") && listeningAt === null) listeningAt = ms();
      if (line.includes("Background warmup complete") && warmCompleteAt === null) warmCompleteAt = ms();
      if (line.includes("warmup failed")) warmCompleteAt = ms();
    }
  });
}
watch(child.stdout);
watch(child.stderr);

let exited = false;
child.on("exit", (code) => {
  exited = true;
  if (!marks.done) {
    console.error(`\n✗ server exited early (code ${code}) at ${ms()}ms`);
    process.exit(1);
  }
});

try {
  // 1) First /health 200
  await pollUntil(async () => {
    const r = await get("/health");
    return r.status === 200 ? r : null;
  }, "/health 200");
  marks.health = ms();

  // 2) initialize handshake (should work while still warming)
  const init = await initialize();
  marks.initialize = ms();
  const initOk = init.status === 200 && /serverInfo|"result"/.test(init.body);

  // 3) /ready snapshot right after initialize (expect "warming" if warm not done)
  const readyAtInit = await get("/ready").then((r) => r.body).catch(() => "?");

  // 4) wait for warm (either /ready warm or the stderr log)
  await pollUntil(async () => {
    if (warmCompleteAt !== null) return true;
    const r = await get("/ready");
    return /"status":"warm"/.test(r.body) ? r : null;
  }, "/ready warm", 180000);
  marks.warm = warmCompleteAt ?? ms();
  marks.done = true;

  // The property that makes scale-to-zero viable: the cold-wake handshake
  // (/health + MCP initialize) must complete fast enough to beat the client's
  // connect timeout. The pre-listen warm-up used to hold this ~14-22s locally
  // (~65s on Railway). Budget here is generous; locally expect ~1-3s.
  const WAKE_BUDGET_MS = 8000;
  console.log("\n── Wake-timing results (ms from process spawn) ──");
  console.log(`  listening (stderr):        ${listeningAt ?? "n/a"}`);
  console.log(`  /health 200:               ${marks.health}`);
  console.log(`  initialize 200:            ${marks.initialize}  (ok=${initOk}, http=${init.status})`);
  console.log(`  /ready at initialize time: ${readyAtInit}`);
  console.log(`  warm-up complete:          ${marks.warm}`);
  console.log(`  ── wake-to-handshake:      ${Math.max(marks.health, marks.initialize)}ms (budget ${WAKE_BUDGET_MS}ms)`);

  const pass = initOk && marks.health < WAKE_BUDGET_MS && marks.initialize < WAKE_BUDGET_MS;
  console.log(
    `\n${pass ? "✓ PASS" : "✗ FAIL"} — cold-wake /health + initialize answered in ` +
      `${Math.max(marks.health, marks.initialize)}ms (warm-up finishes at ${marks.warm}ms, off the critical path).`,
  );
  child.kill("SIGTERM");
  await sleep(300);
  if (!exited) child.kill("SIGKILL");
  process.exit(pass ? 0 : 1);
} catch (err) {
  console.error(`\n✗ probe error at ${ms()}ms: ${err.message}`);
  child.kill("SIGKILL");
  process.exit(1);
}
