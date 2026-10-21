// Renders compare-visual-similarity.mjs's JSON report as a self-contained HTML page
// (thumbnails load live from iiif.micr.io).
//
//   node scripts/tests/render-visual-comparison.mjs <report.json> <out.html>

import fs from "node:fs";

const [, , IN, OUT] = process.argv;
if (!IN || !OUT) throw new Error("usage: render-visual-comparison.mjs <report.json> <out.html>");
const data = JSON.parse(fs.readFileSync(IN, "utf-8"));

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visual similarity: Gemma vs Rijksmuseum</title>
<style>
  :root { --tile:300px; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --bg:#f8fafc; --card:#fff;
          --teal:#0d9488; --teal-soft:#ccfbf1; --amber:#d97706; --rijks:#9a3412; --gemma:#1d4ed8; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--ink); background:var(--bg); }
  .hero { background:linear-gradient(135deg,#1e293b 0%,#334155 100%); color:#e2e8f0; padding:32px 24px 28px; }
  .hero h1 { margin:0 0 6px; font-size:24px; font-weight:650; }
  .hero p { margin:0; color:#94a3b8; max-width:70ch; }
  .stats { display:flex; flex-wrap:wrap; gap:28px; margin-top:20px; }
  .stat b { display:block; font-size:26px; color:#e2e8f0; font-variant-numeric:tabular-nums; }
  .stat span { color:#94a3b8; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  main { max-width:1500px; margin:0 auto; padding:20px 16px 60px; }
  h2 { font-size:17px; margin:28px 0 10px; }
  .table-wrap { overflow-x:auto; background:var(--card); border:1px solid var(--line); border-radius:8px; }
  table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }
  th, td { padding:7px 12px; text-align:right; border-bottom:1px solid var(--line); white-space:nowrap; }
  th:first-child, td:first-child { text-align:left; }
  th { font-size:12px; color:var(--muted); font-weight:600; }
  tr:last-child td { border-bottom:0; }
  .g { color:var(--gemma); } .r { color:var(--rijks); }
  .note { color:var(--muted); font-size:12.5px; margin:8px 2px 0; max-width:100ch; }
  .controls { position:sticky; top:0; z-index:5; background:var(--bg); padding:12px 0; border-bottom:1px solid var(--line);
              display:flex; flex-wrap:wrap; gap:8px 16px; align-items:center; }
  .tabs { display:flex; flex-wrap:wrap; gap:6px; }
  .tabs button { border:1px solid var(--line); background:var(--card); border-radius:999px; padding:5px 12px; cursor:pointer; font:inherit; }
  .tabs button[aria-pressed="true"] { background:#1e293b; color:#fff; border-color:#1e293b; }
  label { color:var(--muted); font-size:13px; }
  select, input { font:inherit; }
  .seed { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; margin:14px 0;
          display:grid; grid-template-columns:var(--tile) 1fr; gap:16px; }
  @media (max-width:760px) { .seed { grid-template-columns:1fr; } .query { position:static; } }
  .query { position:sticky; top:var(--controls-h, 64px); align-self:start; }
  .query img { width:100%; aspect-ratio:1; object-fit:contain; background:#f1f5f9; border-radius:6px; display:block; }
  .query .meta { margin-top:8px; font-size:12.5px; }
  .query .meta a { color:inherit; font-weight:600; }
  .badge { display:inline-block; font-size:11.5px; padding:2px 8px; border-radius:999px; margin-top:6px; font-weight:600; }
  .ov0 { background:#fee2e2; color:#991b1b; } .ovlo { background:#fef3c7; color:#92400e; } .ovhi { background:var(--teal-soft); color:#115e59; }
  .row h3 { font-size:12.5px; margin:0 0 6px; font-weight:600; display:flex; gap:10px; flex-wrap:wrap; align-items:baseline; }
  .row h3 small { color:var(--muted); font-weight:400; }
  .row + .row { margin-top:12px; }
  .seed > div:last-child { min-width:0; }
  .strip { display:flex; gap:8px; overflow-x:auto; padding-bottom:8px; scroll-snap-type:x proximity; }
  .strip .thumb { flex:0 0 var(--tile); scroll-snap-align:start; }
  /* Styled scrollbars stay visible on macOS, where overlay bars hide until scrolled. */
  /* scrollbar-color would override the ::-webkit-scrollbar rules, so only non-WebKit engines get it. */
  @supports not selector(::-webkit-scrollbar) { .strip { scrollbar-color:#94a3b8 #e2e8f0; } }
  .strip::-webkit-scrollbar { height:10px; }
  .strip::-webkit-scrollbar-track { background:#e2e8f0; border-radius:5px; }
  .strip::-webkit-scrollbar-thumb { background:#94a3b8; border-radius:5px; }
  .thumb { position:relative; display:block; aspect-ratio:1; background:#f1f5f9; border-radius:5px; overflow:hidden; border:2px solid transparent; }
  .thumb img { width:100%; height:100%; object-fit:contain; display:block; }
  .thumb.shared { border-color:var(--teal); }
  .thumb .rk { position:absolute; left:3px; top:3px; font-size:10.5px; background:rgba(15,23,42,.72); color:#fff; padding:0 5px; border-radius:4px; }
  .thumb .tag { position:absolute; right:3px; bottom:3px; font-size:10px; padding:0 4px; border-radius:4px; background:rgba(255,255,255,.9); color:var(--ink); }
  .thumb.noimg::after { content:"no image"; position:absolute; inset:0; display:grid; place-items:center; color:var(--muted); font-size:11px; }
  .legend { display:flex; flex-wrap:wrap; gap:14px; font-size:12.5px; color:var(--muted); margin-top:10px; }
  .sw { display:inline-block; width:12px; height:12px; border-radius:3px; vertical-align:-2px; margin-right:5px; }
  footer { color:var(--muted); font-size:12px; margin-top:30px; }
</style></head>
<body>
<header class="hero">
  <h1>Visual similarity: Gemma image vectors vs the Rijksmuseum's visual search</h1>
  <p>For each sampled artwork, the ten nearest neighbours by EmbeddingGemma&nbsp;2 image vector (<span style="color:#93c5fd">gemma.db</span>) are shown beside the ten the Rijksmuseum website's visual search returns. Matches found by both are outlined in teal.</p>
  <div class="stats" id="stats"></div>
</header>
<main>
  <h2>By category</h2>
  <div class="table-wrap"><table id="summary"></table></div>
  <p class="note">Overlap = neighbours in both top-10 lists. <i>Same type</i> shares an object type with the query; <i>same creator</i> has the identical creator label (anonymous excluded); <i>same series</i> shares the object-number stem (sheets of one album, pieces of one service, sides of one coin); <i>year gap</i> is the median distance from the query's earliest date. Columns read <span class="g">Gemma</span>&thinsp;/&thinsp;<span class="r">Rijksmuseum</span>.</p>

  <div class="controls">
    <div class="tabs" id="tabs"></div>
    <label>Sort <select id="sort">
      <option value="ov-asc">Least overlap first</option>
      <option value="ov-desc">Most overlap first</option>
      <option value="sample">Sample order</option>
    </select></label>
    <label>Max overlap <input id="maxov" type="range" min="0" max="${data.k}" value="${data.k}"> <output id="maxovv">${data.k}</output></label>
    <label>Image size <input id="tile" type="range" min="180" max="520" step="20" value="300"> <output id="tilev">300</output>px</label>
    <span class="legend">
      <span><span class="sw" style="border:2px solid var(--teal)"></span>in both lists</span>
      <span><b>C</b> same creator</span><span><b>S</b> same series</span>
    </span>
  </div>
  <div id="seeds"></div>
  <footer>Generated ${data.generatedAt.slice(0, 16).replace("T", " ")} UTC · gemma.db built ${data.gemmaBuild.slice(0, 10)} · k=${data.k}, seed excluded from both lists. Thumbnails from iiif.micr.io.</footer>
</main>
<script>
const DATA = ${JSON.stringify(data).replace(/</g, "\\u003c")};
const O = DATA.objects;
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
const iiif = (id, px) => "https://iiif.micr.io/" + encodeURIComponent(id) + "/full/!" + px + "," + px + "/0/default.jpg";
const link = n => "https://www.rijksmuseum.nl/en/collection/" + encodeURIComponent(n);
// Drop a trailing letter suffix (-A), then a trailing number only when it follows another
// number (RP-F-2001-7-62-111 → RP-F-2001-7-62), so SK-A-3741 stays its own stem.
const stem = n => { const b = n.replace(/-[A-Z]$/, ""); const m = b.match(/^(.*\\d)[-.]\\d+$/); return m ? m[1] : b; };
const normCreator = c => (c || "").toLowerCase().replace(/^(attributed to|workshop of|circle of|after|manner of)\\s+/, "").split(/[,(]/)[0].trim();

function profile(seed, list) {
  const q = O[seed], qt = new Set(q.types.map(t => t.id)), qc = normCreator(q.creator), qs = stem(seed);
  let type = 0, creator = 0, series = 0; const gaps = [];
  const flags = list.map(n => {
    const o = O[n];
    const f = { creator: !!qc && qc !== "anonymous" && normCreator(o.creator) === qc, series: stem(n) === qs };
    if (o.types.some(t => qt.has(t.id))) type++;
    if (f.creator) creator++;
    if (f.series) series++;
    if (q.year != null && o.year != null) gaps.push(Math.abs(o.year - q.year));
    return f;
  });
  gaps.sort((a, b) => a - b);
  return { type, creator, series, gap: gaps.length ? gaps[gaps.length >> 1] : null, flags };
}

const seeds = DATA.seeds.map((s, i) => {
  const g = s.gemma.map(h => h.objectNumber), gs = new Set(g), rs = new Set(s.rijks);
  return { ...s, i, g, gs, rs, overlap: s.rijks.filter(n => gs.has(n)).length,
           top1: g[0] === s.rijks[0], gp: profile(s.objectNumber, g), rp: profile(s.objectNumber, s.rijks) };
});

const mean = (a, f) => a.reduce((s, x) => s + f(x), 0) / a.length;
const median = a => { const v = a.filter(x => x != null).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : "–"; };
const pct = x => Math.round(x * 100) + "%";
const K = DATA.k;

document.getElementById("stats").innerHTML = [
  [seeds.length, "query works"],
  [mean(seeds, s => s.overlap).toFixed(1) + " / " + K, "mean overlap"],
  [seeds.filter(s => s.overlap === 0).length, "no shared neighbour"],
  [seeds.filter(s => s.overlap >= 7).length, "≥7 shared"],
  [pct(mean(seeds, s => s.top1)), "same top match"],
].map(([v, l]) => '<div class="stat"><b>' + v + '</b><span>' + l + '</span></div>').join("");

const rowsHtml = (label, S) => {
  const pair = (fg, fr) => '<span class="g">' + fg + '</span> / <span class="r">' + fr + '</span>';
  return "<tr><td>" + label + "</td><td>" + S.length + "</td><td>" + mean(S, s => s.overlap).toFixed(1) + "</td><td>" +
    S.filter(s => s.overlap === 0).length + "</td><td>" + pct(mean(S, s => s.top1)) + "</td><td>" +
    pair(pct(mean(S, s => s.gp.type / K)), pct(mean(S, s => s.rp.type / K))) + "</td><td>" +
    pair(pct(mean(S, s => s.gp.creator / K)), pct(mean(S, s => s.rp.creator / K))) + "</td><td>" +
    pair(pct(mean(S, s => s.gp.series / K)), pct(mean(S, s => s.rp.series / K))) + "</td><td>" +
    pair(median(S.map(s => s.gp.gap)), median(S.map(s => s.rp.gap))) + "</td></tr>";
};
document.getElementById("summary").innerHTML =
  "<thead><tr><th>Category</th><th>Works</th><th>Overlap@" + K + "</th><th>None shared</th><th>Same #1</th><th>Same type</th><th>Same creator</th><th>Same series</th><th>Year gap (median)</th></tr></thead><tbody>" +
  DATA.categories.map(c => rowsHtml(c.label, seeds.filter(s => s.category === c.key))).join("") +
  rowsHtml("<b>All</b>", seeds) + "</tbody>";

function thumb(n, rank, shared, f) {
  const o = O[n] || {};
  const tip = [n, o.title, o.creator, o.date].filter(Boolean).join(" · ");
  const tags = (f.creator ? "C" : "") + (f.series ? "S" : "");
  return '<a class="thumb' + (shared ? " shared" : "") + (o.iiifId ? "" : " noimg") + '" href="' + link(n) + '" target="_blank" rel="noopener" title="' + esc(tip) + '">' +
    (o.iiifId ? '<img loading="lazy" alt="" src="' + iiif(o.iiifId, 600) + '">' : "") +
    '<span class="rk">' + rank + '</span>' + (tags ? '<span class="tag">' + tags + '</span>' : "") + '</a>';
}
function strip(list, other, p) {
  return '<div class="strip">' + list.map((n, i) => thumb(n, i + 1, other.has(n), p.flags[i])).join("") + "</div>";
}
const summaryLine = p => "<small>" + p.type + " same type · " + p.creator + " same creator · " + p.series + " same series · median gap " + (p.gap ?? "–") + " yrs</small>";

function seedHtml(s) {
  const q = O[s.objectNumber];
  const cls = s.overlap === 0 ? "ov0" : s.overlap <= 3 ? "ovlo" : "ovhi";
  const cat = DATA.categories.find(c => c.key === s.category).label;
  return '<section class="seed"><div class="query">' +
    '<a href="' + link(s.objectNumber) + '" target="_blank" rel="noopener"><img loading="lazy" alt="" src="' + iiif(q.iiifId, 600) + '"></a>' +
    '<div class="meta"><a href="' + link(s.objectNumber) + '" target="_blank" rel="noopener">' + esc(s.objectNumber) + "</a><br>" +
    esc(q.title) + "<br><span style=\\"color:var(--muted)\\">" + esc([q.creator, q.date].filter(Boolean).join(", ")) + " · " + esc(cat) + "</span><br>" +
    '<span class="badge ' + cls + '">' + s.overlap + " / " + K + " shared</span></div></div><div>" +
    '<div class="row"><h3><span class="r">Rijksmuseum visual search</span>' + summaryLine(s.rp) + "</h3>" + strip(s.rijks, s.gs, s.rp) + "</div>" +
    '<div class="row"><h3><span class="g">Gemma image vectors</span>' + summaryLine(s.gp) + " <small>· top cosine " + s.gemma[0].similarity.toFixed(3) + "</small></h3>" + strip(s.g, s.rs, s.gp) + "</div>" +
    "</div></section>";
}

let cat = "all";
const tabs = document.getElementById("tabs");
tabs.innerHTML = [{ key: "all", label: "All" }, ...DATA.categories].map(c =>
  '<button data-k="' + c.key + '" aria-pressed="' + (c.key === cat) + '">' + c.label + "</button>").join("");
tabs.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  cat = b.dataset.k;
  tabs.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b));
  render();
});
const sortSel = document.getElementById("sort"), maxov = document.getElementById("maxov");
sortSel.addEventListener("change", render);
maxov.addEventListener("input", () => { document.getElementById("maxovv").textContent = maxov.value; render(); });
const tile = document.getElementById("tile");
tile.addEventListener("input", () => {
  document.documentElement.style.setProperty("--tile", tile.value + "px");
  document.getElementById("tilev").textContent = tile.value;
});
const controls = document.querySelector(".controls");
const syncControlsH = () => document.documentElement.style.setProperty("--controls-h", controls.offsetHeight + 8 + "px");
new ResizeObserver(syncControlsH).observe(controls);

function render() {
  const max = +maxov.value;
  let list = seeds.filter(s => (cat === "all" || s.category === cat) && s.overlap <= max);
  if (sortSel.value === "ov-asc") list = [...list].sort((a, b) => a.overlap - b.overlap || a.i - b.i);
  if (sortSel.value === "ov-desc") list = [...list].sort((a, b) => b.overlap - a.overlap || a.i - b.i);
  const groups = cat === "all" && sortSel.value === "sample"
    ? DATA.categories.map(c => [c.label, list.filter(s => s.category === c.key)])
    : [[null, list]];
  document.getElementById("seeds").innerHTML = groups.filter(([, l]) => l.length).map(([label, l]) =>
    (label ? "<h2>" + label + "</h2>" : "") + l.map(seedHtml).join("")).join("") ||
    '<p class="note">No works match this filter.</p>';
}
render();
</script>
</body></html>
`;
fs.writeFileSync(OUT, html);
console.error(`wrote ${OUT} (${Math.round(html.length / 1024)} KB)`);
