/**
 * verify-enrichment-store-parity.mjs  (read-only)
 *
 * Independent parity verifier for plan 015 Phase 3.1. Computes the enrichment
 * ground-truth DIRECTLY from the DB (not from the migrate script's own counters)
 * and — if the provenance_enrichments store exists — compares the store's row
 * counts against it. Purpose: confirm the content-addressed store captured exactly
 * what the re-parsed DB holds, AND that the #185/Option-B relabel kept the
 * missing-receiver contamination OUT of the party snapshots.
 *
 * Never writes. Opens the DB normally (SELECT-only) so it works on a WAL DB
 * without a -shm sibling; run it against the throwaway dry-run copy pre-apply and
 * the real DB post-apply.
 *
 * Usage: node scripts/tests/verify-enrichment-store-parity.mjs --db PATH
 */
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const dbIdx = args.indexOf("--db");
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : "data/vocabulary.db";

const db = new Database(dbPath);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);

console.log(`enrichment-store parity  [READ-ONLY]`);
console.log(`  db: ${dbPath}\n`);

// ── DB ground-truth (mirrors runValueExtractor's class predicates) ────────────
const eventType = one(
  `SELECT COUNT(*) c FROM provenance_events WHERE category_method = 'llm_enrichment'`
).c;

// non-structural events (correction_method NULL or not an llm_structural:* tag)
// that carry >=1 party the value extractor would snapshot.
const snapTrigger = one(`
  SELECT COUNT(*) c FROM (
    SELECT e.artwork_id, e.sequence
    FROM provenance_events e
    JOIN provenance_parties p
      ON p.artwork_id = e.artwork_id AND p.sequence = e.sequence
    WHERE (e.correction_method IS NULL OR e.correction_method NOT LIKE 'llm_structural:%')
      AND p.position_method IN ('llm_enrichment', 'llm_disambiguation')
    GROUP BY e.artwork_id, e.sequence
  )
`).c;

// ── relabel / contamination invariants ───────────────────────────────────────
const ruleMissingRecv = one(
  `SELECT COUNT(*) c FROM provenance_parties WHERE position_method = 'rule:missing_receiver'`
).c;
const parseRestLeak = one(
  `SELECT COUNT(*) c FROM provenance_parties WHERE enrichment_reasoning LIKE '%parseRest()%'`
).c;
// would-be contamination: a missing-receiver party STILL tagged llm_enrichment
// (i.e. relabel did NOT take) — these would wrongly enter a snapshot.
const contamInTrigger = one(
  `SELECT COUNT(*) c FROM provenance_parties
   WHERE position_method = 'llm_enrichment' AND enrichment_reasoning LIKE '%parseRest()%'`
).c;

const llmEnrParties = one(
  `SELECT COUNT(*) c FROM provenance_parties WHERE position_method = 'llm_enrichment'`
).c;
const llmDisParties = one(
  `SELECT COUNT(*) c FROM provenance_parties WHERE position_method = 'llm_disambiguation'`
).c;

console.log(`DB ground-truth:`);
console.log(`  event.type candidates (category_method=llm_enrichment):  ${eventType}`);
console.log(`  snapshot-trigger events (value path, distinct evt):       ${snapTrigger}`);
console.log(`  llm_enrichment parties / llm_disambiguation parties:      ${llmEnrParties} / ${llmDisParties}`);
console.log(`  rule:missing_receiver parties (relabelled #185/B):        ${ruleMissingRecv}`);
console.log(`  parseRest() reasoning leak (any position_method):         ${parseRestLeak}`);
console.log(`  >> contamination still tagged llm_enrichment (MUST be 0): ${contamInTrigger}`);

