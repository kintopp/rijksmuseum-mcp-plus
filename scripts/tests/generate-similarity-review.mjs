/**
 * Generate an HTML review page for find_similar results.
 * Run: node scripts/tests/generate-similarity-review.mjs
 * Output: scripts/tests/similarity-review.html
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

// Open vocab DB directly for iiif_id lookups (faster than MCP round-trips)
const vocabDb = new Database(path.join(projectRoot, "data/vocabulary.db"), { readonly: true });
const stmtIiif = vocabDb.prepare("SELECT iiif_id FROM artworks WHERE object_number = ?");

function getIiifUrl(objectNumber, width = 300) {
  const row = stmtIiif.get(objectNumber);
  if (row?.iiif_id) return `https://iiif.micr.io/${row.iiif_id}/full/${width},/0/default.jpg`;
  return null;
}

function collectionUrl(objectNumber) {
  return `https://www.rijksmuseum.nl/en/collection/${objectNumber}`;
}

// 20 diverse artworks across periods, media, and subjects
const TEST_ARTWORKS = [
  // Paintings — 17th c Dutch
  { objectNumber: "SK-C-5",      note: "Night Watch, Rembrandt, 1642" },
  { objectNumber: "SK-A-3262",   note: "Milkmaid, Vermeer, 1660" },
  { objectNumber: "SK-A-1718",   note: "Winter landscape, Avercamp, 1608" },
  { objectNumber: "SK-A-4691",   note: "Self-portrait, Rembrandt, 1628" },
  { objectNumber: "SK-A-4050",   note: "Self-portrait as Apostle Paul, Rembrandt, 1661" },
  // Paintings — other periods
  { objectNumber: "SK-A-2963",   note: "Portrait of Don Ramon Satue, Goya, 1823" },
  { objectNumber: "SK-A-2344",   note: "Self-portrait, Van Gogh, 1887" },
  { objectNumber: "SK-A-3924",   note: "Pompeius Occo, Dirck Jacobsz, 1531" },
  // Prints — different periods
  { objectNumber: "RP-P-OB-613",   note: "Christ before Pilate, Rembrandt, 1635" },
  { objectNumber: "RP-P-OB-1607",  note: "Susanna and the Elders, Lucas van Leyden, 1506" },
  { objectNumber: "RP-P-1962-47",  note: "Good Samaritan, Rembrandt, 1633" },
  { objectNumber: "RP-P-1878-A-1501", note: "Hunter, Van Reysschoot, 1712" },
  // Drawing
  { objectNumber: "RP-T-1930-30", note: "Supper at Emmaus, school of Rembrandt, 1660" },
  // Decorative arts
  { objectNumber: "BK-16676",     note: "Desk, Abraham Roentgen, 1758" },
  { objectNumber: "BK-1975-81",   note: "Cabinet, Herman Doomer, 1635" },
  // Asian art
  { objectNumber: "AK-MAK-187",   note: "Shiva Nataraja, 1100" },
  // Photo
  { objectNumber: "RP-F-F01139",  note: "Travel album, anonymous, 1851" },
  // More paintings for subject diversity
  { objectNumber: "SK-A-180",     note: "Landscape" },
  { objectNumber: "SK-A-1935",    note: "Still life" },
  { objectNumber: "SK-A-3981",    note: "Seascape" },
];

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: projectRoot,
});
const client = new Client({ name: "review-gen", version: "1.0" });
await client.connect(transport);

console.error("Connected. Generating results...");

const entries = [];

for (const artwork of TEST_ARTWORKS) {
  console.error(`  ${artwork.objectNumber} — ${artwork.note}`);
  try {
    const icResult = await client.callTool({
      name: "find_similar",
      arguments: { objectNumber: artwork.objectNumber, mode: "iconclass", maxResults: 8 },
    });
    const linResult = await client.callTool({
      name: "find_similar",
      arguments: { objectNumber: artwork.objectNumber, mode: "lineage", maxResults: 8 },
    });
    entries.push({
      query: artwork,
      iconclass: icResult.structuredContent,
      lineage: linResult.structuredContent,
    });
  } catch (err) {
    console.error(`    ERROR: ${err.message}`);
    entries.push({ query: artwork, error: err.message });
  }
}

await client.close();

// ── HTML generation ──

function escHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function imgTag(objectNumber, alt, width = 300) {
  const url = getIiifUrl(objectNumber, width);
  if (!url) return `<div class="img-placeholder">No image</div>`;
  return `<img src="${url}" alt="${escHtml(alt)}" loading="lazy">`;
}

let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>find_similar — Review Page</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f0; color: #333; padding: 20px; max-width: 1400px; margin: 0 auto; }
  h1 { font-size: 1.6em; margin-bottom: 8px; }
  .subtitle { color: #666; font-size: 0.9em; margin-bottom: 30px; }

  .query-section { background: #fff; border-radius: 8px; margin-bottom: 28px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden; }

  .query-header { display: flex; gap: 16px; padding: 16px; background: #1a1a2e; color: #fff; align-items: flex-start; }
  .query-header a { flex-shrink: 0; }
  .query-header img { max-width: 160px; max-height: 160px; object-fit: contain; border-radius: 4px; background: #2a2a3e; display: block; }
  .query-info { flex: 1; min-width: 0; }
  .query-info h2 { font-size: 1.1em; margin-bottom: 4px; }
  .query-info .meta { font-size: 0.85em; opacity: 0.8; }
  .query-info .meta a { color: #93c5fd; }
  .query-info .notations { font-size: 0.8em; opacity: 0.7; margin-top: 6px; line-height: 1.4; }

  .mode-section { padding: 12px 16px; }
  .mode-label { font-weight: 600; font-size: 0.9em; color: #555; margin-bottom: 10px; border-bottom: 1px solid #eee; padding-bottom: 4px; }
  .mode-label .count { font-weight: 400; color: #999; }
  .mode-label .warning { color: #b45309; font-weight: 400; font-style: italic; }

  .results-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 12px;
  }

  .result-card { text-align: center; }
  .result-card a { display: block; color: inherit; text-decoration: none; }
  .result-card a:hover .title { text-decoration: underline; }
  .result-card img {
    width: 100%;
    max-height: 200px;
    object-fit: contain;
    border-radius: 4px;
    background: #f0f0f0;
    display: block;
  }
  .img-placeholder {
    width: 100%;
    height: 140px;
    background: #e5e5e5;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #999;
    font-size: 0.8em;
  }
  .result-card .title { font-size: 0.8em; margin-top: 5px; line-height: 1.3; max-height: 2.6em; overflow: hidden; }
  .result-card .score { font-size: 0.75em; color: #888; margin-top: 2px; }
  .result-card .shared { font-size: 0.7em; color: #666; margin-top: 2px; line-height: 1.3; max-height: 5.2em; overflow: hidden; }

  .no-results { color: #999; font-size: 0.85em; padding: 8px 0; font-style: italic; }

  .legend { background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .legend h3 { font-size: 0.95em; margin-bottom: 6px; }
  .legend p { font-size: 0.85em; color: #555; line-height: 1.5; margin-bottom: 4px; }
  .legend code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
</style>
</head>
<body>
<h1>find_similar — Evaluation Review</h1>
<p class="subtitle">20 query artworks across periods and media. Top 8 results per mode (5 per row). Generated ${new Date().toISOString().split("T")[0]}.</p>

<div class="legend">
<h3>How to read this</h3>
<p><strong>Iconclass mode</strong> — finds artworks sharing the same Iconclass subject classifications. Score = sum of <code>depth(notation) &times; IDF(notation)</code> for all shared codes. Higher = more specific shared motifs.</p>
<p><strong>Lineage mode</strong> — finds artworks with shared visual-style lineage (e.g. "after Rembrandt", "workshop of"). Score = sum of <code>qualifier_strength &times; creator_IDF</code>. Strength: after/copyist=3, workshop=2, circle/follower=1.</p>
<p>Click any image to open the artwork on the Rijksmuseum website. Each result card shows the shared motifs/lineage. Ask: <em>do these results look genuinely similar to the query artwork?</em></p>
</div>
`;

for (const entry of entries) {
  if (entry.error) {
    html += `<div class="query-section"><div class="query-header"><div class="query-info"><h2>${escHtml(entry.query.objectNumber)}</h2><p class="meta">${escHtml(entry.query.note)}</p><p class="meta" style="color:#f87171">Error: ${escHtml(entry.error)}</p></div></div></div>\n`;
    continue;
  }

  const ic = entry.iconclass;
  const lin = entry.lineage;
  const queryTitle = ic?.queryTitle || lin?.queryTitle || "";
  const queryObjNum = ic?.queryObjectNumber || lin?.queryObjectNumber || entry.query.objectNumber;

  const notationSummary = (ic?.querySignals || []).map(s => `${s.notation} (${escHtml(s.label)})`).join(", ");
  const lineageSummary = (lin?.querySignals || []).map(s => escHtml(s.label)).join(", ");

  html += `<div class="query-section">
  <div class="query-header">
    <a href="${collectionUrl(queryObjNum)}" target="_blank">${imgTag(queryObjNum, queryTitle)}</a>
    <div class="query-info">
      <h2>${escHtml(queryTitle)}</h2>
      <p class="meta"><a href="${collectionUrl(queryObjNum)}" target="_blank">${escHtml(queryObjNum)}</a> — ${escHtml(entry.query.note)}</p>
      ${notationSummary ? `<p class="notations">Iconclass: ${notationSummary}</p>` : ""}
      ${lineageSummary ? `<p class="notations">Lineage: ${lineageSummary}</p>` : ""}
    </div>
  </div>
`;

  // Iconclass results
  html += `  <div class="mode-section">
    <div class="mode-label">Iconclass <span class="count">(${ic?.returnedCount ?? 0} results)</span>`;
  if (ic?.warnings?.length) html += ` <span class="warning">${escHtml(ic.warnings[0])}</span>`;
  html += `</div>\n`;

  if (ic?.results?.length > 0) {
    html += `    <div class="results-grid">\n`;
    for (const r of ic.results) {
      const motifs = (r.sharedMotifs || []).map(m => m.notation).join(", ");
      const motifLabels = (r.sharedMotifs || []).map(m => `${m.notation}: ${escHtml(m.label)}`).join("\n");
      html += `      <div class="result-card">
        <a href="${collectionUrl(r.objectNumber)}" target="_blank">
          ${imgTag(r.objectNumber, r.title)}
          <div class="title">${escHtml(r.title)}</div>
        </a>
        <div class="score">[${r.score}] ${escHtml(r.type || "")}${r.date ? ` ${r.date}` : ""}</div>
        <div class="shared" title="${motifLabels}">${r.sharedMotifs?.length || 0} shared: ${motifs}</div>
      </div>\n`;
    }
    html += `    </div>\n`;
  } else {
    html += `    <div class="no-results">No iconclass-similar artworks found.</div>\n`;
  }
  html += `  </div>\n`;

  // Lineage results
  html += `  <div class="mode-section">
    <div class="mode-label">Lineage <span class="count">(${lin?.returnedCount ?? 0} results)</span>`;
  if (lin?.warnings?.length) html += ` <span class="warning">${escHtml(lin.warnings[0])}</span>`;
  html += `</div>\n`;

  if (lin?.results?.length > 0) {
    html += `    <div class="results-grid">\n`;
    for (const r of lin.results) {
      const lineageDesc = (r.sharedLineage || []).map(l => `${l.qualifierLabel} ${escHtml(l.creatorLabel)} [${l.strength}]`).join("; ");
      html += `      <div class="result-card">
        <a href="${collectionUrl(r.objectNumber)}" target="_blank">
          ${imgTag(r.objectNumber, r.title)}
          <div class="title">${escHtml(r.title)}</div>
        </a>
        <div class="score">[${r.score}] ${escHtml(r.type || "")}${r.date ? ` ${r.date}` : ""}</div>
        <div class="shared">${lineageDesc}</div>
      </div>\n`;
    }
    html += `    </div>\n`;
  } else {
    html += `    <div class="no-results">No lineage-similar artworks found.</div>\n`;
  }
  html += `  </div>\n</div>\n`;
}

html += `</body></html>`;

const outPath = path.join(__dirname, "similarity-review.html");
fs.writeFileSync(outPath, html, "utf-8");
vocabDb.close();
console.error(`\nWritten to ${outPath}`);
console.log(outPath);
