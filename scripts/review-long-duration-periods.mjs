/**
 * Generate HTML review page for #178: long-duration periods (>200 years).
 *
 * Classifies each period as:
 *   - legitimate: institutional/ecclesiastical ownership spanning centuries
 *   - artifact: date inference error (creation date leak, wrong begin/end year)
 *
 * Usage:
 *   node scripts/review-long-duration-periods.mjs [--db PATH] [--output PATH]
 */

import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const dbPath = args.includes("--db") ? args[args.indexOf("--db") + 1] : "data/vocabulary.db";
const outputPath = args.includes("--output") ? args[args.indexOf("--output") + 1] : "data/long-duration-review.html";

const db = new Database(dbPath, { readonly: true });

// ─── Load data ──────────────────────────────────────────────────────

const periods = db.prepare(`
  SELECT pp.artwork_id, a.object_number, a.title, a.creator_label,
    a.date_earliest, a.date_latest, a.provenance_text,
    pp.sequence, pp.owner_name, pp.acquisition_method, pp.acquisition_from,
    pp.begin_year, pp.end_year, (pp.end_year - pp.begin_year) as duration,
    pp.uncertain, pp.derivation, pp.source_events
  FROM provenance_periods pp
  JOIN artworks a ON a.art_id = pp.artwork_id
  WHERE pp.begin_year IS NOT NULL AND pp.end_year IS NOT NULL AND (pp.end_year - pp.begin_year) > 200
  ORDER BY (pp.end_year - pp.begin_year) DESC
`).all();

// Load all events for these artworks
const eventsByArtwork = new Map();
const artworkIds = [...new Set(periods.map(p => p.artwork_id))];
for (const artId of artworkIds) {
  const events = db.prepare(`
    SELECT sequence, raw_text, transfer_type, unsold, date_year, location, parties
    FROM provenance_events WHERE artwork_id = ? ORDER BY sequence
  `).all(artId);
  eventsByArtwork.set(artId, events);
}

// Load all periods for these artworks (for full chain context)
const allPeriodsByArtwork = new Map();
for (const artId of artworkIds) {
  const allP = db.prepare(`
    SELECT sequence, owner_name, acquisition_method, begin_year, end_year,
      (CASE WHEN end_year IS NOT NULL AND begin_year IS NOT NULL THEN end_year - begin_year ELSE NULL END) as duration
    FROM provenance_periods WHERE artwork_id = ? ORDER BY sequence
  `).all(artId);
  allPeriodsByArtwork.set(artId, allP);
}

db.close();

// ─── Classification logic ───────────────────────────────────────────

// Keywords/patterns indicating institutional or ecclesiastical ownership
const INSTITUTIONAL_RE = /\b(?:kerk|church|chapel|kapel|cathedral|kathedraal|monastery|klooster|abbey|abdij|convent|priory|priorij|friary|museum|stichting|foundation|genootschap|gemeente|stad|city|town|staat|state|kingdom|rijk|republic|republiek|universiteit|university|bibliotheek|library|hospital|gasthuis|weeshuis|paleis|palace|kasteel|castle|schloss|slot|hof|court|raad|council|parochie|parish|bisdom|diocese|orde|order|huis|house|arsenaal|arsenal|admiraliteit|compagnie|gilde|guild|sint|saint|st\.|notre.dame|Maria|Laurens|Pieterskerk|Janskerk|Bavo|Martinikerk|confraternity|broederschap|brotherhood)\b/i;

const ECCLESIASTICAL_OWNER_RE = /\b(?:carthusian|benedictine|franciscan|dominican|augustinian|jesuit|carmelite|cistercian|Onze.Lieve.Vrouwe|Sint|Saint|St\.|Notre|Holy|Church|Kerk|Chapel|Kapel|Cathedral|Dom|Minster|Abbey|Priory|Monastery|Convent|Friary)\b/i;

const BUILDING_CONTEXT_RE = /\b(?:installed|geplaatst|chimney|schoorsteenstuk|altarpiece|altaarstuk|organ|orgel|pulpit|preekstoel|tomb|graf|monument|facade|gevel|ceiling|plafond|wall|wand|floor|vloer|window|raam|door|deur|gate|poort)\b/i;

