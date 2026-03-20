// Provenance segment PEG grammar (Rijksmuseum variant of AAM convention)
// Parses a SINGLE preprocessed segment (citations replaced with __CIT_N__, HTML stripped).
// Returns an AST node — faithful extraction, no interpretation.
//
// Strategy: each alternative matches a keyword prefix, then delegates the
// comma-separated tail to parseRest() in the action code. This avoids the
// combinatorial explosion of trying to parse locations/dates/prices in the grammar.

{{
// ─── Post-parse helpers (run in the generated parser) ───────────────
// All regexes hoisted here to avoid per-call recompilation (parseRest called ~102K times)

const MONTHS_RE = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/;
const EXACT_DATE_RE = /^(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/;
const DIGIT_END_RE = /\d$/;
const DIGITS_ONLY_RE = /^\d+$/;
const TO_BUYER_RE = /^to\s+(?:the\s+)?(?:dealers?\s+)?(.+)/i;
const HAS_UPPER_RE = /[A-Z]/;
const LOT_NO_RE = /^no\.\s*\d+/i;
const LOT_NUM_RE = /^lot\s+\d+/i;
const PARENS_RE = /^\(([^)]+)\)/;
const FL_RE = /^fl\.\s*([\d,]+)/;
const POUND_RE = /^£\s*([\d,]+)/;
const FRS_RE = /^frs\.\s*([\d,]+)/;
const LIVRES_RE = /([\d,]+)\s*livres/i;
const NAP_RE = /([\d,]+)\s*Napol[eé]ons/i;
const QUAL_DATE_RE = /^\s*(before|after)\s+(\d{4})\b/i;
const APPROX_DATE_RE = /^\s*c\.\s*(\d{4})\b/;
const BARE_YEAR_RE = /^\s*(\d{4})\s*$/;
const NAME_DATES_RE = /^([^(]+?)\s*\((\d{4}[\/?]?\d{0,2}[-–]\d{0,4}\??|\?[-–]\?|\?[-–]\d{4}|\d{4}[-–]\??\s*)(?:,\s*[^)]+)?\)/;
const UNSOLD_RE = /\b(?:unsold|bought\s+in|withdrawn|invendu|ingetrokken)\b/i;
// City list — kept in sync with RE_CITIES in provenance.ts (+ 5 compound place names)
const CITIES = [
  "Amsterdam","Delft","The Hague","London","Paris","Venice","Rotterdam","Brussels",
  "Wassenaar","Montreux","Buckinghamshire","Hertfordshire","Northampton","Edinburgh",
  "Linz","Soho Square","Madrid","Rome","Florence","Berlin","Vienna","Munich",
  "Stockholm","St Petersburg","New York","Hilversum","Aerdenhout","Haarlem",
  "Leiden","Utrecht","Antwerp","Watergraafsmeer","Cheshunt Nunnery","Aynhoe Park",
  "Palazzo Manfrin","Mentmore Towers","Dalmeny House",
];

// Regex for digit-rejoin: next part starts with 3 digits (thousands group), optionally followed
// by a space + currency word. Excludes 4-digit starts (years like "1824").
const THOUSANDS_CONT_RE = /^\d{3}(?:\s|$)/;

function splitCommaRespectingParens(str) {
  // Split on commas, but not inside matched parentheses or single-quoted strings.
  // Handles ('...'), ('[...]'), (YYYY-YYYY, City), and nested parens.
  const result = [];
  let depth = 0;
  let inSingleQuote = false;
  let start = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'" && depth > 0) {
      inSingleQuote = !inSingleQuote;
    } else if (!inSingleQuote) {
      if (ch === "(" || ch === "[") depth++;
      else if ((ch === ")" || ch === "]") && depth > 0) depth--;
      else if (ch === "," && depth === 0) {
        result.push(str.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  const last = str.slice(start).trim();
  if (last) result.push(last);
  return result;
}

function parseRest(tail) {
  // tail is the raw string after the keyword/name portion
  // Split on commas respecting paren/quote depth, then rejoin number-fragments
  const rawParts = splitCommaRespectingParens(tail).filter(Boolean);
  const parts = [];
  for (let i = 0; i < rawParts.length; i++) {
    let curr = rawParts[i];
    // Rejoin comma-separated thousands greedily: "fl. 6" + "350" + "000" → "fl. 6,350,000"
    // Only rejoin if next part starts with exactly 3 digits (thousands group),
    // not 4 (which is a year). Also accept "000 livres" (digits + currency).
    while (i + 1 < rawParts.length && DIGIT_END_RE.test(curr) && THOUSANDS_CONT_RE.test(rawParts[i + 1])) {
      curr = curr + "," + rawParts[i + 1];
      i++;
    }
    parts.push(curr);
  }

  let location = null;
  let dateExpression = null;
  let dateYear = null;
  let dateQualifier = null;
  let priceAmount = null;
  let priceCurrency = null;
  let saleDetails = null;
  const extraParties = [];

  for (const t of parts) {
    // "to (the dealer) Name" → buyer
    const toBuyer = t.match(TO_BUYER_RE);
    if (toBuyer) {
      const buyerRaw = toBuyer[1].replace(/,\s*$/, "").trim();
      if (buyerRaw && HAS_UPPER_RE.test(buyerRaw)) {
        const nd = extractNameAndDates(buyerRaw);
        if (nd) {
          extraParties.push({ name: nd.name, dates: nd.dates, role: "buyer" });
        } else {
          extraParties.push({ name: buyerRaw, dates: null, role: "buyer" });
        }
        continue;
      }
    }

    // Lot number
    if (LOT_NO_RE.test(t)) {
      saleDetails = saleDetails ? saleDetails + ", " + t : t;
      continue;
    }
    if (LOT_NUM_RE.test(t)) {
      saleDetails = saleDetails ? saleDetails + ", " + t : t;
      continue;
    }

    // Auctioneer in parens — add to saleDetails
    const auctioneerMatch = t.match(PARENS_RE);
    if (auctioneerMatch && saleDetails === null) {
      saleDetails = auctioneerMatch[1].trim();
      continue;
    }

    // Price patterns (regexes hoisted to module scope)
    const flMatch = t.match(FL_RE);
    if (flMatch) { priceAmount = parseFloat(flMatch[1].replace(/,/g, "")); priceCurrency = "guilders"; continue; }
    const poundMatch = t.match(POUND_RE);
    if (poundMatch) { priceAmount = parseFloat(poundMatch[1].replace(/,/g, "")); priceCurrency = "pounds"; continue; }
    const frsMatch = t.match(FRS_RE);
    if (frsMatch) { priceAmount = parseFloat(frsMatch[1].replace(/,/g, "")); priceCurrency = "francs"; continue; }
    const livresMatch = t.match(LIVRES_RE);
    if (livresMatch) { priceAmount = parseFloat(livresMatch[1].replace(/,/g, "")); priceCurrency = "livres"; continue; }
    const napMatch = t.match(NAP_RE);
    if (napMatch) { priceAmount = parseFloat(napMatch[1].replace(/,/g, "")); priceCurrency = "napoléons"; continue; }

    // Date patterns (ordered by specificity)
    const exactDate = t.match(EXACT_DATE_RE);
    if (exactDate) { dateExpression = t; dateYear = parseInt(exactDate[3], 10); continue; }

    const qualDate = t.match(QUAL_DATE_RE);
    if (qualDate) { dateExpression = qualDate[0].trim(); dateYear = parseInt(qualDate[2], 10); dateQualifier = qualDate[1].toLowerCase(); continue; }

    const approxDate = t.match(APPROX_DATE_RE);
    if (approxDate) { dateExpression = approxDate[0].trim(); dateYear = parseInt(approxDate[1], 10); dateQualifier = "circa"; continue; }

    const monthYear = t.match(MONTHS_RE);
    if (monthYear) { dateExpression = t; dateYear = parseInt(monthYear[2], 10); continue; }

    const bareYear = t.match(BARE_YEAR_RE);
    if (bareYear && !dateYear) { dateExpression = bareYear[1]; dateYear = parseInt(bareYear[1], 10); continue; }

    // Location (known cities — check if t starts with a known city)
    if (!location) {
      for (let ci = 0; ci < CITIES.length; ci++) {
        if (t.startsWith(CITIES[ci])) { location = CITIES[ci]; break; }
      }
    }
  }

  // Handle buyer life dates: if last extraParty has no dates and next-to-last part looks like "(YYYY-YYYY)"
  // This is handled downstream, not here.

  // Detect "unsold" / "bought in" — suppresses sale classification
  const unsold = UNSOLD_RE.test(tail);

  return {
    location,
    dateExpression,
    dateYear,
    dateQualifier,
    price: priceAmount !== null ? { amount: priceAmount, currency: priceCurrency } : null,
    saleDetails,
    extraParties,
    unsold,
  };
}

function extractNameAndDates(text) {
  // Strict date pattern matching provenance.ts — avoids capturing "(Amsterdam)" as dates
  const m = text.match(NAME_DATES_RE);
  if (m) {
    return { name: m[1].trim().replace(/,\s*$/, ""), dates: m[2].trim() };
  }
  const name = text.split(",")[0].trim();
  return name ? { name: name.replace(/\]\s*$/, ""), dates: null } : null;
}

// Build a result merging named party (if any) with extraParties from parseRest,
// then clearing extraParties from the spread rest to avoid downstream duplication.
function buildResult(type, nd, role, rest) {
  const parties = nd && nd.name ? [{ ...nd, role }] : [];
  return { type, parties: [...parties, ...(rest.extraParties || [])], ...rest, extraParties: undefined };
}
}}

// ─── Entry point ────────────────────────────────────────────────────

Event
  = _ uncertain:"?"? _ body:EventBody _
    { return { ...body, uncertain: !!uncertain }; }

EventBody
  = SaleEvent
  / CommissionEvent
  / WarRecupEvent
  / ConfiscationEvent
  / LoanEvent
  / TransferEvent
  / BequestEvent
  / PurchaseEvent
  / GiftEvent
  / ExchangeEvent
  / RestitutionEvent
  / DepositEvent
  / CollectionEvent
  / EstateInventoryEvent
  / FromWhomEvent
  / AnaphoricEvent
  / GenericOwnerEvent

// ─── Name capture (paren-aware) ─────────────────────────────────────
// Matches text up to a comma or semicolon, but allows commas inside
// balanced parentheses: "Name (1892-1937, Wassenaar)" stays intact.
NameChars
  = $(( "(" [^)]* ")" / [^,;(] )*)

// ─── Sale ───────────────────────────────────────────────────────────

SaleEvent
  = ("his"i / "her"i / "their"i) _ ("posthumous"i / "deceased"i)? _? "sale" tail:Tail
    { const rest = parseRest(tail); return { type: "sale", parties: [], ...rest }; }
  / "sold"i _ prep:("by"i / "to"i / "with"i) _ ("the"i _)? nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      const role = prep.toLowerCase() === "to" ? "buyer" : "seller";
      return { type: "sale", parties: nd && nd.name ? [{ ...nd, role }] : [], ...rest };
    }
  / "through"i _ ("the"i _)? "mediation"i _ "of"i _ nameRaw:NameChars tail:Tail
    { return buildResult("sale", extractNameAndDates(nameRaw), "intermediary", parseRest(tail)); }
  / "sale"i _ "[" section:[^\]]* "]" tail:Tail
    { const rest = parseRest(tail); return { type: "sale", parties: [], ...rest, saleSection: section.join("") }; }
  / "sale"i _ nameRaw:NameChars tail:Tail
    { return buildResult("sale", extractNameAndDates(nameRaw), "seller", parseRest(tail)); }

