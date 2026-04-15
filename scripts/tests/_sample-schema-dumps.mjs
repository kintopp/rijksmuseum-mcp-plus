#!/usr/bin/env node
// Sample Schema.org dumps (person/organisation/topical_term) and compute
// overlap with the local vocab DB. Pure fs + better-sqlite3, no subprocesses.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOTS = {
  classification: '/tmp/rm-dump-classification',
  concept: '/tmp/rm-dump-concept',
  event: '/tmp/rm-dump-event',
};
const SAMPLE_SIZE = Infinity; // full sweep

function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out;
}

function reservoir(arr, k) {
  if (!Number.isFinite(k) || k >= arr.length) return arr;
  const out = arr.slice(0, k);
  for (let i = k; i < arr.length; i++) {
    const j = Math.floor(Math.random() * (i + 1));
    if (j < k) out[j] = arr[i];
  }
  return out;
}
function bucket(n) {
  if (n === 0) return '0';
  if (n <= 5) return String(n);
  if (n <= 10) return '6-10';
  if (n <= 20) return '11-20';
  return '21+';
}

const TRIPLE_RE = /^(\S+)\s+(\S+)\s+(.+?)\s+\.\s*$/;
function parseTriples(text) {
  const t = [];
  for (const line of text.split('\n')) {
    const m = TRIPLE_RE.exec(line);
    if (m) t.push([m[1], m[2], m[3]]);
  }
  return t;
}

function summarize(files) {
  const sample = reservoir(files, SAMPLE_SIZE);
  const pred = new Map(), types = new Map(), langs = new Map(), hosts = new Map();
  const hName = new Map(), hAlt = new Map(), hSame = new Map();
  const aatUris = new Set(), wikidataUris = new Set(), viafUris = new Set(), rkdUris = new Set(), gettyNonAat = new Set();
  const stats = { parsed: 0, withSameAs: 0, withAat: 0, nameDirect: 0, nameBlank: 0, altName: 0,
    blankNodeEntities: 0, multipleNameEntities: 0, multilingualNameEntities: 0, nonStandardTypeEntities: 0 };
  const STANDARD = new Set(['<http://schema.org/Person>','<http://schema.org/Organization>','<http://schema.org/DefinedTerm>']);
  const weirdSamples = [];
  const ids = [];
  for (const f of sample) {
    const txt = fs.readFileSync(f, 'utf8');
    const triples = parseTriples(txt);
    if (!triples.length) continue;
    stats.parsed++;
    ids.push(path.basename(f));
    let hasSameAs = false, hasAat = false;
    let nameCount = 0, altCount = 0, sameCount = 0;
    const langsSeen = new Set();
    const typesSeen = new Set();
    let hasBlankNode = false, hasNonStdType = false;
    for (const [s, p, o] of triples) {
      pred.set(p, (pred.get(p) || 0) + 1);
      if (s.startsWith('_:')) hasBlankNode = true;
      if (p === '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>') {
        types.set(o, (types.get(o) || 0) + 1);
        typesSeen.add(o);
        if (!STANDARD.has(o)) hasNonStdType = true;
      }
      if (p === '<http://schema.org/name>') {
        nameCount++;
        const ml = /"@([^ >]+)$/.exec(o);
        const tag = ml ? ml[1] : '(none)';
        langs.set(tag, (langs.get(tag) || 0) + 1);
        langsSeen.add(tag);
        if (s.startsWith('<https://id.rijksmuseum.nl/')) stats.nameDirect++;
        else if (s.startsWith('_:')) stats.nameBlank++;
      }
      if (p === '<http://schema.org/alternateName>') { altCount++; stats.altName++; }
      if (p === '<http://schema.org/sameAs>') {
        hasSameAs = true;
        sameCount++;
        const mh = /^<https?:\/\/([^/>]+)/.exec(o);
        if (mh) hosts.set(mh[1], (hosts.get(mh[1]) || 0) + 1);
        if (o.includes('vocab.getty.edu/aat/')) hasAat = true;
        const muri = /^<([^>]+)>/.exec(o);
        if (muri) {
          const u = muri[1];
          if (u.startsWith('http://vocab.getty.edu/aat/')) aatUris.add(u);
          else if (u.startsWith('http://vocab.getty.edu/')) gettyNonAat.add(u);
          else if (u.includes('wikidata.org')) wikidataUris.add(u);
          else if (u.includes('viaf.org')) viafUris.add(u);
          else if (u.includes('rkd.nl')) rkdUris.add(u);
        }
      }
    }
    hName.set(bucket(nameCount), (hName.get(bucket(nameCount)) || 0) + 1);
    hAlt.set(bucket(altCount), (hAlt.get(bucket(altCount)) || 0) + 1);
    hSame.set(bucket(sameCount), (hSame.get(bucket(sameCount)) || 0) + 1);
    if (hasSameAs) stats.withSameAs++;
    if (hasAat) stats.withAat++;
    if (hasBlankNode) stats.blankNodeEntities++;
    if (nameCount > 1) {
      stats.multipleNameEntities++;
      if (langsSeen.size > 1) stats.multilingualNameEntities++;
    }
    if (hasNonStdType) stats.nonStandardTypeEntities++;
    if ((hasBlankNode || hasNonStdType || nameCount > 1 || langsSeen.size > 1) && weirdSamples.length < 5) {
      weirdSamples.push({ file: f, nameCount, altCount, sameCount, types: [...typesSeen], langs: [...langsSeen], hasBlankNode });
    }
  }
  return { stats, pred, types, langs, hosts, ids, hName, hAlt, hSame, aatUris, wikidataUris, viafUris, rkdUris, gettyNonAat, weirdSamples };
}

