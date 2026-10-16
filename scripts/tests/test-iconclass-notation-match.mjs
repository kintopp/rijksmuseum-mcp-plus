#!/usr/bin/env node
/**
 * test-iconclass-notation-match.mjs — the `iconclass` filter's notation match rule.
 *
 * Failure modes:
 *  1. A base code misses its key-expanded/named forms (`25F23` must match `25F23(+46)`).
 *  2. The match leaks to narrower codes, e.g. a bare prefix `LIKE 'n%'` instead of the
 *     `n(` range (`25F2` must not match `25F23`).
 *  3. An expanded code passed verbatim stops matching itself, or widens to its base.
 *  4. collection_stats and search_artwork disagree on the same filter.
 *
 * Fixture (build-fixture-vocab-db.mjs): 25F23 on FX-1, FX-2, FX-7; 25F23(+46) on FX-3.
 */
import { connectFixtureClient } from "./fixture-client.mjs";

const client = await connectFixtureClient("iconclass-notation-match");

let failed = 0;
function check(label, cond, detail = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${cond || !detail ? "" : `\n     ${detail}`}`);
  if (!cond) failed++;
}

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} ${JSON.stringify(args)}: ${r.content?.[0]?.text}`);
  return r.structuredContent;
}

async function objectNumbers(iconclass) {
  const r = await call("search_artwork", { iconclass });
  return (r.results ?? []).map(x => x.objectNumber).sort();
}

try {
  console.log("1. Base code includes key-expanded forms");
  const base = await objectNumbers("25F23");
  check("25F23 → FX-1, FX-2, FX-3, FX-7", JSON.stringify(base) === JSON.stringify(["FX-1", "FX-2", "FX-3", "FX-7"]), `got ${base}`);

  console.log("\n2. Expanded code matches only itself");
  const expanded = await objectNumbers("25F23(+46)");
  check("25F23(+46) → FX-3", JSON.stringify(expanded) === JSON.stringify(["FX-3"]), `got ${expanded}`);

  console.log("\n3. A shorter code is not a prefix match");
  const partial = await objectNumbers("25F2");
  check("25F2 → nothing (no artwork carries it)", partial.length === 0, `got ${partial}`);

  console.log("\n4. collection_stats agrees with search_artwork");
  const stats = await call("collection_stats", { dimension: "type", iconclass: "25F23" });
  check("collection_stats total for 25F23 = 4", stats.total === 4, `got ${stats.total}`);
} catch (err) {
  console.log(`  ✗ ${err.message}`);
  failed++;
} finally {
  await client.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
