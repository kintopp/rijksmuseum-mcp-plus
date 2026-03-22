/**
 * Tests for PEG provenance parser (Layer 1) and interpretation (Layer 2).
 *
 * Run:  node scripts/tests/test-provenance-peg.mjs
 * Requires: npm run build (imports from dist/)
 */

import { parseProvenanceRaw } from "../../dist/provenance-peg.js";
import { interpretPeriods, parseTemporalBounds } from "../../dist/provenance-interpret.js";
import { parseProvenance } from "../../dist/provenance.js";

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

function section(name) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${"═".repeat(60)}`);
}

// ── Fixtures ────────────────────────────────────────────────────

const PROV_SKA2344 = `? Pieter Claesz van Ruijven (1624-1674) and Maria Simonsdr de Knuijt (1623-1681), Delft; ? their daughter, Magdalena van Ruijven (1655-1682), Delft; ? her widower, Jacob Dissius (1653-1695), Delft;{Montias 1989, pp. 246-262, 359, doc. 417.} his sale, Amsterdam, 16 May 1696, no. 2, fl. 175, to Isaac Rooleeuw (1663-1701), Amsterdam;{Hoet and Terwesten 1752-1770, vol. 1 (1752), p. 34; Montias 1989, p. 363, doc. 439; Grijzenhout 2010, p. 66.} his sale, Amsterdam, 20 April 1701, no. 7, fl. 320;{...} …; sale Jacob van Hoek (1670-1718), Amsterdam, 12 April 1719, no. 20, fl. 126;{...} …; collection Pieter Leendert de Neufville (1707-1759), Amsterdam, after 1752;{...} his son, Leendert Pieter de Neufville (1729-1774?), Amsterdam; sale De Neufville, Amsterdam (J.M. Cok), 19 June 1765, no. 65, fl. 560, to the dealer Yver;{...} …; sale Jean Dulong (?-?), Amsterdam, 18 April 1768, no. 10, fl. 925, to Van Diemen;{...} …; collection Jan Jacob de Bruyn (1720-1792), Amsterdam;{...} his sale, Amsterdam, 12 September 1798, no. 32, fl. 1,550, to the dealer J.A. Spaan;{...} …; sale Hendrik Muilman (1743-1812), Amsterdam, 12 April 1813, no. 96, fl. 2,125, to the dealer J. de Vries for Lucretia Johanna van Winter (1785-1845), Amsterdam;{...} her widower, Jonkheer Hendrik Six (1790-1847), Lord of Hillegom, Amsterdam; their son, Jonkheer Pieter Hendrik Six (1827-1905), Lord of Vromade, Amsterdam;{...} from whose heirs, fl. 550,000, with 38 other paintings, with the support of the Vereniging Rembrandt, to the museum, 1908`;

const PROV_SKA3981 = `…; ? estate inventory, Clara de Valaer (1584-1660), widow successfully of Eduart van Domselaer (1568-1624) and Hendrick van Domselaer (1580/81-1652), Amsterdam, 16 October 1660, as security ('een stuk synde twee pauwen ende een kint van Rembrant');{Bredius 1908, p. 223; Strauss <em>et al.</em> 1979, p. 461, doc. no. 1660/15 } ? estate inventory of her son, Tobias van Domselaer (1611-85), Amsterdam, September 1685 ('een groot schilderij met twee paeuwen van Rembrandt'); {Hofstede de Groot 1906, p. 419, doc. no. 359.} …; ? collection John Blackwood (?-1777), Soho Square, London;{The collector and dealer John Blackwood is known to have imported paintings from the Dutch Republic. His collection is mentioned in his 1777 will, but without specification of the individual works; London, The National Archives, Prerogative Court of Canterbury, inv. no. PROB 11/1036, 19 November 1777, Codicil p. 12.} ? his son, Colonel John Blackwood (?-1780), Cheshunt Nunnery, Hertfordshire;{According to his father's 1777 will, he was to inherit the 'pictures and bronzes and marble busts' in the 'for room up two pair of stairs'.} ? his widow, Catherine Ann Blackwood (? - 1804), Cheshunt Nunnery, Hertfordshire; ? her nephew, William Ralph Cartwright (1771-1850), Aynhoe Park, Northampton;{The collection of paintings and bronzes owned by Catherine Ann Blackwood were bequeathed to her nephew; London, The National Archives, Prerogative Court of Canterbury, inv. no. PROB 11/1405, 29 March 1804. According to The Gentleman's Magazine, XCV (1804), p. 431, the collection inherited by William Ralph Cartwright from his aunt Catherine Ann Blackwood had been formed by John Blackwood (?-1777).} first recorded in his collection in 1819;{Lent in that year to the British Institution's annual exhibition; see British Institution 1824, p. 162, no. 33.} his son, Sir Thomas Cartwright (1795-1850), Aynhoe Park, Northampton; his son, William Cornwallis Cartwright (1825-1915), Aynhoe Park, Northampton; last recorded in his collection in 1915;{Hofstede de Groot VI, 1915, p. 403, no. 968.} from whom purchased by the dealer Frederik Muller, Amsterdam, c. 1915;{Schmidt-Degener 1918, p. 3.} from whom purchased by Jean Joseph Marie Chabot (1857-1944), Rotterdam, Montreux, Brussels and Wassenaar, 1918 (on loan to the museum, November 1923 to 27 July 1942, SK-C-1124-I);{Schmidt-Degener 1918, p. 3.} from whom, with two other paintings, fl. 800,000, to Dr. Erhard Göpel, The Hague, for Adolf Hitler's Führermuseum, Linz, 21 July 1942 (inv. no. 2418);{Schwarz 2004, p. 146, no. XXII/10.} war recuperation, SNK, 9 November 1945 (inv. no. NK 2346);{Schwarz 2004, p. 146, no. XXII/10; MCCP website, no. 4299.} on loan from the SNK to the museum, June 1948 - 1960 (SK-C-1396); transferred to the museum, 1960`;

// ══════════════════════════════════════════════════════════════════
//  Phase A: Compatibility gate — PEG output matches regex on fixtures
// ══════════════════════════════════════════════════════════════════

section("Phase A: Compatibility gate");

{
  // SK-A-2344 (The Milkmaid)
  const raw = parseProvenanceRaw(PROV_SKA2344);
  const regex = parseProvenance(PROV_SKA2344);

  assertEq(raw.events.length, regex.events.length,
    `SK-A-2344: event count matches (${raw.events.length})`);

  // Check key events match
  for (let i = 0; i < Math.min(raw.events.length, regex.events.length); i++) {
    const r = raw.events[i];
    const x = regex.events[i];
    assertEq(r.gap, x.gap, `SK-A-2344 event ${i + 1}: gap matches`);
  }

  // 1696 sale event
  const sale1696 = raw.events.find(e => e.dateYear === 1696 && e.transferType === "sale");
  assert(sale1696 !== undefined, "SK-A-2344: 1696 sale found via PEG");
  assertEq(sale1696?.price?.amount, 175, "SK-A-2344: 1696 sale price fl. 175");
  assertEq(sale1696?.location, "Amsterdam", "SK-A-2344: 1696 sale location");

  // Gaps
  const gaps = raw.events.filter(e => e.gap);
  assert(gaps.length >= 4, `SK-A-2344: ≥4 gaps (got ${gaps.length})`);

  // Last event: purchase 1908
  const last = raw.events[raw.events.length - 1];
  assertEq(last.transferType, "sale", "SK-A-2344: last event is purchase");
  assertEq(last.dateYear, 1908, "SK-A-2344: museum purchase 1908");

  // Stats
  assert(raw.stats.peg > 0, `SK-A-2344: PEG parsed ${raw.stats.peg} events`);
  console.log(`    → PEG: ${raw.stats.peg}, fallback: ${raw.stats.fallback}`);
}

{
  // SK-A-3981 (Still Life with Peacocks)
  const raw = parseProvenanceRaw(PROV_SKA3981);
  const regex = parseProvenance(PROV_SKA3981);

  assertEq(raw.events.length, regex.events.length,
    `SK-A-3981: event count matches (${raw.events.length})`);

  // Confiscation: regex parser classified "from whom...Führermuseum" as confiscation via keyword;
  // PEG correctly classifies it as "sale" (structural: "from whom, to X"). Both are valid —
  // the confiscation semantic is a Layer 2 concern. Accept either.
  const confEvent = raw.events.find(e => e.transferType === "confiscation" ||
    (e.transferType === "sale" && e.rawText?.includes("Führermuseum")));
  assert(confEvent !== undefined, "SK-A-3981: Führermuseum event found (sale or confiscation)");

  // War recuperation
  const recupEvent = raw.events.find(e => e.transferType === "recuperation");
  assert(recupEvent !== undefined, "SK-A-3981: recuperation found");

  // Transfer to museum
  const transferEvent = raw.events.find(e => e.transferType === "transfer");
  assert(transferEvent !== undefined, "SK-A-3981: transfer found");
  assertEq(transferEvent?.dateYear, 1960, "SK-A-3981: transfer 1960");

  console.log(`    → PEG: ${raw.stats.peg}, fallback: ${raw.stats.fallback}`);
}

// ══════════════════════════════════════════════════════════════════
//  Phase B: Layer 1 — PEG-specific tests
// ══════════════════════════════════════════════════════════════════

section("Phase B: Layer 1 — PEG-specific");

{
  // Multi-party extraction: sale with buyer
  const raw = parseProvenanceRaw(
    "sale Jacob van Hoek (1670-1718), Amsterdam, 12 April 1719, no. 20, fl. 126, to Isaac Rooleeuw"
  );
  const e = raw.events[0];
  assertEq(e.parseMethod, "peg", "sale segment parsed by PEG");
  assertEq(e.transferType, "sale", "transfer type: sale");

  const seller = e.parties.find(p => p.role === "seller");
  assert(seller !== undefined, "seller party extracted");
  assert(seller?.name?.includes("Jacob van Hoek"), "seller name");
  assertEq(seller?.dates, "1670-1718", "seller dates");

  const buyer = e.parties.find(p => p.role === "buyer");
  assert(buyer !== undefined, "buyer party extracted from 'to' clause");
  assert(buyer?.name?.includes("Isaac Rooleeuw"), "buyer name");
}

{
  // Raw date expression preserved
  const raw = parseProvenanceRaw("collection Pieter de Neufville, Amsterdam, after 1752");
  const e = raw.events[0];
  assertEq(e.dateExpression, "after 1752", "date expression preserved raw");
  assertEq(e.dateYear, 1752, "date year extracted");
  assertEq(e.dateQualifier, "after", "date qualifier extracted");
}

{
  // PEG parse failure → regex fallback
  // Deliberately malformed to trigger fallback
  const raw = parseProvenanceRaw("");
  assertEq(raw.events.length, 0, "empty input → no events");
}

{
  // Null/undefined input
  const r1 = parseProvenanceRaw(null);
  assertEq(r1.events.length, 0, "null → no events");
  const r2 = parseProvenanceRaw(undefined);
  assertEq(r2.events.length, 0, "undefined → no events");
}

{
  // Commission event
  const raw = parseProvenanceRaw("Commissioned by Abraham Anthonisz Recht (1588-1664), Amsterdam");
  const e = raw.events[0];
  assertEq(e.transferType, "commission", "commission type");
  const patron = e.parties.find(p => p.role === "patron");
  assert(patron !== undefined, "patron party extracted");
  assert(patron?.name?.includes("Abraham"), "patron name");
}

{
  // War recuperation — SNK now captured as party
  const raw = parseProvenanceRaw("war recuperation, SNK, 9 November 1945");
  const e = raw.events[0];
  assertEq(e.transferType, "recuperation", "recuperation type");
  assertEq(e.parties.length, 1, "SNK captured as party in recuperation");
  assertEq(e.parties[0]?.name, "SNK", "recuperation party name = SNK");
}

{
  // Anaphoric: "his son, Name (dates)"
  const raw = parseProvenanceRaw("his son, Leendert Pieter de Neufville (1729-1774?), Amsterdam");
  const e = raw.events[0];
  assertEq(e.transferType, "by_descent", "anaphoric → by_descent");
  assert(e.parties.length >= 1, "anaphoric party extracted");
  assertEq(e.parties[0]?.role, "his son", "anaphoric role");
}

{
  // Possessive sale: "his sale, Location, Date, ..."
  const raw = parseProvenanceRaw("his sale, Amsterdam, 16 May 1696, no. 2, fl. 175, to Isaac Rooleeuw (1663-1701)");
  const e = raw.events[0];
  assertEq(e.transferType, "sale", "possessive sale type");
  assertEq(e.price?.amount, 175, "possessive sale price");

  const buyer = e.parties.find(p => p.role === "buyer");
  assert(buyer !== undefined, "buyer from possessive sale 'to' clause");
}

{
  // Collection event
  const raw = parseProvenanceRaw("collection Jan Jacob de Bruyn (1720-1792), Amsterdam");
  const e = raw.events[0];
  assertEq(e.transferType, "collection", "collection type");
  const collector = e.parties.find(p => p.role === "collector");
  assert(collector !== undefined, "collector role assigned");
  assertEq(collector?.dates, "1720-1792", "collector dates");
}

{
  // Confiscation via Führermuseum
  const raw = parseProvenanceRaw("to Dr. Erhard Göpel, The Hague, for Adolf Hitler's Führermuseum, Linz, 21 July 1942");
  const e = raw.events[0];
  // This may fall through to generic since it doesn't start with "confiscated" or "Führermuseum"
  // The regex parser catches this via keyword anywhere in text
  // PEG may or may not catch it — log the parse method
  console.log(`    → Führermuseum mid-text: parseMethod=${e.parseMethod}, type=${e.transferType}`);
}

{
  // Loan event
  const raw = parseProvenanceRaw("on loan from the SNK to the museum, June 1948 - 1960");
  const e = raw.events[0];
  assertEq(e.transferType, "loan", "loan type");
}

{
  // Transfer to museum
  const raw = parseProvenanceRaw("transferred to the museum, 1960");
  const e = raw.events[0];
  assertEq(e.transferType, "transfer", "transfer type");
  assertEq(e.dateYear, 1960, "transfer date");
}

{
  // Purchase: "from whom purchased by dealer Name"
  const raw = parseProvenanceRaw("from whom purchased by the dealer Frederik Muller, Amsterdam, c. 1915");
  const e = raw.events[0];
  assertEq(e.transferType, "sale", "from whom purchased → sale");
  const buyer = e.parties.find(p => p.role === "buyer");
  assert(buyer !== undefined, "buyer extracted from 'from whom purchased'");
  assert(buyer?.name?.includes("Frederik Muller"), "buyer name Muller");
}

{
  // "from whose heirs" → purchase
  const raw = parseProvenanceRaw("from whose heirs, fl. 550,000, with 38 other paintings, to the museum, 1908");
  const e = raw.events[0];
  assertEq(e.transferType, "sale", "from whose heirs → sale");
  assertEq(e.price?.amount, 550000, "purchase price fl. 550,000");
}

// ══════════════════════════════════════════════════════════════════
//  Phase C: Layer 2 — interpretation tests
// ══════════════════════════════════════════════════════════════════

section("Phase C: Layer 2 — interpretation");

{
  // Temporal bound parsing
  const t1 = parseTemporalBounds("1808", 1808, null);
  assertEq(t1.earliest, 1808, "exact: earliest=1808");
  assertEq(t1.latest, 1808, "exact: latest=1808");
  assertEq(t1.rule, "exact_year", "exact rule");

  const t2 = parseTemporalBounds("after 1945", 1945, "after");
  assertEq(t2.earliest, 1945, "after: earliest=1945");
  assertEq(t2.latest, null, "after: latest=null");
  assertEq(t2.rule, "after_year", "after rule");

  const t3 = parseTemporalBounds("before 1800", 1800, "before");
  assertEq(t3.earliest, null, "before: earliest=null");
  assertEq(t3.latest, 1800, "before: latest=1800");

  const t4 = parseTemporalBounds("c. 1700", 1700, "circa");
  assertEq(t4.earliest, 1690, "circa: earliest=1690");
  assertEq(t4.latest, 1710, "circa: latest=1710");

  const t5 = parseTemporalBounds("by 1960", null, null);
  assertEq(t5.earliest, null, "by: earliest=null");
  assertEq(t5.latest, 1960, "by: latest=1960");
  assertEq(t5.rule, "by_year", "by rule");

  const t6 = parseTemporalBounds(null, null, null);
  assertEq(t6.earliest, null, "no date: earliest=null");
  assertEq(t6.latest, null, "no date: latest=null");
}

{
  // Period reconstruction from SK-A-2344
  const raw = parseProvenanceRaw(PROV_SKA2344);
  const periods = interpretPeriods(raw.events);

  assert(periods.length >= 14, `SK-A-2344: ≥14 periods (got ${periods.length})`);
  assertEq(periods[0].sequence, 1, "first period sequence=1");
  assertEq(periods[0].uncertain, true, "first period uncertain");

  // End date inference: first period's end should be inferred from second period
  const p1 = periods[0];
  if (periods[1]?.beginYear) {
    // End year should be inferred from next event
    assert(
      p1.derivation.end_year === "inferred_from_next" || p1.endYear === null,
      "first period end_year derivation is inferred or null"
    );
  }

  // Last period: museum purchase 1908
  const lastP = periods[periods.length - 1];
  assertEq(lastP.acquisitionMethod, "sale", "last period: acquisition=purchase");
  assertEq(lastP.beginYear, 1908, "last period: beginYear=1908");
}

{
  // Role assignment: sale with seller and buyer
  const raw = parseProvenanceRaw(
    "sale Jacob van Hoek (1670-1718), Amsterdam, 12 April 1719, no. 20, fl. 126, to Isaac Rooleeuw"
  );
  const periods = interpretPeriods(raw.events);
  const p = periods[0];

  // In a named sale, the seller is the period owner (ends their ownership)
  // buyer captured from "to" clause → could be acquisitionFrom or separate
  assert(p.owner !== null, "sale period has owner");
  assert(p.derivation.owner !== undefined, "owner derivation tracked");
  console.log(`    → owner: ${p.owner?.name}, rule: ${p.derivation.owner}`);
}

{
  // Derivation completeness: every non-null interpreted field has a derivation entry
  const raw = parseProvenanceRaw(PROV_SKA2344);
  const periods = interpretPeriods(raw.events);

  let derivationGaps = 0;
  for (const p of periods) {
    if (p.owner && !p.derivation.owner) derivationGaps++;
    if (p.acquisitionFrom && !p.derivation.acquisition_from) derivationGaps++;
    if ((p.beginYear !== null || p.beginYearLatest !== null) && !p.derivation.begin_year) derivationGaps++;
    if (p.endYear !== null && !p.derivation.end_year) derivationGaps++;
    if (p.location && !p.derivation.location) derivationGaps++;
  }
  assertEq(derivationGaps, 0, `derivation completeness: ${derivationGaps} gaps`);
}

{
  // Source events linkage
  const raw = parseProvenanceRaw("A (1600-1650), Amsterdam; B (1650-1700), London");
  const periods = interpretPeriods(raw.events);
  assertEq(periods[0].sourceEvents.length, 1, "period 1 has 1 source event");
  assertEq(periods[0].sourceEvents[0], 1, "source event is event 1");
  assertEq(periods[1].sourceEvents[0], 2, "period 2 source is event 2");
}

// ══════════════════════════════════════════════════════════════════
//  Phase D: New grammar rules and reclassification
// ══════════════════════════════════════════════════════════════════

section("Phase D: New grammar rules and reclassification");

// ── Commit 1: heirs in RelationWord ──

{
  const raw = parseProvenanceRaw("his heirs");
  assertEq(raw.events[0].transferType, "by_descent", "bare 'his heirs' → by_descent");
}

{
  const raw = parseProvenanceRaw("her heirs, Amsterdam");
  assertEq(raw.events[0].transferType, "by_descent", "'her heirs, Amsterdam' → by_descent");
  // Location is consumed into nameRaw by AnaphoricEvent (PEG prefix match),
  // not extracted separately. This is expected for short anaphoric segments.
}

{
  const raw = parseProvenanceRaw("their heirs");
  assertEq(raw.events[0].transferType, "by_descent", "'their heirs' → by_descent");
}

{
  const raw = parseProvenanceRaw("his heir and ex wife, Gerritje Gestel - Overtoom (1892-1960), Laren");
  assertEq(raw.events[0].transferType, "by_descent", "'his heir and...' → by_descent");
}

// ── Commit 2: broadened keyword prefixes ──

{
  const raw = parseProvenanceRaw("bequeathed by his widow to King William I, 1814");
  assertEq(raw.events[0].transferType, "bequest", "'bequeathed by' → bequest");
  assertEq(raw.events[0].dateYear, 1814, "bequest date");
}

{
  const raw = parseProvenanceRaw("by bequest to his father Ludwig Moritz Mainz, 1924");
  assertEq(raw.events[0].transferType, "bequest", "'by bequest to' → bequest");
}

{
  const raw = parseProvenanceRaw("purchased from Mendelssohn & Co. Bank, en bloc, to the Dienststelle Mühlmann, The Hague, 1940");
  assertEq(raw.events[0].transferType, "sale", "'purchased from' → sale");
  const seller = raw.events[0].parties.find(p => p.role === "seller");
  assert(seller !== undefined, "'purchased from': seller extracted");
}

{
  const raw = parseProvenanceRaw("acquired by the Vereniging van Vrienden der Aziatische Kunst, 1931");
  assertEq(raw.events[0].transferType, "sale", "'acquired by' → sale");
  assertEq(raw.events[0].dateYear, 1931, "acquired date");
}

{
  const raw = parseProvenanceRaw("transferred from the Landvoogd-Galerij, Paleis Rijswijk, to the museum, 1950");
  assertEq(raw.events[0].transferType, "transfer", "'transferred from' → transfer");
}

{
  const raw = parseProvenanceRaw("transfer to the museum, 1935");
  assertEq(raw.events[0].transferType, "transfer", "'transfer to' → transfer");
}

{
  const raw = parseProvenanceRaw("his posthumous sale, Amsterdam, 29 March 1757, no. 20, fl. 560");
  assertEq(raw.events[0].transferType, "sale", "'his posthumous sale' → sale");
  assertEq(raw.events[0].price?.amount, 560, "posthumous sale price");
}

{
  const raw = parseProvenanceRaw("sold by the Hessisches Landesmuseum, Darmstadt, after 1933");
  assertEq(raw.events[0].transferType, "sale", "'sold by' → sale");
  const seller = raw.events[0].parties.find(p => p.role === "seller");
  assert(seller !== undefined, "'sold by': seller extracted");
}

{
  const raw = parseProvenanceRaw("sold, with the house, to Vennootschap Bruns, 1954");
  assertEq(raw.events[0].transferType, "sale", "'sold, with...' → sale (via reclassification)");
}

{
  const raw = parseProvenanceRaw("from which on loan to the museum, since 1885");
  assertEq(raw.events[0].transferType, "loan", "'from which on loan' → loan");
}

{
  const raw = parseProvenanceRaw("from whom on loan to the museum, 1972");
  assertEq(raw.events[0].transferType, "loan", "'from whom on loan' → loan");
}

{
  const raw = parseProvenanceRaw("exchanged with the dealer A. Miedl, Amsterdam, 9 February 1944");
  assertEq(raw.events[0].transferType, "exchange", "'exchanged with' → exchange");
}

{
  const raw = parseProvenanceRaw("From the artist to the ICN, Rijswijk, 1989");
  assertEq(raw.events[0].transferType, "sale", "'From the artist to' → sale");
  const artist = raw.events[0].parties.find(p => p.name === "the artist");
  assert(artist !== undefined, "'From the artist': artist party extracted");
}

{
  const raw = parseProvenanceRaw("from the heirs of Paul Nijhoff (1868-1949), Amsterdam, to the museum, 1997");
  assertEq(raw.events[0].transferType, "by_descent", "'from the heirs of' → by_descent");
}

{
  const raw = parseProvenanceRaw("through the mediation of the dealer J.H.J. Mellaart, to the museum, 1940");
  assertEq(raw.events[0].transferType, "sale", "'through the mediation' → sale");
  const interm = raw.events[0].parties.find(p => p.role === "intermediary");
  assert(interm !== undefined, "intermediary party extracted");
}

// ── Commit 3: minor keywords ──

{
  const raw = parseProvenanceRaw("ex. coll Kamerbeek, Utrecht");
  assertEq(raw.events[0].transferType, "collection", "'ex. coll' → collection");
  assertEq(raw.events[0].location, "Utrecht", "ex. coll location");
}

{
  const raw = parseProvenanceRaw("ex coll. Baron Steengracht, The Hague");
  assertEq(raw.events[0].transferType, "collection", "'ex coll.' → collection");
}

{
  const raw = parseProvenanceRaw("first recorded in the museum, 1904");
  assertEq(raw.events[0].transferType, "collection", "'first recorded' → collection");
}

{
  const raw = parseProvenanceRaw("first mentioned in the Kloveniersdoelen, 1653");
  assertEq(raw.events[0].transferType, "collection", "'first mentioned' → collection");
}

{
  const raw = parseProvenanceRaw("stored at the Vleeshal, Haarlem, 1926");
  assertEq(raw.events[0].transferType, "deposit", "'stored' → deposit");
  assertEq(raw.events[0].location, "Haarlem", "stored: location");
}

{
  const raw = parseProvenanceRaw("deposited at the museum, 1950");
  assertEq(raw.events[0].transferType, "deposit", "'deposited' → deposit");
}

{
  const raw = parseProvenanceRaw("dedicated to Jan Herman van Eeghen (1849-1918), Amsterdam, 1918");
  assertEq(raw.events[0].transferType, "gift", "'dedicated to' → gift");
}

{
  const raw = parseProvenanceRaw("schenking WKF Zwierzina, 1924");
  assertEq(raw.events[0].transferType, "gift", "'schenking' → gift");
}

{
  const raw = parseProvenanceRaw("donation to the Vereniging van Vrienden, 2017");
  assertEq(raw.events[0].transferType, "gift", "'donation to' → gift");
}

// ── Commit 4: stripHtml hardening ──

{
  const { stripHtml } = await import("../../dist/provenance.js");

  assertEq(stripHtml("&nbsp;Name&nbsp;"), "Name", "stripHtml: &nbsp → space + trim");
  assertEq(stripHtml("&amp; Sons"), "& Sons", "stripHtml: &amp → &");
  assertEq(stripHtml("\">? Commissioned by X"), "? Commissioned by X", "stripHtml: \"> prefix stripped");
  assertEq(stripHtml("**SK-A-123** text"), "SK-A-123 text", "stripHtml: **bold** → plain");
  assertEq(stripHtml("font-family:Aptos, sans-serif"), "", "stripHtml: CSS → empty");
  assertEq(stripHtml("&#160;text"), "text", "stripHtml: numeric entity stripped");
  assertEq(stripHtml('<span style="font-size:11pt'), "", "stripHtml: unclosed <span style=");
  assertEq(stripHtml('<p style="margin:0cm'), "", "stripHtml: unclosed <p style=");
  assertEq(stripHtml('<span lang="EN-US" style="'), "", "stripHtml: unclosed <span lang=");
  assertEq(stripHtml('<span data-olk-copy-source="MessageBody" style="'), "", "stripHtml: unclosed data-olk");
  assertEq(stripHtml("Normal <em>text</em> here"), "Normal text here", "stripHtml: closed tags still work");
}

// ── Cross-reference detection ──

{
  const raw = parseProvenanceRaw("See the provenance for SK-A-4753.");
  assert(raw.isCrossRef, "cross-ref: 'See the provenance for' detected");
  assertEq(raw.crossRefTarget, "SK-A-4753", "cross-ref: target extracted");
}

{
  const raw = parseProvenanceRaw("For the provenance see SK-A-4756.");
  assert(raw.isCrossRef, "cross-ref: 'For the provenance see' detected");
  assertEq(raw.crossRefTarget, "SK-A-4756", "cross-ref: alt pattern target");
}

// ── Post-PEG reclassification (mid-sentence keywords) ──

{
  const raw = parseProvenanceRaw("after closure of the Museum Nusantara in 2013, donated by Erfgoed Delft, 2016");
  assertEq(raw.events[0].transferType, "gift", "reclassify: mid-sentence 'donated' → gift");
}

{
  const raw = parseProvenanceRaw("after the dissolvement of the museum stored at the Vleeshal, Haarlem, 1926");
  assertEq(raw.events[0].transferType, "deposit", "reclassify: mid-sentence 'stored' → deposit");
}

// ── Batch 2: RelationWord expansion, inventory, transferred, inherited ──

{
  // New relation words
  const cases = [
    ["his sister, Mathilde Anna Cohen Tervaert (1864-1945), The Hague", "sister"],
    ["his brother jonkheer James Loudon (1824-1900), The Hague", "brother"],
    ["his cousin, Jan de Wolff (1680-1735), Amsterdam", "cousin"],
    ["his wife, Jonkvrouw Elizabeth Adriana de Jonge, The Hague", "wife"],
    ["his uncle, Baron van Wassenaer, The Hague", "uncle"],
    ["his great-grandson, Name (1800-1860)", "great-grandson"],
    ["her sister-in-law, Name (1800-1860)", "sister-in-law"],
    ["his sister's grandson, W.A.A.J. Schimmelpenninck (1834-1889)", "sister's grandson"],
  ];
  for (const [text, rel] of cases) {
    const raw = parseProvenanceRaw(text);
    const expected = /widow/i.test(rel) ? "widowhood" : "by_descent";
    assertEq(raw.events[0].transferType, expected, `'his/her ${rel}' → ${expected}`);
  }
}

{
  // Inventory / probate inventory
  const raw1 = parseProvenanceRaw("inventory, Frisian Stadholder's Court, Leeuwarden, 16 August 1633");
  assertEq(raw1.events[0].transferType, "collection", "'inventory' → collection");

  const raw2 = parseProvenanceRaw("Probate inventory, Caesar van Everdingen, Alkmaar, after 13 October 1678");
  assertEq(raw2.events[0].transferType, "inventory", "'Probate inventory' → inventory");

  const raw3 = parseProvenanceRaw("their probate inventory, 1760");
  assertEq(raw3.events[0].transferType, "inventory", "'their probate inventory' → inventory");
}

{
  // Transferred variants (comma, in, with)
  const raw1 = parseProvenanceRaw("transferred, with 15 other drawings, to the museum, 1934");
  assertEq(raw1.events[0].transferType, "transfer", "'transferred, with...' → transfer");

  const raw2 = parseProvenanceRaw("transferred in 1948");
  assertEq(raw2.events[0].transferType, "transfer", "'transferred in' → transfer");

  const raw3 = parseProvenanceRaw("transferred with this institution to the Armenhuis, Amsterdam, 1873");
  assertEq(raw3.events[0].transferType, "transfer", "'transferred with...' → transfer");
}

{
  // Inherited by / by inheritance
  const raw1 = parseProvenanceRaw("inherited by Franciscus Johannes Hallo (1808-79), Kasteel Cannenburch");
  assertEq(raw1.events[0].transferType, "by_descent", "'inherited by' → by_descent");
  assert(raw1.events[0].parties[0]?.name?.includes("Franciscus"), "'inherited by': heir name");

  const raw2 = parseProvenanceRaw("by inheritance to J.F. van Lennep (1819-1892), Amsterdam, 1892");
  assertEq(raw2.events[0].transferType, "inheritance", "'by inheritance to' → inheritance");

  const raw3 = parseProvenanceRaw("through inheritance to Johanna van der Hoop, Amsterdam");
  assertEq(raw3.events[0].transferType, "inheritance", "'through inheritance' → inheritance");
}

// ── Batch 3: Commissioned for, purchased variants, cross-ref, installed, verwerving ──

{
  const raw = parseProvenanceRaw("Commissioned for the Maagdenhuis, Amsterdam, 1723");
  assertEq(raw.events[0].transferType, "commission", "'Commissioned for' → commission");
}

{
  const raw = parseProvenanceRaw("purchased, by Reijnier Flaes (Beijing), 1939-1965");
  assertEq(raw.events[0].transferType, "sale", "'purchased,' → sale");
}

{
  const raw = parseProvenanceRaw("purchased for the museum by the Commissie voor Fotoverkoop, 1977");
  assertEq(raw.events[0].transferType, "sale", "'purchased for' → sale");
}

{
  const raw = parseProvenanceRaw("Purchased at Maison Hirsch & Cie, Amsterdam");
  assertEq(raw.events[0].transferType, "sale", "'Purchased at' → sale");
}

{
  // Cross-ref edge cases
  const r1 = parseProvenanceRaw("See provenance for BK-17437");
  assert(r1.isCrossRef, "cross-ref: 'See provenance for' (no 'the')");

  const r2 = parseProvenanceRaw("See the provenance fot BK-17040-A.");
  assert(r2.isCrossRef, "cross-ref: typo 'fot'");

  const r3 = parseProvenanceRaw("*See provenance for BK-15498-A");
  assert(r3.isCrossRef, "cross-ref: asterisk prefix");
}

{
  const raw = parseProvenanceRaw("installed in the Sint-Michielsabdij, Antwerp, 1476");
  assertEq(raw.events[0].transferType, "deposit", "'installed in' → deposit");
}

{
  const raw = parseProvenanceRaw("placed in the garden, 1904");
  assertEq(raw.events[0].transferType, "deposit", "'placed in' → deposit");
}

{
  const raw = parseProvenanceRaw("sent to the Ministerie van Marine, The Hague, October 1818");
  assertEq(raw.events[0].transferType, "transfer", "'sent to' → transfer");
}

{
  const raw = parseProvenanceRaw("removed from the facade, 1873");
  assertEq(raw.events[0].transferType, "transfer", "'removed from' → transfer");
}

{
  const raw = parseProvenanceRaw("verwerving 1921 volgens KOG jaarverslag");
  assertEq(raw.events[0].transferType, "sale", "'verwerving' → sale");
}

// ══════════════════════════════════════════════════════════════════
//  Session 2026-03-21: automated batch audit fixes
// ══════════════════════════════════════════════════════════════════

section("PEG grammar rules (2026-03-21 batch audit)");

// ── Sale patterns ──
{
  const r = parseProvenanceRaw("sale, Hendrik Muilman (1743-1812, Amsterdam), Amsterdam (P. van der Schley et al.), 12 April 1813 sqq., no. 192");
  assertEq(r.events[0].transferType, "sale", "'sale, Name' → sale");
  assert(r.events[0].parties[0]?.name?.includes("Hendrik Muilman"), "'sale, Name' captures consignor");
  assertEq(r.events[0].parties[0]?.role, "consignor", "'sale, Name' role = consignor");
}

// ── Loan patterns ──
{
  const r = parseProvenanceRaw("on long term loan from the NMvNH, Haarlem, to the Museum");
  assertEq(r.events[0].transferType, "loan", "'on long term loan' → loan");
}
{
  const r = parseProvenanceRaw("on loan to the museum, 2000");
  assertEq(r.events[0].transferType, "loan", "'on loan' still works (regression check)");
}
{
  const r = parseProvenanceRaw("on lease to the museum, 2010");
  assertEq(r.events[0].transferType, "loan", "'on lease to' → loan");
}

// ── FromWhomEvent ──
{
  const r = parseProvenanceRaw("from the collection A.P. Hermans-Smits (1822-1897), Eindhoven, fl. 4000, to the Rijksmuseum, 1880");
  assertEq(r.events[0].transferType, "sale", "'from the collection' → sale");
  assert(r.events[0].parties[0]?.name?.includes("Hermans-Smits"), "'from the collection' captures name");
}
{
  const r = parseProvenanceRaw("from the estate of Jan van Goyen, The Hague, 1656");
  assertEq(r.events[0].transferType, "inheritance", "'from the estate of' → inheritance");
}
{
  const r = parseProvenanceRaw("from whom donated, with xx other objects, to the museum, 1990");
  assertEq(r.events[0].transferType, "gift", "'from whom donated' → gift");
  assertEq(r.events[0].parseMethod, "peg", "'from whom donated' parsed via PEG (not regex fallback)");
}
{
  const r = parseProvenanceRaw("by whom donated to the museum, 1938");
  assertEq(r.events[0].transferType, "gift", "'by whom donated' → gift");
  assertEq(r.events[0].parseMethod, "peg", "'by whom donated' parsed via PEG");
}
{
  const r = parseProvenanceRaw("from whom bequeathed, with xx other objects, to the museum, 1968");
  assertEq(r.events[0].transferType, "bequest", "'from whom bequeathed' → bequest");
  assertEq(r.events[0].parseMethod, "peg", "'from whom bequeathed' parsed via PEG");
}
{
  const r = parseProvenanceRaw("from whom transferred to the museum, 2008");
  assertEq(r.events[0].transferType, "transfer", "'from whom transferred' → transfer");
  assertEq(r.events[0].parseMethod, "peg", "'from whom transferred' parsed via PEG");
}
{
  const r = parseProvenanceRaw("from where transferred, on long term loan, to the museum, 1934");
  assertEq(r.events[0].transferType, "loan", "'from where transferred, on long term loan' → loan (reclassified)");
  assertEq(r.events[0].parseMethod, "peg", "'from where transferred' parsed via PEG");
}

// ── CollectionEvent expansions ──
{
  const r = parseProvenanceRaw("collection of the artist");
  assertEq(r.events[0].transferType, "collection", "'collection of' → collection");
  assertEq(r.events[0].parties[0]?.name, "the artist", "'collection of' strips preposition");
}
{
  const r = parseProvenanceRaw("collectie Name, Amsterdam");
  assertEq(r.events[0].transferType, "collection", "'collectie' (Dutch) → collection");
}
{
  const r = parseProvenanceRaw("dealer Name, Paris");
  assertEq(r.events[0].transferType, "collection", "'dealer Name' → collection");
  assertEq(r.events[0].parties[0]?.role, "dealer", "'dealer Name' role = dealer");
}
{
  const r = parseProvenanceRaw("art market, Paris, 2010");
  assertEq(r.events[0].transferType, "sale", "'art market' → sale");
}
{
  const r = parseProvenanceRaw("documented at Kasteel Popkensburg, 1800");
  assertEq(r.events[0].transferType, "collection", "'documented at' → collection");
}
{
  const r = parseProvenanceRaw("recorded at the palace, 1800");
  assertEq(r.events[0].transferType, "collection", "'recorded at' → collection");
}
{
  const r = parseProvenanceRaw("with the dealer D. Katz, Dieren, before May 1940");
  assertEq(r.events[0].transferType, "collection", "'with the dealer' → collection");
}

// ── StandardPhraseEvent additions ──
{
  const r = parseProvenanceRaw("awarded to the museum, 1950");
  assertEq(r.events[0].transferType, "gift", "'awarded to' → gift");
}
{
  const r = parseProvenanceRaw("reinstalled in the Rijksmuseum, 1960");
  assertEq(r.events[0].transferType, "transfer", "'reinstalled' → transfer");
}
{
  const r = parseProvenanceRaw("veiling Amsterdam, 1850, kavel 12");
  assertEq(r.events[0].transferType, "sale", "'veiling' (Dutch) → sale");
}
{
  const r = parseProvenanceRaw("gekocht door het Rijksmuseum, 1880");
  assertEq(r.events[0].transferType, "sale", "'gekocht door' (Dutch) → sale");
}
{
  const r = parseProvenanceRaw("aangekocht door het museum, 1900");
  assertEq(r.events[0].transferType, "sale", "'aangekocht door' (Dutch) → sale");
}
{
  const r = parseProvenanceRaw("geschonken aan het museum, 1900");
  assertEq(r.events[0].transferType, "gift", "'geschonken aan' (Dutch) → gift");
}
{
  const r = parseProvenanceRaw("with the castle to Jonkheer Name, 1900");
  assertEq(r.events[0].transferType, "by_descent", "'with the castle to' → by_descent");
}
{
  const r = parseProvenanceRaw("through the family to Name");
  assertEq(r.events[0].transferType, "by_descent", "'through the family' → by_descent");
}
{
  const r = parseProvenanceRaw("excavation near Amsterdam, 1900");
  assertEq(r.events[0].transferType, "collection", "'excavation' noun → collection");
}
{
  const r = parseProvenanceRaw("comissioned by Name, 1800");
  assertEq(r.events[0].transferType, "commission", "'comissioned' (misspelling) → commission");
}

// ── RelationWord expansions ──
{
  const r = parseProvenanceRaw("his great grandson, Arnold Hugo de Vries, Rhoon");
  assertEq(r.events[0].transferType, "by_descent", "'great grandson' (no hyphen) → by_descent");
  assert(r.events[0].parties[0]?.name?.includes("Arnold"), "great grandson party captured");
}
{
  const r = parseProvenanceRaw("his third cousin and godson, Name (1794-1866), Rotterdam");
  assertEq(r.events[0].transferType, "by_descent", "'third cousin and godson' → by_descent");
  assert(r.events[0].parties.length > 0, "compound relation captures party");
}
{
  const r = parseProvenanceRaw("his mother, Maria (1800-1870), City");
  assertEq(r.events[0].transferType, "by_descent", "'his mother' → by_descent");
  assert(r.events[0].parties[0]?.name?.includes("Maria"), "mother party captured");
}
{
  const r = parseProvenanceRaw("his heir and ex wife, Gerritje Gestel - Overtoom (1892-1960), Laren");
  assertEq(r.events[0].transferType, "by_descent", "'heir and ex wife' → by_descent");
  assert(r.events[0].parties[0]?.name?.includes("Gerritje"), "heir and ex wife party captured");
}
{
  const r = parseProvenanceRaw("by descent to his grandson, Jan van Oort (1921-2006), Arnhem");
  assertEq(r.events[0].transferType, "by_descent", "'by descent to his [rel], Name' → by_descent");
  assert(r.events[0].parties[0]?.name?.includes("Jan van Oort"), "by descent captures heir name");
}

section("Price patterns (2026-03-21)");

{
  const r = parseProvenanceRaw("from whom, €11,500, to the museum, 2022");
  assertEq(r.events[0].price?.currency, "euros", "€ → euros");
  assertEq(r.events[0].price?.amount, 11500, "€11,500 → 11500");
}
{
  const r = parseProvenanceRaw("from whom, DM. 250, to the museum, 1978");
  assertEq(r.events[0].price?.currency, "deutschmarks", "DM. → deutschmarks");
  assertEq(r.events[0].price?.amount, 250, "DM. 250 → 250");
}
{
  const r = parseProvenanceRaw("from whom, frs 10500, to the museum");
  assertEq(r.events[0].price?.currency, "francs", "frs (no period) → francs");
}
{
  const r = parseProvenanceRaw("sale, Name, fl. 2.000, Amsterdam");
  assertEq(r.events[0].price?.amount, 2000, "fl. 2.000 (European decimal) → 2000");
}
{
  const r = parseProvenanceRaw("sale, Name, fl. 600, Amsterdam");
  assertEq(r.events[0].price?.amount, 600, "fl. 600 (no period) → 600 (regression check)");
}

section("Date patterns (2026-03-21)");

{
  const r = parseProvenanceRaw("sale, Name, 7 December 1932 sqq, no. 456");
  assertEq(r.events[0].dateYear, 1932, "exact date with sqq → 1932");
}
{
  const r = parseProvenanceRaw("transferred to convent, 1713-24");
  assertEq(r.events[0].dateYear, 1713, "date range 1713-24 → 1713");
}
{
  const r = parseProvenanceRaw("sold, 1792/93");
  assertEq(r.events[0].dateYear, 1792, "date range 1792/93 → 1792");
}
{
  const r = parseProvenanceRaw("on loan to museum, 1983-2005");
  assertEq(r.events[0].dateYear, 1983, "date range 1983-2005 → 1983");
}
{
  const r = parseProvenanceRaw("collection Name, before or in 1691");
  assertEq(r.events[0].dateYear, 1691, "'before or in 1691' → 1691");
  assertEq(r.events[0].dateQualifier, "before", "'before or in' qualifier → before");
}
{
  const r = parseProvenanceRaw("collection Name, after 1800");
  assertEq(r.events[0].dateYear, 1800, "'after 1800' → 1800");
  assertEq(r.events[0].dateQualifier, "after", "after qualifier");
}
{
  const r = parseProvenanceRaw("on loan to museum, since 1948");
  assertEq(r.events[0].dateYear, 1948, "'since 1948' → 1948");
  assertEq(r.events[0].dateQualifier, "since", "since qualifier");
}
{
  const r = parseProvenanceRaw("with the dealer D. Katz, Dieren, before May 1940");
  assertEq(r.events[0].dateYear, 1940, "'before May 1940' → 1940");
  assertEq(r.events[0].dateQualifier, "before", "'before May' qualifier");
}

section("Location matching (2026-03-21)");

{
  const r = parseProvenanceRaw("collection Name, Middelburg");
  assertEq(r.events[0].location, "Middelburg", "Middelburg (from places.json)");
}
{
  const r = parseProvenanceRaw("collection Name, Leeuwarden");
  assertEq(r.events[0].location, "Leeuwarden", "Leeuwarden");
}
{
  const r = parseProvenanceRaw("sold to Name, Paris (Drouot), 1932");
  assertEq(r.events[0].location, "Paris", "Paris (Drouot) → Paris");
}
{
  const r = parseProvenanceRaw("collection Name, Frankfurt am Main");
  assertEq(r.events[0].location, "Frankfurt am Main", "compound city name");
}

section("Transfer reclassification (#123) and date fallback (#124)");

{
  const r = parseProvenanceRaw("from the artist, transferred to the Town Hall, Amsterdam, 1664");
  assertEq(r.events[0].transferType, "transfer", "'from artist, transferred to' → transfer (not sale)");
}
{
  const r = parseProvenanceRaw("from the artist, to the museum, 1900");
  assertEq(r.events[0].transferType, "sale", "'from artist, to museum' still sale (regression)");
}
{
  // Post-parse date fallback for inline dates
  const r = parseProvenanceRaw("first recorded in museum in 1904");
  assertEq(r.events[0].dateYear, 1904, "inline 'in 1904' extracted by post-parse fallback");
}

section("Attribution date suppression (#88, 2026-03-21)");

{
  // "as Haarlem school, c. 1510" should NOT override sale date 1919
  const r = parseProvenanceRaw("her sale, Amsterdam (F. Muller), 16 December 1919, no. 24, as Haarlem school, c. 1510, fl. 11100");
  assertEq(r.events[0].dateYear, 1919, "'as school, c. YYYY' doesn't override sale date");
}
{
  // "as Brabant, c. 1500" in quoted form
  const r = parseProvenanceRaw("anonymous sale, London (Sothebys), 12 July 1979, no. 74, as Brabant, c. 1500, £ 7480");
  assertEq(r.events[0].dateYear, 1979, "attribution circa after 'as' suppressed");
}
{
  // Legitimate circa date should still work
  const r = parseProvenanceRaw("collection Name, Amsterdam, c. 1920");
  assertEq(r.events[0].dateYear, 1920, "legitimate c. 1920 still extracted");
  assertEq(r.events[0].dateQualifier, "circa", "legitimate circa qualifier preserved");
}
{
  // Circa date NOT preceded by "as" — should still work
  const r = parseProvenanceRaw("excavated at site, Maarssen, c. 1881");
  assertEq(r.events[0].dateYear, 1881, "non-attribution circa preserved");
}

section("Party extraction improvements (#116, 2026-03-21)");

{
  const r = parseProvenanceRaw("from whom, €11,500, to the museum, 2022");
  assert(r.events[0].parties.some(p => /museum/i.test(p.name)), "'to the museum' captured as party");
}
{
  // Sub-problem A: "by [Name]" as buyer
  const r = parseProvenanceRaw("purchased from the dealer Hotei, Leiden, by J.H.W. Goslings, to the museum");
  assert(r.events[0].parties.some(p => /Goslings/.test(p.name) && p.role === "buyer"), "'by Goslings' captured as buyer");
}
{
  // Sub-problem B: institution in recuperation
  const r = parseProvenanceRaw("war recuperation, SNK, 1945");
  assertEq(r.events[0].parties[0]?.name, "SNK", "SNK captured in war recuperation");
}
{
  // Sub-problem C: "transferred to [institution]"
  const r = parseProvenanceRaw("transferred to the Royal Cabinet of Curiosities, The Hague, 1816");
  assert(r.events[0].parties[0]?.name?.includes("Royal Cabinet"), "'transferred to' captures recipient");
  assertEq(r.events[0].parties[0]?.role, "recipient", "transferred-to role = recipient");
}
{
  const r = parseProvenanceRaw("sent to the Rijksmuseum, Amsterdam, 1885");
  assert(r.events[0].parties[0]?.name?.includes("Rijksmuseum"), "'sent to' captures recipient");
}
{
  // Loan with lender
  const r = parseProvenanceRaw("on long term loan from the Nederlandse Maatschappij, Haarlem, to the Museum");
  assert(r.events[0].parties[0]?.role === "lender", "'on loan from' captures lender");
}
{
  // "by descent" NOT captured as party (regression)
  const r = parseProvenanceRaw("by descent to Name");
  assert(!r.events[0].parties.some(p => /descent/i.test(p.name)), "'by descent' not a party name");
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