const top = (m, n = 10) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

const results = {};
for (const [kind, root] of Object.entries(ROOTS)) {
  if (!fs.existsSync(root)) { console.log(`SKIP ${kind}`); continue; }
  console.log(`\nScanning ${kind} at ${root} ...`);
  const files = walk(root);
  console.log(`  total=${files.length} sample=${Math.min(SAMPLE_SIZE, files.length)}`);
  results[kind] = summarize(files);
}

const sortHist = (m) => {
  const order = ['0','1','2','3','4','5','6-10','11-20','21+'];
  return order.filter(k => m.has(k)).map(k => [k, m.get(k)]);
};
for (const [kind, r] of Object.entries(results)) {
  console.log(`\n===== ${kind.toUpperCase()} (n=${r.stats.parsed}) =====`);
  console.log('predicates (top 10):');
  for (const [p, c] of top(r.pred)) console.log(`  ${String(c).padStart(7)}  ${p}`);
  console.log('rdf:type values (top 20):');
  for (const [t, c] of top(r.types, 20)) console.log(`  ${String(c).padStart(7)}  ${t}`);
  console.log(`non-standard-type entities: ${r.stats.nonStandardTypeEntities}`);
  console.log('schema:name language tags:');
  for (const [l, c] of top(r.langs, 15)) console.log(`  ${String(c).padStart(7)}  @${l}`);
  console.log(`schema:name attachment: direct=${r.stats.nameDirect} blankNode=${r.stats.nameBlank}`);
  console.log(`schema:alternateName total triples: ${r.stats.altName}`);
  console.log(`sameAs entities: ${r.stats.withSameAs}/${r.stats.parsed}; with AAT: ${r.stats.withAat}`);
  console.log('per-entity schema:name histogram:');
  for (const [k, c] of sortHist(r.hName)) console.log(`  ${k.padStart(6)}: ${c}`);
  console.log('per-entity schema:alternateName histogram:');
  for (const [k, c] of sortHist(r.hAlt)) console.log(`  ${k.padStart(6)}: ${c}`);
  console.log('per-entity schema:sameAs histogram:');
  for (const [k, c] of sortHist(r.hSame)) console.log(`  ${k.padStart(6)}: ${c}`);
  console.log(`edge cases: blankNodeEntities=${r.stats.blankNodeEntities} multipleNameEntities=${r.stats.multipleNameEntities} multilingualNameEntities=${r.stats.multilingualNameEntities}`);
  console.log('sameAs hosts (FULL, top 25):');
  for (const [h, c] of top(r.hosts, 25)) console.log(`  ${String(c).padStart(7)}  ${h}`);
  console.log('unique external URI counts:');
  console.log(`  AAT:           ${r.aatUris.size}`);
  console.log(`  Getty non-AAT: ${r.gettyNonAat.size}`);
  console.log(`  Wikidata:      ${r.wikidataUris.size}`);
  console.log(`  VIAF:          ${r.viafUris.size}`);
  console.log(`  RKD:           ${r.rkdUris.size}`);
  if (r.weirdSamples.length) {
    console.log('weird samples:');
    for (const s of r.weirdSamples)
      console.log(`  ${s.file} name=${s.nameCount} alt=${s.altCount} sameAs=${s.sameCount} types=${s.types.join('|')} langs=${s.langs.join('|')} blank=${s.hasBlankNode}`);
  }
}

