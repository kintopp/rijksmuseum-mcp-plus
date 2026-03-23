/**
 * Generate HTML review page for position-enrichment LLM results.
 *
 * Usage:
 *   node scripts/generate-position-review.mjs [--input PATH] [--output PATH] [--db PATH]
 */

import { readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const inputIdx = args.indexOf("--input");
const inputPath = inputIdx >= 0 ? args[inputIdx + 1] : "data/audit-position-enrichment-2026-03-22.json";
const outputIdx = args.indexOf("--output");
const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : "data/position-enrichment-review.html";
const dbIdx = args.indexOf("--db");
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : "data/vocabulary.db";

const data = JSON.parse(readFileSync(inputPath, "utf-8"));
const db = new Database(dbPath, { readonly: true });

// Fetch provenance text and all events for each artwork
const getProvText = db.prepare(`SELECT provenance_text FROM artworks WHERE art_id = ?`);
const getEvents = db.prepare(`
  SELECT sequence, raw_text, transfer_type, transfer_category, parties, is_cross_ref
  FROM provenance_events WHERE artwork_id = ? ORDER BY sequence
`);
const getParties = db.prepare(`
  SELECT sequence, party_idx, party_name, party_role, party_position, position_method
  FROM provenance_parties WHERE artwork_id = ? ORDER BY sequence, party_idx
`);

function esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function safeJson(val) {
  if (val == null) return [];
  if (typeof val === "string") { try { return JSON.parse(val); } catch { return []; } }
  return val;
}

// Flatten all enrichments into reviewable items
const items = [];
for (const r of data.results) {
  const { artwork_id, object_number } = r.data;
  const provRow = getProvText.get(artwork_id);
  const provText = provRow?.provenance_text || "";
  const dbEvents = getEvents.all(artwork_id);
  const dbParties = getParties.all(artwork_id);

  for (const enr of r.data.enrichments || []) {
    const seq = enr.event_sequence;
    const dbEvent = dbEvents.find(e => e.sequence === seq);

    for (const pu of enr.party_updates || []) {
      items.push({
        type: "party",
        artwork_id,
        object_number,
        provText,
        dbEvents,
        dbParties,
        seq,
        dbEvent,
        partyIdx: pu.party_idx,
        partyName: pu.party_name,
        position: pu.position,
        confidence: pu.confidence,
        reasoning: pu.reasoning,
      });
    }

    if (enr.category_update) {
      const cu = enr.category_update;
      items.push({
        type: "category",
        artwork_id,
        object_number,
        provText,
        dbEvents,
        dbParties,
        seq,
        dbEvent,
        category: cu.category,
        confidence: cu.confidence,
        reasoning: cu.reasoning,
      });
    }
  }
}

// Group: real positions, parser artifacts, category updates
const realPositions = items.filter(i => i.type === "party" && i.position && i.position !== "null" && i.position !== "None");
const artifacts = items.filter(i => i.type === "party" && (!i.position || i.position === "null" || i.position === "None"));
const categoryUpdates = items.filter(i => i.type === "category");

// Stats
const posDist = {};
for (const i of realPositions) posDist[i.position] = (posDist[i.position] || 0) + 1;
const catDist = {};
for (const i of categoryUpdates) catDist[i.category] = (catDist[i.category] || 0) + 1;

// Confidence buckets
function confBuckets(arr) {
  const key = arr[0]?.type === "party" ? "confidence" : "confidence";
  const buckets = { "≥0.9": 0, "0.8–0.9": 0, "0.7–0.8": 0, "0.6–0.7": 0, "<0.6": 0 };
  for (const i of arr) {
    const c = i.confidence;
    if (c >= 0.9) buckets["≥0.9"]++;
    else if (c >= 0.8) buckets["0.8–0.9"]++;
    else if (c >= 0.7) buckets["0.7–0.8"]++;
    else if (c >= 0.6) buckets["0.6–0.7"]++;
    else buckets["<0.6"]++;
  }
  return buckets;
}

function renderEventChain(dbEvents, dbParties, highlightSeq) {
  let html = '<ul class="event-list">';
  for (const e of dbEvents) {
    const isHighlight = e.sequence === highlightSeq;
    const cls = isHighlight ? "highlight" : "context";
    const parties = dbParties.filter(p => p.sequence === e.sequence);
    const partyStr = parties.length > 0
      ? parties.map(p => {
          const pos = p.party_position ? ` [${p.party_position}]` : " [?]";
          return `${esc(p.party_name)}${pos}`;
        }).join(", ")
      : "";
    const rawShort = esc((e.raw_text || "").replace(/\{[^}]*\}/g, "").slice(0, 100));
    html += `<li class="${cls}">`;
    html += `<span class="seq">${e.sequence}.</span> `;
    html += `<span class="type-tag">${esc(e.transfer_type)}</span> `;
    html += rawShort;
    if (partyStr) html += `<br><span style="font-size:0.75rem;color:var(--text-muted);margin-left:2em;">Parties: ${partyStr}</span>`;
    html += `</li>`;
  }
  html += '</ul>';
  return html;
}

