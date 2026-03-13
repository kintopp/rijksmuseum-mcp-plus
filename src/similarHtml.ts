/**
 * Server-side HTML generator for find_similar comparison pages.
 *
 * Produces a self-contained HTML page showing similarity results across
 * 4 independent signal modes (iconclass, lineage, depicted_person, description)
 * plus a pooled column for artworks appearing in ≥3 modes.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface SimilarCandidate {
  objectNumber: string;
  title: string;
  creator: string;
  date?: string;
  type?: string;
  iiifId?: string;
  score: number;
  url: string;
  /** Mode-specific detail line (e.g. shared motifs, lineage pairs) */
  detail?: string;
}

export interface SimilarQueryInfo {
  objectNumber: string;
  title: string;
  creator: string;
  date?: string;
  type?: string;
  iiifId?: string;
  description?: string;
}

export interface SimilarPageData {
  query: SimilarQueryInfo;
  modes: {
    iconclass: SimilarCandidate[];
    lineage: SimilarCandidate[];
    depicted_person: SimilarCandidate[];
    description: SimilarCandidate[];
  };
  /** Minimum number of modes an artwork must appear in for the pooled column */
  poolThreshold: number;
  generatedAt: string;
}

// ─── HTML generation ────────────────────────────────────────────────

const MODE_LABELS: Record<string, { label: string; color: string; description: string }> = {
  iconclass: { label: "Iconclass", color: "#1565c0", description: "Shared subject classifications" },
  lineage: { label: "Lineage", color: "#6a1b9a", description: "Shared visual-style lineage" },
  depicted_person: { label: "Persons", color: "#2e7d32", description: "Shared depicted persons" },
  description: { label: "Description", color: "#e65100", description: "Similar catalogue descriptions" },
  pooled: { label: "Pooled", color: "#37474f", description: "" },
};

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function iiifThumbUrl(iiifId: string, width = 240): string {
  return `https://iiif.micr.io/${iiifId}/full/${width},/0/default.jpg`;
}

function collectionUrl(objectNumber: string): string {
  return `https://www.rijksmuseum.nl/en/collection/${objectNumber}`;
}

function renderCard(c: SimilarCandidate, rank: number, modeSources?: string[]): string {
  const thumbHtml = c.iiifId
    ? `<a class="result-thumb-link" href="${escHtml(c.url)}" target="_blank">
         <img class="result-thumb" src="${escHtml(iiifThumbUrl(c.iiifId))}" alt="" loading="lazy"
              onerror="this.style.display='none'">
       </a>`
    : `<div class="result-thumb no-image">No image</div>`;

  const dateLine = c.date ? `<span class="date">${escHtml(c.date)}</span>` : "";
  const typeBadge = c.type ? `<span class="type-badge">${escHtml(c.type)}</span>` : "";
  const detailHtml = c.detail
    ? `<div class="detail">${escHtml(c.detail)}</div>`
    : "";
  const sourcesBadges = modeSources
    ? modeSources.map(m => {
        const info = MODE_LABELS[m] || { label: m, color: "#888" };
        return `<span class="mode-badge" style="background:${info.color}">${escHtml(info.label)}</span>`;
      }).join(" ")
    : "";

  return `<div class="result-card">
    ${thumbHtml}
    <div class="result-info">
      <div class="rank-sim">#${rank} &mdash; ${c.score.toFixed(2)}${sourcesBadges ? ` ${sourcesBadges}` : ""}</div>
      <div class="title">${escHtml(c.title || "(untitled)")}${typeBadge}</div>
      <div class="creator">${escHtml(c.creator || "unknown")}</div>
      ${dateLine ? `<div class="date-line">${dateLine}</div>` : ""}
      <a class="obj-link" href="${escHtml(c.url)}" target="_blank">${escHtml(c.objectNumber)}</a>
      ${detailHtml}
    </div>
  </div>`;
}

