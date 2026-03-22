/**
 * Automated provenance parser audit via Anthropic Message Batches API.
 *
 * Three audit modes:
 *   silent-errors       Sample clean parses, find what the parser silently missed
 *   pattern-mining      Sample unknowns, find recurring grammar-fixable patterns
 *   semantic-catalogue  Sample hard cases, classify what KIND of reasoning is needed
 *
 * Usage:
 *   node scripts/audit-provenance-batch.mjs --mode <mode> [options]
 *
 * Options:
 *   --mode MODE          Required. One of: silent-errors, pattern-mining, semantic-catalogue
 *   --sample-size N      Records to sample (default: 200)
 *   --db PATH            Vocab DB path (default: data/vocabulary.db)
 *   --output PATH        JSON output (default: data/audit-<mode>-<YYYY-MM-DD>.json)
 *   --model MODEL        Anthropic model (default: claude-sonnet-4-20250514)
 *   --resume BATCH_ID    Poll existing batch instead of creating new one
 *   --dry-run            Build prompts, write to output, don't submit
 *   --stratify           Mode 1 only: stratify by parse_method + century
 *   --verbose            Print each prompt as built
 *
 * Env:
 *   ANTHROPIC_API_KEY    Required for non-dry-run execution
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";

// ─── Modes ──────────────────────────────────────────────────────────

const MODES = ["silent-errors", "pattern-mining", "semantic-catalogue", "position-enrichment"];

// ─── CLI args ───────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flag(name) { return args.includes(name); }
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

const mode = opt("--mode", null);
const sampleSize = parseInt(opt("--sample-size", "200"), 10);
const dbPath = opt("--db", "data/vocabulary.db");
const model = opt("--model", "claude-sonnet-4-20250514");
const resumeBatchId = opt("--resume", null);
const dryRun = flag("--dry-run");
const stratify = flag("--stratify");
const eraFilter = opt("--era", null); // e.g. "pre1800" — limits sampling to artworks with earliest event before this year
const thinkingBudget = parseInt(opt("--thinking", "0"), 10); // extended thinking token budget (0 = disabled)
const recordsList = opt("--records", null); // comma-separated object numbers for targeted runs
const verbose = flag("--verbose");

const today = new Date().toISOString().slice(0, 10);
const outputPath = opt("--output", `data/audit-${mode}-${today}.json`);

if (!mode || !MODES.includes(mode)) {
  console.error(`Usage: node scripts/audit-provenance-batch.mjs --mode <${MODES.join("|")}> [options]`);
  console.error(`\nOptions:`);
  console.error(`  --sample-size N      Records to sample (default: 200)`);
  console.error(`  --db PATH            Vocab DB path (default: data/vocabulary.db)`);
  console.error(`  --output PATH        JSON output file`);
  console.error(`  --model MODEL        Anthropic model (default: claude-sonnet-4-20250514)`);
  console.error(`  --resume BATCH_ID    Resume polling an existing batch`);
  console.error(`  --dry-run            Build prompts only, don't submit`);
  console.error(`  --stratify           Mode 1: stratify by parse_method + century`);
  console.error(`  --verbose            Print each prompt as built`);
  process.exit(1);
}

console.log(`Provenance audit — ${mode}`);
console.log(`  DB:          ${dbPath}`);
console.log(`  Sample size: ${sampleSize}`);
console.log(`  Model:       ${model}`);
console.log(`  Output:      ${outputPath}`);
console.log(`  Dry run:     ${dryRun}`);
if (stratify) console.log(`  Stratify:    yes`);
if (eraFilter) console.log(`  Era filter:  ${eraFilter}`);
if (thinkingBudget) console.log(`  Thinking:    ${thinkingBudget} tokens`);
if (recordsList) console.log(`  Records:     ${recordsList}`);
if (resumeBatchId) console.log(`  Resume:      ${resumeBatchId}`);
console.log();

// ─── DB (deferred — not opened for --resume) ───────────────────────

let db = null;
function openDb() {
  if (!db) db = new Database(dbPath, { readonly: true });
  return db;
}

// ─── Sampling ───────────────────────────────────────────────────────

function sampleSilentErrors() {
  const db = openDb();
  let artworkIds;
  if (stratify) {
    // Weighted stratification: oversample early eras and complex chains.
    // Era weights: pre1600 ×4, 1600-1800 ×3, 1800-1900 ×1.5, post1900 ×1, no_date ×1
    // Complexity weights: 5+ events ×3, 3-4 ×2, 1-2 ×1
    // Combined weight determines per-bin sample quota (proportional to weight × bin_size,
    // capped at bin size). This ensures early/complex records are overrepresented while
    // still including some modern/simple records for coverage.
    const ERA_WEIGHT = { pre1600: 4, "1600-1800": 3, "1800-1900": 1.5, post1900: 1, no_date: 1 };
    const COMPLEXITY_WEIGHT = { "5+": 3, "3-4": 2, "1-2": 1 };

    const bins = db.prepare(`
      WITH per_artwork AS (
        SELECT artwork_id,
          MIN(date_year) AS earliest_year,
          COUNT(*) AS event_count
        FROM provenance_events
        WHERE parse_method IN ('peg','regex_fallback')
          AND transfer_type != 'unknown' AND is_cross_ref = 0
        GROUP BY artwork_id
      )
      SELECT artwork_id,
        CASE WHEN earliest_year < 1600 THEN 'pre1600'
             WHEN earliest_year < 1800 THEN '1600-1800'
             WHEN earliest_year < 1900 THEN '1800-1900'
             WHEN earliest_year IS NOT NULL THEN 'post1900'
             ELSE 'no_date' END AS era,
        CASE WHEN event_count >= 5 THEN '5+'
             WHEN event_count >= 3 THEN '3-4'
             ELSE '1-2' END AS complexity
      FROM per_artwork
    `).all();

    // Group by bin, compute weighted quotas
    const binMap = new Map();
    for (const row of bins) {
      const key = `${row.era}::${row.complexity}`;
      if (!binMap.has(key)) binMap.set(key, { era: row.era, complexity: row.complexity, ids: [] });
      binMap.get(key).ids.push(row.artwork_id);
    }

    let totalWeight = 0;
    for (const bin of binMap.values()) {
      bin.weight = (ERA_WEIGHT[bin.era] || 1) * (COMPLEXITY_WEIGHT[bin.complexity] || 1);
      totalWeight += bin.weight * bin.ids.length;
    }

    // Assign quotas proportional to weight, then shuffle and take
    artworkIds = [];
    for (const bin of binMap.values()) {
      const quota = Math.min(
        bin.ids.length,
        Math.max(1, Math.round(sampleSize * bin.weight * bin.ids.length / totalWeight)),
      );
      // Fisher-Yates shuffle
      for (let i = bin.ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bin.ids[i], bin.ids[j]] = [bin.ids[j], bin.ids[i]];
      }
      artworkIds.push(...bin.ids.slice(0, quota));
    }

    // If we overshot, trim randomly; if undershot (rounding), that's fine
    if (artworkIds.length > sampleSize) {
      for (let i = artworkIds.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [artworkIds[i], artworkIds[j]] = [artworkIds[j], artworkIds[i]];
      }
      artworkIds = artworkIds.slice(0, sampleSize);
    }

    // Log bin quotas for transparency
    console.log(`  Stratified sampling (weighted by era × complexity):`);
    for (const [key, bin] of [...binMap.entries()].sort()) {
      const taken = artworkIds.filter(id => bin.ids.includes(id)).length;
      if (taken > 0) console.log(`    ${key}: ${taken}/${bin.ids.length} (weight ${bin.weight})`);
    }
  } else {
    // Bias toward complex records (3+ events) — where parsing errors cluster
    // Optional era filter: "pre1800" → only artworks with earliest event date < 1800
    const eraYear = eraFilter ? parseInt(eraFilter.replace(/\D/g, ""), 10) : null;
    const eraClause = eraYear
      ? `AND e.artwork_id IN (SELECT artwork_id FROM provenance_events WHERE date_year IS NOT NULL GROUP BY artwork_id HAVING MIN(date_year) < ${eraYear})`
      : "";
    artworkIds = db.prepare(`
      SELECT artwork_id FROM (
        SELECT e.artwork_id, COUNT(*) AS event_count
        FROM provenance_events e
        WHERE e.parse_method IN ('peg','regex_fallback')
          AND e.transfer_type != 'unknown' AND e.is_cross_ref = 0
          ${eraClause}
        GROUP BY e.artwork_id
        HAVING event_count >= 3
      ) ORDER BY RANDOM() LIMIT ?
    `).all(sampleSize).map(r => r.artwork_id);
  }
  return fetchRecords(artworkIds, { periods: true });
}

function samplePositionEnrichment() {
  const db = openDb();
  let artworkIds;

  if (recordsList) {
    // Targeted: specific object numbers
    const objectNumbers = recordsList.split(",").map(s => s.trim());
    artworkIds = db.prepare(
      `SELECT art_id FROM artworks WHERE object_number IN (${objectNumbers.map(() => "?").join(",")})`
    ).all(...objectNumbers).map(r => r.art_id);
  } else {
    // Sample artworks that have null-position parties or ambiguous transfer_category
    artworkIds = db.prepare(`
      SELECT DISTINCT artwork_id FROM (
        SELECT pp.artwork_id FROM provenance_parties pp
        WHERE pp.party_position IS NULL AND pp.position_method IS NULL
        UNION
        SELECT pe.artwork_id FROM provenance_events pe
        WHERE pe.transfer_category = 'ambiguous' AND pe.is_cross_ref = 0
      ) ORDER BY RANDOM() LIMIT ?
    `).all(sampleSize).map(r => r.artwork_id);
  }
  return fetchRecords(artworkIds, { periods: false });
}

function sampleUnknowns() {
  const db = openDb();
  // Deduplicate: pick one artwork per unique structural pattern.
  // Strip {citations} before comparing so "text {A}" and "text {B}" count as the same.
  // Done in JS because SQLite can't regex-replace multiple citation blocks.
  const allUnknowns = db.prepare(`
    SELECT artwork_id, raw_text FROM provenance_events
    WHERE transfer_type = 'unknown' AND is_cross_ref = 0 AND raw_text != ''
  `).all();
  const seen = new Set();
  const candidates = [];
  for (const row of allUnknowns) {
    const key = row.raw_text.replace(/\{[^}]*\}/g, "").trim().slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(row.artwork_id);
  }
  // Shuffle and take sampleSize
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const artworkIds = [...new Set(candidates.slice(0, sampleSize))];
  return fetchRecords(artworkIds, { periods: false });
}

function fetchRecords(artworkIds, { periods }) {
  if (artworkIds.length === 0) return [];
  const db = openDb();

  const stmtArtwork = db.prepare(
    `SELECT art_id, object_number, provenance_text FROM artworks WHERE art_id = ?`
  );
  const stmtEvents = db.prepare(
    `SELECT * FROM provenance_events WHERE artwork_id = ? ORDER BY sequence`
  );
  // parties are stored as JSON on provenance_events.parties — no need to query provenance_parties

  let stmtPeriods = null;
  if (periods) {
    try {
      stmtPeriods = db.prepare(
        `SELECT * FROM provenance_periods WHERE artwork_id = ? ORDER BY sequence`
      );
    } catch { /* table may not exist */ }
  }

  const records = [];
  for (const artId of artworkIds) {
    const artwork = stmtArtwork.get(artId);
    if (!artwork || !artwork.provenance_text) continue;

    const events = stmtEvents.all(artId);
    const periodRows = stmtPeriods ? stmtPeriods.all(artId) : [];

    records.push({
      artworkId: artId,
      objectNumber: artwork.object_number,
      provenanceText: artwork.provenance_text,
      events,
      periods: periodRows,
    });
  }
  return records;
}

