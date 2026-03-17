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
  parseDate,
  parsePrice,
  parseParty,
  parseLocation,
  parseEvent,
  parseProvenance,
} from "../../dist/provenance.js";

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

// ── Test fixtures ────────────────────────────────────────────────

const PROV_SKA2344 = `? Pieter Claesz van Ruijven (1624-1674) and Maria Simonsdr de Knuijt (1623-1681), Delft; ? their daughter, Magdalena van Ruijven (1655-1682), Delft; ? her widower, Jacob Dissius (1653-1695), Delft;{Montias 1989, pp. 246-262, 359, doc. 417.} his sale, Amsterdam, 16 May 1696, no. 2, fl. 175, to Isaac Rooleeuw (1663-1701), Amsterdam;{Hoet and Terwesten 1752-1770, vol. 1 (1752), p. 34; Montias 1989, p. 363, doc. 439; Grijzenhout 2010, p. 66.} his sale, Amsterdam, 20 April 1701, no. 7, fl. 320;{...} …; sale Jacob van Hoek (1670-1718), Amsterdam, 12 April 1719, no. 20, fl. 126;{...} …; collection Pieter Leendert de Neufville (1707-1759), Amsterdam, after 1752;{...} his son, Leendert Pieter de Neufville (1729-1774?), Amsterdam; sale De Neufville, Amsterdam (J.M. Cok), 19 June 1765, no. 65, fl. 560, to the dealer Yver;{...} …; sale Jean Dulong (?-?), Amsterdam, 18 April 1768, no. 10, fl. 925, to Van Diemen;{...} …; collection Jan Jacob de Bruyn (1720-1792), Amsterdam;{...} his sale, Amsterdam, 12 September 1798, no. 32, fl. 1,550, to the dealer J.A. Spaan;{...} …; sale Hendrik Muilman (1743-1812), Amsterdam, 12 April 1813, no. 96, fl. 2,125, to the dealer J. de Vries for Lucretia Johanna van Winter (1785-1845), Amsterdam;{...} her widower, Jonkheer Hendrik Six (1790-1847), Lord of Hillegom, Amsterdam; their son, Jonkheer Pieter Hendrik Six (1827-1905), Lord of Vromade, Amsterdam;{...} from whose heirs, fl. 550,000, with 38 other paintings, with the support of the Vereniging Rembrandt, to the museum, 1908`;

const PROV_SKA3981 = `…; ? estate inventory, Clara de Valaer (1584-1660), widow successfully of Eduart van Domselaer (1568-1624) and Hendrick van Domselaer (1580/81-1652), Amsterdam, 16 October 1660, as security ('een stuk synde twee pauwen ende een kint van Rembrant');{Bredius 1908, p. 223; Strauss <em>et al.</em> 1979, p. 461, doc. no. 1660/15 } ? estate inventory of her son, Tobias van Domselaer (1611-85), Amsterdam, September 1685 ('een groot schilderij met twee paeuwen van Rembrandt'); {Hofstede de Groot 1906, p. 419, doc. no. 359.} …; ? collection John Blackwood (?-1777), Soho Square, London;{The collector and dealer John Blackwood is known to have imported paintings from the Dutch Republic. His collection is mentioned in his 1777 will, but without specification of the individual works; London, The National Archives, Prerogative Court of Canterbury, inv. no. PROB 11/1036, 19 November 1777, Codicil p. 12.} ? his son, Colonel John Blackwood (?-1780), Cheshunt Nunnery, Hertfordshire;{According to his father's 1777 will, he was to inherit the 'pictures and bronzes and marble busts' in the 'for room up two pair of stairs'.} ? his widow, Catherine Ann Blackwood (? - 1804), Cheshunt Nunnery, Hertfordshire; ? her nephew, William Ralph Cartwright (1771-1850), Aynhoe Park, Northampton;{The collection of paintings and bronzes owned by Catherine Ann Blackwood were bequeathed to her nephew; London, The National Archives, Prerogative Court of Canterbury, inv. no. PROB 11/1405, 29 March 1804. According to The Gentleman's Magazine, XCV (1804), p. 431, the collection inherited by William Ralph Cartwright from his aunt Catherine Ann Blackwood had been formed by John Blackwood (?-1777).} first recorded in his collection in 1819;{Lent in that year to the British Institution's annual exhibition; see British Institution 1824, p. 162, no. 33.} his son, Sir Thomas Cartwright (1795-1850), Aynhoe Park, Northampton; his son, William Cornwallis Cartwright (1825-1915), Aynhoe Park, Northampton; last recorded in his collection in 1915;{Hofstede de Groot VI, 1915, p. 403, no. 968.} from whom purchased by the dealer Frederik Muller, Amsterdam, c. 1915;{Schmidt-Degener 1918, p. 3.} from whom purchased by Jean Joseph Marie Chabot (1857-1944), Rotterdam, Montreux, Brussels and Wassenaar, 1918 (on loan to the museum, November 1923 to 27 July 1942, SK-C-1124-I);{Schmidt-Degener 1918, p. 3.} from whom, with two other paintings, fl. 800,000, to Dr. Erhard Göpel, The Hague, for Adolf Hitler's Führermuseum, Linz, 21 July 1942 (inv. no. 2418);{Schwarz 2004, p. 146, no. XXII/10.} war recuperation, SNK, 9 November 1945 (inv. no. NK 2346);{Schwarz 2004, p. 146, no. XXII/10; MCCP website, no. 4299.} on loan from the SNK to the museum, June 1948 - 1960 (SK-C-1396); transferred to the museum, 1960`;