// ─── Commission ─────────────────────────────────────────────────────

CommissionEvent
  = "commissioned"i _ ("by"i / "for"i / "as"i / "and"i) _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "commission", parties: nd ? [{ ...nd, role: "patron" }] : [], ...rest };
    }

// ─── War recuperation ───────────────────────────────────────────────

WarRecupEvent
  = "war"i _ "recuperation"i tail:Tail
    { const rest = parseRest(tail); return { type: "recuperation", parties: [], ...rest }; }

// ─── Confiscation ───────────────────────────────────────────────────

ConfiscationEvent
  = "confiscated"i tail:Tail
    { const rest = parseRest(tail); return { type: "confiscation", parties: [], ...rest }; }

// ─── Loan ───────────────────────────────────────────────────────────

LoanEvent
  = ("from"i _ ("which"i / "whom"i) _)? "on"i _ "loan"i tail:Tail
    { const rest = parseRest(tail); return { type: "loan", parties: [], ...rest }; }

// ─── Transfer ───────────────────────────────────────────────────────

TransferEvent
  = "transfer"i "red"i? _ ("to"i / "from"i / "for"i / "with"i / "in"i)? tail:Tail
    { const rest = parseRest(tail); return { type: "transfer", parties: [], ...rest }; }
  / ("sent"i / "removed"i / "dispatched"i) _ ("to"i / "from"i / "by"i / "in"i / "when"i / "at"i / "and"i / "after"i)? tail:Tail
    { const rest = parseRest(tail); return { type: "transfer", parties: [], ...rest }; }

