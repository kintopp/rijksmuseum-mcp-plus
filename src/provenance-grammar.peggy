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

const MONTHS_RE = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/;
const EXACT_DATE_RE = /^(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/;
const DIGIT_END_RE = /\d$/;
const DIGITS_ONLY_RE = /^\d+$/;
const TO_BUYER_RE = /^to\s+(?:the\s+)?(?:dealers?\s+)?(.+)/i;
const BY_PARTY_RE = /^by\s+(?:the\s+)?(?:dealers?\s+)?(.+)/i;
// Negative lookahead words — "by descent", "by bequest", "by inheritance" etc. are not party names
const BY_PARTY_EXCLUDE = /^(?:descent|bequest|inheritance|whom|which|where|order|request|exchange)\b/i;
const HAS_UPPER_RE = /[A-Z]/;
// Accept lowercase tail parties that are clearly institutions/roles, not stray text
const KNOWN_RECIPIENT_RE = /^(?:the\s+)?(?:museum|state|nation|city|government|kingdom|republic|dealer|artist|sitter|church)\b/i;
const LOT_NO_RE = /^no\.\s*\d+/i;
const LOT_NUM_RE = /^lot\s+\d+/i;
const PARENS_RE = /^\(([^)]+)\)/;
const FL_RE = /^fl\.\s*([\d,.]+)/;
const POUND_RE = /^£\s*([\d,]+)/;
const FRS_RE = /^frs\.?\s*([\d,]+)/;
const LIVRES_RE = /([\d,]+)\s*livres/i;
const NAP_RE = /([\d,]+)\s*Napol[eé]ons/i;
const DM_RE = /^DM\.?\s*([\d,]+)/;
const RM_RE = /^RM\.?\s*([\d,]+)/;
const SFRS_RE = /^(?:SFrcs|CHF)\s*([\d,]+)/;
const EUR_RE = /^[€]\s*([\d,.]+)/;
const USD_RE = /^\$\s*([\d,]+)/;
// Matches qualified dates: "before 1800", "after May 1940", "since 1948",
// "before or in 1691", "in or shortly before 1660", "in 1904"
const QUAL_DATE_RE = /^\s*(?:(before|after|since|by)(?:\s+or\s+in)?\s+|(in\s+or\s+(?:shortly\s+)?)(before|after)\s+|in\s+)(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+)?(\d{4})\b/i;
const APPROX_DATE_RE = /^\s*c\.\s*(\d{4})\b/;
const DATE_RANGE_RE = /^\s*(\d{4})\s*[-–\/]\s*(\d{2,4})\b/;
const BARE_YEAR_RE = /^\s*(\d{4})\b/;
const NAME_DATES_RE = /^([^(]+?)\s*\((\d{4}[\/?]?\d{0,2}[-–]\d{0,4}\??|\?[-–]\?|\?[-–]\d{4}|\d{4}[-–]\??\s*)(?:,\s*[^)]+)?\)/;
const UNSOLD_RE = /\b(?:unsold|bought\s+in|withdrawn|invendu|ingetrokken)\b/i;
// Place names — set by per-parse initializer from options.places, else hardcoded fallback.
let PLACES = new Set([
  "Amsterdam","Delft","The Hague","London","Paris","Venice","Rotterdam","Brussels",
  "Haarlem","Utrecht","Antwerp","Rome","Berlin","Florence","Leiden","Vienna","Munich",
]);

// Regex for digit-rejoin: next part starts with 3 digits (thousands group), optionally followed
// by a space + currency word. Excludes 4-digit starts (years like "1824").
const THOUSANDS_CONT_RE = /^\d{3}(?:\s|$)/;

