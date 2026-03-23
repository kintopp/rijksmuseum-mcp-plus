/**
 * Deterministic cleanup of remaining null-position party artifacts.
 *
 * After two LLM enrichment + disambiguation passes, 196 null-position parties
 * remain. Most are repeating parser artifacts (contextual preamble, verb
 * fragments) that can be handled with targeted rules.
 *
 * Usage:
 *   node scripts/writeback-residual-nulls.mjs [--dry-run] [--db PATH]
 */

import Database from "better-sqlite3";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbPath = args.includes("--db") ? args[args.indexOf("--db") + 1] : "data/vocabulary.db";

const db = new Database(dbPath, dryRun ? { readonly: true } : undefined);
if (!dryRun) db.pragma("journal_mode = WAL");

// ─── Rules ──────────────────────────────────────────────────────────
// Each rule: { match, action, ... }
// match: exact party_name string or regex
// action: "delete" | "rename"

const RULES = [
  // Contextual preamble — not parties, delete
  { match: "after closure of the Museum Nusantara in 2013", action: "delete" },
  { match: "after the dissolvement of the museum stored at the Vleeshal", action: "delete" },
  { match: "during a renovation", action: "delete" },
  { match: "post-auction sale", action: "delete" },
  { match: "after 1798", action: "delete" },

  // Verb fragments — "sold", "bequeathed", "with the house/shop" are not parties
  { match: "sold", action: "delete" },
  { match: "bequeathed", action: "delete" },
  { match: "with the house", action: "delete" },
  { match: "with the shop", action: "delete" },

  // Administrative fragments
  { match: "application for an export license for the purpose of sale", action: "delete" },
  { match: /^Vermeld in/, action: "delete" },
  { match: /^\(inv\. no\./, action: "delete" },
  { match: /^BK-KOG-/, action: "delete" },
  { match: /^Note RMA/, action: "delete" },
  { match: /^De Gruyter/, action: "delete" },

  // "or Album XX" — auction lot reference, not a party
  { match: /^or Album /, action: "delete" },

  // "gevonden in de Haarlemmermeer" — found in, not a party
  { match: /^gevonden /, action: "delete" },

  // Price fragments
  { match: /^\$ \(Canadian\)/, action: "delete" },

  // Verb/modifier fragments from round 2 unmatched
  { match: "sold after-sale", action: "delete" },
  { match: "public sale", action: "delete" },
  { match: "probably sale", action: "delete" },
  { match: /^or his sale$/, action: "delete" },
  { match: /^or his son$/, action: "delete" },
  { match: /^or$/, action: "delete" },
  { match: "probably with his collection", action: "delete" },
  { match: "…", action: "delete" },

  // Contextual/descriptive phrases — not parties
  { match: /^sold when .* was sold before demolition/, action: "delete" },
  { match: /^its original context/, action: "delete" },
  { match: /painted and found in/, action: "delete" },
  { match: /^Chimney piece in/, action: "delete" },
  { match: /^the series was subsequently divided/, action: "delete" },
  { match: /^the Mechelen friary was suppressed/, action: "delete" },
  { match: /^pulpit dismantled/, action: "delete" },
  { match: /^list appended to the probate inventory/, action: "delete" },

  // Contextual preamble — reason for transfer, not a party
  { match: /^after closure of the Museum Nusantara/, action: "delete" },

  // Cross-reference / pendant notes
  { match: /^with pendant/, action: "delete" },
  { match: /^with BK-/, action: "delete" },

  // Citation leaks
  { match: /^\{Note RMA/, action: "delete" },

  // "sold through the mediation of..." — agents, but parser artifact
  // The real agent names are embedded; handled as delete (agents already on other party rows)
  { match: "sold through the mediation of the dealers A.E. Cohen and M. Wolff (L. 2610)", action: "delete" },
];

// ─── Find matches ───────────────────────────────────────────────────

const nullParties = db.prepare(`
  SELECT pp.artwork_id, pp.sequence, pp.party_idx, pp.party_name
  FROM provenance_parties pp
  WHERE pp.party_position IS NULL AND pp.position_method IS NULL
  ORDER BY pp.artwork_id, pp.sequence, pp.party_idx
`).all();

const matched = [];
const unmatched = [];

for (const pp of nullParties) {
  let ruleMatched = false;
  for (const rule of RULES) {
    if (typeof rule.match === "string") {
      if (pp.party_name === rule.match) { matched.push({ ...pp, rule }); ruleMatched = true; break; }
    } else {
      if (rule.match.test(pp.party_name)) { matched.push({ ...pp, rule }); ruleMatched = true; break; }
    }
  }
  if (!ruleMatched) unmatched.push(pp);
}

console.log(`Residual null-position cleanup`);
console.log(`  DB:         ${dbPath}`);
console.log(`  Dry run:    ${dryRun}`);
console.log(`  Total null: ${nullParties.length}`);
console.log(`  Matched:    ${matched.length} (will delete)`);
console.log(`  Unmatched:  ${unmatched.length} (left as-is)`);
console.log();

if (unmatched.length > 0) {
  console.log(`Unmatched parties (${unmatched.length}):`);
  for (const pp of unmatched) {
    console.log(`  artwork=${pp.artwork_id} seq=${pp.sequence} idx=${pp.party_idx}: "${pp.party_name}"`);
  }
  console.log();
}

if (dryRun) {
  console.log(`Dry run — no changes written.`);
  db.close();
  process.exit(0);
}

// ─── Apply deletes ──────────────────────────────────────────────────

const getParties = db.prepare(`
  SELECT party_idx, party_name, party_dates, party_role, party_position, position_method, uncertain
  FROM provenance_parties WHERE artwork_id = ? AND sequence = ? ORDER BY party_idx
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

let deleted = 0;

// Group by (artwork_id, sequence) to handle multiple deletes per event
const byEvent = new Map();
for (const m of matched) {
  const key = `${m.artwork_id}:${m.sequence}`;
  if (!byEvent.has(key)) byEvent.set(key, { artwork_id: m.artwork_id, sequence: m.sequence, deleteIdxs: new Set() });
  byEvent.get(key).deleteIdxs.add(m.party_idx);
}

const writeBatch = db.transaction(() => {
  for (const [, { artwork_id, sequence, deleteIdxs }] of byEvent) {
    const currentParties = getParties.all(artwork_id, sequence);
    const remaining = currentParties.filter(p => !deleteIdxs.has(p.party_idx));

    deleteAllPartiesForEvent.run(artwork_id, sequence);
    for (let i = 0; i < remaining.length; i++) {
      const p = remaining[i];
      insertParty.run(artwork_id, sequence, i, p.party_name, p.party_dates, p.party_role, p.party_position, p.position_method, p.uncertain);
    }

    const jsonParties = remaining.map(p => ({
      name: p.party_name, dates: p.party_dates, uncertain: !!p.uncertain,
      role: p.party_role, position: p.party_position,
    }));
    updatePartiesJson.run(JSON.stringify(jsonParties), artwork_id, sequence);

    deleted += deleteIdxs.size;
  }
});

writeBatch();

// Version info
db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('residual_null_cleanup_at', ?)`)
  .run(new Date().toISOString());

db.close();

console.log(`Results:`);
console.log(`  Deleted: ${deleted} artifact parties`);
console.log(`  Remaining null-position: ${unmatched.length}`);
