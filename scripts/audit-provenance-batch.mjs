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

const MODES = ["silent-errors", "pattern-mining", "semantic-catalogue", "position-enrichment", "structural-signals", "type-classification", "forced-sale"];

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
    if (eraYear != null && !Number.isFinite(eraYear)) {
      console.error(`Invalid --era value: ${eraFilter}`);
      process.exit(1);
    }
    const eraClause = eraYear
      ? `AND e.artwork_id IN (SELECT artwork_id FROM provenance_events WHERE date_year IS NOT NULL GROUP BY artwork_id HAVING MIN(date_year) < ?)`
      : "";
    const eraBindings = eraYear ? [eraYear] : [];
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
    `).all(...eraBindings, sampleSize).map(r => r.artwork_id);
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
    // Sample artworks that have null-position parties
    artworkIds = db.prepare(`
      SELECT DISTINCT artwork_id FROM provenance_parties
      WHERE party_position IS NULL AND position_method IS NULL
      ORDER BY RANDOM() LIMIT ?
    `).all(sampleSize).map(r => r.artwork_id);
  }
  return fetchRecords(artworkIds, { periods: false });
}

function sampleTypeClassification() {
  const db = openDb();
  // Get all artworks with non-unsold unknown events (the true residual)
  const UNSOLD_RE = /\b(?:unsold|bought\s+in|withdrawn|invendu|ingetrokken)\b/i;
  let artworkIds;

  if (recordsList) {
    const objectNumbers = recordsList.split(",").map(s => s.trim());
    artworkIds = db.prepare(
      `SELECT art_id FROM artworks WHERE object_number IN (${objectNumbers.map(() => "?").join(",")})`
    ).all(...objectNumbers).map(r => r.art_id);
  } else {
    // All artworks with non-unsold unknown events
    const rows = db.prepare(`
      SELECT DISTINCT pe.artwork_id, pe.raw_text
      FROM provenance_events pe
      WHERE pe.transfer_type = 'unknown' AND pe.is_cross_ref = 0
    `).all();
    // Filter out unsold in JS (complex regex not possible in SQLite)
    const ids = new Set();
    for (const row of rows) {
      if (!UNSOLD_RE.test(row.raw_text)) ids.add(row.artwork_id);
    }
    artworkIds = [...ids].slice(0, sampleSize);
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

const TOOL_STRUCTURAL_SIGNALS = {
  name: "report_structural_signals",
  description: "Report structural signals found in unknown provenance segments that could enable deterministic classification",
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
            raw_text: { type: "string" },
            signals: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  signal_type: {
                    type: "string",
                    enum: [
                      "life_dates",           // (YYYY-YYYY) pattern
                      "noble_title",          // Baron, Jonkheer, Count, etc.
                      "academic_title",       // Dr, Prof., Mr (Dutch)
                      "institution_name",     // museum, church, gallery, etc.
                      "lugt_mark",            // (L. NNNN)
                      "city_location",        // known city name present
                      "dutch_phrase",         // Dutch-language provenance phrase
                      "french_phrase",        // French-language provenance phrase
                      "dealer_indicator",     // "dealer", "gallery", "Galerie", etc.
                      "auction_house",        // known auction house name
                      "collection_mark",      // collector's stamp or mark reference
                      "date_only",            // standalone date with no party
                      "cross_ref_fragment",   // reference to another artwork
                      "citation_leak",        // bibliographic text that leaked out of {}
                      "other",
                    ],
                  },
                  evidence: { type: "string", description: "The specific text that constitutes this signal" },
                  implies_type: {
                    type: "string",
                    enum: ["collection", "sale", "loan", "deposit", "transfer", "inventory", "non_provenance", "uncertain"],
                    description: "What transfer type this signal suggests",
                  },
                  deterministic: { type: "boolean", description: "Could a parser rule reliably detect this signal without world knowledge?" },
                },
                required: ["signal_type", "evidence", "implies_type", "deterministic"],
              },
            },
            recommended_type: {
              type: "string",
              enum: ["collection", "sale", "loan", "deposit", "transfer", "inventory", "by_descent", "widowhood", "non_provenance", "unknown"],
              description: "Recommended transfer type based on all signals combined",
            },
            confidence: { type: "number", description: "0.0-1.0 confidence in the recommendation" },
          },
          required: ["event_sequence", "raw_text", "signals", "recommended_type", "confidence"],
        },
      },
    },
    required: ["artwork_id", "object_number", "segments"],
  },
};

const TYPE_CLASSIFICATION_TYPES = [
  "sale", "inheritance", "by_descent", "widowhood", "bequest", "commission",
  "confiscation", "theft", "looting", "recuperation", "restitution",
  "loan", "transfer", "collection", "gift", "exchange", "deposit",
  "inventory", "non_provenance", "unknown",
];

const TOOL_TYPE_CLASSIFICATION = {
  name: "report_type_classification",
  description: "Classify transfer types for individual unknown provenance events that no parser rule can handle",
  input_schema: {
    type: "object",
    properties: {
      artwork_id: { type: "integer" },
      object_number: { type: "string" },
      classifications: {
        type: "array",
        items: {
          type: "object",
          properties: {
            event_sequence: { type: "integer" },
            raw_text: { type: "string" },
            transfer_type: { type: "string", enum: TYPE_CLASSIFICATION_TYPES },
            transfer_category: { type: "string", enum: ["ownership", "custody", "ambiguous"] },
            confidence: { type: "number", description: "0.0-1.0" },
            reasoning: { type: "string", description: "Brief explanation of why this type was chosen" },
          },
          required: ["event_sequence", "raw_text", "transfer_type", "transfer_category", "confidence", "reasoning"],
        },
      },
    },
    required: ["artwork_id", "object_number", "classifications"],
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
  const eventsXml = record.events
    .filter(e => !e.is_cross_ref)
    .map(e => {
      const parties = safeJson(e.parties) || [];
      const partiesXml = parties.map((p, i) =>
        `      <party idx="${i}" name="${(p.name || "").replace(/"/g, "&quot;")}" role="${p.role ?? "null"}" position="${p.position ?? "null"}" />`
      ).join("\n");
      return `    <event sequence="${e.sequence}" transfer_type="${e.transfer_type}" transfer_category="${e.transfer_category ?? "null"}">
      <raw_text>${e.raw_text}</raw_text>
${partiesXml}
    </event>`;
    }).join("\n");

  // Identify which events need enrichment
  const needsWork = record.events.filter(e => {
    if (e.is_cross_ref) return false;
    const parties = safeJson(e.parties) || [];
    const hasNullPosition = parties.some(p => p.position === null || p.position === undefined);
    const isAmbiguous = e.transfer_category === "ambiguous";
    return hasNullPosition || isAmbiguous;
  });

  const needsWorkXml = needsWork.map(e => {
    const parties = safeJson(e.parties) || [];
    const nullParties = parties
      .map((p, i) => ({ ...p, idx: i }))
      .filter(p => p.position === null || p.position === undefined);
    const parts = [];
    if (nullParties.length > 0) parts.push(`null_position_parties="${nullParties.map(p => `idx=${p.idx}:${p.name}`).join("; ")}"`);
    if (e.transfer_category === "ambiguous") parts.push(`ambiguous_category="true"`);
    return `    <target sequence="${e.sequence}" ${parts.join(" ")}>${(e.raw_text || "").slice(0, 120)}</target>`;
  }).join("\n");

  return `<role>You are a provenance researcher classifying party positions and transfer categories in structured provenance data from a Rijksmuseum artwork. A parser has already assigned positions to most parties using keyword rules and role inference. The remaining parties could not be positioned by any rule. Your job is to classify each one using the provenance chain context, AAM conventions, and art-historical knowledge.</role>

<background>
<aam_standard>
The provenance text follows the AAM (American Alliance of Museums, 2001) convention:
- Semicolons (;) separate events in chronological order (earliest → present)
- Each segment names the new holder (receiver); the previous segment's party is implicitly the sender
- Question mark (?) prefix marks uncertain attribution
- Curly braces ({…}) enclose bibliographic citations (not provenance data)
- "from X to Y" = X is sender, Y is receiver
- "whose sale" / "his sale" = the previous owner (sender) consigning at auction
- "or his sale" / "possibly anonymous sale" = the previous owner as consignor (sender)
- A bare name with dates and location = the person/institution held the artwork (receiver)
</aam_standard>

<plod_model>
We are structuring toward the PLOD (Provenance Linked Open Data) model:
- Each event is a directed transfer: **Sender** → **Receiver**, optionally facilitated by an **Agent**
- **Sender** — the party relinquishing the artwork (seller, consignor, donor, lender, deceased estate, confiscated-from)
- **Receiver** — the party acquiring the artwork (buyer, heir, recipient, borrower, collector, museum)
- **Agent** — facilitates without owning: a dealer buying "for" or "on behalf of" someone, an auction house conducting the sale, an intermediary
- Transfer category: **ownership** (permanent: sale, gift, inheritance, confiscation, restitution) vs **custody** (temporary: loan, deposit, storage)
</plod_model>

<parser_artifacts>
The parser sometimes creates parties from text fragments that are not real parties. Common patterns:
- "whose sale" / "or his sale" → parsed as party name, but this is an anaphoric reference to the previous owner (sender)
- "post-auction sale" / "sold after-sale" → parsed as party name, but this is a sale modifier (not a party — skip it)
- "after closure of Museum X in YYYY" → contextual preamble (not a party — skip it)
- "from his heirs to the museum" → "from his heirs" is the sender; "museum" is the receiver
- "ffrom whom" → typo for "from whom" = the previous owner (sender)
If a parsed "party" is actually a text fragment or modifier rather than a person/institution, report position as null with a reasoning note.
</parser_artifacts>
</background>

<artwork>
Object number: ${record.objectNumber} (artwork_id: ${record.artworkId})
</artwork>

<raw_provenance>
${record.provenanceText}
</raw_provenance>

<all_events>
${eventsXml}
</all_events>

<events_needing_enrichment>
${needsWorkXml}
</events_needing_enrichment>

<examples>
<example>
<context>Bare-name event with no transfer verb</context>
<event sequence="3" transfer_type="collection" transfer_category="null">
  <raw_text>? Pieter van Ruijven (1624-1674), Delft</raw_text>
  <party idx="0" name="Pieter van Ruijven" role="null" position="null" />
</event>
<enrichment>
  <party_update idx="0" position="receiver" confidence="0.90" reasoning="AAM bare-name convention: named party with life dates is the holder/owner. No transfer verb — the party is the receiver (current possessor)." />
</enrichment>
</example>

<example>
<context>Sale with "whose sale" — anaphoric reference to previous owner as consignor</context>
<event sequence="5" transfer_type="sale" transfer_category="ownership">
  <raw_text>whose sale, London (Sotheby's, private treaty), €750,000, to the Rijksmuseum Fonds, 2011</raw_text>
  <party idx="0" name="whose sale" role="null" position="null" />
  <party idx="1" name="Rijksmuseum Fonds" role="buyer" position="receiver" />
</event>
<enrichment>
  <party_update idx="0" position="sender" confidence="0.95" reasoning="'whose sale' is an anaphoric reference: 'whose' refers back to the previous event's party, who is consigning the artwork for sale. The consignor is the sender." />
</enrichment>
</example>

<example>
<context>Sale with dealer acting as agent — "on behalf of"</context>
<event sequence="4" transfer_type="sale" transfer_category="ownership">
  <raw_text>from the dealer J. Goudstikker, Amsterdam, on behalf of Julius vom Rath</raw_text>
  <party idx="0" name="J. Goudstikker" role="null" position="null" />
  <party idx="1" name="Julius vom Rath" role="buyer" position="receiver" />
</event>
<enrichment>
  <party_update idx="0" position="agent" confidence="0.90" reasoning="'on behalf of' signals that Goudstikker is facilitating the purchase for vom Rath, not acquiring the artwork himself. The dealer is the agent; vom Rath is the receiver." />
</enrichment>
</example>

<example>
<context>Administrative transfer — "transferred to the museum" (ambiguous category)</context>
<event sequence="7" transfer_type="transfer" transfer_category="ambiguous">
  <raw_text>{Note RMA.} transferred to the museum, 1960</raw_text>
  <party idx="0" name="the museum" role="recipient" position="receiver" />
</event>
<enrichment>
  <category_update category="ownership" confidence="0.85" reasoning="'Transferred to the museum' in Rijksmuseum provenance is a permanent institutional acquisition, not temporary custody. The phrasing mirrors 'accessioned by' — this is an ownership transfer." />
</enrichment>
</example>

<example>
<context>Parser artifact — "post-auction sale" is not a party</context>
<event sequence="16" transfer_type="sale" transfer_category="ownership">
  <raw_text>post-auction sale, with BK-2013-9-1 to -4, $80,000, to the museum</raw_text>
  <party idx="0" name="post-auction sale" role="null" position="null" />
  <party idx="1" name="museum" role="buyer" position="receiver" />
</event>
<enrichment>
  <party_update idx="0" position="null" confidence="0.95" reasoning="'post-auction sale' is a sale modifier, not a person or institution. This is a parser artifact — no position can be assigned because it is not a party." />
</enrichment>
</example>

<example>
<context>Genuinely ambiguous — bare location name, no context</context>
<event sequence="1" transfer_type="gift" transfer_category="ownership">
  <raw_text>Zierikzee</raw_text>
  <party idx="0" name="Zierikzee" role="null" position="null" />
</event>
<enrichment>
  <party_update idx="0" position="null" confidence="0.40" reasoning="'Zierikzee' is a city name. Without further context, it is unclear whether this refers to a person from Zierikzee, the town of Zierikzee (donor), or a location note. Genuinely ambiguous — skip." />
</enrichment>
</example>
</examples>

<task>
For EACH event in events_needing_enrichment, provide enrichments:

1. **Party positions** — for each party with position="null", classify as sender, receiver, or agent. If the parsed "party" is a text fragment or modifier (not a real person/institution), report position as null with an explanation.

2. **Transfer category** — for events with transfer_category="ambiguous", classify as ownership or custody.

Use the full provenance chain for context. The events before and after help determine direction: in AAM notation, the chain flows chronologically, so each event's party typically received the artwork from the previous event's party.

Confidence calibration:
- ≥ 0.9 — keyword or AAM convention makes it unambiguous ("whose sale" = sender)
- 0.7–0.9 — clear from chain context but not explicitly stated
- 0.5–0.7 — requires interpretation or world knowledge
- < 0.5 — genuinely ambiguous, multiple valid readings exist

Only report enrichments where you have confidence ≥ 0.5. Skip events where ambiguity is irreducible.

Use the report_position_enrichment tool to submit your classifications.
</task>`;
}