// ─── Bequest ────────────────────────────────────────────────────────

BequestEvent
  = ("bequeathed"i _ ("to"i / "by"i) / "by"i _ "bequest"i / "bequest"i) _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "bequest", parties: nd && nd.name ? [{ ...nd, role: "heir" }] : [], ...rest };
    }

// ─── Purchase ───────────────────────────────────────────────────────

PurchaseEvent
  = "from"i _ "whom"i _ "purchased"i _ "by"i _ ("the"i _)? ("dealer"i _)? nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "purchase", parties: nd && nd.name ? [{ ...nd, role: "buyer" }] : [], ...rest };
    }
  / "from"i _ "whose"i _ "heirs"i tail:Tail
    { return buildResult("purchase", null, null, parseRest(tail)); }
  / "purchased"i _ "by"i _ ("the"i _)? ("museum"i / ("dealer"i _))? nameRaw:NameChars? tail:Tail
    {
      const nd = nameRaw ? extractNameAndDates(nameRaw) : null;
      const rest = parseRest(tail);
      return { type: "purchase", parties: nd && nd.name ? [{ ...nd, role: "buyer" }] : [], ...rest };
    }
  / "bought"i _ "by"i _ ("the"i _)? ("dealer"i _)? nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "purchase", parties: nd && nd.name ? [{ ...nd, role: "buyer" }] : [], ...rest };
    }
  / "purchased"i _ "from"i _ nameRaw:NameChars tail:Tail
    { return buildResult("purchase", nameRaw ? extractNameAndDates(nameRaw) : null, "seller", parseRest(tail)); }
  / ("acquired"i / "verwerving"i) _ ("by"i / "from"i / "in"i / "for"i / "with"i / "en"i)? _? ("the"i _)? nameRaw:NameChars tail:Tail
    {
      const nd = nameRaw ? extractNameAndDates(nameRaw) : null;
      const rest = parseRest(tail);
      return { type: "purchase", parties: nd && nd.name ? [{ ...nd, role: "buyer" }] : [], ...rest };
    }
  / "purchased"i _ ("for"i / "at"i) _ nameRaw:NameChars tail:Tail
    {
      const nd = nameRaw ? extractNameAndDates(nameRaw) : null;
      const rest = parseRest(tail);
      return { type: "purchase", parties: nd && nd.name ? [{ ...nd, role: "buyer" }] : [], ...rest };
    }
  / "purchased"i ","? tail:Tail
    { const rest = parseRest(tail); return { type: "purchase", parties: [...(rest.extraParties || [])], ...rest, extraParties: undefined }; }