// Parse price string handling European decimal notation (period = thousands, comma = decimal).
// "2.000" → 2000, "3.253,50" → 3253.50, "600" → 600, "1,200" → 1200
function parsePrice(raw) {
  // If contains period followed by exactly 3 digits (thousands separator)
  if (/\.\d{3}(?:[,.]|$)/.test(raw)) {
    // European: periods are thousands, comma is decimal
    const normalized = raw.replace(/\./g, "").replace(",", ".");
    return parseFloat(normalized);
  }
  // Standard: commas are thousands, period is decimal
  return parseFloat(raw.replace(/,/g, ""));
}

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
  let prevWasAttribution = false;

  for (const t of parts) {
    // "to (the dealer) Name" → buyer/recipient
    const toBuyer = t.match(TO_BUYER_RE);
    if (toBuyer) {
      const buyerRaw = toBuyer[1].replace(/,\s*$/, "").trim();
      if (buyerRaw && (HAS_UPPER_RE.test(buyerRaw) || KNOWN_RECIPIENT_RE.test(buyerRaw))) {
        const nd = extractNameAndDates(buyerRaw);
        if (nd) {
          extraParties.push({ name: nd.name, dates: nd.dates, role: "buyer" });
        } else {
          extraParties.push({ name: buyerRaw, dates: null, role: "buyer" });
        }
        continue;
      }
    }

    // "by (the dealer) Name" → buyer (but not "by descent", "by bequest", etc.)
    const byParty = t.match(BY_PARTY_RE);
    if (byParty) {
      const partyRaw = byParty[1].replace(/,\s*$/, "").trim();
      if (partyRaw && !BY_PARTY_EXCLUDE.test(partyRaw) && (HAS_UPPER_RE.test(partyRaw) || KNOWN_RECIPIENT_RE.test(partyRaw))) {
        const nd = extractNameAndDates(partyRaw);
        if (nd) {
          extraParties.push({ name: nd.name, dates: nd.dates, role: "buyer" });
        } else {
          extraParties.push({ name: partyRaw, dates: null, role: "buyer" });
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
    if (flMatch) { priceAmount = parsePrice(flMatch[1]); priceCurrency = "guilders"; continue; }
    const poundMatch = t.match(POUND_RE);
    if (poundMatch) { priceAmount = parsePrice(poundMatch[1]); priceCurrency = "pounds"; continue; }
    const frsMatch = t.match(FRS_RE);
    if (frsMatch) { priceAmount = parsePrice(frsMatch[1]); priceCurrency = "francs"; continue; }
    const livresMatch = t.match(LIVRES_RE);
    if (livresMatch) { priceAmount = parsePrice(livresMatch[1]); priceCurrency = "livres"; continue; }
    const napMatch = t.match(NAP_RE);
    if (napMatch) { priceAmount = parsePrice(napMatch[1]); priceCurrency = "napoléons"; continue; }
    const dmMatch = t.match(DM_RE);
    if (dmMatch) { priceAmount = parsePrice(dmMatch[1]); priceCurrency = "deutschmarks"; continue; }
    const rmMatch = t.match(RM_RE);
    if (rmMatch) { priceAmount = parsePrice(rmMatch[1]); priceCurrency = "reichsmarks"; continue; }
    const sfrsMatch = t.match(SFRS_RE);
    if (sfrsMatch) { priceAmount = parsePrice(sfrsMatch[1]); priceCurrency = "swiss_francs"; continue; }
    const eurMatch = t.match(EUR_RE);
    if (eurMatch) { priceAmount = parsePrice(eurMatch[1]); priceCurrency = "euros"; continue; }
    const usdMatch = t.match(USD_RE);
    if (usdMatch) { priceAmount = parsePrice(usdMatch[1]); priceCurrency = "dollars"; continue; }

    // Skip catalogue attribution context: "as German school" / "as 'Brabant'" / "as Rembrandt"
    // These introduce artwork dating, not event dates. Flag so the NEXT circa date is suppressed.
    if (/^as\s+(?:'[^']*'|[A-Z])/i.test(t)) { prevWasAttribution = true; continue; }

    // Date patterns (ordered by specificity)
    const exactDate = t.match(EXACT_DATE_RE);
    if (exactDate) { dateExpression = t; dateYear = parseInt(exactDate[3], 10); prevWasAttribution = false; continue; }

    const qualDate = t.match(QUAL_DATE_RE);
    if (qualDate) {
      dateExpression = qualDate[0].trim();
      dateYear = parseInt(qualDate[4], 10);
      const rawQual = (qualDate[1] || qualDate[3] || "in").toLowerCase();
      dateQualifier = rawQual === "by" ? "before" : rawQual;
      prevWasAttribution = false;
      continue;
    }

    // Circa dates: skip if (a) we already have an exact date, or (b) previous part was "as [attribution]"
    const approxDate = t.match(APPROX_DATE_RE);
    if (approxDate && !prevWasAttribution) {
      if (!dateYear) { dateExpression = approxDate[0].trim(); dateYear = parseInt(approxDate[1], 10); dateQualifier = "circa"; }
      prevWasAttribution = false;
      continue;
    }
    if (approxDate && prevWasAttribution) { prevWasAttribution = false; continue; }

    const monthYear = t.match(MONTHS_RE);
    if (monthYear) { dateExpression = t; dateYear = parseInt(monthYear[2], 10); prevWasAttribution = false; continue; }

    // Date range: "1713-24", "1792/93", "1983-2005"
    const dateRange = t.match(DATE_RANGE_RE);
    if (dateRange && !dateYear) {
      const startYear = parseInt(dateRange[1], 10);
      let endPart = dateRange[2];
      if (endPart.length === 2) endPart = dateRange[1].slice(0, 2) + endPart;
      dateExpression = dateRange[0].trim();
      dateYear = startYear;
      prevWasAttribution = false;
      continue;
    }

    const bareYear = t.match(BARE_YEAR_RE);
    if (bareYear && !dateYear) { dateExpression = bareYear[1]; dateYear = parseInt(bareYear[1], 10); prevWasAttribution = false; continue; }

    prevWasAttribution = false;

    // Location (known places — check if t matches or starts with a known place)
    // Guard: skip noble title words that happen to be place names ("Heer van Soelen", "Baron van X")
    const NOBLE_TITLE_RE = /^(?:Heer|Baron|Vrouwe|Graaf|Gravin)\s+(?:van|de|het|der)\s/i;
    if (!location && !NOBLE_TITLE_RE.test(t)) {
      // Try exact match first, then progressively shorter prefixes (for "City (details)")
      let candidate_loc = null;
      if (PLACES.has(t)) { candidate_loc = t; }
      else {
        // Try trimming parenthesized suffix: "Paris (Drouot)" → "Paris"
        const parenIdx = t.indexOf("(");
        const candidate = parenIdx > 0 ? t.slice(0, parenIdx).trim() : null;
        if (candidate && PLACES.has(candidate)) { candidate_loc = candidate; }
        // Try first N words for compound names: "The Hague", "New York", "St Petersburg"
        else {
          const words = t.split(/[\s,]/);
          for (let n = Math.min(3, words.length); n >= 1; n--) {
            const prefix = words.slice(0, n).join(" ");
            if (PLACES.has(prefix)) { candidate_loc = prefix; break; }
          }
        }
      }
      // Second guard: single-word match that looks like a title word in context
      if (candidate_loc && /^(?:Heer|Baron|Vrouwe|Graaf|Gravin)$/i.test(candidate_loc)) {
        // Only accept if there's no "van" after it in the original text
        const afterLoc = t.slice(candidate_loc.length).trim();
        if (!/^van\b/i.test(afterLoc)) { location = candidate_loc; }
        // else: skip — "Baron van X" is a title, not a location
      } else {
        location = candidate_loc;
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

// Classify inheritance sub-type from relation word (CMOA alignment)
const WIDOW_RE = /\b(?:widow|widower)\b/i;
function inheritanceType(rel) {
  if (WIDOW_RE.test(rel)) return "widowhood";
  return "by_descent";  // son, daughter, heir, nephew, cousin, etc.
}


}}

{
  // Per-parse initializer: pick up places Set from options if provided
  if (options.places) PLACES = options.places;
}

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
  / EstateInventoryEvent
  / CollectionEvent
  / FromWhomEvent
  / AnaphoricEvent
  / StandardPhraseEvent
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
  / ("anonymous"i / "unknown"i / "posthumous"i / "possible"i / "possibly"i) _ "sale"i tail:Tail
    { const rest = parseRest(tail); return { type: "sale", parties: [], ...rest }; }
  / ("private"i / "german"i / "french"i / "english"i / "dutch"i / "italian"i) _ "sale"i tail:Tail
    { const rest = parseRest(tail); return { type: "sale", parties: [], ...rest }; }
  / "sold"i _ prep:("for"i / "to"i / "by"i / "with"i) _ ("the"i _)? nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      const role = prep.toLowerCase() === "to" ? "buyer" : prep.toLowerCase() === "by" ? "seller" : null;
      return { type: "sale", parties: nd && nd.name ? [{ ...nd, role }] : [], ...rest };
    }
  / "through"i _ ("the"i _)? "mediation"i _ "of"i _ nameRaw:NameChars tail:Tail
    { return buildResult("sale", extractNameAndDates(nameRaw), "intermediary", parseRest(tail)); }
  / "sale"i _ "[" section:[^\]]* "]" tail:Tail
    { const rest = parseRest(tail); return { type: "sale", parties: [], ...rest, saleSection: section.join("") }; }
  / "sale"i "," _ nameRaw:NameChars tail:Tail
    { return buildResult("sale", extractNameAndDates(nameRaw), "consignor", parseRest(tail)); }
  / "sale"i _ nameRaw:NameChars tail:Tail
    { return buildResult("sale", extractNameAndDates(nameRaw), "seller", parseRest(tail)); }

// ─── Commission ─────────────────────────────────────────────────────

CommissionEvent
  = ("commissioned"i / "comissioned"i / "commissoned"i) _ ("by"i / "for"i / "as"i / "and"i) _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "commission", parties: nd ? [{ ...nd, role: "patron" }] : [], ...rest };
    }
  / "founded"i _ "by"i _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "commission", parties: nd ? [{ ...nd, role: "patron" }] : [], ...rest };
    }

