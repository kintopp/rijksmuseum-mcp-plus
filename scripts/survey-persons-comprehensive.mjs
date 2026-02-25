#!/usr/bin/env node
/**
 * Comprehensive survey: depictedPerson (vocab DB v0.15) vs aboutActor (Search API)
 *
 * Tests ~120 person names across 12 categories to determine whether aboutActor
 * can be dropped in favour of depictedPerson. Outputs a markdown report with
 * per-name results, category summaries, and an overall verdict.
 *
 * Usage:  node scripts/survey-persons-comprehensive.mjs [--json]
 */
import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(__dirname, '..', 'data', 'vocabulary.db');
const db = new Database(dbPath, { readonly: true });

// ─── Test names by category ────────────────────────────────────────────
const CATEGORIES = {
  'Dutch royalty / House of Orange': [
    'Willem van Oranje', 'Maurits', 'Frederik Hendrik', 'Amalia van Solms',
    'Willem II', 'Willem III', 'Mary Stuart', 'Maria Stuart',
    'Willem IV', 'Willem V', 'Wilhelmina', 'Juliana', 'Beatrix',
    'Anna Paulowna', 'Emma', 'Bernhard',
  ],
  'European monarchs': [
    'Napoleon', 'Louis XIV', 'Karel V', 'Elizabeth I',
    'Filips II', 'Philip II', 'Henry VIII', 'Catherine de Medici',
    'Maria Theresia', 'Peter the Great', 'Friedrich the Great',
    'Victoria', 'Louis XVI', 'Marie Antoinette',
    'Christina of Sweden', 'Charles I', 'Charles II',
    'James I', 'George III',
  ],
  'Religious figures': [
    'Christus', 'Jesus', 'Maria', 'Madonna',
    'Johannes de Doper', 'John the Baptist',
    'Paulus', 'Petrus', 'Mozes', 'David',
    'Maria Magdalena', 'Franciscus', 'Hieronymus',
    'Abraham', 'Salomo', 'Judith', 'Susanna',
  ],
  'Mythological figures': [
    'Venus', 'Hercules', 'Minerva', 'Apollo',
    'Diana', 'Jupiter', 'Mars', 'Bacchus',
    'Cupido', 'Mercurius', 'Ganymedes', 'Orpheus',
    'Ceres', 'Flora', 'Medusa', 'Prometheus',
  ],
  'Artists (as subjects)': [
    'Rembrandt van Rijn', 'Johannes Vermeer', 'Jan Steen',
    'Rubens', 'Frans Hals', 'Anthony van Dyck',
    'Albrecht Dürer', 'Michelangelo', 'Raphael', 'Leonardo da Vinci',
    'Caravaggio', 'Goya', 'Velázquez', 'Titian',
  ],
  'Philosophers & scientists': [
    'Erasmus', 'Hugo de Groot', 'Spinoza', 'Descartes',
    'Newton', 'Galileo', 'Copernicus', 'Linnaeus',
    'Christiaan Huygens', 'Antonie van Leeuwenhoek',
  ],
  'Writers & poets': [
    'Vondel', 'Bredero', 'Hooft', 'Cats',
    'Shakespeare', 'Dante', 'Homer', 'Voltaire',
    'Goethe', 'Schiller',
  ],
  'Military figures': [
    'Michiel de Ruyter', 'Tromp', 'Wellington', 'Piet Hein',
    'Alexander the Great', 'Julius Caesar', 'Jan van Galen',
    'Cornelis de Witt', 'Johan de Witt',
  ],
  'VOC & colonial figures': [
    'Jan Pieterszoon Coen', 'Abel Tasman', 'Hendrik Brouwer',
    'Cornelis de Houtman', 'Antonio van Diemen',
  ],
  'Musicians & composers': [
    'Mozart', 'Bach', 'Beethoven', 'Handel',
  ],
  'Reformation & religion': [
    'Luther', 'Calvijn', 'Calvin', 'Ignatius van Loyola',
  ],
  'Non-Western / diverse': [
    'Confucius', 'Buddha', 'Muhammad', 'Cleopatra',
    'Nefertiti', 'Genghis Khan', 'Akbar',
  ],
};

// ─── Stop words (matches VocabularyDb.PERSON_STOP_WORDS) ───────────────
const STOP = new Set([
  'van', 'von', 'de', 'di', 'du', 'of', 'zu',
  'het', 'the', 'la', 'le', 'el', 'den', 'der', 'ten', 'ter', 'della',
]);