function buildPromptStructuralSignals(record) {
  const unknownEvents = record.events.filter(
    e => e.transfer_type === "unknown" && !e.is_cross_ref
  );

  return `<role>You are a computational linguist analysing provenance text segments that a parser could not classify. Your task is NOT to identify keywords — a previous analysis already found all keyword-based patterns. Instead, you are looking for STRUCTURAL signals: patterns in the text's form, formatting, or composition that could enable deterministic classification without world knowledge.</role>

<background>
<aam_standard>
In AAM (American Alliance of Museums) provenance notation, a bare name with optional dates and location — e.g., "Frits Lugt (1884-1970), Paris" — is a valid entry meaning "held by this person." The parser classifies these as "unknown" because no transfer keyword is present. But many of these segments contain structural signals beyond the bare name that could help classify them.
</aam_standard>

<structural_signals>
We are looking for these categories of deterministic signal:

1. **life_dates** — "(YYYY-YYYY)" pattern indicates a person → likely "collection" (personal ownership)
2. **noble_title** — "Baron", "Jonkheer", "Jonkvrouw", "Count", "Countess", "Graaf", "Gravin", "Lord", "Prince", "Princess", "Duke", "Marquis", "Sir", "Lady" preceding a name → person, likely "collection"
3. **academic_title** — "Dr", "Prof.", "Mr" (Dutch honorific), "Mrs" preceding a name → person, likely "collection"
4. **institution_name** — words like "museum", "church", "kerk", "chapel", "kapel", "cathedral", "monastery", "klooster", "gallery", "galerie", "society", "vereniging", "genootschap", "stichting", "foundation", "ministry", "ministerie", "cabinet", "kabinet", "palace", "paleis", "castle", "kasteel", "town hall", "stadhuis" → institution, likely "collection" or "loan"
5. **lugt_mark** — "(L. NNNN)" or "(Lugt NNNN)" — collector's stamp reference → definitely "collection"
6. **city_location** — a known city name (Amsterdam, Paris, London, etc.) present as the only content after the name → supports "collection" classification
7. **dutch_phrase** — Dutch-language provenance text not yet handled by the parser
8. **french_phrase** — French-language provenance text not yet handled
9. **dealer_indicator** — "dealer", "gallery", "Galerie", "handel", "kunsthandel" in the name → dealer holding, likely "collection" with dealer role
10. **auction_house** — known auction house name (Christie's, Sotheby's, Bonhams, etc.) → likely "sale"
11. **collection_mark** — any collector's mark reference beyond Lugt
12. **date_only** — standalone date or date range with no party name → fragment
13. **cross_ref_fragment** — reference to another artwork (object number pattern like "SK-A-NNNN")
14. **citation_leak** — bibliographic text (author names, page numbers, journal titles) that leaked out of {curly braces}
</structural_signals>
</background>

<artwork>
Object number: ${record.objectNumber} (artwork_id: ${record.artworkId})
</artwork>

<raw_provenance>
${record.provenanceText}
</raw_provenance>

<unknown_segments>
${unknownEvents.map(e => `<segment sequence="${e.sequence}">${e.raw_text}</segment>`).join("\n")}
</unknown_segments>

<examples>
<example>
<segment>"Jonkheer Pieter Hendrik Six (1827-1905), Lord of Vromade, Amsterdam"</segment>
<analysis>
- signal: noble_title — "Jonkheer" (evidence: "Jonkheer", deterministic: true)
- signal: life_dates — "(1827-1905)" (evidence: "(1827-1905)", deterministic: true)
- signal: noble_title — "Lord" (evidence: "Lord of Vromade", deterministic: true)
- signal: city_location — "Amsterdam" (evidence: "Amsterdam", deterministic: true)
- recommended_type: collection (confidence: 0.95)
- reasoning: Multiple strong structural signals (noble title + life dates + city) make this unambiguously a person holding the artwork.
</analysis>
</example>

<example>
<segment>"Mauritshuis, The Hague, 1876"</segment>
<analysis>
- signal: institution_name — "Mauritshuis" (evidence: "Mauritshuis", deterministic: false — requires knowing this is a museum)
- signal: city_location — "The Hague" (evidence: "The Hague", deterministic: true)
- recommended_type: collection (confidence: 0.70)
- reasoning: City location is structural; institution name recognition requires a curated list. If Mauritshuis were in an institution list, confidence would be 0.95.
</analysis>
</example>

<example>
<segment>"F. Scholten, 'The Larson Family of Statuary Founders', _Simiolus_ 31 (2004-05), pp. 54-89"</segment>
<analysis>
- signal: citation_leak — journal reference (evidence: "_Simiolus_ 31 (2004-05), pp. 54-89", deterministic: true)
- recommended_type: non_provenance (confidence: 0.95)
- reasoning: Journal title in italics, volume number, page range — unmistakably a bibliographic citation that should have been inside {curly braces}.
</analysis>
</example>

<example>
<segment>"collection William Pitcairn Knowles (1820-94), Rotterdam and Wiesbaden (L. 2643)"</segment>
<analysis>
- signal: lugt_mark — "(L. 2643)" (evidence: "(L. 2643)", deterministic: true)
- signal: life_dates — "(1820-94)" (evidence: "(1820-94)", deterministic: true)
- recommended_type: collection (confidence: 0.95)
- reasoning: Lugt mark is a definitive collector signal.
</analysis>
</example>
</examples>

<task>
For EACH unknown segment, identify ALL structural signals present. For each signal, report:
- The signal type (from the list above)
- The specific evidence text
- What transfer type it implies
- Whether a parser rule could detect it deterministically (without world knowledge)

Then give your overall recommended transfer type and confidence.

Focus on what's STRUCTURALLY detectable. "Baron van Swieten" has a noble title (structural). "Goudstikker" being a dealer requires world knowledge (not structural). A word like "Galerie" in a name IS structural.

Use the report_structural_signals tool to submit your analysis.
</task>`;
}