const PROV_SKA4885 = `Commissioned by Abraham Anthonisz Recht (1588-1664), Amsterdam;{According to an entry in Johannes Wtenbogaert's appointment book dated 13 April 1633: 'Wtgeschildert van Rembrant, voor Abr Anthonissen'; Tideman 1903, p. 127; Strauss <em>et al.</em> 1979, p. 99, doc. no. 1633/2.} estate inventory of his house in the Diemermeer, Watergraafsmeer, 20 October 1664, in the parlor ('1 contrefeijtsel van Johannes Uyttenbogaert f 40.-');{Strauss <em>et al.</em> 1979, p. 531, doc. no. 1664/2; Dudok van Heel 1994, p. 343.} …; collection Conte Girolamo Manfrin (1742-1802), Palazzo Manfrin, Venice;{Wax seal and label on the reverse of the painting.} first mentioned in the Manfrin collection, 1806;{Von der Recke 1819, p. 200.} by descent to Marchesa Bortolina Manfrin Plattis;{Coll. cat. Manfrin Plattis 1851: 'In Stanza segnata D: [no.] 23. Rembrandt. Ritratto con colare bianco'. The number D 23 is recorded on one of the labels on the reverse.} from whom, 8,000 Napoléons, with 14 other paintings, to Alexander Barker (?-1873), London, 1856;{Robertson 1978, p. 316.} by whom probably sold to Baron Mayer Amschel de Rothschild (1818-74), Mentmore Towers, Buckinghamshire, before 1860;{According to an 1883 catalogue of the paintings at Mentmore towers, the painting was acquired before 1860; see the catalogue for the sale, [section Neil Archibald Primrose, 7th Earl of Rosebery], London (Sotheby's), 8 July 1992, no. 86.} his daughter, Hannah Primrose (1851-90), Countess of Rosebery, Mentmore Towers, Buckinghamshire; her husband, Archibald Primrose (1847-1929), 5th Earl of Rosebery, Mentmore Towers, Buckinghamshire; his son, Harry Meyer Archibald Primrose (1882-1974), 6th Earl of Rosebery, Mentmore Towers, Buckinghamshire; his son, Neil Archibald Primrose (1929-), 7th Earl of Rosebery, Mentmore Towers, Buckinghamshire and from 1977 Dalmeny House, near Edinburgh; sale [section Neil Archibald Primrose, 7th Earl of Rosebery], London (Sotheby's), 8 July 1992, no. 86, £ 4,180,000, to the dealers Otto Naumann and Dr Alfred Bader; from whom purchased by the museum, with support from the Vereniging Rembrandt, the Prins Bernhard Fonds, the Stichting VSB Fonds, the Rijksmuseum-Stichting, the State of the Netherlands, and numerous individuals and companies, December 1992`;

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
assertEq(classifyTransfer("his son, Leendert"), "inheritance", "his son → inheritance");
assertEq(classifyTransfer("her widower, Jacob Dissius"), "inheritance", "her widower → inheritance");
assertEq(classifyTransfer("their daughter, Magdalena"), "inheritance", "their daughter → inheritance (via daughter)");
assertEq(classifyTransfer("collection Pieter Leendert"), "collection", "collection → collection");
assertEq(classifyTransfer("Commissioned by Abraham"), "commission", "commissioned → commission");
assertEq(classifyTransfer("war recuperation, SNK"), "recuperation", "war recuperation → recuperation");
assertEq(classifyTransfer("to Dr. Erhard Göpel for Adolf Hitler's Führermuseum"), "confiscation", "Führermuseum → confiscation");
assertEq(classifyTransfer("on loan from the SNK"), "loan", "on loan → loan");
assertEq(classifyTransfer("transferred to the museum"), "transfer", "transferred → transfer");
assertEq(classifyTransfer("from whom purchased by the dealer"), "purchase", "from whom purchased → purchase");
assertEq(classifyTransfer("from whose heirs, fl. 550,000, to the museum, 1908"), "purchase", "from whose heirs to museum → purchase");
assertEq(classifyTransfer("her nephew, William Ralph Cartwright"), "inheritance", "her nephew → inheritance");

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
//  Section 8: parseProvenance — SK-A-2344 (The Milkmaid)
// ══════════════════════════════════════════════════════════════════

