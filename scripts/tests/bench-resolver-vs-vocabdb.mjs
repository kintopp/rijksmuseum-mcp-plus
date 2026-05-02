/**
 * Benchmark: Linked Art resolver (HTTP) vs local vocab DB (SQLite)
 *
 * For a sample of artworks, measures the time to reconstruct artwork detail
 * fields from:
 *   A) The live resolver at id.rijksmuseum.nl (HTTP calls)
 *   B) The local vocabulary database (SQLite queries)
 *
 * Also compares field coverage — which fields are present in each path.
 *
 * Run:
 *   node scripts/tests/bench-resolver-vs-vocabdb.mjs
 *   node scripts/tests/bench-resolver-vs-vocabdb.mjs SK-C-5          # single artwork
 *   node scripts/tests/bench-resolver-vs-vocabdb.mjs --cold           # clear response cache between runs
 *   node scripts/tests/bench-resolver-vs-vocabdb.mjs --rounds 5       # more rounds for stable averages
 */
import Database from "better-sqlite3";
import axios from "axios";
import https from "node:https";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── Config ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const coldMode = args.includes("--cold");
const roundsIdx = args.indexOf("--rounds");
const ROUNDS = roundsIdx !== -1 ? parseInt(args[roundsIdx + 1], 10) : 3;
const singleId = args.find((a) => !a.startsWith("--") && (roundsIdx === -1 || a !== args[roundsIdx + 1]));

const TEST_ARTWORKS = singleId
  ? [{ id: singleId, label: singleId }]
  : [
      { id: "SK-C-5",    label: "Night Watch — iconic, many subjects/vocab terms" },
      { id: "SK-A-1718", label: "Winter Landscape (Avercamp) — rich iconclass" },
      { id: "SK-A-2344", label: "Love Letter (Vermeer) — genre scene" },
      { id: "SK-A-3924", label: "Self-Portrait (Van Gogh) — modern" },
      { id: "SK-A-4691", label: "Windmill (Ruisdael) — landscape" },
      { id: "RP-P-OB-1", label: "Print — likely lineage qualifiers" },
      { id: "BK-NM-1010", label: "Decorative art — few subjects" },
      { id: "BK-14656",   label: "Dollhouse — complex object" },
      { id: "SK-A-4050",  label: "Merry Drinker (Hals) — portrait" },
      { id: "SK-A-180",   label: "Syndics (Rembrandt) — group portrait" },
    ];

// ── HTTP client (same config as RijksmuseumApiClient) ───────────────

const http = axios.create({
  headers: { Accept: "application/ld+json" },
  timeout: 15_000,
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 25 }),
});

// ── Vocab DB setup ──────────────────────────────────────────────────

const vocabDbPath = process.env.VOCAB_DB_PATH || path.join(PROJECT_DIR, "data/vocabulary.db");
if (!fs.existsSync(vocabDbPath)) {
  console.error(`Vocabulary DB not found at ${vocabDbPath}`);
  process.exit(1);
}

const db = new Database(vocabDbPath, { readonly: true });
db.pragma("mmap_size = 1610612736");

// Build field_id lookup
const fieldMap = new Map(
  db.prepare("SELECT id, name FROM field_lookup").all().map((r) => [r.name, r.id])
);

// Prepared statements for vocab DB path
const stmtArtwork = db.prepare(`
  SELECT art_id, object_number, title, title_all_text, creator_label,
         date_earliest, date_latest, description_text, inscription_text,
         provenance_text, credit_line, narrative_text, height_cm, width_cm,
         has_image, iiif_id, rights_id
  FROM artworks WHERE object_number = ?
`);

const stmtMappingsForArtwork = db.prepare(`
  SELECT fl.name AS field_name, v.label_en, v.label_nl, v.external_id,
         v.id AS vocab_id, v.type AS vocab_type, v.notation,
         v.birth_year, v.death_year, v.gender, v.wikidata_id,
         v.lat, v.lon
  FROM mappings m
  JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
  JOIN field_lookup fl ON fl.id = m.field_id
  WHERE m.artwork_id = ?
  ORDER BY fl.name, v.label_en
`);

const stmtRights = db.prepare(`SELECT uri FROM rights_lookup WHERE id = ?`);

// ── Resolver path: simulate full get_artwork_details ────────────────

