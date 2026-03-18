/**
 * Analyse 100 provenance records from the vocab DB to catalog patterns.
 * Outputs a pattern inventory for PEG grammar design.
 */
import Database from "better-sqlite3";
import { parseProvenance } from "../dist/provenance.js";

const db = new Database("data/vocabulary.db", { readonly: true });

// Stratified sample: 5-10 semicolons, spread across types
const rows = db.prepare(`
  WITH prov AS (
    SELECT a.art_id, a.object_number, a.provenance_text,
      (LENGTH(provenance_text) - LENGTH(REPLACE(provenance_text, ';', ''))) as semicolons
    FROM artworks a
    WHERE a.provenance_text IS NOT NULL
      AND (LENGTH(provenance_text) - LENGTH(REPLACE(provenance_text, ';', ''))) BETWEEN 4 AND 9
  ),
  typed AS (
    SELECT p.*, COALESCE(v.label_en, v.label_nl) as type_label
    FROM prov p
    JOIN mappings m ON m.artwork_id = p.art_id
    JOIN field_lookup f ON f.id = m.field_id AND f.name = 'type'
    JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
  )
  SELECT object_number, type_label, semicolons, provenance_text
  FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY type_label ORDER BY RANDOM()) as rn
    FROM typed
  )
  WHERE (type_label = 'drawing' AND rn <= 30)
     OR (type_label = 'painting' AND rn <= 25)
     OR (type_label IN ('sculpture', 'figure') AND rn <= 8)
     OR (type_label IN ('print', 'ontwerp', 'aquarel') AND rn <= 5)
     OR (type_label IN ('vase', 'cloth', 'furniture', 'bowl', 'box', 'miniature') AND rn <= 3)
  ORDER BY type_label, semicolons DESC
`).all();

db.close();

// ─── Pattern counters ─────────────────────────────────────────────

const patterns = {
  // Citations & notes
  curlyBraceCitations: 0,      // {Note RMA}
  numberedFootnotes: 0,        // [1]
  
  // Gaps
  ellipsisGaps: 0,             // … or ...
  periodGaps: 0,               // . as gap (CMOA style)
  
  // Dates
  exactDates: 0,               // 16 May 1696
  yearOnly: 0,                 // , 1908
  circaDates: 0,               // c. 1915
  beforeAfterDates: 0,         // before 1860, after 1752
  dateRanges: 0,               // 1940-1945
  monthYear: 0,                // February 1982
  
  // Temporal qualifiers (4-bound candidates)
  byDate: 0,                   // "by 1960" → EOTB
  untilDate: 0,                // "until 1908" → EOTE
  sometimeBetween: 0,          // "sometime between X and Y"
  atLeast: 0,                  // "at least until"
  
  // Life dates
  parenLifeDates: 0,           // (1624-1674)
  bracketLifeDates: 0,         // [1624-1674]
  unknownBirthDeath: 0,        // (?-?), (1729-?)
  
  // Transfer types
  sale: 0,
  purchase: 0,
  inheritance: 0,
  bequest: 0,
  gift: 0,
  commission: 0,
  confiscation: 0,
  loan: 0,
  transfer: 0,
  exchange: 0,
  consignment: 0,
  deposit: 0,
  theft: 0,
  restitution: 0,
  
  // Parties
  dealers: 0,                  // "dealer", "art dealer"
  auctioneers: 0,              // "Christie's", "Sotheby's" etc
  museums: 0,                  // "museum", "Rijksmuseum"
  royalty: 0,                  // "King", "Prince", "Queen"
  anaphoric: 0,                // "his son", "her widow"
  theArtist: 0,                // "the artist"
  unknownParty: 0,             // "unknown"
  
  // Locations
  locations: 0,
  
  // Prices
  guilders: 0,
  pounds: 0,
  francs: 0,
  dollars: 0,
  otherCurrency: 0,
  
  // HTML
  htmlTags: 0,                 // <em>, <i>
  
  // Special
  enBloc: 0,                   // "en bloc"
  warRecuperation: 0,          // "war recuperation"
  lotNumbers: 0,               // "no. 157", "lot 25"
  lugtNumbers: 0,              // "L. 2602d"
  crossReferences: 0,          // "See the provenance for..."
  multipleStatements: 0,       // provenance_text contains " | "
  
  // Uncertainty
  uncertaintyQuestion: 0,      // ? prefix
  uncertaintyPossibly: 0,      // "possibly", "probably"
};

// Track unique examples for each pattern
const examples = {};
function track(key, text, objNum) {
  patterns[key]++;
  if (!examples[key]) examples[key] = [];
  if (examples[key].length < 3) {
    examples[key].push({ objNum, snippet: text.slice(0, 120) });
  }
}