function aggregateStructuralSignals(results) {
  const signalCounts = {};
  const signalDeterministic = {};
  const recommendedTypes = {};
  let totalSegments = 0;
  let segmentsWithSignals = 0;
  const allSegments = [];

  for (const r of results) {
    if (r.error || !r.data?.segments) continue;
    for (const seg of r.data.segments) {
      totalSegments++;
      const signals = seg.signals || [];
      if (signals.length > 0) segmentsWithSignals++;
      for (const s of signals) {
        signalCounts[s.signal_type] = (signalCounts[s.signal_type] || 0) + 1;
        if (s.deterministic) {
          signalDeterministic[s.signal_type] = (signalDeterministic[s.signal_type] || 0) + 1;
        }
      }
      recommendedTypes[seg.recommended_type] = (recommendedTypes[seg.recommended_type] || 0) + 1;
      allSegments.push({
        objectNumber: r.data.object_number,
        sequence: seg.event_sequence,
        rawText: (seg.raw_text || "").slice(0, 80),
        signals: signals.map(s => s.signal_type),
        deterministic: signals.filter(s => s.deterministic).map(s => s.signal_type),
        recommendedType: seg.recommended_type,
        confidence: seg.confidence,
      });
    }
  }

  return { totalSegments, segmentsWithSignals, signalCounts, signalDeterministic, recommendedTypes, allSegments };
}

