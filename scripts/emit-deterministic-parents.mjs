/**
 * emit-deterministic-parents.mjs
 *
 * Read-only "parent-text oracle" for the content-addressed enrichment store
 * (plan 015, Phase 2 / Step 2.1).
 *
 * The current DB holds split CHILDREN, not the deterministic PARENT events the
 * structural audits were generated against. To content-address a structural op
 * on its parent's raw_text, this script reconstructs the parent events with a
 * clean deterministic parse of the unchanged source text — it runs the parser
 * over artworks.provenance_text and emits (object_number, sequence, raw_text)
 * for every parsed event. It writes NOTHING to the DB.
 *
 * Run it with the dist/ built from the grammar version the audits were generated
 * against (pre-#390 for the current data/vocabulary.db). If dist/ carries #390,
 * the #390-affected artworks surface as `unmatched` on re-apply (acceptable —
 * they get re-generated).
 *
 * Usage:
 *   node scripts/emit-deterministic-parents.mjs [--db PATH] [--limit N]
 *     → prints JSONL to stdout, one {object_number, sequence, raw_text} per line.
 *
 * Or import { buildOracle } from this module to get the parsed map in-process
 * (the structural extractor uses this path — no shelling out).
 */

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProvenanceRaw } from "../dist/provenance-peg.js";
import { buildDupOrdinals } from "./lib/raw-text-hash.mjs";

/**
 * Parse every artwork's provenance_text with the deterministic parser and build
 * a parent-text oracle, reading the DB read-only.
 *
 * @param {import("better-sqlite3").Database} db  opened read-only
 * @param {{ limit?: number }} [opts]
 * @returns {{
 *   byObjSeq: Map<string, string>,            // `${object_number}|${sequence}` → raw_text
 *   groupsByObj: Map<string, Map<string, number[]>>,  // object_number → buildDupOrdinals(events)
 * }}
 */
export function buildOracle(db, { limit = 0 } = {}) {
  // Match the parser's own guard (batch-parse-provenance.mjs:182-183): never feed
  // empty strings to the parser — they would pollute the oracle.
  const baseSql =
    "SELECT art_id, object_number, provenance_text FROM artworks " +
    "WHERE provenance_text IS NOT NULL AND provenance_text != ''";
  const sql = limit ? `${baseSql} LIMIT ?` : baseSql;
  const rows = limit ? db.prepare(sql).all(limit) : db.prepare(sql).all();

  const byObjSeq = new Map();
  const groupsByObj = new Map();

  for (const row of rows) {
    const objectNumber = row.object_number;
    const result = parseProvenanceRaw(row.provenance_text);
    const events = [];
    for (const e of result.events) {
      // Skip empty raw_text — buildDupOrdinals would throw, and an empty parent
      // cannot be content-addressed (the structural extractor reports it as a miss).
      if (e.rawText == null || String(e.rawText).trim() === "") continue;
      byObjSeq.set(`${objectNumber}|${e.sequence}`, e.rawText);
      events.push({ sequence: e.sequence, raw_text: e.rawText });
    }
    groupsByObj.set(objectNumber, buildDupOrdinals(events));
  }

  return { byObjSeq, groupsByObj };
}

// ─── isMain guard (CLI: print JSONL) ──────────────────────────────────────────

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const dbIdx = args.indexOf("--db");
  const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : "data/vocabulary.db";
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 0;

  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    const { byObjSeq } = buildOracle(db, { limit });
    for (const [key, rawText] of byObjSeq) {
      const sepIdx = key.lastIndexOf("|");
      const object_number = key.slice(0, sepIdx);
      const sequence = parseInt(key.slice(sepIdx + 1), 10);
      process.stdout.write(JSON.stringify({ object_number, sequence, raw_text: rawText }) + "\n");
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  } finally {
    db?.close();
  }
}
