#!/usr/bin/env node
/**
 * test-creator-name-variants.mjs — a `creator` name string resolves through every
 * recorded name variant, and says so when it reaches more than one creator.
 *
 * Failure modes:
 *  1. Label-only matching: a natural-order name for an inverted-label person
 *     ("Hendrick Avercamp" vs label "Avercamp, Hendrick") returns 0 because the
 *     phrase hits a namesake term ("Hendrick Avercamp Prize") that has no works.
 *  2. A spelling variant held only in person_names ("Hendrik Avercamp") misses.
 *  3. The label form itself stops matching once variants are added.
 *  4. A variant shared by two persons merges their works silently (no warning),
 *     or the warning text drifts (model-facing: pinned in full).
 *  5. A name reaching exactly one creator emits a spurious ambiguity warning.
 *  6. An unrecognised name returns 0 with no recovery hint.
 *  7. The three resolution sites disagree: collection_stats, and the same-row
 *     intercept (productionRole + sameRowMatching), must resolve variants and carry
 *     the warning too — once, not duplicated, including when the qualifier
 *     intercept falls through to the default loop after resolving the creator.
 *  8. collection_stats replaces the creator's no-match hint with its generic line.
 *
 * Untested branch: more than CREATOR_AMBIGUITY_LIST_MAX creators collapses the
 * list to a count; the fixture has no name that broad.
 *
 * Fixture (build-fixture-vocab-db.mjs): Avercamp on FX-2; Bosschaert (I) on FX-7,
 * (II) on FX-4, both carrying the variant "Ambrosius Bosschaert"; all three painter rows;
 * an unmapped "Hendrick Avercamp Prize" term, which must not count as a second creator.
 */
import { connectFixtureClient } from "./fixture-client.mjs";

const client = await connectFixtureClient("creator-name-variants");

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

async function search(args) {
  const r = await call("search_artwork", args);
  return { objs: (r.results ?? []).map(x => x.objectNumber).sort(), warnings: r.warnings ?? [] };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const BOSSCHAERT_WARNING =
  'creator:"Ambrosius Bosschaert" matched 2 different creators; results combine their works: ' +
  "Bosschaert, Ambrosius (I) (1573–1621; vocabId v-bosschaert-i; 1 work), " +
  "Bosschaert, Ambrosius (II) (1609–1645; vocabId v-bosschaert-ii; 1 work). " +
  "To restrict to one, pass its vocabId from search_persons as creator.";

try {
  console.log("1–3. One person, three name forms");
  for (const name of ["Hendrick Avercamp", "Hendrik Avercamp", "Avercamp, Hendrick"]) {
    const r = await search({ creator: name });
    check(`"${name}" → FX-2`, same(r.objs, ["FX-2"]), `got ${r.objs}`);
    check(`"${name}" → no warning`, r.warnings.length === 0, `got ${JSON.stringify(r.warnings)}`);
  }

  console.log("\n4. Shared variant names both creators");
  const shared = await search({ creator: "Ambrosius Bosschaert" });
  check("→ FX-4, FX-7", same(shared.objs, ["FX-4", "FX-7"]), `got ${shared.objs}`);
  check("ambiguity warning, exact text", same(shared.warnings, [BOSSCHAERT_WARNING]), `got ${JSON.stringify(shared.warnings)}`);
  const pinned = await search({ creator: "Ambrosius Bosschaert de Jonge" });
  check("a variant unique to one person → that person only, no warning",
    same(pinned.objs, ["FX-4"]) && pinned.warnings.length === 0, `got ${pinned.objs} ${JSON.stringify(pinned.warnings)}`);

  console.log("\n5. Single-creator name with label and variant hits on the same id");
  const rembrandt = await search({ creator: "Rembrandt van Rijn" });
  check("Rembrandt → FX-1, FX-6, no warning",
    same(rembrandt.objs, ["FX-1", "FX-6"]) && rembrandt.warnings.length === 0, `got ${rembrandt.objs} ${JSON.stringify(rembrandt.warnings)}`);

  console.log("\n6. Unrecognised name");
  const none = await search({ creator: "Hendrikus Avercampius" });
  check("→ 0 results", none.objs.length === 0, `got ${none.objs}`);
  check("recovery hint, exact text", same(none.warnings, [
    'creator:"Hendrikus Avercampius" matched no artist or organisation name. Check the spelling, or look for candidates with search_persons.',
  ]), `got ${JSON.stringify(none.warnings)}`);

  console.log("\n7a. collection_stats");
  const stats = await call("collection_stats", { dimension: "type", creator: "Hendrick Avercamp" });
  check("natural-order name → total 1", stats.total === 1, `got ${stats.total}`);
  const statsShared = await call("collection_stats", { dimension: "type", creator: "Ambrosius Bosschaert" });
  check("shared variant → total 2", statsShared.total === 2, `got ${statsShared.total}`);
  check("shared variant → same warning", (statsShared.warnings ?? []).includes(BOSSCHAERT_WARNING),
    `got ${JSON.stringify(statsShared.warnings)}`);

  console.log("\n7b. Same-row intercept (productionRole + sameRowMatching)");
  const sameRow = await search({ creator: "Hendrick Avercamp", productionRole: "painter", sameRowMatching: true });
  check("natural-order name → FX-2", same(sameRow.objs, ["FX-2"]), `got ${sameRow.objs}`);
  const sameRowShared = await search({ creator: "Ambrosius Bosschaert", productionRole: "painter", sameRowMatching: true });
  check("shared variant → FX-4, FX-7", same(sameRowShared.objs, ["FX-4", "FX-7"]), `got ${sameRowShared.objs}`);
  check("warning carried exactly once", same(sameRowShared.warnings, [BOSSCHAERT_WARNING]),
    `got ${JSON.stringify(sameRowShared.warnings)}`);
  // A qualifier absent from assignment_pairs makes the intercept fall through to the
  // default loop after it has already resolved the creator.
  const fallThrough = await search({ creator: "Ambrosius Bosschaert", attributionQualifier: "painter" });
  check("qualifier fall-through → warning carried exactly once", same(fallThrough.warnings, [BOSSCHAERT_WARNING]),
    `got ${JSON.stringify(fallThrough.warnings)}`);
  const fallThroughStats = await call("collection_stats", { dimension: "type", creator: "Ambrosius Bosschaert", attributionQualifier: "painter" });
  check("qualifier fall-through (stats) → warning carried exactly once",
    (fallThroughStats.warnings ?? []).filter(w => w === BOSSCHAERT_WARNING).length === 1,
    `got ${JSON.stringify(fallThroughStats.warnings)}`);

  console.log("\n7c. collection_stats zero match keeps the resolver's hint");
  const statsNone = await call("collection_stats", { dimension: "type", creator: "Hendrikus Avercampius" });
  check("→ total 0 with the creator hint, exact text", statsNone.total === 0 && same(statsNone.warnings, [
    'creator:"Hendrikus Avercampius" matched no artist or organisation name. Check the spelling, or look for candidates with search_persons.',
  ]), `got ${statsNone.total} ${JSON.stringify(statsNone.warnings)}`);
} catch (e) {
  console.error(e);
  failed++;
} finally {
  await client.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
