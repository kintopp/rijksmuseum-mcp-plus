/**
 * Verifies that requesting a facet on a dimension that is already a filter
 * emits a `warnings` entry naming the dropped facet (#351).
 *
 * Run:  npm run build  &&  node scripts/tests/test-facet-warning.mjs
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

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
    compact: true,
    maxResults: 5,
  });
  const w = r.warnings ?? [];
  const hit = w.find((s) => /omitted because already filtered/i.test(s) && s.includes("creator"));
  check("warning emitted when filtered dimension is requested as facet", !!hit, JSON.stringify(w));
  check("warning lists 'creator' specifically", hit?.includes("creator") === true);
  check("warning does not list 'type' (still computable)", hit && !hit.includes(" type"));
  check("type facet still returned", r.facets && Object.keys(r.facets).includes("type"));
  check("creator facet NOT returned", !(r.facets && Object.keys(r.facets).includes("creator")));
}

// Case 2: multiple dropped facets
{
  const r = await db.search({
    creator: "Rembrandt van Rijn",
    type: "painting",
    facets: ["creator", "type", "century"],
    compact: true,
    maxResults: 5,
  });
  const w = r.warnings ?? [];
  const hit = w.find((s) => /omitted because already filtered/i.test(s));
  check("multi-drop warning emitted", !!hit, JSON.stringify(w));
  check("multi-drop names creator", hit?.includes("creator") === true);
  check("multi-drop names type", hit?.includes("type") === true);
  check("plural 'Facets' used", hit?.startsWith("Facets ") === true, hit);
}

// Case 3: no overlap → no warning
{
  const r = await db.search({
    creator: "Rembrandt van Rijn",
    facets: ["type", "century"],
    compact: true,
    maxResults: 5,
  });
  const w = r.warnings ?? [];
  const hit = w.find((s) => /omitted because already filtered/i.test(s));
  check("no warning when no overlap", !hit, JSON.stringify(w));
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
