/**
 * reapply-enrichments-from-store.mjs
 *
 * Reads the content-addressed provenance_enrichments store and re-applies
 * all value, parties, and structural enrichments to the current provenance
 * tables, content-matching each enrichment to the event still carrying the
 * same raw_text (rather than its old ordinal position).
 *
 * Re-apply order (mirrors POST-REPARSE-STEPS ordering):
 *   1. value    — event.type / event.manual / period.manual on parents
 *   2. parties  — event.parties snapshots rebuild party lists on parents (§G+§H)
 *   3. field-correction structural — modify a parent's columns / insert receiver
 *   4. reclassification structural — mark_non_provenance / merge (delete) a parent
 *   5. split structural LAST — replace a parent with N children + renumber once
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
import { buildDupOrdinals } from "./lib/raw-text-hash.mjs";
import * as M from "./lib/provenance-enrichment-methods.mjs";

// Issue → correction_method maps, replicated verbatim from the writeback scripts
// so the structural re-apply stamps the same correction_method values.
const SPLIT_ISSUE_TO_METHOD = {
  multi_transfer: `${M.LLM_STRUCTURAL_PREFIX}#125`,
  bequest_chain: `${M.LLM_STRUCTURAL_PREFIX}#117`,
  gap_bridge: `${M.LLM_STRUCTURAL_PREFIX}#99`,
  catalogue_fragment: `${M.LLM_STRUCTURAL_PREFIX}#102`,
};
const RECLASS_ISSUE_TO_METHOD = {
  phantom_event: `${M.LLM_STRUCTURAL_PREFIX}#87`,
  location_as_event: `${M.LLM_STRUCTURAL_PREFIX}#104`,
  alternative_acquisition: `${M.LLM_STRUCTURAL_PREFIX}#103`,
};
const FIELD_ISSUE_TO_METHOD = {
  truncated_location: `${M.LLM_STRUCTURAL_PREFIX}#149`,
  wrong_location: `${M.LLM_STRUCTURAL_PREFIX}#119`,
  missing_receiver: `${M.LLM_STRUCTURAL_PREFIX}#116`,
};

// ─── Core reapply function ─────────────────────────────────────────────────────

/**
 * Re-apply all store enrichments to the current provenance tables.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ dryRun?: boolean }} opts
 * @returns {{
 *   applied: { event_type: number, event_manual: number, period_manual: number, parties: number, event_fieldcorrection: number, event_reclassify: number, event_split: number },
 *   unmatched: { text_changed: number, dup_cardinality_changed: number, ordinal_out_of_range: number, period_not_found: number, structural_text_changed: number, structural_dup_cardinality_changed: number, structural_ordinal_out_of_range: number },
 *   unmatched_object_numbers: string[]
 * }}
 */