// ─── Analyse each record ──────────────────────────────────────────

let totalEvents = 0;
let unknownTransferCount = 0;
let nullPartyCount = 0;

for (const row of rows) {
  const text = row.provenance_text;
  
  // Cross-references
  if (/^See the provenance for/i.test(text)) {
    track("crossReferences", text, row.object_number);
    continue;
  }
  
  // Multiple statements (pipe-separated)
  if (text.includes(" | ")) track("multipleStatements", text, row.object_number);
  
  // HTML
  if (/<\/?(?:em|i|b|strong)[^>]*>/i.test(text)) track("htmlTags", text, row.object_number);
  
  // Citations
  const curlyCount = (text.match(/\{[^}]+\}/g) || []).length;
  if (curlyCount > 0) track("curlyBraceCitations", text, row.object_number);
  const bracketNoteCount = (text.match(/\[\d+\]/g) || []).length;
  if (bracketNoteCount > 0) track("numberedFootnotes", text, row.object_number);
  
  // Gaps
  if (/[…]|\.{3}/.test(text)) track("ellipsisGaps", text, row.object_number);
  
  // Dates
  if (/\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/.test(text))
    track("exactDates", text, row.object_number);
  if (/,\s*\d{4}\b/.test(text)) track("yearOnly", text, row.object_number);
  if (/\bc\.\s*\d{4}/.test(text)) track("circaDates", text, row.object_number);
  if (/\b(?:before|after)\s+\d{4}/i.test(text)) track("beforeAfterDates", text, row.object_number);
  if (/\d{4}\s*[-–]\s*\d{4}/.test(text) && !/\(\d{4}[-–]\d{4}\)/.test(text))
    track("dateRanges", text, row.object_number);
  if (/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/.test(text))
    track("monthYear", text, row.object_number);
  
  // 4-bound date candidates
  if (/\bby\s+\d{4}/i.test(text)) track("byDate", text, row.object_number);
  if (/\buntil\s+\d{4}/i.test(text)) track("untilDate", text, row.object_number);
  if (/sometime\s+between/i.test(text)) track("sometimeBetween", text, row.object_number);
  if (/at\s+least/i.test(text)) track("atLeast", text, row.object_number);
  
  // Life dates
  if (/\(\d{4}[-–]\d{4}\)/.test(text)) track("parenLifeDates", text, row.object_number);
  if (/\[\d{4}[-–]\d{4}\]/.test(text)) track("bracketLifeDates", text, row.object_number);
  if (/\(\?[-–]|\[-–]\?|[-–]\?\)/.test(text)) track("unknownBirthDeath", text, row.object_number);
  
  // Transfer types (scan full text)
  if (/\bsale\b/i.test(text)) track("sale", text, row.object_number);
  if (/\bpurchas/i.test(text)) track("purchase", text, row.object_number);
  if (/\binherit|\bby descent|\bson\b|\bdaughter\b|\bwidow/i.test(text)) track("inheritance", text, row.object_number);
  if (/\bbequest|\bbequeath/i.test(text)) track("bequest", text, row.object_number);
  if (/\bgift\b|\bdonat|\bgiven by|\bpresented/i.test(text)) track("gift", text, row.object_number);
  if (/\bcommission/i.test(text)) track("commission", text, row.object_number);
  if (/\bconfiscat/i.test(text)) track("confiscation", text, row.object_number);
  if (/\bloan\b/i.test(text)) track("loan", text, row.object_number);
  if (/\btransferred/i.test(text)) track("transfer", text, row.object_number);
  if (/\bexchange\b/i.test(text)) track("exchange", text, row.object_number);
  if (/\bconsign/i.test(text)) track("consignment", text, row.object_number);
  if (/\bdeposit/i.test(text)) track("deposit", text, row.object_number);
  if (/\bstolen\b|\btheft\b|\blooted/i.test(text)) track("theft", text, row.object_number);
  if (/\brestitut/i.test(text)) track("restitution", text, row.object_number);
  
  // Parties
  if (/\bdealer\b/i.test(text)) track("dealers", text, row.object_number);
  if (/Christie|Sotheby|Bonham|Phillips|Dorotheum|Frederik Muller|Mak van Waay|auction/i.test(text))
    track("auctioneers", text, row.object_number);
  if (/\bmuseum\b|\bRijksmuseum\b|\bRMA\b/i.test(text)) track("museums", text, row.object_number);
  if (/\bKing\b|\bPrince\b|\bQueen\b|\bEmperor\b|\bStadhouder\b|\bStadtholder\b/i.test(text))
    track("royalty", text, row.object_number);
  if (/\bhis\s+(?:son|daughter|widow|nephew|grandson)/i.test(text)) track("anaphoric", text, row.object_number);
  if (/\bthe artist\b/i.test(text)) track("theArtist", text, row.object_number);
  if (/\bunknown\b/i.test(text)) track("unknownParty", text, row.object_number);
  
  // Prices
  if (/\bfl\.\s*[\d,]/.test(text)) track("guilders", text, row.object_number);
  if (/£\s*[\d,]/.test(text)) track("pounds", text, row.object_number);
  if (/\bfrs?\.\s*[\d,]/.test(text)) track("francs", text, row.object_number);
  if (/\$\s*[\d,]/.test(text)) track("dollars", text, row.object_number);
  if (/\blivres\b|\bnapo[lé]/i.test(text)) track("otherCurrency", text, row.object_number);
  
  // Special
  if (/en bloc/i.test(text)) track("enBloc", text, row.object_number);
  if (/war recuperation/i.test(text)) track("warRecuperation", text, row.object_number);
  if (/\bno\.\s*\d+|\blot\s+\d+/i.test(text)) track("lotNumbers", text, row.object_number);
  if (/\bL\.\s*\d+/i.test(text)) track("lugtNumbers", text, row.object_number);
  
  // Uncertainty
  if (/^\s*\?/.test(text) || /;\s*\?/.test(text)) track("uncertaintyQuestion", text, row.object_number);
  if (/\bpossibly\b|\bprobably\b/i.test(text)) track("uncertaintyPossibly", text, row.object_number);
  
  // Locations — count any city name
  if (/\b(?:Amsterdam|London|Paris|The Hague|Berlin|Vienna|Rome|New York|Brussels|Rotterdam)\b/.test(text))
    track("locations", text, row.object_number);
  
  // Parse with current parser and count unknowns
  const chain = parseProvenance(text);
  totalEvents += chain.events.length;
  for (const ev of chain.events) {
    if (ev.transferType === "unknown") unknownTransferCount++;
    if (!ev.party) nullPartyCount++;
  }
}

