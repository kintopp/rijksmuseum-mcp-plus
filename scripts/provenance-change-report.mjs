/**
 * provenance-change-report.mjs
 *
 * Read-only diff between the current harvest's provenance_text_hash values
 * and the hashes as of the last parse (stored in provenance_parse_state by
 * batch-parse-provenance.mjs). Classifies each provenance artwork as
 * unchanged / modified / new / removed and cross-references the
 * provenance_enrichments store to flag re-enrichment candidates.
 *
 * Usage:
 *   node scripts/provenance-change-report.mjs [--db <path>] [--baseline <path>] [--out <csv>]
 *
 *   --db <path>        Target DB (default: data/vocabulary.db)
 *   --baseline <path>  Diff against another DB's artworks.provenance_text_hash
 *                      instead of the in-DB provenance_parse_state table.
 *                      Use this for the first run (before any stamp exists) or
 *                      for an ad-hoc DB-vs-DB comparison.
 *   --out <csv>        Write the full work-list (modified + new + removed) to a CSV.
 *
 * Output:
 *   Human-readable summary + one machine line:
 *     CHANGEREPORT {"unchanged":N,"modified":N,"new":N,"removed":N,...}
 *   Exit 0 always.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// ─── Pure diff function (exported for tests) ──────────────────────────────────

/**
 * Compute the four change-detection sets and cross-reference with the store.
 *
 * @param {object} params
 * @param {Database} params.db       - The primary DB (current harvest).
 * @param {Map<string,string|null>} params.currentMap  - object_number → provenance_text_hash
 * @param {Map<string,string|null>} params.baselineMap - object_number → hash (from parse-state or baseline DB)
 * @returns {{
 *   unchanged: string[],
 *   modified: string[],
 *   added: string[],
 *   removed: string[],
 *   withEnrichment: Set<string>,
 *   modifiedWithEnrichment: number,
 *   addedWithEnrichment: number,
 *   removedWithEnrichment: number,
 * }}
 */
