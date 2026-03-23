/**
 * Backfill enrichment_reasoning column from all audit JSON files.
 *
 * Sources (5 files):
 * - Type classification: audit-type-classification-2026-03-22.json → provenance_events
 * - Position enrichment R1: audit-position-enrichment-r1.json → provenance_parties
 * - Position enrichment R2: audit-position-enrichment-r2.json → provenance_parties
 * - Party disambiguation R1: audit-party-disambiguation-r1.json → provenance_parties
 * - Party disambiguation R2: audit-party-disambiguation-r2.json → provenance_parties
 * - Transfer category rule: deterministic → provenance_events
 *
 * For position enrichment, reasoning is stored on the party row.
 * For disambiguation, reasoning describes the whole decomposition and is stored
 * on ALL replacement parties for that event (prefixed with [action]).
 * For type classification, reasoning is stored on the event row.
 *
 * Usage:
 *   node scripts/backfill-enrichment-reasoning.mjs [--dry-run] [--db PATH]
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbPath = args.includes("--db") ? args[args.indexOf("--db") + 1] : "data/vocabulary.db";

const db = new Database(dbPath, dryRun ? { readonly: true } : undefined);
if (!dryRun) db.pragma("journal_mode = WAL");

const stats = { typeClass: 0, posEnrich: 0, posCat: 0, disambig: 0, rule: 0 };

// ─── Prepared statements ────────────────────────────────────────────

const updateEventReasoning = dryRun ? null : db.prepare(`
  UPDATE provenance_events SET enrichment_reasoning = ?
  WHERE artwork_id = ? AND sequence = ? AND enrichment_reasoning IS NULL
`);

const updatePartyReasoning = dryRun ? null : db.prepare(`
  UPDATE provenance_parties SET enrichment_reasoning = ?
  WHERE artwork_id = ? AND sequence = ? AND party_idx = ? AND enrichment_reasoning IS NULL
`);

const updatePartyReasoningByMethod = dryRun ? null : db.prepare(`
  UPDATE provenance_parties SET enrichment_reasoning = ?
  WHERE artwork_id = ? AND sequence = ? AND position_method = 'llm_disambiguation' AND enrichment_reasoning IS NULL
`);

// ─── 1. Type classifications → provenance_events ────────────────────

console.log("1. Type classifications...");
const typeData = JSON.parse(readFileSync("data/audit-type-classification-2026-03-22.json", "utf-8"));
for (const r of typeData.results) {
  for (const cls of r.data.classifications) {
    if (!dryRun) {
      const result = updateEventReasoning.run(cls.reasoning, r.data.artwork_id, cls.event_sequence);
      stats.typeClass += result.changes;
    } else stats.typeClass++;
  }
}
console.log(`   ${stats.typeClass} events`);

// ─── 2. Position enrichment (both rounds) → provenance_parties ──────

function backfillPositionEnrichment(filePath, label) {
  console.log(`2. Position enrichment (${label})...`);
  const data = JSON.parse(readFileSync(filePath, "utf-8"));
  let posCount = 0, catCount = 0;

  for (const r of data.results) {
    if (r.error) continue;
    const { artwork_id } = r.data;
    for (const enr of r.data.enrichments || []) {
      // Party position reasoning
      for (const pu of enr.party_updates || []) {
        const pos = pu.position;
        if (pos == null || pos === "null" || pos === "None") continue;
        if (!dryRun) {
          const result = updatePartyReasoning.run(pu.reasoning, artwork_id, enr.event_sequence, pu.party_idx);
          posCount += result.changes;
        } else posCount++;
      }
      // Category reasoning
      if (enr.category_update) {
        if (!dryRun) {
          const result = updateEventReasoning.run(enr.category_update.reasoning, artwork_id, enr.event_sequence);
          catCount += result.changes;
        } else catCount++;
      }
    }
  }
  stats.posEnrich += posCount;
  stats.posCat += catCount;
  console.log(`   ${posCount} parties, ${catCount} category updates`);
}

backfillPositionEnrichment("data/audit-position-enrichment-r1.json", "R1");
backfillPositionEnrichment("data/audit-position-enrichment-r2.json", "R2");

// ─── 3. Party disambiguation (both rounds) → provenance_parties ─────

function backfillDisambiguation(filePath, label) {
  console.log(`3. Party disambiguation (${label})...`);
  const data = JSON.parse(readFileSync(filePath, "utf-8"));
  let count = 0;

  for (const r of data.results) {
    if (r.error) continue;
    const { artwork_id } = r.data;
    for (const d of r.data.disambiguations || []) {
      // Build a rich reasoning string that explains the full decomposition
      const parts = [`[${d.action}] ${d.reasoning}`];
      if (d.replacement_parties?.length > 0) {
        const partySummary = d.replacement_parties
          .map(p => `${p.name} [${p.position}]`)
          .join(" + ");
        parts.push(`Original: "${d.original_text}" → ${partySummary}`);
      } else {
        parts.push(`Original: "${d.original_text}" → deleted`);
      }
      const fullReasoning = parts.join(" | ");

      // Apply to all llm_disambiguation parties in this event
      if (!dryRun) {
        const result = updatePartyReasoningByMethod.run(fullReasoning, artwork_id, d.event_sequence);
        count += result.changes;
      } else count++;
    }
  }
  stats.disambig += count;
  console.log(`   ${count} parties`);
}

backfillDisambiguation("data/audit-party-disambiguation-r1.json", "R1");
backfillDisambiguation("data/audit-party-disambiguation-r2.json", "R2");

// ─── 4. Transfer category rule → provenance_events ──────────────────

console.log("4. Transfer category rule...");
const ruleReasoning = "Deterministic rule: all transfer-type events in the Rijksmuseum corpus are permanent institutional transfers. Verified via LLM pilot batch (50 artworks, 57/57 → ownership) and keyword analysis (0 genuine custody matches among 6,233 events).";
if (!dryRun) {
  const result = db.prepare(`
    UPDATE provenance_events SET enrichment_reasoning = ?
    WHERE category_method = 'rule:transfer_is_ownership' AND enrichment_reasoning IS NULL
  `).run(ruleReasoning);
  stats.rule = result.changes;
} else {
  stats.rule = db.prepare(`SELECT COUNT(*) as cnt FROM provenance_events WHERE category_method = 'rule:transfer_is_ownership' AND enrichment_reasoning IS NULL`).get().cnt;
}
console.log(`   ${stats.rule} events`);

// ─── Summary ────────────────────────────────────────────────────────

const total = Object.values(stats).reduce((a, b) => a + b, 0);
console.log(`\nTotal: ${total} rows updated`);
if (dryRun) console.log("(dry run)");

// Coverage check
if (!dryRun) {
  const missingParties = db.prepare(`
    SELECT position_method, COUNT(*) as cnt FROM provenance_parties
    WHERE position_method LIKE 'llm%' AND enrichment_reasoning IS NULL
    GROUP BY 1
  `).all();
  const missingEvents = db.prepare(`
    SELECT category_method, COUNT(*) as cnt FROM provenance_events
    WHERE (category_method LIKE 'llm%' OR category_method LIKE 'rule%') AND enrichment_reasoning IS NULL
    GROUP BY 1
  `).all();

  if (missingParties.length === 0 && missingEvents.length === 0) {
    console.log("\nFull coverage — all LLM/rule-enriched rows have reasoning.");
  } else {
    console.log("\nMissing reasoning:");
    for (const row of missingParties) console.log(`  parties: ${row.position_method} = ${row.cnt}`);
    for (const row of missingEvents) console.log(`  events: ${row.category_method} = ${row.cnt}`);
  }
}

db.close();
