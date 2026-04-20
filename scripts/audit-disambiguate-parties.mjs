/**
 * Re-run LLM on 213 parser-artifact parties to extract structured
 * sender/receiver/agent names from merged party text.
 *
 * Input:  data/backfills/disambig-targets.json (from position-enrichment nulls)
 * Output: data/audit-party-disambiguation-2026-03-22.json
 *
 * Usage:
 *   node scripts/audit-disambiguate-parties.mjs [--dry-run] [--db PATH]
 */

import { writeFileSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbPath = args.includes("--db") ? args[args.indexOf("--db") + 1] : "data/vocabulary.db";
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "claude-sonnet-4-20250514";
const outputPath = "data/audit-party-disambiguation-2026-03-22.json";

// ─── Load targets ───────────────────────────────────────────────────

const targets = JSON.parse(readFileSync("data/backfills/disambig-targets.json", "utf-8"));
console.log(`Party disambiguation batch`);
console.log(`  Targets:  ${targets.length} events across ${new Set(targets.map(t => t.artwork_id)).size} artworks`);
console.log(`  Model:    ${model}`);
console.log(`  Dry run:  ${dryRun}`);
console.log();

// ─── Fetch context from DB ──────────────────────────────────────────

const db = new Database(dbPath, { readonly: true });

const getProvText = db.prepare(`SELECT provenance_text FROM artworks WHERE art_id = ?`);
const getEvents = db.prepare(`
  SELECT sequence, raw_text, transfer_type, transfer_category, parties, is_cross_ref
  FROM provenance_events WHERE artwork_id = ? ORDER BY sequence
`);

function safeJson(val) {
  if (val == null) return [];
  if (typeof val === "string") { try { return JSON.parse(val); } catch { return []; } }
  return val;
}

function esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

// ─── Tool schema ────────────────────────────────────────────────────

const TOOL = {
  name: "report_party_disambiguation",
  description: "Report the correct party decomposition for a merged/artifact party name",
  input_schema: {
    type: "object",
    properties: {
      artwork_id: { type: "integer" },
      object_number: { type: "string" },
      disambiguations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            event_sequence: { type: "integer" },
            original_party_idx: { type: "integer", description: "The idx of the malformed party in the original parties array" },
            original_text: { type: "string", description: "The original merged party text" },
            action: {
              type: "string",
              enum: ["split", "rename", "delete"],
              description: "split: replace with multiple parties; rename: fix the name but keep as one party; delete: not a real party at all",
            },
            replacement_parties: {
              type: "array",
              description: "The corrected parties (for split/rename). Empty for delete.",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "The corrected party name (person or institution)" },
                  position: { type: "string", enum: ["sender", "receiver", "agent"] },
                  role_hint: { type: "string", description: "Brief role description (e.g. 'consignor', 'heir', 'dealer', 'donor')" },
                },
                required: ["name", "position"],
              },
            },
            confidence: { type: "number", description: "0.0-1.0" },
            reasoning: { type: "string" },
          },
          required: ["event_sequence", "original_party_idx", "original_text", "action", "replacement_parties", "confidence", "reasoning"],
        },
      },
    },
    required: ["artwork_id", "object_number", "disambiguations"],
  },
};

// ─── Prompt builder ─────────────────────────────────────────────────