section("8. parseProvenance — SK-A-2344 (The Milkmaid)");

{
  const chain = parseProvenance(PROV_SKA2344);
  assert(chain.events.length >= 14, `event count ≥14 (got ${chain.events.length})`);

  // First event: uncertain Pieter Claesz van Ruijven
  const e1 = chain.events[0];
  assertEq(e1.uncertain, true, "first event uncertain (?)");
  assertEq(e1.location, "Delft", "first event location Delft");
  assertEq(e1.sequence, 1, "first event sequence 1");

  // Sale event with price and buyer (Dissius sale, 1696)
  const saleEvent = chain.events.find(
    e => e.transferType === "sale" && e.date?.year === 1696
  );
  assert(saleEvent !== undefined, "1696 sale event found");
  assertEq(saleEvent?.price?.amount, 175, "1696 sale price fl. 175");
  assertEq(saleEvent?.price?.currency, "guilders", "guilders currency");
  assertEq(saleEvent?.location, "Amsterdam", "1696 sale in Amsterdam");
  assert(saleEvent?.saleDetails?.includes("no. 2"), "lot number in sale details");

  // Gap events
  const gaps = chain.events.filter(e => e.gap);
  assert(gaps.length >= 4, `at least 4 gaps (got ${gaps.length})`);

  // Collection event
  const collEvent = chain.events.find(e => e.transferType === "collection");
  assert(collEvent !== undefined, "collection event found");

  // Last event: purchase by museum, 1908
  const last = chain.events[chain.events.length - 1];
  assertEq(last.transferType, "purchase", "last event is purchase");
  assertEq(last.date?.year, 1908, "museum purchase 1908");
  assertEq(last.price?.amount, 550000, "museum purchase price fl. 550,000");
}

// ══════════════════════════════════════════════════════════════════
//  Section 9: parseProvenance — SK-A-3981 (Still Life with Peacocks)
// ══════════════════════════════════════════════════════════════════

section("9. parseProvenance — SK-A-3981 (Still Life with Peacocks)");

{
  const chain = parseProvenance(PROV_SKA3981);
  assert(chain.events.length >= 12, `event count ≥12 (got ${chain.events.length})`);

  // Confiscation event (Führermuseum)
  const confEvent = chain.events.find(e => e.transferType === "confiscation");
  assert(confEvent !== undefined, "confiscation event found");
  assertEq(confEvent?.date?.year, 1942, "confiscation 1942");

  // War recuperation
  const recupEvent = chain.events.find(e => e.transferType === "recuperation");
  assert(recupEvent !== undefined, "recuperation event found");
  assertEq(recupEvent?.date?.year, 1945, "recuperation 1945");

  // Loan event
  const loanEvent = chain.events.find(e => e.transferType === "loan");
  assert(loanEvent !== undefined, "loan event found");

  // Transfer to museum
  const transferEvent = chain.events.find(e => e.transferType === "transfer");
  assert(transferEvent !== undefined, "transfer event found");
  assertEq(transferEvent?.date?.year, 1960, "transfer 1960");

  // HTML stripping (et al. in citations)
  const rawTexts = chain.events.map(e => e.rawText).join(" ");
  assert(!rawTexts.includes("<em>"), "no <em> tags in rawText (HTML stripped)");

  // Purchase event: from whom purchased by dealer
  const purchEvent = chain.events.find(e => e.transferType === "purchase");
  assert(purchEvent !== undefined, "purchase event found (dealer Muller)");
}

// ══════════════════════════════════════════════════════════════════
//  Section 10: parseProvenance — SK-A-4885 (Johannes Wtenbogaert)
// ══════════════════════════════════════════════════════════════════

section("10. parseProvenance — SK-A-4885 (Johannes Wtenbogaert)");