function classify(period, events, allPeriods) {
  const { owner_name, acquisition_method, begin_year, end_year, duration,
    date_earliest, date_latest, derivation } = period;

  let deriv = {};
  try { deriv = JSON.parse(derivation || "{}"); } catch { /* empty */ }

  // Check if begin_year matches creation date range (potential leak)
  const creationOverlap = date_earliest != null && date_latest != null &&
    begin_year >= date_earliest && begin_year <= date_latest;

  // Check if this is the first period (most likely to have creation date as begin)
  const isFirstPeriod = period.sequence === 1;

  // Check for institutional/ecclesiastical owner
  const ownerIsInstitutional = owner_name && INSTITUTIONAL_RE.test(owner_name);
  const ownerIsEcclesiastical = owner_name && ECCLESIASTICAL_OWNER_RE.test(owner_name);

  // Check if raw provenance text mentions building context
  const provText = period.provenance_text || "";
  const hasBuildingContext = BUILDING_CONTEXT_RE.test(provText);

  // Check if acquisition method is commission (commissioned works can legitimately
  // stay in one place for centuries)
  const isCommission = acquisition_method === "commission";

  // Check if the begin year derivation looks suspicious
  const beginFromCreation = deriv.beginYear === "creation_date" ||
    deriv.begin === "creation_date" ||
    (isFirstPeriod && creationOverlap && !owner_name);

  // Check source events
  let sourceEvents = [];
  try { sourceEvents = JSON.parse(period.source_events || "[]"); } catch { /* empty */ }

  // Get the actual event that sourced the begin year
  const beginEvent = events.find(e => sourceEvents.includes(e.sequence));

  // Check provenance text for institutional/building keywords (broader than just owner name)
  const provHasInstitutional = INSTITUTIONAL_RE.test(provText);
  const provHasEcclesiastical = ECCLESIASTICAL_OWNER_RE.test(provText);

  // Check if begin_year might come from a lot number parsed as year
  // (e.g. "no. 1346" → begin_year 1346, but creation date is 1640)
  const lotNumberArtifact = isFirstPeriod && date_earliest != null &&
    begin_year < date_earliest - 50 && !owner_name;

  // ── Decision tree ──

  // Strong artifact: lot number parsed as year (begin << creation date)
  if (lotNumberArtifact) {
    return {
      verdict: "artifact",
      confidence: 0.95,
      reasoning: `Begin year ${begin_year} is ${date_earliest - begin_year} years before creation date (${date_earliest}–${date_latest}). Likely a lot/catalogue number parsed as a year.`,
    };
  }

  // Strong artifact: first period, no owner, no method, overlaps creation date
  if (isFirstPeriod && creationOverlap && !owner_name && !acquisition_method) {
    return {
      verdict: "artifact",
      confidence: 0.90,
      reasoning: `First period with no owner/method, begin year ${begin_year} overlaps creation date range (${date_earliest}–${date_latest}). Likely creation date leaking into period begin year.`,
    };
  }

  // Strong legitimate: institutional/ecclesiastical owner
  if (ownerIsInstitutional || ownerIsEcclesiastical) {
    return {
      verdict: "legitimate",
      confidence: 0.95,
      reasoning: `Institutional/ecclesiastical owner "${owner_name}" — churches, museums, and institutions can hold artworks for centuries.`,
    };
  }

  // Strong legitimate: commission (object stayed in situ — facade, altar, church)
  if (isCommission) {
    const context = hasBuildingContext ? " in architectural context" : "";
    return {
      verdict: "legitimate",
      confidence: 0.90,
      reasoning: `Commissioned work${context} — "${owner_name || "(unnamed)"}" — commissioned objects (facades, altars, tombs) typically remained in situ for centuries.`,
    };
  }

  // Legitimate: named owner with inventory/collection + provenance has institutional context
  if (owner_name && (provHasInstitutional || provHasEcclesiastical || hasBuildingContext)) {
    return {
      verdict: "legitimate",
      confidence: 0.85,
      reasoning: `Owner "${owner_name}" in institutional/ecclesiastical provenance context. Long ownership is historically plausible.`,
    };
  }

  // Legitimate: deposit/transfer with institutional provenance context
  if ((acquisition_method === "deposit" || acquisition_method === "transfer") && (provHasInstitutional || provHasEcclesiastical)) {
    return {
      verdict: "legitimate",
      confidence: 0.85,
      reasoning: `${acquisition_method} in institutional context — object deposited/transferred within institutional custody spanning centuries.`,
    };
  }

  // Legitimate: named owner who is clearly a historical figure (life dates in name)
  if (owner_name && /\(\d{3,4}-\d{3,4}\)|\(\d{3,4}-\)|\(d\.\s+\d{3,4}\)|\(c\.\s+\d{3,4}/.test(owner_name)) {
    return {
      verdict: "legitimate",
      confidence: 0.80,
      reasoning: `Owner "${owner_name}" is a historical figure with life dates. Begin year ${begin_year} likely reflects their documented ownership.`,
    };
  }

  // Legitimate: named owner + sale/bequest/gift/inventory (real provenance event with named party)
  if (owner_name && ["sale", "bequest", "gift", "inventory", "collection", "by_descent", "widowhood", "loan"].includes(acquisition_method)) {
    return {
      verdict: "legitimate",
      confidence: 0.75,
      reasoning: `Named owner "${owner_name}" with documented acquisition (${acquisition_method}). Long duration may reflect gaps in provenance chain (undocumented intermediate owners).`,
    };
  }

  // Legitimate: family/collection/heirs keywords
  if (owner_name) {
    const lowerOwner = owner_name.toLowerCase();
    if (lowerOwner.includes("family") || lowerOwner.includes("heirs") ||
      lowerOwner.includes("collection") || lowerOwner.includes("erven") ||
      lowerOwner.includes("prince") || lowerOwner.includes("estates")) {
      return {
        verdict: "legitimate",
        confidence: 0.80,
        reasoning: `Family/dynasty/estate ownership ("${owner_name}") can span multiple generations over centuries.`,
      };
    }
  }

  // Review: first period overlapping creation date with collection type
  if (isFirstPeriod && creationOverlap && acquisition_method === "collection") {
    if (owner_name && /\b(?:artist|schilder|painter|maker)\b/i.test(owner_name)) {
      return {
        verdict: "legitimate",
        confidence: 0.75,
        reasoning: `First period, owner "${owner_name}" appears to be the creator. Begin year from creation date range is plausible.`,
      };
    }
    return {
      verdict: "review",
      confidence: 0.50,
      reasoning: `First period, collection type, begin year ${begin_year} overlaps creation date (${date_earliest}–${date_latest}). Owner "${owner_name || "(none)"}" — may be legitimate early provenance or creation date artifact.`,
    };
  }

  // Legitimate: provenance text has gap markers (…) indicating documented provenance gaps
  if (!owner_name && acquisition_method && provText.includes("…")) {
    return {
      verdict: "legitimate",
      confidence: 0.75,
      reasoning: `Provenance has documented gaps (…). The ${duration}-year period spans undocumented intermediate owners between known provenance points. This is a provenance gap, not a date artifact.`,
    };
  }

  // Artifact: no owner, no clear institutional context, no gap markers
  if (!owner_name && !provHasInstitutional && !provHasEcclesiastical) {
    return {
      verdict: "artifact",
      confidence: 0.70,
      reasoning: `No owner name, ${acquisition_method || "no acquisition method"}, ${duration}-year duration, no institutional context in provenance. Likely a date inference artifact.`,
    };
  }

  // Default review for anything we couldn't classify
  return {
    verdict: "review",
    confidence: 0.50,
    reasoning: `Owner "${owner_name || "none"}", ${acquisition_method || "no method"}, ${duration}-year duration. Requires manual verification.`,
  };
}

// ─── Classify all periods ───────────────────────────────────────────

const results = periods.map(period => {
  const events = eventsByArtwork.get(period.artwork_id) || [];
  const allPeriods = allPeriodsByArtwork.get(period.artwork_id) || [];
  const classification = classify(period, events, allPeriods);
  return { ...period, ...classification };
});

// ─── Stats ──────────────────────────────────────────────────────────

const verdictCounts = { legitimate: 0, artifact: 0, review: 0 };
for (const r of results) verdictCounts[r.verdict]++;

console.log(`Long-duration period review`);
console.log(`  Total: ${results.length}`);
console.log(`  Legitimate: ${verdictCounts.legitimate}`);
console.log(`  Artifact: ${verdictCounts.artifact}`);
console.log(`  Needs review: ${verdictCounts.review}`);

// ─── Generate HTML ──────────────────────────────────────────────────

function escHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function verdictBadgeClass(verdict) {
  if (verdict === "legitimate") return "badge-legitimate";
  if (verdict === "artifact") return "badge-artifact";
  return "badge-review";
}

function formatEvents(events, sourceEvents) {
  let srcSet;
  try { srcSet = new Set(JSON.parse(sourceEvents || "[]")); } catch { srcSet = new Set(); }
  return events.map(e => {
    const cls = srcSet.has(e.sequence) ? "highlight" : "context";
    const type = e.transfer_type !== "unknown" ? ` <span class="type-tag">[${e.transfer_type}${e.unsold ? " unsold" : ""}]</span>` : "";
    const year = e.date_year ? ` <span class="type-tag">${e.date_year}</span>` : "";
    return `<li class="${cls}"><span class="seq">${e.sequence}.</span>${type}${year} ${escHtml(e.raw_text)}</li>`;
  }).join("\n");
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Long-Duration Period Review — #178</title>
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
  .summary-grid { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .summary-item { font-family: var(--mono); font-size: 0.8rem; padding: 2px 8px; border-radius: 4px; background: #eee8d8; }

  .filter-bar { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 2rem; display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
  .filter-btn { font-family: var(--mono); font-size: 0.8rem; padding: 4px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--surface); cursor: pointer; }
  .filter-btn:hover { background: var(--highlight); }
  .filter-btn.active { background: var(--accent); color: white; border-color: var(--accent); }

  .toc { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 2rem; }
  .toc h2 { font-size: 1rem; margin-bottom: 0.5rem; }
  .toc-grid { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .toc-link { font-family: var(--mono); font-size: 0.75rem; padding: 2px 6px; border-radius: 3px; text-decoration: none; color: var(--accent); background: #f5ece0; }
  .toc-link:hover { background: var(--highlight); }

  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 1.5rem; overflow: hidden; }
  .card-header { background: #eee8d8; padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; }
  .card-header h2 { font-size: 1rem; font-weight: 500; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.8rem; font-weight: 500; font-family: var(--mono); }
  .badge-legitimate { background: #2d6a4f; color: white; }
  .badge-artifact { background: #c0392b; color: white; }
  .badge-review { background: #e67e22; color: white; }
  .badge-duration { background: #1a4f7a; color: white; margin-left: 4px; }
  .badge-confidence { background: #6b4c9a; color: white; margin-left: 4px; }
  .badge-method { background: #555; color: white; margin-left: 4px; }

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

  .period-detail { background: #faf8f2; padding: 0.75rem; border-radius: 6px; margin-bottom: 0.75rem; font-size: 0.85rem; border: 1px solid #e8e0cc; }
  .period-detail dt { font-weight: 500; color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; }
  .period-detail dd { margin-bottom: 0.5rem; font-family: var(--mono); font-size: 0.82rem; }
  .reasoning { font-family: var(--sans); font-style: italic; color: var(--text-muted); font-size: 0.85rem; margin-top: 0.5rem; padding: 0.5rem; background: #faf8f2; border-radius: 4px; border-left: 3px solid var(--accent); }

  .period-chain { font-size: 0.8rem; margin-top: 0.75rem; }
  .period-chain .period-row { padding: 3px 0; border-bottom: 1px solid #f0ebe0; display: flex; gap: 0.5rem; }
  .period-chain .period-row:last-child { border-bottom: none; }
  .period-chain .target { background: var(--highlight); padding: 2px 4px; border-radius: 3px; font-weight: 500; }

  .back-to-top { position: fixed; bottom: 1rem; right: 1rem; background: var(--accent); color: white; padding: 0.5rem 1rem; border-radius: 6px; text-decoration: none; font-size: 0.8rem; opacity: 0.8; }
  .back-to-top:hover { opacity: 1; }
</style>
</head>
<body>
<h1>Long-Duration Period Review — Issue #178</h1>
<p class="subtitle">Reviewer: Claude Opus 4.6. Date: ${new Date().toISOString().split("T")[0]}. Method: <code>enrichment_reasoning</code> on provenance_periods (not yet written back).</p>

<div class="summary">
  <h2>Task description</h2>
  <p style="font-size:0.9rem;line-height:1.6;">After the #88 fix (creation date leak suppression), <strong>${results.length} periods</strong> still have durations exceeding 200 years. Some are legitimate — churches, museums, and institutions can hold artworks for centuries. Others are artifacts of date inference: a creation date leaking into the period begin year, or a wrong end year from a misinterpreted event.</p>
  <p style="font-size:0.9rem;line-height:1.6;margin-top:0.5rem;">Each card shows the provenance event chain (left, with source events highlighted) and the period details with classification reasoning (right). Three verdicts: <span class="badge badge-legitimate">legitimate</span> (long ownership is historically plausible), <span class="badge badge-artifact">artifact</span> (date inference error), <span class="badge badge-review">needs review</span> (ambiguous — could be either).</p>
</div>

<div class="summary">
  <h2>Distribution</h2>
  <div class="summary-grid">
    <span class="summary-item">Total: ${results.length}</span>
    <span class="summary-item" style="background:#d4edda">Legitimate: ${verdictCounts.legitimate}</span>
    <span class="summary-item" style="background:#f8d7da">Artifact: ${verdictCounts.artifact}</span>
    <span class="summary-item" style="background:#fff3cd">Needs review: ${verdictCounts.review}</span>
  </div>
</div>

<div class="filter-bar">
  <span style="font-size:0.8rem;color:var(--text-muted)">Filter:</span>
  <button class="filter-btn active" onclick="filterCards('all')">All (${results.length})</button>
  <button class="filter-btn" onclick="filterCards('legitimate')">Legitimate (${verdictCounts.legitimate})</button>
  <button class="filter-btn" onclick="filterCards('artifact')">Artifact (${verdictCounts.artifact})</button>
  <button class="filter-btn" onclick="filterCards('review')">Needs review (${verdictCounts.review})</button>
</div>

<div class="toc">
  <h2>Jump to artwork</h2>
  <div class="toc-grid">
    ${results.map((r, i) => `<a class="toc-link" href="#card-${i}" data-verdict="${r.verdict}">${r.object_number}</a>`).join("\n    ")}
  </div>
</div>

${results.map((r, i) => {
  const events = eventsByArtwork.get(r.artwork_id) || [];
  const allPeriods = allPeriodsByArtwork.get(r.artwork_id) || [];
  const dateRange = (r.date_earliest || r.date_latest)
    ? `${r.date_earliest ?? "?"}–${r.date_latest ?? "?"}`
    : "";

  return `<div class="card" id="card-${i}" data-verdict="${r.verdict}">
  <div class="card-header">
    <h2>${escHtml(r.object_number)} — ${escHtml(r.title || "(untitled)")}</h2>
    <div>
      <span class="badge ${verdictBadgeClass(r.verdict)}">${r.verdict}</span>
      <span class="badge badge-duration">${r.duration} yrs</span>
      <span class="badge badge-confidence">${(r.confidence * 100).toFixed(0)}%</span>
      ${r.acquisition_method ? `<span class="badge badge-method">${r.acquisition_method}</span>` : ""}
    </div>
  </div>
  <div class="card-body">
    <div class="left">
      <div class="section-label">Provenance events (${events.length})</div>
      <ul class="event-list">
        ${formatEvents(events, r.source_events)}
      </ul>
    </div>
    <div class="right">
      <div class="section-label">Period ${r.sequence} — flagged</div>
      <dl class="period-detail">
        <dt>Owner</dt><dd>${escHtml(r.owner_name || "(none)")}</dd>
        <dt>Acquisition</dt><dd>${escHtml(r.acquisition_method || "(none)")}${r.acquisition_from ? " from " + escHtml(r.acquisition_from) : ""}</dd>
        <dt>Years</dt><dd>${r.begin_year}–${r.end_year} (${r.duration} years)</dd>
        <dt>Artwork dates</dt><dd>${escHtml(r.creator_label || "")}${dateRange ? ", " + dateRange : ""}</dd>
      </dl>

      <div class="section-label">All periods</div>
      <div class="period-chain">
        ${allPeriods.map(p => {
          const isTarget = p.sequence === r.sequence;
          const years = (p.begin_year || p.end_year) ? `${p.begin_year ?? "?"}–${p.end_year ?? "?"}` : "?–?";
          const dur = p.duration != null ? ` (${p.duration} yrs)` : "";
          return `<div class="period-row${isTarget ? " target" : ""}"><span class="seq">${p.sequence}.</span> ${escHtml(p.owner_name || "(unnamed)")} | ${p.acquisition_method || "?"} | ${years}${dur}</div>`;
        }).join("\n        ")}
      </div>

      <div class="section-label" style="margin-top:0.75rem">Classification</div>
      <div class="reasoning">${escHtml(r.reasoning)}</div>
    </div>
  </div>
</div>`;
}).join("\n\n")}

<a href="#" class="back-to-top">↑ Top</a>

<script>
function filterCards(verdict) {
  document.querySelectorAll('.card').forEach(card => {
    card.style.display = verdict === 'all' || card.dataset.verdict === verdict ? '' : 'none';
  });
  document.querySelectorAll('.toc-link').forEach(link => {
    link.style.display = verdict === 'all' || link.dataset.verdict === verdict ? '' : 'none';
  });
  document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
  event.target.classList.add('active');
}
</script>
</body>
</html>`;

writeFileSync(outputPath, html);
console.log(`\nWritten to ${outputPath} (${(html.length / 1024).toFixed(0)} KB)`);