// ─── Tool schemas (for structured output) ───────────────────────────

const TOOL_SILENT_ERRORS = {
  name: "report_audit_findings",
  description: "Report audit findings comparing parser output against raw provenance text",
  input_schema: {
    type: "object",
    properties: {
      artwork_id: { type: "integer" },
      object_number: { type: "string" },
      total_events_checked: { type: "integer" },
      errors: {
        type: "array",
        items: {
          type: "object",
          properties: {
            event_sequence: { type: "integer", description: "Sequence number of the event with the error" },
            error_type: {
              type: "string",
              enum: ["field_error", "phantom_event", "missing_event", "merge_error"],
            },
            field: {
              type: "string",
              enum: ["transfer_type", "transfer_category", "parties", "party_position",
                     "date_year", "date_qualifier",
                     "location", "price_amount", "price_currency", "sale_details", "n/a"],
            },
            raw_text_quote: { type: "string", description: "Relevant quote from raw provenance text" },
            parser_value: { type: "string", description: "What the parser produced" },
            correct_value: { type: "string", description: "What it should be" },
            severity: { type: "string", enum: ["high", "medium", "low"] },
            notes: { type: "string" },
          },
          required: ["event_sequence", "error_type", "field", "raw_text_quote",
                     "parser_value", "correct_value", "severity"],
        },
      },
      summary: { type: "string", description: "One-line summary of this record's quality" },
    },
    required: ["artwork_id", "object_number", "total_events_checked", "errors", "summary"],
  },
};

// Base 19 types mirror TransferType in src/provenance.ts (type-only, not importable at runtime).
// Last 3 are audit-specific categories for segments the parser can't handle.
const TRANSFER_TYPES = [
  "sale", "inheritance", "bequest", "commission", "purchase",
  "confiscation", "recuperation", "loan", "transfer", "collection",
  "gift", "auction", "exchange", "deposit", "seizure", "restitution",
  "donation", "inventory", "unknown",
  "bare_name_no_verb", "fragment_artefact", "non_provenance",
];

