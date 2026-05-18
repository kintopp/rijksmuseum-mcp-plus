// HTML report renderer for the payload-redundancy audit.
//
// Output is a single self-contained HTML file (inline CSS, no external
// assets) so it can be opened from disk or attached to an issue without
// resolving any further dependencies.
//
// Sections:
//   0. Header + summary stats
//   1. Reader's guide — how to interpret findings and severity
//   2. Findings by class (A–F), each with a class-level guide paragraph
//   3. Appendices: schema catalogue, helper call graph, raw byte stats

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sevBar(score) {
  const pct = Math.max(0, Math.min(100, score));
  const colour = pct >= 60 ? "#c53030" : pct >= 30 ? "#dd6b20" : "#3182ce";
  return `<span class="sev-bar" title="severity ${pct}/100"><span style="width:${pct}%;background:${colour}"></span></span>`;
}

function bytesFmt(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const CSS = `
  :root {
    --bg: #fafaf7;
    --fg: #1f2933;
    --muted: #52606d;
    --accent: #2c5282;
    --accent-soft: #ebf4ff;
    --code-bg: #f7fafc;
    --border: #cbd5e0;
    --warn: #c53030;
    --info: #3182ce;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    max-width: 1080px;
    margin: 2rem auto;
    padding: 0 1.5rem 4rem;
    background: var(--bg);
    color: var(--fg);
    line-height: 1.55;
    font-size: 15px;
  }
  h1 {
    font-size: 1.7rem;
    margin: 0 0 0.4rem;
    border-bottom: 2px solid var(--accent);
    padding-bottom: 0.4rem;
  }
  h2 {
    font-size: 1.2rem;
    color: var(--accent);
    margin-top: 2.5rem;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.3rem;
  }
  h3 {
    font-size: 1.02rem;
    color: var(--muted);
    margin-top: 1.6rem;
  }
  p { margin: 0.6rem 0; }
  ul, ol { padding-left: 1.4rem; }
  li { margin: 0.2rem 0; }
  code, pre {
    font-family: "SF Mono", Monaco, Consolas, monospace;
    font-size: 0.85em;
  }
  code { background: var(--code-bg); padding: 0.1em 0.3em; border-radius: 3px; }
  pre {
    background: var(--code-bg);
    padding: 0.8rem 1rem;
    border-radius: 4px;
    border: 1px solid var(--border);
    overflow-x: auto;
    font-size: 0.82em;
    line-height: 1.45;
  }
  pre code { background: transparent; padding: 0; }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 0.8rem 0 1.2rem;
    font-size: 0.92em;
  }
  th, td {
    border-bottom: 1px solid var(--border);
    padding: 0.4rem 0.6rem;
    text-align: left;
    vertical-align: top;
  }
  th { background: var(--accent-soft); font-weight: 600; }
  tr:hover td { background: #f3f4f6; }
  .meta-line {
    color: var(--muted);
    font-size: 0.88em;
    margin: 0.2rem 0 1rem;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 0.8rem;
    margin: 1rem 0 2rem;
  }
  .stat {
    background: white;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.6rem 0.8rem;
  }
  .stat-label { font-size: 0.75em; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .stat-value { font-size: 1.3rem; font-weight: 600; color: var(--fg); margin-top: 0.2rem; }
  .guide {
    background: var(--accent-soft);
    border-left: 4px solid var(--accent);
    padding: 0.8rem 1rem;
    margin: 1rem 0 1.6rem;
    border-radius: 0 4px 4px 0;
    font-size: 0.93em;
  }
  .finding {
    background: white;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.8rem 1rem;
    margin: 0.8rem 0;
  }
  .finding-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    margin-bottom: 0.4rem;
  }
  .finding-title {
    font-weight: 600;
    font-size: 0.95em;
  }
  .sev-bar {
    display: inline-block;
    width: 80px;
    height: 8px;
    background: #e2e8f0;
    border-radius: 2px;
    overflow: hidden;
    vertical-align: middle;
  }
  .sev-bar > span { display: block; height: 100%; }
  .sev-num {
    font-size: 0.78em;
    color: var(--muted);
    margin-left: 0.4rem;
  }
  .badge {
    display: inline-block;
    font-size: 0.72em;
    padding: 0.05em 0.5em;
    border-radius: 10px;
    background: var(--code-bg);
    color: var(--muted);
    margin-right: 0.3rem;
  }
  .badge-warn { background: #fed7d7; color: var(--warn); }
  .badge-info { background: var(--accent-soft); color: var(--accent); }
  .empty {
    color: var(--muted);
    font-style: italic;
    padding: 0.6rem;
    background: white;
    border: 1px dashed var(--border);
    border-radius: 4px;
  }
  details { margin: 0.4rem 0; }
  summary { cursor: pointer; color: var(--accent); font-size: 0.9em; }
  .toc {
    background: white;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.8rem 1.2rem;
    margin: 1rem 0 2rem;
  }
  .toc ol { margin: 0.3rem 0; }
  .toc a { color: var(--accent); text-decoration: none; }
  .toc a:hover { text-decoration: underline; }
`;

function readersGuide() {
  return `
    <div class="guide">
      <strong>How to read this report.</strong>
      The audit asks a single question of each MCP tool's output: <em>is this byte
      doing work?</em> A field that's never rendered in the text channel, or
      that re-states a value already present elsewhere, or that shares a name
      with a structurally different field in another tool, is suspect — not
      necessarily wrong, but worth a look. The findings are split into six
      classes (A–F) below; each class begins with a paragraph on what the
      class catches and what's most likely to be a <em>false positive worth
      ignoring</em>. Severity is a coarse log-scale composite of
      <code>bytes_wasted × call_frequency</code>; treat the bars as priority
      hints, not verdicts. Anything weighing &lt; 30/100 is usually polish-tier.
    </div>
  `;
}

function renderShapeCollisions(findings) {
  if (findings.length === 0) {
    return `<p class="empty">No same-name-different-shape collisions detected — this is the best-news class to read first.</p>`;
  }
  let html = `<table><thead><tr><th>Field name</th><th>Distinct shapes</th><th>Occurrences</th></tr></thead><tbody>`;
  for (const f of findings) {
    const occs = f.occurrences.map(o => `<li><code>${escapeHtml(o.tool)}</code> → <code>${escapeHtml(o.path)}</code> <span class="badge">${escapeHtml(o.kind)}</span></li>`).join("");
    html += `<tr>
      <td><code>${escapeHtml(f.name)}</code></td>
      <td>${f.kinds.map(k => `<span class="badge badge-warn">${escapeHtml(k)}</span>`).join(" ")}</td>
      <td><ul>${occs}</ul></td>
    </tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

function renderValueAliases(findings) {
  if (findings.length === 0) {
    return `<p class="empty">No cross-tool value aliases detected on shared anchors.</p>`;
  }
  let html = "";
  for (const f of findings.slice(0, 50)) {
    const occs = f.occurrences.map(o =>
      `<li><code>${escapeHtml(o.tool)}</code> · fixture <code>${escapeHtml(o.fixture)}</code> · field <code>${escapeHtml(o.path)}</code></li>`,
    ).join("");
    html += `
      <div class="finding">
        <div class="finding-header">
          <span class="finding-title">Anchor ${escapeHtml(f.anchor)}: value appears under ${f.occurrences.length} distinct field paths</span>
          ${sevBar(f.severity ?? 40)}<span class="sev-num">${f.severity ?? 40}</span>
        </div>
        <pre><code>${escapeHtml(f.value)}</code></pre>
        <ul>${occs}</ul>
      </div>
    `;
  }
  if (findings.length > 50) {
    html += `<p class="meta-line">…and ${findings.length - 50} more aliases (see CSV).</p>`;
  }
  return html;
}

function renderDeadBytes(findings) {
  if (findings.length === 0) {
    return `<p class="empty">No structured-only fields above the byte threshold.</p>`;
  }
  let html = `<table><thead><tr><th>Tool</th><th>Fixture</th><th>Field path</th><th>Bytes</th><th>Sample value</th><th>Severity</th></tr></thead><tbody>`;
  for (const f of findings.slice(0, 80)) {
    html += `<tr>
      <td><code>${escapeHtml(f.tool)}</code></td>
      <td><code>${escapeHtml(f.fixture)}</code></td>
      <td><code>${escapeHtml(f.path)}</code></td>
      <td style="text-align:right">${bytesFmt(f.bytes)}</td>
      <td><code>${escapeHtml((f.valueSample || "").slice(0, 60))}…</code></td>
      <td>${sevBar(f.severity)}<span class="sev-num">${f.severity}</span></td>
    </tr>`;
  }
  html += `</tbody></table>`;
  if (findings.length > 80) {
    html += `<p class="meta-line">…and ${findings.length - 80} more (see CSV).</p>`;
  }
  return html;
}

function renderIntraDup(findings) {
  if (findings.length === 0) {
    return `<p class="empty">No long string fields showed significant intra-field self-duplication.</p>`;
  }
  let html = "";
  for (const f of findings) {
    const dr = f.dup;
    html += `
      <div class="finding">
        <div class="finding-header">
          <span class="finding-title">
            <code>${escapeHtml(f.tool)}</code> · <code>${escapeHtml(f.path)}</code>
            — ${dr.blockCount} blocks, ${(dr.overallRedundancy * 100).toFixed(0)}% redundant
          </span>
          ${sevBar(f.severity)}<span class="sev-num">${f.severity}</span>
        </div>
        <p class="meta-line">
          <span class="badge badge-info">${bytesFmt(dr.totalBytes)}</span>
          <span class="badge">${dr.dupPairs} near-dup block pairs</span>
          <span class="badge">${dr.translationPairs} NL↔EN translation pairs</span>
          <span class="badge">fixture <code>${escapeHtml(f.fixture)}</code></span>
        </p>
        <details><summary>First 3 blocks</summary>
          <pre><code>${escapeHtml(dr.sampleBlocks.join("\n\n"))}</code></pre>
        </details>
      </div>
    `;
  }
  return html;
}

function renderDerivable(findings) {
  if (findings.length === 0) {
    return `<p class="empty">No derived-from-structured-array fields detected by the current synthesiser set.</p>`;
  }
  let html = `<table><thead><tr><th>Tool</th><th>Fixture</th><th>Array field</th><th>Derived string field</th><th>Synthesiser</th></tr></thead><tbody>`;
  for (const f of findings) {
    html += `<tr>
      <td><code>${escapeHtml(f.tool)}</code></td>
      <td><code>${escapeHtml(f.fixture)}</code></td>
      <td><code>${escapeHtml(f.arrayPath)}</code></td>
      <td><code>${escapeHtml(f.stringPath)}</code> = <code>${escapeHtml(f.value)}</code></td>
      <td><span class="badge badge-info">${escapeHtml(f.synthesiser)}</span></td>
    </tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

function renderTextOnly(findings) {
  if (findings.length === 0) {
    return `<p class="empty">No text-only signals detected — every labelled section in the text channel maps to a structured field.</p>`;
  }
  let html = `<table><thead><tr><th>Tool</th><th>Fixture</th><th>Text label</th><th>Sample value</th><th>Kind</th><th>Severity</th></tr></thead><tbody>`;
  for (const f of findings.slice(0, 80)) {
    const kind = f.valuePresentInStructured
      ? `<span class="badge badge-info">derived rendering</span>`
      : `<span class="badge badge-warn">computed text-only</span>`;
    html += `<tr>
      <td><code>${escapeHtml(f.tool)}</code></td>
      <td><code>${escapeHtml(f.fixture)}</code></td>
      <td><code>${escapeHtml(f.label)}</code></td>
      <td><code>${escapeHtml(f.valueSample)}</code></td>
      <td>${kind}</td>
      <td>${sevBar(f.severity)}<span class="sev-num">${f.severity}</span></td>
    </tr>`;
  }
  html += `</tbody></table>`;
  if (findings.length > 80) {
    html += `<p class="meta-line">…and ${findings.length - 80} more (see CSV).</p>`;
  }
  return html;
}

function renderHelperGraph(records) {
  if (records.length === 0) {
    return `<p class="empty">No shared helpers detected.</p>`;
  }
  let html = `<table><thead><tr><th>Helper</th><th>Defined in</th><th>Distinct caller files</th><th>Total calls</th><th>Call sites</th></tr></thead><tbody>`;
  for (const r of records) {
    const sites = Object.entries(r.callSites)
      .map(([file, n]) => `<li><code>${escapeHtml(file)}</code> × ${n}</li>`)
      .join("");
    html += `<tr>
      <td><code>${escapeHtml(r.name)}</code></td>
      <td><code>${escapeHtml(r.definedIn)}</code></td>
      <td style="text-align:right">${r.distinctFiles}</td>
      <td style="text-align:right">${r.totalCalls}</td>
      <td><ul>${sites}</ul></td>
    </tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

function renderSchemaCatalogue(schemasByTool) {
  let html = "";
  for (const [tool, fields] of Object.entries(schemasByTool)) {
    html += `<h3>${escapeHtml(tool)} <span class="meta-line">${fields.length} fields</span></h3>`;
    html += `<table><thead><tr><th>Path</th><th>Kind</th><th>Nullable</th><th>Optional</th></tr></thead><tbody>`;
    for (const f of fields) {
      html += `<tr>
        <td><code>${escapeHtml(f.path)}</code></td>
        <td><code>${escapeHtml(f.kind)}</code></td>
        <td>${f.nullable ? "✓" : ""}</td>
        <td>${f.optional ? "✓" : ""}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }
  return html;
}

function renderToolLimitsTable(toolLimits, modeFlags, allToolNames) {
  const rows = [...allToolNames].sort();
  let html = `<table><thead><tr>
    <th>Tool</th>
    <th>max maxResults</th>
    <th>default maxResults</th>
    <th>Mode flag (compact / identifiersOnly)</th>
    <th>Notes</th>
  </tr></thead><tbody>`;
  for (const tool of rows) {
    const lim = toolLimits[tool];
    const flags = modeFlags[tool] ?? [];
    const flagHtml = flags.length === 0
      ? "<span class=\"meta-line\">—</span>"
      : flags.map(f => `<code>${escapeHtml(f.flag)}</code>: ${escapeHtml((f.description || "").slice(0, 110))}${(f.description || "").length > 110 ? "…" : ""}`).join("<br>");
    const maxCell = lim ? String(lim.max) : `<span class="meta-line">—</span>`;
    const defaultCell = lim ? String(lim.default) : `<span class="meta-line">—</span>`;
    const notes = !lim && flags.length === 0
      ? "<span class=\"meta-line\">no per-call threshold and no response-mode flag — single-shot tool</span>"
      : "";
    html += `<tr>
      <td><code>${escapeHtml(tool)}</code></td>
      <td style="text-align:right">${maxCell}</td>
      <td style="text-align:right">${defaultCell}</td>
      <td>${flagHtml}</td>
      <td>${notes}</td>
    </tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

function renderBytesTable(bytesByTool) {
  let html = `<table><thead><tr><th>Tool</th><th>Fixture</th><th>Bytes (structured)</th><th>Bytes (text)</th><th>Top fields</th></tr></thead><tbody>`;
  for (const row of bytesByTool) {
    const top = row.topFields.map(([k, v]) => `<li><code>${escapeHtml(k)}</code> ${bytesFmt(v)}</li>`).join("");
    html += `<tr>
      <td><code>${escapeHtml(row.tool)}</code></td>
      <td><code>${escapeHtml(row.fixture)}</code></td>
      <td style="text-align:right">${bytesFmt(row.bytesStructured)}</td>
      <td style="text-align:right">${bytesFmt(row.bytesText)}</td>
      <td><ul>${top}</ul></td>
    </tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

function renderCaptureFailures(failures) {
  if (failures.length === 0) {
    return `<p class="empty">All fixtures captured successfully.</p>`;
  }
  let html = `<table><thead><tr><th>Tool</th><th>Fixture</th><th>Error</th></tr></thead><tbody>`;
  for (const f of failures) {
    html += `<tr>
      <td><code>${escapeHtml(f.tool)}</code></td>
      <td><code>${escapeHtml(f.fixture)}</code></td>
      <td><code>${escapeHtml(f.error)}</code></td>
    </tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

export function renderReport(data) {
  const {
    generatedAt, projectVersion, totalFindings,
    schemasByTool, helperRecords,
    shapeCollisions, valueAliases, deadBytes, intraDups, derivables, textOnly,
    bytesByTool, toolLimits, modeFlags, captureFailures, skippedTools,
  } = data;

  const totalFields = Object.values(schemasByTool).reduce((a, b) => a + b.length, 0);
  const totalTools = Object.keys(schemasByTool).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Payload-redundancy audit — Rijksmuseum MCP+</title>
<style>${CSS}</style>
</head>
<body>

<h1>Payload-redundancy audit</h1>
<p class="meta-line">
  Generated ${escapeHtml(generatedAt)} ·
  rijksmuseum-mcp-plus ${escapeHtml(projectVersion)} ·
  ${totalTools} tools / ${totalFields} declared fields / ${totalFindings} findings
</p>

<div class="toc">
  <strong>Contents</strong>
  <ol>
    <li><a href="#guide">Reader's guide</a></li>
    <li><a href="#shape">A. Cross-tool name collisions (different shapes)</a></li>
    <li><a href="#aliases">B. Value aliases (same value, different field name across tools)</a></li>
    <li><a href="#dead">C. Dead bytes (structured-only fields)</a></li>
    <li><a href="#intra">D. Intra-field self-duplication</a></li>
    <li><a href="#derived">E. Derivable string fields</a></li>
    <li><a href="#helpers">F. Shared format/build/render helpers</a></li>
    <li><a href="#textonly">G. Text-only signals (no structured-channel home)</a></li>
    <li><a href="#schema">Appendix 1: Schema catalogue</a></li>
    <li><a href="#bytes">Appendix 2: Per-fixture byte budget</a></li>
    <li><a href="#thresholds">Appendix 3: Per-call thresholds &amp; mode-flag transitions</a></li>
    <li><a href="#failures">Appendix 4: Capture failures &amp; skipped tools</a></li>
  </ol>
</div>

<div class="stats">
  <div class="stat"><div class="stat-label">Tools audited</div><div class="stat-value">${totalTools}</div></div>
  <div class="stat"><div class="stat-label">Declared fields</div><div class="stat-value">${totalFields}</div></div>
  <div class="stat"><div class="stat-label">Shape collisions</div><div class="stat-value">${shapeCollisions.length}</div></div>
  <div class="stat"><div class="stat-label">Value aliases</div><div class="stat-value">${valueAliases.length}</div></div>
  <div class="stat"><div class="stat-label">Dead-byte fields</div><div class="stat-value">${deadBytes.length}</div></div>
  <div class="stat"><div class="stat-label">Self-dup strings</div><div class="stat-value">${intraDups.length}</div></div>
  <div class="stat"><div class="stat-label">Text-only signals</div><div class="stat-value">${textOnly.length}</div></div>
  <div class="stat"><div class="stat-label">Shared helpers</div><div class="stat-value">${helperRecords.length}</div></div>
</div>

<h2 id="guide">Reader's guide</h2>
${readersGuide()}
<p>
  The audit collected real responses from every non-app tool against a fixture
  matrix anchored to a handful of well-known artworks (<em>The Battle of Waterloo</em>,
  <em>The Night Watch</em>, <em>The Milkmaid</em>) so cross-tool value comparison
  is grounded in the same underlying facts. Findings are not deduplicated
  against the project's intentional design choices — the human reader is the
  triage layer. Two common <strong>false-positive shapes to expect</strong>:
</p>
<ol>
  <li><strong>Dual text/structured-channel mirroring.</strong> Per
    <code>structuredcontent-adoption.md</code>, every field that appears in
    <code>structured</code> is intentionally re-rendered into the <code>text</code>
    channel for clients that ignore structured content. The presence-diff in
    section C tries to filter these out, but borderline cases can leak.</li>
  <li><strong>Authority-space duplication.</strong> Some fields carry the same
    entity under different ID conventions on purpose (e.g.
    <code>actorUri</code> = Rijks internal vs <code>wikidataId</code> = global
    Wikidata QID per <code>vocabulary-external-ids-design.md</code>). These are
    deliberate, not cruft.</li>
</ol>

<h2 id="shape">A. Cross-tool name collisions (different shapes)</h2>
<div class="guide">
  <strong>What this catches.</strong> A field name that means one thing in tool X
  (e.g. <code>dimensions</code> as a structured array) but something else in
  tool Y (e.g. <code>dimensions</code> as a free-text string). These are the
  highest-priority class — an LLM that learned one tool will silently
  misinterpret the other. Mechanical detection from
  <code>tools/list</code> schemas; no human judgment needed to confirm.
</div>
${renderShapeCollisions(shapeCollisions)}

<h2 id="aliases">B. Value aliases (same value, different field name across tools)</h2>
<div class="guide">
  <strong>What this catches.</strong> The same concrete value (e.g.
  <code>"h 379.5 cm × w 453.5 cm"</code>) appearing under different field names
  in different tools' responses on the same anchor artwork. Strong evidence of
  a renamed projection of the same underlying source. <em>Watch out for:</em>
  short common strings (object numbers, titles) that legitimately appear in
  every tool — these are filtered by length, but a few will leak through. Ignore
  any alias where both keys mean "the artwork's title" or "the objectNumber" —
  those are intentional identity carriers.
</div>
${renderValueAliases(valueAliases)}

<h2 id="dead">C. Dead bytes (structured-only fields)</h2>
<div class="guide">
  <strong>What this catches.</strong> Fields shipped in <code>structuredContent</code>
  whose value never appears in the text channel. In claude.ai and Claude Desktop
  (per project memory) <code>structuredContent</code> is ignored — so these
  bytes ship over the wire and are discarded by the most common clients.
  <em>Not all dead bytes are bad:</em> the rijksmuseum-mcp-client web app and
  other structured-content-aware consumers do read this data. Severity-weighting
  by byte size helps prioritise — start with the heaviest. Image-bytes fields
  (<code>image</code>, <code>imageBase64</code>) are excluded by fixture config.
</div>
${renderDeadBytes(deadBytes)}

<h2 id="intra">D. Intra-field self-duplication</h2>
<div class="guide">
  <strong>What this catches.</strong> A single long string field whose content
  repeats itself — typically because the cataloguer captured the same
  measurements in both English and Dutch, or in both summary and labelled-detail
  forms. <code>extentText</code> is the canonical case. Two signals are reported
  per field: near-duplicate block pairs (Jaccard ≥ 0.5 on tokens) and NL↔EN
  translation pairs (different language stopwords + overlapping numerics).
</div>
${renderIntraDup(intraDups)}

<h2 id="derived">E. Derivable string fields</h2>
<div class="guide">
  <strong>What this catches.</strong> A string field whose value can be
  mechanically synthesised from another, more structured field on the same
  response. Today the script knows one synthesiser — <code>formatDimensions</code>
  ("h W cm × w H cm" from the <code>dimensions[]</code> array). Adding more
  synthesisers is the easiest way to grow this class; add them to
  <code>tryDeriveString()</code> in <code>analyzers.mjs</code> as patterns
  emerge.
</div>
${renderDerivable(derivables)}

<h2 id="textonly">G. Text-only signals (no structured-channel home)</h2>
<div class="guide">
  <strong>What this catches.</strong> Facts emitted in the text channel that
  have <em>no</em> corresponding key in <code>structuredContent</code> — the
  symmetric counterpart to section C (dead bytes). Detected by parsing
  <code>[Label] value</code> and <code>Label: value</code> patterns out of the
  text channel and checking whether each label maps to any structured field
  path. Two flavours:
  <ul>
    <li><span class="badge badge-warn">computed text-only</span> — the value
      itself doesn't appear anywhere in structured. Strongest signal: this is a
      fact computed at render time (e.g. <code>get_artwork_details</code>'s
      <code>[Provenance parsed]</code> block — event counts, gap counts,
      earliest owner — derived in <code>formatDetailSummary</code> from the raw
      provenance text). Clients that read only structuredContent never see
      these facts; consumers comparing tools across the two channels see
      asymmetric data.</li>
    <li><span class="badge badge-info">derived rendering</span> — the label has
      no structured key, but the value text <em>is</em> findable in structured
      content (typically embedded inside a longer string field). Less severe:
      the data exists, just under a different name/shape.</li>
  </ul>
  <em>Watch out for:</em> labels that legitimately don't appear in structured
  because they're text-channel-only formatting conventions (rare — the report
  surfaces them anyway so you can decide).
</div>
${renderTextOnly(textOnly)}

<h2 id="helpers">F. Shared format/build/render helpers</h2>
<div class="guide">
  <strong>What this catches.</strong> Helper functions named <code>formatX</code>,
  <code>buildX</code>, <code>renderX</code> called from multiple files. Each
  shared helper is a candidate cross-tool duplication source — the
  <code>formatDimensions()</code> case that motivated this audit shows up here
  because <code>registration.ts</code> calls it for both <code>dimensionStatement</code>
  and <code>physicalDimensions</code>. Treat as informational; cross-reference
  with sections A–B to confirm whether the shared call produces a real
  duplication problem or a deliberate reuse.
</div>
${renderHelperGraph(helperRecords)}

<h2 id="schema">Appendix 1: Schema catalogue</h2>
<div class="guide">
  Full flattened <code>outputSchema</code> per tool, captured from
  <code>tools/list</code> at audit time. Useful as a frozen snapshot to diff
  against future schema changes (schema-drift detection).
</div>
${renderSchemaCatalogue(schemasByTool)}

<h2 id="bytes">Appendix 2: Per-fixture byte budget</h2>
<div class="guide">
  Bytes per captured response, split by structured channel vs text channel,
  with the top byte-consuming fields enumerated. Wide structured-to-text gaps
  are a tell for hidden cruft.
</div>
${renderBytesTable(bytesByTool)}

<h2 id="thresholds">Appendix 3: Per-call thresholds &amp; mode-flag transitions</h2>
<div class="guide">
  <strong>What this is.</strong> Each row shows the per-call limit a tool
  imposes on <code>maxResults</code> (parsed from <code>TOOL_LIMITS</code> in
  <code>src/registration.ts</code>) and whether the tool exposes a response-mode
  flag (<code>compact</code>, <code>identifiersOnly</code>) that switches the
  whole response between a full-shape form and an IDs-only form. <em>Not
  shown here</em> — the four fixed per-array preview caps inside
  <code>get_artwork_details</code> (<code>relatedObjects</code>,
  <code>children</code>, <code>themes</code>, <code>exhibitions</code> are
  each capped at 25 records with a companion <code>*TotalCount</code> field),
  and the <code>search_provenance</code> count cap (50,000) — those are fixed
  in code, not per-call thresholds.
</div>
${renderToolLimitsTable(toolLimits, modeFlags, Object.keys(schemasByTool))}

<h2 id="failures">Appendix 4: Capture failures & skipped tools</h2>
<div class="guide">
  Tools the fixture matrix tried to call but that failed, plus tools deliberately
  not exercised (app-only, hidden, state-dependent).
</div>
<h3>Capture failures</h3>
${renderCaptureFailures(captureFailures)}
<h3>Deliberately skipped</h3>
<ul>${Object.entries(skippedTools).map(([t, why]) => `<li><code>${escapeHtml(t)}</code> — ${escapeHtml(why)}</li>`).join("")}</ul>

</body>
</html>`;
}