function buildPrompt(artworkId, objectNumber, eventTargets) {
  const provRow = getProvText.get(artworkId);
  const provText = provRow?.provenance_text || "";
  const events = getEvents.all(artworkId);

  const eventsXml = events
    .filter(e => !e.is_cross_ref)
    .map(e => {
      const parties = safeJson(e.parties);
      const partiesXml = parties.map((p, i) =>
        `      <party idx="${i}" name="${esc(p.name || "")}" role="${p.role ?? "null"}" position="${p.position ?? "null"}" />`
      ).join("\n");
      return `    <event sequence="${e.sequence}" transfer_type="${e.transfer_type}" transfer_category="${e.transfer_category ?? "null"}">
      <raw_text>${esc(e.raw_text)}</raw_text>
${partiesXml}
    </event>`;
    }).join("\n");

  const targetsXml = eventTargets.map(t =>
    `    <target sequence="${t.event_sequence}" party_idx="${t.party_idx}" original_text="${esc(t.party_name)}" />`
  ).join("\n");

  return `<role>You are a provenance researcher correcting parser errors in structured provenance data. A previous analysis identified party names that are actually merged text fragments — e.g., "from his heirs to the museum" was parsed as a single party name instead of two separate parties. Your job is to decompose each flagged party into the correct individual parties with their positions.</role>

<background>
<aam_standard>
The provenance text follows the AAM (American Alliance of Museums, 2001) convention:
- Semicolons (;) separate events in chronological order (earliest → present)
- "from X to Y" = X is sender, Y is receiver
- "whose sale" / "his sale" / "or his sale" = anaphoric reference to previous owner (sender/consignor)
- "sold through X" / "on behalf of X" = X is an agent
- A bare name with dates and location = the holder (receiver)
- "{…}" encloses bibliographic citations (not provenance data)
</aam_standard>

<actions>
For each flagged party, choose one action:
- **split** — the text contains multiple parties that should be separate entries. Provide each party with name, position, and role_hint.
- **rename** — the text is one real party but the name is malformed (e.g., includes a verb prefix like "from whom" or "sold through"). Provide the corrected name.
- **delete** — the text is not a party at all (contextual preamble, sale modifier, citation leak). Provide empty replacement_parties.
</actions>

<positions>
- **sender** — relinquishing the artwork: seller, consignor, donor, lender, estate, previous owner
- **receiver** — acquiring the artwork: buyer, heir, recipient, borrower, collector, museum
- **agent** — facilitating without owning: dealer acting for someone, auction house, intermediary
</positions>
</background>

<artwork>
Object number: ${objectNumber} (artwork_id: ${artworkId})
</artwork>

<raw_provenance>
${provText}
</raw_provenance>

<all_events>
${eventsXml}
</all_events>

<flagged_parties>
${targetsXml}
</flagged_parties>

<examples>
<example>
<target sequence="4" party_idx="0" original_text="from his heirs to the museum (L. 2228)" />
<disambiguation>
  action: split
  replacement_parties:
    - name: "his heirs", position: sender, role_hint: "estate/heirs"
    - name: "the museum", position: receiver, role_hint: "acquiring institution"
  confidence: 0.95
  reasoning: "from X to Y" pattern — X is the sender (heirs of previous owner), Y is the receiver (museum).
</disambiguation>
</example>

<example>
<target sequence="5" party_idx="0" original_text="whose sale" />
<disambiguation>
  action: rename
  replacement_parties:
    - name: "[previous owner]", position: sender, role_hint: "consignor"
  confidence: 0.90
  reasoning: "whose sale" is an anaphoric reference to the previous event's party, who is consigning at auction. Rename to indicate the referent; position is sender.
</disambiguation>
</example>

<example>
<target sequence="3" party_idx="0" original_text="after closure of the Museum Nusantara in 2013" />
<disambiguation>
  action: delete
  replacement_parties: []
  confidence: 0.95
  reasoning: Contextual preamble explaining why a transfer happened, not a person or institution.
</disambiguation>
</example>

<example>
<target sequence="7" party_idx="0" original_text="sold through the dealer Weitzner" />
<disambiguation>
  action: rename
  replacement_parties:
    - name: "Weitzner", position: agent, role_hint: "dealer/intermediary"
  confidence: 0.90
  reasoning: "sold through X" means X facilitated the sale as an intermediary. The party name should be just "Weitzner"; "sold through the dealer" is a verb phrase describing the role.
</disambiguation>
</example>

<example>
<target sequence="2" party_idx="0" original_text="from the De Bosch Kemper family to the Teding van Berkhout family" />
<disambiguation>
  action: split
  replacement_parties:
    - name: "De Bosch Kemper family", position: sender, role_hint: "previous owner"
    - name: "Teding van Berkhout family", position: receiver, role_hint: "new owner"
  confidence: 0.95
  reasoning: Classic "from X to Y" pattern parsed as single party. Split into sender and receiver.
</disambiguation>
</example>
</examples>

<task>
For EACH flagged party, determine the correct decomposition. Extract real person/institution names — strip verb phrases, prepositions, and contextual text. For anaphoric references ("whose", "his", "from whom"), try to resolve the referent from the provenance chain if possible; otherwise use a bracketed placeholder like "[previous owner]".

Use the report_party_disambiguation tool to submit your results.
</task>`;
}

// ─── Group targets by artwork ───────────────────────────────────────

const byArtwork = new Map();
for (const t of targets) {
  const key = t.artwork_id;
  if (!byArtwork.has(key)) byArtwork.set(key, { artwork_id: t.artwork_id, object_number: t.object_number, events: [] });
  byArtwork.get(key).events.push(t);
}

console.log(`Grouped into ${byArtwork.size} artwork batches`);

// ─── Build batch requests ───────────────────────────────────────────

const requests = [];
let idx = 0;
for (const [artworkId, group] of byArtwork) {
  const prompt = buildPrompt(artworkId, group.object_number, group.events);
  requests.push({
    custom_id: `disambig-${idx}-${artworkId}`,
    params: {
      model,
      max_tokens: 4096,
      tools: [TOOL],
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: prompt }],
    },
  });
  idx++;
}

console.log(`Built ${requests.length} batch requests`);

if (dryRun) {
  writeFileSync(outputPath, JSON.stringify(requests.slice(0, 3), null, 2));
  console.log(`\nDry run — first 3 prompts written to ${outputPath}`);
  db.close();
  process.exit(0);
}

// ─── Submit batch ───────────────────────────────────────────────────

