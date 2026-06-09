/**
 * Build an explanatory, parser-centric visualization of the Rijksmuseum
 * inscription field and what the #383 parser unlocks.
 *
 * This is a *companion* to scripts/build-inscription-report.py, written from a
 * different stance. The Python report's thesis is a deficit framing — "the field
 * is NOT a complete inventory" and ~half is collector-mark "boilerplate" to be
 * discounted. This generator instead treats the field as a rich, multi-layered
 * annotation log and shows how the parser makes it queryable along five
 * independent axes, leaning into perspectives the original missed:
 *
 *   - the flat-text → structured-record transformation itself
 *   - inscriptions as a *fingerprint of medium* (object-type × inscription-type)
 *   - collector marks as a *provenance layer*, not noise
 *   - Latin maker-formulas as a *role-attribution* layer
 *   - the new query axes the facet vocabulary opens up (live search_inscriptions)
 *
 * Every number and demo is authentic: it imports the SHIPPING parser from dist/
 * and calls the real VocabularyDb.searchInscriptions() — no re-derived logic.
 *
 * Run:    npm run build   (once, so dist/ is current)
 *         env -u RIJKS_MCP_HTTP node scripts/build-inscription-explorer.mjs
 * Output: offline/explorations/inscription-parser-explorer.html
 */

import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import {
  parseInscriptions,
  summarizeInscriptions,
  groupInscriptionMatches,
  INSCRIPTION_TYPES,
  INSCRIPTION_TECHNIQUES,
} from "../dist/inscriptions.js";
import { VocabularyDb } from "../dist/api/VocabularyDb.js";

const DB = process.env.VOCAB_DB_PATH || "data/vocabulary.db";
const OUT = "offline/explorations/inscription-parser-explorer.html";

const con = new Database(DB, { readonly: true });

// ─── Helpers ───────────────────────────────────────────────────────
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = (part, whole) => (whole ? (100 * part) / whole : 0);
const fmt = (n) => n.toLocaleString("en-US");
const incr = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const sortDesc = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);

// ─── Medium membership for the fingerprint cross-tab ────────────────
// One art_id can carry several object types; for the cross-tab a record counts
// toward every target medium it belongs to (interpretable as "inscriptions seen
// ON prints", etc.). field_id 15 = object type.
const MEDIA = ["painting", "print", "drawing", "photograph", "poster"];
const mediumIds = new Map(MEDIA.map((m) => [m, new Set()]));
for (const m of MEDIA) {
  const rows = con
    .prepare(
      `SELECT m.artwork_id AS id
       FROM mappings m JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
       WHERE m.field_id = 15 AND COALESCE(NULLIF(v.label_en,''), v.label_nl) = ?`,
    )
    .all(m);
  for (const r of rows) mediumIds.get(m).add(r.id);
}

// ─── Latin maker-formula roles (full words only — low false-positive) ──
const ROLE_FORMULAS = [
  { word: "invenit", role: "invenit", gloss: "designed / conceived the image" },
  { word: "delineavit", role: "delineavit", gloss: "drew it" },
  { word: "pinxit", role: "pinxit", gloss: "painted it" },
  { word: "sculpsit", role: "sculpsit", gloss: "engraved the plate" },
  { word: "fecit", role: "fecit", gloss: "made it (general)" },
  { word: "excudit", role: "excudit", gloss: "published / printed it" },
];
const roleRe = new RegExp(`\\b(${ROLE_FORMULAS.map((r) => r.word).join("|")})\\b`, "i");

// Hallmark vocabulary the parser recognises on silver / metalwork.
const HALLMARK_TYPES = new Set([
  "maker's mark",
  "town mark",
  "date letter",
  "alloy mark",
  "check stamp",
  "duty mark",
]);

// ─── Single full-population scan ───────────────────────────────────
const rows = con
  .prepare(
    `SELECT art_id, object_number, inscription_text
     FROM artworks
     WHERE inscription_text IS NOT NULL AND TRIM(inscription_text) <> ''`,
  )
  .all();

const totalArtworks = con.prepare("SELECT COUNT(*) AS n FROM artworks").get().n;
const recordCount = rows.length;

const lengths = [];
const segCountDist = new Map(); // "1","2","3-4","5-8","9+"
const typeRecordCounts = new Map();
const techRecordCounts = new Map();
const placementRecordCounts = new Map();
const langSegCounts = new Map(); // nl/en/unknown
const lugtRecordCounts = new Map();
const roleRecordCounts = new Map();
const composition = new Map();
// medium → { total, typeCounts: Map }
const mediumStats = new Map(MEDIA.map((m) => [m, { total: 0, typeCounts: new Map() }]));

let segmentsTotal = 0;
let segWithTypeToken = 0;
let segTypeRecognised = 0;
let recordsWithTranscribed = 0;
let recordsWithLugt = 0;
let recordsWithHallmark = 0;

// curated examples
const ex = { collectorPair: null, hallmarkStack: null, signatureDated: null, printRoles: null, longCaption: null, multilingualNotice: null };

