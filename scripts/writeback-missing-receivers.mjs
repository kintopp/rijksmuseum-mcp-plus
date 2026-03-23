/**
 * Extract missing receiver parties from provenance event text (#116).
 *
 * ~843 events have "to the [Name]" or "to [Name]" in the tail but no receiver
 * party was captured by the parser. Most are deterministic patterns:
 *   - "donated by X to the Vereniging van Vrienden der Aziatische Kunst"
 *   - "fl. 500, to the museum"
 *   - "to the dealer P. de Boer"
 *
 * Usage:
 *   node scripts/writeback-missing-receivers.mjs [--dry-run] [--db PATH]
 */

import Database from "better-sqlite3";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbPath = args.includes("--db") ? args[args.indexOf("--db") + 1] : "data/vocabulary.db";

// ─── Receiver extraction ────────────────────────────────────────────

// Match "to the [Name/Institution]" or "to [Name]" in tail
// Capture the receiver name, stopping at:
//   - comma + year (", 1906")
//   - ", as " (attribution)
//   - ", with " (lot grouping)
//   - ", but " (condition)
//   - end of string
// Skip "to the catalogue" (false positive — catalogue reference, not a receiver)
const TO_THE_RE = /\bto the (catalogue)\b/i;

function extractReceiver(rawText) {
  // Skip "to the catalogue" false positives
  if (TO_THE_RE.test(rawText)) return null;

  // Try "to the [Institution/Name]" first
  // Stop at: comma+year, comma+keyword, comma+currency, period+closing, or end
  let match = rawText.match(
    /\bto the\s+((?:dealer|dealers)\s+)?(.+?)(?:,\s*(?:January|February|March|April|May|June|July|August|September|October|November|December)\s|,\s*(?:19|20|18|17|16|15|14)\d{2}\b|,\s*(?:as|with|but|for|in|through|on|who)\s|,\s*(?:fl\.|£|gns|DM|RM|CHF|Bfr)\s|[.}]\s*$|\s*$)/i
  );
  if (match) {
    const isDealer = !!match[1];
    let name = match[2].trim();
    // Clean up trailing punctuation and truncate at curly braces or parenthetical notes
    name = name.replace(/[,;.]+$/, "").trim();
    name = name.replace(/\s*\{.*$/, "").trim();  // truncate at citation
    name = name.replace(/\s*\(L\.\s*\d+\).*$/, "").trim();  // truncate at Lugt number
    name = name.replace(/\s+through the mediation.*$/i, "").trim();  // truncate at mediation clause
    name = name.replace(/\s+with support.*$/i, "").trim();  // truncate at support clause
    name = name.replace(/\s+with \d+.*$/i, "").trim();  // truncate at "with N other..."
    name = name.replace(/,\s*\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December).*$/i, "").trim();  // truncate at day+month date
    if (!name || name.length < 2) return null;
    // Skip names over 100 chars (likely extraction error)
    if (name.length > 100) return null;
    // Skip if it's just a preposition or article
    if (/^(?:a|an|the|de|het|een|van|von)$/i.test(name)) return null;
    return {
      name,
      role: isDealer ? "dealer" : "buyer",
      position: isDealer ? "agent" : "receiver",
    };
  }

  // Try "to [Capitalized Name]" (without "the")
  match = rawText.match(
    /\bto\s+([A-Z][A-Za-zÀ-ÿ\-'. ]+?)(?:,\s*(?:19|20|18|17|16|15|14)\d{2}\b|,\s*(?:as|with|but|for|in|through|on)\s|,\s*(?:fl\.|£|gns|DM|RM|CHF|Bfr)\s|\s*$)/i
  );
  if (match) {
    let name = match[1].trim();
    name = name.replace(/[,;.]+$/, "").trim();
    if (!name || name.length < 2) return null;
    // Skip common non-names
    if (/^(?:Amsterdam|London|Paris|Berlin|The Hague|Rotterdam|Utrecht|Leiden|Delft|Haarlem|Antwerp|Brussels|Rome|Florence|Venice|Vienna|Munich|Dresden|Prague|Madrid|Lisbon|Stockholm|Copenhagen|Moscow|St Petersburg|New York|Washington|Boston|Philadelphia|Chicago)$/i.test(name)) return null;
    return {
      name,
      role: "buyer",
      position: "receiver",
    };
  }

  return null;
}

// ─── Main ───────────────────────────────────────────────────────────

const db = new Database(dbPath, dryRun ? { readonly: true } : undefined);
if (!dryRun) db.pragma("journal_mode = WAL");

// Find events with "to the" but no receiver party
const events = db.prepare(`
  SELECT pe.artwork_id, pe.sequence, pe.transfer_type, pe.raw_text, pe.parties as parties_json
  FROM provenance_events pe
  WHERE pe.transfer_type IN ('sale','gift','bequest','transfer','recuperation','restitution','exchange')
    AND pe.is_cross_ref = 0
    AND pe.raw_text LIKE '%to the %'
    AND NOT EXISTS (
      SELECT 1 FROM provenance_parties pp
      WHERE pp.artwork_id = pe.artwork_id AND pp.sequence = pe.sequence
        AND pp.party_position = 'receiver'
    )
  ORDER BY pe.artwork_id, pe.sequence
`).all();

// Also find "to [Name]" without "the" (sale events)
const events2 = db.prepare(`
  SELECT pe.artwork_id, pe.sequence, pe.transfer_type, pe.raw_text, pe.parties as parties_json
  FROM provenance_events pe
  WHERE pe.transfer_type IN ('sale','gift','bequest','transfer','recuperation','restitution','exchange')
    AND pe.is_cross_ref = 0
    AND pe.raw_text LIKE '%, to %'
    AND pe.raw_text NOT LIKE '%to the %'
    AND NOT EXISTS (
      SELECT 1 FROM provenance_parties pp
      WHERE pp.artwork_id = pe.artwork_id AND pp.sequence = pe.sequence
        AND pp.party_position = 'receiver'
    )
  ORDER BY pe.artwork_id, pe.sequence
`).all();

const allEvents = [...events, ...events2];
// Deduplicate by (artwork_id, sequence)
const seen = new Set();
const unique = allEvents.filter(e => {
  const key = `${e.artwork_id}:${e.sequence}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

console.log(`Missing receiver extraction (#116)`);
console.log(`  DB:        ${dbPath}`);
console.log(`  Dry run:   ${dryRun}`);
console.log(`  Candidate events: ${unique.length}`);
console.log();

const extracted = [];
const skipped = { falsePositive: 0, noMatch: 0 };
const noMatchSamples = [];

for (const event of unique) {
  const receiver = extractReceiver(event.raw_text);
  if (receiver) {
    extracted.push({ ...event, receiver });
  } else if (TO_THE_RE.test(event.raw_text)) {
    skipped.falsePositive++;
  } else {
    skipped.noMatch++;
    if (noMatchSamples.length < 10) {
      noMatchSamples.push(event.raw_text.substring(0, 120));
    }
  }
}

// ─── Stats ──────────────────────────────────────────────────────────

const roleCounts = {};
for (const e of extracted) {
  const key = `${e.receiver.position}:${e.receiver.role}`;
  roleCounts[key] = (roleCounts[key] || 0) + 1;
}

// Top receiver names
const nameCounts = {};
for (const e of extracted) nameCounts[e.receiver.name] = (nameCounts[e.receiver.name] || 0) + 1;
const topNames = Object.entries(nameCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);

console.log(`Extracted: ${extracted.length}`);
for (const [role, cnt] of Object.entries(roleCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${role}: ${cnt}`);
}
console.log(`\nTop receiver names:`);
for (const [name, cnt] of topNames) {
  console.log(`  ${name}: ${cnt}`);
}
console.log(`\nSkipped: ${skipped.falsePositive} false positives, ${skipped.noMatch} no match`);
if (noMatchSamples.length > 0) {
  console.log(`\nNo-match samples:`);
  for (const s of noMatchSamples) console.log(`  "${s}..."`);
}
console.log();

if (dryRun) {
  console.log(`Dry run — no changes written.`);
  db.close();
  process.exit(0);
}

// ─── Write to DB ────────────────────────────────────────────────────

const getMaxPartyIdx = db.prepare(`
  SELECT COALESCE(MAX(party_idx), -1) as max_idx
  FROM provenance_parties WHERE artwork_id = ? AND sequence = ?
`);

const insertParty = db.prepare(`
  INSERT INTO provenance_parties (
    artwork_id, sequence, party_idx, party_name, party_dates, party_role,
    party_position, position_method, uncertain, enrichment_reasoning
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'llm_enrichment', 0, ?)
`);

const updatePartiesJson = db.prepare(`
  UPDATE provenance_events SET parties = ? WHERE artwork_id = ? AND sequence = ?
`);

let inserted = 0;

const writeBatch = db.transaction((rows) => {
  for (const row of rows) {
    const { artwork_id, sequence, receiver, parties_json } = row;

    // Get next party_idx
    const maxIdx = getMaxPartyIdx.get(artwork_id, sequence).max_idx;
    const newIdx = maxIdx + 1;

    // Insert party
    const reasoning = `Extracted from event text: receiver "${receiver.name}" found in "to the/to [Name]" pattern. Parser's parseRest() missed this tail party.`;
    insertParty.run(artwork_id, sequence, newIdx, receiver.name, null, receiver.role, receiver.position, reasoning);

    // Update parties JSON
    let parties = [];
    try { parties = JSON.parse(parties_json || "[]"); } catch { /* empty */ }
    parties.push({
      name: receiver.name,
      dates: null,
      uncertain: false,
      role: receiver.role,
      position: receiver.position,
    });
    updatePartiesJson.run(JSON.stringify(parties), artwork_id, sequence);

    inserted++;
  }
});

writeBatch(extracted);

// Version info
db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('receiver_extraction_at', ?)`)
  .run(new Date().toISOString());
db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('receiver_extraction_count', ?)`)
  .run(String(inserted));

db.close();

console.log(`Results:`);
console.log(`  Inserted: ${inserted} receiver parties`);
console.log(`  Version info updated.`);