const TOOL_PATTERN_MINING = {
  name: "report_pattern_findings",
  description: "Report pattern analysis for unknown provenance segments",
  input_schema: {
    type: "object",
    properties: {
      artwork_id: { type: "integer" },
      object_number: { type: "string" },
      segments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            event_sequence: { type: "integer" },
            raw_text: { type: "string", description: "The raw text of the unknown event" },
            inferred_transfer_type: {
              type: "string",
              enum: TRANSFER_TYPES,
            },
            leading_keyword: {
              type: "string",
              description: "The keyword/phrase that signals this type, or empty string if bare name",
            },
            grammar_fixable: { type: "boolean" },
            rule_sketch: {
              type: "string",
              description: "If grammar-fixable: 'if contains X, classify as Y'. Empty otherwise.",
            },
            reasoning: { type: "string", description: "Why this classification" },
          },
          required: ["event_sequence", "raw_text", "inferred_transfer_type",
                     "leading_keyword", "grammar_fixable"],
        },
      },
    },
    required: ["artwork_id", "object_number", "segments"],
  },
};

const REASONING_TYPES = [
  "pattern_matching", "world_knowledge", "contextual_inference",
  "disambiguation", "multi_event_linking",
];

const TOOL_SEMANTIC_CATALOGUE = {
  name: "report_semantic_findings",
  description: "Report from-scratch provenance parsing with reasoning type classification",
  input_schema: {
    type: "object",
    properties: {
      artwork_id: { type: "integer" },
      object_number: { type: "string" },
      overall_difficulty: {
        type: "string",
        enum: ["trivial", "moderate", "complex", "expert"],
      },
      parsed_events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sequence: { type: "integer" },
            raw_text_segment: { type: "string" },
            owner_name: { type: "string" },
            transfer_type: { type: "string" },
            date_year: { type: ["integer", "null"] },
            location: { type: ["string", "null"] },
            price: { type: ["string", "null"] },
            reasoning_type: { type: "string", enum: REASONING_TYPES },
            reasoning_explanation: { type: "string" },
          },
          required: ["sequence", "raw_text_segment", "owner_name", "transfer_type",
                     "reasoning_type", "reasoning_explanation"],
        },
      },
    },
    required: ["artwork_id", "object_number", "parsed_events", "overall_difficulty"],
  },
};

const TOOL_POSITION_ENRICHMENT = {
  name: "report_position_enrichment",
  description: "Report inferred party positions and transfer categories for ambiguous provenance events",
  input_schema: {
    type: "object",
    properties: {
      artwork_id: { type: "integer" },
      object_number: { type: "string" },
      enrichments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            event_sequence: { type: "integer" },
            party_updates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  party_idx: { type: "integer", description: "0-indexed position in the parties array" },
                  party_name: { type: "string" },
                  position: { type: "string", enum: ["sender", "receiver", "agent"] },
                  confidence: { type: "number", description: "0.0-1.0 confidence in this classification" },
                  reasoning: { type: "string", description: "Brief explanation" },
                },
                required: ["party_idx", "party_name", "position", "confidence", "reasoning"],
              },
            },
            category_update: {
              type: "object",
              properties: {
                category: { type: "string", enum: ["ownership", "custody"] },
                confidence: { type: "number" },
                reasoning: { type: "string" },
              },
              required: ["category", "confidence", "reasoning"],
            },
          },
          required: ["event_sequence"],
        },
      },
      summary: { type: "string" },
    },
    required: ["artwork_id", "object_number", "enrichments", "summary"],
  },
};

// ─── Prompt builders ────────────────────────────────────────────────

function buildPromptSilentErrors(record) {
  // Build a clean representation of parser output
  const eventsJson = record.events.map(e => ({
    sequence: e.sequence,
    rawText: e.raw_text,
    transferType: e.transfer_type,
    transferCategory: e.transfer_category ?? null,
    uncertain: !!e.uncertain,
    parties: safeJson(e.parties),
    dateExpression: e.date_expression,
    dateYear: e.date_year,
    dateQualifier: e.date_qualifier,
    location: e.location,
    priceAmount: e.price_amount,
    priceCurrency: e.price_currency,
    saleDetails: e.sale_details,
    isCrossRef: !!e.is_cross_ref,
    crossRefTarget: e.cross_ref_target,
    parseMethod: e.parse_method,
  }));

  return `You are auditing a provenance parser's structured output against raw museum provenance text.

## Artwork
Object number: ${record.objectNumber} (artwork_id: ${record.artworkId})

## Raw provenance text (from museum database)
${record.provenanceText}

## Parser's structured output
${JSON.stringify(eventsJson, null, 2)}

## Your task
Compare the parser output against the raw text, event by event. For each event, check:
1. **transfer_type** — Does the keyword in raw text match the classified type?
2. **transfer_category** — Is the category correct? "ownership" for sales/gifts/inheritance, "custody" for loans/deposits, "ambiguous" for unclear cases. Report if a loan is tagged "ownership" or a sale is tagged "custody".
3. **parties** — Are all names captured? Are roles correct? Any name truncation or fragmentation?
4. **party_position** — Each party has a "position" field (sender/receiver/agent/null). Check:
   - In sale events: seller should be "sender", buyer should be "receiver", auctioneer/dealer should be "agent"
   - In gift events: donor should be "sender", recipient should be "receiver"
   - In inheritance/bequest events: heir should be "receiver", deceased should be "sender"
   - In loan events: lender should be "sender", borrower should be "receiver"
   - Are there parties with position=null that should have a position based on context?
   - Are there parties with the WRONG position? (e.g., a buyer tagged as "sender")
5. **date_year / date_qualifier** — Does it match the date in raw text? Not confused with a price, catalogue number, or publication year?
6. **location** — Correctly extracted, not a party name fragment?
7. **price_amount / price_currency** — Amount and currency correct? Not concatenated with a year?
8. **missing events** — Any ownership transfers in raw text with no corresponding parsed event?
9. **phantom events** — Any parsed events that don't correspond to real provenance transfers?
10. **merge/split errors** — Two events merged into one, or one event split into two?

## DO NOT report as errors — design choices and known limitations

**Deliberate design choices (these are CORRECT, not errors):**
- Unsold/bought-in auction events classified as "unknown" — deliberate reclassification. "bought in", "unsold", "withdrawn" events are NOT sales. Do not report unknown→sale for these.
- Events correctly classified as "unknown" for genuinely ambiguous bare names (e.g. "Mathias Komor (Beijing)")
- Cross-references (isCrossRef: true) classified as "unknown" — correct by design
- "estate inventory" events classified as "inventory" (not "collection") — deliberate separation
- Events reclassified from sale→gift when text contains "as a gift" or "donated" — correct
- Events reclassified from sale/transfer→loan when text contains "on loan" — correct
- "from the artist, transferred to [institution]" classified as "transfer" not "sale" — correct
- Date qualifier "by [year]" mapped to "before" — "by 1800" means "no later than 1800"
- Attribution dates suppressed: "as German school, c. 1500" does NOT produce a date — the date describes the attribution, not a provenance event. Do not report missing dates for attribution phrases.
- Standalone "Inv." segments (bare inventory numbers) are skipped — they are not provenance events. Do not report these as missing events.
- Parties with position=null when their role is also null (bare-name unknowns) — expected
- Parties with position="receiver" and role=null in collection/recuperation/restitution/commission/inventory events — this is a deliberate context-based inference, not an error
- Anaphoric references "where"/"whom" suppressed as party names (party set to null) — correct
- Credit-line enriched events (parseMethod="credit_line") may have transfer types inferred from the artwork's credit line field rather than the provenance text — this is correct

**Known limitations (do not report — already tracked):**
- "to [Name]" in loan events tagged as role "buyer" instead of "borrower" — known (#147)
- "to [Name]" in gift events tagged as role "buyer" instead of "recipient" — known (#148)
- Multi-city locations truncated to first city ("Amsterdam and Paris" → "Amsterdam") — known (#149)
- Loan "from X to Y" parties lost when comma separates keyword — known (#150)
- "his heirs" bare phrase without proper name not captured as party — known (#151)
- "by or for" prefix leaking into party name in commissions — known (#152)
- Unrecognized currencies: gns (guineas), Bfr. (Belgian francs), DM, ¥, Ffrs, mark — known (#153)
- fl. 2,000.00 parsed as 2 (European decimal suffix) — known (#154)
- Pre-decimal guilder notation fl. 1:10:- parsed as 1 — known (#95)
- Fractional prices (½, ¼) not parsed — known (#89)
- Pre-decimal British pounds (£0.13.0) — known (#92)
- Relational phrases kept as names (e.g. "his eldest son") — known (#85)
- Minor whitespace or formatting differences in names

Report ONLY genuine errors where the parser produced a wrong value or missed a real transfer, AND the error is not covered by the known limitations above.

Use the report_audit_findings tool to submit your findings.`;
}

