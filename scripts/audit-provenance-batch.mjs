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

const MODES = ["silent-errors", "pattern-mining", "semantic-catalogue"];

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
    artworkIds = db.prepare(`
      WITH candidates AS (
        SELECT DISTINCT e.artwork_id, e.parse_method,
          CASE WHEN e.date_year < 1600 THEN 'pre1600'
               WHEN e.date_year < 1800 THEN '1600-1800'
               WHEN e.date_year < 1900 THEN '1800-1900'
               ELSE 'post1900' END AS century_bin
        FROM provenance_events e
        WHERE e.parse_method IN ('peg','regex_fallback')
          AND e.transfer_type != 'unknown' AND e.is_cross_ref = 0
          AND e.date_year IS NOT NULL
      )
      SELECT artwork_id FROM (
        SELECT artwork_id,
          ROW_NUMBER() OVER (PARTITION BY parse_method, century_bin ORDER BY RANDOM()) AS rn
        FROM candidates
      ) WHERE rn <= ?
    `).all(Math.ceil(sampleSize / 8)).map(r => r.artwork_id);
  } else {
    // Bias toward complex records (3+ events) — where parsing errors cluster
    artworkIds = db.prepare(`
      SELECT artwork_id FROM (
        SELECT e.artwork_id, COUNT(*) AS event_count
        FROM provenance_events e
        WHERE e.parse_method IN ('peg','regex_fallback')
          AND e.transfer_type != 'unknown' AND e.is_cross_ref = 0
        GROUP BY e.artwork_id
        HAVING event_count >= 3
      ) ORDER BY RANDOM() LIMIT ?
    `).all(sampleSize).map(r => r.artwork_id);
  }
  return fetchRecords(artworkIds, { periods: true });
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
              enum: ["transfer_type", "parties", "date_year", "date_qualifier",
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

// ─── Prompt builders ────────────────────────────────────────────────

function buildPromptSilentErrors(record) {
  // Build a clean representation of parser output
  const eventsJson = record.events.map(e => ({
    sequence: e.sequence,
    rawText: e.raw_text,
    transferType: e.transfer_type,
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
2. **parties** — Are all names captured? Are roles correct? Any name truncation or fragmentation?
3. **date_year / date_qualifier** — Does it match the date in raw text? Not confused with a price, catalogue number, or publication year?
4. **location** — Correctly extracted, not a party name fragment?
5. **price_amount / price_currency** — Amount and currency correct? Not concatenated with a year?
6. **missing events** — Any ownership transfers in raw text with no corresponding parsed event?
7. **phantom events** — Any parsed events that don't correspond to real provenance transfers?
8. **merge/split errors** — Two events merged into one, or one event split into two?

## DO NOT report as errors
- Events correctly classified as "unknown" for genuinely ambiguous bare names (e.g. "Mathias Komor (Beijing)")
- Cross-references (isCrossRef: true) classified as "unknown" — this is CORRECT by design
- Minor whitespace or formatting differences in names
- Missing buyer/seller distinction — the parser does not yet have separate buyer vs seller fields
- Relational phrases kept as names (e.g. "his eldest son") — known limitation (#85)
- Fractional prices (½, ¼) not parsed — known limitation (#89)
- Pre-decimal British pounds (£0.13.0) — known limitation (#92)

Report ONLY genuine errors where the parser produced a wrong value or missed a real transfer.

Use the report_audit_findings tool to submit your findings.`;
}

function buildPromptPatternMining(record) {
  const unknownEvents = record.events.filter(
    e => e.transfer_type === "unknown" && !e.is_cross_ref
  );

  return `You are analysing unparsed provenance text segments from a museum artwork. The parser classified these as "unknown" — your job is to identify structural patterns that could be handled by grammar rules.

## Artwork
Object number: ${record.objectNumber} (artwork_id: ${record.artworkId})

## Full raw provenance text (for context)
${record.provenanceText}

## Unknown event segments (the parser could not classify these)
${unknownEvents.map(e => `- Sequence ${e.sequence}: "${e.raw_text}"`).join("\n")}

## Your task
For EACH unknown segment above:

1. **What type of ownership transfer does this describe?** Choose from: sale, inheritance, bequest, commission, purchase, confiscation, recuperation, loan, transfer, collection, gift, auction, exchange, deposit, seizure, restitution, donation, inventory, bare_name_no_verb, fragment_artefact, non_provenance

2. **What is the leading keyword or structural phrase?** (e.g., "sold by", "by descent", "the dealer", "returned to"). If this is just a bare name with no verb or keyword, set this to empty string.

3. **Is this grammar-fixable?** A pattern is grammar-fixable if a keyword rule would ALWAYS correctly classify it. Set to false if it requires contextual reasoning, world knowledge, or disambiguation.

4. **If grammar-fixable, sketch a rule:** e.g., "if text starts with 'returned' → transfer"

## Key distinctions
- "bare_name_no_verb" = just a person/institution name with optional location, no transfer verb (e.g. "Frits Lugt, Paris"). These are NOT grammar-fixable.
- "fragment_artefact" = orphaned text from a splitting bug (empty, bare date, lone price). Not a real event.
- "non_provenance" = bibliographic reference, editorial note, or other non-transfer text.

Use the report_pattern_findings tool to submit your analysis.`;
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

    requests.push({
      custom_id: `${mode}-${i}-${record.artworkId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
      params: {
        model,
        max_tokens: 4096,
        tools: [toolDef],
        tool_choice: { type: "any" },
        messages: [{ role: "user", content: prompt }],
      },
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


// ─── Cost estimation ────────────────────────────────────────────────

function estimateCost(results) {
  // Batch API pricing (50% of standard)
  const RATES = {
    "claude-sonnet-4-20250514": { input: 1.50, output: 7.50 },
    "claude-sonnet-4-6-20250514": { input: 1.50, output: 7.50 },
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
