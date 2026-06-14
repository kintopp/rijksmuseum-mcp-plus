/**
 * provenance-parse-snapshot.mjs — before/after per-record provenance parse-regression harness.
 *
 * Snapshots the per-record provenance parse (events + parties, key fields) across the
 * whole corpus, so two runs — e.g. before vs after a grammar change / full re-parse —
 * can be diffed per artwork and bucketed into INTENDED vs COLLATERAL change. This is the
 * equivalence check the existing verification stack lacks (POST-REPARSE-STEPS.md only does
 * corpus-wide aggregate bands; plan 015's reconciliation only covers enriched events).
 *
 * Two snapshot sources:
 *   (default)   re-parse artworks.provenance_text with the CURRENT dist/ parser —
 *               deterministic, isolates grammar behaviour. For a clean grammar A/B,
 *               build dist/ from the OLD checkout → snapshot, build NEW → snapshot, diff.
 *   --from-db   read the already-stored provenance_events/provenance_parties rows —
 *               captures the DB's actual current state, including applied enrichments.
 *               Use it to baseline a deployed DB without rebuilding an old dist/.
 *
 * Recommended workflows:
 *   • Grammar A/B (isolates the parser — USE THIS for #390 re-parse verification):
 *       both snapshots in PARSE mode, old dist vs new dist —
 *         checkout OLD grammar → npm run build → snapshot --out before.jsonl
 *         checkout NEW grammar → npm run build → snapshot --out after.jsonl
 *       Then field_drift = TRUE grammar regressions; resegmented = intended #390 changes.
 *   • DB end-to-end before/after: both snapshots --from-db, old DB vs the re-parsed +
 *       re-applied DB. Captures the whole pipeline (parse + writebacks / 015 re-apply).
 *   CAVEAT: do NOT diff --from-db (before) against PARSE (after) when hunting grammar
 *   regressions — the stored DB carries the enrichment/rule layer (category rule, party
 *   backfills, llm reclassifications), so field_drift is dominated by enrichment, not
 *   grammar. (The `resegmented` bucket stays clean either way: an event-count change on
 *   byte-identical source text is the re-segmentation signature, immune to value enrichment.)
 *
 * Usage:
 *   node scripts/provenance-parse-snapshot.mjs snapshot [--db PATH] [--from-db] [--limit N] --out FILE
 *   node scripts/provenance-parse-snapshot.mjs diff --before A.jsonl --after B.jsonl [--out REPORT.md] [--examples N]
 *   node scripts/provenance-parse-snapshot.mjs diff --selftest
 *
 * Read-only on the DB. `snapshot` (parse mode) requires `npm run build` first (imports dist/).
 * Output JSONL is a working artifact — write it under data/ (gitignored), not into git.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// ─── CLI ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0];
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const FIELD_LABEL = { t: "transferType", c: "category", y: "dateYear", p: "price", cur: "currency", u: "unsold", x: "crossRef", pa: "parties" };

const sha = (s) => createHash("sha256").update(String(s ?? ""), "utf8").digest("hex").slice(0, 16);
const partyKey = (pa) => (pa || []).map((p) => `${p.n ?? ""}|${p.po ?? ""}|${p.r ?? ""}`).join("§");

// ─── Normalisation: one compact record per artwork ──────────────────
// { obj, th(text hash), n(event count), ev:[{ s,rt,t,c,y,p,cur,u,x, pa:[{n,po,r}] }] }
function normEventFromParse(e, inferPosition, T2C) {
  return {
    s: e.sequence,
    rt: e.rawText ?? "",
    t: e.transferType ?? null,
    c: T2C[e.transferType] ?? null,
    y: e.dateYear ?? null,
    p: e.price?.amount ?? null,
    cur: e.price?.currency ?? null,
    u: e.unsold ? 1 : 0,
    x: e.isCrossRef ? 1 : 0,
    pa: (e.parties || []).map((pp) => ({ n: pp.name ?? null, po: inferPosition(pp.role, e.transferType) ?? null, r: pp.role ?? null })),
  };
}

// ─── Classification core (shared by diff + selftest) ────────────────
// Returns { bucket, detail } where bucket ∈
//   identical | resegmented | field_drift | source_changed | added | removed
function classifyRecord(before, after) {
  if (!before) return { bucket: "added", detail: null };
  if (!after) return { bucket: "removed", detail: null };
  if (before.th !== after.th) return { bucket: "source_changed", detail: `${before.n}→${after.n} events` };
  if (before.n !== after.n) return { bucket: "resegmented", detail: `${before.n}→${after.n} events` };
  const changed = new Set();
  for (let i = 0; i < after.n; i++) {
    const be = before.ev[i], ae = after.ev[i];
    if (be.t !== ae.t) changed.add("t");
    if (be.c !== ae.c) changed.add("c");
    if (be.y !== ae.y) changed.add("y");
    if (be.p !== ae.p) changed.add("p");
    if (be.cur !== ae.cur) changed.add("cur");
    if (be.u !== ae.u) changed.add("u");
    if (be.x !== ae.x) changed.add("x");
    if (partyKey(be.pa) !== partyKey(ae.pa)) changed.add("pa");
  }
  if (changed.size) return { bucket: "field_drift", detail: [...changed].map((f) => FIELD_LABEL[f]) };
  return { bucket: "identical", detail: null };
}

// ─── snapshot ───────────────────────────────────────────────────────
async function runSnapshot() {
  const dbPath = val("--db", "data/vocabulary.db");
  const fromDb = has("--from-db");
  const out = val("--out");
  const limit = parseInt(val("--limit", "0"), 10) || 0;
  if (!out) { console.error("snapshot: --out FILE required"); process.exit(2); }
  if (!existsSync(dbPath)) { console.error(`snapshot: DB not found: ${dbPath}`); process.exit(2); }

  let inferPosition, T2C, parseProvenanceRaw;
  if (!fromDb) {
    // dist/ import deferred so `diff --selftest` never needs a build
    const peg = await import("../dist/provenance-peg.js");
    const prov = await import("../dist/provenance.js");
    parseProvenanceRaw = peg.parseProvenanceRaw;
    inferPosition = prov.inferPosition;
    T2C = prov.TRANSFER_TYPE_TO_CATEGORY;
  }

  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT art_id, object_number, provenance_text FROM artworks
     WHERE provenance_text IS NOT NULL AND TRIM(provenance_text) != ''
     ORDER BY object_number${limit ? " LIMIT " + limit : ""}`
  ).all();

  const stmtEvents = fromDb
    ? db.prepare(`SELECT sequence, raw_text, transfer_type, transfer_category, date_year, price_amount, price_currency, unsold, is_cross_ref
                  FROM provenance_events WHERE artwork_id = ? ORDER BY sequence`)
    : null;
  const stmtParties = fromDb
    ? db.prepare(`SELECT party_name, party_position, party_role FROM provenance_parties WHERE artwork_id = ? AND sequence = ? ORDER BY party_idx`)
    : null;

  mkdirSync(dirname(out), { recursive: true });
  const ws = createWriteStream(out);
  console.log(`snapshot (${fromDb ? "from-db" : "parse"}) → ${out}  [${rows.length} artworks${limit ? `, limit ${limit}` : ""}]`);

  let n = 0, parseErrors = 0;
  for (const r of rows) {
    let ev = [];
    try {
      if (fromDb) {
        for (const e of stmtEvents.all(r.art_id)) {
          ev.push({
            s: e.sequence, rt: e.raw_text ?? "", t: e.transfer_type ?? null, c: e.transfer_category ?? null,
            y: e.date_year ?? null, p: e.price_amount ?? null, cur: e.price_currency ?? null,
            u: e.unsold ? 1 : 0, x: e.is_cross_ref ? 1 : 0,
            pa: stmtParties.all(r.art_id, e.sequence).map((p) => ({ n: p.party_name ?? null, po: p.party_position ?? null, r: p.party_role ?? null })),
          });
        }
      } else {
        const parsed = parseProvenanceRaw(r.provenance_text);
        ev = parsed.events.map((e) => normEventFromParse(e, inferPosition, T2C));
      }
    } catch (err) {
      parseErrors++;
      ev = [{ s: 0, rt: "", t: "__parse_error__", c: null, y: null, p: null, cur: null, u: 0, x: 0, pa: [] }];
    }
    ws.write(JSON.stringify({ obj: r.object_number, th: sha(r.provenance_text), n: ev.length, ev }) + "\n");
    if (++n % 5000 === 0) console.log(`  ${n}/${rows.length}`);
  }
  await new Promise((res) => ws.end(res));
  db.close();
  console.log(`done: ${n} records${parseErrors ? `, ${parseErrors} parse errors` : ""}`);
}

// ─── diff ───────────────────────────────────────────────────────────
function loadSnapshot(path) {
  const map = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    map.set(rec.obj, rec);
  }
  return map;
}

function runDiff() {
  if (has("--selftest")) return runSelftest();
  const beforePath = val("--before");
  const afterPath = val("--after");
  const out = val("--out");
  const exN = parseInt(val("--examples", "8"), 10);
  if (!beforePath || !afterPath) { console.error("diff: --before A.jsonl --after B.jsonl required"); process.exit(2); }

  const before = loadSnapshot(beforePath);
  const after = loadSnapshot(afterPath);
  const objs = new Set([...before.keys(), ...after.keys()]);

  const buckets = { identical: 0, resegmented: 0, field_drift: 0, source_changed: 0, added: 0, removed: 0 };
  const fieldTally = {};
  const examples = { resegmented: [], field_drift: [], source_changed: [], added: [], removed: [] };

  for (const obj of objs) {
    const { bucket, detail } = classifyRecord(before.get(obj), after.get(obj));
    buckets[bucket]++;
    if (bucket === "field_drift") for (const f of detail) fieldTally[f] = (fieldTally[f] || 0) + 1;
    if (bucket !== "identical" && examples[bucket].length < exN) examples[bucket].push({ obj, detail });
  }

  const total = objs.size;
  const review = buckets.field_drift + buckets.removed; // most-likely-regression queue
  const lines = [];
  lines.push(`# Provenance parse snapshot diff`);
  lines.push("");
  lines.push(`before: ${beforePath}  (${before.size})`);
  lines.push(`after:  ${afterPath}  (${after.size})`);
  lines.push(`total artworks compared: ${total}`);
  lines.push("");
  lines.push(`| bucket | count | % | meaning |`);
  lines.push(`|---|---:|---:|---|`);
  const pct = (k) => ((buckets[k] / total) * 100).toFixed(2);
  lines.push(`| identical | ${buckets.identical} | ${pct("identical")} | parse unchanged |`);
  lines.push(`| resegmented | ${buckets.resegmented} | ${pct("resegmented")} | same source text, event COUNT changed (expected #390 class — re-segmentation) |`);
  lines.push(`| field_drift | ${buckets.field_drift} | ${pct("field_drift")} | same source + same count, a field changed (**scrutinise — likely regression**) |`);
  lines.push(`| source_changed | ${buckets.source_changed} | ${pct("source_changed")} | provenance_text itself changed (upstream edit, not parser) |`);
  lines.push(`| added | ${buckets.added} | ${pct("added")} | only in AFTER |`);
  lines.push(`| removed | ${buckets.removed} | ${pct("removed")} | only in BEFORE (**scrutinise**) |`);
  lines.push("");
  lines.push(`**Review queue (field_drift + removed): ${review}**`);
  if (Object.keys(fieldTally).length) {
    lines.push("");
    lines.push(`field_drift by field: ` + Object.entries(fieldTally).sort((a, b) => b[1] - a[1]).map(([f, c]) => `${f}=${c}`).join(", "));
  }
  for (const b of ["field_drift", "removed", "resegmented", "source_changed", "added"]) {
    if (!examples[b].length) continue;
    lines.push("");
    lines.push(`### ${b} examples`);
    for (const ex of examples[b]) lines.push(`- ${ex.obj}${ex.detail ? ` — ${Array.isArray(ex.detail) ? ex.detail.join(",") : ex.detail}` : ""}`);
  }
  const report = lines.join("\n");
  console.log(report);
  if (out) { mkdirSync(dirname(out), { recursive: true }); createWriteStream(out).end(report + "\n"); }
  // machine-readable last line
  console.log("\nSNAPSHOT-DIFF " + JSON.stringify({ total, buckets, review, fieldTally }));
}

// ─── selftest: prove the bucketing on synthetic pairs ───────────────
function rec(obj, th, ev) { return { obj, th, n: ev.length, ev }; }
function ev1(over = {}) { return { s: 1, rt: "x", t: "sale", c: "ownership", y: 1700, p: null, cur: null, u: 0, x: 0, pa: [{ n: "A", po: "receiver", r: "buyer" }], ...over }; }

function runSelftest() {
  const cases = [
    ["identical", classifyRecord(rec("o", "h", [ev1()]), rec("o", "h", [ev1()])).bucket],
    ["resegmented", classifyRecord(rec("o", "h", [ev1()]), rec("o", "h", [ev1(), ev1({ s: 2 })])).bucket],
    ["field_drift(type)", classifyRecord(rec("o", "h", [ev1()]), rec("o", "h", [ev1({ t: "gift" })])).bucket],
    ["field_drift(party)", classifyRecord(rec("o", "h", [ev1()]), rec("o", "h", [ev1({ pa: [{ n: "A", po: "agent", r: "dealer" }] })])).bucket],
    ["source_changed", classifyRecord(rec("o", "h1", [ev1()]), rec("o", "h2", [ev1()])).bucket],
    ["added", classifyRecord(null, rec("o", "h", [ev1()])).bucket],
    ["removed", classifyRecord(rec("o", "h", [ev1()]), null).bucket],
  ];
  const expected = ["identical", "resegmented", "field_drift", "field_drift", "source_changed", "added", "removed"];
  let pass = 0, fail = 0;
  cases.forEach(([name, got], i) => {
    const ok = got === expected[i];
    console.log(`  ${ok ? "✓" : "✗"} ${name} → ${got}${ok ? "" : ` (expected ${expected[i]})`}`);
    ok ? pass++ : fail++;
  });
  console.log(`\nselftest: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ─── dispatch ───────────────────────────────────────────────────────
if (cmd === "snapshot") await runSnapshot();
else if (cmd === "diff") runDiff();
else {
  console.error("usage:\n  provenance-parse-snapshot.mjs snapshot [--db PATH] [--from-db] [--limit N] --out FILE\n  provenance-parse-snapshot.mjs diff --before A.jsonl --after B.jsonl [--out REPORT.md] [--examples N]\n  provenance-parse-snapshot.mjs diff --selftest");
  process.exit(2);
}
