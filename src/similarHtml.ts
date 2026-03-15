/**
 * Server-side HTML generator for find_similar comparison pages.
 *
 * Produces a self-contained HTML page showing similarity results across
 * up to 6 signal modes in horizontal scroll rows (Visual, Lineage,
 * Iconclass, Description, Depicted Person, Depicted Place) plus a pooled
 * row for artworks appearing in ≥2 modes.
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
  /** Shared Iconclass notation codes (for per-card links) */
  sharedNotations?: string[];
  /** Lineage qualifier label for per-card display */
  qualifierLabel?: string;
  /** Getty AAT URI for the qualifier */
  qualifierUri?: string;
  /** Creator referenced by the lineage qualifier */
  qualifierCreator?: string;
  /** Truncated description snippet for description cards */
  descSnippet?: string;
  /** Shared depicted person/place terms for per-card display */
  sharedTerms?: { label: string; wikidataUri?: string }[];
}

export interface SimilarQueryInfo {
  objectNumber: string;
  title: string;
  creator: string;
  date?: string;
  type?: string;
  iiifId?: string;
  description?: string;
  /** Iconclass codes assigned to the query artwork */
  iconclassCodes?: { notation: string; label: string }[];
  /** Lineage qualifiers on the query artwork */
  lineageQualifiers?: { label: string; aatUri: string; creator: string }[];
  /** Depicted persons on the query artwork */
  depictedPersons?: { label: string; wikidataUri?: string }[];
  /** Depicted places on the query artwork (after filtering) */
  depictedPlaces?: { label: string; wikidataUri?: string }[];
}

export interface SimilarPageData {
  query: SimilarQueryInfo;
  modes: {
    iconclass: SimilarCandidate[];
    lineage: SimilarCandidate[];
    description: SimilarCandidate[];
    visual?: SimilarCandidate[];
    depictedPerson?: SimilarCandidate[];
    depictedPlace?: SimilarCandidate[];
  };
  /** Minimum number of modes an artwork must appear in for the pooled row */
  poolThreshold: number;
  generatedAt: string;
  /** URL to full visual search results on rijksmuseum.nl (if available) */
  visualSearchUrl?: string;
  /** Total visual results available (for "See all N+" link) */
  visualTotalResults?: number;
}

// ─── HTML generation ────────────────────────────────────────────────

/** Render order and styling for each signal mode */
const MODE_INFO: Record<string, { label: string; badge: string; color: string; methodology: string }> = {
  visual: {
    label: "Visual",
    badge: "V",
    color: "#00838f",
    methodology:
      "The Rijksmuseum&rsquo;s own image-based visual similarity model. " +
      "87% of all artworks have digital images.",
  },
  description: {
    label: "Description",
    badge: "Desc",
    color: "#e65100",
    methodology:
      "Artworks with semantically similar Dutch catalogue descriptions. " +
      "Shared generic structural phrases, " +
      "(&ldquo;Links een X, rechts een Y&rdquo;) can artificially inflate scores for visually dissimilar works.",
  },
  iconclass: {
    label: "Iconclass",
    badge: "IC",
    color: "#1565c0",
    methodology:
      "Artworks sharing the same <a href='https://iconclass.org' target='_blank'>Iconclass</a> subject codes. " +
      "Deeper codes (more specific scenes) that appear on fewer artworks " +
      "contribute more. Single shallow matches are pruned.",
  },
  lineage: {
    label: "Lineage",
    badge: "Lin",
    color: "#6a1b9a",
    methodology:
      "Artworks sharing visual-style lineage &mdash; works <em>after</em> the same artist, from the same " +
      "<em>workshop</em>, <em>attributed to</em> the same hand, or in the same <em>circle</em>. " +
      "Score weighted by <strong>qualifier strength</strong>: " +
      "&ldquo;after&rdquo;/&ldquo;copyist of&rdquo; (3&times;), &ldquo;workshop of&rdquo; (2&times;), " +
      "&ldquo;attributed to&rdquo; (1.5&times;), &ldquo;circle of&rdquo;/&ldquo;follower of&rdquo; (1&times;); " +
      "rarer creators contribute more.",
  },
  depictedPerson: {
    label: "Depicted Person",
    badge: "Per",
    color: "#2e7d32",
    methodology:
      "Artworks depicting the same historical figures or named individuals. " +
      "People appearing on fewer artworks contribute more.",
  },
  depictedPlace: {
    label: "Depicted Place",
    badge: "Pl",
    color: "#4e342e",
    methodology:
      "Artworks depicting the same specific sites &mdash; streets, buildings, monuments, waterways. " +
      "Rarer places contribute more. " +
      "Broader administrative regions (countries, provinces and cities) are excluded.",
  },
  pooled: {
    label: "Pooled",
    badge: "P",
    color: "#37474f",
    methodology: "",
  },
};