// ─── escapeFts5 (matches src/utils/db.ts) ──────────────────────────────
function escapeFts5(value) {
  const cleaned = value.replace(/[*^():{}[\]\\]/g, '').replace(/"/g, '""').trim();
  if (!cleaned) return null;
  return `"${cleaned}"`;
}

// ─── depictedPerson via vocab DB ───────────────────────────────────────
const stmtPhrase = db.prepare(`
  SELECT DISTINCT pn.person_id AS id FROM person_names pn
  WHERE pn.rowid IN (SELECT rowid FROM person_names_fts WHERE person_names_fts MATCH ?)
`);
const stmtVocabInt = db.prepare(`
  SELECT vocab_int_id FROM vocabulary WHERE id = ?
`);

function countDepicted(name) {
  const ftsPhrase = escapeFts5(name);
  if (!ftsPhrase) return { persons: 0, artworks: 0, tier: 'empty' };

  // Tier 1: phrase match
  let personRows = stmtPhrase.all(ftsPhrase);
  let tier = 'phrase';

  // Tier 2: token AND fallback
  if (personRows.length === 0) {
    const tokens = name.split(/\s+/).filter(t => t.length > 0 && !STOP.has(t.toLowerCase()));
    const ftsTokens = tokens.map(t => escapeFts5(t)).filter(Boolean);
    if (ftsTokens.length > 0) {
      personRows = stmtPhrase.all(ftsTokens.join(' AND '));
      tier = 'token-AND';
    }
  }

  if (personRows.length === 0) return { persons: 0, artworks: 0, tier };

  // Resolve person_id → vocab_int_id
  const vocabIntIds = personRows
    .map(r => stmtVocabInt.get(r.id)?.vocab_int_id)
    .filter(Boolean);

  if (vocabIntIds.length === 0) return { persons: personRows.length, artworks: 0, tier };

  const ph = vocabIntIds.map(() => '?').join(',');
  const cnt = db.prepare(
    `SELECT COUNT(DISTINCT artwork_id) as cnt FROM mappings WHERE field_id = 10 AND vocab_rowid IN (${ph})`
  ).get(...vocabIntIds);

  return { persons: personRows.length, artworks: cnt.cnt, tier };
}

// ─── aboutActor via Search API (paginated) ─────────────────────────────
const SEARCH_DELAY_MS = 200; // polite rate limiting
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function countAboutActor(name) {
  let total = 0;
  let pages = 0;
  let url = `https://data.rijksmuseum.nl/search/collection?aboutActor=${encodeURIComponent(name)}`;
  while (url) {
    const res = await fetch(url);
    if (!res.ok) return { total: -1, pages: 0 };
    const j = await res.json();
    const items = j.orderedItems || [];
    total += items.length;
    pages++;
    url = j.next?.id || null;
    if (url) await sleep(SEARCH_DELAY_MS);
  }
  return { total, pages };
}

// ─── Main ──────────────────────────────────────────────────────────────
const jsonMode = process.argv.includes('--json');
const results = [];
const categoryStats = {};

// Deduplicate names across categories (keep first occurrence)
const seen = new Set();
const testPlan = [];
for (const [cat, names] of Object.entries(CATEGORIES)) {
  for (const name of names) {
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      testPlan.push({ name, category: cat });
    }
  }
}

console.error(`Surveying ${testPlan.length} unique names across ${Object.keys(CATEGORIES).length} categories...`);
console.error('');

for (let i = 0; i < testPlan.length; i++) {
  const { name, category } = testPlan[i];
  const dp = countDepicted(name);
  const aa = await countAboutActor(name);

  const ratio = dp.artworks > 0
    ? (aa.total / dp.artworks)
    : aa.total > 0 ? Infinity : null;

  const winner =
    ratio === null ? 'neither' :
    ratio === Infinity ? 'aboutActor-only' :
    ratio > 1.5 ? 'aboutActor' :
    ratio < 0.67 ? 'depictedPerson' :
    'parity';

  const entry = {
    name,
    category,
    depictedPerson: dp.artworks,
    aboutActor: aa.total,
    persons: dp.persons,
    tier: dp.tier,
    ratio: ratio === Infinity ? '∞' : ratio === null ? '—' : ratio.toFixed(2),
    winner,
  };
  results.push(entry);

  // Category stats
  if (!categoryStats[category]) {
    categoryStats[category] = { total: 0, parity: 0, aboutActorWins: 0, depictedPersonWins: 0, aboutActorOnly: 0, neither: 0 };
  }
  const cs = categoryStats[category];
  cs.total++;
  cs[winner === 'aboutActor-only' ? 'aboutActorOnly' : winner === 'aboutActor' ? 'aboutActorWins' : winner === 'depictedPerson' ? 'depictedPersonWins' : winner === 'parity' ? 'parity' : 'neither']++;

  const progress = `[${String(i + 1).padStart(3)}/${testPlan.length}]`;
  const ratioStr = entry.ratio === '∞' ? '  ∞  ' : entry.ratio === '—' ? '  —  ' : String(entry.ratio).padStart(5);
  console.error(`${progress} ${name.padEnd(30)} dp=${String(dp.artworks).padStart(6)}  aa=${String(aa.total).padStart(6)}  ${ratioStr}  ${winner}`);
}

