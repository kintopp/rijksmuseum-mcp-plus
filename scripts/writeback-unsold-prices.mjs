/**
 * Extract prices from unsold/bought-in events (#161).
 *
 * Pattern: "bought in at fl. 1,700" → price_amount=1700, price_currency="guilders"
 * 598 events have "bought in at" with no parsed price.
 *
 * Usage:
 *   node scripts/writeback-unsold-prices.mjs [--dry-run] [--db PATH]
 */

import Database from "better-sqlite3";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbPath = args.includes("--db") ? args[args.indexOf("--db") + 1] : "data/vocabulary.db";

// ─── Currency mapping (sync with provenance.ts parsePrice) ──────────

const CURRENCY_MAP = {
  "fl": "guilders", "fl.": "guilders",
  "£": "pounds", "gns": "guineas",
  "fr": "francs", "fr.": "francs", "frs": "francs", "frs.": "francs",
  "RM": "reichsmark", "RM.": "reichsmark",
  "Bfr": "belgian_francs", "Bfr.": "belgian_francs",
  "DM": "deutschmark",
};

// ─── Price extraction regex ─────────────────────────────────────────

// Match "bought in at fl. 1,700" or "bought in at £245" or "bought in at frs. 140,000"
const PRICE_RE = /bought\s+in\s+at\s+(fl\.?|£|gns?|fr[s]?\.?|RM\.?|Bfr\.?|DM)\s*([\d,]+(?:\.\d+)?)/i;

// ─── Main ───────────────────────────────────────────────────────────

const db = new Database(dbPath, dryRun ? { readonly: true } : undefined);
if (!dryRun) db.pragma("journal_mode = WAL");

const rows = db.prepare(`
  SELECT artwork_id, sequence, raw_text
  FROM provenance_events
  WHERE unsold = 1 AND price_amount IS NULL AND raw_text LIKE '%bought in at%'
`).all();

console.log(`Unsold price extraction (#161)`);
console.log(`  DB:       ${dbPath}`);
console.log(`  Dry run:  ${dryRun}`);
console.log(`  Matching: ${rows.length} events`);
console.log();

const extracted = [];
const noMatch = [];

for (const row of rows) {
  const match = PRICE_RE.exec(row.raw_text);
  if (match) {
    const currencyRaw = match[1].replace(/\.$/, ""); // strip trailing dot for lookup
    const currency = CURRENCY_MAP[currencyRaw] || CURRENCY_MAP[match[1]] || currencyRaw;
    const amount = parseFloat(match[2].replace(/,/g, ""));
    if (!isNaN(amount)) {
      extracted.push({ ...row, amount, currency, currencyRaw: match[1] });
    } else {
      noMatch.push({ ...row, reason: `parsed NaN from "${match[2]}"` });
    }
  } else {
    noMatch.push({ ...row, reason: "regex no match" });
  }
}

// ─── Stats ──────────────────────────────────────────────────────────

const currencyCounts = {};
for (const e of extracted) {
  currencyCounts[e.currency] = (currencyCounts[e.currency] || 0) + 1;
}

console.log(`Extracted: ${extracted.length}`);
for (const [cur, cnt] of Object.entries(currencyCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cur}: ${cnt}`);
}
console.log(`No match:  ${noMatch.length}`);
for (const nm of noMatch.slice(0, 5)) {
  console.log(`  ${nm.reason}: "${nm.raw_text.substring(0, 100)}..."`);
}
console.log();

if (dryRun) {
  // Show sample extractions
  console.log(`Sample extractions:`);
  for (const e of extracted.slice(0, 10)) {
    const snippet = e.raw_text.substring(e.raw_text.indexOf("bought in"), e.raw_text.indexOf("bought in") + 40);
    console.log(`  ${e.currencyRaw} ${e.amount.toLocaleString()} (${e.currency}) ← "${snippet}"`);
  }
  console.log(`\nDry run — no changes written.`);
  db.close();
  process.exit(0);
}

// ─── Write to DB ────────────────────────────────────────────────────

const updateStmt = db.prepare(`
  UPDATE provenance_events
  SET price_amount = ?, price_currency = ?
  WHERE artwork_id = ? AND sequence = ? AND price_amount IS NULL
`);

let updated = 0;
const writeBatch = db.transaction((rows) => {
  for (const row of rows) {
    const result = updateStmt.run(row.amount, row.currency, row.artwork_id, row.sequence);
    if (result.changes > 0) updated++;
  }
});

writeBatch(extracted);

// Version info
db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('unsold_price_extraction_at', ?)`)
  .run(new Date().toISOString());
db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('unsold_price_extraction_count', ?)`)
  .run(String(updated));

db.close();

console.log(`Results:`);
console.log(`  Updated: ${updated}`);
console.log(`  Version info updated.`);