// ─── War recuperation ───────────────────────────────────────────────

WarRecupEvent
  = "war"i _ "recuperation"i ","? _ nameRaw:NameChars tail:Tail
    { return buildResult("recuperation", extractNameAndDates(nameRaw), null, parseRest(tail)); }

// ─── Confiscation ───────────────────────────────────────────────────

ConfiscationEvent
  = "confiscated"i tail:Tail
    { const rest = parseRest(tail); return { type: "confiscation", parties: [], ...rest }; }
  / "taken"i _ ("by"i / "from"i / "to"i) _ nameRaw:NameChars tail:Tail
    { return buildResult("confiscation", extractNameAndDates(nameRaw), null, parseRest(tail)); }
  / "suppressed"i tail:Tail
    { const rest = parseRest(tail); return { type: "confiscation", parties: [], ...rest }; }

// ─── Loan ───────────────────────────────────────────────────────────

LoanEvent
  = ("from"i _ ("which"i / "whom"i) _)? "on"i _ ("long"i _ "term"i _)? "loan"i _ "from"i _ nameRaw:NameChars tail:Tail
    { return buildResult("loan", extractNameAndDates(nameRaw), "lender", parseRest(tail)); }
  / ("from"i _ ("which"i / "whom"i) _)? "on"i _ ("long"i _ "term"i _)? "loan"i tail:Tail
    { const rest = parseRest(tail); return { type: "loan", parties: [], ...rest }; }
  / "on"i _ "display"i _ ("in"i / "at"i)? _? nameRaw:NameChars tail:Tail
    { return buildResult("loan", extractNameAndDates(nameRaw), null, parseRest(tail)); }
  / "exhibited"i _ ("by"i / "at"i / "in"i) _ nameRaw:NameChars tail:Tail
    { return buildResult("loan", extractNameAndDates(nameRaw), null, parseRest(tail)); }