for (const r of rows) {
  const text = r.inscription_text;
  lengths.push(text.length);
  const segs = parseInscriptions(text);
  segmentsTotal += segs.length;

  const nSeg = segs.length;
  const bucket = nSeg === 1 ? "1" : nSeg === 2 ? "2" : nSeg <= 4 ? "3–4" : nSeg <= 8 ? "5–8" : "9+";
  incr(segCountDist, bucket);

  const sum = summarizeInscriptions(segs);
  for (const t of sum.types) incr(typeRecordCounts, t);
  for (const t of sum.techniques) incr(techRecordCounts, t);
  for (const p of sum.placements) incr(placementRecordCounts, p);

  // segment-level recognition + language
  for (const s of segs) {
    incr(langSegCounts, s.language);
    if (s.type != null) {
      segWithTypeToken++;
      if (s.normalizedType != null) segTypeRecognised++;
    }
  }

  // collector marks (record-level distinct)
  const marks = new Set(sum.collectorMarks);
  for (const mk of marks) incr(lugtRecordCounts, mk);
  if (marks.size) recordsWithLugt++;

  // hallmark presence
  const hasHallmark = sum.types.some((t) => HALLMARK_TYPES.has(t));
  if (hasHallmark) recordsWithHallmark++;

  // transcribed?
  if (sum.hasTranscribedText) recordsWithTranscribed++;

  // composition (neutral framing)
  let comp;
  if (sum.hasTranscribedText) comp = "Carries transcribed text";
  else if (marks.size) comp = "Collector / ownership mark";
  else if (segs.every((s) => s.isPlaceholder)) comp = "Type label only (value not catalogued)";
  else comp = "Described mark, no quoted value";
  incr(composition, comp);

  // Latin roles (over transcribed text + raw value)
  const corpus = segs.map((s) => (s.transcribedText.join(" ") + " " + (s.value || ""))).join(" ");
  for (const rf of ROLE_FORMULAS) {
    if (new RegExp(`\\b${rf.word}\\b`, "i").test(corpus)) incr(roleRecordCounts, rf.role);
  }

  // medium cross-tab
  for (const m of MEDIA) {
    if (mediumIds.get(m).has(r.art_id)) {
      const ms = mediumStats.get(m);
      ms.total++;
      for (const t of sum.types) incr(ms.typeCounts, t);
    }
  }

  // ── curated example capture (first qualifying, stable row order) ──
  if (!ex.collectorPair && /verzamelaarsmerk/i.test(text) && /collector/i.test(text) && marks.size === 1 && text.length <= 130) {
    ex.collectorPair = { obj: r.object_number, text, segs };
  }
  if (!ex.hallmarkStack) {
    const hk = new Set(sum.types.filter((t) => HALLMARK_TYPES.has(t)));
    if (hk.size >= 3) ex.hallmarkStack = { obj: r.object_number, text, segs };
  }
  if (!ex.signatureDated) {
    const sd = segs.find(
      (s) =>
        (s.normalizedType === "signature and date" ||
          (s.normalizedType === "signature" && /\b(1[5-9]\d\d|20\d\d)\b/.test(s.transcribedText.join(" ")))) &&
        s.transcribedText.length &&
        (s.normalizedPlacement || s.normalizedTechnique),
    );
    if (sd && text.length <= 200) ex.signatureDated = { obj: r.object_number, text, segs };
  }
  if (!ex.printRoles && marks.size && roleRe.test(corpus)) {
    const hasQuote = segs.some((s) => s.transcribedText.length);
    if (hasQuote && text.length <= 360) ex.printRoles = { obj: r.object_number, text, segs };
  }
  if (!ex.longCaption) {
    const lc = segs.find(
      (s) =>
        s.transcribedText.join(" ").length > 180 &&
        !["copyright notice", "address", "address and date", "negative number"].includes(s.normalizedType),
    );
    if (lc) ex.longCaption = { obj: r.object_number, text, segs };
  }
}

// ─── Live search_inscriptions demos (real shipping path) ───────────
const vdb = new VocabularyDb();
const sampleOf = (res) => res.results[0] || null;
const demo = (label, params, blurb) => {
  const res = vdb.searchInscriptions(params);
  return { label, params, blurb, ...res, sample: sampleOf(res) };
};

const demos = [
  demo(
    "A handwritten signature on the verso",
    { inscriptionType: "signature", placement: "verso", technique: "handwritten", maxResults: 1 },
    "Three facets that must hold for one and the same mark — impossible to express with substring search.",
  ),
  demo(
    "Works bearing a watermark",
    { inscriptionType: "watermark", maxResults: 1 },
    "A single typed facet pulls every catalogued watermark, in Dutch (watermerk) or English.",
  ),
  demo(
    "An engraved monogram",
    { inscriptionType: "monogram", technique: "engraved", maxResults: 1 },
    "Type + technique together — the unsigned mark of an identifiable hand.",
  ),
  demo(
    "Everything from the F. G. Waller bequest",
    { collectorMark: "Lugt 2760", maxResults: 1 },
    "A collector-mark number resolves to a provenance set: every sheet that passed through one collection before reaching the museum.",
  ),
  demo(
    "Prints inscribed “fecit”",
    { transcribedText: "fecit", maxResults: 1 },
    "Search the transcription itself — surface the Latin maker-formulas that encode who made the plate.",
  ),
].filter(Boolean);

// naive-LIKE contrast for the flagship facet query
const likeAllThree = con
  .prepare(
    `SELECT COUNT(*) AS n FROM artworks
     WHERE inscription_text LIKE '%signat%' AND inscription_text LIKE '%verso%' AND inscription_text LIKE '%handgeschreven%'`,
  )
  .get().n;

// ─── Derived summary numbers ───────────────────────────────────────
lengths.sort((a, b) => a - b);
const median = (arr) => arr[Math.floor(arr.length / 2)];
const medianLen = median(lengths);
const typeRecognPct = pct(segTypeRecognised, segWithTypeToken);
const langTotal = [...langSegCounts.values()].reduce((a, b) => a + b, 0);

// ── stderr diagnostics (for annotation pass) ──
console.error("records:", fmt(recordCount), "segments:", fmt(segmentsTotal));
console.error("type-recognition:", typeRecognPct.toFixed(2) + "%");
console.error("TOP LUGT:", sortDesc(lugtRecordCounts).slice(0, 12).map(([k, v]) => `${k}=${v}`).join("  "));
console.error("examples:", Object.entries(ex).map(([k, v]) => `${k}:${v ? v.obj : "—"}`).join("  "));
console.error("demos:", demos.map((d) => `${d.label}=${d.totalConfirmed}/${d.totalCandidates}`).join("  "));
for (const m of MEDIA) {
  const ms = mediumStats.get(m);
  console.error(`TOPTYPES ${m}:`, sortDesc(ms.typeCounts).slice(0, 8).map(([k, v]) => `${k}=${pct(v, ms.total).toFixed(0)}%`).join("  "));
}

