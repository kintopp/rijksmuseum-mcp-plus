/**
 * Rule-based provenance parser for Rijksmuseum Linked Art provenance strings.
 *
 * Provenance follows the AAM (American Alliance of Museums) punctuation convention:
 *   - `;` separates ownership events (direct succession)
 *   - `…` or `...` marks gaps in the chain
 *   - `{...}` encloses inline bibliographic citations
 *   - `?` prefix marks uncertain attribution
 *   - `(YYYY-YYYY)` life dates, `c.` approximate, `before`/`after` qualifiers
 *
 * Pipeline: extractCitations → splitEvents → per-event parsing → ProvenanceChain
 */

// ─── Types ─────────────────────────────────────────────────────────

export interface ProvenanceDate {
  text: string;
  year: number | null;
  approximate: boolean;
  qualifier: "before" | "after" | "circa" | null;
}

export interface ProvenancePrice {
  text: string;
  amount: number | null;
  currency: string;
}

export interface ProvenanceCitation {
  text: string;
}

export interface ProvenanceParty {
  name: string;
  dates: string | null;
  uncertain: boolean;
  role: string | null;
  position?: "sender" | "receiver" | "agent" | null;
}

export type TransferType =
  | "sale"
  | "inheritance"
  | "bequest"
  | "commission"
  | "purchase"
  | "confiscation"
  | "recuperation"
  | "loan"
  | "transfer"
  | "collection"
  | "gift"
  | "auction"
  | "exchange"
  | "deposit"
  | "seizure"
  | "restitution"
  | "donation"
  | "inventory"
  | "unknown";

export type TransferCategory = "ownership" | "custody" | "ambiguous";

// ─── Party position mapping ──────────────────────────────────────────
// Maps party roles (assigned by PEG grammar) to transfer positions.
// Position is relative to the transfer event:
//   sender = relinquishes the artwork
//   receiver = acquires the artwork
//   agent = facilitates without owning

export const ROLE_TO_POSITION: Record<string, "sender" | "receiver" | "agent"> = {
  // Receivers
  buyer: "receiver",
  heir: "receiver",
  recipient: "receiver",
  patron: "receiver",
  collector: "receiver",
  creator: "receiver",
  sitter: "receiver",
  // Senders
  seller: "sender",
  consignor: "sender",
  donor: "sender",
  deceased: "sender",
  lender: "sender",
  // Agents
  intermediary: "agent",
  auctioneer: "agent",
  dealer: "agent",
};

/**
 * Infer a party's transfer position from its role and transfer type.
 *
 * Three-tier inference:
 *   1. Explicit role mapping (ROLE_TO_POSITION)
 *   2. Anaphoric roles ("his son", "her widow") → receiver
 *   3. Null-role fallback by transfer type — when a party has no role
 *      (GenericOwnerEvent catch-all), the transfer type often determines
 *      position: in a collection/recuperation/commission the named party
 *      is typically the receiver (holder of the artwork).
 */
export function inferPosition(
  role: string | null,
  transferType: TransferType,
): "sender" | "receiver" | "agent" | null {
  if (role) {
    const mapped = ROLE_TO_POSITION[role];
    if (mapped) return mapped;
    // Anaphoric roles: "his son", "her widow", "their grandson" — always inheritance receivers
    if (/^(?:his|her|their)\s+/i.test(role)) return "receiver";
    return null;
  }

  // Null-role fallback: infer position from transfer type context.
  // The named party in these event types is almost always the holder/receiver.
  switch (transferType) {
    case "collection":
    case "recuperation":
    case "restitution":
    case "commission":
    case "inventory":
      return "receiver";
    default:
      return null;
  }
}

// ─── Transfer category mapping ───────────────────────────────────────

export const TRANSFER_TYPE_TO_CATEGORY: Record<TransferType, TransferCategory> = {
  sale: "ownership",
  purchase: "ownership",
  inheritance: "ownership",
  bequest: "ownership",
  gift: "ownership",
  donation: "ownership",
  commission: "ownership",
  exchange: "ownership",
  confiscation: "ownership",
  recuperation: "ownership",
  restitution: "ownership",
  seizure: "ownership",
  auction: "ownership",
  collection: "ownership",
  inventory: "ownership",
  loan: "custody",
  deposit: "custody",
  transfer: "ambiguous",
  unknown: "ambiguous",
};

