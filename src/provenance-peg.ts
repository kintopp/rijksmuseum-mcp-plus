/**
 * Layer 1: PEG-based provenance parser with regex fallback.
 *
 * Faithful extraction — captures what's explicitly in the text without
 * interpretation. Per-segment: tries PEG grammar first, falls back to
 * the existing regex parseEvent() on PEG failure.
 */

import { parse as pegParse } from "./provenance-parser.generated.js";
import type { PegAstNode } from "./provenance-parser.generated.js";
import {
  extractCitations,
  splitEvents,
  stripHtml,
  parseEvent,
  type ProvenanceParty,
  type ProvenancePrice,
  type ProvenanceCitation,
  type TransferType,
} from "./provenance.js";

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
  /(?:see|zie|see under|zie onder|same provenance as|dezelfde herkomst als)\s+(?:the provenance of\s+)?(?:inv\.\s*(?:no\.?\s*)?|cat\.\s*(?:no\.?\s*)?)?([A-Z]{1,3}[-\s]?[A-Z]?[-\s]?\d[\d\w.-]*)/i;

function detectCrossReference(
  text: string
): { targetObjectNumber: string } | null {
  const match = text.match(CROSS_REF_PATTERN);
  if (match) return { targetObjectNumber: match[1].trim() };
  return null;
}

// ─── AST → RawProvenanceEvent ───────────────────────────────────────

const VALID_TRANSFER_TYPES = new Set<TransferType>([
  "sale", "inheritance", "bequest", "commission", "purchase",
  "confiscation", "recuperation", "loan", "transfer", "collection",
  "gift", "auction", "exchange", "deposit", "seizure", "restitution",
  "donation", "inventory", "unknown",
]);

function astToRawEvent(
  ast: PegAstNode,
  sequence: number,
  rawText: string,
  gap: boolean,
  citationMap: Map<string, string>
): RawProvenanceEvent {
  // Collect all parties from the AST
  const parties: ProvenanceParty[] = [];
  for (const p of ast.parties || []) {
    if (p.name) {
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

  // Validate transfer type
  const transferType: TransferType = VALID_TRANSFER_TYPES.has(ast.type as TransferType)
    ? (ast.type as TransferType)
    : "unknown";

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
        rawText: text,
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
      raw: text,
      stats: { total: 1, peg: 0, fallback: 0 },
    };
  }

  const { cleaned, citations } = extractCitations(text);
  const segments = splitEvents(cleaned);
  const stats = { total: segments.length, peg: 0, fallback: 0 };
  const events: RawProvenanceEvent[] = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const sequence = i + 1;

    // Prepare text for PEG: strip HTML, remove citation placeholders
    const rawText = stripHtml(segment.text);
    let working = rawText
      .replace(/__CIT_\d+__/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    // Try PEG parse
    let event: RawProvenanceEvent;
    try {
      const ast = pegParse(working);
      event = astToRawEvent(ast, sequence, rawText, segment.gap, citations);
      stats.peg++;
    } catch {
      // PEG failed — fall back to regex parser
      event = regexFallbackToRawEvent(segment, sequence, citations);
      stats.fallback++;
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