// ─── Collector-mark identifications (Frits Lugt, Marques de Collections) ──
// Only marks identified with confidence from authoritative sources (Fondation
// Custodia / Met / NGA provenance records). The headline finding: the three
// most common "collector" marks are the museum's OWN print-room stamps — the
// Rijksmuseum stamping its own acquisitions — not private collectors. The
// largest genuine prior-owner mark is F.G. Waller's. kind: "museum" | "owner".
const LUGT_NAMES = {
  "2228": { name: "Rijksprentenkabinet, Rijksmuseum", kind: "museum" },
  "240": { name: "Rijksprentenkabinet, Rijksmuseum — early red stamp", kind: "museum" },
  "2233": { name: "Rijksprentenkabinet, Rijksmuseum — late 19th c.", kind: "museum" },
  "2228A": { name: "Rijksprentenkabinet, Rijksmuseum — variant of L.2228", kind: "museum" },
  "2760": { name: "François Gérard Waller (1867–1934), Amsterdam", kind: "owner" },
};

// ════════════════════════════════════════════════════════════════════
//  Render helpers
// ════════════════════════════════════════════════════════════════════
function barRows(items, total, color, opts = {}) {
  if (!items.length) return "";
  const max = Math.max(...items.map(([, c]) => c)) || 1;
  return (
    '<div class="bars">' +
    items
      .map(([label, count]) => {
        const w = (100 * count) / max;
        const meta = opts.countOnly ? fmt(count) : `${pct(count, total).toFixed(1)}% · ${fmt(count)}`;
        return (
          `<div class="bar-row"><div class="bar-label">${esc(label)}</div>` +
          `<div class="bar-track"><div class="bar-fill" style="width:${w.toFixed(1)}%;background:${color}"></div></div>` +
          `<div class="bar-value">${meta}</div></div>`
        );
      })
      .join("") +
    "</div>"
  );
}