export interface ProvenanceEvent {
  sequence: number;
  rawText: string;
  gap: boolean;
  party: ProvenanceParty | null;
  transferType: TransferType;
  date: ProvenanceDate | null;
  location: string | null;
  price: ProvenancePrice | null;
  saleDetails: string | null;
  citations: ProvenanceCitation[];
  uncertain: boolean;
}

export interface ProvenanceChain {
  events: ProvenanceEvent[];
  raw: string;
}

// ─── 1. extractCitations ───────────────────────────────────────────

/**
 * Pull `{...}` citation blocks out of the text, replacing them with
 * `__CIT_N__` placeholders. Citations can contain semicolons, dates,
 * and names that would confuse later pipeline stages.
 */
export function extractCitations(text: string): {
  cleaned: string;
  citations: Map<string, string>;
} {
  const citations = new Map<string, string>();
  let idx = 0;
  const cleaned = text.replace(/\{([^}]*)\}/g, (_match, inner: string) => {
    const key = `__CIT_${idx}__`;
    citations.set(key, inner.trim());
    idx++;
    return key;
  });
  return { cleaned, citations };
}

// ─── 2. splitEvents ────────────────────────────────────────────────

/**
 * Split provenance text on `;` and detect gap markers (`…` or `...`)
 * at the start or end of segments.
 *
 * AAM convention: `{...} …;` means a gap before the next event.
 * The ellipsis may appear as a leading `…`, a trailing `…`, or a
 * standalone segment containing only citation placeholders + ellipsis.
 */
export function splitEvents(
  text: string
): { text: string; gap: boolean }[] {
  if (!text || !text.trim()) return [];

  // Normalize doubled articles ("the the dealer" → "the dealer")
  text = text.replace(/\bthe\s+the\b/gi, "the");

  // Decode &amp; before splitting — the ';' in '&amp;' is a false event delimiter.
  // Other entities (&lt; &gt; etc.) don't contain ';' at a position that causes splits,
  // and full stripHtml() runs per-segment after splitting.
  text = text.replace(/&amp;/gi, "&");

  // Split on semicolons, but not inside parentheses or brackets — catalogue
  // descriptions in ('...') and ('[...]') often contain semicolons as French/
  // Dutch clause separators that should not create event boundaries.
  // Note: single-quote tracking is limited to opening `('` sequences to avoid
  // false matches on possessive apostrophes like "Sotheby's".
  const raw: string[] = [];
  let depth = 0;
  let inQuotedDesc = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotedDesc) {
      // End quoted description: closing quote followed by closing paren
      if (ch === "'" && i + 1 < text.length && text[i + 1] === ")") {
        inQuotedDesc = false;
        // Don't decrement depth here — the ')' will do it on next iteration
      }
    } else if (ch === "(" && i + 1 < text.length && text[i + 1] === "'") {
      // Start of ('...') catalogue description — enter quoted mode
      depth++;
      inQuotedDesc = true;
      i++; // skip the opening quote
    } else if (ch === "(" || ch === "[") {
      depth++;
    } else if ((ch === ")" || ch === "]") && depth > 0) {
      depth--;
    } else if (ch === ";" && depth === 0) {
      raw.push(text.slice(start, i));
      start = i + 1;
    }
  }
  raw.push(text.slice(start));
  const results: { text: string; gap: boolean }[] = [];
  let pendingGap = false;

  for (const segment of raw) {
    let trimmed = segment.trim();
    if (!trimmed) continue;

    // Strip citation placeholders for gap detection (they're noise here)
    const stripped = trimmed.replace(/__CIT_\d+__/g, "").trim();

    // Is this segment purely a gap marker (ellipsis, maybe with citation placeholders)?
    if (/^[.\u2026\s]*$/.test(stripped) && /[\u2026]|\.{3}/.test(stripped)) {
      pendingGap = true;
      continue;
    }
    // Also match segments that are ONLY citation placeholders + ellipsis
    if (!stripped || /^[.\u2026]{1,3}$/.test(stripped)) {
      if (/[\u2026]|\.{3}/.test(trimmed)) pendingGap = true;
      continue;
    }

    let gap = pendingGap;
    pendingGap = false;

    // Leading ellipsis on this segment
    if (/^[\u2026]|^\.{3}/.test(trimmed)) {
      gap = true;
      trimmed = trimmed.replace(/^[\u2026]|^\.{3}/, "").trim();
      trimmed = trimmed.replace(/^[;,]\s*/, "");
    }

    // Trailing ellipsis — means gap AFTER this segment (before next)
    if (/[\u2026]\s*$|\.{3}\s*$/.test(trimmed)) {
      trimmed = trimmed.replace(/[\u2026]\s*$|\.{3}\s*$/, "").trim();
      pendingGap = true;
    }

    if (!trimmed) continue;

    // Skip standalone inventory-mark abbreviations (not provenance events)
    if (/^Inv\.?\s*$/i.test(trimmed)) continue;

    // Skip cross-reference preambles: "For both the present painting (SK-A-3857) and its pendant"
    // These introduce shared provenance for multiple artworks — not events themselves.
    if (/^For (?:both )?the present /i.test(trimmed)) continue;

    // Skip fragment artefacts: bare years, orphaned connectors
    const fragStripped = trimmed.replace(/__CIT_\d+__/g, "").trim();
    if (/^\d{4}$/.test(fragStripped)) continue;                    // bare year
    if (/^(?:et al\.?|_ and _)$/i.test(fragStripped)) continue;    // orphaned connectors

    results.push({ text: trimmed, gap });
  }

  return results;
}

