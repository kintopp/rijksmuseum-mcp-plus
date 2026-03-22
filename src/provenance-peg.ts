/**
 * Layer 1: PEG-based provenance parser with regex fallback.
 *
 * Faithful extraction — captures what's explicitly in the text without
 * interpretation. Per-segment: tries PEG grammar first, falls back to
 * the existing regex parseEvent() on PEG failure.
 */

import { parse as pegParse } from "./provenance-parser.generated.js";
import type { PegAstNode } from "./provenance-parser.generated.js";
import placesJson from "./places.json" with { type: "json" };
import {
  extractCitations,
  splitEvents,
  stripHtml,
  parseEvent,
  classifyTransfer,
  type ProvenanceParty,
  type ProvenancePrice,
  type ProvenanceCitation,
  type TransferType,
} from "./provenance.js";

// Place names for location matching (loaded once from places.json, 2,302 entries)
const placesSet: Set<string> = new Set(placesJson as string[]);

// SYNC: keep in sync with UNSOLD_RE in provenance-grammar.peggy:44
const UNSOLD_RE = /\b(?:unsold|bought\s+in|withdrawn|invendu|ingetrokken)\b/i;

// ─── Types ──────────────────────────────────────────────────────────

export interface RawProvenanceEvent {
  sequence: number;
  rawText: string;
  gap: boolean;

  transferType: TransferType;
  uncertain: boolean;

  parties: ProvenanceParty[];

  dateExpression: string | null;
  dateYear: number | null;
  dateQualifier: string | null;

  location: string | null;
  price: ProvenancePrice | null;
  saleDetails: string | null;
  citations: ProvenanceCitation[];

  isCrossRef: boolean;
  crossRefTarget: string | null;

  parseMethod: "peg" | "regex_fallback" | "cross_ref";
}

export interface ParseProvenanceRawResult {
  events: RawProvenanceEvent[];
  isCrossRef: boolean;
  crossRefTarget: string | null;
  raw: string;
  stats: { total: number; peg: number; fallback: number };
}

// ─── Cross-reference detection ──────────────────────────────────────

const CROSS_REF_PATTERN =
  /(?:see|zie|see under|zie onder|same provenance as|dezelfde herkomst als)\s+(?:the\s+)?(?:provenance\s+)?(?:(?:of|for|fot|to)\s+)?(?:inv\.\s*(?:no\.?\s*)?|cat\.\s*(?:no\.?\s*)?)?([A-Z]{1,3}[-\s]?[A-Z]?[-\s]?\d[\d\w.-]*)/i;
const CROSS_REF_PATTERN_ALT =
  /(?:for|voor)\s+(?:the\s+)?provenance\s+(?:see|zie)\s+(?:inv\.\s*(?:no\.?\s*)?|cat\.\s*(?:no\.?\s*)?)?([A-Z]{1,3}[-\s]?[A-Z]?[-\s]?\d[\d\w.-]*)/i;
// Pendant cross-references: "For both the present painting and its pendant SK-A-XXXX, ..."
const CROSS_REF_PENDANT =
  /(?:for\s+both|together\s+with)\s+.*?(?:pendant|companion|counterpart)\s+(?:to\s+)?([A-Z]{1,3}[-\s]?[A-Z]?[-\s]?\d[\d\w.-]*)/i;

function detectCrossReference(
  text: string
): { targetObjectNumber: string } | null {
  const cleaned = text.replace(/^\*+\s*/, ""); // strip leading asterisks
  const match = cleaned.match(CROSS_REF_PATTERN) || cleaned.match(CROSS_REF_PATTERN_ALT) || cleaned.match(CROSS_REF_PENDANT);
  if (match) return { targetObjectNumber: match[1].trim().replace(/\.$/, "") };
  return null;
}

// ─── AST → RawProvenanceEvent ───────────────────────────────────────

const VALID_TRANSFER_TYPES = new Set<TransferType>([
  "sale", "inheritance", "by_descent", "widowhood", "bequest", "commission",
  "confiscation", "theft", "looting", "recuperation", "loan", "transfer",
  "collection", "gift", "exchange", "deposit", "restitution",
  "inventory", "unknown",
]);