const client = new Anthropic();

const batch = await client.messages.batches.create({
  requests,
});

console.log(`\nBatch ID: ${batch.id}`);
console.log(`Status:   ${batch.processing_status}`);

// Save state for resume
writeFileSync(outputPath.replace(".json", ".state.json"), JSON.stringify({
  batchId: batch.id,
  mode: "party-disambiguation",
  model,
  requestCount: requests.length,
  createdAt: new Date().toISOString(),
}, null, 2));

// ─── Poll ───────────────────────────────────────────────────────────

console.log(`\nPolling for completion (30s intervals)...`);
let pollCount = 0;
while (true) {
  pollCount++;
  const status = await client.messages.batches.retrieve(batch.id);
  const counts = status.request_counts;
  const elapsed = ((pollCount - 1) * 30 / 60).toFixed(1);
  console.log(`  [poll ${pollCount}, ${elapsed}m] ${status.processing_status} — succeeded: ${counts.succeeded}, errored: ${counts.errored}, expired: ${counts.expired}, processing: ${counts.processing}`);

  if (status.processing_status === "ended") break;
  await new Promise(r => setTimeout(r, 30_000));
}

// ─── Collect results ────────────────────────────────────────────────

console.log(`\nCollecting results...`);
const results = [];
let succeeded = 0, failed = 0;
let inputTokens = 0, outputTokens = 0;

for await (const event of await client.messages.batches.results(batch.id)) {
  const customId = event.custom_id;
  const artworkId = parseInt(customId.split("-").pop(), 10);
  const group = byArtwork.get(artworkId);

  if (event.result?.type !== "succeeded") {
    failed++;
    results.push({ customId, error: event.result?.error || "unknown", data: { artwork_id: artworkId, object_number: group?.object_number } });
    continue;
  }

  succeeded++;
  const msg = event.result.message;
  inputTokens += msg.usage?.input_tokens || 0;
  outputTokens += msg.usage?.output_tokens || 0;

  // Extract tool call
  const toolBlock = msg.content?.find(b => b.type === "tool_use");
  if (toolBlock?.input) {
    results.push({ customId, data: toolBlock.input });
  } else {
    failed++;
    results.push({ customId, error: "no tool call", data: { artwork_id: artworkId, object_number: group?.object_number } });
  }
}

console.log(`  Succeeded: ${succeeded}, Failed: ${failed}`);

// ─── Estimate cost ──────────────────────────────────────────────────

const RATES = { "claude-sonnet-4-20250514": { input: 1.50, output: 7.50 } };
const rate = RATES[model] || { input: 1.50, output: 7.50 };
const cost = ((inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output).toFixed(2);

// ─── Save results ───────────────────────────────────────────────────

const output = {
  meta: {
    mode: "party-disambiguation",
    model,
    batchId: batch.id,
    requestCount: requests.length,
    successCount: succeeded,
    errorCount: failed,
    inputTokens,
    outputTokens,
    estimatedCost: cost,
    createdAt: new Date().toISOString(),
  },
  results,
};

writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`\nResults written to ${outputPath}`);

// ─── Report ─────────────────────────────────────────────────────────

const actionDist = {};
let totalDisambig = 0;
let totalReplacements = 0;

for (const r of results) {
  if (r.error) continue;
  for (const d of r.data.disambiguations || []) {
    totalDisambig++;
    actionDist[d.action] = (actionDist[d.action] || 0) + 1;
    totalReplacements += (d.replacement_parties || []).length;
  }
}

console.log(`\n${"═".repeat(60)}`);
console.log(`\n## Party Disambiguation (${totalDisambig} events)\n`);
console.log(`| Action | Count |`);
console.log(`|--------|-------|`);
for (const [action, count] of Object.entries(actionDist).sort((a, b) => b[1] - a[1])) {
  console.log(`| ${action} | ${count} |`);
}
console.log(`\n| Metric | Value |`);
console.log(`|--------|-------|`);
console.log(`| Total replacement parties | ${totalReplacements} |`);
console.log(`| Input tokens | ${inputTokens.toLocaleString()} |`);
console.log(`| Output tokens | ${outputTokens.toLocaleString()} |`);
console.log(`| Estimated cost | $${cost} |`);

// Show samples
console.log(`\n### Samples\n`);
let shown = 0;
for (const r of results) {
  if (r.error) continue;
  for (const d of r.data.disambiguations || []) {
    if (shown >= 10) break;
    const parties = (d.replacement_parties || []).map(p => `${p.name} [${p.position}]`).join(" + ");
    console.log(`- **${r.data.object_number}** seq ${d.event_sequence}: "${(d.original_text || "").slice(0, 60)}" → ${d.action}: ${parties || "(deleted)"} (${(d.confidence * 100).toFixed(0)}%)`);
    shown++;
  }
  if (shown >= 10) break;
}

db.close();