// ─── 3. stripHtml ──────────────────────────────────────────────────

/** Map of named HTML entities to their character equivalents. */
const HTML_ENTITY_MAP: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
};

/** Remove HTML tags, entities, leaked CSS, and Linked Art artifacts, preserving inner text. */
export function stripHtml(text: string): string {
  return text
    .replace(/<\/?[a-z][a-z0-9]*[^>]*>?/gi, "")             // HTML tags (including unclosed)
    .replace(/&(nbsp|amp|lt|gt|quot|apos);?/gi, (_m, e: string) =>
      HTML_ENTITY_MAP[e.toLowerCase()] ?? "")
    .replace(/&#\d+;?/g, "")                                  // numeric HTML entities
    .replace(/(?:font-family|mso-[\w-]+|font-size|line-height|color|margin|padding|text-align|text-indent)\s*:[^;]*;?\s*/gi, "")  // leaked CSS
    .replace(/^"+>?\s*/, "")                                   // "> prefix (Linked Art artifact)
    .replace(/\*\*([^*]+)\*\*/g, "$1")                        // **bold** markdown
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ─── 4. classifyTransfer ───────────────────────────────────────────

const TRANSFER_RULES: [RegExp, TransferType][] = [
  [/\bcommissioned (?:by|for|as)\b/i, "commission"],
  [/war recuperation/i, "recuperation"],
  [/confiscat|Führermuseum/i, "confiscation"],
  [/\bfrom which on loan\b|on loan/i, "loan"],
  [/\btransfer(?:red)?\b|\bsent to\b|\bremoved\b/i, "transfer"],
  [/bequest|bequeathed/i, "bequest"],
  [/\bsold[, ]+(?:by|to|with)\b|\bthrough the mediation\b|\bfrom the artist\b/i, "sale"],
  [/(?:his|her|their) (?:posthumous |deceased )?sale|sale [A-Z]|sale\b.*\d{4}|\bsale\s*\[|\bby whom sold\b/i, "sale"],
  [/\bpurchased\b|from whom purchased|from whose heirs.*to the museum|\bbought by\b/i, "purchase"],
  [/\bacquired\b|\bverwerving\b/i, "purchase"],
  [/from whom,.*\bto\b|by whom to\b|\bfrom the dealer\b|\bfrom (?:Count|Baron|Prince|Marchesa|Conte)\b.*\bto\b/i, "sale"],
  [/\b(?:his|her|their) (?:sons?|heirs?|daughters?|sisters?|brothers?|cousins?|wife|uncle|aunt|nephew|niece|stepson|stepdaughter|grands?(?:on|daughter)|great-grands?(?:on|daughter)|sister's grands?(?:on|daughter))\b|\bwidow(?:er)?\b|\bby descent\b|\binherited by\b|\bby inheritance\b|\bthrough inheritance\b|\bfrom the heirs\b/i, "inheritance"],
  [/\bexchanged (?:with|for)\b/i, "exchange"],
  [/\bcollection\b|\bwith an? (?:art )?dealer\b|\bex\.?\s*coll\.?\b|\bfirst (?:recorded|mentioned)\b|\b(?:probate )?inventory\b/i, "collection"],
  [/\bdonated\b|\bdonation\b|\bgift\b|\bgiven by\b|\bpresented by\b|\bdedicated to\b|\bschenking\b/i, "gift"],
  [/\bstored\b|\bdeposited\b|\binstalled\b|\bplaced\b/i, "deposit"],
  [/\bestate inventory\b/i, "collection"],
];

/** Classify the transfer type of a provenance segment using keyword priority. */
export function classifyTransfer(text: string): TransferType {
  for (const [pattern, type] of TRANSFER_RULES) {
    if (pattern.test(text)) return type;
  }
  return "unknown";
}

// ─── 5. parseDate ──────────────────────────────────────────────────

// Pre-compiled date patterns (avoid per-call RegExp construction)
const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December";
const RE_EXACT_DATE = new RegExp(`(\\d{1,2})\\s+(${MONTHS})\\s+(\\d{4})`);
const RE_MONTH_YEAR = new RegExp(`(${MONTHS})\\s+(\\d{4})`);

/**
 * Extract the most prominent date from a provenance segment.
 * Priority: exact date > qualified year > approximate year > bare year.
 */
export function parseDate(text: string): ProvenanceDate | null {
  // Exact date: "16 May 1696" or "8 July 1992"
  const exactMatch = text.match(RE_EXACT_DATE);
  if (exactMatch) {
    return {
      text: exactMatch[0],
      year: parseInt(exactMatch[3], 10),
      approximate: false,
      qualifier: null,
    };
  }

  // Before/after year: "before 1860", "after 1752"
  const qualMatch = text.match(/\b(before|after)\s+(\d{4})\b/i);
  if (qualMatch) {
    return {
      text: qualMatch[0],
      year: parseInt(qualMatch[2], 10),
      approximate: false,
      qualifier: qualMatch[1].toLowerCase() as "before" | "after",
    };
  }

  // Approximate year: "c. 1915", "c.1915"
  const approxMatch = text.match(/\bc\.\s*(\d{4})\b/);
  if (approxMatch) {
    return {
      text: approxMatch[0],
      year: parseInt(approxMatch[1], 10),
      approximate: true,
      qualifier: "circa",
    };
  }

  // Month+year (after qualifiers to avoid false matches on ranges)
  const monthYearMatch = text.match(RE_MONTH_YEAR);
  if (monthYearMatch) {
    return {
      text: monthYearMatch[0],
      year: parseInt(monthYearMatch[2], 10),
      approximate: false,
      qualifier: null,
    };
  }

  // Bare year at end or after comma: ", 1908" or standalone "1960"
  // Avoid matching years inside life dates (YYYY-YYYY) or citation placeholders
  const bareMatch = text.match(/(?:,\s*|\b)(\d{4})\b(?!\s*[-–]|\s*\))/);
  if (bareMatch) {
    // Verify it's not inside parenthetical life dates
    // Use bareMatch.index (not indexOf) — indexOf finds the first occurrence
    // which may be inside a life-date span if the same year appears twice
    const pos = bareMatch.index!;
    const before = text.slice(0, pos);
    const after = text.slice(pos + bareMatch[0].length);
    // Skip if it looks like life dates: "(1624-1674)"
    if (/\(\d{4}[-–]$/.test(before) || /^[-–]\d{4}\)/.test(after)) {
      // This is a life date, skip
    } else {
      return {
        text: bareMatch[1],
        year: parseInt(bareMatch[1], 10),
        approximate: false,
        qualifier: null,
      };
    }
  }

  return null;
}

// ─── 6. parsePrice ─────────────────────────────────────────────────

/** Try matching a price pattern; return structured result or null. */
function matchPrice(text: string, pattern: RegExp, currency: string): ProvenancePrice | null {
  const m = text.match(pattern);
  if (!m) return null;
  return { text: m[0], amount: parseFloat(m[1].replace(/,/g, "")), currency };
}

// Price patterns: [regex with amount in group 1, currency label]
const PRICE_RULES: [RegExp, string][] = [
  [/fl\.\s*([\d,]+)/, "guilders"],
  [/£\s*([\d,]+)/, "pounds"],
  [/frs\.\s*([\d,]+)/, "francs"],
  [/([\d,]+)\s*livres/i, "livres"],
  [/([\d,]+)\s*Napol[eé]ons/i, "napoléons"],
];

/**
 * Extract price/currency from a provenance segment.
 * Handles: fl., £, frs., livres, Napoléons.
 */
export function parsePrice(text: string): ProvenancePrice | null {
  for (const [pattern, currency] of PRICE_RULES) {
    const result = matchPrice(text, pattern, currency);
    if (result) return result;
  }
  return null;
}

// ─── 7. parseParty ─────────────────────────────────────────────────

// Anaphoric role patterns: "his son", "her widower", "their sons", "his grandson", etc.
const ANAPHORA_PATTERN =
  /^(?:\?\s*)?(his|her|their)\s+(sons?|daughters?|widower|widow|husband|nephew|niece|grandson|granddaughter)/i;

/** Try extracting a party by matching a keyword prefix and extracting name+dates after it. */
function tryKeywordParty(
  working: string, pattern: RegExp, role: string, uncertain: boolean, anchored = true
): ProvenanceParty | null {
  const m = working.match(pattern);
  if (!m) return null;
  const offset = anchored ? m[0].length : m.index! + m[0].length;
  const nameAndDates = extractNameAndDates(working.slice(offset));
  if (!nameAndDates) return null;
  return { ...nameAndDates, uncertain, role };
}

/**
 * Extract the owner/party from a provenance segment.
 * Handles: direct name, anaphoric references, life dates, uncertainty.
 */
export function parseParty(text: string): ProvenanceParty | null {
  if (!text.trim()) return null;

  let uncertain = false;
  let working = text.trim();

  // Strip leading "?" for uncertainty
  if (working.startsWith("?")) {
    uncertain = true;
    working = working.slice(1).trim();
  }

  // Anaphoric role: "his son, Jonkheer Pieter..."
  const anaphoraMatch = working.match(ANAPHORA_PATTERN);
  if (anaphoraMatch) {
    const role = `${anaphoraMatch[1]} ${anaphoraMatch[2]}`.toLowerCase();
    const afterRole = working.slice(anaphoraMatch[0].length).replace(/^,\s*/, "");
    const nameAndDates = extractNameAndDates(afterRole);
    if (nameAndDates) {
      return { ...nameAndDates, uncertain, role };
    }
    return { name: afterRole.split(",")[0].trim(), dates: null, uncertain, role };
  }

  // Keyword-based extraction (anchored patterns — match at start of text)
  const keywordResult =
    tryKeywordParty(working, /^[Cc]ommissioned by\s+/, "patron", uncertain) ||
    tryKeywordParty(working, /^sale\s+(?:\[(?:section\s+)?)?/i, "seller", uncertain) ||
    tryKeywordParty(working, /^collection\s+/i, "collector", uncertain) ||
    tryKeywordParty(working, /^estate inventory(?:\s+of(?:\s+(?:his|her|their))?)?,?\s*/i, "deceased", uncertain) ||
    tryKeywordParty(working, /^by whom\s+(?:(?:probably\s+)?sold\s+)?to\s+/i, "buyer", uncertain) ||
    tryKeywordParty(working, /^bought by\s+(?:the\s+)?(?:dealer\s+)?/i, "buyer", uncertain) ||
    tryKeywordParty(working, /^(?:given|presented) by\s+(?:the\s+)?/i, "donor", uncertain);
  if (keywordResult) return keywordResult;

  // "from whom purchased by <Name>" — non-anchored (may appear mid-text), with early return on failure
  const fromWhomResult = tryKeywordParty(
    working, /from whom(?:\s+purchased)?\s+by\s+(?:the\s+)?(?:dealer\s+)?/i, "buyer", uncertain, false
  );
  if (fromWhomResult) return fromWhomResult;
  if (/from whom(?:\s+purchased)?\s+by\b/i.test(working)) return null;

  // "purchased by <Name>" — non-anchored (only when "from whom" didn't match above)
  const purchasedResult = tryKeywordParty(
    working, /purchased by\s+(?:the\s+)?(?:museum|dealer\s+)?/i, "buyer", uncertain, false
  );
  if (purchasedResult) return purchasedResult;

  // "to <Name>" buyer at end after price — non-anchored
  const toBuyerResult = tryKeywordParty(
    working, /,\s+to\s+(?:the\s+)?(?:dealer[s]?\s+)?/i, "buyer", uncertain, false
  );
  if (toBuyerResult) return toBuyerResult;

  // "by whom sold, YEAR" (no explicit buyer)
  if (/^by whom\b/i.test(working)) return null;

  // "from the dealer <Name>, to ..." — require "dealer" or negative lookahead to avoid
  // false matches on "from the collection of..." / "from the estate of..."
  const fromDealerMatch = working.match(/^from the (?!collection\b|estate\b|heirs?\b)(?:dealer\s+)?/i);
  if (fromDealerMatch && /\bto\b/i.test(working)) {
    const nameAndDates = extractNameAndDates(working.slice(fromDealerMatch[0].length));
    if (nameAndDates) {
      return { ...nameAndDates, uncertain, role: "seller" };
    }
  }

  // Patterns with no person to extract
  if (/^with an?\s+(?:art\s+)?dealer\b/i.test(working)) return null;
  if (/^war recuperation/i.test(working)) return null;
  if (/^on loan/i.test(working)) return null;
  if (/^transferred to/i.test(working)) return null;

  // Generic: first name with optional dates
  const nameAndDates = extractNameAndDates(working);
  if (nameAndDates) {
    return { ...nameAndDates, uncertain, role: null };
  }

  return null;
}

/**
 * Extract a name and optional life dates from the start of a text fragment.
 * Life dates: `(1624-1674)`, `(?-?)`, `(1729-1774?)`, `(1588-1664)`.
 */
function extractNameAndDates(
  text: string
): { name: string; dates: string | null } | null {
  if (!text.trim()) return null;

  // Match: Name (YYYY-YYYY) or Name (?-?)
  const datesMatch = text.match(/^([^(]+?)\s*\((\d{4}[\/?]?\d{0,2}[-–]\d{0,4}\??|\?[-–]\?|\?[-–]\d{4}|\d{4}[-–]\??\s*)(?:,\s*[^)]+)?\)/);
  if (datesMatch) {
    const name = datesMatch[1].trim().replace(/,\s*$/, "");
    if (name) {
      return { name, dates: datesMatch[2] };
    }
  }

  // No dates — take text up to the first comma (location delimiter)
  // But skip commas inside quoted strings
  const parts = text.split(",");
  const name = parts[0].trim();
  if (name && /[A-Z]/.test(name)) {
    return { name: name.replace(/\]$/, ""), dates: null };
  }

  return null;
}

// ─── 8. parseLocation ──────────────────────────────────────────────

// Place names — shared with PEG grammar (src/places.json, 2,302 entries from vocab DB)
import placesJson from "./places.json" with { type: "json" };
const placesSet: Set<string> = new Set(placesJson as string[]);

/**
 * Extract location from a provenance segment.
 * Checks comma-separated parts against the places Set.
 */
export function parseLocation(text: string): string | null {
  // Split on comma and "and" to handle "London and New York"
  const parts = text.split(/,|\band\b/).map(p => p.trim()).filter(Boolean);
  for (const p of parts) {
    if (placesSet.has(p)) return p;
    // Try trimming parenthesized suffix: "Paris (Drouot)" → "Paris"
    const parenIdx = p.indexOf("(");
    if (parenIdx > 0) {
      const candidate = p.slice(0, parenIdx).trim();
      if (placesSet.has(candidate)) return candidate;
    }
    // Try first N words for compound names
    const words = p.split(/\s+/);
    for (let n = Math.min(3, words.length); n >= 1; n--) {
      const prefix = words.slice(0, n).join(" ");
      if (placesSet.has(prefix)) return prefix;
    }
  }
  return null;
}

// ─── 9. parseEvent ─────────────────────────────────────────────────

/**
 * Parse a single provenance segment into a structured event.
 * Re-inserts citations from the placeholder map.
 */
export function parseEvent(
  segment: { text: string; gap: boolean },
  sequence: number,
  citationMap: Map<string, string>
): ProvenanceEvent {
  const rawText = stripHtml(segment.text);
  let working = rawText;

  // Re-insert citation placeholders for the rawText, but parse on cleaned text
  const citations: ProvenanceCitation[] = [];
  const citRefs = working.match(/__CIT_\d+__/g) || [];
  for (const ref of citRefs) {
    const citText = citationMap.get(ref);
    if (citText) citations.push({ text: stripHtml(citText) });
  }
  // Remove citation placeholders from working text for parsing
  working = working.replace(/__CIT_\d+__/g, "").trim();
  // Clean up doubled spaces and trailing/leading punctuation
  working = working.replace(/\s{2,}/g, " ").trim();

  // Detect and strip uncertainty marker for classifyTransfer.
  // Note: parseParty receives `working` (with `?`) because it strips `?`
  // internally to set its own `uncertain` flag. Do NOT pass cleanedWorking
  // to parseParty — that would skip the uncertainty detection.
  const uncertain = working.startsWith("?");
  const cleanedWorking = uncertain ? working.slice(1).trim() : working;

  // Extract sale details (lot number, auction house)
  let saleDetails: string | null = null;
  const lotMatch = working.match(/\bno\.\s*\d+/i);
  if (lotMatch) {
    // Look for auction house in parentheses before lot
    const auctionMatch = working.match(/\(([^)]+)\)\s*,?\s*\d/);
    saleDetails = auctionMatch
      ? `${auctionMatch[1].trim()}, ${lotMatch[0]}`
      : lotMatch[0];
  }

  return {
    sequence,
    rawText: restoreCitations(rawText, citationMap),
    gap: segment.gap,
    party: parseParty(working),
    transferType: classifyTransfer(cleanedWorking),
    date: parseDate(working),
    location: parseLocation(working),
    price: parsePrice(working),
    saleDetails,
    citations,
    uncertain,
  };
}

/** Restore citation placeholders back to `{...}` text, with HTML stripped. */
function restoreCitations(
  text: string,
  citationMap: Map<string, string>
): string {
  return text.replace(/__CIT_\d+__/g, (key) => {
    const val = citationMap.get(key);
    return val != null ? `{${stripHtml(val)}}` : key;
  });
}

// ─── 10. parseProvenance ───────────────────────────────────────────

/**
 * Entry point: parse a full provenance string into a structured chain.
 * Pipeline: extractCitations → splitEvents → map(parseEvent).
 */
export function parseProvenance(text: string | null | undefined): ProvenanceChain {
  if (!text || !text.trim()) {
    return { events: [], raw: text ?? "" };
  }

  const { cleaned, citations } = extractCitations(text);
  const segments = splitEvents(cleaned);
  const events = segments.map((seg, i) => parseEvent(seg, i + 1, citations));

  return { events, raw: text };
}
