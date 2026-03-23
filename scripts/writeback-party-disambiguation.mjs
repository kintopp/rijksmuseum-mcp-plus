/**
 * Write back party disambiguation results to provenance_parties and provenance_events.
 *
 * From audit-party-disambiguation JSON:
 * - split (143): delete original party, insert 2+ replacement parties
 * - rename (44): update party name + set position
 * - delete (26): remove party row entirely
 *
 * Also updates the `parties` JSON column in provenance_events to stay in sync.
 *
 * Usage:
 *   node scripts/writeback-party-disambiguation.mjs [--dry-run] [--db PATH] [--input PATH]
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbPath = args.includes("--db") ? args[args.indexOf("--db") + 1] : "data/vocabulary.db";
const inputPath = args.includes("--input") ? args[args.indexOf("--input") + 1] : "data/audit-party-disambiguation-2026-03-22.json";

const data = JSON.parse(readFileSync(inputPath, "utf-8"));

console.log(`Party disambiguation write-back`);
console.log(`  Input:    ${inputPath}`);
console.log(`  DB:       ${dbPath}`);
console.log(`  Dry run:  ${dryRun}`);
console.log();

// ─── Flatten disambiguations ────────────────────────────────────────

const items = [];
for (const r of data.results) {
  if (r.error) continue;
  const { artwork_id, object_number } = r.data;
  for (const d of r.data.disambiguations || []) {
    items.push({ artwork_id, object_number, ...d });
  }
}

const splits = items.filter(i => i.action === "split");
const renames = items.filter(i => i.action === "rename");
const deletes = items.filter(i => i.action === "delete");

console.log(`Disambiguations: ${items.length} total`);
console.log(`  split:  ${splits.length} (→ ${splits.reduce((s, i) => s + i.replacement_parties.length, 0)} parties)`);
console.log(`  rename: ${renames.length}`);
console.log(`  delete: ${deletes.length}`);
console.log();

if (dryRun) {
  console.log(`Dry run — no changes written.`);
  process.exit(0);
}

// ─── Write to DB ────────────────────────────────────────────────────

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Prepared statements
const getParties = db.prepare(`
  SELECT party_idx, party_name, party_dates, party_role, party_position, position_method, uncertain
  FROM provenance_parties WHERE artwork_id = ? AND sequence = ? ORDER BY party_idx
`);

const deleteParty = db.prepare(`
  DELETE FROM provenance_parties WHERE artwork_id = ? AND sequence = ? AND party_idx = ?
`);

const deleteAllPartiesForEvent = db.prepare(`
  DELETE FROM provenance_parties WHERE artwork_id = ? AND sequence = ?
`);

const insertParty = db.prepare(`
  INSERT INTO provenance_parties (artwork_id, sequence, party_idx, party_name, party_dates, party_role, party_position, position_method, uncertain)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updatePartiesJson = db.prepare(`
  UPDATE provenance_events SET parties = ? WHERE artwork_id = ? AND sequence = ?
`);

function positionToRole(position) {
  // Map PLOD position to a reasonable role hint
  if (position === "sender") return "seller";
  if (position === "receiver") return "buyer";
  if (position === "agent") return "dealer";
  return null;
}

let splitsDone = 0, renamesDone = 0, deletesDone = 0, errors = 0;

// Group items by event to avoid read-after-write conflicts when multiple
// disambiguations target the same (artwork_id, sequence).
const byEvent = new Map();
for (const item of items) {
  const key = `${item.artwork_id}:${item.event_sequence}`;
  if (!byEvent.has(key)) byEvent.set(key, []);
  byEvent.get(key).push(item);
}

const writeBatch = db.transaction(() => {
  for (const [, eventItems] of byEvent) {
    const { artwork_id, event_sequence: seq } = eventItems[0];

    // Read parties ONCE for this event
    let currentParties = getParties.all(artwork_id, seq);
    if (currentParties.length === 0) {
      console.warn(`  WARN: No parties for artwork ${artwork_id} seq ${seq} — skipping ${eventItems.length} item(s)`);
      errors += eventItems.length;
      continue;
    }

    // Sort by descending origIdx so that splits/deletes don't shift indices
    // of items processed later in the same event.
    eventItems.sort((a, b) => b.original_party_idx - a.original_party_idx);

    // Apply all actions to an in-memory party list, then write once
    let partyList = currentParties.map(p => ({ ...p }));
    let hadError = false;

    for (const item of eventItems) {
      const { original_party_idx: origIdx, action, replacement_parties } = item;
      const origParty = partyList.find((_, i) => {
        // Find the party that originally was at origIdx — we track by scanning
        // the list since indices shift. Use the original party_idx stored in each entry.
        return partyList[i]._origIdx === origIdx;
      }) ?? partyList[origIdx]; // fallback to positional

      // Tag parties with their original index on first pass
      if (!partyList[0]?._origIdx && partyList[0]?._origIdx !== 0) {
        partyList = partyList.map((p, i) => ({ ...p, _origIdx: p.party_idx ?? i }));
      }

      const origEntry = partyList.find(p => p._origIdx === origIdx);
      if (!origEntry) {
        console.warn(`  WARN: No party at idx ${origIdx} for artwork ${artwork_id} seq ${seq} — skipping`);
        errors++;
        hadError = true;
        continue;
      }

      const entryPos = partyList.indexOf(origEntry);

      if (action === "delete") {
        partyList.splice(entryPos, 1);
        deletesDone++;

      } else if (action === "rename") {
        const repl = replacement_parties[0];
        if (!repl) { errors++; hadError = true; continue; }
        partyList[entryPos] = {
          ...origEntry,
          party_name: repl.name,
          party_role: repl.role_hint || positionToRole(repl.position),
          party_position: repl.position,
          position_method: "llm_disambiguation",
        };
        renamesDone++;

      } else if (action === "split") {
        const newParties = replacement_parties.map(repl => ({
          party_name: repl.name,
          party_dates: null,
          party_role: repl.role_hint || positionToRole(repl.position),
          party_position: repl.position,
          position_method: "llm_disambiguation",
          uncertain: origEntry.uncertain,
          _origIdx: -1, // new parties have no original index
        }));
        partyList.splice(entryPos, 1, ...newParties);
        splitsDone++;
      }
    }

    // Write the final party list to DB
    deleteAllPartiesForEvent.run(artwork_id, seq);
    for (let i = 0; i < partyList.length; i++) {
      const p = partyList[i];
      insertParty.run(artwork_id, seq, i, p.party_name, p.party_dates, p.party_role, p.party_position, p.position_method, p.uncertain);
    }
    // Update JSON column
    const jsonParties = partyList.map(p => ({
      name: p.party_name, dates: p.party_dates, uncertain: !!p.uncertain,
      role: p.party_role, position: p.party_position,
    }));
    updatePartiesJson.run(JSON.stringify(jsonParties), artwork_id, seq);
  }
});

writeBatch();

// Version info
db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('party_disambiguation_at', ?)`)
  .run(new Date().toISOString());
db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('party_disambiguation_batch', ?)`)
  .run(data.meta.batchId);
db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('party_disambiguation_count', ?)`)
  .run(String(splitsDone + renamesDone + deletesDone));

db.close();

console.log(`Results:`);
console.log(`  Splits:  ${splitsDone}`);
console.log(`  Renames: ${renamesDone}`);
console.log(`  Deletes: ${deletesDone}`);
console.log(`  Errors:  ${errors}`);