async function resolverPath(objectNumber) {
  // Step 1: Search API to find the URI
  const searchStart = performance.now();
  const searchResp = await http.get("https://data.rijksmuseum.nl/search/collection", {
    params: { objectNumber },
  });
  const searchMs = performance.now() - searchStart;

  const items = searchResp.data?.orderedItems || [];
  if (items.length === 0) throw new Error(`No results for ${objectNumber}`);

  // Step 2: Resolve the object (Linked Art JSON-LD)
  const resolveStart = performance.now();
  const obj = (await http.get(items[0].id)).data;
  const resolveMs = performance.now() - resolveStart;

  // Step 3: Resolve VisualItem (subjects — separate HTTP call)
  let viMs = 0;
  let subjectCount = 0;
  const shows = Array.isArray(obj.shows) ? obj.shows : obj.shows ? [obj.shows] : [];
  if (shows[0]?.id) {
    const viStart = performance.now();
    try {
      const vi = (await http.get(shows[0].id)).data;
      const represents = Array.isArray(vi.represents) ? vi.represents : vi.represents ? [vi.represents] : [];
      const representsType = Array.isArray(vi.represents_instance_of_type) ? vi.represents_instance_of_type : vi.represents_instance_of_type ? [vi.represents_instance_of_type] : [];
      subjectCount = represents.length + representsType.length;
    } catch { /* ignore */ }
    viMs = performance.now() - viStart;
  }

  // Step 4: Resolve all vocabulary URIs (types, materials, techniques, actors, subjects)
  const classifiedAs = Array.isArray(obj.classified_as) ? obj.classified_as : obj.classified_as ? [obj.classified_as] : [];
  const madeOf = Array.isArray(obj.made_of) ? obj.made_of : obj.made_of ? [obj.made_of] : [];
  const memberOf = Array.isArray(obj.member_of) ? obj.member_of : obj.member_of ? [obj.member_of] : [];
  const prodParts = Array.isArray(obj.produced_by?.part) ? obj.produced_by.part : obj.produced_by?.part ? [obj.produced_by.part] : [];

  const vocabUris = new Set();
  for (const c of classifiedAs) vocabUris.add(typeof c === "string" ? c : c.id);
  for (const m of madeOf) if (m.id) vocabUris.add(m.id);
  for (const m of memberOf) if (m.id) vocabUris.add(m.id);
  for (const p of prodParts) {
    const actors = Array.isArray(p.carried_out_by) ? p.carried_out_by : p.carried_out_by ? [p.carried_out_by] : [];
    const techs = Array.isArray(p.technique) ? p.technique : p.technique ? [p.technique] : [];
    const places = Array.isArray(p.took_place_at) ? p.took_place_at : p.took_place_at ? [p.took_place_at] : [];
    for (const a of actors) if (a.id) vocabUris.add(a.id);
    for (const t of techs) if (t.id) vocabUris.add(t.id);
    for (const pl of places) if (pl.id) vocabUris.add(pl.id);
  }
  // Remove falsy
  vocabUris.delete(undefined);
  vocabUris.delete(null);
  vocabUris.delete("");

  const vocabStart = performance.now();
  const settled = await Promise.allSettled(
    [...vocabUris].map((uri) => http.get(uri).then((r) => r.data))
  );
  const vocabMs = performance.now() - vocabStart;

  const vocabResolved = settled.filter((r) => r.status === "fulfilled").length;
  const vocabFailed = settled.filter((r) => r.status === "rejected").length;

  // Extract field counts from the resolved object
  const referredToBy = Array.isArray(obj.referred_to_by) ? obj.referred_to_by : obj.referred_to_by ? [obj.referred_to_by] : [];
  const fields = {
    title: !!extractTitle(obj),
    creator: !!extractCreator(obj),
    date: !!obj.produced_by?.timespan,
    description: referredToBy.some((r) => hasAatClass(r, "http://vocab.getty.edu/aat/300435416")),
    provenance: referredToBy.some((r) => hasAatClass(r, "http://vocab.getty.edu/aat/300055863")),
    creditLine: referredToBy.some((r) => hasAatClass(r, "http://vocab.getty.edu/aat/300435418")),
    inscriptions: referredToBy.some((r) => hasAatClass(r, "http://vocab.getty.edu/aat/300028702")),
    dimensions: !!(Array.isArray(obj.dimension) ? obj.dimension.length : obj.dimension),
    types: classifiedAs.length,
    materials: madeOf.length,
    production: prodParts.length,
    collectionSets: memberOf.length,
    subjects: subjectCount,
    vocabTermsResolved: vocabResolved,
    vocabTermsFailed: vocabFailed,
  };

  return {
    timing: {
      searchMs: round(searchMs),
      resolveMs: round(resolveMs),
      visualItemMs: round(viMs),
      vocabResolveMs: round(vocabMs),
      totalMs: round(searchMs + resolveMs + viMs + vocabMs),
      httpCalls: 1 + 1 + (viMs > 0 ? 1 : 0) + vocabUris.size, // search + resolve + VI + vocab
    },
    fields,
  };
}

