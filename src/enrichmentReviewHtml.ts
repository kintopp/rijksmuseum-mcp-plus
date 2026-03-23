/**
 * Generate an HTML review page showing LLM enrichment provenance for
 * provenance events/parties returned by search_provenance.
 *
 * Visual style matches the existing review pages (type-classification,
 * position-enrichment, party-disambiguation).
 */

// ─── Types ──────────────────────────────────────────────────────────

interface EnrichmentReviewEvent {
  sequence: number;
  rawText: string;
  gap: boolean;
  transferType: string;
  unsold: boolean;
  batchPrice: boolean;
  dateYear: number | null;
  categoryMethod: string | null;
  enrichmentReasoning: string | null;
  parties: {
    name: string;
    role: string | null;
    position: string | null;
    positionMethod: string | null;
    enrichmentReasoning: string | null;
  }[];
}

interface EnrichmentReviewArtwork {
  objectNumber: string;
  title: string;
  creator: string;
  events: EnrichmentReviewEvent[];
}

export interface EnrichmentReviewData {
  query: string;
  artworks: EnrichmentReviewArtwork[];
}

// ─── Helpers ────────────────────────────────────────────────────────

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function methodLabel(method: string): string {
  switch (method) {
    case "llm_enrichment": return "LLM classified";
    case "llm_disambiguation": return "LLM disambiguated";
    case "rule:transfer_is_ownership": return "Validated rule";
    default: return method;
  }
}

function methodBadgeStyle(method: string): string {
  if (method.startsWith("llm")) return "background:#6b4c9a;color:white";
  if (method.startsWith("rule:")) return "background:#2d6a4f;color:white";
  return "background:#555;color:white";
}

/** Any non-default enrichment (LLM or rule-based) — used for page content. */
export function isEnrichedEvent(e: { categoryMethod?: string | null }): boolean {
  return !!e.categoryMethod && e.categoryMethod !== "type_mapping";
}

/** Any non-default enrichment (LLM or rule-based) — used for page content. */
export function isEnrichedParty(p: { positionMethod?: string | null }): boolean {
  return !!p.positionMethod && p.positionMethod !== "role_mapping";
}

/** LLM-only enrichment — used as the guard for whether to create the page. */
export function isLlmEnrichedEvent(e: { categoryMethod?: string | null }): boolean {
  return isEnrichedEvent(e) && e.categoryMethod!.startsWith("llm_");
}

/** LLM-only enrichment — used as the guard for whether to create the page. */
export function isLlmEnrichedParty(p: { positionMethod?: string | null }): boolean {
  return isEnrichedParty(p) && p.positionMethod!.startsWith("llm_");
}

// ─── Generator ──────────────────────────────────────────────────────