// ─── Transfer ───────────────────────────────────────────────────────

TransferEvent
  = "transfer"i "red"i? _ "to"i _ nameRaw:NameChars tail:Tail
    { return buildResult("transfer", extractNameAndDates(nameRaw), "recipient", parseRest(tail)); }
  / "transfer"i "red"i? _ ("from"i / "for"i / "with"i / "in"i)? tail:Tail
    { const rest = parseRest(tail); return { type: "transfer", parties: [], ...rest }; }
  / ("sent"i / "removed"i / "dispatched"i) _ "to"i _ nameRaw:NameChars tail:Tail
    { return buildResult("transfer", extractNameAndDates(nameRaw), "recipient", parseRest(tail)); }
  / ("sent"i / "removed"i / "dispatched"i) _ ("from"i / "by"i / "in"i / "when"i / "at"i / "and"i / "after"i)? tail:Tail
    { const rest = parseRest(tail); return { type: "transfer", parties: [], ...rest }; }
  / "consigned"i _ "by"i _ nameRaw:NameChars tail:Tail
    { return buildResult("transfer", extractNameAndDates(nameRaw), "consignor", parseRest(tail)); }
  / "divided"i _ "with"i tail:Tail
    { const rest = parseRest(tail); return { type: "transfer", parties: [], ...rest }; }
  / "to"i _ nameRaw:NameChars tail:Tail
    &{ const nd = extractNameAndDates(nameRaw); return nd && nd.name && /^[A-Z]/.test(nd.name); }
    { return buildResult("transfer", extractNameAndDates(nameRaw), "recipient", parseRest(tail)); }

// ─── Bequest ────────────────────────────────────────────────────────

