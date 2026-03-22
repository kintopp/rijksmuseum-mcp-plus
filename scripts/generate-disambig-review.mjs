/**
 * Generate HTML review page for party-disambiguation LLM results.
 *
 * Usage:
 *   node scripts/generate-disambig-review.mjs [--input PATH] [--output PATH] [--db PATH]
 */

import { readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const inputIdx = args.indexOf("--input");
const inputPath = inputIdx >= 0 ? args[inputIdx + 1] : "data/audit-party-disambiguation-2026-03-22.json";
const outputIdx = args.indexOf("--output");
const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : "data/party-disambiguation-review.html";
const dbIdx = args.indexOf("--db");
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : "data/vocabulary.db";

const data = JSON.parse(readFileSync(inputPath, "utf-8"));
const db = new Database(dbPath, { readonly: true });

const getEvents = db.prepare(`
  SELECT sequence, raw_text, transfer_type, transfer_category, parties, is_cross_ref
  FROM provenance_events WHERE artwork_id = ? ORDER BY sequence
`);
const getParties = db.prepare(`
  SELECT sequence, party_idx, party_name, party_role, party_position, position_method
  FROM provenance_parties WHERE artwork_id = ? ORDER BY sequence, party_idx
`);

function esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

// Flatten into reviewable items
const items = [];
for (const r of data.results) {
  if (r.error) continue;
  const { artwork_id, object_number } = r.data;
  const dbEvents = getEvents.all(artwork_id);
  const dbParties = getParties.all(artwork_id);

  for (const d of r.data.disambiguations || []) {
    items.push({
      artwork_id,
      object_number,
      dbEvents,
      dbParties,
      seq: d.event_sequence,
      originalIdx: d.original_party_idx,
      originalText: d.original_text,
      action: d.action,
      replacements: d.replacement_parties || [],
      confidence: d.confidence,
      reasoning: d.reasoning,
    });
  }
}

// Group by action
const splits = items.filter(i => i.action === "split");
const renames = items.filter(i => i.action === "rename");
const deletes = items.filter(i => i.action === "delete");

// Stats
const posDist = {};
for (const i of items) {
  for (const p of i.replacements) {
    posDist[p.position] = (posDist[p.position] || 0) + 1;
  }
}

function confBuckets(arr) {
  const buckets = { "≥0.9": 0, "0.8–0.9": 0, "0.7–0.8": 0, "<0.7": 0 };
  for (const i of arr) {
    const c = i.confidence;
    if (c >= 0.9) buckets["≥0.9"]++;
    else if (c >= 0.8) buckets["0.8–0.9"]++;
    else if (c >= 0.7) buckets["0.7–0.8"]++;
    else buckets["<0.7"]++;
  }
  return buckets;
}

function actionColor(a) {
  if (a === "split") return "#2d6a4f";
  if (a === "rename") return "#1a4f7a";
  return "#8b4513";
}

function posColor(p) {
  if (p === "sender") return "#c0392b";
  if (p === "receiver") return "#2d6a4f";
  if (p === "agent") return "#7d3c98";
  return "#666";
}

function renderEventChain(dbEvents, dbParties, highlightSeq) {
  let html = '<ul class="event-list">';
  for (const e of dbEvents) {
    if (e.is_cross_ref) continue;
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

function renderCard(item, idx, sectionPrefix) {
  const id = `${sectionPrefix}-${idx + 1}`;
  const color = actionColor(item.action);

  let replacementHtml = "";
  if (item.replacements.length === 0) {
    replacementHtml = `<div style="color:var(--text-muted);font-style:italic;margin-top:0.5rem;">(no replacement — party deleted)</div>`;
  } else {
    replacementHtml = '<div style="margin-top:0.5rem;">';
    for (const p of item.replacements) {
      const pc = posColor(p.position);
      replacementHtml += `<div style="margin:4px 0;padding:4px 8px;border-left:3px solid ${pc};background:#faf8f2;border-radius:0 4px 4px 0;">`;
      replacementHtml += `<strong style="color:${pc};">${esc(p.position)}</strong>: ${esc(p.name)}`;
      if (p.role_hint) replacementHtml += ` <span style="color:var(--text-muted);font-size:0.8rem;">(${esc(p.role_hint)})</span>`;
      replacementHtml += `</div>`;
    }
    replacementHtml += '</div>';
  }

  return `
  <div class="card" id="${id}">
    <div class="card-header">
      <h2>${esc(item.object_number)} — seq ${item.seq}</h2>
      <div>
        <span class="badge" style="background:${color};color:white;">${esc(item.action)}</span>
        <span class="badge badge-confidence">${(item.confidence * 100).toFixed(0)}%</span>
      </div>
    </div>
    <div class="card-body">
      <div class="left">
        <div class="section-label">Provenance chain (highlighted: seq ${item.seq})</div>
        ${renderEventChain(item.dbEvents, item.dbParties, item.seq)}
      </div>
      <div class="right">
        <div class="section-label">Original party (idx ${item.originalIdx})</div>
        <div class="classified-event" style="background:#fde8e8;">
          <code>${esc(item.originalText)}</code>
        </div>

        <div class="section-label" style="margin-top:1rem;">Correction → ${esc(item.action)}</div>
        ${replacementHtml}

        <div class="reasoning">${esc(item.reasoning)}</div>
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

// Sort by confidence ascending
splits.sort((a, b) => a.confidence - b.confidence);
renames.sort((a, b) => a.confidence - b.confidence);
deletes.sort((a, b) => a.confidence - b.confidence);

const splitBuckets = confBuckets(splits);
const renameBuckets = confBuckets(renames);
const deleteBuckets = confBuckets(deletes);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Party Disambiguation Review — ${items.length} Events</title>
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

  .classified-event { padding: 0.75rem; border-radius: 6px; margin-bottom: 0.75rem; font-family: var(--mono); font-size: 0.82rem; word-break: break-word; }
  .reasoning { font-family: var(--sans); font-style: italic; color: var(--text-muted); font-size: 0.85rem; margin-top: 0.75rem; }

  .nav-links { position: fixed; bottom: 1rem; right: 1rem; display: flex; flex-direction: column; gap: 0.25rem; }
  .nav-links a { background: var(--accent); color: white; padding: 0.4rem 0.8rem; border-radius: 6px; text-decoration: none; font-size: 0.75rem; opacity: 0.8; text-align: center; }
  .nav-links a:hover { opacity: 1; }
</style>
</head>
<body>
<h1>Party Disambiguation Review — ${items.length} Events</h1>
<p class="subtitle">Model: ${esc(data.meta.model)} via Batch API. Batch: <code>${esc(data.meta.batchId)}</code>. Cost: $${data.meta.estimatedCost}. Sorted by confidence (lowest first).</p>

<div class="summary">
  <h2>Task description</h2>
  <p style="font-size:0.9rem;line-height:1.6;">The provenance parser sometimes creates a single party entry from text that actually contains multiple parties or is not a party at all. For example, <code>"from his heirs to the museum"</code> gets parsed as one party name, when it should be two: "his heirs" (sender) and "the museum" (receiver). Similarly, <code>"whose sale"</code> is an anaphoric reference to the previous owner, and <code>"after closure of Museum Nusantara in 2013"</code> is contextual preamble, not a party.</p>
  <p style="font-size:0.9rem;line-height:1.6;margin-top:0.5rem;">This is a targeted second pass on the <strong>${items.length} parser artifacts</strong> identified during position enrichment (see separate review) where the LLM's reasoning indicated it could identify the correct parties inside the merged text. The LLM was given each artwork's full provenance chain and the specific flagged party, then asked to choose one of three actions:</p>
  <ul style="font-size:0.9rem;line-height:1.6;margin-top:0.5rem;margin-left:1.5rem;">
    <li><strong>Split (${splits.length})</strong> — decompose into 2+ separate parties with names and positions. E.g., <code>"from the De Bosch Kemper family to the Teding van Berkhout family"</code> &amp;rarr; De Bosch Kemper family [sender] + Teding van Berkhout family [receiver].</li>
    <li><strong>Rename (${renames.length})</strong> — the text refers to one real party but the name is malformed (includes verb phrases or prepositions). Extract the clean name and assign a position. E.g., <code>"Probably bequeathed by the artist"</code> &amp;rarr; the artist [sender].</li>
    <li><strong>Delete (${deletes.length})</strong> — the text is not a party at all (contextual preamble, sale modifier, citation leak). E.g., <code>"after closure of the Museum Nusantara in 2013"</code> &amp;rarr; remove.</li>
  </ul>
  <p style="font-size:0.9rem;line-height:1.6;margin-top:0.5rem;">The prompt used XML structure with 5 few-shot examples covering each action type plus AAM conventions for resolving anaphoric references ("whose", "his", "from whom"). For anaphoric references, the LLM was asked to resolve the referent from the provenance chain where possible. Each card below shows the provenance chain on the left, the original malformed party (red) on the right, and the corrected decomposition with color-coded positions.</p>
</div>

<div class="summary">
  <h2>Overview</h2>
  <div class="summary-grid">
    <span class="summary-item">Total: ${items.length}</span>
    <span class="summary-item" style="background:#d4edda;">split: ${splits.length}</span>
    <span class="summary-item" style="background:#cce5ff;">rename: ${renames.length}</span>
    <span class="summary-item" style="background:#f8d7da;">delete: ${deletes.length}</span>
    <span class="summary-item">→ ${items.reduce((s, i) => s + i.replacements.length, 0)} replacement parties</span>
  </div>

  <table>
    <tr><th>Positions</th><th>receiver</th><th>sender</th><th>agent</th></tr>
    <tr><td></td><td>${posDist.receiver || 0}</td><td>${posDist.sender || 0}</td><td>${posDist.agent || 0}</td></tr>
  </table>

  <table style="margin-top:0.5rem;">
    <tr><th>Confidence</th>${Object.keys(splitBuckets).map(k => `<th>${k}</th>`).join("")}</tr>
    <tr><td>Splits</td>${Object.values(splitBuckets).map(v => `<td>${v}</td>`).join("")}</tr>
    <tr><td>Renames</td>${Object.values(renameBuckets).map(v => `<td>${v}</td>`).join("")}</tr>
    <tr><td>Deletes</td>${Object.values(deleteBuckets).map(v => `<td>${v}</td>`).join("")}</tr>
  </table>
</div>

<div class="summary">
  <h2>Sections</h2>
  <div class="summary-grid">
    <a class="toc-link" href="#section-split" style="font-size:0.85rem;padding:4px 10px;">Splits (${splits.length})</a>
    <a class="toc-link" href="#section-rename" style="font-size:0.85rem;padding:4px 10px;">Renames (${renames.length})</a>
    <a class="toc-link" href="#section-delete" style="font-size:0.85rem;padding:4px 10px;">Deletes (${deletes.length})</a>
  </div>
</div>

${renderSection("Splits", "Merged party text decomposed into 2+ separate parties with positions. Review the name extraction and position assignment.", splits, "split")}

${renderSection("Renames", "Malformed party name cleaned up — verb phrases, prepositions, or contextual text stripped. Position assigned.", renames, "rename")}

${renderSection("Deletes", "Text fragment is not a real party — contextual preamble, sale modifier, or citation leak. Recommended for removal.", deletes, "delete")}

<div class="nav-links">
  <a href="#section-split">Splits</a>
  <a href="#section-rename">Renames</a>
  <a href="#section-delete">Deletes</a>
  <a href="#">Top</a>
</div>

</body>
</html>`;

writeFileSync(outputPath, html);
db.close();
console.log(`Written ${outputPath} (${items.length} items: ${splits.length} splits, ${renames.length} renames, ${deletes.length} deletes)`);