export function generateEnrichmentReviewHtml(data: EnrichmentReviewData): string {
  const { query, artworks } = data;

  // Collect method distribution and derive counts
  const methodCounts: Record<string, number> = {};
  let enrichedEventCount = 0;
  let enrichedPartyCount = 0;
  let llmCount = 0;
  for (const art of artworks) {
    for (const e of art.events) {
      if (isEnrichedEvent(e)) {
        enrichedEventCount++;
        const m = e.categoryMethod!;
        if (m.startsWith("llm_")) llmCount++;
        methodCounts[m] = (methodCounts[m] || 0) + 1;
      }
      for (const p of e.parties) {
        if (isEnrichedParty(p)) {
          enrichedPartyCount++;
          const m = p.positionMethod!;
          if (m.startsWith("llm_")) llmCount++;
          methodCounts[m] = (methodCounts[m] || 0) + 1;
        }
      }
    }
  }

  // Build cards
  let cardIdx = 0;
  const cards: string[] = [];
  const tocLinks: string[] = [];

  for (const art of artworks) {
    // Collect enrichments for this artwork
    const eventEnrichments: { seq: number; type: string; method: string; reasoning: string }[] = [];
    const partyEnrichments: { seq: number; name: string; position: string; method: string; reasoning: string }[] = [];

    for (const e of art.events) {
      if (isEnrichedEvent(e)) {
        eventEnrichments.push({
          seq: e.sequence,
          type: e.transferType,
          method: e.categoryMethod!,
          reasoning: e.enrichmentReasoning || "(no reasoning recorded)",
        });
      }
      for (const p of e.parties) {
        if (isEnrichedParty(p)) {
          partyEnrichments.push({
            seq: e.sequence,
            name: p.name,
            position: p.position || "unknown",
            method: p.positionMethod!,
            reasoning: p.enrichmentReasoning || "(no reasoning recorded)",
          });
        }
      }
    }

    if (eventEnrichments.length === 0 && partyEnrichments.length === 0) continue;

    const enrichedSeqs = new Set([
      ...eventEnrichments.map(e => e.seq),
      ...partyEnrichments.map(p => p.seq),
    ]);

    tocLinks.push(`<a class="toc-link" href="#card-${cardIdx}">${esc(art.objectNumber)}</a>`);

    // Event list (left panel)
    const eventListItems = art.events.map(e => {
      const cls = enrichedSeqs.has(e.sequence) ? "highlight" : "context";
      const typeTag = e.transferType !== "unknown"
        ? ` <span class="type-tag">[${esc(e.transferType)}${e.unsold ? " unsold" : ""}${e.batchPrice ? " batch" : ""}]</span>`
        : "";
      const year = e.dateYear ? ` <span class="type-tag">${e.dateYear}</span>` : "";
      return `<li class="${cls}"><span class="seq">${e.sequence}.</span>${typeTag}${year} ${esc(e.rawText)}</li>`;
    }).join("\n");

    // Enrichment details (right panel)
    const enrichmentDetails: string[] = [];

    for (const ee of eventEnrichments) {
      enrichmentDetails.push(`
        <div class="enrichment-item">
          <div class="enrichment-header">
            <span class="badge" style="${methodBadgeStyle(ee.method)}">${methodLabel(ee.method)}</span>
            <span class="enrichment-target">Event ${ee.seq} → <code>${esc(ee.type)}</code></span>
          </div>
          <div class="reasoning">${esc(ee.reasoning)}</div>
        </div>`);
    }

    for (const pe of partyEnrichments) {
      enrichmentDetails.push(`
        <div class="enrichment-item">
          <div class="enrichment-header">
            <span class="badge" style="${methodBadgeStyle(pe.method)}">${methodLabel(pe.method)}</span>
            <span class="enrichment-target">Event ${pe.seq}, "${esc(pe.name)}" → <code>${esc(pe.position)}</code></span>
          </div>
          <div class="reasoning">${esc(pe.reasoning)}</div>
        </div>`);
    }

    cards.push(`
<div class="card" id="card-${cardIdx}">
  <div class="card-header">
    <h2>${esc(art.objectNumber)} — ${esc(art.title || "(untitled)")}</h2>
    <span style="font-size:0.8rem;color:var(--text-muted)">${esc(art.creator)}</span>
  </div>
  <div class="card-body">
    <div class="left">
      <div class="section-label">Provenance chain (enriched events highlighted)</div>
      <ul class="event-list">${eventListItems}</ul>
    </div>
    <div class="right">
      <div class="section-label">Enrichments (${eventEnrichments.length} event${eventEnrichments.length !== 1 ? "s" : ""}, ${partyEnrichments.length} part${partyEnrichments.length !== 1 ? "ies" : "y"})</div>
      ${enrichmentDetails.join("\n")}
    </div>
  </div>
</div>`);

    cardIdx++;
  }

  // Distribution summary
  const distItems = Object.entries(methodCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([m, c]) => `<span class="summary-item"><span class="badge" style="${methodBadgeStyle(m)};font-size:0.7rem;vertical-align:middle">${methodLabel(m)}</span> ${c}</span>`)
    .join("\n    ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Enrichment Review — ${llmCount} LLM-Assisted Result${llmCount !== 1 ? "s" : ""}</title>
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

  .disclaimer { background: #fff3cd; border: 2px solid #e6c200; border-radius: 8px; padding: 1rem; margin-bottom: 2rem; }
  .disclaimer h2 { font-size: 1rem; margin-bottom: 0.5rem; color: #856404; }
  .disclaimer p { font-size: 0.9rem; line-height: 1.6; color: #856404; }

  .toc { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 2rem; }
  .toc h2 { font-size: 1rem; margin-bottom: 0.5rem; }
  .toc-grid { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .toc-link { font-family: var(--mono); font-size: 0.75rem; padding: 2px 6px; border-radius: 3px; text-decoration: none; color: var(--accent); background: #f5ece0; }
  .toc-link:hover { background: var(--highlight); }

  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 1.5rem; overflow: hidden; }
  .card-header { background: #eee8d8; padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; }
  .card-header h2 { font-size: 1rem; font-weight: 500; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.8rem; font-weight: 500; font-family: var(--mono); }

  .card-body { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  @media (max-width: 800px) { .card-body { grid-template-columns: 1fr; } .left { border-right: none !important; border-bottom: 1px solid var(--border); } }
  .left, .right { padding: 1rem; }
  .left { border-right: 1px solid var(--border); }

  .section-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 0.5rem; font-weight: 500; }

  .event-list { list-style: none; font-size: 0.82rem; max-height: 400px; overflow-y: auto; }
  .event-list li { padding: 4px 0; border-bottom: 1px solid #f0ebe0; }
  .event-list li:last-child { border-bottom: none; }
  .event-list .seq { color: var(--text-muted); font-family: var(--mono); font-size: 0.75rem; min-width: 1.5em; display: inline-block; }
  .event-list .type-tag { font-family: var(--mono); font-size: 0.7rem; color: var(--accent); }
  .event-list .highlight { background: var(--highlight); padding: 2px 4px; border-radius: 3px; }
  .event-list .context { opacity: 0.6; }

  .enrichment-item { margin-bottom: 1rem; }
  .enrichment-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; flex-wrap: wrap; }
  .enrichment-target { font-size: 0.82rem; font-family: var(--mono); }
  .reasoning { font-family: var(--sans); font-style: italic; color: var(--text-muted); font-size: 0.85rem; padding: 0.5rem; background: #faf8f2; border-radius: 4px; border-left: 3px solid var(--accent); }

  .back-to-top { position: fixed; bottom: 1rem; right: 1rem; background: var(--accent); color: white; padding: 0.5rem 1rem; border-radius: 6px; text-decoration: none; font-size: 0.8rem; opacity: 0.8; }
  .back-to-top:hover { opacity: 1; }
</style>
</head>
<body>
<h1>Enrichment Review — ${llmCount} LLM-Assisted Result${llmCount !== 1 ? "s" : ""}</h1>
<p class="subtitle">Query: <code>${esc(query)}</code>. Generated ${new Date().toISOString().split("T")[0]}.</p>

<div class="disclaimer">
  <h2>About this page</h2>
  <p>Some provenance records in these results were enriched or classified by an LLM (large language model) because the provenance parser could not resolve them from text alone. Each enrichment below shows the method used and the LLM's reasoning for its decision.</p>
  <p style="margin-top:0.5rem;">These classifications are automated and have <strong>not</strong> been individually verified or endorsed by the Rijksmuseum. The reasoning is provided for transparency so you can assess the quality of each decision.</p>
</div>

<div class="summary">
  <h2>Task description</h2>
  <p style="font-size:0.9rem;line-height:1.6;">The provenance parser automatically extracts structured ownership events from free-text provenance records written in the AAM (American Alliance of Museums) standard. It uses rule-based pattern matching to identify transfer types, parties, dates, locations, and prices. When the rules cannot resolve an event — for example, a bare name with no transfer keyword, or a merged party text that needs decomposition — an LLM (large language model) is used with art-historical domain context to make the classification. Every LLM decision is recorded with its method and reasoning for full traceability.</p>
</div>

<div class="summary">
  <h2>Distribution</h2>
  <div class="summary-grid">
    <span class="summary-item">Enriched events: ${enrichedEventCount}</span>
    <span class="summary-item">Enriched parties: ${enrichedPartyCount}</span>
    <span class="summary-item">Artworks: ${cards.length}</span>
  </div>
  <div class="summary-grid" style="margin-top:0.5rem">
    ${distItems}
  </div>
</div>

${tocLinks.length > 0 ? `
<div class="toc">
  <h2>Jump to artwork</h2>
  <div class="toc-grid">
    ${tocLinks.join("\n    ")}
  </div>
</div>` : ""}

${cards.join("\n")}

<a href="#" class="back-to-top">↑ Top</a>
</body>
</html>`;
}
