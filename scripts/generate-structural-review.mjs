/**
 * Generate an HTML review page for LLM structural corrections.
 *
 * Reads one or more audit JSON files and generates a single-page HTML
 * with grouped sections for field corrections, event reclassifications,
 * and event splits.
 *
 * Usage:
 *   node scripts/generate-structural-review.mjs [options]
 *
 * Options:
 *   --field-correction PATH     Audit JSON for field corrections
 *   --event-reclassification PATH  Audit JSON for event reclassifications
 *   --event-splitting PATH      Audit JSON for event splits
 *   --output PATH               Output HTML file (default: data/structural-correction-review.html)
 */

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
function opt(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const fieldPath = opt("--field-correction");
const reclassPath = opt("--event-reclassification");
const splitPath = opt("--event-splitting");
const outputPath = opt("--output") || "data/structural-correction-review.html";

function safeLoad(path) {
  if (!path) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

const fieldData = safeLoad(fieldPath);
const reclassData = safeLoad(reclassPath);
const splitData = safeLoad(splitPath);

function esc(s) {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function confClass(c) {
  if (c >= 0.9) return "conf-high";
  if (c >= 0.8) return "conf-good";
  if (c >= 0.7) return "conf-ok";
  return "conf-low";
}

const ISSUE_LABELS = {
  truncated_location: "Multi-city location truncated",
  wrong_location: "Wrong location (party residence)",
  missing_receiver: "Missing receiver party",
  phantom_event: "Bibliographic phantom event",
  location_as_event: "Location label as event",
  alternative_acquisition: "Alternative acquisition",
  multi_transfer: "Multi-transfer merge",
  bequest_chain: "Bequest chain",
  gap_bridge: "Gap-bridging chain",
  catalogue_fragment: "Catalogue fragment",
};

// ─── Extract cards from audit JSON ──────────────────────────────────

function extractCards(data, key) {
  if (!data) return [];
  const cards = [];
  for (const result of data.results) {
    if (result.error || !result.data?.[key]) continue;
    for (const item of result.data[key]) {
      cards.push({ objectNumber: result.data.object_number, artworkId: result.data.artwork_id, ...item });
    }
  }
  return cards;
}

const fieldCards = extractCards(fieldData, "corrections");
const reclassCards = extractCards(reclassData, "reclassifications");
const splitCards = extractCards(splitData, "splits");

const totalItems = fieldCards.length + reclassCards.length + splitCards.length;

// ─── Build HTML ─────────────────────────────────────────────────────

function renderFieldCard(c, idx) {
  const issueLabel = ISSUE_LABELS[c.issue_type] || c.issue_type;
  const badge = c.issue_type === "missing_receiver"
    ? '<span class="badge badge-green">+party</span>'
    : '<span class="badge badge-blue">location</span>';

  const newPartyHtml = c.new_party
    ? `<div class="detail"><strong>New party:</strong> ${esc(c.new_party.name)} (${esc(c.new_party.position)}${c.new_party.role ? `, ${esc(c.new_party.role)}` : ""})</div>`
    : "";

  return `<div class="card" id="fc-${idx}">
  <div class="card-header">
    <div><strong>${esc(c.objectNumber)}</strong> seq ${c.event_sequence} ${badge}</div>
    <span class="badge ${confClass(c.confidence)}">${(c.confidence * 100).toFixed(0)}%</span>
  </div>
  <div class="card-body">
    <div class="detail"><strong>Issue:</strong> ${esc(issueLabel)}</div>
    <div class="detail"><strong>Raw text:</strong> <code>${esc(c.raw_text_quote)}</code></div>
    <div class="detail"><strong>Before:</strong> <code>${esc(c.current_value)}</code></div>
    <div class="detail"><strong>After:</strong> <code class="highlight">${esc(c.corrected_value)}</code></div>
    ${newPartyHtml}
    <div class="reasoning">${esc(c.reasoning)}</div>
  </div>
</div>`;
}

function renderReclassCard(rc, idx) {
  const issueLabel = ISSUE_LABELS[rc.issue_type] || rc.issue_type;
  const actionBadge = rc.action === "mark_non_provenance"
    ? '<span class="badge badge-red">non_provenance</span>'
    : rc.action === "merge_with_adjacent"
    ? '<span class="badge badge-amber">merge</span>'
    : '<span class="badge badge-amber">merge alt</span>';

  const mergeHtml = rc.merge_target_sequence != null
    ? `<div class="detail"><strong>Merge into:</strong> seq ${rc.merge_target_sequence}</div>` : "";

  return `<div class="card" id="rc-${idx}">
  <div class="card-header">
    <div><strong>${esc(rc.objectNumber)}</strong> seq ${rc.event_sequence} ${actionBadge}</div>
    <span class="badge ${confClass(rc.confidence)}">${(rc.confidence * 100).toFixed(0)}%</span>
  </div>
  <div class="card-body">
    <div class="detail"><strong>Issue:</strong> ${esc(issueLabel)}</div>
    <div class="detail"><strong>Raw text:</strong> <code>${esc(rc.raw_text_quote)}</code></div>
    ${mergeHtml}
    <div class="reasoning">${esc(rc.reasoning)}</div>
  </div>
</div>`;
}

function renderSplitCard(s, idx) {
  const issueLabel = ISSUE_LABELS[s.issue_type] || s.issue_type;
  const replacements = (s.replacement_events || []).map((re, i) => `
    <div class="split-event">
      <div class="split-idx">${i + 1}.</div>
      <div>
        <span class="badge badge-blue">${esc(re.transfer_type)}</span>
        ${re.location ? `<span class="badge badge-green">${esc(re.location)}</span>` : ""}
        ${re.date_year ? `<span class="badge">${re.date_year}</span>` : ""}
        <div class="detail"><em>${esc(re.raw_text_segment)}</em></div>
        ${(re.parties || []).map(p => `<div class="detail party">${esc(p.name)} → <strong>${esc(p.position)}</strong></div>`).join("")}
      </div>
    </div>`).join("");

  return `<div class="card" id="sp-${idx}">
  <div class="card-header">
    <div><strong>${esc(s.objectNumber)}</strong> seq ${s.original_sequence} <span class="badge badge-amber">split → ${s.replacement_events?.length ?? 0}</span></div>
    <span class="badge ${confClass(s.confidence)}">${(s.confidence * 100).toFixed(0)}%</span>
  </div>
  <div class="card-body">
    <div class="detail"><strong>Issue:</strong> ${esc(issueLabel)}</div>
    <div class="split-list">${replacements}</div>
    <div class="reasoning">${esc(s.reasoning)}</div>
  </div>
</div>`;
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Structural Corrections Review — ${totalItems} Items</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:ital,wght@0,300;0,400;0,500;1,300&display=swap');
  :root {
    --bg: #f5f0e8; --surface: #fffdf8; --border: #d4c9b0;
    --text: #2a2118; --text-muted: #7a6e5e; --accent: #8b4513;
    --highlight: #fff3cd; --mono: 'IBM Plex Mono', monospace;
    --sans: 'IBM Plex Sans', sans-serif;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; line-height: 1.6; padding: 2rem; max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin-bottom: 0.5rem; color: var(--accent); }
  h2 { font-size: 1.1rem; margin: 2rem 0 1rem; color: var(--accent); border-bottom: 2px solid var(--border); padding-bottom: 0.3rem; }
  .subtitle { color: var(--text-muted); margin-bottom: 1.5rem; font-size: 0.9rem; }
  .summary { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; }
  .summary-grid { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; }
  .summary-item { font-family: var(--mono); font-size: 0.8rem; padding: 2px 8px; border-radius: 4px; background: #eee8d8; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 1rem; overflow: hidden; }
  .card-header { background: #eee8d8; padding: 0.5rem 1rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  .card-body { padding: 1rem; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 0.75rem; font-weight: 500; font-family: var(--mono); background: #555; color: white; }
  .badge-blue { background: #2563eb; }
  .badge-green { background: #16a34a; }
  .badge-red { background: #dc2626; }
  .badge-amber { background: #b85c00; }
  .conf-high { background: #16a34a; }
  .conf-good { background: #65a30d; }
  .conf-ok { background: #ca8a04; }
  .conf-low { background: #dc2626; }
  .detail { font-size: 0.85rem; margin-bottom: 0.3rem; }
  .detail code { font-size: 0.8rem; background: #f5ece0; padding: 1px 4px; border-radius: 3px; }
  .detail code.highlight { background: var(--highlight); font-weight: 500; }
  .reasoning { font-style: italic; color: var(--text-muted); font-size: 0.85rem; padding: 0.5rem; background: #faf8f2; border-radius: 4px; border-left: 3px solid var(--accent); margin-top: 0.5rem; }
  .split-list { margin: 0.5rem 0; }
  .split-event { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; padding: 0.5rem; background: #faf8f2; border-radius: 4px; }
  .split-idx { font-family: var(--mono); font-weight: 500; color: var(--accent); min-width: 1.5rem; }
  .party { padding-left: 1rem; font-size: 0.8rem; color: var(--text-muted); }
  .disclaimer { background: #fff3cd; border: 2px solid #e6c200; border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; }
  .disclaimer p { font-size: 0.9rem; color: #856404; }
</style>
</head>
<body>
<h1>Structural Corrections Review</h1>
<p class="subtitle">Generated ${new Date().toISOString().split("T")[0]}. ${totalItems} items across 3 groups.</p>

<div class="disclaimer">
  <p>These corrections were generated by an LLM (Claude Sonnet) to fix structural parser limitations. Each correction shows the LLM's reasoning and confidence. Review before applying writebacks.</p>
</div>

<div class="summary">
  <strong>Summary</strong>
  <div class="summary-grid">
    <span class="summary-item">Field corrections: ${fieldCards.length}</span>
    <span class="summary-item">Reclassifications: ${reclassCards.length}</span>
    <span class="summary-item">Event splits: ${splitCards.length}</span>
  </div>
</div>

${fieldCards.length > 0 ? `
<h2>Group A: Field Corrections (${fieldCards.length})</h2>
<p class="subtitle">Truncated/wrong locations (#149, #119) and missing receiver parties (#116).</p>
${fieldCards.map((c, i) => renderFieldCard(c, i)).join("\n")}
` : ""}

${reclassCards.length > 0 ? `
<h2>Group B: Event Reclassifications (${reclassCards.length})</h2>
<p class="subtitle">Phantom events (#87), location labels (#104), alternative acquisitions (#103).</p>
${reclassCards.map((rc, i) => renderReclassCard(rc, i)).join("\n")}
` : ""}

${splitCards.length > 0 ? `
<h2>Group C: Event Splits (${splitCards.length})</h2>
<p class="subtitle">Multi-transfer merges (#125), bequest chains (#117), gap-bridging (#99), catalogue fragments (#102).</p>
${splitCards.map((s, i) => renderSplitCard(s, i)).join("\n")}
` : ""}

</body>
</html>`;

writeFileSync(outputPath, html, "utf-8");
console.log(`Review page written to ${outputPath} (${totalItems} items)`);