// ── Vocab DB path: reconstruct same fields from SQLite ──────────────

function vocabDbPath_query(objectNumber) {
  const start = performance.now();

  // Step 1: Look up the artwork
  const artStart = performance.now();
  const artwork = stmtArtwork.get(objectNumber);
  const artMs = performance.now() - artStart;

  if (!artwork) throw new Error(`Not in vocab DB: ${objectNumber}`);

  // Step 2: Look up all mappings (types, materials, techniques, creators, subjects, etc.)
  const mapStart = performance.now();
  const mappings = stmtMappingsForArtwork.all(artwork.art_id);
  const mapMs = performance.now() - mapStart;

  // Step 3: Look up rights URI
  const rightsStart = performance.now();
  const rights = artwork.rights_id ? stmtRights.get(artwork.rights_id) : null;
  const rightsMs = performance.now() - rightsStart;

  const totalMs = performance.now() - start;

  // Group mappings by field
  const byField = {};
  for (const m of mappings) {
    if (!byField[m.field_name]) byField[m.field_name] = [];
    byField[m.field_name].push(m);
  }

  const fields = {
    title: !!artwork.title,
    creator: !!artwork.creator_label,
    date: artwork.date_earliest != null || artwork.date_latest != null,
    description: !!artwork.description_text,
    provenance: !!artwork.provenance_text,
    creditLine: !!artwork.credit_line,
    inscriptions: !!artwork.inscription_text,
    dimensions: artwork.height_cm != null || artwork.width_cm != null,
    narrative: !!artwork.narrative_text,
    iiifId: !!artwork.iiif_id,
    rights: !!rights?.uri,
    types: (byField.type || []).length,
    materials: (byField.material || []).length,
    techniques: (byField.technique || []).length,
    creators: (byField.creator || []).length,
    creatorRoles: (byField.production_role || []).length,
    attributionQualifiers: (byField.attribution_qualifier || []).length,
    subjects: (byField.subject || []).length,
    spatialSubjects: (byField.spatial || []).length,
    birthPlaces: (byField.birth_place || []).length,
    deathPlaces: (byField.death_place || []).length,
    collectionSets: (byField.collection_set || []).length,
    totalMappings: mappings.length,
  };

  return {
    timing: {
      artworkMs: round(artMs),
      mappingsMs: round(mapMs),
      rightsMs: round(rightsMs),
      totalMs: round(totalMs),
      sqliteQueries: 2 + (artwork.rights_id ? 1 : 0),
    },
    fields,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function ensureArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function extractTitle(obj) {
  return ensureArray(obj.identified_by)
    .filter((i) => i.type === "Name")
    .map((i) => (Array.isArray(i.content) ? i.content.join("; ") : i.content))
    .find(Boolean);
}

function extractCreator(obj) {
  const parts = ensureArray(obj.produced_by?.part);
  for (const p of parts) {
    const actors = ensureArray(p.carried_out_by);
    if (actors[0]?._label) return actors[0]._label;
  }
  return null;
}

function hasAatClass(item, aatUri) {
  return ensureArray(item.classified_as).some(
    (c) => (typeof c === "string" ? c : c?.id) === aatUri
  );
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatMs(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Benchmark: Linked Art Resolver (HTTP) vs Vocab DB (SQLite)     ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`Artworks: ${TEST_ARTWORKS.length}  |  Rounds: ${ROUNDS}  |  Cold mode: ${coldMode}`);
  console.log(`Vocab DB: ${vocabDbPath}`);
  console.log();

  // Warm up the SQLite mmap pages
  console.log("Warming SQLite mmap pages...");
  for (const { id } of TEST_ARTWORKS) {
    try { vocabDbPath_query(id); } catch { /* ok */ }
  }
  console.log();

  const results = [];

  for (const { id, label } of TEST_ARTWORKS) {
    console.log(`── ${id}: ${label} ${"─".repeat(Math.max(0, 50 - id.length - label.length))}`);

    const resolverRuns = [];
    const vocabRuns = [];
    let resolverFields = null;
    let vocabFields = null;

    for (let r = 0; r < ROUNDS; r++) {
      // Resolver path
      try {
        const res = await resolverPath(id);
        resolverRuns.push(res.timing);
        resolverFields = res.fields;
        if (r < ROUNDS - 1) {
          process.stdout.write(`  Resolver  round ${r + 1}: ${formatMs(res.timing.totalMs)} (${res.timing.httpCalls} HTTP calls)\n`);
        } else {
          process.stdout.write(`  Resolver  round ${r + 1}: ${formatMs(res.timing.totalMs)} (${res.timing.httpCalls} HTTP calls)\n`);
        }
      } catch (err) {
        console.log(`  Resolver  round ${r + 1}: ERROR — ${err.message}`);
      }

      // Vocab DB path
      try {
        const res = vocabDbPath_query(id);
        vocabRuns.push(res.timing);
        vocabFields = res.fields;
        process.stdout.write(`  Vocab DB  round ${r + 1}: ${formatMs(res.timing.totalMs)} (${res.timing.sqliteQueries} queries)\n`);
      } catch (err) {
        console.log(`  Vocab DB  round ${r + 1}: ERROR — ${err.message}`);
      }
    }

    if (resolverRuns.length > 0 && vocabRuns.length > 0) {
      const resolverMedian = median(resolverRuns.map((r) => r.totalMs));
      const vocabMedian = median(vocabRuns.map((r) => r.totalMs));
      const speedup = resolverMedian / vocabMedian;

      console.log();
      console.log(`  Summary:`);
      console.log(`    Resolver median: ${formatMs(resolverMedian)}  (search: ${formatMs(median(resolverRuns.map((r) => r.searchMs)))}, resolve: ${formatMs(median(resolverRuns.map((r) => r.resolveMs)))}, VI: ${formatMs(median(resolverRuns.map((r) => r.visualItemMs)))}, vocab: ${formatMs(median(resolverRuns.map((r) => r.vocabResolveMs)))})`);
      console.log(`    Vocab DB median: ${formatMs(vocabMedian)}  (artwork: ${formatMs(median(vocabRuns.map((r) => r.artworkMs)))}, mappings: ${formatMs(median(vocabRuns.map((r) => r.mappingsMs)))})`);
      console.log(`    Speedup: ${speedup.toFixed(0)}×`);

      // Field coverage comparison
      console.log();
      console.log(`  Field coverage:`);
      console.log(`    Resolver: title=${resolverFields.title} creator=${resolverFields.creator} date=${resolverFields.date} desc=${resolverFields.description} prov=${resolverFields.provenance} credit=${resolverFields.creditLine} inscr=${resolverFields.inscriptions} dims=${resolverFields.dimensions}`);
      console.log(`    Vocab DB: title=${vocabFields.title} creator=${vocabFields.creator} date=${vocabFields.date} desc=${vocabFields.description} prov=${vocabFields.provenance} credit=${vocabFields.creditLine} inscr=${vocabFields.inscriptions} dims=${vocabFields.dimensions}`);
      console.log(`    Resolver vocab terms: ${resolverFields.vocabTermsResolved} resolved, ${resolverFields.vocabTermsFailed} failed`);
      console.log(`    Vocab DB mappings: ${vocabFields.totalMappings} (types:${vocabFields.types} mat:${vocabFields.materials} tech:${vocabFields.techniques} creators:${vocabFields.creators} subjects:${vocabFields.subjects} spatial:${vocabFields.spatialSubjects} sets:${vocabFields.collectionSets})`);

      // Fields only in resolver
      const resolverOnly = [];
      if (!vocabFields.narrative && resolverFields.description) { /* narrative is in vocab DB actually */ }
      // Dimension statement (free text) vs h/w numeric — note the difference
      if (resolverFields.dimensions && !vocabFields.dimensions) resolverOnly.push("dimensions");

      // Fields only in vocab DB
      const vocabOnly = [];
      if (vocabFields.narrative) vocabOnly.push("narrative");
      if (vocabFields.iiifId) vocabOnly.push("iiifId");
      if (vocabFields.rights) vocabOnly.push("rights");
      if (vocabFields.attributionQualifiers > 0) vocabOnly.push(`attributionQualifiers(${vocabFields.attributionQualifiers})`);
      if (vocabFields.birthPlaces > 0) vocabOnly.push(`birthPlaces(${vocabFields.birthPlaces})`);
      if (vocabFields.deathPlaces > 0) vocabOnly.push(`deathPlaces(${vocabFields.deathPlaces})`);

      if (resolverOnly.length) console.log(`    Resolver-only: ${resolverOnly.join(", ")}`);
      if (vocabOnly.length) console.log(`    Vocab DB-only: ${vocabOnly.join(", ")}`);

      results.push({
        id,
        resolverMedianMs: resolverMedian,
        vocabMedianMs: vocabMedian,
        speedup,
        httpCalls: resolverRuns[0].httpCalls,
        mappingCount: vocabFields.totalMappings,
      });
    }

    console.log();
  }

  // ── Aggregate summary ──────────────────────────────────────────────

  if (results.length > 1) {
    console.log("╔══════════════════════════════════════════════════════════════════╗");
    console.log("║  Aggregate Summary                                             ║");
    console.log("╚══════════════════════════════════════════════════════════════════╝");
    console.log();

    const avgResolverMs = results.reduce((s, r) => s + r.resolverMedianMs, 0) / results.length;
    const avgVocabMs = results.reduce((s, r) => s + r.vocabMedianMs, 0) / results.length;
    const avgSpeedup = avgResolverMs / avgVocabMs;
    const minSpeedup = Math.min(...results.map((r) => r.speedup));
    const maxSpeedup = Math.max(...results.map((r) => r.speedup));
    const totalHttpCalls = results.reduce((s, r) => s + r.httpCalls, 0);

    console.log(`  Artworks benchmarked: ${results.length}`);
    console.log(`  Avg resolver time:    ${formatMs(avgResolverMs)}`);
    console.log(`  Avg vocab DB time:    ${formatMs(avgVocabMs)}`);
    console.log(`  Avg speedup:          ${avgSpeedup.toFixed(0)}×`);
    console.log(`  Speedup range:        ${minSpeedup.toFixed(0)}×–${maxSpeedup.toFixed(0)}×`);
    console.log(`  Total HTTP calls/run: ${totalHttpCalls} (avg ${(totalHttpCalls / results.length).toFixed(1)}/artwork)`);
    console.log(`  Total SQLite queries: ${results.length * 2}–${results.length * 3} (2–3/artwork)`);
    console.log();

    // Table
    console.log("  ┌─────────────────────┬────────────┬────────────┬─────────┬──────────┐");
    console.log("  │ Object Number       │ Resolver   │ Vocab DB   │ Speedup │ HTTP/#   │");
    console.log("  ├─────────────────────┼────────────┼────────────┼─────────┼──────────┤");
    for (const r of results) {
      const id = r.id.padEnd(19);
      const res = formatMs(r.resolverMedianMs).padStart(10);
      const voc = formatMs(r.vocabMedianMs).padStart(10);
      const spd = `${r.speedup.toFixed(0)}×`.padStart(7);
      const htt = `${r.httpCalls}`.padStart(8);
      console.log(`  │ ${id} │ ${res} │ ${voc} │ ${spd} │ ${htt} │`);
    }
    console.log("  └─────────────────────┴────────────┴────────────┴─────────┴──────────┘");
    console.log();

    // Estimated daily savings
    const callsPerDay = 100; // hypothetical
    const savedSecsPerCall = (avgResolverMs - avgVocabMs) / 1000;
    console.log(`  Estimated impact at ${callsPerDay} detail lookups/day:`);
    console.log(`    Time saved: ${(savedSecsPerCall * callsPerDay).toFixed(0)}s/day (${(savedSecsPerCall * callsPerDay / 60).toFixed(1)} min)`);
    console.log(`    HTTP calls eliminated: ~${Math.round(totalHttpCalls / results.length * callsPerDay)}/day`);
    console.log(`    External dependency: fully removed for artwork details`);
  }

  db.close();
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