function buildPromptPatternMining(record) {
  const unknownEvents = record.events.filter(
    e => e.transfer_type === "unknown" && !e.is_cross_ref
  );

  return `<role>You are a provenance researcher and computational linguist analysing unparsed provenance text segments from a Rijksmuseum artwork. A PEG grammar parser classified these segments as "unknown" because they did not match any of its ~20 keyword-based event rules (e.g., "sold by" → sale, "by descent" → inheritance, "collection of" → collection). Your job is to determine what each segment describes and whether a new grammar rule could handle it.</role>

<background>
<aam_standard>
The raw provenance text follows the AAM (American Alliance of Museums, 2001) punctuation convention:
- Semicolons (;) separate events where direct succession is known or assumed
- Ellipsis (…) or period (.) marks a gap — no direct transfer known
- Question mark (?) prefix marks uncertain/conjectural attribution
- Curly braces ({…}) enclose inline bibliographic citations — these are NOT provenance data
- Parenthesised years ((YYYY-YYYY)) are life dates of the owner
- Events are in chronological order: earliest known owner → present

CRITICAL: In AAM notation, a bare name with optional location and dates — e.g., "Frits Lugt (1884-1970), Paris" — is a VALID provenance entry meaning "held by this person". There is no transfer verb because the AAM convention implies it. These bare-name segments are the MOST COMMON type of unknown and they are NOT grammar-fixable.
</aam_standard>

<plod_framework>
We are structuring this data toward the PLOD (Provenance Linked Open Data) model:
- Each provenance event is a directed transfer: Sender → Receiver (with optional Agent)
- Transfers are either ownership changes (permanent: sale, gift, inheritance) or custody changes (temporary: loan, deposit)
- Resolving "unknown" transfer types enables proper sender/receiver classification downstream
</plod_framework>

<grammar_fixable_definition>
A pattern is "grammar-fixable" if and only if:
1. There is a specific keyword or phrase that RELIABLY signals the transfer type
2. The keyword appears in a consistent position (typically at the start of the segment or after a citation)
3. The rule would work correctly across ALL artworks — not just this one
4. No world knowledge, contextual reasoning, or disambiguation is needed

If you need to know WHO a person is (dealer vs collector), WHERE an institution is, or what happened BEFORE this event to classify it — it is NOT grammar-fixable.
</grammar_fixable_definition>
</background>

<examples>
<example>
<segment>"anonymous sale, Amsterdam (R.W.P. de Vries), 9 December 1930 sqq., no. 304, as N. Maes"</segment>
<analysis>
- inferred_transfer_type: sale
- leading_keyword: "anonymous sale"
- grammar_fixable: true
- rule_sketch: "if text starts with 'anonymous sale' → sale"
- reasoning: "anonymous sale" is an unambiguous keyword that always means a sale at auction. The parser already handles "sale" but misses the "anonymous sale" variant.
</analysis>
</example>

<example>
<segment>"Jonkheer Pieter Hendrik Six (1827-1905), Lord of Vromade, Amsterdam"</segment>
<analysis>
- inferred_transfer_type: bare_name_no_verb
- leading_keyword: ""
- grammar_fixable: false
- rule_sketch: ""
- reasoning: This is a bare name following AAM convention — a person with life dates and location, implying they held the artwork. No keyword to match. Classifying this as "collection" would require recognising that any bare name implies ownership, which is semantic, not syntactic.
</analysis>
</example>

<example>
<segment>"found during the dredging of the Waal River near Tiel, 1867"</segment>
<analysis>
- inferred_transfer_type: collection
- leading_keyword: "found"
- grammar_fixable: true
- rule_sketch: "if text starts with 'found' → collection"
- reasoning: "found" reliably indicates archaeological discovery or accidental find — the first known acquisition of the object. This is a consistent keyword pattern.
</analysis>
</example>

<example>
<segment>"Galerie Fritz Gerstel, Berlin"</segment>
<analysis>
- inferred_transfer_type: bare_name_no_verb
- leading_keyword: ""
- grammar_fixable: false
- rule_sketch: ""
- reasoning: Despite "Galerie" suggesting a dealer, this is still a bare name with no transfer verb. Knowing this is a dealer requires world knowledge about the art market. The segment follows AAM bare-name convention.
</analysis>
</example>

<example>
<segment>"from the Municipality of Franekerdeel to the museum, 1913"</segment>
<analysis>
- inferred_transfer_type: transfer
- leading_keyword: "from"
- grammar_fixable: true
- rule_sketch: "if text matches 'from [entity] to [entity]' → transfer"
- reasoning: The "from X to Y" pattern reliably indicates a directed transfer between two named parties. This works regardless of who X and Y are.
</analysis>
</example>
</examples>

<artwork>
Object number: ${record.objectNumber} (artwork_id: ${record.artworkId})
</artwork>

<raw_provenance>
${record.provenanceText}
</raw_provenance>

<unknown_segments>
${unknownEvents.map(e => `<segment sequence="${e.sequence}">${e.raw_text}</segment>`).join("\n")}
</unknown_segments>

<task>
Analyse EACH unknown segment above. For each one, determine:

1. What type of transfer does it describe? Choose from: sale, inheritance, bequest, commission, purchase, confiscation, recuperation, loan, transfer, collection, gift, auction, exchange, deposit, seizure, restitution, donation, inventory, bare_name_no_verb, fragment_artefact, non_provenance

2. What is the leading keyword or structural phrase? Be specific — capture the exact words. If bare name with no keyword, use empty string.

3. Is it grammar-fixable? Apply the strict definition above. Most unknowns are bare names — do NOT over-classify these as grammar-fixable.

4. If grammar-fixable, sketch a precise rule with match conditions.

Think carefully about each segment. The most common mistake is classifying bare-name AAM entries as grammar-fixable when they have no keyword to match on.

Use the report_pattern_findings tool to submit your analysis.
</task>`;
}