function astToRawEvent(
  ast: PegAstNode,
  sequence: number,
  rawText: string,
  gap: boolean,
  citationMap: Map<string, string>
): RawProvenanceEvent {
  // Collect all parties from the AST
  // Suppress anaphoric placeholders that aren't real names ("where", "whom" as literal party names)
  const ANAPHORIC_PLACEHOLDERS = new Set(["where", "whom", "which", "whose"]);
  const parties: ProvenanceParty[] = [];
  for (const p of ast.parties || []) {
    if (p.name && !ANAPHORIC_PLACEHOLDERS.has(p.name.toLowerCase().trim())) {
      parties.push({
        name: p.name,
        dates: p.dates ?? null,
        uncertain: ast.uncertain,
        role: p.role ?? null,
      });
    }
  }
  // Extra parties from RestOfSegment (e.g., buyer in "to Name") — inherit event's uncertainty
  for (const p of ast.extraParties || []) {
    if (p.name) {
      parties.push({
        name: p.name,
        dates: p.dates ?? null,
        uncertain: ast.uncertain,
        role: p.role ?? null,
      });
    }
  }

  // Extract citations from rawText
  const citations: ProvenanceCitation[] = [];
  const citRefs = rawText.match(/__CIT_\d+__/g) || [];
  for (const ref of citRefs) {
    const citText = citationMap.get(ref);
    if (citText) citations.push({ text: stripHtml(citText) });
  }

  // Validate transfer type; reclassify "sale" → "unknown" when unsold/bought-in
  let transferType: TransferType = VALID_TRANSFER_TYPES.has(ast.type as TransferType)
    ? (ast.type as TransferType)
    : "unknown";
  if (transferType === "sale" && ast.unsold) {
    transferType = "unknown";
  }
  // Post-parse reclassification: tail keywords override initial classification.
  // "from whom, fl. 19,186, to the museum as a gift" → gift, not sale
  // "from whom, with 21 other drawings, on loan to the museum" → loan, not sale
  // "from where transferred, on long term loan" → loan, not transfer
  if ((transferType === "sale" || transferType === "transfer") && /\bon\s+(?:long[- ]term\s+)?loan\b/i.test(rawText)) {
    transferType = "loan";
  } else if (transferType === "sale" && /\bas\s+a\s+gift\b|\bdonated\b/i.test(rawText)) {
    transferType = "gift";
  }

  // Remap generic roles from parseRest (buyer/seller) to contextually correct roles.
  // parseRest() assigns "buyer" for "to [Name]" and "seller" for "from [Name]";
  // for non-sale event types the correct role depends on the transfer type (#147, #148, #150).
  if (transferType === "loan") {
    for (const p of parties) {
      if (p.role === "buyer") p.role = "borrower";
      else if (p.role === "seller") p.role = "lender";
    }
  } else {
    const BUYER_REMAP: Record<string, string> = {
      gift: "recipient", bequest: "heir",
      inheritance: "heir", by_descent: "heir", widowhood: "heir",
      transfer: "recipient", restitution: "recipient", deposit: "recipient",
    };
    const remappedRole = BUYER_REMAP[transferType];
    if (remappedRole) {
      for (const p of parties) {
        if (p.role === "buyer") p.role = remappedRole;
      }
    }
  }

  // Price
  let price: ProvenancePrice | null = null;
  if (ast.price) {
    price = {
      text: `${ast.price.currency === "guilders" ? "fl." : ast.price.currency === "pounds" ? "£" : ast.price.currency} ${ast.price.amount.toLocaleString("en-US")}`,
      amount: ast.price.amount,
      currency: ast.price.currency,
    };
  }

  // Restore citations in rawText for display
  const restoredRawText = rawText.replace(/__CIT_\d+__/g, (key) => {
    const val = citationMap.get(key);
    return val != null ? `{${stripHtml(val)}}` : key;
  });

  return {
    sequence,
    rawText: restoredRawText,
    gap,
    transferType,
    uncertain: ast.uncertain,
    parties,
    dateExpression: ast.dateExpression ?? null,
    dateYear: ast.dateYear ?? null,
    dateQualifier: ast.dateQualifier ?? null,
    location: ast.location ?? null,
    price,
    saleDetails: ast.saleDetails ?? null,
    citations,
    isCrossRef: false,
    crossRefTarget: null,
    parseMethod: "peg",
  };
}