// ─── Gift ───────────────────────────────────────────────────────────

GiftEvent
  = ("donated"i / "donation"i / "gift"i / "given"i / "presented"i / "dedicated"i / "schenking"i) _ ("by"i / "to"i / "of"i / "van"i)? _? ("the"i _)? nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "gift", parties: nd && nd.name ? [{ ...nd, role: "donor" }] : [], ...rest };
    }

// ─── Exchange ───────────────────────────────────────────────────────

ExchangeEvent
  = ("in"i _ "exchange"i / "exchanged"i) _ ("for"i / "with"i) _ nameRaw:NameChars? tail:Tail
    {
      const nd = nameRaw ? extractNameAndDates(nameRaw) : null;
      const rest = parseRest(tail);
      return { type: "exchange", parties: nd && nd.name ? [{ ...nd, role: null }] : [], ...rest };
    }

// ─── Restitution ────────────────────────────────────────────────────

RestitutionEvent
  = ("restituted"i / "returned"i) _ "to"i _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "restitution", parties: nd && nd.name ? [{ ...nd, role: "recipient" }] : [], ...rest };
    }

// ─── Deposit ────────────────────────────────────────────────────────

DepositEvent
  = ("on"i _ "deposit"i / "stored"i / "deposited"i / "kept"i / "installed"i / "placed"i) tail:Tail
    { const rest = parseRest(tail); return { type: "deposit", parties: [], ...rest }; }

// ─── Collection ─────────────────────────────────────────────────────