function renderColumn(label: string, color: string, description: string, candidates: SimilarCandidate[], pooledSources?: Map<string, string[]>): string {
  const isPooled = label === "Pooled";
  const headerExtra = description ? ` <span class="col-desc">${escHtml(description)}</span>` : "";
  const count = candidates.length;
  const emptyMsg = count === 0
    ? `<div class="empty-col">No results for this signal.</div>`
    : "";

  const cards = candidates.map((c, i) => {
    const sources = isPooled ? pooledSources?.get(c.objectNumber) : undefined;
    return renderCard(c, i + 1, sources);
  }).join("\n");

  return `<div class="column">
    <div class="col-header" style="border-bottom-color:${color}">
      <span class="col-label" style="color:${color}">${escHtml(label)}</span>
      <span class="col-count">${count}</span>${headerExtra}
    </div>
    ${emptyMsg}${cards}
  </div>`;
}

export function generateSimilarHtml(data: SimilarPageData): string {
  const { query, modes, poolThreshold, generatedAt } = data;

  // Compute pooled: artworks appearing in ≥ poolThreshold modes
  const modeNames = Object.keys(modes) as (keyof typeof modes)[];
  const objectModes = new Map<string, { candidate: SimilarCandidate; sources: string[]; bestScore: number }>();

  for (const mode of modeNames) {
    for (const c of modes[mode]) {
      const existing = objectModes.get(c.objectNumber);
      if (existing) {
        existing.sources.push(mode);
        if (c.score > existing.bestScore) {
          existing.bestScore = c.score;
          existing.candidate = c; // keep the version with the best score
        }
      } else {
        objectModes.set(c.objectNumber, { candidate: c, sources: [mode], bestScore: c.score });
      }
    }
  }

  const pooled: SimilarCandidate[] = [];
  const pooledSources = new Map<string, string[]>();
  for (const [objNum, entry] of objectModes) {
    if (entry.sources.length >= poolThreshold) {
      pooled.push({ ...entry.candidate, score: entry.sources.length });
      pooledSources.set(objNum, entry.sources);
    }
  }
  pooled.sort((a, b) => b.score - a.score || a.objectNumber.localeCompare(b.objectNumber));

  // Query artwork header
  const queryThumb = query.iiifId
    ? `<img class="query-thumb" src="${escHtml(iiifThumbUrl(query.iiifId, 300))}" alt="" loading="lazy"
           onerror="this.style.display='none'">`
    : "";

  const queryType = query.type ? `<span class="type-badge">${escHtml(query.type)}</span>` : "";
  const queryDate = query.date ? ` (${escHtml(query.date)})` : "";
  const queryDesc = query.description
    ? `<div class="desc collapsed" onclick="this.classList.toggle('collapsed')" title="Click to expand">${escHtml(query.description)}</div>`
    : "";

  // Mode columns
  const columns = modeNames.map(mode => {
    const info = MODE_LABELS[mode];
    return renderColumn(info.label, info.color, info.description, modes[mode]);
  });

  // Pooled column
  const pooledInfo = MODE_LABELS.pooled;
  const pooledDesc = `Artworks appearing in ${poolThreshold}+ signal modes`;
  columns.push(renderColumn(pooledInfo.label, pooledInfo.color, pooledDesc, pooled, pooledSources));

  // Count totals
  const totalUnique = objectModes.size;
  const modeCounts = modeNames.map(m => `${MODE_LABELS[m].label}: ${modes[m].length}`).join(" | ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Similar to: ${escHtml(query.title || query.objectNumber)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0 auto; padding: 20px; background: #fafafa; color: #222; }
  h1 { font-size: 1.4em; margin-bottom: 4px; }
  .subtitle { color: #666; font-size: 0.85em; margin-bottom: 20px; }

  .query-header { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                  padding: 16px; margin-bottom: 24px;
                  display: flex; align-items: flex-start; gap: 16px; }
  .query-thumb { width: 300px; max-height: 400px; object-fit: contain; border-radius: 4px;
                 flex-shrink: 0; background: #eee; }
  .query-info { flex: 1; }
  .query-info h2 { font-size: 1.2em; margin-bottom: 4px; }
  .query-info .obj-num { font-size: 0.85em; color: #0066cc; text-decoration: none; }
  .query-info .obj-num:hover { text-decoration: underline; }
  .query-info .creator { font-size: 0.9em; color: #555; margin-top: 2px; }
  .query-info .desc { font-size: 0.8em; color: #555; margin-top: 8px; cursor: pointer;
                      line-height: 1.4; }
  .query-info .desc.collapsed { max-height: 3.6em; overflow: hidden; }
  .type-badge { display: inline-block; font-size: 0.7em; background: #e8e8e8;
                padding: 1px 6px; border-radius: 3px; margin-left: 6px; color: #555; }

  .columns-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; }
  @media (max-width: 1400px) { .columns-grid { grid-template-columns: repeat(3, 1fr); } }
  @media (max-width: 900px) { .columns-grid { grid-template-columns: 1fr; } }

  .column { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            padding: 12px; min-width: 0; }
  .col-header { font-size: 0.9em; font-weight: 600; margin-bottom: 10px;
                padding-bottom: 6px; border-bottom: 3px solid; display: flex;
                align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .col-label { font-size: 1em; }
  .col-count { font-size: 0.75em; color: #888; }
  .col-desc { font-size: 0.7em; color: #999; font-weight: normal; }
  .empty-col { font-size: 0.85em; color: #999; font-style: italic; padding: 12px 0; }

  .result-card { display: flex; gap: 8px; padding: 8px; border-radius: 6px; margin-bottom: 8px;
                 border: 1px solid #f0f0f0; }
  .result-card:hover { background: #fafafa; border-color: #ddd; }
  .result-thumb { width: 120px; max-height: 160px; object-fit: contain; border-radius: 4px;
                  flex-shrink: 0; background: #f5f5f5; }
  .result-thumb.no-image { width: 120px; height: 80px; display: flex; align-items: center;
                           justify-content: center; background: #f0f0f0; color: #bbb;
                           font-size: 0.75em; border-radius: 4px; flex-shrink: 0; }
  .result-thumb-link { flex-shrink: 0; }
  .result-info { flex: 1; font-size: 0.8em; min-width: 0; }
  .result-info .rank-sim { font-weight: 600; color: #333; }
  .result-info .title { margin-top: 2px; color: #444; overflow: hidden; text-overflow: ellipsis; }
  .result-info .creator { color: #666; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; }
  .result-info .date-line { color: #888; font-size: 0.9em; }
  .result-info .obj-link { font-size: 0.85em; color: #0066cc; text-decoration: none; }
  .result-info .obj-link:hover { text-decoration: underline; }
  .result-info .detail { color: #777; font-size: 0.85em; margin-top: 4px; line-height: 1.3;
                         max-height: 3.9em; overflow: hidden; }
  .mode-badge { display: inline-block; font-size: 0.6em; color: #fff; padding: 1px 5px;
                border-radius: 3px; margin-left: 3px; vertical-align: middle; }

  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e0e0e0;
            font-size: 0.75em; color: #999; }
</style>
</head>
<body>

<h1>Find Similar: ${escHtml(query.title || query.objectNumber)}</h1>
<p class="subtitle">${modeCounts} | ${totalUnique} unique | pooled threshold: ${poolThreshold}+ modes | ${escHtml(generatedAt)}</p>

<div class="query-header">
  ${queryThumb}
  <div class="query-info">
    <h2>${escHtml(query.title || "(untitled)")}${queryType}</h2>
    <div class="creator">${escHtml(query.creator || "unknown")}${queryDate}</div>
    <a class="obj-num" href="${escHtml(collectionUrl(query.objectNumber))}" target="_blank">${escHtml(query.objectNumber)}</a>
    ${queryDesc}
  </div>
</div>

<div class="columns-grid">
  ${columns.join("\n")}
</div>

<div class="footer">
  Generated by rijksmuseum-mcp+ find_similar | ${escHtml(generatedAt)}
</div>

</body>
</html>`;
}
