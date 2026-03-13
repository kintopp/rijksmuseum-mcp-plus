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

// 40 random paintings (type=painting, with images)
const TEST_ARTWORKS = [
  "SK-A-1648", "SK-A-4541", "SK-A-3783", "SK-A-1320", "SK-A-867",
  "SK-A-2704", "SK-A-2031", "RP-T-1952-248", "SK-A-332", "SK-A-987",
  "SK-A-846", "SK-A-3851", "SK-A-3091", "SK-A-4146", "SK-A-740",
  "SK-A-117", "SK-A-4494", "SK-A-944", "SK-A-4750", "SK-A-2665",
  "SK-A-964", "SK-A-2016", "RP-T-1952-199", "SK-A-693", "SK-A-623",
  "SK-A-3746", "RP-T-1950-205", "SK-A-720", "SK-A-4553", "SK-A-19",
  "SK-A-2062", "SK-A-281", "SK-A-3433", "SK-A-4896", "SK-A-2457",
  "SK-A-2193", "SK-A-3961", "SK-A-1279", "SK-A-746", "SK-A-2083",
].map(objectNumber => ({ objectNumber, note: "" }));

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
      arguments: { objectNumber: artwork.objectNumber, mode: "iconclass", maxResults: 50 },
    });
    const linResult = await client.callTool({
      name: "find_similar",
      arguments: { objectNumber: artwork.objectNumber, mode: "lineage", maxResults: 50 },
    });
    const perResult = await client.callTool({
      name: "find_similar",
      arguments: { objectNumber: artwork.objectNumber, mode: "depicted_person", maxResults: 50 },
    });

    // Build per-objectNumber lookup across modes
    const ic = icResult.structuredContent;
    const lin = linResult.structuredContent;
    const per = perResult.structuredContent;
    const modeMap = new Map(); // objectNumber → { modes: Set, icData, linData, perData }
    for (const r of (ic?.results || [])) {
      modeMap.set(r.objectNumber, { modes: new Set(["iconclass"]), icData: r });
    }
    for (const r of (lin?.results || [])) {
      const e = modeMap.get(r.objectNumber) || { modes: new Set() };
      e.modes.add("lineage");
      e.linData = r;
      modeMap.set(r.objectNumber, e);
    }
    for (const r of (per?.results || [])) {
      const e = modeMap.get(r.objectNumber) || { modes: new Set() };
      e.modes.add("depicted_person");
      e.perData = r;
      modeMap.set(r.objectNumber, e);
    }
    // Filter to 2+ mode overlap
    const intersections = [...modeMap.entries()]
      .filter(([, v]) => v.modes.size >= 2)
      .sort((a, b) => b[1].modes.size - a[1].modes.size);

    entries.push({
      query: artwork,
      iconclass: ic,
      lineage: lin,
      person: per,
      intersections,
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
<p class="subtitle">40 random paintings only. Top 50 per mode, 8 shown. Intersections (2+ modes) shown first. Solo-notation filter: depth &ge; 5. Generated ${new Date().toISOString().split("T")[0]}.</p>

<div class="legend">
<h3>How to read this</h3>
<p><strong>Iconclass mode</strong> — finds artworks sharing the same Iconclass subject classifications. Score = sum of <code>depth(notation) &times; IDF(notation)</code> for all shared codes. Higher = more specific shared motifs.</p>
<p><strong>Lineage mode</strong> — finds artworks with shared visual-style lineage (e.g. "after Rembrandt", "workshop of"). Score = sum of <code>qualifier_strength &times; creator_IDF</code>. Strength: after/copyist=3, workshop=2, circle/follower=1.</p>
<p><strong>Depicted person mode</strong> — finds artworks depicting the same named persons (rulers, saints, artists). Score = sum of <code>log(N / df)</code> for each shared person. Rare persons score higher.</p>
<p><strong>Intersections</strong> (yellow section) — artworks appearing in 2+ modes within the top 50 results each. <span style="color:#d97706">Orange border</span> = 2 modes, <span style="color:#dc2626">red border</span> = 3 modes. These are the strongest multi-signal matches.</p>
<p>Click any image to open the artwork on the Rijksmuseum website. Each result card shows the shared motifs/lineage/persons. Ask: <em>do these results look genuinely similar to the query artwork?</em></p>
</div>
`;

for (const entry of entries) {
  if (entry.error) {
    html += `<div class="query-section"><div class="query-header"><div class="query-info"><h2>${escHtml(entry.query.objectNumber)}</h2><p class="meta">${escHtml(entry.query.note)}</p><p class="meta" style="color:#f87171">Error: ${escHtml(entry.error)}</p></div></div></div>\n`;
    continue;
  }

  const ic = entry.iconclass;
  const lin = entry.lineage;
  const per = entry.person;
  const queryTitle = ic?.queryTitle || lin?.queryTitle || per?.queryTitle || "";
  const queryObjNum = ic?.queryObjectNumber || lin?.queryObjectNumber || per?.queryObjectNumber || entry.query.objectNumber;

  const notationSummary = (ic?.querySignals || []).map(s => `${s.notation} (${escHtml(s.label)})`).join(", ");
  const lineageSummary = (lin?.querySignals || []).map(s => escHtml(s.label)).join(", ");
  const personSummary = (per?.querySignals || []).map(s => escHtml(s.label)).join(", ");

  html += `<div class="query-section">
  <div class="query-header">
    <a href="${collectionUrl(queryObjNum)}" target="_blank">${imgTag(queryObjNum, queryTitle)}</a>
    <div class="query-info">
      <h2>${escHtml(queryTitle)}</h2>
      <p class="meta"><a href="${collectionUrl(queryObjNum)}" target="_blank">${escHtml(queryObjNum)}</a> — ${escHtml(entry.query.note)}</p>
      ${notationSummary ? `<p class="notations">Iconclass: ${notationSummary}</p>` : ""}
      ${lineageSummary ? `<p class="notations">Lineage: ${lineageSummary}</p>` : ""}
      ${personSummary ? `<p class="notations">Persons: ${personSummary}</p>` : ""}
    </div>
  </div>
`;

  // Intersection section — artworks appearing in 2+ modes (shown first)
  const ixns = entry.intersections || [];
  const tripleCount = ixns.filter(([, v]) => v.modes.size === 3).length;
  const doubleCount = ixns.filter(([, v]) => v.modes.size === 2).length;
  html += `  <div class="mode-section" style="background: #fefce8;">
    <div class="mode-label" style="color: #92400e; border-color: #fde68a;">Intersections <span class="count">(${ixns.length} artworks in 2+ modes: ${tripleCount} triple, ${doubleCount} double)</span></div>\n`;

  if (ixns.length > 0) {
    html += `    <div class="results-grid">\n`;
    for (const [objNum, data] of ixns) {
      const modeLabels = [...data.modes].sort().join(" + ");
      const title = data.icData?.title || data.linData?.title || data.perData?.title || "";
      const type = data.icData?.type || data.linData?.type || data.perData?.type || "";
      const date = data.icData?.date || data.linData?.date || data.perData?.date || "";

      const details = [];
      if (data.icData?.sharedMotifs?.length) {
        details.push(`IC: ${data.icData.sharedMotifs.map(m => m.notation).join(", ")}`);
      }
      if (data.linData?.sharedLineage?.length) {
        details.push(`Lin: ${data.linData.sharedLineage.map(l => `${l.qualifierLabel} ${escHtml(l.creatorLabel)}`).join(", ")}`);
      }
      if (data.perData?.sharedPersons?.length) {
        details.push(`Per: ${data.perData.sharedPersons.map(p => escHtml(p.label)).join(", ")}`);
      }
      const borderColor = data.modes.size === 3 ? "#dc2626" : "#d97706";
      html += `      <div class="result-card" style="border: 2px solid ${borderColor}; border-radius: 6px; padding: 4px;">
        <a href="${collectionUrl(objNum)}" target="_blank">
          ${imgTag(objNum, title)}
          <div class="title">${escHtml(title)}</div>
        </a>
        <div class="score" style="color: ${borderColor}; font-weight: 600;">[${modeLabels}] ${escHtml(type)}${date ? ` ${date}` : ""}</div>
        <div class="shared">${details.join(" | ")}</div>
      </div>\n`;
    }
    html += `    </div>\n`;
  } else {
    html += `    <div class="no-results">No artworks found in 2+ modes (top 50 each).</div>\n`;
  }
  html += `  </div>\n`;

  // Iconclass results (show top 8 of up to 50)
  const icDisplay = (ic?.results || []).slice(0, 8);
  html += `  <div class="mode-section">
    <div class="mode-label">Iconclass <span class="count">(${icDisplay.length} shown / ${ic?.returnedCount ?? 0} found)</span>`;
  if (ic?.warnings?.length) html += ` <span class="warning">${escHtml(ic.warnings[0])}</span>`;
  html += `</div>\n`;

  if (icDisplay.length > 0) {
    html += `    <div class="results-grid">\n`;
    for (const r of icDisplay) {
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

  // Lineage results (show top 8 of up to 50)
  const linDisplay = (lin?.results || []).slice(0, 8);
  html += `  <div class="mode-section">
    <div class="mode-label">Lineage <span class="count">(${linDisplay.length} shown / ${lin?.returnedCount ?? 0} found)</span>`;
  if (lin?.warnings?.length) html += ` <span class="warning">${escHtml(lin.warnings[0])}</span>`;
  html += `</div>\n`;

  if (linDisplay.length > 0) {
    html += `    <div class="results-grid">\n`;
    for (const r of linDisplay) {
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
  html += `  </div>\n`;

  // Depicted person results (show top 8 of up to 50)
  const perDisplay = (per?.results || []).slice(0, 8);
  html += `  <div class="mode-section">
    <div class="mode-label">Depicted Person <span class="count">(${perDisplay.length} shown / ${per?.returnedCount ?? 0} found)</span>`;
  if (per?.warnings?.length) html += ` <span class="warning">${escHtml(per.warnings[0])}</span>`;
  html += `</div>\n`;

  if (perDisplay.length > 0) {
    html += `    <div class="results-grid">\n`;
    for (const r of perDisplay) {
      const persons = (r.sharedPersons || []).map(p => escHtml(p.label)).join(", ");
      const personTooltip = (r.sharedPersons || []).map(p => `${escHtml(p.label)} (IDF ${p.weight?.toFixed(1)})`).join("\n");
      html += `      <div class="result-card">
        <a href="${collectionUrl(r.objectNumber)}" target="_blank">
          ${imgTag(r.objectNumber, r.title)}
          <div class="title">${escHtml(r.title)}</div>
        </a>
        <div class="score">[${r.score}] ${escHtml(r.type || "")}${r.date ? ` ${r.date}` : ""}</div>
        <div class="shared" title="${personTooltip}">${r.sharedPersons?.length || 0} shared: ${persons}</div>
      </div>\n`;
    }
    html += `    </div>\n`;
  } else {
    html += `    <div class="no-results">No person-similar artworks found.</div>\n`;
  }
  html += `  </div>\n</div>\n`;
}

html += `</body></html>`;

const outPath = path.join(__dirname, "similarity-review-paintings.html");
fs.writeFileSync(outPath, html, "utf-8");
vocabDb.close();
console.error(`\nWritten to ${outPath}`);
console.log(outPath);