CollectionEvent
  = "collection"i _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "collection", parties: nd && nd.name ? [{ ...nd, role: "collector" }] : [], ...rest };
    }
  / "ex"i "."? _ "coll"i "."? _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "collection", parties: nd && nd.name ? [{ ...nd, role: "collector" }] : [], ...rest };
    }
  / ("first"i / "last"i) _ ("recorded"i / "mentioned"i / "documented"i / "noted"i) tail:Tail
    { const rest = parseRest(tail); return { type: "collection", parties: [], ...rest }; }
  / "with"i _ "an"i? _? ("art"i _)? "dealer"i tail:Tail
    { const rest = parseRest(tail); return { type: "collection", parties: [], ...rest }; }

// ─── Estate inventory ───────────────────────────────────────────────

EstateInventoryEvent
  = "estate"i _ "inventory"i (_ "of"i (_ ("his"i / "her"i / "their"i))?)? ","? _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "collection", parties: nd && nd.name ? [{ ...nd, role: "deceased" }] : [], ...rest };
    }
  / ("probate"i _)? "inventory"i ","? _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "collection", parties: nd && nd.name ? [{ ...nd, role: null }] : [], ...rest };
    }

// ─── From whom ──────────────────────────────────────────────────────

FromWhomEvent
  = "from"i _ "whom"i tail:Tail
    { return buildResult("sale", null, null, parseRest(tail)); }
  / "by"i _ "whom"i _ ("probably"i _)? ("sold"i _)? ("to"i _)? nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      const parties = nd && nd.name ? [{ ...nd, role: "buyer" }] : [];
      return { type: "sale", parties, ...rest };
    }
  / "from"i _ ("the"i _)? "dealer"i "s"i? _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "sale", parties: nd && nd.name ? [{ ...nd, role: "seller" }] : [], ...rest };
    }
  / "from"i _ ("the"i _)? "heirs"i _ ("of"i _)? nameRaw:NameChars tail:Tail
    { return buildResult("inheritance", extractNameAndDates(nameRaw), "deceased", parseRest(tail)); }
  / "from"i _ "the"i _ "artist"i tail:Tail
    { return buildResult("sale", { name: "the artist", dates: null }, "seller", parseRest(tail)); }
  / "from"i _ ("the"i _)? !("collection"i / "estate"i) nameRaw:NameChars tail:Tail
    &{ return /\bto\b/i.test(tail); }
    { return buildResult("sale", extractNameAndDates(nameRaw), "seller", parseRest(tail)); }

// ─── Anaphoric ──────────────────────────────────────────────────────

AnaphoricEvent
  = poss:("his"i / "her"i / "their"i) _
    rel:RelationWord
    ","? _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const role = poss.toLowerCase() + " " + rel.toLowerCase();
      const rest = parseRest(tail);
      return { type: "inheritance", parties: nd && nd.name ? [{ ...nd, role }] : [], ...rest };
    }
  / "by"i _ "descent"i tail:Tail
    { const rest = parseRest(tail); return { type: "inheritance", parties: [], ...rest }; }
  / "inherited"i _ "by"i _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "inheritance", parties: nd && nd.name ? [{ ...nd, role: "heir" }] : [], ...rest };
    }
  / ("by"i / "through"i) _ "inheritance"i _ ("to"i _)? nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "inheritance", parties: nd && nd.name ? [{ ...nd, role: "heir" }] : [], ...rest };
    }

RelationWord "relation word"
  = $("sons"i / "son"i / "daughters"i / "daughter"i / "widower"i / "widow"i
     / "husband"i / "wife"i / "nephew"i / "niece"i
     / "great-great-granddaughter"i / "great-great-grandson"i
     / "great-granddaughter"i / "great-grandson"i
     / "granddaughter"i / "grandson"i
     / "sister-in-law"i / "brother-in-law"i
     / "sister's grandson"i / "sister's granddaughter"i
     / "sisters"i / "sister"i / "brothers"i / "brother"i
     / "cousins"i / "cousin"i / "uncle"i / "aunt"i
     / "stepson"i / "stepdaughter"i
     / "heirs"i / "heir"i)

// ─── Generic owner (catch-all) ──────────────────────────────────────

GenericOwnerEvent
  = nameRaw:$([^,;]+) tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "unknown", parties: nd && nd.name ? [{ ...nd, role: null }] : [], ...rest };
    }
  / tail:Tail
    { const rest = parseRest(tail); return { type: "unknown", parties: [], ...rest }; }

// ─── Primitives ─────────────────────────────────────────────────────

// Tail: everything from the first comma (or end of input) to EOI
Tail "comma-separated tail"
  = t:$(","? .*)
    { return t; }

_ "whitespace"
  = [ \t\n\r]*