export function computeDiff({ db, currentMap, baselineMap }) {
  const unchanged = [];
  const modified = [];
  const added = [];
  const removed = [];

  // Artworks in current harvest
  for (const [objNum, hash] of currentMap) {
    if (!baselineMap.has(objNum)) {
      added.push(objNum);
    } else if (baselineMap.get(objNum) === hash) {
      unchanged.push(objNum);
    } else {
      modified.push(objNum);
    }
  }

  // Artworks in baseline but not in current harvest
  for (const objNum of baselineMap.keys()) {
    if (!currentMap.has(objNum)) {
      removed.push(objNum);
    }
  }

  // Cross-reference the enrichments store
  const withEnrichment = new Set();
  const hasStore = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provenance_enrichments'")
    .get();
  if (hasStore) {
    const storeRows = db
      .prepare("SELECT DISTINCT object_number FROM provenance_enrichments")
      .all();
    for (const row of storeRows) {
      withEnrichment.add(row.object_number);
    }
  }

  // Re-enrichment candidates: changed artworks that carry a store entry.
  const countEnriched = (arr) => arr.reduce((n, o) => n + (withEnrichment.has(o) ? 1 : 0), 0);

  return {
    unchanged,
    modified,
    added,
    removed,
    withEnrichment,
    modifiedWithEnrichment: countEnriched(modified),
    addedWithEnrichment: countEnriched(added),
    removedWithEnrichment: countEnriched(removed),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ARTWORK_HASH_SQL =
  "SELECT object_number, provenance_text_hash FROM artworks WHERE provenance_text IS NOT NULL";

/** Load object_number → provenance_text_hash from a DB into a Map. */
function loadHashMap(db, sql) {
  return new Map(db.prepare(sql).all().map((r) => [r.object_number, r.provenance_text_hash]));
}

// ─── isMain guard ─────────────────────────────────────────────────────────────

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const dbIdx = args.indexOf("--db");
  const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : "data/vocabulary.db";
  const baselineIdx = args.indexOf("--baseline");
  const baselinePath = baselineIdx >= 0 ? args[baselineIdx + 1] : null;
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;

  let db = null;
  let baselineDb = null;
  try {
    db = new Database(dbPath, { readonly: true });

    // Build current map: object_number → provenance_text_hash from artworks
    const currentMap = loadHashMap(db, ARTWORK_HASH_SQL);

    // Build baseline map
    let baselineMap;
    if (baselinePath) {
      baselineDb = new Database(baselinePath, { readonly: true });
      baselineMap = loadHashMap(baselineDb, ARTWORK_HASH_SQL);
    } else {
      // Use in-DB provenance_parse_state
      const stateExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provenance_parse_state'")
        .get();
      if (!stateExists) {
        console.log(
          "No parse-state baseline found in this DB.\n" +
          "Run `node scripts/batch-parse-provenance.mjs` first to stamp a baseline,\n" +
          "or pass --baseline <path> to compare against another DB's artworks table."
        );
        process.exit(0);
      }
      baselineMap = loadHashMap(
        db,
        "SELECT object_number, provenance_text_hash FROM provenance_parse_state"
      );
    }

    const {
      unchanged,
      modified,
      added,
      removed,
      withEnrichment,
      modifiedWithEnrichment,
      addedWithEnrichment,
      removedWithEnrichment,
    } = computeDiff({ db, currentMap, baselineMap });

    // Human summary
    console.log("\nProvenance change report");
    console.log("═".repeat(50));
    console.log(`  Baseline:  ${baselinePath ? baselinePath : "provenance_parse_state (in-DB)"}`);
    console.log(`  Current:   ${dbPath}`);
    console.log("");
    console.log(`  Unchanged: ${unchanged.length.toLocaleString()}`);
    console.log(`  Modified:  ${modified.length.toLocaleString()}  (${modifiedWithEnrichment} carry enrichments → re-enrichment candidates)`);
    console.log(`  New:       ${added.length.toLocaleString()}  (${addedWithEnrichment} carry enrichments)`);
    console.log(`  Removed:   ${removed.length.toLocaleString()}  (${removedWithEnrichment} carry enrichments)`);
    console.log("");
    if (modified.length + added.length + removed.length === 0) {
      console.log("  No changes detected — re-enrichment surface is zero.");
    } else {
      console.log(`  Re-enrichment surface: ${(modifiedWithEnrichment + addedWithEnrichment).toLocaleString()} artworks`);
      console.log("  (modified ∩ store + new ∩ store — these need a fresh LLM pass)");
      if (removed.length > 0) {
        console.log(`  Note: ${removed.length} removed artworks with ${removedWithEnrichment} store entries (store entries become orphaned)`);
      }
    }

    // Optional CSV work-list
    if (outPath) {
      const lines = ["object_number,change_type,has_enrichment"];
      for (const [arr, type] of [[modified, "modified"], [added, "new"], [removed, "removed"]]) {
        for (const o of arr) lines.push(`${o},${type},${withEnrichment.has(o) ? 1 : 0}`);
      }
      fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf-8");
      console.log(`\n  Work-list written to: ${outPath}`);
    }

    // Machine-readable summary line. Cap inline lists; full work-list goes to --out.
    const MAX_INLINE = 200;
    const sample = (arr) => arr.slice(0, MAX_INLINE);
    const report = {
      unchanged: unchanged.length,
      modified: modified.length,
      modified_with_enrichment: modifiedWithEnrichment,
      added: added.length,
      added_with_enrichment: addedWithEnrichment,
      removed: removed.length,
      removed_with_enrichment: removedWithEnrichment,
      reenrichment_surface: modifiedWithEnrichment + addedWithEnrichment,
      baseline: baselinePath ?? "provenance_parse_state",
      modified_sample: sample(modified),
      added_sample: sample(added),
      removed_sample: sample(removed),
    };
    console.log(`CHANGEREPORT ${JSON.stringify(report)}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  } finally {
    db?.close();
    baselineDb?.close();
  }
}