{
  const chain = parseProvenance(PROV_SKA4885);
  assert(chain.events.length >= 10, `event count ≥10 (got ${chain.events.length})`);

  // Commission origin
  const commEvent = chain.events.find(e => e.transferType === "commission");
  assert(commEvent !== undefined, "commission event found");
  assertEq(commEvent?.party?.role, "patron", "commission party is patron");
  assert(commEvent?.party?.name?.includes("Abraham"), "patron name Abraham");

  // Sotheby's sale with £ price
  const saleEvent = chain.events.find(
    e => e.transferType === "sale" && e.price?.currency === "pounds"
  );
  assert(saleEvent !== undefined, "Sotheby's sale with £ found");
  assertEq(saleEvent?.price?.amount, 4180000, "£4,180,000");
  assertEq(saleEvent?.date?.year, 1992, "sale 1992");

  // Napoléons price
  const napEvent = chain.events.find(e => e.price?.currency === "napoléons");
  assert(napEvent !== undefined, "Napoléons price event found");
  assertEq(napEvent?.price?.amount, 8000, "8,000 Napoléons");

  // Inheritance events (Primrose family)
  const inhEvents = chain.events.filter(e => e.transferType === "inheritance");
  assert(inhEvents.length >= 4, `≥4 inheritance events (got ${inhEvents.length})`);

  // Venice location
  const veniceEvent = chain.events.find(e => e.location === "Venice");
  assert(veniceEvent !== undefined, "Venice location found");

  // Last event: museum purchase December 1992
  const last = chain.events[chain.events.length - 1];
  assertEq(last.transferType, "purchase", "last event is purchase");
  assertEq(last.date?.year, 1992, "museum purchase December 1992");
}

// ══════════════════════════════════════════════════════════════════
//  Section 11: Edge cases
// ══════════════════════════════════════════════════════════════════

section("11. Edge cases");

{
  const chain = parseProvenance(null);
  assertEq(chain.events.length, 0, "null input → empty events");
}

{
  const chain = parseProvenance("");
  assertEq(chain.events.length, 0, "empty string → empty events");
}

{
  const chain = parseProvenance(undefined);
  assertEq(chain.events.length, 0, "undefined → empty events");
}

{
  const chain = parseProvenance("single owner, no semicolons");
  assertEq(chain.events.length, 1, "single segment without semicolons");
  assertEq(chain.events[0].sequence, 1, "sequence starts at 1");
}

{
  const chain = parseProvenance("A; B; C");
  assertEq(chain.events.length, 3, "simple three-segment chain");
  assertEq(chain.events[2].sequence, 3, "third event sequence 3");
}

{
  // Verify citations are restored in rawText
  const chain = parseProvenance("owner;{cite 1} next owner");
  const hasRawCitation = chain.events.some(e => e.rawText.includes("{cite 1}"));
  assert(hasRawCitation, "citations restored in rawText");
}

// ══════════════════════════════════════════════════════════════════
//  Section 12: Expanded transfer classification (audit-driven)
// ══════════════════════════════════════════════════════════════════

section("12. Expanded transfer classification");

// "by whom sold" → sale
assertEq(classifyTransfer("by whom sold to Edward Gray"), "sale", "by whom sold → sale");
assertEq(classifyTransfer("by whom sold, 1883"), "sale", "by whom sold (no buyer) → sale");

// "bought by" → purchase
assertEq(classifyTransfer("bought by Mr Carter, for Henry Doetsch"), "purchase", "bought by → purchase");

// "from whom, fl. X, to Y" → sale
assertEq(classifyTransfer("from whom, fl. 4,000, to Jeronimo de Vries"), "sale", "from whom + price + to → sale");
assertEq(classifyTransfer("from whom, fl. 1,800,000, to the museum"), "sale", "from whom + to museum → sale");

// "given by" / "presented by" → gift
assertEq(classifyTransfer("Given by the artist to Andries Bonger"), "gift", "given by → gift");
assertEq(classifyTransfer("Presented by the artist to the sitter"), "gift", "presented by → gift");

// "with an art dealer" → collection
assertEq(classifyTransfer("with an art dealer, Paris"), "collection", "with art dealer → collection");

// "estate inventory" → collection (after ? stripping)
assertEq(classifyTransfer("Estate inventory, Eberhard Jabach"), "collection", "Estate inventory → collection");

// "his grandson" → inheritance
assertEq(classifyTransfer("his grandson, Count Sergei"), "inheritance", "his grandson → inheritance");

// "his sons" (plural) → inheritance
assertEq(classifyTransfer("his sons, Jonkheer Jan Pieter Six and Jonkheer Pieter Hendrik Six"), "inheritance", "his sons (plural) → inheritance");

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
  const chain = parseProvenance("? Estate inventory, Eberhard Jabach (1618-95), Paris, 17 July 1696");
  assertEq(chain.events[0].uncertain, true, "? prefix → uncertain");
  assertEq(chain.events[0].transferType, "collection", "? Estate inventory → collection (? stripped)");
}

{
  // "? Presented by" — gift with uncertainty
  const chain = parseProvenance("? Presented by the artist to Don Ramón Satué, Madrid, 1823");
  assertEq(chain.events[0].transferType, "gift", "? Presented by → gift");
  assertEq(chain.events[0].uncertain, true, "uncertain gift");
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
