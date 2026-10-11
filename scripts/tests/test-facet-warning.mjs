/**
 * Verifies that requesting a facet on a dimension that is already a filter
 * emits a `warnings` entry naming the dropped facet (#351).
 *
 * Runs on the fixture DB; maxResults: 1 keeps the fixture's small matches above
 * the result page so facets are computed at all.
 * Run:  npm run build  &&  node scripts/tests/test-facet-warning.mjs
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildFixture } from "./build-fixture-vocab-db.mjs";

process.env.VOCAB_DB_PATH = buildFixture("fixture-facet-warning.db");
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { VocabularyDb } = await import(path.join(PROJECT_DIR, "dist/api/VocabularyDb.js"));

const db = new VocabularyDb();
if (!db.available) {
  console.error("vocabulary DB not available");
  process.exit(2);
}

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

console.log("== #351: facet dropped when dimension is already filtered ==");

// Case 1: single dropped facet (creator filter + creator facet)
{
  const r = await db.search({
    creator: "Rembrandt van Rijn",
    facets: ["creator", "type"],
    maxResults: 1,
  });
  const w = r.warnings ?? [];
  check("warning names exactly the dropped creator facet",
    w.includes("Facet omitted because already filtered on the same dimension: creator"), JSON.stringify(w));
  check("type facet still returned", r.facets && Object.keys(r.facets).includes("type"));
  check("creator facet NOT returned", !(r.facets && Object.keys(r.facets).includes("creator")));
}

// Case 2: multiple dropped facets
{
  const r = await db.search({
    creator: "Rembrandt van Rijn",
    type: "painting",
    facets: ["creator", "type", "century"],
    maxResults: 1,
  });
  const w = r.warnings ?? [];
  check("plural warning names both dropped facets, century kept",
    w.includes("Facets omitted because already filtered on the same dimension: creator, type"), JSON.stringify(w));
}

// Case 3: no overlap → no warning
{
  const r = await db.search({
    creator: "Rembrandt van Rijn",
    facets: ["type", "century"],
    maxResults: 1,
  });
  const w = r.warnings ?? [];
  const hit = w.find((s) => /omitted because already filtered/i.test(s));
  check("no warning when no overlap", !hit, JSON.stringify(w));
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