BequestEvent
  = ("bequeathed"i _ ("to"i / "by"i) / "by"i _ "bequest"i / "bequest"i / ("his"i / "her"i) _ "will"i / "testament"i) _ nameRaw:NameChars tail:Tail
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
      return { type: "sale", parties: nd && nd.name ? [{ ...nd, role: "buyer" }] : [], ...rest };
    }
  / "from"i _ "whose"i _ "heirs"i tail:Tail
    { return buildResult("sale", null, null, parseRest(tail)); }
  / "purchased"i _ "by"i _ ("the"i _)? ("museum"i / ("dealer"i _))? nameRaw:NameChars? tail:Tail
    {
      const nd = nameRaw ? extractNameAndDates(nameRaw) : null;
      const rest = parseRest(tail);
      return { type: "sale", parties: nd && nd.name ? [{ ...nd, role: "buyer" }] : [], ...rest };
    }
  / "bought"i _ "by"i _ ("the"i _)? ("dealer"i _)? nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "sale", parties: nd && nd.name ? [{ ...nd, role: "buyer" }] : [], ...rest };
    }
  / ("purchased"i / "puchased"i) _ "from"i _ nameRaw:NameChars tail:Tail
    { return buildResult("sale", nameRaw ? extractNameAndDates(nameRaw) : null, "seller", parseRest(tail)); }
  / ("acquired"i / "aqcuired"i / "verwerving"i / "aangekocht"i) _ ("by"i / "from"i / "in"i / "for"i / "with"i / "en"i / "bij"i / "door"i)? _? ("the"i / "het"i / "de"i)? _? nameRaw:NameChars tail:Tail
    {
      const nd = nameRaw ? extractNameAndDates(nameRaw) : null;
      const rest = parseRest(tail);
      return { type: "sale", parties: nd && nd.name ? [{ ...nd, role: "buyer" }] : [], ...rest };
    }
  / "purchased"i _ ("for"i / "at"i) _ nameRaw:NameChars tail:Tail
    {
      const nd = nameRaw ? extractNameAndDates(nameRaw) : null;
      const rest = parseRest(tail);
      return { type: "sale", parties: nd && nd.name ? [{ ...nd, role: "buyer" }] : [], ...rest };
    }
  / "purchased"i ","? tail:Tail
    { const rest = parseRest(tail); return { type: "sale", parties: [...(rest.extraParties || [])], ...rest, extraParties: undefined }; }

// ─── Gift ───────────────────────────────────────────────────────────

GiftEvent
  = ("donated"i / "donation"i / "anonymous"i _ "donation"i / "gift"i / "given"i / "presented"i / "dedicated"i / "schenking"i / "send"i _ "by"i) _ prep:("by"i / "to"i / "of"i / "van"i)? _? ("the"i _)? nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      const role = prep && prep.toLowerCase() === "to" ? "recipient" : "donor";
      return { type: "gift", parties: nd && nd.name ? [{ ...nd, role }] : [], ...rest };
    }

// ─── Exchange ───────────────────────────────────────────────────────

ExchangeEvent
  = "exchange"i _ ("by"i / "with"i / "between"i) _ nameRaw:NameChars? tail:Tail
    {
      const nd = nameRaw ? extractNameAndDates(nameRaw) : null;
      const rest = parseRest(tail);
      return { type: "exchange", parties: nd && nd.name ? [{ ...nd, role: null }] : [], ...rest };
    }
  / ("in"i _ "exchange"i / "exchanged"i) _ ("for"i / "with"i) _ nameRaw:NameChars? tail:Tail
    {
      const nd = nameRaw ? extractNameAndDates(nameRaw) : null;
      const rest = parseRest(tail);
      return { type: "exchange", parties: nd && nd.name ? [{ ...nd, role: null }] : [], ...rest };
    }

// ─── Restitution ────────────────────────────────────────────────────

RestitutionEvent
  = ("restituted"i / "returned"i / "redeemed"i) _ ("to"i / "by"i) _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "restitution", parties: nd && nd.name ? [{ ...nd, role: "recipient" }] : [], ...rest };
    }
  / ("returned"i / "retrieved"i / "temporarily"i _ "returned"i) tail:Tail
    { const rest = parseRest(tail); return { type: "restitution", parties: [], ...rest }; }

// ─── Deposit ────────────────────────────────────────────────────────

DepositEvent
  = ("on"i _ "deposit"i / "stored"i / "deposited"i / "kept"i / "installed"i / "placed"i / "depot"i / "buried"i) tail:Tail
    { const rest = parseRest(tail); return { type: "deposit", parties: [], ...rest }; }

// ─── Collection ─────────────────────────────────────────────────────

CollectionEvent
  = ("collection"i / "collectie"i) _ ("of"i / "van"i) _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "collection", parties: nd && nd.name ? [{ ...nd, role: "collector" }] : [], ...rest };
    }
  / ("collection"i / "collectie"i) _ nameRaw:NameChars tail:Tail
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
  / ("first"i / "last"i)? _? ("recorded"i / "mentioned"i / "documented"i / "noted"i) _ ("at"i / "in"i / "by"i)? _? nameRaw:NameChars tail:Tail
    { return buildResult("collection", extractNameAndDates(nameRaw), null, parseRest(tail)); }
  / ("with"i _)? ("an"i / "the"i)? _? ("art"i _)? "dealer"i "s"i? ","? _ nameRaw:NameChars? tail:Tail
    {
      const nd = nameRaw ? extractNameAndDates(nameRaw) : null;
      const rest = parseRest(tail);
      return { type: "collection", parties: nd && nd.name ? [{ ...nd, role: "dealer" }] : [], ...rest };
    }
  / ("art"i _)? "market"i tail:Tail
    { const rest = parseRest(tail); return { type: "sale", parties: [], ...rest }; }