// ── store comparison (only if the table exists) ───────────────────────────────
const hasStore = one(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='provenance_enrichments'`
);
if (!hasStore) {
  console.log(`\n(no provenance_enrichments table — store not yet built; ground-truth only)`);
  db.close();
  process.exit(0);
}

console.log(`\nstore (provenance_enrichments) counts by op_kind/field:`);
const rows = all(
  `SELECT op_kind, field, COUNT(*) c FROM provenance_enrichments GROUP BY 1,2 ORDER BY 1,2`
);
for (const r of rows) console.log(`  ${r.op_kind.padEnd(12)} ${String(r.field).padEnd(22)} ${r.c}`);
const total = one(`SELECT COUNT(*) c FROM provenance_enrichments`).c;
console.log(`  ${"TOTAL".padEnd(35)} ${total}`);

const storeEventType = one(
  `SELECT COUNT(*) c FROM provenance_enrichments WHERE field='event.type'`
).c;
const storeSnapshots = one(
  `SELECT COUNT(*) c FROM provenance_enrichments WHERE field='event.parties'`
).c;

// contamination scan over snapshot payloads. A rule:missing_receiver party MAY
// legitimately ride inside a snapshot when it co-occurs on the same event as a
// genuine llm party (§G stores the event's FULL final party list). That is safe
// at cutover ONLY when its party_position='receiver', because the kept
// writeback-missing-receivers guard (`NOT EXISTS … party_position='receiver'`)
// then skips re-inserting it. A missing-receiver party with ANY OTHER position
// (e.g. the 57 'agent' rows the leak-doc flagged) EVADES that guard → re-apply +
// writeback would DOUBLE-INSERT. So the hazard is guard-evading parties only.
const snapPayloads = all(
  `SELECT object_number, payload FROM provenance_enrichments WHERE field='event.parties'`
);
let guardEvadingSnapshots = 0;   // the real hazard
let benignReceiverSnapshots = 0; // by-design co-occurrence, guard-protected
for (const s of snapPayloads) {
  try {
    const parsed = JSON.parse(s.payload);
    const mr = (parsed.parties || []).filter(
      (p) => p.position_method === "rule:missing_receiver" ||
             (p.enrichment_reasoning && /parseRest\(\)/.test(p.enrichment_reasoning))
    );
    if (!mr.length) continue;
    if (mr.every((p) => p.party_position === "receiver")) benignReceiverSnapshots++;
    else guardEvadingSnapshots++;
  } catch { /* ignore */ }
}

console.log(`\nparity checks:`);
const check = (label, ok, detail) =>
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? " — " + detail : ""}`);

check("event.type store == DB candidates", storeEventType === eventType,
  `store ${storeEventType} vs db ${eventType}`);
check("snapshot store >= value-path triggers (>= because manual-csv adds some)",
  storeSnapshots >= snapTrigger, `store ${storeSnapshots} vs value-triggers ${snapTrigger}`);
check("no GUARD-EVADING missing-receiver party in any snapshot (cutover double-insert hazard)",
  guardEvadingSnapshots === 0,
  `${guardEvadingSnapshots} guard-evading; ${benignReceiverSnapshots} benign receiver-position co-occurrences`);
check("relabel effective in data (parseRest still tagged llm_enrichment == 0)",
  contamInTrigger === 0, `${contamInTrigger} still mislabelled`);

// Structural store self-consistency — the migrate extractor MUST mirror the
// writebacks' gates (writeback-event-{splitting,reclassification},-field-corrections
// all default --min-confidence 0.7; splitting also requires replacement_events>=2).
// A store row violating either is the over-capture regression
// (plans/provenance-enrichment-structural-confidence-leak.md). Splits legitimately
// keep an undefined→NULL confidence (the writeback's `< N` guard does too), so the
// confidence check excludes NULLs; the length check catches degenerate splits.
const lowConfStructural = one(
  `SELECT COUNT(*) c FROM provenance_enrichments
   WHERE op_kind='structural' AND confidence IS NOT NULL AND confidence < 0.7`
).c;
const degenerateSplits = all(
  `SELECT payload FROM provenance_enrichments WHERE field='event.split'`
).filter((r) => {
  try { const p = JSON.parse(r.payload); return !p.replacement_events || p.replacement_events.length < 2; }
  catch { return false; }
}).length;
check("no sub-0.7-confidence structural store row (writeback min-confidence gate mirrored)",
  lowConfStructural === 0, `${lowConfStructural} low-conf structural rows`);
check("no degenerate (<2-replacement) split store row",
  degenerateSplits === 0, `${degenerateSplits} degenerate split rows`);

db.close();
