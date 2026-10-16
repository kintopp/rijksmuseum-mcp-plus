/**
 * #261 fix — delete 14 phantom rowids from vec_artworks.
 *
 * Root cause (see issue): the v0.24 vocab-embeddings Modal script filters
 * empty-source-text artworks in Python *after* fetching all 833,432 rows
 * from SQLite. sqlite-vec's vec0 chunk allocator appears to have allocated
 * gap-filler entries for art_ids within chunks whose contents were later
 * dropped, shadowing neighboring real embeddings. Result: vec_artworks
 * carries 14 phantom rowids that LEFT JOIN vs artwork_embeddings with no
 * match.
 *
 * This script does NOT fix the generator script (that's v0.25 scope per
 * the plan). It surgically cleans the deployed artifact.
 *
 * Usage:
 *   node scripts/delete_phantom_vec0_rowids.mjs --db PATH [--apply]
 *   (default --db data/embeddings.db; dry-run unless --apply passed)
 */
import Database from "better-sqlite3";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sqliteVec = require("sqlite-vec");

const args = process.argv.slice(2);
const dbPath = args.includes("--db") ? args[args.indexOf("--db") + 1] : "data/embeddings.db";
const apply = args.includes("--apply");

console.log(`DB:    ${dbPath}`);
console.log(`Mode:  ${apply ? "APPLY (will DELETE phantoms)" : "dry-run (read-only verify)"}\n`);

const db = new Database(dbPath, apply ? undefined : { readonly: true });
sqliteVec.load(db);

// ─── Pre-check counts ──────────────────────────────────────────────
const regCount = db.prepare("SELECT COUNT(*) AS n FROM artwork_embeddings").get().n;
const vecCount = db.prepare("SELECT COUNT(*) AS n FROM vec_artworks").get().n;
console.log(`Before: artwork_embeddings=${regCount.toLocaleString()}  vec_artworks=${vecCount.toLocaleString()}  diff=${vecCount - regCount}`);

// ─── Identify phantom rowids ───────────────────────────────────────
// Phantoms: vec_artworks.artwork_id with no matching row in artwork_embeddings.
const phantoms = db.prepare(`
  SELECT vec.artwork_id
  FROM vec_artworks vec
  LEFT JOIN artwork_embeddings ae ON ae.art_id = vec.artwork_id
  WHERE ae.art_id IS NULL
  ORDER BY vec.artwork_id
`).all().map(r => r.artwork_id);

console.log(`Phantom artwork_ids: ${phantoms.length}`);
if (phantoms.length === 0) {
  console.log("No phantoms found. Nothing to do.");
  db.close();
  process.exit(0);
}
console.log(`  IDs: ${phantoms.join(", ")}`);

// ─── DELETE (when --apply) ─────────────────────────────────────────
if (apply) {
  const stmt = db.prepare("DELETE FROM vec_artworks WHERE artwork_id = ?");
  let deleted = 0;
  const tx = db.transaction((ids) => {
    for (const id of ids) {
      const r = stmt.run(id);
      deleted += r.changes;
    }
  });
  tx(phantoms);
  console.log(`\nDeleted ${deleted} rowids.`);

  const regAfter = db.prepare("SELECT COUNT(*) AS n FROM artwork_embeddings").get().n;
  const vecAfter = db.prepare("SELECT COUNT(*) AS n FROM vec_artworks").get().n;
  console.log(`After:  artwork_embeddings=${regAfter.toLocaleString()}  vec_artworks=${vecAfter.toLocaleString()}  diff=${vecAfter - regAfter}`);

  if (regAfter === vecAfter && vecAfter === regCount) {
    console.log("\nSUCCESS — counts match and artwork_embeddings is untouched.");
  } else {
    console.error("\nFAIL — counts mismatch after delete.");
    process.exit(1);
  }
} else {
  console.log("\n(dry-run — pass --apply to actually DELETE)");
}

db.close();