// ─── Output ───────────────────────────────────────────────────────

console.log(`\n## Provenance Pattern Inventory (${rows.length} records, ${totalEvents} events)\n`);
console.log(`Current parser: ${unknownTransferCount}/${totalEvents} unknown transfer type (${(100*unknownTransferCount/totalEvents).toFixed(1)}%), ${nullPartyCount}/${totalEvents} null party (${(100*nullPartyCount/totalEvents).toFixed(1)}%)\n`);

const categories = {
  "Citations & Notes": ["curlyBraceCitations", "numberedFootnotes"],
  "Gaps": ["ellipsisGaps", "periodGaps"],
  "Date Formats": ["exactDates", "yearOnly", "circaDates", "beforeAfterDates", "dateRanges", "monthYear"],
  "4-Bound Date Candidates": ["byDate", "untilDate", "sometimeBetween", "atLeast"],
  "Life Dates": ["parenLifeDates", "bracketLifeDates", "unknownBirthDeath"],
  "Transfer Types": ["sale", "purchase", "inheritance", "bequest", "gift", "commission", "confiscation", "loan", "transfer", "exchange", "consignment", "deposit", "theft", "restitution"],
  "Party Types": ["dealers", "auctioneers", "museums", "royalty", "anaphoric", "theArtist", "unknownParty"],
  "Prices": ["guilders", "pounds", "francs", "dollars", "otherCurrency"],
  "HTML & Special": ["htmlTags", "enBloc", "warRecuperation", "lotNumbers", "lugtNumbers", "crossReferences", "multipleStatements"],
  "Uncertainty": ["uncertaintyQuestion", "uncertaintyPossibly"],
  "Locations": ["locations"],
};

for (const [cat, keys] of Object.entries(categories)) {
  console.log(`### ${cat}\n`);
  console.log("| Pattern | Count | % of records |");
  console.log("|---------|-------|-------------|");
  for (const key of keys) {
    const count = patterns[key];
    const pct = (100 * count / rows.length).toFixed(1);
    console.log(`| ${key} | ${count} | ${pct}% |`);
  }
  // Show examples for patterns that appear
  for (const key of keys) {
    if (examples[key]?.length > 0) {
      console.log(`\n**${key} examples:**`);
      for (const ex of examples[key]) {
        console.log(`- \`${ex.objNum}\`: ${ex.snippet}…`);
      }
    }
  }
  console.log("");
}