function table(headers, rowsHtml) {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${rowsHtml}</tbody></table>`;
}

// heat grid: rows = media, cols = inscription types, cell shaded by % of that
// medium's inscribed records carrying that type.
function heatGrid(media, cols) {
  const head =
    "<tr><th></th>" + cols.map((c) => `<th class="rot"><span>${esc(c)}</span></th>`).join("") + "</tr>";
  const body = media
    .map((m) => {
      const ms = mediumStats.get(m);
      const cells = cols
        .map((c) => {
          const v = pct(ms.typeCounts.get(c) || 0, ms.total);
          const a = Math.min(1, v / 60); // saturate at 60%
          const txt = v >= 0.5 ? `${v.toFixed(0)}` : "";
          const fg = a > 0.55 ? "#fff" : "#1b2530";
          return `<td class="cell" style="background:rgba(31,122,114,${a.toFixed(2)});color:${fg}" title="${esc(c)}: ${v.toFixed(1)}%">${txt}</td>`;
        })
        .join("");
      return `<tr><th class="rowlab">${esc(m)} <span class="muted">${fmt(ms.total)}</span></th>${cells}</tr>`;
    })
    .join("");
  return `<table class="heat">${head}${body}</table>`;
}

// raw → structured: render a parsed record as annotated segment cards.
function parsedRecord(rec) {
  const segCards = rec.segs
    .map((s) => {
      const chips = [];
      if (s.normalizedType) chips.push(`<span class="chip type">${esc(s.normalizedType)}</span>`);
      else if (s.type) chips.push(`<span class="chip type ghost">${esc(s.type)}</span>`);
      if (s.normalizedPlacement) chips.push(`<span class="chip place">${esc(s.normalizedPlacement)}</span>`);
      if (s.normalizedTechnique) chips.push(`<span class="chip method">${esc(s.normalizedTechnique)}</span>`);
      chips.push(`<span class="chip lang">${esc(s.language)}</span>`);
      const tx = s.transcribedText.length
        ? `<div class="seg-val">“${s.transcribedText.map(esc).join("” · “")}”</div>`
        : s.collectorMarks.length
          ? `<div class="seg-val mark">${s.collectorMarks.map((m) => esc(`${m.catalogue} ${m.number}`)).join(", ")}</div>`
          : s.isPlaceholder
            ? `<div class="seg-val none">— type label, no value —</div>`
            : s.value
              ? `<div class="seg-val">${esc(s.value)}</div>`
              : "";
      return `<div class="seg"><div class="seg-raw">${esc(s.raw)}</div><div class="seg-facets">${chips.join("")}</div>${tx}</div>`;
    })
    .join("");
  return `<div class="parsed"><div class="parsed-obj">${esc(rec.obj)}</div>${segCards}</div>`;
}

// Folded render: collapse a gloss pair to the single logical match the parser
// produces (R6), with a note naming the per-label languages. Used where showing
// every raw segment would just repeat the same (untranslated) transcription.
function foldedRecord(rec) {
  const m = groupInscriptionMatches(rec.segs)[0];
  if (!m) return parsedRecord(rec);
  const labels = rec.segs.map(
    (s) =>
      `${esc(s.normalizedType || s.type || "—")}${s.normalizedPlacement ? ", " + esc(s.normalizedPlacement) : ""} <span class="chip lang">${esc(s.language)}</span>`,
  );
  const chips = [];
  if (m.normalizedType) chips.push(`<span class="chip type">${esc(m.normalizedType)}</span>`);
  for (const o of m.occurrences) {
    const q = [o.placement, o.technique].filter(Boolean).join(" · ");
    if (q) chips.push(`<span class="chip place">${esc(q)}</span>`);
  }
  const val = m.value ? `“${esc(m.value)}”` : "";
  return (
    `<div class="parsed"><div class="parsed-obj">${esc(rec.obj)}</div>` +
    `<div class="seg"><div class="seg-facets">${chips.join("")}</div>` +
    (val ? `<div class="seg-val">${val}</div>` : "") +
    `<div class="fold-note">Catalogued under ${rec.segs.length} type labels — ${labels.join(" &nbsp;·&nbsp; ")} — and folded into one transcription. The words themselves are never translated, so each label carries the same Dutch text.</div>` +
    `</div></div>`
  );
}

function exampleCard(title, gloss, rec, folded = false) {
  if (!rec) return "";
  return (
    `<article class="example"><h3>${esc(title)}</h3><p class="ex-gloss">${gloss}</p>` +
    `<code class="raw">${esc(rec.text)}</code>${folded ? foldedRecord(rec) : parsedRecord(rec)}</article>`
  );
}

function demoCard(d) {
  const s = d.sample;
  let sampleHtml = '<div class="demo-empty">no sample</div>';
  if (s) {
    const mi = s.matchedInscriptions[0];
    const occ = mi.occurrences
      .map((o) => [o.placement, o.technique].filter(Boolean).join(" · ") || "—")
      .join(" / ");
    const val = mi.value ? `“${esc(mi.value)}”` : mi.collectorMark ? esc(`${mi.collectorMark.catalogue} ${mi.collectorMark.number}`) : "—";
    sampleHtml =
      `<div class="demo-sample"><div class="ds-title">${esc(s.title)}</div>` +
      `<div class="ds-meta">${esc(s.creator || "—")}${s.date ? " · " + esc(s.date) : ""} · <span class="mono">${esc(s.objectNumber)}</span></div>` +
      `<div class="ds-match"><span class="chip type">${esc(mi.normalizedType || "—")}</span> ${val} <span class="ds-occ">${esc(occ)}</span></div></div>`;
  }
  const p = d.params;
  const collectorOnly = p.collectorMark && !(p.inscriptionType || p.placement || p.technique || p.transcribedText || p.text);
  let nums;
  if (collectorOnly) {
    // A single collector-mark facet: the FTS candidate count IS the provenance
    // set (every record bearing the mark); confirmed is parse-capped, so the
    // candidate count is the honest headline here.
    nums =
      `<div class="dn"><b>${fmt(d.totalCandidates)}</b><span>sheets bearing this mark (provenance set)</span></div>` +
      (d.candidatesCapped ? '<div class="dn ghost"><b>cap</b><span class="capwarn">beyond the 20k parse cap — §09</span></div>' : "");
  } else {
    const cap = d.candidatesCapped ? '<span class="capwarn">parse cap hit — partial</span>' : "";
    nums =
      `<div class="dn"><b>${fmt(d.totalConfirmed)}</b><span>confirmed (parser-precise)</span></div>` +
      `<div class="dn ghost"><b>${fmt(d.totalCandidates)}</b><span>naive co-occurrence ${cap}</span></div>`;
  }
  return (
    `<article class="demo"><h3>${esc(d.label)}</h3><p class="demo-blurb">${d.blurb}</p>` +
    `<div class="demo-nums">${nums}</div>` +
    sampleHtml +
    `</article>`
  );
}

// ─── Build datasets for the page ───────────────────────────────────
// Columns chosen to maximise contrast between media (each lights up somewhere
// distinct): signature/sig+date mark paintings, collector's mark marks prints,
// cliché instruction marks drawings, factory mark + number mark photographs,
// date marks posters.
const HEAT_COLS = [
  "signature",
  "signature and date",
  "inscription",
  "annotation",
  "date",
  "collector's mark",
  "number",
  "stamp",
  "cliché instruction",
  "factory mark",
];

const compOrder = [
  "Carries transcribed text",
  "Collector / ownership mark",
  "Described mark, no quoted value",
  "Type label only (value not catalogued)",
];
const compPalette = ["#1f7a72", "#33658f", "#6a5a93", "#94a3b8"];
const compItems = compOrder.map((l) => [l, composition.get(l) || 0]);
const stackSeg = compItems
  .map(([l, c], i) => `<div style="width:${pct(c, recordCount).toFixed(2)}%;background:${compPalette[i]}" title="${esc(l)}: ${pct(c, recordCount).toFixed(1)}%"></div>`)
  .join("");
const stackLegend = compItems
  .map(([l, c], i) => `<div><span class="swatch" style="background:${compPalette[i]}"></span><b>${pct(c, recordCount).toFixed(1)}%</b> ${esc(l)} <span class="muted">(${fmt(c)})</span></div>`)
  .join("");

const langOrder = ["nl", "en", "unknown"];
const langLabels = { nl: "Dutch (detailed cataloguing side)", en: "English (gloss side)", unknown: "Unknown (value-only / mark-only)" };
const langBars = barRows(
  langOrder.map((l) => [langLabels[l], langSegCounts.get(l) || 0]),
  langTotal,
  "#33658f",
);

const segDistOrder = ["1", "2", "3–4", "5–8", "9+"];
const segBars = barRows(
  segDistOrder.map((b) => [`${b} segment${b === "1" ? "" : "s"}`, segCountDist.get(b) || 0]),
  recordCount,
  "#475569",
);

const typeBars = barRows(sortDesc(typeRecordCounts).slice(0, 12), recordCount, "#1f7a72");
const techBars = barRows(sortDesc(techRecordCounts).slice(0, 10), recordCount, "#6a5a93");
const placeBars = barRows(sortDesc(placementRecordCounts), recordCount, "#b07a2e");

const lugtRows = sortDesc(lugtRecordCounts)
  .slice(0, 12)
  .map(([mark, c]) => {
    const num = mark.match(/(\d+[a-z]?)/i)?.[1];
    const info = LUGT_NAMES[num];
    const who = info ? esc(info.name) : '<span class="muted">unidentified — look up&nbsp;↗</span>';
    const tag = info
      ? info.kind === "museum"
        ? '<span class="tag museum">museum’s own stamp</span>'
        : '<span class="tag owner">prior owner</span>'
      : "";
    return `<tr><td class="mono">${esc(mark)}</td><td>${who} ${tag}</td><td>${fmt(c)}</td><td>${pct(c, recordCount).toFixed(1)}%</td></tr>`;
  })
  .join("");
const lugtTable = table(["Mark", "Identified as (Frits Lugt no.)", "Records", "Share"], lugtRows);

const roleRows = ROLE_FORMULAS.map((rf) => {
  const c = roleRecordCounts.get(rf.role) || 0;
  return `<tr><td class="mono"><i>${esc(rf.word)}</i></td><td>${esc(rf.gloss)}</td><td>${fmt(c)}</td></tr>`;
}).join("");
const roleTable = table(["Formula", "Meaning", "Records w/ transcription"], roleRows);

const demoCards = demos.map(demoCard).join("");

const examplesHtml = [
  exampleCard(
    "One mark, recorded twice",
    "The Dutch side carries the operational metadata (placement, method); the English side is a bare gloss. The parser folds the pair into one logical match (R6) — note both rows collapse to a single occurrence.",
    ex.collectorPair,
  ),
  exampleCard(
    "A silversmith's hallmark stack",
    "Several distinct marks struck together. The parser types each one — maker, town, assay, date letter — turning a flat string into the components needed to localise and date the object.",
    ex.hallmarkStack,
  ),
  exampleCard(
    "A signature and its date",
    "Transcription, placement, and method all attach to a single typed mark — the unit a researcher actually wants.",
    ex.signatureDated,
  ),
  exampleCard(
    "A long image-borne text",
    "A caption or annotation actually written on the sheet. It is catalogued twice — under an English type label (<code>inscription</code>) and a Dutch one (<code>opschrift, verso</code>) — but a transcription is never translated, so both copies carry the same Dutch words. The parser folds them into one match.",
    ex.longCaption,
    true,
  ),
]
  .filter(Boolean)
  .join("");

// ════════════════════════════════════════════════════════════════════
//  HTML
// ════════════════════════════════════════════════════════════════════
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Inscription Parser: turning a flat field into queryable records</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,500..600;1,6..72,500..600&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --ink:#1b2530;--muted:#5b6672;--soft:#8a94a0;--paper:#f6f5f1;--panel:#fff;
  --line:rgba(27,37,48,.12);--line-soft:rgba(27,37,48,.07);--track:rgba(27,37,48,.06);
  --teal:#1f7a72;--blue:#33658f;--ochre:#b07a2e;--violet:#6a5a93;--slate:#475569;--red:#b04a45;
  --serif:"Newsreader",Georgia,"Times New Roman",serif;--sans:"Geist",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box}
body{margin:0;color:var(--ink);background:var(--paper);font:15px/1.6 var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
main{max-width:1120px;margin:0 auto;padding:0 24px 90px}
.hero{background:linear-gradient(135deg,#13312e 0%,#1f4a45 55%,#334155 100%);color:#e6edf3;border-bottom:4px solid var(--teal)}
.hero-inner{max-width:1120px;margin:0 auto;padding:58px 24px 42px}
.eyebrow{margin:0 0 16px;color:#7fcabf;font:500 11px/1.4 var(--mono);text-transform:uppercase;letter-spacing:.16em}
.eyebrow code{font-family:var(--mono);color:#a7ded4}
h1{margin:0;max-width:900px;font:600 45px/1.08 var(--serif);letter-spacing:-.01em;color:#f4f7fa}
.hero p{max-width:800px;margin:20px 0 0;color:#a9bccb;font-size:17px;line-height:1.6}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-top:38px}
.kpi{border:1px solid rgba(255,255,255,.14);border-top:2px solid var(--teal);padding:16px;background:rgba(255,255,255,.05);border-radius:8px}
.kpi b{display:block;font:500 30px/1.1 var(--mono);color:#e2e8f0;font-variant-numeric:tabular-nums}
.kpi span{display:block;margin-top:8px;color:#9fb4c2;font-size:12px;line-height:1.45}
section{margin-top:58px}
.sec-head{display:flex;align-items:baseline;gap:12px;margin:0 0 8px}
.sec-index{flex:none;font:500 13px/1 var(--mono);color:var(--teal);letter-spacing:.08em}
h2{margin:0;font:600 27px/1.18 var(--serif);letter-spacing:-.005em}
h3{margin:0 0 12px;font:500 11px/1.3 var(--mono);text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}
.lead{margin:0 0 20px;max-width:840px;color:var(--muted);font-size:14.5px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:24px;overflow-x:auto}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
code{font:13px/1.5 var(--mono)}
.muted{color:var(--muted)}.mono{font-family:var(--mono)}
.grammar{padding:18px 20px;overflow-x:auto;white-space:nowrap;color:#e7eef4;background:#1e293b;border-radius:8px;font:13px/1.6 var(--mono)}
.chip{display:inline-block;padding:3px 8px;border-radius:4px;font:500 12px/1.4 var(--mono);color:#fff;white-space:nowrap}
.chip.ghost{background:transparent!important;border:1px dashed currentColor;color:#94a3b8}
.type{background:var(--teal)}.place{background:var(--ochre)}.method{background:var(--violet)}.value{background:var(--slate)}
.chip.lang{background:#cbd5e1;color:#334155}
.sep{color:#7d8a98;padding:0 2px}
.legend{display:flex;gap:18px;flex-wrap:wrap;margin-top:16px;color:var(--muted);font-size:12.5px}
.swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:8px;vertical-align:-1px}
.stack{display:flex;height:34px;overflow:hidden;border-radius:8px;background:var(--track)}
.stack>div{height:100%}
.stack-legend{display:grid;grid-template-columns:1fr 1fr;gap:12px 24px;margin-top:20px;font-size:13px}
.stack-legend b{font-family:var(--mono);font-weight:500;font-variant-numeric:tabular-nums}
.bars{display:flex;flex-direction:column;gap:10px}
.bar-row{display:grid;grid-template-columns:180px 1fr 116px;gap:12px;align-items:center}
.bar-label{color:var(--ink);font-size:13px;text-align:right;line-height:1.25}
.bar-track{height:16px;border-radius:4px;background:var(--track);overflow:hidden}
.bar-fill{height:100%;border-radius:4px}
.bar-value{color:var(--muted);font:12px/1 var(--mono);font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{padding:10px;border-bottom:1px solid var(--line-soft);text-align:left;vertical-align:middle}
th{color:var(--muted);font:500 10.5px/1.3 var(--mono);letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid var(--line)}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:rgba(31,122,114,.04)}
td:nth-child(n+3){font-variant-numeric:tabular-nums;color:var(--muted)}
/* heat grid */
table.heat{border-collapse:separate;border-spacing:3px}
table.heat th.rot{height:96px;vertical-align:bottom;padding:0 0 6px;border:none}
table.heat th.rot span{display:inline-block;transform:rotate(-50deg);transform-origin:left bottom;white-space:nowrap;font:500 11px/1 var(--mono);color:var(--muted);text-transform:none;letter-spacing:0}
table.heat th.rowlab{text-align:right;font:500 13px/1.3 var(--sans);color:var(--ink);text-transform:none;letter-spacing:0;border:none;white-space:nowrap;padding-right:12px}
table.heat th.rowlab .muted{font:11px/1 var(--mono)}
td.cell{width:46px;height:34px;text-align:center;border:none;border-radius:4px;font:500 12px/1 var(--mono);font-variant-numeric:tabular-nums}
.note{margin:18px 0 0;padding:2px 0 2px 16px;border-left:2px solid var(--teal);color:var(--muted);font:italic 500 14.5px/1.55 var(--serif)}
.note code{font-style:normal;font-family:var(--mono);font-size:12px}
/* parsed record */
.raw{display:block;white-space:pre-wrap;word-break:break-word;background:#1e293b;color:#cfe6e1;padding:12px 14px;border-radius:6px;font-size:12px;line-height:1.55}
.parsed{margin-top:12px;display:flex;flex-direction:column;gap:8px}
.parsed-obj{font:11px/1.3 var(--mono);color:var(--teal);letter-spacing:.04em}
.seg{border:1px solid var(--line);border-left:3px solid var(--teal);border-radius:0 6px 6px 0;padding:9px 12px;background:#fcfcfb}
.seg-raw{font:12px/1.4 var(--mono);color:var(--soft);word-break:break-word}
.seg-facets{display:flex;gap:6px;flex-wrap:wrap;margin:7px 0 0}
.seg-val{margin-top:6px;font-size:13px;color:var(--ink)}
.seg-val.mark{font-family:var(--mono);color:var(--blue)}
.seg-val.none{color:var(--soft);font-style:italic}
.fold-note{margin-top:10px;padding-top:9px;border-top:1px dashed var(--line);font-size:11.5px;color:var(--muted);line-height:1.55}
.fold-note .chip.lang{padding:1px 5px;font-size:10px;vertical-align:1px}
.fold-note code{background:var(--track);padding:1px 5px;border-radius:3px}
.example{border:1px solid var(--line);border-radius:8px;padding:18px;background:var(--panel)}
.example h3{margin:0 0 4px;font:600 14px/1.3 var(--sans);text-transform:none;letter-spacing:0;color:var(--ink)}
.ex-gloss{margin:0 0 12px;color:var(--muted);font-size:13px;line-height:1.5}
/* demo cards */
.demo{border:1px solid var(--line);border-radius:8px;padding:18px;background:var(--panel)}
.demo h3{margin:0 0 4px;font:600 14px/1.3 var(--sans);text-transform:none;letter-spacing:0;color:var(--ink)}
.demo-blurb{margin:0 0 14px;color:var(--muted);font-size:12.5px;line-height:1.5}
.demo-nums{display:flex;gap:14px;margin-bottom:14px}
.dn{flex:1;border:1px solid var(--line);border-top:2px solid var(--teal);border-radius:6px;padding:10px 12px}
.dn.ghost{border-top-color:var(--soft);opacity:.85}
.dn b{display:block;font:500 22px/1.1 var(--mono);font-variant-numeric:tabular-nums}
.dn span{display:block;margin-top:4px;font-size:11px;color:var(--muted)}
.capwarn{color:var(--red);font-weight:500}
.demo-sample{border-top:1px dashed var(--line);padding-top:12px}
.ds-title{font:500 13.5px/1.3 var(--sans);color:var(--ink)}
.ds-meta{margin-top:2px;font-size:11.5px;color:var(--muted)}
.ds-match{margin-top:9px;font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ds-occ{font:11px/1.3 var(--mono);color:var(--ochre)}
.callout{margin-top:18px;border-left:3px solid var(--blue);padding:14px 18px;background:#f0f5fa;color:#28384a;border-radius:0 6px 6px 0;font-size:13.5px;line-height:1.55}
.callout b{color:var(--blue)}
.tag{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:10px;font:500 10px/1.5 var(--mono);white-space:nowrap;vertical-align:1px}
.tag.museum{background:#e4ebf1;color:#33658f}
.tag.owner{background:#e7f2ef;color:#1f7a72}
.axes{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-top:4px}
.axis{border:1px solid var(--line);border-top:2px solid var(--teal);border-radius:6px;padding:12px}
.axis b{display:block;font:500 12px/1.3 var(--mono);color:var(--teal);text-transform:uppercase;letter-spacing:.08em}
.axis span{display:block;margin-top:6px;font-size:12.5px;color:var(--muted)}
footer{margin-top:70px;padding-top:20px;border-top:1px solid var(--line);color:var(--soft);font:12px/1.7 var(--mono)}
footer code{color:var(--muted)}
@media(max-width:820px){
  main,.hero-inner{padding-left:16px;padding-right:16px}
  h1{font-size:34px}
  .kpis,.grid-2,.grid-3,.axes{grid-template-columns:1fr}
  .bar-row{grid-template-columns:120px 1fr 96px}
  .stack-legend{grid-template-columns:1fr}
  .demo-nums{flex-direction:column}
}
</style>
</head>
<body>
<header class="hero"><div class="hero-inner">
  <p class="eyebrow">A light parser for <code>artworks.inscription_text</code> · Rijksmuseum MCP+ · issue #383</p>
  <h1>One flat text field, five new ways to ask questions of it.</h1>
  <p>Every signature, hallmark, watermark, caption and collector's stamp the Rijksmuseum has catalogued lives in a single pipe-delimited string. The #383 parser reads that string's bilingual grammar and emits structured records — so the marks become searchable by <i>type</i>, <i>technique</i>, <i>placement</i>, <i>transcription</i>, and <i>collector</i>, instead of by blind substring.</p>
  <div class="kpis">
    <div class="kpi"><b>${pct(recordCount, totalArtworks).toFixed(1)}%</b><span>of ${fmt(totalArtworks)} artworks carry inscription text (${fmt(recordCount)} records)</span></div>
    <div class="kpi"><b>${fmt(segmentsTotal)}</b><span>segments parsed — each a single physical mark or its gloss</span></div>
    <div class="kpi"><b>${typeRecognPct.toFixed(1)}%</b><span>of typed segments resolve to one of the ${INSCRIPTION_TYPES.length} normalised type buckets</span></div>
    <div class="kpi"><b>5</b><span>independent query axes opened by the facet vocabulary</span></div>
  </div>
</div></header>

<main>

<section>
  <div class="sec-head"><span class="sec-index">01</span><h2>From a flat string to structured records</h2></div>
  <p class="lead">Each physical mark is usually catalogued twice: a Dutch segment carrying the operational detail (placement, method) and an English gloss that keeps only the type and value. A segment is <code>&lt;header&gt;: &lt;value&gt;</code>, where the header is a type followed by an any-order run of placement/technique qualifiers — classified by vocabulary membership, not by fixed position.</p>
  <div class="panel">
    <div class="grammar"><span class="chip type">verzamelaarsmerk</span><span class="sep">,</span> <span class="chip place">verso</span><span class="sep">,</span> <span class="chip method">gestempeld</span><span class="sep">:</span> <span class="chip value">Lugt 2228</span><span class="sep"> | </span><span class="chip type">collector's mark</span><span class="sep">:</span> <span class="chip value">Lugt 2228</span></div>
    <div class="legend">
      <span><span class="swatch" style="background:var(--teal)"></span>type</span>
      <span><span class="swatch" style="background:var(--ochre)"></span>placement (recto / verso)</span>
      <span><span class="swatch" style="background:var(--violet)"></span>technique</span>
      <span><span class="swatch" style="background:var(--slate)"></span>value (transcription / mark)</span>
    </div>
    <p class="note">Median record: ${medianLen} characters. The parser is lossless — every segment keeps its <code>raw</code> text — and the bilingual pair is folded back into one logical match at the result layer, so the same mark is never counted twice.</p>
    <div class="axes">
      <div class="axis"><b>type</b><span>${INSCRIPTION_TYPES.length} buckets: signature, watermark, hallmark, collector's mark…</span></div>
      <div class="axis"><b>technique</b><span>${INSCRIPTION_TECHNIQUES.length} buckets: handwritten, engraved, stamped, etched…</span></div>
      <div class="axis"><b>placement</b><span>recto / verso — the load-bearing surface signal</span></div>
      <div class="axis"><b>transcription</b><span>the quoted text actually on the work</span></div>
      <div class="axis"><b>collector</b><span>Lugt catalogue numbers → provenance</span></div>
    </div>
  </div>
</section>

<section>
  <div class="sec-head"><span class="sec-index">02</span><h2>What the marks are made of</h2></div>
  <p class="lead">Record-level frequencies after the parser unifies Dutch and English labels into normalised buckets. Type tells you <i>what kind of mark</i>; technique tells you <i>how it was applied</i>; placement tells you <i>which side</i>.</p>
  <div class="grid-3">
    <div class="panel"><h3>Type · top 12 of ${INSCRIPTION_TYPES.length}</h3>${typeBars}</div>
    <div class="panel"><h3>Technique · top 10 of ${INSCRIPTION_TECHNIQUES.length}</h3>${techBars}</div>
    <div class="panel"><h3>Placement</h3>${placeBars}<p class="note" style="margin-top:20px">Verso dominance is a feature: it is where collection-management marks live, which is exactly what makes the provenance layer (§05) so rich.</p></div>
  </div>
</section>

<section>
  <div class="sec-head"><span class="sec-index">03</span><h2>How clean is the signal?</h2></div>
  <p class="lead">A facet vocabulary is only useful if it covers the population. Two views establish trust: how reliably type tokens resolve, and how the bilingual structure splits — the basis for the parser's language inference and gloss-deduplication.</p>
  <div class="grid-2">
    <div class="panel"><h3>Language inferred per segment</h3>${langBars}<p class="note" style="margin-top:18px">Language is inferred from <i>which vocabulary</i> a segment's tokens came from — not guessed. Value-only and mark-only segments are honestly “unknown”.</p></div>
    <div class="panel"><h3>Segments per record</h3>${segBars}<p class="note" style="margin-top:18px">Multi-mark objects stack up: each additional physical mark adds another Dutch/English pair, so a hallmarked silver box or a much-handled print runs to 6, 8, or more segments.</p></div>
  </div>
  <div class="callout"><b>${typeRecognPct.toFixed(1)}%</b> of segments that carry a type token resolve to one of the ${INSCRIPTION_TYPES.length} normalised buckets. The remaining long tail is genuinely diverse (each unrecognised token &lt;0.03% of the population), and falls through as a literal passthrough rather than being dropped — the closed bucket set is the public contract, not a lossy filter.</div>
</section>

<section>
  <div class="sec-head"><span class="sec-index">04</span><h2>Inscriptions as a fingerprint of medium</h2></div>
  <p class="lead">The most revealing view is not a single ranking — it is how the <i>mix</i> of inscription types shifts by object type. Each medium has its own signature: paintings sign on the front, prints accrete collectors' stamps, photographs carry studio and process stamps. Cell = share of that medium's inscribed records carrying that type.</p>
  <div class="panel">${heatGrid(MEDIA, HEAT_COLS)}<p class="note" style="margin-top:18px">Read across a row to see a medium's habits; read down a column to see which media share a practice. The numbers are percentages; blank cells are below 0.5%.</p></div>
</section>

<section>
  <div class="sec-head"><span class="sec-index">05</span><h2>Collector marks are a provenance layer, not boilerplate</h2></div>
  <p class="lead">Roughly half of inscribed records carry a collector's mark — and that is the field's richest asset, not its noise. Each <code>Lugt N</code> is a catalogue number from Frits Lugt's <i>Marques de Collections</i> identifying a specific owner. Parsed out, they turn the collection into a who-owned-what graph: one number resolves to every sheet that passed through one collection.</p>
  <div class="panel" style="margin-bottom:20px"><h3>What an inscribed record carries</h3><div class="stack">${stackSeg}</div><div class="stack-legend">${stackLegend}</div></div>
  <div class="panel">${lugtTable}<p class="note" style="margin-top:18px">${fmt(recordsWithLugt)} records (${pct(recordsWithLugt, recordCount).toFixed(1)}% of inscribed works) carry at least one Lugt number. Identifications are from the Fondation Custodia database; any number can be looked up at marquesdecollections.fr.</p></div>
  <div class="callout"><b>The honest twist:</b> the three commonest marks — Lugt 2228, 240, 2233 — are the Rijksmuseum's <i>own</i> print-room stamps (the Rijksprentenkabinet marking its acquisitions), not private collections. That is exactly why the parser matters: it separates the institution's ownership stamps from genuine <i>prior</i>-provenance marks like F.G. Waller's (Lugt 2760, a major donor). <code>search_inscriptions({collectorMark:"Lugt 2760"})</code> reconstructs one donor's gift directly.</div>
</section>

<section>
  <div class="sec-head"><span class="sec-index">06</span><h2>Latin formulas: a role-attribution layer in the transcription</h2></div>
  <p class="lead">On prints, the transcribed text itself encodes the division of labour. The old formulas — <i>invenit</i>, <i>delineavit</i>, <i>sculpsit</i>, <i>excudit</i> — name who conceived, drew, engraved, and published a plate. Because the parser keeps transcribed text as a searchable field, these become a queryable attribution layer.</p>
  <div class="grid-2">
    <div class="panel">${roleTable}<p class="note" style="margin-top:18px">Counts match the full Latin words only; abbreviated forms (<code>inv.</code>, <code>sc.</code>, <code>exc.</code>) add more. <code>search_inscriptions({transcribedText:"excudit"})</code> finds the publishers.</p></div>
    <div class="panel">${exampleCard("A print that names its makers", "Several hands, one sheet — and a collector mark recording where it later travelled.", ex.printRoles) || '<p class="muted">—</p>'}</div>
  </div>
</section>

<section>
  <div class="sec-head"><span class="sec-index">07</span><h2>The new queries this opens up</h2></div>
  <p class="lead">Before the parser, the only handle on this field was substring search over a bilingual blob — which cannot tell whether three matched words belong to one mark or three, and matches placement words sitting inside transcriptions. The <b>confirmed</b> count below is parser-precise (the facets hold for one and the same mark); the <b>ghost</b> count is the naive co-occurrence the old approach would have returned. These are live <code>search_inscriptions</code> calls against the deployed database.</p>
  <div class="grid-2">${demoCards}</div>
  <div class="callout"><b>The precision gap, concretely:</b> a substring search for <code>signat…</code> AND <code>verso</code> AND <code>handgeschreven</code> matches ${fmt(likeAllThree)} records — but only <b>${fmt(demos[0].totalConfirmed)}</b> actually have a single mark that is a handwritten signature on the verso. The parser's same-segment requirement removes the rest as false positives.</div>
</section>

<section>
  <div class="sec-head"><span class="sec-index">08</span><h2>Worked examples</h2></div>
  <p class="lead">Real records, raw on top and parsed below — the transformation that powers every section above.</p>
  <div class="grid-2">${examplesHtml}</div>
</section>

<section>
  <div class="sec-head"><span class="sec-index">09</span><h2>What it doesn't claim</h2></div>
  <div class="panel">
    <p style="margin:0 0 12px">The parser is a <b>light, rule-based normaliser</b>, not a semantic reader. Honest boundaries:</p>
    <ul style="margin:0;padding-left:20px;color:var(--muted);font-size:14px;line-height:1.7">
      <li>The inscription field is a <b>cataloguer's mark log</b>, not a complete transcription of all text visible on a work — absence of a mark is not evidence of absence.</li>
      <li>A transcribed string is not guaranteed to be image-borne: repeated institutional stamps (<code>RPK</code>, copyright lines) live here too. Type and placement are what disambiguate them.</li>
      <li>Search runs as a runtime parse over an FTS-narrowed candidate set (no materialised index). A broad single facet — e.g. <i>collector's mark</i>, ~half the corpus — trips a parse cap and returns a partial result with a warning. Sustained cap hits are the deliberate trigger for a future materialised index (deferred Stage B).</li>
    </ul>
  </div>
</section>

<footer>
  Generated by <code>scripts/build-inscription-explorer.mjs</code> · parser + search imported from <code>dist/</code> (the shipping single source of truth) · ${fmt(recordCount)} inscribed records, ${fmt(segmentsTotal)} segments scanned from <code>${esc(DB)}</code>.<br>
  Companion to <code>scripts/build-inscription-report.py</code>. Frits Lugt numbers identified via <i>Les Marques de Collections de Dessins &amp; d'Estampes</i> (marquesdecollections.fr).
</footer>
</main>
</body>
</html>`;

writeFileSync(OUT, HTML);
con.close();
console.error("\nwrote", OUT, "(" + (HTML.length / 1024).toFixed(0) + " KB)");