/** Display order for signal rows */
const MODE_ORDER = ["visual", "lineage", "iconclass", "description", "depictedPerson", "depictedPlace"] as const;

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Render a label as a link (if URI present) or plain escaped text. */
function renderOptionalLink(label: string, uri: string | undefined): string {
  return uri
    ? `<a href="${escHtml(uri)}" target="_blank">${escHtml(label)}</a>`
    : escHtml(label);
}

function iiifThumbUrl(iiifId: string, width = 250): string {
  return `https://iiif.micr.io/${iiifId}/full/${width},/0/default.jpg`;
}

function renderCardMetadata(c: SimilarCandidate, mode: string): string {
  if (mode === "iconclass" && c.sharedNotations && c.sharedNotations.length > 0) {
    const codes = c.sharedNotations.map(n =>
      `<a href="https://iconclass.org/${escHtml(n)}" target="_blank"><code>${escHtml(n)}</code></a>`
    ).join(" ");
    return `<div class="card-detail">${codes}</div>`;
  }
  if (mode === "lineage" && c.qualifierLabel) {
    const qualHtml = c.qualifierUri
      ? `<a href="${escHtml(c.qualifierUri)}" target="_blank"><code class="qualifier">${escHtml(c.qualifierLabel)}</code></a>`
      : `<code class="qualifier">${escHtml(c.qualifierLabel)}</code>`;
    const creator = c.qualifierCreator ? ` ${escHtml(c.qualifierCreator)}` : "";
    return `<div class="card-detail">${qualHtml}${creator}</div>`;
  }
  if (mode === "description" && c.descSnippet) {
    return `<div class="card-detail"><div class="desc-snippet">${escHtml(c.descSnippet)}</div></div>`;
  }
  if ((mode === "depictedPerson" || mode === "depictedPlace") && c.sharedTerms && c.sharedTerms.length > 0) {
    const labels = c.sharedTerms.map(t => renderOptionalLink(t.label, t.wikidataUri)).join(", ");
    return `<div class="card-detail">${labels}</div>`;
  }
  return "";
}

function renderCard(c: SimilarCandidate, rank: number, mode: string, modeSources?: string[]): string {
  const thumbHtml = c.iiifId
    ? `<a class="result-thumb-link" href="${escHtml(c.url)}" target="_blank">
         <img class="result-thumb" src="${escHtml(iiifThumbUrl(c.iiifId))}" alt="" loading="lazy"
              onerror="this.style.display='none'">
       </a>`
    : `<a class="result-thumb-link" href="${escHtml(c.url)}" target="_blank">
         <div class="result-thumb no-image">No image</div>
       </a>`;

  const scoreStr = mode === "visual"
    ? "" // Visual has no scores from the Rijksmuseum API
    : ` &mdash; ${c.score.toFixed(2)}`;
  const sourcesBadges = modeSources
    ? modeSources.map(m => {
        const info = MODE_INFO[m] || { label: m, badge: m.charAt(0), color: "#888" };
        return `<span class="mode-badge" style="background:${info.color}">${escHtml(info.badge)}</span>`;
      }).join("")
    : "";

  const metaHtml = renderCardMetadata(c, mode);

  return `<div class="result-card">
    ${thumbHtml}
    <div class="result-info">
      <div class="rank-sim">#${rank}${scoreStr}${sourcesBadges ? ` ${sourcesBadges}` : ""}</div>
      <div class="title">${escHtml(c.title || "(untitled)")}</div>
      <div class="creator">${escHtml(c.creator || "unknown")}</div>
      <a class="obj-link" href="${escHtml(c.url)}" target="_blank">${escHtml(c.objectNumber)}</a>
    </div>
    ${metaHtml}
  </div>`;
}

