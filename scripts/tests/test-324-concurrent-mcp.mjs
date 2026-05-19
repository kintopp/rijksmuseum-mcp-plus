#!/usr/bin/env node
// Reproduction probe for issue #324:
//   HTTP /mcp: 'Already connected to a transport' errors under concurrent requests
//
// Fires N concurrent POST /mcp requests and reports status codes + any 500s.
// Buggy build (pre 3b26a44): expected ~10-15% 500s with "Already connected".
// Fixed build (3b26a44+):    expected 0 errors.

const URL = process.env.MCP_URL || "https://rijksmuseum-mcp-plus-production.up.railway.app/mcp";
const N = Number(process.env.N || 24);
const ROUNDS = Number(process.env.ROUNDS || 3);

async function fire(id) {
  const t0 = Date.now();
  try {
    const r = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" }),
    });
    const text = await r.text();
    const ok = r.status === 200 && !text.includes("Already connected");
    return { id, status: r.status, ms: Date.now() - t0, ok, body: ok ? "" : text.slice(0, 240) };
  } catch (err) {
    return { id, status: 0, ms: Date.now() - t0, ok: false, body: `fetch error: ${err.message}` };
  }
}

let total = 0, errors = 0;
for (let round = 1; round <= ROUNDS; round++) {
  const promises = [];
  for (let i = 0; i < N; i++) promises.push(fire(round * 1000 + i));
  const results = await Promise.all(promises);

  const okCount = results.filter((r) => r.ok).length;
  const failCount = N - okCount;
  total += N;
  errors += failCount;

  console.log(`Round ${round}: ${okCount}/${N} ok, ${failCount} failed`);
  for (const r of results) {
    if (!r.ok) console.log(`  id=${r.id} status=${r.status} ms=${r.ms} body=${r.body}`);
  }
}

console.log(`\nTotal: ${total - errors}/${total} ok (${errors} failures, ${(100 * errors / total).toFixed(1)}%)`);
process.exit(errors > 0 ? 1 : 0);