function positionColor(pos) {
  if (pos === "sender") return "#c0392b";
  if (pos === "receiver") return "#2d6a4f";
  if (pos === "agent") return "#7d3c98";
  return "#666";
}

function categoryColor(cat) {
  return cat === "custody" ? "#d4a017" : "#1a4f7a";
}

function renderCard(item, idx, sectionPrefix) {
  const id = `${sectionPrefix}-${idx + 1}`;
  let badgesHtml = "";
  let classifiedHtml = "";

  if (item.type === "party") {
    const pos = item.position || "null";
    const color = positionColor(pos);
    badgesHtml = `<span class="badge" style="background:${color};color:white;">${esc(pos)}</span>`;
    badgesHtml += `<span class="badge badge-confidence">${(item.confidence * 100).toFixed(0)}%</span>`;
    classifiedHtml = `
      <div class="classified-event">
        <strong>Party:</strong> ${esc(item.partyName)} (idx ${item.partyIdx})<br>
        <strong>Position:</strong> <span style="color:${color};font-weight:600;">${esc(pos)}</span>
      </div>
      <div class="reasoning">${esc(item.reasoning)}</div>
    `;
  } else {
    const color = categoryColor(item.category);
    badgesHtml = `<span class="badge" style="background:${color};color:white;">${esc(item.category)}</span>`;
    badgesHtml += `<span class="badge badge-confidence">${(item.confidence * 100).toFixed(0)}%</span>`;
    classifiedHtml = `
      <div class="classified-event">
        <strong>Event seq ${item.seq}:</strong> ${esc((item.dbEvent?.raw_text || "").replace(/\{[^}]*\}/g, "").slice(0, 120))}<br>
        <strong>Category:</strong> <span style="color:${color};font-weight:600;">${esc(item.category)}</span>
        (was: ambiguous)
      </div>
      <div class="reasoning">${esc(item.reasoning)}</div>
    `;
  }

  return `
  <div class="card" id="${id}">
    <div class="card-header">
      <h2>${esc(item.object_number)} — seq ${item.seq}</h2>
      <div>${badgesHtml}</div>
    </div>
    <div class="card-body">
      <div class="left">
        <div class="section-label">Provenance chain (highlighted: seq ${item.seq})</div>
        ${renderEventChain(item.dbEvents, item.dbParties, item.seq)}
      </div>
      <div class="right">
        <div class="section-label">LLM Classification</div>
        ${classifiedHtml}
      </div>
    </div>
  </div>`;
}

function renderSection(title, description, sectionItems, sectionPrefix) {
  if (sectionItems.length === 0) return "";
  let html = `<h2 class="section-title" id="section-${sectionPrefix}">${esc(title)} (${sectionItems.length})</h2>`;
  html += `<p class="section-desc">${esc(description)}</p>`;
  html += `<div class="toc"><h3>Jump to</h3><div class="toc-grid">`;
  for (let i = 0; i < sectionItems.length; i++) {
    const item = sectionItems[i];
    html += `<a class="toc-link" href="#${sectionPrefix}-${i + 1}">${i + 1}. ${esc(item.object_number)}</a>`;
  }
  html += `</div></div>`;
  for (let i = 0; i < sectionItems.length; i++) {
    html += renderCard(sectionItems[i], i, sectionPrefix);
  }
  return html;
}

// Sort: low confidence first (most interesting to review)
realPositions.sort((a, b) => a.confidence - b.confidence);
artifacts.sort((a, b) => a.confidence - b.confidence);
categoryUpdates.sort((a, b) => a.confidence - b.confidence);