function buildPromptSemanticCatalogue(record) {
  return `You are a provenance researcher parsing a museum artwork's ownership history from scratch. Your goal is to parse the provenance AND classify what kind of reasoning each event requires.

## Artwork
Object number: ${record.objectNumber} (artwork_id: ${record.artworkId})

## Raw provenance text
${record.provenanceText}

## Your task
Parse this provenance text into structured ownership events. Provenance texts use semicolons to separate events. Curly braces {…} contain bibliographic citations.

For EACH event/ownership transfer:
1. **owner_name** — The person or institution
2. **transfer_type** — How they acquired it (sale, inheritance, gift, collection, purchase, bequest, confiscation, loan, transfer, deposit, exchange, restitution, recuperation, donation, commission, auction, inventory, unknown)
3. **date_year** — Year (if mentioned)
4. **location** — City/place (if mentioned)
5. **price** — Amount + currency as string (if mentioned, e.g. "fl. 600" or "£2,500")

Then classify what KIND of reasoning you needed:
- **pattern_matching** — A keyword directly indicates the transfer type (e.g., "sold by" = sale, "by descent" = inheritance)
- **world_knowledge** — You needed to know something about the person/institution (e.g., knowing "Goudstikker" was a dealer, "SNK" was Stichting Nederlandsch Kunstbezit)
- **contextual_inference** — The transfer type is implied by position in the chain or surrounding events (e.g., a name after a sale event is likely the buyer)
- **disambiguation** — Multiple interpretations possible (e.g., is "1876" a transfer date or publication date?)
- **multi_event_linking** — Understanding requires connecting multiple events (e.g., "returned to" requires knowing who owned it before)

Use the report_semantic_findings tool to submit your analysis.`;
}

function buildPromptPositionEnrichment(record) {
  const eventsJson = record.events
    .filter(e => !e.is_cross_ref)
    .map(e => ({
      sequence: e.sequence,
      rawText: e.raw_text,
      transferType: e.transfer_type,
      transferCategory: e.transfer_category ?? null,
      parties: safeJson(e.parties),
    }));

  // Identify which events need enrichment
  const needsWork = eventsJson.filter(e => {
    const parties = e.parties || [];
    const hasNullPosition = parties.some(p => p.position === null || p.position === undefined);
    const isAmbiguous = e.transferCategory === "ambiguous";
    return hasNullPosition || isAmbiguous;
  });

  return `You are a provenance researcher classifying party positions and transfer categories in structured provenance data from a Rijksmuseum artwork.

## Background: provenance data standards

### AAM notation (source format)
The raw provenance text follows the AAM (American Alliance of Museums, 2001) punctuation convention:
- **;** (semicolon) separates events where direct succession is known or assumed
- **…** or **.** marks a gap — no direct transfer known between events
- **?** prefix marks uncertain/conjectural attribution
- **{…}** encloses inline bibliographic citations (not provenance data)
- **(YYYY-YYYY)** life dates of the owner
- Events are listed in chronological order: earliest known owner → present

Key AAM principle: each semicolon-delimited segment typically represents one transfer event involving one or more parties. The segment names the new owner (receiver); the previous segment's party is implicitly the sender.

### PLOD framework (target model)
We are structuring this data toward the PLOD (Provenance Linked Open Data) model, where each provenance event is a directed transfer:
- **Sender** → **Receiver**, optionally facilitated by an **Agent**
- Every transfer is either an **ownership** change (permanent: sale, gift, inheritance, confiscation, restitution) or a **custody** change (temporary: loan, deposit, storage)
- The sender/receiver distinction is the structural core — it enables cross-institutional provenance queries and authority linking

## Artwork
Object number: ${record.objectNumber} (artwork_id: ${record.artworkId})

## Raw provenance text
${record.provenanceText}

## Parser's structured output (non-cross-reference events only)
${JSON.stringify(eventsJson, null, 2)}

## Events needing enrichment
The following events have parties with null position or ambiguous transfer category:
${needsWork.map(e => `- Sequence ${e.sequence}: ${e.rawText?.slice(0, 80)}`).join("\n")}

## Your task
For EACH event listed above, provide:

### Party position classification
For parties with position=null, classify as:
- **sender** — the party relinquishing the artwork (seller, donor, lender, deceased estate)
- **receiver** — the party acquiring the artwork (buyer, heir, recipient, borrower, collector)
- **agent** — the party facilitating without owning (dealer, auctioneer, intermediary)

Use the AAM sequential convention: in a bare-name event (no transfer verb), the named party is typically the **receiver** (current holder). The sender is implicitly the previous event's party. In sale events, the named seller is the sender; the "to [Name]" party is the receiver. A dealer buying "for" someone else is an **agent**, not a receiver.

### Transfer category classification
For events with transferCategory="ambiguous" (typically transfer_type "transfer" or "unknown"):
- **ownership** — the artwork changes hands permanently (sale, gift, inheritance, confiscation, restitution)
- **custody** — the artwork is held temporarily (loan, deposit, temporary storage)

Consider context clues: "transferred to the museum" after a loan period suggests permanent acquisition (ownership). "Stored at" or "deposited with" suggests custody. Administrative transfers between government departments are typically ownership.

### Confidence calibration
- **≥ 0.9** — structural certainty: a keyword or the AAM convention makes it unambiguous
- **0.7–0.9** — contextual inference: position is clear from the chain but not explicitly stated
- **0.5–0.7** — probable: requires some interpretation or world knowledge
- **< 0.5** — genuinely ambiguous: multiple valid interpretations exist

Only report enrichments where you have something to contribute. Skip events where the ambiguity is genuine and irreducible.

## Example

Given an event: \`? Pieter van Ruijven (1624-1674), Delft\` with transferType "unknown" and position null:
- **position: receiver** (confidence 0.85) — bare-name AAM convention: the named party is the holder
- **category: ownership** (confidence 0.80) — a named collector with life dates implies long-term ownership, not temporary custody

Use the report_position_enrichment tool to submit your classifications.`;
}

// ─── Batch construction ─────────────────────────────────────────────

function safeJson(val) {
  if (val == null) return null;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return val; }
  }
  return val;
}