export function reapply(db, { dryRun = false } = {}) {
  const applied = {
    event_type: 0,
    event_manual: 0,
    period_manual: 0,
    parties: 0,
    event_fieldcorrection: 0,
    event_reclassify: 0,
    event_split: 0,
  };
  const unmatched = {
    text_changed: 0,
    dup_cardinality_changed: 0,
    ordinal_out_of_range: 0,
    period_not_found: 0,
    structural_text_changed: 0,
    structural_dup_cardinality_changed: 0,
    structural_ordinal_out_of_range: 0,
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

  const getPeriodBySourceEvent = db.prepare(`
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

  // ── Structural statements ────────────────────────────────────────────────────
  // Field-correction: location update (guarded by current value, like the writeback)
  const updateLocation = dryRun ? null : db.prepare(`
    UPDATE provenance_events
    SET location = ?, correction_method = ?, enrichment_reasoning = ?
    WHERE artwork_id = ? AND sequence = ? AND location = ?
  `);
  const getMaxPartyIdx = db.prepare(
    "SELECT COALESCE(MAX(party_idx), -1) AS max_idx FROM provenance_parties WHERE artwork_id = ? AND sequence = ?"
  );
  const insertFieldParty = dryRun ? null : db.prepare(`
    INSERT INTO provenance_parties
      (artwork_id, sequence, party_idx, party_name, party_role, party_position, position_method, enrichment_reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getPartiesJson = db.prepare(
    "SELECT parties FROM provenance_events WHERE artwork_id = ? AND sequence = ?"
  );
  const updatePartiesJsonCorr = dryRun ? null : db.prepare(`
    UPDATE provenance_events SET parties = ?, correction_method = ?, enrichment_reasoning = ?
    WHERE artwork_id = ? AND sequence = ?
  `);
  // Reclassification
  const markNonProv = dryRun ? null : db.prepare(`
    UPDATE provenance_events
    SET transfer_type = 'non_provenance', transfer_category = NULL,
        correction_method = ?, enrichment_reasoning = ?
    WHERE artwork_id = ? AND sequence = ?
  `);
  const updateTargetLocation = dryRun ? null : db.prepare(`
    UPDATE provenance_events SET location = ?, correction_method = ?, enrichment_reasoning = ?
    WHERE artwork_id = ? AND sequence = ?
  `);
  const setUncertain = dryRun ? null : db.prepare(`
    UPDATE provenance_events SET uncertain = 1, correction_method = ?, enrichment_reasoning = ?
    WHERE artwork_id = ? AND sequence = ?
  `);
  const deleteEventAt = dryRun ? null : db.prepare(
    "DELETE FROM provenance_events WHERE artwork_id = ? AND sequence = ?"
  );
  const deletePartiesAt = dryRun ? null : db.prepare(
    "DELETE FROM provenance_parties WHERE artwork_id = ? AND sequence = ?"
  );
  // Split: full-artwork rebuild (ported from writeback-event-splitting.mjs)
  const getFullEvents = db.prepare(
    "SELECT * FROM provenance_events WHERE artwork_id = ? ORDER BY sequence"
  );
  const getFullParties = db.prepare(
    "SELECT * FROM provenance_parties WHERE artwork_id = ? ORDER BY sequence, party_idx"
  );
  const getFullPeriods = db.prepare(
    "SELECT * FROM provenance_periods WHERE artwork_id = ? ORDER BY sequence"
  );
  const deleteAllEvents = dryRun ? null : db.prepare(
    "DELETE FROM provenance_events WHERE artwork_id = ?"
  );
  const deleteAllParties = dryRun ? null : db.prepare(
    "DELETE FROM provenance_parties WHERE artwork_id = ?"
  );
  const insertFullEvent = dryRun ? null : db.prepare(`
    INSERT INTO provenance_events (
      artwork_id, sequence, raw_text, gap, transfer_type, unsold, batch_price,
      transfer_category, category_method, uncertain, parties,
      date_expression, date_year, date_qualifier, location,
      price_amount, price_currency, sale_details, citations,
      is_cross_ref, cross_ref_target, parse_method, correction_method, enrichment_reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFullParty = dryRun ? null : db.prepare(`
    INSERT INTO provenance_parties (
      artwork_id, sequence, party_idx, party_name, party_dates, party_role,
      party_position, position_method, uncertain, enrichment_reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updatePeriodSourceEvents = dryRun ? null : db.prepare(
    "UPDATE provenance_periods SET source_events = ? WHERE artwork_id = ? AND sequence = ?"
  );

  /**
   * Content-match a store row to a current event sequence (shared dup guard).
   * Returns { seq } or { unmatched: '<reason>' }. `prefix` selects the bucket
   * ('' for value/parties, 'structural_' for structural ops).
   */
  function locateSeq(groups, row, prefix = "") {
    const seqs = groups.get(row.raw_text_hash);
    if (!seqs) return { unmatched: `${prefix}text_changed` };
    if (seqs.length !== row.dup_count) return { unmatched: `${prefix}dup_cardinality_changed` };
    const seq = seqs[row.dup_ordinal];
    if (seq == null) return { unmatched: `${prefix}ordinal_out_of_range` };
    return { seq };
  }

  /**
   * Replay writeback-event-splitting.mjs's processArtwork against this artwork,
   * where each locatedSplit carries original_sequence = the content-located
   * CURRENT sequence of the parent. Rebuilds the whole artwork with contiguous
   * sequences and remaps provenance_periods.source_events. (Ported through the
   * source_events remap — not stopping at the event re-insert.)
   */
  function applySplits(artworkId, locatedSplits) {
    const existingEvents = getFullEvents.all(artworkId);
    const existingParties = getFullParties.all(artworkId);
    const existingPeriods = getFullPeriods.all(artworkId);

    const partiesBySeq = new Map();
    for (const p of existingParties) {
      if (!partiesBySeq.has(p.sequence)) partiesBySeq.set(p.sequence, []);
      partiesBySeq.get(p.sequence).push(p);
    }

    const splitBySeq = new Map(locatedSplits.map((s) => [s.original_sequence, s]));

    const newEvents = [];
    const seqMap = {};

    for (const evt of existingEvents) {
      if (splitBySeq.has(evt.sequence)) {
        const split = splitBySeq.get(evt.sequence);
        const method = SPLIT_ISSUE_TO_METHOD[split.issue_type] ?? `${M.LLM_STRUCTURAL_PREFIX}${split.issue_type}`;
        const startIdx = newEvents.length;
        for (const re of split.replacement_events) {
          const newSeq = newEvents.length;
          const partiesJson = JSON.stringify((re.parties || []).map((p) => ({
            name: p.name,
            role: p.role ?? null,
            position: p.position,
          })));
          newEvents.push({
            event: {
              artwork_id: artworkId,
              sequence: newSeq,
              raw_text: re.raw_text_segment,
              gap: re.gap ? 1 : 0,
              transfer_type: re.transfer_type,
              unsold: 0,
              batch_price: 0,
              transfer_category: re.transfer_category,
              category_method: null,
              uncertain: evt.uncertain,
              parties: partiesJson,
              date_expression: null,
              date_year: re.date_year ?? null,
              date_qualifier: re.date_qualifier ?? null,
              location: re.location ?? null,
              price_amount: null,
              price_currency: null,
              sale_details: null,
              citations: evt.citations,
              is_cross_ref: 0,
              cross_ref_target: null,
              parse_method: M.LLM_STRUCTURAL,
              correction_method: method,
              enrichment_reasoning: split.reasoning,
            },
            parties: (re.parties || []).map((p, i) => ({
              party_idx: i,
              party_name: p.name,
              party_dates: null,
              party_role: p.role ?? null,
              party_position: p.position,
              position_method: M.LLM_STRUCTURAL,
              uncertain: 0,
              enrichment_reasoning: split.reasoning,
            })),
          });
        }
        const endIdx = newEvents.length;
        seqMap[evt.sequence] = Array.from({ length: endIdx - startIdx }, (_, i) => startIdx + i);
      } else {
        const newSeq = newEvents.length;
        seqMap[evt.sequence] = [newSeq];
        newEvents.push({
          event: { ...evt, sequence: newSeq },
          parties: (partiesBySeq.get(evt.sequence) || []).map((p) => ({ ...p, sequence: newSeq })),
        });
      }
    }

    if (!dryRun) {
      deleteAllEvents.run(artworkId);
      deleteAllParties.run(artworkId);
      for (const { event: e, parties } of newEvents) {
        insertFullEvent.run(
          e.artwork_id, e.sequence, e.raw_text, e.gap, e.transfer_type, e.unsold, e.batch_price,
          e.transfer_category, e.category_method, e.uncertain, e.parties,
          e.date_expression, e.date_year, e.date_qualifier, e.location,
          e.price_amount, e.price_currency, e.sale_details, e.citations,
          e.is_cross_ref, e.cross_ref_target, e.parse_method, e.correction_method, e.enrichment_reasoning
        );
        for (const p of parties) {
          insertFullParty.run(
            artworkId, e.sequence, p.party_idx, p.party_name, p.party_dates ?? null, p.party_role ?? null,
            p.party_position ?? null, p.position_method ?? null, p.uncertain ?? 0, p.enrichment_reasoning ?? null
          );
        }
      }
      // Remap provenance_periods.source_events against the new sequence numbers.
      for (const period of existingPeriods) {
        if (!period.source_events) continue;
        let sourceEvents;
        try { sourceEvents = JSON.parse(period.source_events); } catch { continue; }
        if (!Array.isArray(sourceEvents)) continue;
        const newSourceEvents = [];
        for (const oldSeq of sourceEvents) {
          const mapped = seqMap[oldSeq];
          if (mapped) newSourceEvents.push(...mapped);
          else newSourceEvents.push(oldSeq);
        }
        updatePeriodSourceEvents.run(JSON.stringify(newSourceEvents), artworkId, period.sequence);
      }
    }
  }

  const run = db.transaction(() => {
    const artworks = getArtworks.all();

    for (const { art_id: artworkId, object_number: objectNumber } of artworks) {
      const events = getEvents.all(artworkId);
      const groups = buildDupOrdinals(events);
      const enrichments = getEnrichments.all(objectNumber);

      // Passes 1–2: value then parties (structural handled afterwards).
      const valueParties = enrichments
        .filter((r) => r.op_kind === "value" || r.op_kind === "parties")
        .sort((a, b) => {
          const kindOrder = { value: 0, parties: 1 };
          return (kindOrder[a.op_kind] ?? 99) - (kindOrder[b.op_kind] ?? 99);
        });

      for (const row of valueParties) {
        // Locate the sequence by content-address
        const located = locateSeq(groups, row);
        if (located.unmatched) {
          unmatched[located.unmatched]++;
          unmatchedObjectNumbers.add(objectNumber);
          continue;
        }
        const seq = located.seq;

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
            // Resolve period via source_events (read happens in dry-run too)
            const eventSeq = payload.period_sequence;
            const periodRow = getPeriodBySourceEvent.get(artworkId, `%${eventSeq}%`);
            if (!periodRow) {
              unmatched.period_not_found++;
              unmatchedObjectNumbers.add(objectNumber);
            } else {
              applied.period_manual++;
              if (!dryRun) {
                for (const [col, val] of Object.entries(payload)) {
                  if (col === "period_sequence") continue;
                  updatePeriodManual(col, dryRun).run(val, artworkId, periodRow.sequence);
                }
              }
            }
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

      // ── Passes 3–5: structural (field-correction → reclassify → split LAST) ──
      // field-correction + reclassification locate against the pre-structural
      // `groups` (they don't change raw_text); splits re-locate against fresh
      // groups so they pick up any reclassification merge-deletions, then
      // renumber once at the end.
      const structRows = enrichments.filter((r) => r.op_kind === "structural");

      // Pass 3: field corrections
      for (const row of structRows.filter((r) => r.field === "event.fieldcorrection")) {
        const located = locateSeq(groups, row, "structural_");
        if (located.unmatched) {
          unmatched[located.unmatched]++;
          unmatchedObjectNumbers.add(objectNumber);
          continue;
        }
        const seq = located.seq;
        const c = JSON.parse(row.payload);
        const method = FIELD_ISSUE_TO_METHOD[c.issue_type] ?? `${M.LLM_STRUCTURAL_PREFIX}${c.issue_type}`;
        if (c.field === "location") {
          applied.event_fieldcorrection++;
          if (!dryRun) {
            updateLocation.run(c.corrected_value, method, row.reasoning ?? null, artworkId, seq, c.current_value);
          }
        } else if (c.field === "parties" && c.new_party) {
          applied.event_fieldcorrection++;
          if (!dryRun) {
            const { max_idx } = getMaxPartyIdx.get(artworkId, seq);
            insertFieldParty.run(
              artworkId, seq, max_idx + 1,
              c.new_party.name, c.new_party.role ?? null, c.new_party.position,
              M.LLM_STRUCTURAL, row.reasoning ?? null
            );
            const evtRow = getPartiesJson.get(artworkId, seq);
            if (evtRow) {
              let parties;
              try { parties = JSON.parse(evtRow.parties || "[]"); } catch { parties = []; }
              parties.push({ name: c.new_party.name, role: c.new_party.role ?? null, position: c.new_party.position });
              updatePartiesJsonCorr.run(JSON.stringify(parties), method, row.reasoning ?? null, artworkId, seq);
            }
          }
        }
      }

      // Pass 4: reclassifications (mark_non_provenance / merge → delete)
      for (const row of structRows.filter((r) => r.field === "event.reclassify")) {
        const located = locateSeq(groups, row, "structural_");
        if (located.unmatched) {
          unmatched[located.unmatched]++;
          unmatchedObjectNumbers.add(objectNumber);
          continue;
        }
        const seq = located.seq;
        const r = JSON.parse(row.payload);
        const method = RECLASS_ISSUE_TO_METHOD[r.issue_type] ?? `${M.LLM_STRUCTURAL_PREFIX}${r.issue_type}`;
        applied.event_reclassify++;
        if (dryRun) continue;
        if (r.action === "mark_non_provenance") {
          markNonProv.run(method, r.reasoning ?? null, artworkId, seq);
        } else if (r.action === "merge_with_adjacent") {
          if (r.merge_field_updates?.location != null) {
            updateTargetLocation.run(r.merge_field_updates.location, method, r.reasoning ?? null, artworkId, r.merge_target_sequence);
          }
          deletePartiesAt.run(artworkId, seq);
          deleteEventAt.run(artworkId, seq);
        } else if (r.action === "merge_alternatives") {
          setUncertain.run(method, r.reasoning ?? null, artworkId, r.merge_target_sequence);
          deletePartiesAt.run(artworkId, seq);
          deleteEventAt.run(artworkId, seq);
        }
      }

      // Pass 5: splits LAST — re-locate against the current (post-pass-4) events,
      // then rebuild the whole artwork with contiguous sequences in one shot.
      const splitRows = structRows.filter((r) => r.field === "event.split");
      if (splitRows.length > 0) {
        const freshGroups = buildDupOrdinals(getEvents.all(artworkId));
        const locatedSplits = [];
        for (const row of splitRows) {
          const located = locateSeq(freshGroups, row, "structural_");
          if (located.unmatched) {
            unmatched[located.unmatched]++;
            unmatchedObjectNumbers.add(objectNumber);
            continue;
          }
          const split = JSON.parse(row.payload);
          // Override the audit's original_sequence with the content-located seq.
          locatedSplits.push({ ...split, original_sequence: located.seq });
          applied.event_split++;
        }
        if (locatedSplits.length > 0) {
          applySplits(artworkId, locatedSplits);
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