// ─── Regex fallback → RawProvenanceEvent adapter ────────────────────

function regexFallbackToRawEvent(
  segment: { text: string; gap: boolean },
  sequence: number,
  citationMap: Map<string, string>
): RawProvenanceEvent {
  const event = parseEvent(segment, sequence, citationMap);
  return {
    sequence: event.sequence,
    rawText: event.rawText,
    gap: event.gap,
    transferType: event.transferType,
    uncertain: event.uncertain,
    parties: event.party ? [event.party] : [],
    dateExpression: event.date?.text ?? null,
    dateYear: event.date?.year ?? null,
    dateQualifier: event.date?.qualifier ?? null,
    location: event.location,
    price: event.price,
    saleDetails: event.saleDetails,
    citations: event.citations,
    isCrossRef: false,
    crossRefTarget: null,
    parseMethod: "regex_fallback",
  };
}

// ─── Entry point ────────────────────────────────────────────────────

export function parseProvenanceRaw(
  text: string | null | undefined
): ParseProvenanceRawResult {
  const empty: ParseProvenanceRawResult = {
    events: [],
    isCrossRef: false,
    crossRefTarget: null,
    raw: text ?? "",
    stats: { total: 0, peg: 0, fallback: 0 },
  };
  if (!text || !text.trim()) return empty;

  // Check for cross-reference
  const crossRef = detectCrossReference(text);
  if (crossRef) {
    return {
      events: [{
        sequence: 1,
        rawText: stripHtml(text),
        gap: false,
        transferType: "unknown",
        uncertain: false,
        parties: [],
        dateExpression: null,
        dateYear: null,
        dateQualifier: null,
        location: null,
        price: null,
        saleDetails: null,
        citations: [],
        isCrossRef: true,
        crossRefTarget: crossRef.targetObjectNumber,
        parseMethod: "cross_ref",
      }],
      isCrossRef: true,
      crossRefTarget: crossRef.targetObjectNumber,
      raw: stripHtml(text),
      stats: { total: 1, peg: 0, fallback: 0 },
    };
  }

  const { cleaned, citations } = extractCitations(text);
  // Strip HTML BEFORE splitting on semicolons — CSS properties in HTML tags
  // contain semicolons (e.g. "font-size:medium;font-family:Aptos") that would
  // create false event boundaries. Only 68 artworks have HTML-wrapped provenance,
  // but they produce dozens of spurious segments each.
  const htmlStripped = stripHtml(cleaned);
  const segments = splitEvents(htmlStripped);
  const stats = { total: segments.length, peg: 0, fallback: 0 };
  const events: RawProvenanceEvent[] = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const sequence = i + 1;

    // Text is already HTML-stripped; just use segment text directly
    const rawText = segment.text;
    let working = rawText
      .replace(/__CIT_\d+__/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    // Try PEG parse
    let event: RawProvenanceEvent;
    let ast: PegAstNode | null = null;
    try {
      ast = pegParse(working, { places: placesSet } as any);
      event = astToRawEvent(ast, sequence, rawText, segment.gap, citations);
      stats.peg++;
    } catch {
      // PEG failed — fall back to regex parser
      event = regexFallbackToRawEvent(segment, sequence, citations);
      stats.fallback++;
    }

    // PEG catch-all → "unknown": try regex classifier (matches mid-sentence keywords)
    // Skip reclassification for unsold lots — they were intentionally set to "unknown"
    if (event.transferType === "unknown" && !event.isCrossRef && !event.gap && !ast?.unsold && !UNSOLD_RE.test(working)) {
      const reclassified = classifyTransfer(working);
      if (reclassified !== "unknown") {
        event.transferType = reclassified;
      }
    }

    // Structural signal reclassification: if STILL unknown after regex classifier,
    // check for deterministic structural signals that indicate "collection".
    // This runs last so it doesn't override keyword-based reclassification (gift, deposit, etc.)
    if (event.transferType === "unknown" && !event.isCrossRef && !ast?.unsold && !UNSOLD_RE.test(working)) {
      if (
        /\(L\.\s*\d+\)/.test(working) ||                                  // Lugt collector mark
        /\(\d{4}[-–]\d{2,4}\??\)/.test(working) ||                        // Life dates (YYYY-YYYY)
        /\b(?:Baron|Jonkheer|Jonkvrouw|Count|Countess|Graaf|Gravin|Lord|Prince|Princess|Duke|Duchess|Marquis|Marchesa|Conte|Comtesse|Vicomte|Sir|Lady|Freiherr|Freifrau|Herzog)\b/.test(working) || // Noble title
        /\b(?:Dr|Prof)\b\.?\s/.test(working) ||                            // Academic title
        /\b(?:Kunsthandel|Galerie|Gallery|Galleria)\b/i.test(working) ||   // Dealer indicator
        /\b(?:Rijksmuseum|Mauritshuis|Hermitage|Louvre|Uffizi|Prado|National Gallery|British Museum|Metropolitan Museum|Albertina|Alte Pinakothek|Gemäldegalerie)\b/.test(working) || // Major museums
        /\b(?:[Mm]useum|[Mm]usée|[Kk]erk|[Cc]hurch|[Cc]hapel|[Kk]apel|[Cc]athedral|[Mm]onastery|[Kk]looster|[Mm]inisterie|[Mm]inistry|[Kk]abinet|[Cc]abinet|[Pp]aleis|[Pp]alace|[Ss]tichting|[Ff]oundation|[Gg]enootschap|[Vv]ereniging|[Ss]tadhuis|[Tt]own [Hh]all|[Rr]aadhuis|[Gg]asthuis|[Hh]ofje|[Ww]eeshuis|[Hh]ospital|[Gg]ewölbe|[Gg]ewolbe|[Ss]chloss|[Kk]unstkammer|[Kk]unstkabinett|[Ss]ammlung|[Gg]alería|[Pp]inacoteca|[Aa]ccademia|[Aa]bbey|[Aa]bdij|[Cc]onvent|[Rr]esidenz|[Ww]erf|[Ii]nstituut|[Ii]nstitute|[Dd]epartement|[Aa]dmiraliteit|[Dd]ockyard|[Cc]ompagnie|[Cc]ompany|[Cc]astle)\b/.test(working) || // Institution type keywords (NL/EN/DE/FR/IT)
        /'\s*s\s+(?:Lands|Rijks)\b/.test(working) || // Dutch "'s Lands" / "'s Rijks" institutional prefix
        /\bart\s+market\b/i.test(working) || // Art market reference
        /\bVOC\b/.test(working) || // Dutch East India Company
        /kerk\b|huis\b.*(?:Amsterdam|Delft|Haarlem|Utrecht|Leiden|Rotterdam)/i.test(working) || // Dutch compound church/house names
        /\b(?:private|unknown|unidentified)\s+(?:collector|dealer)\b/i.test(working) || // Generic collector/dealer
        /\b(?:Palazzo|Kunstgewerbe|Landes)\b/.test(working) // Italian/German institution prefixes
      ) {
        event.transferType = "collection";
      }
    }

    // Post-parse date fallback (#124): if no date was extracted, scan raw text
    // for a bare year not inside parentheses (life dates) or citations
    if (!event.dateYear && !event.isCrossRef) {
      const stripped = working.replace(/\([^)]*\)/g, "").replace(/__CIT_\d+__/g, "");
      const yearMatch = stripped.match(/\b(1[0-9]{3}|20[0-2]\d)\b/);
      if (yearMatch) {
        event.dateYear = parseInt(yearMatch[1], 10);
        event.dateExpression = yearMatch[1];
      }
    }

    events.push(event);
  }

  return {
    events,
    isCrossRef: false,
    crossRefTarget: null,
    raw: text,
    stats,
  };
}