// ─── Output ────────────────────────────────────────────────────────────
if (jsonMode) {
  console.log(JSON.stringify({ results, categoryStats }, null, 2));
} else {
  // Markdown report
  console.log('# depictedPerson vs aboutActor — Comprehensive Survey');
  console.log('');
  console.log(`**Date:** ${new Date().toISOString().slice(0, 10)}`);
  console.log(`**Names tested:** ${testPlan.length} (deduplicated)`);
  console.log(`**Vocab DB:** v0.15 with person_names_fts`);
  console.log('');
  console.log('**Winner criteria:** ratio < 0.67 → depictedPerson wins; ratio > 1.5 → aboutActor wins; 0.67–1.5 → parity; one has 0 → X-only; both 0 → neither');
  console.log('');

  // Per-category tables
  for (const [cat, names] of Object.entries(CATEGORIES)) {
    const catResults = results.filter(r => r.category === cat);
    if (catResults.length === 0) continue;

    console.log(`## ${cat}`);
    console.log('');
    console.log('| Name | depictedPerson | aboutActor | persons | tier | ratio | winner |');
    console.log('|------|---------------:|-----------:|--------:|------|------:|--------|');
    for (const r of catResults) {
      console.log(`| ${r.name} | ${r.depictedPerson} | ${r.aboutActor} | ${r.persons} | ${r.tier} | ${r.ratio} | ${r.winner} |`);
    }
    console.log('');
  }

  // Category summary
  console.log('## Category Summary');
  console.log('');
  console.log('| Category | Total | Parity | dp wins | aa wins | aa-only | Neither |');
  console.log('|----------|------:|-------:|--------:|--------:|--------:|--------:|');
  for (const [cat, cs] of Object.entries(categoryStats)) {
    console.log(`| ${cat} | ${cs.total} | ${cs.parity} | ${cs.depictedPersonWins} | ${cs.aboutActorWins} | ${cs.aboutActorOnly} | ${cs.neither} |`);
  }
  console.log('');

  // Overall summary
  const totals = { total: 0, parity: 0, dpWins: 0, aaWins: 0, aaOnly: 0, neither: 0 };
  for (const cs of Object.values(categoryStats)) {
    totals.total += cs.total;
    totals.parity += cs.parity;
    totals.dpWins += cs.depictedPersonWins;
    totals.aaWins += cs.aboutActorWins;
    totals.aaOnly += cs.aboutActorOnly;
    totals.neither += cs.neither;
  }

  console.log('## Overall Verdict');
  console.log('');
  console.log(`- **Total names:** ${totals.total}`);
  console.log(`- **Parity (0.67–1.5x):** ${totals.parity} (${(100 * totals.parity / totals.total).toFixed(1)}%)`);
  console.log(`- **depictedPerson wins (<0.67x):** ${totals.dpWins} (${(100 * totals.dpWins / totals.total).toFixed(1)}%)`);
  console.log(`- **aboutActor wins (>1.5x):** ${totals.aaWins} (${(100 * totals.aaWins / totals.total).toFixed(1)}%)`);
  console.log(`- **aboutActor-only (dp=0):** ${totals.aaOnly} (${(100 * totals.aaOnly / totals.total).toFixed(1)}%)`);
  console.log(`- **Neither (both 0):** ${totals.neither} (${(100 * totals.neither / totals.total).toFixed(1)}%)`);
  console.log('');

  const canDrop = (totals.aaWins + totals.aaOnly) === 0;
  const safeNames = totals.parity + totals.dpWins;
  console.log(`**Can aboutActor be dropped?** ${canDrop ? 'YES' : 'NO'} — ${safeNames} of ${totals.total} names (${(100 * safeNames / totals.total).toFixed(1)}%) are safe with depictedPerson alone.`);

  if (!canDrop) {
    console.log('');
    console.log('### Names where aboutActor provides unique/better coverage');
    console.log('');
    const problematic = results.filter(r => r.winner === 'aboutActor' || r.winner === 'aboutActor-only');
    console.log('| Name | Category | depictedPerson | aboutActor | ratio |');
    console.log('|------|----------|---------------:|-----------:|------:|');
    for (const r of problematic) {
      console.log(`| ${r.name} | ${r.category} | ${r.depictedPerson} | ${r.aboutActor} | ${r.ratio} |`);
    }
  }
}

db.close();
