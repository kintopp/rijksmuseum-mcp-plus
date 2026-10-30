/**
 * Unit tests for the provenance parser.
 *
 * Run:  node scripts/tests/test-provenance-parser.mjs
 * Requires: npm run build (imports from dist/)
 */

import {
  extractCitations,
  splitEvents,
  stripHtml,
  classifyTransfer,
  parseEvent,
} from "../../dist/provenance.js";

// The field parsers are private to provenance.ts; each event field is exactly
// one of them applied to the segment text, so reach them through parseEvent.
const ev = (text) => parseEvent({ text, gap: false }, 1, new Map());
const parseDate = (text) => ev(text).date;
const parsePrice = (text) => ev(text).price;
const parseParty = (text) => ev(text).party;
const parseLocation = (text) => ev(text).location;

// ── Test helpers ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function assertEq(actual, expected, msg) {
  const ok = actual === expected;
  assert(ok, ok ? msg : `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertDeepEq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, ok ? msg : `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(name) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${"═".repeat(60)}`);
}

// ══════════════════════════════════════════════════════════════════
//  Section 1: extractCitations
// ══════════════════════════════════════════════════════════════════

section("1. extractCitations");

{
  const { cleaned, citations } = extractCitations("hello {world} test");
  assertEq(citations.size, 1, "single citation extracted");
  assertEq(citations.get("__CIT_0__"), "world", "citation text captured");
  assert(cleaned.includes("__CIT_0__"), "placeholder inserted");
  assert(!cleaned.includes("{"), "braces removed");
}

{
  const { cleaned, citations } = extractCitations(
    "A;{cite 1; cite 2} B;{cite 3}"
  );
  assertEq(citations.size, 2, "multiple citations extracted");
  assertEq(citations.get("__CIT_0__"), "cite 1; cite 2", "semicolon inside citation preserved");
  assert(cleaned.includes("__CIT_1__"), "second placeholder present");
}

{
  const { citations } = extractCitations("no citations here");
  assertEq(citations.size, 0, "no citations returns empty map");
}

{
  const { citations } = extractCitations("{...}");
  assertEq(citations.get("__CIT_0__"), "...", "ellipsis citation captured");
}

// ══════════════════════════════════════════════════════════════════
//  Section 2: splitEvents
// ══════════════════════════════════════════════════════════════════

section("2. splitEvents");

{
  const events = splitEvents("A; B; C");
  assertEq(events.length, 3, "basic split on semicolons");
  assertEq(events[0].text, "A", "first segment text");
  assertEq(events[0].gap, false, "no gap on first");
}

{
  const events = splitEvents("A;{...} …; B");
  const bEvent = events.find(e => e.text.includes("B"));
  assert(bEvent !== undefined, "B segment found after gap");
  assert(bEvent?.gap === true, "gap detected after ellipsis");
}

{
  const events = splitEvents("");
  assertEq(events.length, 0, "empty string returns no events");
}

{
  const events = splitEvents("single segment");
  assertEq(events.length, 1, "single segment without semicolons");
  assertEq(events[0].gap, false, "single segment no gap");
}

{
  // Unicode ellipsis
  const events = splitEvents("A; …; B");
  const bEvent = events.find(e => e.text === "B");
  assert(bEvent?.gap === true, "unicode ellipsis marks gap");
}

// Fragment filtering (2026-03-21)
{
  const events = splitEvents("A; 1824; B");
  assertEq(events.length, 2, "bare year '1824' filtered as fragment");
  assertEq(events[0].text, "A", "fragment filter keeps A");
  assertEq(events[1].text, "B", "fragment filter keeps B");
}
{
  const events = splitEvents("A; et al.; B");
  assertEq(events.length, 2, "'et al.' filtered as fragment");
}
{
  const events = splitEvents("Inv.; A; B");
  assertEq(events.length, 2, "'Inv.' still filtered");
}

// ══════════════════════════════════════════════════════════════════
//  Section 3: stripHtml
// ══════════════════════════════════════════════════════════════════

section("3. stripHtml");

assertEq(stripHtml("<em>et al.</em>"), "et al.", "strips <em> tags");
assertEq(stripHtml("no tags"), "no tags", "no tags passthrough");
assertEq(stripHtml("<i>italic</i> and <b>bold</b>"), "italic and bold", "multiple tag types");
assertEq(stripHtml("Strauss <em>et al.</em> 1979"), "Strauss et al. 1979", "inline em preserved text");

// ══════════════════════════════════════════════════════════════════
//  Section 4: classifyTransfer
// ══════════════════════════════════════════════════════════════════

section("4. classifyTransfer");

assertEq(classifyTransfer("his sale, Amsterdam, 16 May 1696"), "sale", "his sale → sale");
assertEq(classifyTransfer("sale Jacob van Hoek"), "sale", "sale Name → sale");
assertEq(classifyTransfer("his son, Leendert"), "by_descent", "his son → inheritance");
assertEq(classifyTransfer("her widower, Jacob Dissius"), "widowhood", "her widower → inheritance");
assertEq(classifyTransfer("their daughter, Magdalena"), "by_descent", "their daughter → inheritance (via daughter)");
assertEq(classifyTransfer("collection Pieter Leendert"), "collection", "collection → collection");
assertEq(classifyTransfer("Commissioned by Abraham"), "commission", "commissioned → commission");
assertEq(classifyTransfer("war recuperation, SNK"), "recuperation", "war recuperation → recuperation");
assertEq(classifyTransfer("to Dr. Erhard Göpel for Adolf Hitler's Führermuseum"), "confiscation", "Führermuseum → confiscation");
assertEq(classifyTransfer("on loan from the SNK"), "loan", "on loan → loan");
assertEq(classifyTransfer("transferred to the museum"), "transfer", "transferred → transfer");
assertEq(classifyTransfer("from whom purchased by the dealer"), "sale", "from whom purchased → purchase");
assertEq(classifyTransfer("from whose heirs, fl. 550,000, to the museum, 1908"), "sale", "from whose heirs to museum → purchase");
assertEq(classifyTransfer("her nephew, William Ralph Cartwright"), "by_descent", "her nephew → inheritance");

// ══════════════════════════════════════════════════════════════════
//  Section 5: parseDate
// ══════════════════════════════════════════════════════════════════

section("5. parseDate");

{
  const d = parseDate("his sale, Amsterdam, 16 May 1696, no. 2");
  assertEq(d?.year, 1696, "exact date year");
  assertEq(d?.text, "16 May 1696", "exact date text");
  assertEq(d?.approximate, false, "exact not approximate");
  assertEq(d?.qualifier, null, "exact no qualifier");
}

{
  const d = parseDate("collection after 1752");
  assertEq(d?.year, 1752, "after year");
  assertEq(d?.qualifier, "after", "after qualifier");
}

{
  const d = parseDate("before 1860");
  assertEq(d?.year, 1860, "before year");
  assertEq(d?.qualifier, "before", "before qualifier");
}

{
  const d = parseDate("from whom purchased, c. 1915");
  assertEq(d?.year, 1915, "approximate year");
  assertEq(d?.approximate, true, "c. is approximate");
  assertEq(d?.qualifier, "circa", "circa qualifier");
}

{
  const d = parseDate("to the museum, 1908");
  assertEq(d?.year, 1908, "bare year at end");
}

{
  const d = parseDate("no date information here at all");
  assertEq(d, null, "no date returns null");
}

// ══════════════════════════════════════════════════════════════════
//  Section 6: parsePrice
// ══════════════════════════════════════════════════════════════════

section("6. parsePrice");

{
  const p = parsePrice("fl. 175");
  assertEq(p?.amount, 175, "guilders simple");
  assertEq(p?.currency, "guilders", "guilders currency");
}

{
  const p = parsePrice("fl. 1,550");
  assertEq(p?.amount, 1550, "guilders with comma");
}

{
  const p = parsePrice("fl. 550,000");
  assertEq(p?.amount, 550000, "guilders large amount");
}

{
  const p = parsePrice("£ 4,180,000");
  assertEq(p?.amount, 4180000, "pounds large");
  assertEq(p?.currency, "pounds", "pounds currency");
}

{
  const p = parsePrice("8,000 Napoléons");
  assertEq(p?.amount, 8000, "napoléons");
  assertEq(p?.currency, "napoléons", "napoléons currency");
}

{
  const p = parsePrice("no price here");
  assertEq(p, null, "no price returns null");
}

// ══════════════════════════════════════════════════════════════════
//  Section 7: parseParty
// ══════════════════════════════════════════════════════════════════

section("7. parseParty");

{
  const p = parseParty("? Pieter Claesz van Ruijven (1624-1674) and Maria, Delft");
  assert(p !== null, "party extracted from uncertain name+dates");
  assertEq(p?.uncertain, true, "uncertain flag from ?");
  assertEq(p?.dates, "1624-1674", "life dates extracted");
  assert(p?.name?.includes("Pieter"), "name contains Pieter");
}

{
  const p = parseParty("his son, Jonkheer Pieter Hendrik Six (1827-1905), Lord of Vromade");
  assertEq(p?.role, "his son", "anaphoric role");
  assert(p?.name?.includes("Pieter Hendrik Six"), "name from anaphora");
  assertEq(p?.dates, "1827-1905", "dates from anaphora");
}

{
  const p = parseParty("Commissioned by Abraham Anthonisz Recht (1588-1664), Amsterdam");
  assertEq(p?.role, "patron", "commission patron role");
  assert(p?.name?.includes("Abraham"), "patron name");
}

{
  const p = parseParty("from whom purchased by the dealer Frederik Muller, Amsterdam");
  assertEq(p?.role, "buyer", "buyer from 'from whom purchased'");
  assert(p?.name?.includes("Frederik Muller"), "buyer name");
}

{
  const p = parseParty("sale Jean Dulong (?-?), Amsterdam");
  assertEq(p?.role, "seller", "sale → seller role");
  assertEq(p?.dates, "?-?", "unknown dates");
}

{
  const p = parseParty("collection Jan Jacob de Bruyn (1720-1792), Amsterdam");
  assertEq(p?.role, "collector", "collection → collector role");
}

{
  const p = parseParty("war recuperation, SNK");
  assertEq(p, null, "war recuperation has no party");
}

// ══════════════════════════════════════════════════════════════════
//  Section 11: Edge cases
// ══════════════════════════════════════════════════════════════════

section("11. Edge cases");

{
  // Verify citations are restored in rawText
  const { cleaned, citations } = extractCitations("owner;{cite 1} next owner");
  const events = splitEvents(cleaned).map((seg, i) => parseEvent(seg, i + 1, citations));
  assert(events.some(e => e.rawText.includes("{cite 1}")), "citations restored in rawText");
}

// ══════════════════════════════════════════════════════════════════
//  Section 12: Expanded transfer classification (audit-driven)
// ══════════════════════════════════════════════════════════════════

section("12. Expanded transfer classification");

// "by whom sold" → sale
assertEq(classifyTransfer("by whom sold to Edward Gray"), "sale", "by whom sold → sale");
assertEq(classifyTransfer("by whom sold, 1883"), "sale", "by whom sold (no buyer) → sale");

// "bought by" → purchase
assertEq(classifyTransfer("bought by Mr Carter, for Henry Doetsch"), "sale", "bought by → purchase");

// "from whom, fl. X, to Y" → sale
assertEq(classifyTransfer("from whom, fl. 4,000, to Jeronimo de Vries"), "sale", "from whom + price + to → sale");
assertEq(classifyTransfer("from whom, fl. 1,800,000, to the museum"), "sale", "from whom + to museum → sale");

// "given by" / "presented by" → gift
assertEq(classifyTransfer("Given by the artist to Andries Bonger"), "gift", "given by → gift");
assertEq(classifyTransfer("Presented by the artist to the sitter"), "gift", "presented by → gift");

// "with an art dealer" → collection
assertEq(classifyTransfer("with an art dealer, Paris"), "collection", "with art dealer → collection");

// "estate inventory" → collection (after ? stripping)
assertEq(classifyTransfer("Estate inventory, Eberhard Jabach"), "inventory", "Estate inventory → collection");

// "his grandson" → inheritance
assertEq(classifyTransfer("his grandson, Count Sergei"), "by_descent", "his grandson → inheritance");

// "his sons" (plural) → inheritance
assertEq(classifyTransfer("his sons, Jonkheer Jan Pieter Six and Jonkheer Pieter Hendrik Six"), "by_descent", "his sons (plural) → inheritance");

// #172: bare "acquired" should NOT classify as sale
assertEq(classifyTransfer("Otto Schäfer, Schweinfurt"), "unknown", "#172: bare name not classified as sale");
assertEq(classifyTransfer("Jhr. J. Goll van Franckenstein (L.2987; 1750-1821)"), "unknown", "#172: collector mark not classified as sale");
// But "acquired by/from" should still work
assertEq(classifyTransfer("acquired by the museum, 1900"), "sale", "#172: 'acquired by' still classified as sale");
assertEq(classifyTransfer("acquired from the dealer, 1850"), "sale", "#172: 'acquired from' still classified as sale");

// ══════════════════════════════════════════════════════════════════
//  Section 13: Expanded price parsing
// ══════════════════════════════════════════════════════════════════

section("13. Expanded price parsing");

{
  const p = parsePrice("frs. 300,000");
  assertEq(p?.amount, 300000, "francs amount");
  assertEq(p?.currency, "francs", "francs currency");
}

{
  const p = parsePrice("24,000 livres");
  assertEq(p?.amount, 24000, "livres amount");
  assertEq(p?.currency, "livres", "livres currency");
}

// ══════════════════════════════════════════════════════════════════
//  Section 14: Expanded party parsing
// ══════════════════════════════════════════════════════════════════

section("14. Expanded party parsing");

{
  const p = parseParty("by whom sold to Edward Gray (?-1838), Harrington");
  assertEq(p?.role, "buyer", "by whom sold → buyer role");
  assert(p?.name?.includes("Edward Gray"), "buyer name from 'by whom sold to'");
  assertEq(p?.dates, "?-1838", "buyer dates");
}

{
  const p = parseParty("bought by Mr Carter, for Henry Doetsch");
  assertEq(p?.role, "buyer", "bought by → buyer role");
  assert(p?.name?.includes("Mr Carter"), "bought by name");
}

{
  const p = parseParty("Given by the artist to Andries Bonger (1861-1936), Hilversum");
  assertEq(p?.role, "donor", "given by → donor role");
  assert(p?.name?.includes("artist"), "donor name");
}

{
  const p = parseParty("his grandson, Count Sergei Alexandrovich Stroganoff (1852-1923), St Petersburg");
  assertEq(p?.role, "his grandson", "grandson anaphoric role");
  assert(p?.name?.includes("Stroganoff"), "grandson name");
  assertEq(p?.dates, "1852-1923", "grandson dates");
}

{
  const p = parseParty("his sons, Jonkheer Jan Pieter Six (1824-1899), Lord of Hillegom");
  assertEq(p?.role, "his sons", "sons (plural) anaphoric role");
}

// ══════════════════════════════════════════════════════════════════
//  Section 15: Uncertainty stripping for classifyTransfer
// ══════════════════════════════════════════════════════════════════

section("15. Uncertainty + classification");

{
  // "? Estate inventory" — the ? should be stripped before classification
  const event = ev("? Estate inventory, Eberhard Jabach (1618-95), Paris, 17 July 1696");
  assertEq(event.uncertain, true, "? prefix → uncertain");
  assertEq(event.transferType, "inventory", "? Estate inventory → inventory (? stripped)");
}

{
  // "? Presented by" — gift with uncertainty
  const event = ev("? Presented by the artist to Don Ramón Satué, Madrid, 1823");
  assertEq(event.transferType, "gift", "? Presented by → gift");
  assertEq(event.uncertain, true, "uncertain gift");
}

// ══════════════════════════════════════════════════════════════════
//  Section 16: Expanded locations
// ══════════════════════════════════════════════════════════════════

section("16. Expanded locations");

assertEq(parseLocation("Count Stroganoff, St Petersburg"), "St Petersburg", "St Petersburg");
assertEq(parseLocation("Don Ramón Satué, Madrid, 1823"), "Madrid", "Madrid");
assertEq(parseLocation("Duveen Brothers, London and New York"), "London", "London (first match)");
assertEq(parseLocation("Andries Bonger, Hilversum"), "Hilversum", "Hilversum");
assertEq(parseLocation("Palazzo Manfrin, Venice"), "Venice", "Venice unchanged");

// ══════════════════════════════════════════════════════════════════
//  Section 17: Additional transfer patterns (second audit round)
// ══════════════════════════════════════════════════════════════════

section("17. Additional transfer patterns");

assertEq(classifyTransfer("by whom to Duveen Brothers, London and New York, 1919"), "sale", "by whom to → sale");
assertEq(classifyTransfer("from the dealer Christian Josi, to the museum, fl. 600"), "sale", "from the dealer + to → sale");
assertEq(
  classifyTransfer("from Count Alexander Sergeievich Stroganoff, with two other paintings, 24,000 livres, to Count Alexander"),
  "sale", "from Count + to Count → sale"
);

{
  const p = parseParty("by whom to Duveen Brothers, London and New York, 1919");
  assertEq(p?.role, "buyer", "by whom to → buyer");
  assert(p?.name?.includes("Duveen"), "buyer name Duveen");
}

{
  const p = parseParty("from the dealer Christian Josi, to the museum, fl. 600, 1824");
  assertEq(p?.role, "seller", "from the dealer → seller");
  assert(p?.name?.includes("Christian Josi"), "seller name Josi");
}

// ══════════════════════════════════════════════════════════════════
//  Summary
// ══════════════════════════════════════════════════════════════════

console.log(`\n${"═".repeat(60)}`);
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(60)}`);
if (failures.length) {
  console.log("\nFailed assertions:");
  for (const f of failures) console.log(`  • ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