// ─── Estate inventory ───────────────────────────────────────────────

EstateInventoryEvent
  = "estate"i _ "inventory"i (_ "of"i (_ ("his"i / "her"i / "their"i))?)? ","? _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "inventory", parties: nd && nd.name ? [{ ...nd, role: "deceased" }] : [], ...rest };
    }
  / "probate"i _ "inventory"i ","? _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "inventory", parties: nd && nd.name ? [{ ...nd, role: "deceased" }] : [], ...rest };
    }

// ─── From whom ──────────────────────────────────────────────────────

FromWhomEvent
  = ("from"i / "by"i) _ ("whom"i / "where"i / "which"i) _ ("probably"i _)? "donated"i tail:Tail
    { return buildResult("gift", null, null, parseRest(tail)); }
  / ("from"i / "by"i) _ ("whom"i / "where"i / "which"i) _ ("probably"i _)? "bequeathed"i tail:Tail
    { return buildResult("bequest", null, null, parseRest(tail)); }
  / ("from"i / "by"i) _ ("whom"i / "where"i / "which"i) _ ("probably"i _)? "transferred"i tail:Tail
    { return buildResult("transfer", null, null, parseRest(tail)); }
  / "from"i _ "whom"i tail:Tail
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
    { return buildResult("by_descent", extractNameAndDates(nameRaw), "deceased", parseRest(tail)); }
  / "from"i _ "the"i _ "artist"i tail:Tail
    {
      const rest = parseRest(tail);
      const type = /\btransferred\s+to\b/i.test(tail) ? "transfer" : "sale";
      return buildResult(type, { name: "the artist", dates: null }, "seller", rest);
    }
  / "from"i _ ("the"i _)? "collection"i _ nameRaw:NameChars tail:Tail
    { return buildResult("sale", extractNameAndDates(nameRaw), "seller", parseRest(tail)); }
  / "from"i _ ("the"i _)? "estate"i _ ("of"i _)? nameRaw:NameChars tail:Tail
    { return buildResult("inheritance", extractNameAndDates(nameRaw), "deceased", parseRest(tail)); }
  / ("the"i _)? "heirs"i _ ("of"i _) nameRaw:NameChars tail:Tail
    { return buildResult("by_descent", extractNameAndDates(nameRaw), "deceased", parseRest(tail)); }
  / "from"i _ ("the"i _)? !("collection"i / "estate"i) nameRaw:NameChars tail:Tail
    &{ return /\bto\b/i.test(tail); }
    {
      const rest = parseRest(tail);
      // Reclassify: if tail contains "transferred to", this is a transfer not a sale
      const type = /\btransferred\s+to\b/i.test(tail) ? "transfer" : "sale";
      return buildResult(type, extractNameAndDates(nameRaw), "seller", rest);
    }

// ─── Anaphoric ──────────────────────────────────────────────────────

AnaphoricEvent
  = poss:("his"i / "her"i / "their"i) _
    rel:RelationWord
    ","? _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const role = poss.toLowerCase() + " " + rel.toLowerCase();
      const rest = parseRest(tail);
      return { type: inheritanceType(rel), parties: nd && nd.name ? [{ ...nd, role }] : [], ...rest };
    }
  / "by"i _ "descent"i _ "to"i _ ("his"i / "her"i / "their"i) _ rel:RelationWord ","? _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: inheritanceType(rel), parties: nd && nd.name ? [{ ...nd, role: "heir" }] : [], ...rest };
    }
  / "by"i _ "descent"i tail:Tail
    { const rest = parseRest(tail); return { type: "by_descent", parties: [], ...rest }; }
  / "inherited"i _ "by"i _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "by_descent", parties: nd && nd.name ? [{ ...nd, role: "heir" }] : [], ...rest };
    }
  / ("by"i / "through"i) _ "inheritance"i _ ("to"i _)? nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "inheritance", parties: nd && nd.name ? [{ ...nd, role: "heir" }] : [], ...rest };
    }

RelationWord "relation word"
  = $("third cousin and godson"i
     / "heir and ex wife"i / "heir and ex-wife"i
     / "half-brother"i / "half-sister"i / "half brother"i / "half sister"i
     / "younger brother"i / "eldest son"i / "eldest daughter"i
     / "grandnephew"i / "grandniece"i
     / "life companion"i
     / "sons"i / "son"i / "daughters"i / "daughter"i / "daugter"i / "daugther"i / "widower"i / "widow"i
     / "distant cousin"i / "spouse"i / "relative"i / "relatives"i / "successor"i / "descendants"i
     / "husband"i / "wife"i / "nephew"i / "niece"i
     / "great-great-granddaughter"i / "great-great-grandson"i / "great great granddaughter"i / "great great grandson"i
     / "great-granddaughter"i / "great-grandson"i / "great granddaughter"i / "great grandson"i
     / "granddaughter"i / "grandson"i
     / "sister-in-law"i / "brother-in-law"i / "sister in law"i / "brother in law"i
     / "sister's grandson"i / "sister's granddaughter"i
     / "sisters"i / "sister"i / "brothers"i / "brother"i
     / "mother"i / "father"i
     / "cousins"i / "cousin"i / "uncle"i / "aunt"i
     / "stepson"i / "stepdaughter"i
     / "children"i / "heirs"i / "heir"i)

