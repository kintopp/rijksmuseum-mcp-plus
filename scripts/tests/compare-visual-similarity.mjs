// Scratch probe: Gemma image-to-image neighbours vs the Rijksmuseum website's visual search.
// Samples PER_CATEGORY works per media category, takes the top K from each source (seed
// excluded) and writes a JSON report for render-visual-comparison.mjs.
//
//   node scripts/tests/compare-visual-similarity.mjs [outFile] [perCategory] [k]
//
// Needs dist/, data/vocabulary.db, a two-stage gemma.db (GEMMA_DB_PATH, default
// data/gemma-v3.db) and network access to rijksmuseum.nl (2 requests per seed, paced).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import axios from "axios";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.env.GEMMA_DB_PATH ??= path.join(PROJECT_DIR, "data/gemma-v3.db");
const { GemmaDb } = await import(path.join(PROJECT_DIR, "dist/api/GemmaDb.js"));
const { USER_AGENT } = await import(path.join(PROJECT_DIR, "dist/utils/userAgent.js"));

const OUT = process.argv[2] ?? path.join(PROJECT_DIR, "scripts/tests/visual-comparison.json");
const PER_CATEGORY = parseInt(process.argv[3] ?? "15", 10);
const K = parseInt(process.argv[4] ?? "10", 10);
const PACE_MS = 400;

// Type vocab_int_ids, from the type-field distribution in the vocab DB.
const CATEGORIES = [
  { key: "painting", label: "Paintings", types: [36172] },
  { key: "print", label: "Prints", types: [33604] },
  { key: "drawing", label: "Drawings", types: [26477] },
  { key: "photograph", label: "Photographs", types: [33264] },
  { key: "sculpture", label: "Sculpture", types: [28931, 36981, 25109] },
  { key: "decorative", label: "Ceramics & furniture", types: [28683, 31222, 28562, 32213] },
  { key: "numismatic", label: "Coins & medals", types: [24188, 31860] },
];

const vocab = new Database(path.join(PROJECT_DIR, "data/vocabulary.db"), { readonly: true });
const gemma = new GemmaDb();
if (!gemma.available) throw new Error("Gemma DB unavailable");
const gdb = gemma.rawDb;

const gidByObj = new Map();
const objByGid = new Map();
for (const r of gdb.prepare("SELECT art_id, object_number FROM artwork_object_numbers").iterate()) {
  gidByObj.set(r.object_number, r.art_id);
  objByGid.set(r.art_id, r.object_number);
}
const stmtImageVec = gdb.prepare("SELECT embedding FROM gemma_images_vectors WHERE artwork_id = ?");

const typeFieldId = vocab.prepare("SELECT id FROM field_lookup WHERE name = 'type'").get().id;
const stmtMeta = vocab.prepare(
  "SELECT object_number, art_id, title, creator_label, date_display, date_earliest, iiif_id FROM artworks WHERE object_number = ?",
);
const stmtTypes = vocab.prepare(`
  SELECT v.vocab_int_id AS id, COALESCE(NULLIF(v.label_en, ''), v.label_nl) AS label
  FROM mappings m JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
  WHERE m.artwork_id = ? AND m.field_id = ?
`);

const http = axios.create({ headers: { "User-Agent": USER_AGENT }, timeout: 10000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rijksVisual(objectNumber) {
  const s = await http.get("https://www.rijksmuseum.nl/api/v1/collection/search", {
    params: { query: objectNumber, language: "en", pageSize: 5 },
  });
  const nodeId = (s.data?.artObjects ?? []).find(o => o.objectNumber === objectNumber)?.objectNodeId;
  if (!nodeId) return null;
  await sleep(PACE_MS);
  const v = await http.get("https://www.rijksmuseum.nl/api/v1/collection/visualsearch", {
    params: { objectNodeId: nodeId, language: "en", page: 1, pageSize: K + 1 },
  });
  return (v.data?.artObjects ?? []).map(o => o.objectNumber).filter(n => n !== objectNumber).slice(0, K);
}

function gemmaVisual(objectNumber) {
  const gid = gidByObj.get(objectNumber);
  const row = gid === undefined ? null : stmtImageVec.get(gid);
  if (!row) return null;
  return gemma.search("images", row.embedding, K + 1)
    .filter(h => h.artId !== gid)
    .slice(0, K)
    .map(h => ({ objectNumber: objByGid.get(h.artId), similarity: +h.similarity.toFixed(4) }));
}

const metaCache = new Map();
function meta(objectNumber) {
  if (metaCache.has(objectNumber)) return metaCache.get(objectNumber);
  const a = stmtMeta.get(objectNumber);
  const m = a
    ? {
        title: a.title ?? "", creator: a.creator_label ?? "", date: a.date_display ?? "",
        year: a.date_earliest, iiifId: a.iiif_id,
        types: stmtTypes.all(a.art_id, typeFieldId),
      }
    : { title: "", creator: "", date: "", year: null, iiifId: null, types: [] };
  metaCache.set(objectNumber, m);
  return m;
}

const seeds = [];
for (const cat of CATEGORIES) {
  const pool = vocab.prepare(`
    SELECT a.object_number FROM artworks a
    WHERE a.has_image = 1 AND a.iiif_id IS NOT NULL
      AND a.art_id IN (SELECT artwork_id FROM mappings WHERE field_id = ? AND vocab_rowid IN (SELECT value FROM json_each(?)))
    ORDER BY random() LIMIT ?
  `).all(typeFieldId, JSON.stringify(cat.types), PER_CATEGORY * 4).map(r => r.object_number);

  let taken = 0, skipped = 0;
  for (const objectNumber of pool) {
    if (taken >= PER_CATEGORY) break;
    const g = gemmaVisual(objectNumber);
    if (!g?.length) { skipped++; continue; }
    let r;
    try {
      r = await rijksVisual(objectNumber);
    } catch (err) {
      console.error(`  ${objectNumber}: rijks error ${err.response?.status ?? err.code}`);
      r = null;
    }
    await sleep(PACE_MS);
    if (!r?.length) { skipped++; continue; }
    seeds.push({ category: cat.key, objectNumber, gemma: g, rijks: r });
    taken++;
    console.error(`${cat.key} ${taken}/${PER_CATEGORY} ${objectNumber}`);
  }
  console.error(`${cat.key}: ${taken} seeds, ${skipped} skipped (no vector or no website result)`);
}

const objects = {};
for (const s of seeds) {
  for (const n of [s.objectNumber, ...s.rijks, ...s.gemma.map(h => h.objectNumber)]) objects[n] ??= meta(n);
}

fs.writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(), k: K, gemmaBuild: gemma.buildId,
  categories: CATEGORIES.map(({ key, label }) => ({ key, label })), seeds, objects,
}, null, 1));
console.error(`wrote ${OUT}: ${seeds.length} seeds, ${Object.keys(objects).length} objects`);