const realBuckets = confBuckets(realPositions);
const artifactBuckets = confBuckets(artifacts);
const catBuckets = confBuckets(categoryUpdates);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Position Enrichment Review — ${items.length} Classifications</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:ital,wght@0,300;0,400;0,500;1,300&display=swap');

  :root {
    --bg: #f5f0e8; --surface: #fffdf8; --border: #d4c9b0;
    --text: #2a2118; --text-muted: #7a6e5e; --accent: #8b4513;
    --highlight: #fff3cd; --mono: 'IBM Plex Mono', monospace;
    --sans: 'IBM Plex Sans', sans-serif;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; line-height: 1.6; padding: 2rem; max-width: 1200px; margin: 0 auto; }

  h1 { font-size: 1.4rem; margin-bottom: 0.5rem; color: var(--accent); }
  .subtitle { color: var(--text-muted); margin-bottom: 1rem; font-size: 0.9rem; }

  .summary { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 2rem; }
  .summary h2 { font-size: 1rem; margin-bottom: 0.5rem; }
  .summary-grid { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem; }
  .summary-item { font-family: var(--mono); font-size: 0.8rem; padding: 2px 8px; border-radius: 4px; background: #eee8d8; }
  .summary table { font-size: 0.85rem; border-collapse: collapse; }
  .summary th, .summary td { padding: 2px 12px; text-align: left; }
  .summary th { color: var(--text-muted); font-weight: 500; }

  .section-title { font-size: 1.2rem; margin: 2rem 0 0.25rem; color: var(--accent); border-bottom: 2px solid var(--border); padding-bottom: 0.25rem; }
  .section-desc { color: var(--text-muted); font-size: 0.85rem; margin-bottom: 1rem; }

  .toc { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; }
  .toc h3 { font-size: 0.9rem; margin-bottom: 0.5rem; }
  .toc-grid { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .toc-link { font-family: var(--mono); font-size: 0.72rem; padding: 2px 5px; border-radius: 3px; text-decoration: none; color: var(--accent); background: #f5ece0; }
  .toc-link:hover { background: var(--highlight); }

  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 1.5rem; overflow: hidden; }
  .card-header { background: #eee8d8; padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; }
  .card-header h2 { font-size: 1rem; font-weight: 500; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.8rem; font-weight: 500; font-family: var(--mono); }
  .badge-confidence { background: #6b4c9a; color: white; margin-left: 4px; }

  .card-body { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  @media (max-width: 800px) { .card-body { grid-template-columns: 1fr; } .left { border-right: none !important; border-bottom: 1px solid var(--border); } }
  .left, .right { padding: 1rem; }
  .left { border-right: 1px solid var(--border); }

  .section-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 0.5rem; font-weight: 500; }

  .event-list { list-style: none; font-size: 0.82rem; }
  .event-list li { padding: 4px 0; border-bottom: 1px solid #f0ebe0; }
  .event-list li:last-child { border-bottom: none; }
  .event-list .seq { color: var(--text-muted); font-family: var(--mono); font-size: 0.75rem; min-width: 1.5em; display: inline-block; }
  .event-list .type-tag { font-family: var(--mono); font-size: 0.7rem; color: var(--accent); }
  .event-list .highlight { background: var(--highlight); padding: 2px 4px; border-radius: 3px; }
  .event-list .context { opacity: 0.6; }

  .classified-event { background: var(--highlight); padding: 0.75rem; border-radius: 6px; margin-bottom: 0.75rem; font-family: var(--mono); font-size: 0.82rem; word-break: break-word; }
  .reasoning { font-family: var(--sans); font-style: italic; color: var(--text-muted); font-size: 0.85rem; margin-top: 0.5rem; }

  .nav-links { position: fixed; bottom: 1rem; right: 1rem; display: flex; flex-direction: column; gap: 0.25rem; }
  .nav-links a { background: var(--accent); color: white; padding: 0.4rem 0.8rem; border-radius: 6px; text-decoration: none; font-size: 0.75rem; opacity: 0.8; text-align: center; }
  .nav-links a:hover { opacity: 1; }

  .filter-bar { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1.5rem; display: flex; gap: 1rem; flex-wrap: wrap; align-items: center; }
  .filter-bar label { font-size: 0.85rem; cursor: pointer; }
  .filter-bar input[type="checkbox"] { margin-right: 0.25rem; }
</style>
</head>
<body>
<h1>Position Enrichment Review — ${items.length} Classifications</h1>
<p class="subtitle">Model: ${esc(data.meta.model)} via Batch API. Batch: <code>${esc(data.meta.batchId)}</code>. Cost: $${data.meta.estimatedCost}. Sorted by confidence (lowest first).</p>

<div class="summary">
  <h2>Task description</h2>
  <p style="font-size:0.9rem;line-height:1.6;">In the PLOD (Provenance Linked Open Data) model, each provenance event is a directed transfer: <strong>Sender &rarr; Receiver</strong>, optionally facilitated by an <strong>Agent</strong>. The parser assigns party positions using keyword rules (e.g., "from X" &rarr; sender, "to Y" &rarr; receiver) and role inference (e.g., "buyer" &rarr; receiver). However, <strong>${items.filter(i => i.type === "party").length} parties</strong> across ${new Set(items.map(i => i.artwork_id)).size} artworks had no position — the parser found no keyword or role to assign one.</p>
  <p style="font-size:0.9rem;line-height:1.6;margin-top:0.5rem;">The LLM was given each artwork's full provenance chain (all events with existing party positions) and asked to: (1) classify each null-position party as <em>sender</em>, <em>receiver</em>, or <em>agent</em> using AAM sequential conventions and chain context; (2) reclassify any remaining <code>ambiguous</code> transfer categories as <em>ownership</em> or <em>custody</em>. The prompt used XML structure with AAM/PLOD domain context, parser-artifact guidance, and 6 few-shot examples (bare-name receiver, "whose sale" sender, dealer-as-agent, institutional transfer, parser artifact, genuinely ambiguous). Results fall into three sections:</p>
  <ul style="font-size:0.9rem;line-height:1.6;margin-top:0.5rem;margin-left:1.5rem;">
    <li><strong>Real Positions (${realPositions.length})</strong> — parties that received a sender/receiver/agent classification</li>
    <li><strong>Parser Artifacts (${artifacts.length})</strong> — text fragments the model identified as not being real parties (e.g., "whose sale", "after closure of Museum Nusantara", "post-auction sale"). These were returned with position null and were subsequently re-analyzed in a disambiguation pass (see separate review).</li>
    <li><strong>Category Updates (${categoryUpdates.length})</strong> — events reclassified from <code>ambiguous</code> to ownership or custody</li>
  </ul>
</div>

<div class="summary">
  <h2>Overview</h2>
  <div class="summary-grid">
    <span class="summary-item">Total items: ${items.length}</span>
    <span class="summary-item">Real positions: ${realPositions.length}</span>
    <span class="summary-item">Parser artifacts: ${artifacts.length}</span>
    <span class="summary-item">Category updates: ${categoryUpdates.length}</span>
  </div>

  <table>
    <tr><th></th><th>receiver</th><th>sender</th><th>agent</th></tr>
    <tr><td><strong>Positions</strong></td><td>${posDist.receiver || 0}</td><td>${posDist.sender || 0}</td><td>${posDist.agent || 0}</td></tr>
  </table>

  <table style="margin-top:0.5rem;">
    <tr><th></th><th>ownership</th><th>custody</th></tr>
    <tr><td><strong>Categories</strong></td><td>${catDist.ownership || 0}</td><td>${catDist.custody || 0}</td></tr>
  </table>

  <table style="margin-top:0.5rem;">
    <tr><th>Confidence</th>${Object.keys(realBuckets).map(k => `<th>${k}</th>`).join("")}</tr>
    <tr><td>Real positions</td>${Object.values(realBuckets).map(v => `<td>${v}</td>`).join("")}</tr>
    <tr><td>Parser artifacts</td>${Object.values(artifactBuckets).map(v => `<td>${v}</td>`).join("")}</tr>
    <tr><td>Category updates</td>${Object.values(catBuckets).map(v => `<td>${v}</td>`).join("")}</tr>
  </table>
</div>

<div class="summary">
  <h2>Sections</h2>
  <div class="summary-grid">
    <a class="toc-link" href="#section-pos" style="font-size:0.85rem;padding:4px 10px;">Real Positions (${realPositions.length})</a>
    <a class="toc-link" href="#section-artifact" style="font-size:0.85rem;padding:4px 10px;">Parser Artifacts (${artifacts.length})</a>
    <a class="toc-link" href="#section-cat" style="font-size:0.85rem;padding:4px 10px;">Category Updates (${categoryUpdates.length})</a>
  </div>
</div>

${renderSection("Real Position Assignments", "Parties that received sender, receiver, or agent classification. Sorted lowest confidence first — review these most carefully.", realPositions, "pos")}

${renderSection("Parser Artifacts", "Parties the model identified as text fragments, not real people/institutions. Position left as null.", artifacts, "artifact")}

${renderSection("Category Updates", "Events reclassified from ambiguous to ownership or custody.", categoryUpdates, "cat")}

<div class="nav-links">
  <a href="#section-pos">Positions</a>
  <a href="#section-artifact">Artifacts</a>
  <a href="#section-cat">Categories</a>
  <a href="#">Top</a>
</div>

</body>
</html>`;

writeFileSync(outputPath, html);
db.close();
console.log(`Written ${outputPath} (${items.length} items: ${realPositions.length} positions, ${artifacts.length} artifacts, ${categoryUpdates.length} categories)`);