function printStructuralSignalsReport(report) {
  console.log(`\n## Structural Signals (${report.totalSegments} segments)\n`);
  console.log(`| Metric | Value |`);
  console.log(`|--------|-------|`);
  console.log(`| Segments with ≥1 signal | ${report.segmentsWithSignals} (${(100 * report.segmentsWithSignals / Math.max(report.totalSegments, 1)).toFixed(1)}%) |`);
  console.log(`| Segments with no signals | ${report.totalSegments - report.segmentsWithSignals} |`);

  console.log(`\n### Signal frequency\n`);
  console.log(`| Signal type | Total | Deterministic | % deterministic |`);
  console.log(`|-------------|-------|---------------|-----------------|`);
  for (const [type, count] of Object.entries(report.signalCounts).sort((a, b) => b[1] - a[1])) {
    const det = report.signalDeterministic[type] || 0;
    console.log(`| ${type} | ${count} | ${det} | ${(100 * det / Math.max(count, 1)).toFixed(0)}% |`);
  }

  console.log(`\n### Recommended type distribution\n`);
  console.log(`| Type | Count | % |`);
  console.log(`|------|-------|---|`);
  for (const [type, count] of Object.entries(report.recommendedTypes).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${type} | ${count} | ${(100 * count / Math.max(report.totalSegments, 1)).toFixed(1)}% |`);
  }

  // High-confidence reclassifiable
  const reclassifiable = report.allSegments.filter(s => s.confidence >= 0.8 && s.recommendedType !== "unknown");
  console.log(`\n### Reclassifiable with high confidence (≥0.8): ${reclassifiable.length} segments\n`);
  const byType = {};
  for (const s of reclassifiable) {
    byType[s.recommendedType] = (byType[s.recommendedType] || 0) + 1;
  }
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`- **${type}**: ${count}`);
  }

  console.log(`\n### Sample segments with strong signals\n`);
  const highConf = report.allSegments.filter(s => s.confidence >= 0.8 && s.deterministic.length > 0).slice(0, 10);
  for (const s of highConf) {
    console.log(`- **${s.objectNumber}** seq ${s.sequence}: "${s.rawText}" → ${s.recommendedType} (${(s.confidence * 100).toFixed(0)}%)`);
    console.log(`  signals: ${s.deterministic.join(", ")}`);
  }
}