const DB = 'data/vocabulary.db';
if (fs.existsSync(DB)) {
  console.log(`\n===== OVERLAP with ${DB} =====`);
  const db = new Database(DB, { readonly: true });
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  console.log(`tables: ${tables.join(', ')}`);
  const vcols = db.prepare(`PRAGMA table_info(vocabulary)`).all().map(c => c.name);
  console.log(`vocabulary cols: ${vcols.join(', ')}`);
  const uriCol = vcols.includes('uri') ? 'uri' : vcols.includes('source_uri') ? 'source_uri' : null;
  console.log(`vocabulary count: ${db.prepare('SELECT COUNT(*) AS c FROM vocabulary').get().c}`);

  if (uriCol) {
    const lu = db.prepare(`SELECT 1 FROM vocabulary WHERE ${uriCol} = ? LIMIT 1`);
    for (const [kind, r] of Object.entries(results)) {
      let hit = 0;
      for (const id of r.ids) if (lu.get(`https://id.rijksmuseum.nl/${id}`)) hit++;
      console.log(`  ${kind}: ${hit}/${r.ids.length} (${((hit / r.ids.length) * 100).toFixed(1)}%) sampled IDs already in vocabulary`);
    }
    // AAT coverage from topical_term
    if (results.topical_term) {
      const aat = new Set();
      const files = reservoir(walk(ROOTS.topical_term), 1000);
      for (const f of files) {
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
          const m = /<(http:\/\/vocab\.getty\.edu\/aat\/\d+)>/.exec(line);
          if (m) aat.add(m[1]);
        }
      }
      let present = 0;
      for (const u of aat) if (lu.get(u)) present++;
      console.log(`  topical_term AAT: ${present}/${aat.size} (${((present / aat.size) * 100).toFixed(1)}%) AAT URIs already in vocabulary`);
    }
  }

  // --- Integer-id overlap (dump filenames are Rijksmuseum entity IDs = vocabulary.id) ---
  console.log(`\n----- integer-id overlap -----`);
  console.log('vocabulary by type:');
  for (const row of db.prepare('SELECT type, COUNT(*) AS c FROM vocabulary GROUP BY type ORDER BY c DESC').all())
    console.log(`  ${String(row.c).padStart(7)}  ${row.type}`);
  const byType = db.prepare('SELECT type FROM vocabulary WHERE id = ?');
  for (const [kind, root] of Object.entries(ROOTS)) {
    if (!fs.existsSync(root)) continue;
    const files = walk(root);
    let hit = 0;
    const typeHist = new Map();
    for (const f of files) {
      const id = Number(path.basename(f));
      if (!Number.isFinite(id)) continue;
      const r = byType.get(id);
      if (r) { hit++; typeHist.set(r.type, (typeHist.get(r.type) || 0) + 1); }
    }
    const pct = ((hit / files.length) * 100).toFixed(1);
    console.log(`${kind}: ${hit}/${files.length} (${pct}%) dump IDs in vocabulary.id`);
    for (const [t, c] of [...typeHist.entries()].sort((a, b) => b[1] - a[1]))
      console.log(`    ${String(c).padStart(6)}  ${t || '(null)'}`);
  }

  // --- person_names coverage for person dump ---
  if (tables.includes('person_names')) {
    const pnCols = db.prepare(`PRAGMA table_info(person_names)`).all().map(c => c.name);
    console.log(`\nperson_names cols: ${pnCols.join(', ')}`);
    console.log(`person_names rows: ${db.prepare('SELECT COUNT(*) AS c FROM person_names').get().c}`);
    const fk = pnCols.find(c => /id/i.test(c)) || pnCols[0];
    const pnDistinct = db.prepare(`SELECT COUNT(DISTINCT ${fk}) AS c FROM person_names`).get().c;
    console.log(`distinct ${fk} values: ${pnDistinct}`);
    const pnSet = new Set(db.prepare(`SELECT DISTINCT ${fk} AS id FROM person_names`).all().map(r => Number(r.id)));
    const personIdsInDump = new Set(walk(ROOTS.person).map(f => Number(path.basename(f))));
    console.log(`person dump entity count: ${personIdsInDump.size}`);
    let overlap = 0;
    for (const id of personIdsInDump) if (pnSet.has(id)) overlap++;
    console.log(`dump IDs already in person_names: ${overlap}/${personIdsInDump.size} (${((overlap/personIdsInDump.size)*100).toFixed(1)}%)`);
    console.log(`→ dump-only persons (not in person_names): ${personIdsInDump.size - overlap}`);
  }

  // --- AAT sameAs coverage from topical_term dumps ---
  console.log(`\n----- topical_term AAT sweep -----`);
  const allAat = new Set();
  for (const f of walk(ROOTS.topical_term)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = /<(http:\/\/vocab\.getty\.edu\/aat\/\d+)>/.exec(line);
      if (m) allAat.add(m[1]);
    }
  }
  console.log(`unique AAT URIs referenced: ${allAat.size}`);
  const extLu = db.prepare('SELECT 1 FROM vocabulary WHERE external_id = ? LIMIT 1');
  let extHit = 0;
  for (const u of allAat) if (extLu.get(u)) extHit++;
  console.log(`already in vocabulary.external_id: ${extHit}/${allAat.size} (${((extHit/allAat.size)*100).toFixed(1)}%)`);

  if (tables.includes('persons')) {
    const pc = db.prepare('SELECT COUNT(*) AS c FROM persons').get().c;
    const pcols = db.prepare(`PRAGMA table_info(persons)`).all().map(c => c.name);
    console.log(`persons: ${pc} rows; cols: ${pcols.join(', ')}`);
    // If persons has a URI/id col, check overlap with sampled person IDs
    const pUri = pcols.find(c => /uri|source_uri|rkd|rijks_id|id$/i.test(c));
    if (pUri && results.person) {
      const lu = db.prepare(`SELECT 1 FROM persons WHERE ${pUri} = ? LIMIT 1`);
      let hit = 0;
      for (const id of results.person.ids) {
        if (lu.get(`https://id.rijksmuseum.nl/${id}`) || lu.get(id)) hit++;
      }
      console.log(`  persons overlap on ${pUri}: ${hit}/${results.person.ids.length}`);
    }
  }
}
