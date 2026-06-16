/**
 * Plan 029: search_provenance auto-downgrades a non-compact events result to
 * compact when the full structuredContent would breach the host size ceiling.
 *
 * Standalone (NOT a runner gate — needs a built dist/ + local data/*.db).
 * Run: node scripts/tests/test-provenance-size-guard.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SAFE_RESULT_BUDGET = 120_000; // mirrors responseShape.ts
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, MCP_SKIP_STARTUP_WARM: "1", STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "size-guard-test", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`); if (!cond) failed++; };
const call = (args) => client.callTool({ name: "search_provenance", arguments: args }, undefined, { timeout: 180_000 });
const textOf = (r) => (r.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");

// 1. Non-compact at the documented breach point → auto-downgrade
{
  const r = await call({ location: "Amsterdam", maxResults: 50 });
  const sc = r.structuredContent;
  const total = JSON.stringify(r).length;
  console.log(`\n[1] maxResults:50 compact:false → total=${total.toLocaleString()} chars`);
  ok(total <= SAFE_RESULT_BUDGET, `whole result ≤ SAFE_RESULT_BUDGET (got ${total.toLocaleString()})`);
  ok(sc?.autoCompacted === true, "structuredContent.autoCompacted === true");
  ok(Array.isArray(sc?.warnings) && sc.warnings.some(w => /compact summaries/.test(w)), "warnings[] has a 'compact summaries' note");
  ok(/compact summaries/.test(textOf(r)), "warning is mirrored into the text channel");
  ok(sc?.results?.[0]?.summary != null && sc?.results?.[0]?.matchedEvents != null, "results[0] has compact shape (summary + matchedEvents)");
  ok(sc?.results?.[0]?.events === undefined, "results[0] has NO full events array (downgraded)");
}

// 2. Non-compact, small page → no downgrade, full shape
{
  const r = await call({ location: "Amsterdam", maxResults: 10 });
  const sc = r.structuredContent;
  const total = JSON.stringify(r).length;
  console.log(`\n[2] maxResults:10 compact:false → total=${total.toLocaleString()} chars`);
  ok(sc?.autoCompacted === undefined, "autoCompacted absent (under threshold)");
  ok(Array.isArray(sc?.results?.[0]?.events), "results[0] has full events array (not downgraded)");
}

// 3. Explicit compact → no *downgrade* signal (user asked for it)
{
  const r = await call({ location: "Amsterdam", maxResults: 50, compact: true });
  const sc = r.structuredContent;
  console.log(`\n[3] maxResults:50 compact:true`);
  ok(sc?.autoCompacted === undefined, "autoCompacted absent (compact was requested, not forced)");
  ok(sc?.results?.[0]?.summary != null, "results[0] has compact shape");
}

await client.close();
console.log(`\n${failed === 0 ? "All size-guard tests passed ✓" : `${failed} assertion(s) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