function buildPromptTypeClassification(record) {
  const UNSOLD_RE = /\b(?:unsold|bought\s+in|withdrawn|invendu|ingetrokken)\b/i;
  const unknownEvents = record.events.filter(
    e => e.transfer_type === "unknown" && !e.is_cross_ref && !UNSOLD_RE.test(e.raw_text)
  );

  const eventsJson = unknownEvents.map(e => ({
    sequence: e.sequence,
    rawText: e.raw_text,
    parties: safeJson(e.parties),
  }));

  return `<role>You are a provenance researcher classifying individual ownership events from a Rijksmuseum artwork. A parser has already handled all keyword-based and structurally-detectable patterns. These remaining events could not be classified by any rule. Your job is to classify each one based on your understanding of the text, the provenance chain context, and art-historical knowledge.</role>

<background>
<aam_standard>
The provenance text follows the AAM (American Alliance of Museums, 2001) convention:
- Semicolons (;) separate events in chronological order (earliest → present)
- Question mark (?) prefix marks uncertain attribution
- Curly braces ({…}) enclose bibliographic citations
- A bare name with optional dates and location implies the person/institution held the artwork
</aam_standard>

<transfer_types>
Available transfer types (CMOA-aligned vocabulary):
- **collection** — person or institution held the artwork (bare-name AAM convention)
- **sale** — sold (includes auction purchases)
- **by_descent** — inherited by a family member (son, daughter, nephew, cousin, etc.)
- **widowhood** — inherited by surviving spouse
- **inheritance** — generic inheritance (relationship unknown)
- **bequest** — given through a will after death
- **gift** — given voluntarily
- **commission** — commissioned by the named party
- **loan** — temporary custody (on loan, on display, on lease)
- **deposit** — temporary storage
- **transfer** — administrative/institutional transfer
- **confiscation** — legally seized by authority
- **theft** — stolen
- **looting** — looted during conflict
- **recuperation** — recovered by government after war/theft
- **restitution** — legally returned to rightful owner
- **exchange** — traded for another object
- **inventory** — documentation/attestation of existing ownership (not a transfer)
- **non_provenance** — text that is not a provenance event (citation leak, object description, editorial note)
- **unknown** — genuinely unclassifiable even with context
</transfer_types>
</background>

<artwork>
Object number: ${record.objectNumber} (artwork_id: ${record.artworkId})
</artwork>

<raw_provenance>
${record.provenanceText}
</raw_provenance>

<events_to_classify>
${eventsJson.map(e => `<event sequence="${e.sequence}">
  <raw_text>${e.rawText}</raw_text>
  <parties>${JSON.stringify(e.parties)}</parties>
</event>`).join("\n")}
</events_to_classify>

<examples>
<example>
<event>"Kvovinsky, St Petersburg, c. 1850"</event>
<classification>
- transfer_type: collection
- transfer_category: ownership
- confidence: 0.85
- reasoning: Bare name with city and approximate date — AAM convention for a collector/owner holding the artwork.
</classification>
</example>

<example>
<event>"from Bouasse-Lebel to Paul Mallon"</event>
<classification>
- transfer_type: sale
- transfer_category: ownership
- confidence: 0.80
- reasoning: "from X to Y" pattern indicates a directed transfer. Without further context (no price, no "gift"/"donated"), sale is the most likely interpretation for a commercial transfer between parties.
</classification>
</example>

<example>
<event>"{Note RMA.} (inv. no. SK-C-1404)"</event>
<classification>
- transfer_type: non_provenance
- transfer_category: ambiguous
- confidence: 0.95
- reasoning: This is an inventory number cross-reference, not a provenance event. The citation and inventory number are administrative metadata.
</classification>
</example>

<example>
<event>"the Mechelen friary was suppressed in 1796"</event>
<classification>
- transfer_type: confiscation
- transfer_category: ownership
- confidence: 0.85
- reasoning: "Suppressed" in the context of a religious institution means dissolved by state authority (typically French Revolutionary/Napoleonic confiscation). The artwork would have been seized as state property.
</classification>
</example>
</examples>

<task>
For EACH event above, classify the transfer type. Use the full provenance chain for context — the events before and after can help determine what happened.

Most of these will be "collection" (bare names) but look carefully — some contain contextual clues that suggest a specific transfer type. If genuinely unclassifiable even with art-historical knowledge, use "unknown".

Use the report_type_classification tool to submit your classifications.
</task>`;
}

function aggregateTypeClassification(results) {
  const typeDist = {};
  const categoryDist = {};
  let totalClassified = 0;
  let highConfidence = 0;
  const allClassifications = [];

  for (const r of results) {
    if (r.error || !r.data?.classifications) continue;
    for (const c of r.data.classifications) {
      totalClassified++;
      typeDist[c.transfer_type] = (typeDist[c.transfer_type] || 0) + 1;
      categoryDist[c.transfer_category] = (categoryDist[c.transfer_category] || 0) + 1;
      if (c.confidence >= 0.8) highConfidence++;
      allClassifications.push({
        objectNumber: r.data.object_number,
        sequence: c.event_sequence,
        rawText: (c.raw_text || "").slice(0, 80),
        type: c.transfer_type,
        category: c.transfer_category,
        confidence: c.confidence,
        reasoning: c.reasoning,
      });
    }
  }

  return { totalClassified, highConfidence, typeDist, categoryDist, allClassifications };
}

