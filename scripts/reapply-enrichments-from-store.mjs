/**
 * reapply-enrichments-from-store.mjs
 *
 * Reads the content-addressed provenance_enrichments store and re-applies
 * all value and parties enrichments to the current provenance tables.
 *
 * Usage:
 *   node scripts/reapply-enrichments-from-store.mjs [--dry-run] [--db PATH]
 *
 * Output:
 *   Human-readable summary + a RECONCILE <json> line for machine parsing.
 *   Exit 0 always (unmatched rows are non-fatal, logged in the reconcile object).
 */

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDupOrdinals, rawTextHash } from "./lib/raw-text-hash.mjs";
import * as M from "./lib/provenance-enrichment-methods.mjs";

// ─── Core reapply function ─────────────────────────────────────────────────────

/**
 * Re-apply all store enrichments to the current provenance tables.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ dryRun?: boolean }} opts
 * @returns {{
 *   applied: { event_type: number, event_manual: number, period_manual: number, parties: number },
 *   unmatched: { text_changed: number, dup_cardinality_changed: number, ordinal_out_of_range: number, period_not_found: number },
 *   unmatched_object_numbers: string[]
 * }}
 */
export function reapply(db, { dryRun = false } = {}) {
  const applied = { event_type: 0, event_manual: 0, period_manual: 0, parties: 0 };
  const unmatched = {
    text_changed: 0,
    dup_cardinality_changed: 0,
    ordinal_out_of_range: 0,
    period_not_found: 0,
  };
  const unmatchedObjectNumbers = new Set();

  // Prepare queries
  const getArtworks = db.prepare(`
    SELECT DISTINCT a.art_id, a.object_number
    FROM artworks a
    JOIN provenance_enrichments pe ON pe.object_number = a.object_number
  `);

  const getEvents = db.prepare(`
    SELECT sequence, raw_text
    FROM provenance_events WHERE artwork_id = ? ORDER BY sequence
  `);

  const getEnrichments = db.prepare(`
    SELECT raw_text_hash, dup_ordinal, dup_count, field, party_idx,
           op_kind, payload, method, reasoning
    FROM provenance_enrichments WHERE object_number = ?
    ORDER BY op_kind, field, dup_ordinal
  `);

  // Write statements (only used when not dry-run)
  const updateEventType = dryRun ? null : db.prepare(`
    UPDATE provenance_events
    SET transfer_type = ?, transfer_category = ?,
        category_method = ?, enrichment_reasoning = ?
    WHERE artwork_id = ? AND sequence = ?
  `);

  const updateEventManual = (colName, dryRun_) => dryRun_ ? null : db.prepare(`
    UPDATE provenance_events SET ${colName} = ?, enrichment_reasoning = ?
    WHERE artwork_id = ? AND sequence = ?
  `);

  const updatePeriodManual = (colName, dryRun_) => dryRun_ ? null : db.prepare(`
    UPDATE provenance_periods SET ${colName} = ?
    WHERE artwork_id = ? AND sequence = ?
  `);

  const getPeriodBySourceEvent = dryRun ? null : db.prepare(`
    SELECT sequence FROM provenance_periods
    WHERE artwork_id = ? AND source_events LIKE ?
  `);

  const deleteParties = dryRun ? null : db.prepare(`
    DELETE FROM provenance_parties WHERE artwork_id = ? AND sequence = ?
  `);

  const insertParty = dryRun ? null : db.prepare(`
    INSERT INTO provenance_parties
      (artwork_id, sequence, party_idx, party_name, party_dates, party_role,
       party_position, position_method, uncertain, enrichment_reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updatePartiesJson = dryRun ? null : db.prepare(`
    UPDATE provenance_events SET parties = ? WHERE artwork_id = ? AND sequence = ?
  `);

  const run = db.transaction(() => {
    const artworks = getArtworks.all();

    for (const { art_id: artworkId, object_number: objectNumber } of artworks) {
      const events = getEvents.all(artworkId);
      const groups = buildDupOrdinals(events);
      const enrichments = getEnrichments.all(objectNumber);

      // Sort: value before parties so we don't stomp
      const sorted = [...enrichments].sort((a, b) => {
        const kindOrder = { value: 0, parties: 1 };
        return (kindOrder[a.op_kind] ?? 99) - (kindOrder[b.op_kind] ?? 99);
      });

      for (const row of sorted) {
        // Locate the sequence by content-address
        const seqs = groups.get(row.raw_text_hash);
        if (!seqs) {
          unmatched.text_changed++;
          unmatchedObjectNumbers.add(objectNumber);
          continue;
        }
        if (seqs.length !== row.dup_count) {
          unmatched.dup_cardinality_changed++;
          unmatchedObjectNumbers.add(objectNumber);
          continue;
        }
        const seq = seqs[row.dup_ordinal];
        if (seq == null) {
          unmatched.ordinal_out_of_range++;
          unmatchedObjectNumbers.add(objectNumber);
          continue;
        }

        const payload = JSON.parse(row.payload);

        if (row.op_kind === "value") {
          if (row.field === "event.type") {
            applied.event_type++;
            if (!dryRun) {
              updateEventType.run(
                payload.transfer_type,
                payload.transfer_category,
                M.LLM_ENRICHMENT,
                row.reasoning ?? null,
                artworkId,
                seq
              );
            }
          } else if (row.field === "event.manual") {
            applied.event_manual++;
            if (!dryRun) {
              for (const [col, val] of Object.entries(payload)) {
                updateEventManual(col, dryRun).run(val, row.reasoning ?? null, artworkId, seq);
              }
            }
          } else if (row.field === "period.manual") {
            if (!dryRun) {
              // Resolve period via source_events LIKE match
              const eventSeq = payload.period_sequence;
              const periodRow = getPeriodBySourceEvent.get(artworkId, `%${eventSeq}%`);
              if (!periodRow) {
                unmatched.period_not_found++;
                unmatchedObjectNumbers.add(objectNumber);
                applied.period_manual--; // will be incremented below, pre-decrement to cancel
              } else {
                for (const [col, val] of Object.entries(payload)) {
                  if (col === "period_sequence") continue;
                  updatePeriodManual(col, dryRun).run(val, artworkId, periodRow.sequence);
                }
              }
            }
            applied.period_manual++;
          }
        } else if (row.op_kind === "parties") {
          // §G + §H: delete + reinsert + rebuild JSON mirror
          applied.parties++;
          if (!dryRun) {
            deleteParties.run(artworkId, seq);
            for (let i = 0; i < payload.parties.length; i++) {
              const p = payload.parties[i];
              insertParty.run(
                artworkId,
                seq,
                i,
                p.party_name,
                p.party_dates ?? null,
                p.party_role ?? null,
                p.party_position ?? null,
                p.position_method ?? null,
                p.uncertain ? 1 : 0,
                p.enrichment_reasoning ?? null
              );
            }
            // Rebuild parties JSON mirror (§H)
            const partiesJson = JSON.stringify(
              payload.parties.map((p) => ({
                name: p.party_name,
                dates: p.party_dates ?? null,
                uncertain: !!(p.uncertain),
                role: p.party_role ?? null,
                position: p.party_position ?? null,
              }))
            );
            updatePartiesJson.run(partiesJson, artworkId, seq);
          }
        }
      }
    }
  });

  run();

  return {
    applied,
    unmatched,
    unmatched_object_numbers: [...unmatchedObjectNumbers].sort(),
  };
}

// ─── isMain guard ────────────────────────────────────────────────────────────

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const dbIdx = args.indexOf("--db");
  const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : "data/vocabulary.db";

  console.log("Provenance enrichment re-apply");
  console.log(`  DB:      ${dbPath}`);
  console.log(`  Dry run: ${dryRun}`);
  console.log();

  let db;
  try {
    db = new Database(dbPath);
    const result = reapply(db, { dryRun });

    console.log("Applied:");
    for (const [k, v] of Object.entries(result.applied)) {
      console.log(`  ${k}: ${v}`);
    }
    console.log("Unmatched:");
    for (const [k, v] of Object.entries(result.unmatched)) {
      console.log(`  ${k}: ${v}`);
    }
    if (result.unmatched_object_numbers.length > 0) {
      console.log("Unmatched object_numbers:", result.unmatched_object_numbers.join(", "));
    }
    if (dryRun) console.log("\n(dry-run — no writes)");

    console.log(
      `RECONCILE ${JSON.stringify({
        applied: result.applied,
        unmatched: result.unmatched,
        unmatched_object_numbers: result.unmatched_object_numbers,
      })}`
    );
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  } finally {
    db?.close();
  }
}