function renderRow(
  mode: string,
  label: string,
  color: string,
  methodology: string,
  candidates: SimilarCandidate[],
  options?: { seeAllUrl?: string; seeAllCount?: number; pooledSources?: Map<string, string[]> },
): string {
  const isPooled = mode === "pooled";
  const count = candidates.length;
  if (count === 0 && !isPooled) return ""; // skip empty signal rows (except pooled which can be informative)
  const emptyMsg = count === 0
    ? `<div class="empty-row">No results for this type of similarity.</div>`
    : "";

  const countLabel = options?.seeAllCount
    ? `${count} of ${options.seeAllCount}+ results`
    : `${count} results`;

  const methodHtml = methodology
    ? `<div class="row-method">${methodology}</div>`
    : "";

  const cards = candidates.map((c, i) => {
    const sources = isPooled ? options?.pooledSources?.get(c.objectNumber) : undefined;
    return renderCard(c, i + 1, mode, sources);
  }).join("\n");

  const seeAllCard = options?.seeAllUrl
    ? `<a class="see-all-card" href="${escHtml(options.seeAllUrl)}" target="_blank">
         See all ${options.seeAllCount ?? ""}+<br>visual matches<br>on rijksmuseum.nl &rarr;
       </a>`
    : "";

  return `<div class="signal-row">
    <div class="row-header">
      <span class="row-label" style="color:${color}">${escHtml(label)}</span>
      <span class="row-count">${countLabel}</span>
    </div>
    ${methodHtml}
    ${emptyMsg}
    <div class="strip-container">
      <div class="cards-strip">
        ${cards}
        ${seeAllCard}
      </div>
    </div>
  </div>`;
}

