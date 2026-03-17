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
  | "unknown";

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

  const raw = text.split(";");
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

    results.push({ text: trimmed, gap });
  }

  return results;
}

// ─── 3. stripHtml ──────────────────────────────────────────────────

/** Remove HTML tags (e.g. `<em>`, `</em>`, `<i>`, `</i>`), preserving inner text. */
export function stripHtml(text: string): string {
  return text.replace(/<\/?[a-z][a-z0-9]*[^>]*>/gi, "");
}

// ─── 4. classifyTransfer ───────────────────────────────────────────

const TRANSFER_RULES: [RegExp, TransferType][] = [
  [/commissioned by/i, "commission"],
  [/war recuperation/i, "recuperation"],
  [/confiscat|Führermuseum/i, "confiscation"],
  [/on loan/i, "loan"],
  [/transferred to/i, "transfer"],
  [/bequest|bequeathed/i, "bequest"],
  [/(?:his|her|their) sale|sale [A-Z]|sale\b.*\d{4}|\bsale\s*\[/i, "sale"],
  [/purchased by|from whom purchased|from whose heirs.*to the museum/i, "purchase"],
  [/\bhis son\b|\bher son\b|\btheir son\b|\bdaughter\b|\bwidower\b|\bwidow\b|\bby descent\b|\bher husband\b|\bher nephew\b/i, "inheritance"],
  [/\bcollection\b/i, "collection"],
  [/donated|gift\b/i, "gift"],
];

/** Classify the transfer type of a provenance segment using keyword priority. */
export function classifyTransfer(text: string): TransferType {
  for (const [pattern, type] of TRANSFER_RULES) {
    if (pattern.test(text)) return type;
  }
  return "unknown";
}

// ─── 5. parseDate ──────────────────────────────────────────────────

// Months for date matching
const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December";

/**
 * Extract the most prominent date from a provenance segment.
 * Priority: exact date > qualified year > approximate year > bare year.
 */
export function parseDate(text: string): ProvenanceDate | null {
  // Exact date: "16 May 1696" or "8 July 1992"
  const exactMatch = text.match(
    new RegExp(`(\\d{1,2})\\s+(${MONTHS})\\s+(\\d{4})`)
  );
  if (exactMatch) {
    return {
      text: exactMatch[0],
      year: parseInt(exactMatch[3], 10),
      approximate: false,
      qualifier: null,
    };
  }

  // Month + year without day: "November 1923", "June 1948", "December 1992"
  const monthYearMatch = text.match(
    new RegExp(`(${MONTHS})\\s+(\\d{4})`)
  );

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
    const pos = text.indexOf(bareMatch[0]);
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

/**
 * Extract price/currency from a provenance segment.
 * Handles: fl. N, £ N, N Napoléons.
 */
export function parsePrice(text: string): ProvenancePrice | null {
  // Dutch guilders: "fl. 175", "fl. 550,000"
  const flMatch = text.match(/fl\.\s*([\d,]+)/);
  if (flMatch) {
    return {
      text: flMatch[0],
      amount: parseFloat(flMatch[1].replace(/,/g, "")),
      currency: "guilders",
    };
  }

  // British pounds: "£ 4,180,000" or "£4,180,000"
  const poundMatch = text.match(/£\s*([\d,]+)/);
  if (poundMatch) {
    return {
      text: poundMatch[0],
      amount: parseFloat(poundMatch[1].replace(/,/g, "")),
      currency: "pounds",
    };
  }

  // Napoléons: "8,000 Napoléons"
  const napMatch = text.match(/([\d,]+)\s*Napol[eé]ons/i);
  if (napMatch) {
    return {
      text: napMatch[0],
      amount: parseFloat(napMatch[1].replace(/,/g, "")),
      currency: "napoléons",
    };
  }

  return null;
}

// ─── 7. parseParty ─────────────────────────────────────────────────

// Anaphoric role patterns: "his son", "her widower", "their son", etc.
const ANAPHORA_PATTERN =
  /^(?:\?\s*)?(his|her|their)\s+(son|daughter|widower|widow|husband|nephew)/i;

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

  // "Commissioned by <Name>"
  const commMatch = working.match(/^[Cc]ommissioned by\s+/);
  if (commMatch) {
    const afterKeyword = working.slice(commMatch[0].length);
    const nameAndDates = extractNameAndDates(afterKeyword);
    if (nameAndDates) {
      return { ...nameAndDates, uncertain, role: "patron" };
    }
  }

  // "from whom purchased by <Name>"
  const fromWhomMatch = working.match(
    /from whom(?:\s+purchased)?\s+by\s+(?:the\s+)?(?:dealer\s+)?/i
  );
  if (fromWhomMatch) {
    const afterKeyword = working.slice(fromWhomMatch.index! + fromWhomMatch[0].length);
    const nameAndDates = extractNameAndDates(afterKeyword);
    if (nameAndDates) {
      return { ...nameAndDates, uncertain, role: "buyer" };
    }
  }

  // "purchased by <Name>" (without "from whom")
  const purchasedByMatch = working.match(/purchased by\s+(?:the\s+)?(?:museum|dealer\s+)?/i);
  if (purchasedByMatch && !fromWhomMatch) {
    const afterKeyword = working.slice(purchasedByMatch.index! + purchasedByMatch[0].length);
    const nameAndDates = extractNameAndDates(afterKeyword);
    if (nameAndDates) {
      return { ...nameAndDates, uncertain, role: "buyer" };
    }
  }

  // "sale <Name>" or "sale [section <Name>]"
  const saleMatch = working.match(
    /^sale\s+(?:\[(?:section\s+)?)?/i
  );
  if (saleMatch) {
    const afterKeyword = working.slice(saleMatch[0].length);
    const nameAndDates = extractNameAndDates(afterKeyword);
    if (nameAndDates) {
      return { ...nameAndDates, uncertain, role: "seller" };
    }
  }

  // "collection <Name>"
  const collMatch = working.match(/^collection\s+/i);
  if (collMatch) {
    const afterKeyword = working.slice(collMatch[0].length);
    const nameAndDates = extractNameAndDates(afterKeyword);
    if (nameAndDates) {
      return { ...nameAndDates, uncertain, role: "collector" };
    }
  }

  // "estate inventory ..." — extract the person
  const estateMatch = working.match(
    /^estate inventory(?:\s+of(?:\s+(?:his|her|their))?)?,?\s*/i
  );
  if (estateMatch) {
    const afterKeyword = working.slice(estateMatch[0].length);
    const nameAndDates = extractNameAndDates(afterKeyword);
    if (nameAndDates) {
      return { ...nameAndDates, uncertain, role: "deceased" };
    }
  }

  // "to <Name>" buyer at end after price — look for ", to <Name>"
  const toBuyerMatch = working.match(/,\s+to\s+(?:the\s+)?(?:dealer[s]?\s+)?/i);
  if (toBuyerMatch) {
    const afterTo = working.slice(toBuyerMatch.index! + toBuyerMatch[0].length);
    const nameAndDates = extractNameAndDates(afterTo);
    if (nameAndDates) {
      return { ...nameAndDates, uncertain, role: "buyer" };
    }
  }

  // "war recuperation" — no person
  if (/^war recuperation/i.test(working)) return null;

  // "on loan" — no specific person to extract as primary
  if (/^on loan/i.test(working)) return null;

  // "transferred to" — no specific person
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
  const datesMatch = text.match(/^([^(]+?)\s*\((\d{4}[\/?]?\d{0,2}[-–]\d{0,4}\??|\?[-–]\?|\?[-–]\d{4}|\d{4}[-–]\??)\)/);
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

/**
 * Extract location from a provenance segment.
 * Location typically follows name+dates, separated by comma.
 */
export function parseLocation(text: string): string | null {
  // Known city names that appear in Rijksmuseum provenance
  const CITIES =
    /\b(Amsterdam|Delft|The Hague|London|Paris|Venice|Rotterdam|Brussels|Wassenaar|Montreux|Buckinghamshire|Hertfordshire|Northampton|Edinburgh|Linz|Soho Square)\b/;

  const match = text.match(CITIES);
  if (match) return match[1];
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

  // Detect uncertainty marker
  const uncertain = working.startsWith("?");

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
    transferType: classifyTransfer(working),
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