function buildBatchRequests(records) {
  const { tool: toolDef, buildPrompt } = MODE_CONFIG[mode];
  const requests = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const prompt = buildPrompt(record);
    if (verbose) {
      console.log(`\n${"─".repeat(60)}`);
      console.log(`Prompt for ${record.objectNumber}:`);
      console.log(prompt.slice(0, 500) + (prompt.length > 500 ? "\n...(truncated)" : ""));
    }

    const params = {
      model,
      max_tokens: 4096,
      tools: [toolDef],
      tool_choice: thinkingBudget > 0 ? { type: "auto" } : { type: "any" },
      messages: [{ role: "user", content: prompt }],
    };
    // Extended thinking support — requires tool_choice: "auto" (not "any")
    if (thinkingBudget > 0) {
      params.thinking = { type: "enabled", budget_tokens: thinkingBudget };
      params.max_tokens = thinkingBudget + 4096;
    }
    requests.push({
      custom_id: `${mode}-${i}-${record.artworkId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
      params,
    });
  }
  return requests;
}

// ─── API interaction ────────────────────────────────────────────────

async function submitBatch(client, requests) {
  console.log(`Submitting batch: ${requests.length} requests...`);
  const batch = await client.messages.batches.create({ requests });
  console.log(`  Batch ID:    ${batch.id}`);
  console.log(`  Status:      ${batch.processing_status}`);

  // Save state file for resumability
  const stateFile = outputPath.replace(/\.json$/, ".state.json");
  writeFileSync(stateFile, JSON.stringify({
    batchId: batch.id,
    mode,
    sampleSize: requests.length,
    model,
    createdAt: new Date().toISOString(),
  }, null, 2));
  console.log(`  State file:  ${stateFile}`);

  return batch.id;
}

const MAX_POLL_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours

async function pollUntilDone(client, batchId) {
  let polls = 0;
  const start = Date.now();
  while (true) {
    const status = await client.messages.batches.retrieve(batchId);
    polls++;
    const c = status.request_counts;
    const elapsed = ((Date.now() - start) / 60_000).toFixed(1);
    console.log(
      `  [poll ${polls}, ${elapsed}m] ${status.processing_status} — ` +
      `succeeded: ${c.succeeded}, errored: ${c.errored}, ` +
      `expired: ${c.expired}, processing: ${c.processing}`
    );
    if (status.processing_status === "ended") return status;
    if (Date.now() - start > MAX_POLL_DURATION_MS) {
      throw new Error(`Batch ${batchId} did not complete within 4 hours. Resume with --resume ${batchId}`);
    }
    await new Promise(r => setTimeout(r, 30_000));
  }
}

async function collectResults(client, batchId) {
  const results = [];
  for await (const entry of await client.messages.batches.results(batchId)) {
    if (entry.result.type === "succeeded") {
      const toolBlock = entry.result.message.content.find(b => b.type === "tool_use");
      if (toolBlock) {
        results.push({
          customId: entry.custom_id,
          data: toolBlock.input,
          usage: entry.result.message.usage,
        });
      } else {
        results.push({ customId: entry.custom_id, error: "no_tool_use_block" });
      }
    } else {
      results.push({
        customId: entry.custom_id,
        error: entry.result.type,
        detail: entry.result.error || null,
      });
    }
  }
  return results;
}

// ─── Aggregation ────────────────────────────────────────────────────

function aggregateSilentErrors(results) {
  const errorsByType = {};
  const errorsByField = {};
  const errorsBySeverity = {};
  let totalEventsChecked = 0;
  let recordsWithErrors = 0;
  let recordsClean = 0;
  const allErrors = [];

  for (const r of results) {
    if (r.error) continue;
    totalEventsChecked += r.data.total_events_checked || 0;
    if (r.data.errors && r.data.errors.length > 0) {
      recordsWithErrors++;
      for (const e of r.data.errors) {
        errorsByType[e.error_type] = (errorsByType[e.error_type] || 0) + 1;
        errorsByField[e.field] = (errorsByField[e.field] || 0) + 1;
        errorsBySeverity[e.severity] = (errorsBySeverity[e.severity] || 0) + 1;
        allErrors.push({ ...e, objectNumber: r.data.object_number, artworkId: r.data.artwork_id });
      }
    } else {
      recordsClean++;
    }
  }

  // Cluster similar errors
  const patterns = {};
  for (const e of allErrors) {
    const key = `${e.error_type}::${e.field}`;
    if (!patterns[key]) patterns[key] = { errorType: e.error_type, field: e.field, count: 0, examples: [] };
    patterns[key].count++;
    if (patterns[key].examples.length < 3) {
      patterns[key].examples.push({
        objectNumber: e.objectNumber, sequence: e.event_sequence,
        raw: e.raw_text_quote, parser: e.parser_value, correct: e.correct_value,
      });
    }
  }
  const topPatterns = Object.values(patterns).sort((a, b) => b.count - a.count);

  return {
    totalEventsChecked, recordsWithErrors, recordsClean,
    errorRate: recordsWithErrors / Math.max(recordsWithErrors + recordsClean, 1),
    totalErrors: allErrors.length,
    errorsByType, errorsByField, errorsBySeverity, topPatterns,
  };
}

function aggregatePatternMining(results) {
  const keywordFreq = {};
  let bareNameCount = 0;
  let fragmentCount = 0;
  let nonProvenanceCount = 0;
  let grammarFixableTotal = 0;
  let totalSegments = 0;

  for (const r of results) {
    if (r.error || !r.data.segments) continue;
    for (const seg of r.data.segments) {
      totalSegments++;
      if (seg.inferred_transfer_type === "bare_name_no_verb") { bareNameCount++; continue; }
      if (seg.inferred_transfer_type === "fragment_artefact") { fragmentCount++; continue; }
      if (seg.inferred_transfer_type === "non_provenance") { nonProvenanceCount++; continue; }

      const key = (seg.leading_keyword || "").toLowerCase().trim();
      if (!key) { bareNameCount++; continue; } // empty keyword = bare name

      if (!keywordFreq[key]) {
        keywordFreq[key] = {
          count: 0, transferType: seg.inferred_transfer_type,
          grammarFixable: seg.grammar_fixable, ruleSketch: seg.rule_sketch || "",
          examples: [],
        };
      }
      keywordFreq[key].count++;
      if (keywordFreq[key].examples.length < 3) {
        keywordFreq[key].examples.push({
          objectNumber: r.data.object_number, rawText: seg.raw_text,
        });
      }
      if (seg.grammar_fixable) grammarFixableTotal++;
    }
  }

  const sortedKeywords = Object.entries(keywordFreq)
    .sort((a, b) => b[1].count - a[1].count);

  return {
    totalSegments, bareNameCount, fragmentCount, nonProvenanceCount,
    grammarFixableTotal, sortedKeywords,
  };
}

function aggregateSemanticCatalogue(results) {
  const reasoningDist = {};
  const difficultyDist = {};
  const examples = {};
  let totalEvents = 0;

  for (const r of results) {
    if (r.error || !r.data.parsed_events) continue;
    difficultyDist[r.data.overall_difficulty] =
      (difficultyDist[r.data.overall_difficulty] || 0) + 1;
    for (const ev of r.data.parsed_events) {
      totalEvents++;
      const rt = ev.reasoning_type || "unknown";
      reasoningDist[rt] = (reasoningDist[rt] || 0) + 1;
      if (!examples[rt]) examples[rt] = [];
      if (examples[rt].length < 5) {
        examples[rt].push({
          objectNumber: r.data.object_number,
          rawText: ev.raw_text_segment,
          transferType: ev.transfer_type,
          explanation: ev.reasoning_explanation,
        });
      }
    }
  }

  return { totalEvents, reasoningDist, difficultyDist, examples };
}

function aggregatePositionEnrichment(results) {
  let totalEnrichments = 0;
  let partyUpdates = 0;
  let categoryUpdates = 0;
  let highConfParty = 0;
  let highConfCategory = 0;
  const positionDist = {};
  const categoryDist = {};
  const allUpdates = [];

  for (const r of results) {
    if (r.error || !r.data?.enrichments) continue;
    for (const en of r.data.enrichments) {
      totalEnrichments++;
      for (const pu of en.party_updates || []) {
        partyUpdates++;
        positionDist[pu.position] = (positionDist[pu.position] || 0) + 1;
        if (pu.confidence >= 0.8) highConfParty++;
        allUpdates.push({ type: "party", objectNumber: r.data.object_number, ...pu, sequence: en.event_sequence });
      }
      if (en.category_update) {
        categoryUpdates++;
        categoryDist[en.category_update.category] = (categoryDist[en.category_update.category] || 0) + 1;
        if (en.category_update.confidence >= 0.8) highConfCategory++;
        allUpdates.push({ type: "category", objectNumber: r.data.object_number, ...en.category_update, sequence: en.event_sequence });
      }
    }
  }

  return {
    totalEnrichments, partyUpdates, categoryUpdates,
    highConfParty, highConfCategory,
    positionDist, categoryDist, allUpdates,
  };
}

function printPositionEnrichmentReport(report) {
  console.log(`\n## Position Enrichment (${report.totalEnrichments} events processed)\n`);
  console.log(`| Metric | Value |`);
  console.log(`|--------|-------|`);
  console.log(`| Party position updates | ${report.partyUpdates} (${report.highConfParty} high-confidence ≥0.8) |`);
  console.log(`| Transfer category updates | ${report.categoryUpdates} (${report.highConfCategory} high-confidence ≥0.8) |`);

  console.log(`\n### Position distribution\n`);
  console.log(`| Position | Count |`);
  console.log(`|----------|-------|`);
  for (const [pos, count] of Object.entries(report.positionDist).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${pos} | ${count} |`);
  }

  console.log(`\n### Category distribution\n`);
  console.log(`| Category | Count |`);
  console.log(`|----------|-------|`);
  for (const [cat, count] of Object.entries(report.categoryDist).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${cat} | ${count} |`);
  }

  // Show some examples
  console.log(`\n### Sample enrichments\n`);
  for (const u of report.allUpdates.slice(0, 10)) {
    if (u.type === "party") {
      console.log(`- **${u.objectNumber}** seq ${u.sequence}: ${u.party_name} → ${u.position} (${(u.confidence * 100).toFixed(0)}%)`);
      console.log(`  _${u.reasoning}_`);
    } else {
      console.log(`- **${u.objectNumber}** seq ${u.sequence}: → ${u.category} (${(u.confidence * 100).toFixed(0)}%)`);
      console.log(`  _${u.reasoning}_`);
    }
  }
}


// ─── Cost estimation ────────────────────────────────────────────────

function estimateCost(results) {
  // Batch API pricing (50% of standard)
  const RATES = {
    "claude-sonnet-4-20250514": { input: 1.50, output: 7.50 },
    "claude-sonnet-4-6-20250514": { input: 1.50, output: 7.50 },
    "claude-opus-4-20250514": { input: 7.50, output: 37.50 },
    "claude-haiku-4-5-20251001": { input: 0.50, output: 2.50 },
  };
  const rate = RATES[model] || { input: 1.50, output: 7.50 };

  let inputTokens = 0, outputTokens = 0;
  for (const r of results) {
    if (r.usage) {
      inputTokens += r.usage.input_tokens || 0;
      outputTokens += r.usage.output_tokens || 0;
    }
  }
  const cost = (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
  return { inputTokens, outputTokens, estimatedCost: cost.toFixed(2) };
}

// ─── Markdown report ────────────────────────────────────────────────

function printSilentErrorsReport(report) {
  const total = report.recordsWithErrors + report.recordsClean;
  console.log(`\n## Provenance Parser Audit: Silent Errors (${total} records)\n`);
  console.log(`| Metric | Value |`);
  console.log(`|--------|-------|`);
  console.log(`| Records checked | ${total} |`);
  console.log(`| Records with errors | ${report.recordsWithErrors} (${(100 * report.errorRate).toFixed(1)}%) |`);
  console.log(`| Total events checked | ${report.totalEventsChecked} |`);
  console.log(`| Total errors found | ${report.totalErrors} |`);

  console.log(`\n### Error distribution by type\n`);
  console.log(`| Type | Count | % |`);
  console.log(`|------|-------|---|`);
  for (const [type, count] of Object.entries(report.errorsByType).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${type} | ${count} | ${(100 * count / Math.max(report.totalErrors, 1)).toFixed(1)}% |`);
  }

  console.log(`\n### Error distribution by field\n`);
  console.log(`| Field | Count | % |`);
  console.log(`|-------|-------|---|`);
  for (const [field, count] of Object.entries(report.errorsByField).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${field} | ${count} | ${(100 * count / Math.max(report.totalErrors, 1)).toFixed(1)}% |`);
  }

  console.log(`\n### Error distribution by severity\n`);
  console.log(`| Severity | Count |`);
  console.log(`|----------|-------|`);
  for (const [sev, count] of Object.entries(report.errorsBySeverity).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${sev} | ${count} |`);
  }

  console.log(`\n### Top error patterns\n`);
  console.log(`| Pattern | Count | Example |`);
  console.log(`|---------|-------|---------|`);
  for (const p of report.topPatterns.slice(0, 15)) {
    const ex = p.examples[0];
    const exStr = ex ? `${ex.objectNumber} seq ${ex.sequence}: "${ex.raw?.slice(0, 60) || ""}"` : "";
    console.log(`| ${p.errorType} / ${p.field} | ${p.count} | ${exStr} |`);
  }
}

function printPatternMiningReport(report) {
  console.log(`\n## Provenance Pattern Mining (${report.totalSegments} unknown segments)\n`);
  console.log(`| Category | Count | % |`);
  console.log(`|----------|-------|---|`);
  console.log(`| Grammar-fixable keywords | ${report.grammarFixableTotal} | ${(100 * report.grammarFixableTotal / Math.max(report.totalSegments, 1)).toFixed(1)}% |`);
  console.log(`| Bare names (no verb) | ${report.bareNameCount} | ${(100 * report.bareNameCount / Math.max(report.totalSegments, 1)).toFixed(1)}% |`);
  console.log(`| Fragment artefacts | ${report.fragmentCount} | ${(100 * report.fragmentCount / Math.max(report.totalSegments, 1)).toFixed(1)}% |`);
  console.log(`| Non-provenance text | ${report.nonProvenanceCount} | ${(100 * report.nonProvenanceCount / Math.max(report.totalSegments, 1)).toFixed(1)}% |`);

  console.log(`\n### Grammar-fixable keywords (sorted by frequency)\n`);
  console.log(`| Rank | Keyword | Count | Transfer type | Fixable | Rule sketch |`);
  console.log(`|------|---------|-------|---------------|---------|-------------|`);
  let rank = 0;
  for (const [keyword, info] of report.sortedKeywords.slice(0, 30)) {
    rank++;
    console.log(`| ${rank} | "${keyword}" | ${info.count} | ${info.transferType} | ${info.grammarFixable ? "Yes" : "No"} | ${info.ruleSketch} |`);
  }
}

function printSemanticCatalogueReport(report) {
  console.log(`\n## Semantic Catalogue (${report.totalEvents} events parsed)\n`);

  console.log(`### Difficulty distribution\n`);
  console.log(`| Difficulty | Records |`);
  console.log(`|-----------|---------|`);
  for (const [diff, count] of Object.entries(report.difficultyDist).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${diff} | ${count} |`);
  }

  console.log(`\n### Reasoning type distribution\n`);
  console.log(`| Reasoning type | Count | % |`);
  console.log(`|----------------|-------|---|`);
  for (const [rt, count] of Object.entries(report.reasoningDist).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${rt} | ${count} | ${(100 * count / Math.max(report.totalEvents, 1)).toFixed(1)}% |`);
  }

  console.log(`\n### Representative examples per reasoning type\n`);
  for (const [rt, exs] of Object.entries(report.examples)) {
    console.log(`\n#### ${rt}\n`);
    for (const ex of exs.slice(0, 3)) {
      console.log(`- **${ex.objectNumber}**: "${ex.rawText?.slice(0, 80)}" → ${ex.transferType}`);
      console.log(`  _${ex.explanation}_`);
    }
  }
}

// ─── Mode registry ──────────────────────────────────────────────────

const MODE_CONFIG = {
  "silent-errors": {
    sample: sampleSilentErrors,
    tool: TOOL_SILENT_ERRORS,
    buildPrompt: buildPromptSilentErrors,
    aggregate: aggregateSilentErrors,
    report: printSilentErrorsReport,
  },
  "pattern-mining": {
    sample: sampleUnknowns,
    tool: TOOL_PATTERN_MINING,
    buildPrompt: buildPromptPatternMining,
    aggregate: aggregatePatternMining,
    report: printPatternMiningReport,
  },
  "semantic-catalogue": {
    sample: sampleUnknowns,
    tool: TOOL_SEMANTIC_CATALOGUE,
    buildPrompt: buildPromptSemanticCatalogue,
    aggregate: aggregateSemanticCatalogue,
    report: printSemanticCatalogueReport,
  },
  "position-enrichment": {
    sample: samplePositionEnrichment,
    tool: TOOL_POSITION_ENRICHMENT,
    buildPrompt: buildPromptPositionEnrichment,
    aggregate: aggregatePositionEnrichment,
    report: printPositionEnrichmentReport,
  },
};

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  const cfg = MODE_CONFIG[mode];
  const client = resumeBatchId || !dryRun ? new Anthropic() : null;

  // When resuming, skip sampling — go straight to polling
  if (resumeBatchId) {
    console.log(`Resuming batch ${resumeBatchId}...`);
    console.log(`\nPolling for completion (30s intervals)...`);
    await pollUntilDone(client, resumeBatchId);

    console.log(`\nCollecting results...`);
    const results = await collectResults(client, resumeBatchId);
    const successes = results.filter(r => !r.error);
    const failures = results.filter(r => r.error);
    console.log(`  Succeeded: ${successes.length}, Failed: ${failures.length}`);

    const report = cfg.aggregate(results);
    const cost = estimateCost(results);
    const output = {
      meta: {
        mode, model, batchId: resumeBatchId, sampleSize: successes.length,
        createdAt: new Date().toISOString(),
        successCount: successes.length, errorCount: failures.length,
        ...cost,
      },
      results: results.map(r => ({
        customId: r.customId,
        ...(r.error ? { error: r.error, detail: r.detail } : { data: r.data }),
      })),
      report,
    };
    writeFileSync(outputPath, JSON.stringify(output, null, 2));
    printReport(cfg, report, cost);
    return;
  }

  // Sample records from DB
  console.log(`Sampling ${sampleSize} records (mode: ${mode})...`);
  const records = cfg.sample();
  console.log(`  Sampled: ${records.length} records`);

  if (records.length === 0) {
    console.error("No records found. Check your DB and mode.");
    process.exit(1);
  }

  const requests = buildBatchRequests(records);
  console.log(`  Built ${requests.length} batch requests`);

  if (dryRun) {
    const dryOutput = {
      meta: { mode, model, sampleSize: records.length, dryRun: true, createdAt: new Date().toISOString() },
      requests: requests.map(r => ({
        customId: r.custom_id,
        prompt: r.params.messages[0].content,
        toolSchema: r.params.tools[0].name,
      })),
    };
    writeFileSync(outputPath, JSON.stringify(dryOutput, null, 2));
    console.log(`\nDry run complete. Prompts written to ${outputPath}`);
    if (db) db.close();
    return;
  }

  const batchId = await submitBatch(client, requests);

  console.log(`\nPolling for completion (30s intervals)...`);
  await pollUntilDone(client, batchId);

  console.log(`\nCollecting results...`);
  const results = await collectResults(client, batchId);
  const successes = results.filter(r => !r.error);
  const failures = results.filter(r => r.error);
  console.log(`  Succeeded: ${successes.length}, Failed: ${failures.length}`);

  const report = cfg.aggregate(results);
  const cost = estimateCost(results);

  const output = {
    meta: {
      mode, model, batchId, sampleSize: records.length,
      createdAt: new Date().toISOString(),
      successCount: successes.length, errorCount: failures.length,
      ...cost,
    },
    results: results.map(r => ({
      customId: r.customId,
      ...(r.error ? { error: r.error, detail: r.detail } : { data: r.data }),
    })),
    report,
  };
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  printReport(cfg, report, cost);

  // Mark state file as complete
  const stateFile = outputPath.replace(/\.json$/, ".state.json");
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      state.completedAt = new Date().toISOString();
      writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch {}
  }

  if (db) db.close();
  console.log(`\nDone.`);
}

function printReport(cfg, report, cost) {
  console.log(`\nResults written to ${outputPath}`);
  console.log(`\n${"═".repeat(60)}`);
  cfg.report(report);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`\n### Cost`);
  console.log(`| Metric | Value |`);
  console.log(`|--------|-------|`);
  console.log(`| Input tokens | ${cost.inputTokens.toLocaleString()} |`);
  console.log(`| Output tokens | ${cost.outputTokens.toLocaleString()} |`);
  console.log(`| Estimated cost | $${cost.estimatedCost} |`);
}

main().catch(err => {
  console.error(err);
  if (db) db.close();
  process.exit(1);
});