function printTypeClassificationReport(report) {
  console.log(`\n## Type Classification (${report.totalClassified} events)\n`);
  console.log(`| Metric | Value |`);
  console.log(`|--------|-------|`);
  console.log(`| Total classified | ${report.totalClassified} |`);
  console.log(`| High confidence (≥0.8) | ${report.highConfidence} (${(100 * report.highConfidence / Math.max(report.totalClassified, 1)).toFixed(0)}%) |`);

  console.log(`\n### Transfer type distribution\n`);
  console.log(`| Type | Count | % |`);
  console.log(`|------|-------|---|`);
  for (const [type, count] of Object.entries(report.typeDist).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${type} | ${count} | ${(100 * count / Math.max(report.totalClassified, 1)).toFixed(1)}% |`);
  }

  console.log(`\n### Transfer category distribution\n`);
  console.log(`| Category | Count |`);
  console.log(`|----------|-------|`);
  for (const [cat, count] of Object.entries(report.categoryDist).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${cat} | ${count} |`);
  }

  console.log(`\n### Sample classifications\n`);
  for (const c of report.allClassifications.slice(0, 15)) {
    console.log(`- **${c.objectNumber}** seq ${c.sequence}: "${c.rawText}" → **${c.type}** (${(c.confidence * 100).toFixed(0)}%)`);
    console.log(`  _${c.reasoning}_`);
  }
}

// ─── Forced sale ────────────────────────────────────────────────────

function sampleForcedSale() {
  const db = openDb();
  let artworkIds;

  if (recordsList) {
    const objectNumbers = recordsList.split(",").map(s => s.trim());
    artworkIds = db.prepare(
      `SELECT art_id FROM artworks WHERE object_number IN (${objectNumbers.map(() => "?").join(",")})`
    ).all(...objectNumbers).map(r => r.art_id);
  } else {
    // All artworks with sale events dated 1933–1945
    artworkIds = db.prepare(`
      SELECT DISTINCT artwork_id FROM provenance_events
      WHERE transfer_type = 'sale' AND date_year BETWEEN 1933 AND 1945
        AND is_cross_ref = 0
      ORDER BY RANDOM() LIMIT ?
    `).all(sampleSize).map(r => r.artwork_id);
  }
  return fetchRecords(artworkIds, { periods: false });
}

const TOOL_FORCED_SALE = {
  name: "report_forced_sale_classification",
  description: "Classify wartime sale events as forced_sale or voluntary sale",
  input_schema: {
    type: "object",
    properties: {
      artwork_id: { type: "integer" },
      object_number: { type: "string" },
      classifications: {
        type: "array",
        items: {
          type: "object",
          properties: {
            event_sequence: { type: "integer" },
            classification: {
              type: "string",
              enum: ["forced_sale", "sale", "insufficient_evidence"],
              description: "forced_sale: involuntary sale under persecution/duress; sale: voluntary transaction; insufficient_evidence: cannot determine from available text",
            },
            confidence: { type: "number", description: "0.0-1.0" },
            indicators: {
              type: "array",
              items: { type: "string" },
              description: "Specific evidence supporting the classification (e.g., 'buyer is Nazi apparatus', 'seller is known persecuted party', 'followed by war recuperation')",
            },
            reasoning: { type: "string", description: "Explanation of how indicators combine to support the classification" },
          },
          required: ["event_sequence", "classification", "confidence", "indicators", "reasoning"],
        },
      },
    },
    required: ["artwork_id", "object_number", "classifications"],
  },
};

function buildPromptForcedSale(record) {
  const eventsXml = record.events
    .filter(e => !e.is_cross_ref)
    .map(e => {
      const parties = safeJson(e.parties) || [];
      const partiesXml = parties.map((p, i) =>
        `      <party idx="${i}" name="${esc(p.name || "")}" role="${p.role ?? "null"}" position="${p.position ?? "null"}" />`
      ).join("\n");
      return `    <event sequence="${e.sequence}" transfer_type="${e.transfer_type}" date_year="${e.date_year ?? "null"}" transfer_category="${e.transfer_category ?? "null"}">
      <raw_text>${esc(e.raw_text)}</raw_text>
${partiesXml}
    </event>`;
    }).join("\n");

  // Identify sale events in the 1933–1945 window
  const targetEvents = record.events.filter(
    e => e.transfer_type === "sale" && e.date_year >= 1933 && e.date_year <= 1945 && !e.is_cross_ref
  );
  const targetsXml = targetEvents.map(e =>
    `    <target sequence="${e.sequence}" date_year="${e.date_year}">${esc((e.raw_text || "").slice(0, 150))}</target>`
  ).join("\n");

  // Contextual signals: does the chain include recuperation?
  const hasRecuperation = record.events.some(e => e.transfer_type === "recuperation");

  return `<role>You are a provenance researcher specializing in Nazi-era forced transactions. You are classifying individual sale events from a Rijksmuseum artwork's provenance chain to determine whether they represent forced sales (involuntary transactions under persecution or duress) or voluntary sales.</role>

<background>
<historical_context>
Between 1933 and 1945, the Nazi regime and its collaborators systematically looted, confiscated, and coerced the sale of art from Jewish collectors, dealers, and other persecuted groups across Europe. The Netherlands was occupied from May 1940 to May 1945. Key phases:
- **1933–1939 (pre-occupation):** Jewish collectors in Germany and Austria fled or were forced to liquidate. Some sold through Dutch dealers.
- **1940–1945 (occupation):** Direct confiscation by Nazi agencies (Dienststelle Mühlmann, ERR), forced sales by Jewish owners under anti-Jewish decrees, and purchases by Nazi officials (Göring, Posse/Führermuseum) and collaborating dealers.
- **1945+ (post-war):** War recuperation by the Stichting Nederlands Kunstbezit (SNK), restitution proceedings.
</historical_context>

<cmoa_definition>
The CMOA (Carnegie Museum of Art) Art Tracks thesaurus defines **Forced Sale** as:
> "This object was purchased by the named party using involuntary pressure on the seller."

A forced sale is a subcategory of **Sale** (not Confiscation) — it involves an exchange of value (money changed hands), but the seller acted under duress, persecution, or coercion. This distinguishes it from:
- **Confiscation** — no exchange of value; legally seized by state authority
- **Theft/Looting** — no exchange of value; illegally taken
- **Voluntary sale** — seller acted freely, without external pressure
</cmoa_definition>

<indicators_forced>
Strong indicators of a forced sale:
1. **Nazi apparatus buyer:** Dienststelle Mühlmann, Hans Posse (Führermuseum/Linz), Hermann Göring, Erhard Göpel, Walter Andreas Hofer, Karl Haberstock, Alois Miedl, or other known Nazi art agents
2. **Persecuted seller:** Known Jewish collector/dealer selling during 1933–1945, especially after occupation (1940). Key names in Rijksmuseum provenance: Fritz Mannheimer, Jacques Goudstikker, Nathan Katz, Adolphe Schloss, Gutmann family, Rothschild family, Lippmann-Rosenthal (Nazi-controlled looting bank)
3. **"En bloc" liquidation:** Entire collections sold at once, often at below-market prices — characteristic of forced liquidation
4. **Followed by recuperation:** A post-war "war recuperation, SNK" event strongly suggests the preceding sale was involuntary
5. **Estate of persecuted party:** "purchased from his/the estate" of a person who died during persecution
6. **Nazi-era keywords:** Feindvermögen (enemy property), Sichergestellt (secured/seized), Verwalter (administrator), Treuhänder (trustee), Beauftragter (commissioner)
7. **Below-market pricing combined with wartime date and persecuted seller**
</indicators_forced>

<indicators_voluntary>
Indicators of a voluntary sale:
1. **Museum as buyer, artist as seller:** "from the artist, fl. X, to the museum" — direct purchase from a living artist
2. **Known non-persecuted seller:** Dutch institutional sellers, auction houses operating normally, established dealers without known persecution history
3. **Normal auction process:** Standard public auction with catalogue numbers, normal-looking prices, no subsequent recuperation
4. **Pre-1940 Netherlands:** Before German occupation, Dutch sales were generally voluntary (though German/Austrian refugees may have been selling under duress from 1933)
5. **No recuperation in the chain:** Absence of post-war SNK recuperation suggests the transaction was not considered problematic
</indicators_voluntary>

<important_nuance>
Not all wartime sales are forced sales. The Rijksmuseum actively purchased art throughout the war years, often from dealers, artists, and estates in normal transactions. The presence of a 1940–1945 date alone is NOT sufficient to classify as forced_sale.

Conversely, some sales before 1940 — particularly by German Jewish collectors fleeing Nazi Germany (1933–1939) — may be forced sales even though they occurred in the Netherlands before occupation.

When evidence is ambiguous, use "insufficient_evidence" rather than guessing. The classification has legal and ethical implications for restitution claims.
</important_nuance>
</background>

<artwork>
Object number: ${record.objectNumber} (artwork_id: ${record.artworkId})
Chain has recuperation event: ${hasRecuperation ? "YES" : "no"}
</artwork>

<full_provenance_chain>
${eventsXml}
</full_provenance_chain>

<events_to_classify>
${targetsXml}
</events_to_classify>

<examples>
<example>
<context>Sale to Nazi Führermuseum buyer, followed by war recuperation</context>
<event sequence="4" date_year="1940">from whom, fl. 30,000, to Hans Posse (1879-1942), for Adolf Hitler's Führermuseum, Linz, 7 September 1940</event>
<classification>
  classification: forced_sale
  confidence: 0.95
  indicators: ["buyer is Hans Posse purchasing for Hitler's Führermuseum", "date during Dutch occupation (1940)", "followed by war recuperation SNK 1945"]
  reasoning: Hans Posse was Hitler's chief art agent, acquiring works for the planned Führermuseum in Linz. The seller (a dealer consigned by an unknown collector) was operating under occupation conditions. The subsequent war recuperation by SNK confirms this was treated as an involuntary wartime transaction.
</classification>
</example>

<example>
<context>En bloc estate purchase by Dienststelle Mühlmann</context>
<event sequence="3" date_year="1940">purchased from his estate, en bloc, by the Dienststelle Mühlmann, The Hague, for Adolf Hitler's Führermuseum, Linz, 1940</event>
<classification>
  classification: forced_sale
  confidence: 0.95
  indicators: ["buyer is Dienststelle Mühlmann (Nazi art confiscation agency)", "en bloc estate purchase", "Fritz Mannheimer was a Jewish banker who died 1939", "followed by war recuperation"]
  reasoning: The Dienststelle Mühlmann was the Nazi agency responsible for art acquisition in the Netherlands, operating under Seyss-Inquart. The "purchase" from Mannheimer's estate was conducted under occupation authority — the estate had no real choice. The en bloc nature and subsequent recuperation confirm forced character.
</classification>
</example>

<example>
<context>Normal museum purchase from an artist during wartime</context>
<event sequence="5" date_year="1943">From the artist, fl. 20, to the museum, 1943</event>
<classification>
  classification: sale
  confidence: 0.90
  indicators: ["seller is the artist (not persecuted group)", "buyer is the Rijksmuseum (not Nazi apparatus)", "direct artist-to-museum sale", "no recuperation in chain"]
  reasoning: A direct purchase from a living artist by the museum at a modest price. No indicators of duress — the artist is selling their own work voluntarily. The absence of any subsequent recuperation or restitution confirms this was a normal acquisition.
</classification>
</example>

<example>
<context>Standard auction sale, non-persecuted estate</context>
<event sequence="3" date_year="1937">sale, A.W.M. Mensing (1866-1936, Amsterdam), Amsterdam (F. Muller), 27 April 1937 sqq., no. 869, fl. 210, with 44 other drawings, to the museum</event>
<classification>
  classification: sale
  confidence: 0.85
  indicators: ["standard public auction (F. Muller)", "seller died 1936 (pre-occupation)", "museum as buyer", "no recuperation in chain", "Mensing was a Dutch collector, not in persecuted category"]
  reasoning: A.W.M. Mensing was a major Dutch art collector who died in 1936, before the German occupation. His estate sale at Frederik Muller was a normal posthumous auction. The museum purchased at public auction at normal prices. No indicators of duress.
</classification>
</example>

<example>
<context>Ambiguous — wartime sale with insufficient context</context>
<event sequence="2" date_year="1943">acquired by Hubert W. Krantz (d. 1963), Aachen, 1943</event>
<classification>
  classification: insufficient_evidence
  confidence: 0.60
  indicators: ["buyer is in Aachen (Germany)", "date is 1943 (wartime)", "no information about seller or circumstances", "no recuperation in chain"]
  reasoning: The bare acquisition note provides no information about who sold the artwork or under what circumstances. While the wartime date and German buyer raise questions, there is no evidence of a specific persecuted seller or Nazi involvement. Without more context, this cannot be classified as either forced or voluntary with confidence.
</classification>
</example>
</examples>

<task>
For EACH sale event in events_to_classify, determine whether it was a forced sale, a voluntary sale, or has insufficient evidence to classify.

Consider the FULL provenance chain — events before and after the sale provide critical context:
- A recuperation event after the sale strongly suggests it was forced
- The identity of the seller (previous event's party) matters: was this person/entity likely persecuted?
- The identity of the buyer matters: was this a Nazi agency, official, or known collaborator?
- En bloc sales of entire collections during wartime are suspicious

Be conservative: if there is no clear evidence of duress, classify as "sale". Only use "forced_sale" when there are concrete indicators. Use "insufficient_evidence" when the text is too sparse to determine either way but the context raises questions.

Use the report_forced_sale_classification tool to submit your classifications.
</task>`;
}

function esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function aggregateForcedSale(results) {
  const classDist = {};
  let total = 0;
  let highConf = 0;
  const allClassifications = [];
  const indicatorFreq = {};

  for (const r of results) {
    if (r.error || !r.data?.classifications) continue;
    for (const c of r.data.classifications) {
      total++;
      classDist[c.classification] = (classDist[c.classification] || 0) + 1;
      if (c.confidence >= 0.8) highConf++;
      for (const ind of c.indicators || []) {
        indicatorFreq[ind] = (indicatorFreq[ind] || 0) + 1;
      }
      allClassifications.push({
        objectNumber: r.data.object_number,
        sequence: c.event_sequence,
        classification: c.classification,
        confidence: c.confidence,
        indicators: c.indicators || [],
        reasoning: c.reasoning,
      });
    }
  }

  return { total, highConf, classDist, indicatorFreq, allClassifications };
}

function printForcedSaleReport(report) {
  console.log(`\n## Forced Sale Classification (${report.total} events)\n`);
  console.log(`| Metric | Value |`);
  console.log(`|--------|-------|`);
  console.log(`| Total classified | ${report.total} |`);
  console.log(`| High confidence (≥0.8) | ${report.highConf} (${(100 * report.highConf / Math.max(report.total, 1)).toFixed(0)}%) |`);

  console.log(`\n### Classification distribution\n`);
  console.log(`| Classification | Count | % |`);
  console.log(`|---------------|-------|---|`);
  for (const [cls, count] of Object.entries(report.classDist).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${cls} | ${count} | ${(100 * count / Math.max(report.total, 1)).toFixed(1)}% |`);
  }

  console.log(`\n### Top indicators\n`);
  const topInd = Object.entries(report.indicatorFreq).sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [ind, count] of topInd) {
    console.log(`- ${ind} (${count})`);
  }

  console.log(`\n### Forced sale samples\n`);
  const forced = report.allClassifications.filter(c => c.classification === "forced_sale").slice(0, 10);
  for (const c of forced) {
    console.log(`- **${c.objectNumber}** seq ${c.sequence}: (${(c.confidence * 100).toFixed(0)}%) ${c.indicators.slice(0, 3).join("; ")}`);
    console.log(`  _${c.reasoning.slice(0, 150)}_`);
  }

  console.log(`\n### Voluntary sale samples\n`);
  const vol = report.allClassifications.filter(c => c.classification === "sale").slice(0, 5);
  for (const c of vol) {
    console.log(`- **${c.objectNumber}** seq ${c.sequence}: (${(c.confidence * 100).toFixed(0)}%) ${c.indicators.slice(0, 2).join("; ")}`);
  }

  console.log(`\n### Insufficient evidence samples\n`);
  const insuff = report.allClassifications.filter(c => c.classification === "insufficient_evidence").slice(0, 5);
  for (const c of insuff) {
    console.log(`- **${c.objectNumber}** seq ${c.sequence}: (${(c.confidence * 100).toFixed(0)}%) ${c.reasoning.slice(0, 100)}`);
  }
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
  "structural-signals": {
    sample: sampleUnknowns,
    tool: TOOL_STRUCTURAL_SIGNALS,
    buildPrompt: buildPromptStructuralSignals,
    aggregate: aggregateStructuralSignals,
    report: printStructuralSignalsReport,
  },
  "type-classification": {
    sample: sampleTypeClassification,
    tool: TOOL_TYPE_CLASSIFICATION,
    buildPrompt: buildPromptTypeClassification,
    aggregate: aggregateTypeClassification,
    report: printTypeClassificationReport,
  },
  "forced-sale": {
    sample: sampleForcedSale,
    tool: TOOL_FORCED_SALE,
    buildPrompt: buildPromptForcedSale,
    aggregate: aggregateForcedSale,
    report: printForcedSaleReport,
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

    // Mark state file as complete (mirrors the normal path)
    const stateFile = outputPath.replace(/\.json$/, ".state.json");
    if (existsSync(stateFile)) {
      try {
        const state = JSON.parse(readFileSync(stateFile, "utf8"));
        state.completedAt = new Date().toISOString();
        writeFileSync(stateFile, JSON.stringify(state, null, 2));
      } catch {}
    }
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