// ─── Standard provenance phrases ────────────────────────────────────

StandardPhraseEvent
  = "the"i _ "artist"i tail:Tail
    { const rest = parseRest(tail); return { type: "collection", parties: [{ name: "the artist", dates: null, role: "creator" }], ...rest }; }
  / "the"i _ "dealer"i "s"i? _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "collection", parties: nd && nd.name ? [{ ...nd, role: "dealer" }] : [], ...rest };
    }
  / "the"i _ "sitter"i tail:Tail
    { const rest = parseRest(tail); return { type: "collection", parties: [{ name: "the sitter", dates: null, role: "sitter" }], ...rest }; }
  / "private"i _ "collection"i tail:Tail
    { const rest = parseRest(tail); return { type: "collection", parties: [], ...rest }; }
  / "anonymous"i _ "collection"i tail:Tail
    { const rest = parseRest(tail); return { type: "collection", parties: [], ...rest }; }
  / "whence"i tail:Tail
    { return buildResult("sale", null, null, parseRest(tail)); }
  / "recorded"i _ "in"i _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "collection", parties: nd && nd.name ? [{ ...nd, role: null }] : [], ...rest };
    }
  / "description"i _ "of"i _ nameRaw:NameChars tail:Tail
    {
      const rest = parseRest(tail);
      return { type: "collection", parties: [], ...rest };
    }
  / "SNK"i tail:Tail
    { const rest = parseRest(tail); return { type: "collection", parties: [{ name: "Stichting Nederlandsch Kunstbezit", dates: null, role: null }], ...rest }; }
  / "DRVK"i tail:Tail
    { const rest = parseRest(tail); return { type: "collection", parties: [{ name: "Dienst voor 's Rijks Verspreide Kunstvoorwerpen", dates: null, role: null }], ...rest }; }
  / "as"i _ "security"i tail:Tail
    { const rest = parseRest(tail); return { type: "deposit", parties: [], ...rest }; }
  / "auction"i _ nameRaw:NameChars tail:Tail
    { return buildResult("sale", extractNameAndDates(nameRaw), "auctioneer", parseRest(tail)); }
  / "found"i _ "in"i _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "collection", parties: nd && nd.name ? [{ ...nd, role: null }] : [], ...rest };
    }
  / "moved"i _ "to"i tail:Tail
    { const rest = parseRest(tail); return { type: "transfer", parties: [], ...rest }; }
  / "found"i _ ("during"i / "in"i / "at"i / "near"i / "under"i / "on"i / "by"i)? _? ("the"i _)? nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "collection", parties: nd && nd.name ? [{ ...nd, role: null }] : [], ...rest };
    }
  / ("excavated"i / "excavation"i) _ ("at"i / "in"i / "near"i / "works"i)? _ ("the"i _ "site"i _ "of"i _)? nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "collection", parties: nd && nd.name ? [{ ...nd, role: null }] : [], ...rest };
    }
  / "dredged"i _ ("from"i _)? nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "collection", parties: nd && nd.name ? [{ ...nd, role: null }] : [], ...rest };
    }
  / "discovered"i _ ("in"i / "at"i / "near"i)? _? nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "collection", parties: nd && nd.name ? [{ ...nd, role: null }] : [], ...rest };
    }
  / ("country"i _ "house"i / "garden"i) _ nameRaw:NameChars tail:Tail
    {
      const nd = extractNameAndDates(nameRaw);
      const rest = parseRest(tail);
      return { type: "collection", parties: nd && nd.name ? [{ ...nd, role: null }] : [], ...rest };
    }
  / "deaccessioned"i _ ("by"i _)? nameRaw:NameChars tail:Tail
    { return buildResult("sale", extractNameAndDates(nameRaw), null, parseRest(tail)); }
  / "dismantled"i tail:Tail
    { const rest = parseRest(tail); return { type: "transfer", parties: [], ...rest }; }
  / ("unknown"i / "unidentified"i) _ "collector"i tail:Tail
    { const rest = parseRest(tail); return { type: "collection", parties: [], ...rest }; }
  / "stolen"i tail:Tail
    { const rest = parseRest(tail); return { type: "theft", parties: [], ...rest }; }
  / "looted"i tail:Tail
    { const rest = parseRest(tail); return { type: "looting", parties: [], ...rest }; }
  / "seized"i tail:Tail
    { const rest = parseRest(tail); return { type: "confiscation", parties: [], ...rest }; }
  / "awarded"i _ "to"i _ nameRaw:NameChars tail:Tail
    { return buildResult("gift", extractNameAndDates(nameRaw), "recipient", parseRest(tail)); }
  / "reinstalled"i tail:Tail
    { const rest = parseRest(tail); return { type: "transfer", parties: [], ...rest }; }
  / "on"i _ "lease"i _ ("to"i / "from"i)? tail:Tail
    { const rest = parseRest(tail); return { type: "loan", parties: [], ...rest }; }
  / "veiling"i _ nameRaw:NameChars tail:Tail
    { return buildResult("sale", extractNameAndDates(nameRaw), "auctioneer", parseRest(tail)); }
  / "gekocht"i _ ("door"i / "van"i / "bij"i) _ ("het"i / "de"i)? _? nameRaw:NameChars tail:Tail
    { return buildResult("sale", extractNameAndDates(nameRaw), "buyer", parseRest(tail)); }
  / ("aangekocht"i / "verworven"i) _ ("door"i / "van"i / "bij"i)? _? ("het"i / "de"i)? _? nameRaw:NameChars tail:Tail
    { return buildResult("sale", extractNameAndDates(nameRaw), "buyer", parseRest(tail)); }
  / "geschonken"i _ ("aan"i / "door"i) _ ("het"i / "de"i)? _? nameRaw:NameChars tail:Tail
    { return buildResult("gift", extractNameAndDates(nameRaw), "recipient", parseRest(tail)); }
  / "with"i _ "the"i _ ("castle"i / "house"i / "estate"i) _ "to"i _ nameRaw:NameChars tail:Tail
    { return buildResult("by_descent", extractNameAndDates(nameRaw), "heir", parseRest(tail)); }
  / "through"i _ "the"i _ "family"i _ ("to"i _)? nameRaw:NameChars tail:Tail
    { return buildResult("by_descent", extractNameAndDates(nameRaw), "heir", parseRest(tail)); }
  / ("the"i _)? "estate"i _ "of"i _ nameRaw:NameChars tail:Tail
    { return buildResult("inheritance", extractNameAndDates(nameRaw), "deceased", parseRest(tail)); }
  / "received"i _ "by"i _ nameRaw:NameChars tail:Tail
    { return buildResult("transfer", extractNameAndDates(nameRaw), "recipient", parseRest(tail)); }
  / "lottery"i _ ("held"i _ "by"i _)? nameRaw:NameChars tail:Tail
    { return buildResult("sale", extractNameAndDates(nameRaw), "auctioneer", parseRest(tail)); }
  / ("unidentified"i / "unknown"i) _ ("collection"i / "collector"i) tail:Tail
    { const rest = parseRest(tail); return { type: "collection", parties: [], ...rest }; }
  / ("property"i / "archives"i) _ "of"i _ nameRaw:NameChars tail:Tail
    { return buildResult("collection", extractNameAndDates(nameRaw), "collector", parseRest(tail)); }
  / "entered"i _ "the"i _ "museum"i tail:Tail
    { const rest = parseRest(tail); return { type: "transfer", parties: [], ...rest }; }
  / ("also"i _)? ("recorded"i / "listed"i / "displayed"i) _ ("in"i / "at"i / "by"i)? _? nameRaw:NameChars tail:Tail
    { return buildResult("collection", extractNameAndDates(nameRaw), null, parseRest(tail)); }
  / "appraisal"i tail:Tail
    { const rest = parseRest(tail); return { type: "inventory", parties: [], ...rest }; }
  / ("possibly"i / "probably"i / "an"i / "a"i) _ ([a-zA-Z]+ _)? ("private"i _)? "collection"i tail:Tail
    { const rest = parseRest(tail); return { type: "collection", parties: [], ...rest }; }
  / "'s"i _ "Rijks"i _ "verzameling"i tail:Tail
    { const rest = parseRest(tail); return { type: "collection", parties: [], ...rest }; }
  / "erven"i _ nameRaw:NameChars tail:Tail
    { return buildResult("by_descent", extractNameAndDates(nameRaw), "heir", parseRest(tail)); }
  / "studio"i _ "estate"i _ "of"i _ nameRaw:NameChars tail:Tail
    { return buildResult("inheritance", extractNameAndDates(nameRaw), "deceased", parseRest(tail)); }

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
