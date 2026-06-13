/**
 * Pre-pass for #383 Proposal 2: materialize boilerplate-stripped inscription text
 * for embedding generation.
 *
 * Runs the real TS inscription parser (formatInscriptionsForEmbedding) over every
 * inscription-bearing artwork in the vocab DB and writes the cleaned text to a
 * sidecar SQLite DB. The Modal generator (generate-vocabulary-embeddings-modal.py)
 * reads this sidecar locally in Phase 1 and substitutes the cleaned text for the
 * raw inscription_text, so the embeddings drop collector-mark / placeholder noise.
 *
 * Single source of truth: the strip logic lives only in src/inscriptions.ts; this
 * pre-pass materializes its output so the Python generator never re-ports the parser.
 *
 * Usage:
 *   npm run build            # required — imports from dist/
 *   node scripts/build-inscription-embed-text.mjs [--vocab PATH] [--out PATH] [--limit N]
 */

import Database from "better-sqlite3";
import { formatInscriptionsForEmbedding } from "../dist/inscriptions.js";

// ─── CLI args ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
const argVal = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};

const vocabPath = argVal("--vocab", "data/vocabulary.db");
const outPath = argVal("--out", "data/inscription-embed-text.db");
const limit = parseInt(argVal("--limit", "0"), 10);

console.log("Inscription embed-text pre-pass (#383 Proposal 2)");
console.log(`  Vocab DB:   ${vocabPath}`);
console.log(`  Sidecar:    ${outPath}`);
console.log(`  Limit:      ${limit || "none"}`);
console.log();

// ─── Read vocab DB ──────────────────────────────────────────────────

const vocab = new Database(vocabPath, { readonly: true });
const vocabBuiltAt =
  vocab.prepare("SELECT value FROM version_info WHERE key = 'built_at'").get()?.value ?? "unknown";

const sql =
  "SELECT art_id, inscription_text FROM artworks WHERE COALESCE(inscription_text, '') != ''" +
  (limit > 0 ? ` LIMIT ${limit}` : "");
const rows = vocab.prepare(sql).all();
vocab.close();
console.log(`  ${rows.length.toLocaleString()} inscription-bearing artworks`);

// ─── Write sidecar ──────────────────────────────────────────────────

const out = new Database(outPath);
out.pragma("journal_mode = WAL");
out.exec(`
  DROP TABLE IF EXISTS inscription_embed_text;
  CREATE TABLE inscription_embed_text (
    art_id     INTEGER PRIMARY KEY,
    embed_text TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS version_info (key TEXT PRIMARY KEY, value TEXT);
`);

const insert = out.prepare("INSERT INTO inscription_embed_text (art_id, embed_text) VALUES (?, ?)");

let strippedToEmpty = 0;
let changed = 0;
const tx = out.transaction((batch) => {
  for (const r of batch) {
    const cleaned = formatInscriptionsForEmbedding(r.inscription_text);
    if (cleaned === "") strippedToEmpty++;
    else if (cleaned !== r.inscription_text) changed++;
    insert.run(r.art_id, cleaned);
  }
});
tx(rows);

out.prepare("INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)").run(
  "built_from_vocab_built_at",
  vocabBuiltAt,
);
out.prepare("INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)").run(
  "source_artwork_count",
  String(rows.length),
);

out.exec("VACUUM");
out.close();

// ─── Report ─────────────────────────────────────────────────────────

const unchanged = rows.length - strippedToEmpty - changed;
const pct = (n) => `${((n / Math.max(rows.length, 1)) * 100).toFixed(1)}%`;
console.log();
console.log(`  Stripped to empty (pure boilerplate): ${strippedToEmpty.toLocaleString()} (${pct(strippedToEmpty)})`);
console.log(`  Changed (partial strip):              ${changed.toLocaleString()} (${pct(changed)})`);
console.log(`  Unchanged (no boilerplate):           ${unchanged.toLocaleString()} (${pct(unchanged)})`);
console.log();
console.log(`  Vocab built_at: ${vocabBuiltAt}`);
console.log(`Done → ${outPath}`);