export function generateSimilarHtml(data: SimilarPageData): string {
  const { query, modes, poolThreshold, generatedAt } = data;

  // Compute pooled: artworks appearing in ≥ poolThreshold modes
  const modeNames = MODE_ORDER.filter(m => m in modes && (modes as Record<string, SimilarCandidate[]>)[m]?.length > 0);
  const objectModes = new Map<string, { candidate: SimilarCandidate; sources: string[]; bestScore: number }>();

  for (const mode of modeNames) {
    const candidates = (modes as Record<string, SimilarCandidate[]>)[mode] ?? [];
    for (const c of candidates) {
      const existing = objectModes.get(c.objectNumber);
      if (existing) {
        existing.sources.push(mode);
        if (c.score > existing.bestScore) {
          existing.bestScore = c.score;
          existing.candidate = c;
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
    : `<div class="query-thumb no-image">No image available</div>`;

  const queryType = query.type ? `<span class="type-badge">${escHtml(query.type)}</span>` : "";
  const queryDate = query.date ? ` (${escHtml(query.date)})` : "";

  // Build metadata sections for header
  let metaSections = "";

  if (query.description) {
    metaSections += `<div class="meta-section">
      <div class="meta-section-label description">Description</div>
      <div class="meta-desc">${escHtml(query.description)}</div>
    </div>`;
  }

  if (query.iconclassCodes && query.iconclassCodes.length > 0) {
    const codesHtml = query.iconclassCodes.map(c =>
      `<a href="https://iconclass.org/${escHtml(c.notation)}" target="_blank"><code>${escHtml(c.notation)}</code></a> ${escHtml(c.label)}`
    ).join(" &middot; ");
    metaSections += `<div class="meta-section">
      <div class="meta-section-label iconclass">Iconclass</div>
      <div class="meta-content">${codesHtml}</div>
    </div>`;
  }

  if (query.lineageQualifiers && query.lineageQualifiers.length > 0) {
    const lineageHtml = query.lineageQualifiers.map(q =>
      `<a href="${escHtml(q.aatUri)}" target="_blank"><code class="qualifier">${escHtml(q.label)}</code></a> ${escHtml(q.creator)}`
    ).join(" &middot; ");
    metaSections += `<div class="meta-section">
      <div class="meta-section-label lineage">Lineage</div>
      <div class="meta-content">${lineageHtml}</div>
    </div>`;
  }

  if (query.depictedPersons && query.depictedPersons.length > 0) {
    const personsHtml = query.depictedPersons.map(p => renderOptionalLink(p.label, p.wikidataUri)).join(" &middot; ");
    metaSections += `<div class="meta-section">
      <div class="meta-section-label depicted-person">Depicted Persons</div>
      <div class="meta-content">${personsHtml}</div>
    </div>`;
  }

  if (query.depictedPlaces && query.depictedPlaces.length > 0) {
    const placesHtml = query.depictedPlaces.map(p => renderOptionalLink(p.label, p.wikidataUri)).join(" &middot; ");
    metaSections += `<div class="meta-section">
      <div class="meta-section-label depicted-place">Depicted Places</div>
      <div class="meta-content">${placesHtml}</div>
    </div>`;
  }

  const queryMetaHtml = metaSections
    ? `<div class="query-metadata">${metaSections}</div>`
    : "";

  // Signal rows (ordered: Visual, Lineage, Iconclass, Description, Depicted Person, Depicted Place)
  const rows: string[] = [];
  for (const mode of MODE_ORDER) {
    const candidates = (modes as Record<string, SimilarCandidate[] | undefined>)[mode] ?? [];
    if (candidates.length === 0) continue;
    const info = MODE_INFO[mode];
    const rowOptions = mode === "visual"
      ? { seeAllUrl: data.visualSearchUrl, seeAllCount: data.visualTotalResults }
      : undefined;
    rows.push(renderRow(mode, info.label, info.color, info.methodology, candidates, rowOptions));
  }

  // Pooled row
  const pooledInfo = MODE_INFO.pooled;
  const pooledMethodology = `Artworks appearing in <strong>${poolThreshold}+</strong> of the ${modeNames.length} forms of similarity above. ` +
    `The scores and icons show which and how many forms agree.`;
  rows.push(renderRow("pooled", pooledInfo.label, pooledInfo.color, pooledMethodology, pooled, { pooledSources }));

  // Count totals
  const totalUnique = objectModes.size;
  const modeCounts = modeNames.map(m => `${MODE_INFO[m].label}: ${(modes as Record<string, SimilarCandidate[]>)[m]?.length ?? 0}`).join(" | ");

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
                  padding: 20px; margin-bottom: 24px;
                  display: flex; align-items: flex-start; gap: 20px; }
  .query-thumb { width: 300px; max-height: 420px; object-fit: contain; border-radius: 4px;
                 flex-shrink: 0; background: #eee; }
  .query-thumb.no-image { height: 200px; display: flex; align-items: center;
                          justify-content: center; color: #bbb; font-size: 0.9em; }
  .query-info { flex: 1; min-width: 0; }
  .query-info h2 { font-size: 1.2em; margin-bottom: 4px; }
  .query-info .obj-num { font-size: 0.85em; color: #0066cc; text-decoration: none; }
  .query-info .obj-num:hover { text-decoration: underline; }
  .query-info .creator { font-size: 0.9em; color: #555; margin-top: 2px; }
  .type-badge { display: inline-block; font-size: 0.7em; background: #e8e8e8;
                padding: 1px 6px; border-radius: 3px; margin-left: 6px; color: #555; }

  .query-metadata { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; }
  .meta-section { font-size: 0.8em; line-height: 1.5; }
  .meta-section-label { font-weight: 600; font-size: 0.75em; text-transform: uppercase;
                        letter-spacing: 0.03em; margin-bottom: 3px; }
  .meta-section-label.iconclass { color: #1565c0; }
  .meta-section-label.lineage { color: #6a1b9a; }
  .meta-section-label.description { color: #e65100; }
  .meta-section-label.depicted-person { color: #2e7d32; }
  .meta-section-label.depicted-place { color: #4e342e; }
  .meta-section .meta-content { color: #555; }
  .meta-section .meta-content a { text-decoration: none; }
  .meta-section .meta-content a:hover code { text-decoration: underline; }
  .meta-section .meta-content code { font-family: "SF Mono", "Menlo", monospace;
                                      font-size: 0.88em; background: #f0f4f8;
                                      padding: 1px 5px; border-radius: 3px; color: #1565c0; }
  .meta-section .meta-content .qualifier { background: #f3e5f5; color: #6a1b9a; }
  .meta-section .meta-content a:hover .qualifier { text-decoration: underline; }
  .meta-desc { color: #555; font-size: 1em; line-height: 1.45; }

  .signal-rows { display: flex; flex-direction: column; gap: 20px; }

  .signal-row { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                padding: 16px; overflow: hidden; }
  .row-header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
  .row-label { font-size: 0.95em; font-weight: 600; }
  .row-count { font-size: 0.75em; color: #888; }
  .row-method { font-size: 0.72em; color: #888; line-height: 1.3; margin-bottom: 12px;
                max-width: 80ch; }
  .row-method a { color: #0066cc; }
  .row-method strong { font-weight: 600; color: #666; }
  .empty-row { font-size: 0.85em; color: #999; font-style: italic; padding: 12px 0; }

  .strip-container { position: relative; }
  .strip-container::after { content: ''; position: absolute; top: 0; right: 0;
                            width: 40px; height: 100%; pointer-events: none;
                            background: linear-gradient(to right, transparent, rgba(255,255,255,0.8)); }
  .cards-strip { display: flex; gap: 14px; overflow-x: auto; padding-bottom: 8px;
                 scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; }
  .cards-strip::-webkit-scrollbar { height: 6px; }
  .cards-strip::-webkit-scrollbar-track { background: #f0f0f0; border-radius: 3px; }
  .cards-strip::-webkit-scrollbar-thumb { background: #ccc; border-radius: 3px; }
  .cards-strip::-webkit-scrollbar-thumb:hover { background: #aaa; }

  .result-card { flex: 0 0 200px; scroll-snap-align: start; display: flex;
                 flex-direction: column; gap: 6px; padding: 10px;
                 border-radius: 6px; border: 1px solid #f0f0f0; }
  .result-card:hover { border-color: #ddd; background: #fafafa; }
  .result-thumb { width: 100%; aspect-ratio: 3/4; object-fit: contain; border-radius: 4px;
                  background: #f5f5f5; }
  .result-thumb.no-image { display: flex; align-items: center; justify-content: center;
                           background: #f0f0f0; color: #bbb; font-size: 0.8em; }
  .result-thumb-link { display: block; }
  .result-info { font-size: 0.78em; }
  .result-info .rank-sim { font-weight: 600; color: #333; }
  .result-info .title { margin-top: 2px; color: #444; display: -webkit-box;
                        -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .result-info .creator { color: #666; margin-top: 1px; white-space: nowrap;
                          overflow: hidden; text-overflow: ellipsis; }
  .result-info .obj-link { font-size: 0.85em; color: #0066cc; text-decoration: none; }
  .result-info .obj-link:hover { text-decoration: underline; }

  .card-detail { font-size: 0.7em; margin-top: 4px; padding-top: 4px;
                 border-top: 1px solid #f0f0f0; color: #888; line-height: 1.35; }
  .card-detail a { text-decoration: none; }
  .card-detail a:hover code { text-decoration: underline; }
  .card-detail code { font-family: "SF Mono", "Menlo", monospace; font-size: 0.9em;
                      background: #f0f4f8; padding: 0px 3px; border-radius: 2px; color: #1565c0; }
  .card-detail .qualifier { background: #f3e5f5; color: #6a1b9a; }
  .card-detail a:hover .qualifier { text-decoration: underline; }
  .card-detail .desc-snippet { color: #777; display: -webkit-box;
                               -webkit-line-clamp: 4; -webkit-box-orient: vertical;
                               overflow: hidden; font-style: italic; }

  .see-all-card { flex: 0 0 160px; scroll-snap-align: start; display: flex;
                  align-items: center; justify-content: center; padding: 20px;
                  border-radius: 6px; border: 1px dashed #ccc; background: #f8f8f8;
                  text-decoration: none; color: #0066cc; font-size: 0.85em;
                  text-align: center; line-height: 1.4; min-height: 200px; }
  .see-all-card:hover { background: #f0f0f0; border-color: #aaa; }

  .mode-badge { display: inline-block; font-size: 0.55em; color: #fff; padding: 1px 4px;
                border-radius: 3px; margin-left: 2px; vertical-align: middle; }

  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e0e0e0;
            font-size: 0.75em; color: #999; }
  .footer a { color: #999; text-decoration: underline; }
  .footer a:hover { color: #666; }

  @media (max-width: 700px) {
    .query-header { flex-direction: column; }
    .query-thumb { width: 100%; max-height: 300px; }
  }
</style>
</head>
<body>

<h1>Find Similar: ${escHtml(query.title || query.objectNumber)}</h1>
<p class="subtitle">${modeCounts} | ${totalUnique} unique | pooled: ${poolThreshold}+ types | ${escHtml(generatedAt)}</p>

<div class="query-header">
  ${queryThumb}
  <div class="query-info">
    <h2>${escHtml(query.title || "(untitled)")}${queryType}</h2>
    <div class="creator">${escHtml(query.creator || "unknown")}${queryDate}</div>
    <a class="obj-num" href="${escHtml(`https://www.rijksmuseum.nl/en/collection/${query.objectNumber}`)}" target="_blank">${escHtml(query.objectNumber)}</a>
    ${queryMetaHtml}
  </div>
</div>

<div class="signal-rows">
  ${rows.join("\n")}
</div>

<div class="footer">
  Generated by <a href="https://github.com/kintopp/rijksmuseum-mcp-plus" target="_blank">rijksmuseum-mcp+</a> find_similar | ${escHtml(generatedAt)}
</div>

</body>
</html>`;
}
