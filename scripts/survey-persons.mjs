import Database from 'better-sqlite3';
const db = new Database('data/vocabulary.db', { readonly: true });

const testNames = [
  'Willem van Oranje', 'Johan de Witt', 'Amalia van Solms', 'Maurits',
  'Frederik Hendrik', 'Maria Stuart', 'Wilhelmina',
  'Napoleon', 'Louis XIV', 'Karel V', 'Elizabeth I',
  'Rembrandt van Rijn', 'Johannes Vermeer', 'Jan Steen',
  'Maria', 'Christus', 'Venus', 'Hercules', 'Minerva',
  'Erasmus', 'Hugo de Groot', 'Spinoza', 'Vondel',
  'Michiel de Ruyter', 'Tromp', 'Wellington',
  'Mozart', 'Luther', 'Voltaire',
];

const STOP = new Set(['van', 'von', 'de', 'den', 'der', 'het', 'le', 'la', 'du', 'des', 'di', 'del', 'della', 'da', 'das', 'do', 'dos', 'af', 'av', 'zu', 'zum']);

function countDepicted(name) {
  const ftsPhrase = '"' + name.replace(/"/g, '""') + '"';
  let personRows = db.prepare(`
    SELECT DISTINCT pn.person_id FROM person_names pn
    WHERE pn.rowid IN (SELECT rowid FROM person_names_fts WHERE person_names_fts MATCH ?)
  `).all(ftsPhrase);

  let tier = 'phrase';
  if (personRows.length === 0) {
    const tokens = name.split(/\s+/).filter(t => t.length > 0 && !STOP.has(t.toLowerCase()));
    const ftsTokens = tokens.map(t => '"' + t.replace(/"/g, '""') + '"');
    if (ftsTokens.length > 0) {
      personRows = db.prepare(`
        SELECT DISTINCT pn.person_id FROM person_names pn
        WHERE pn.rowid IN (SELECT rowid FROM person_names_fts WHERE person_names_fts MATCH ?)
      `).all(ftsTokens.join(' AND '));
      tier = 'token-AND';
    }
  }

  if (personRows.length === 0) return { persons: 0, artworks: 0, tier };

  const vocabIntIds = personRows.map(r => {
    return db.prepare('SELECT vocab_int_id FROM vocabulary WHERE id = ?').get(r.person_id)?.vocab_int_id;
  }).filter(Boolean);

  if (vocabIntIds.length === 0) return { persons: personRows.length, artworks: 0, tier };

  const ph = vocabIntIds.map(() => '?').join(',');
  const cnt = db.prepare(`
    SELECT COUNT(DISTINCT m.artwork_id) as cnt FROM mappings m
    WHERE m.field_id = 10 AND m.vocab_rowid IN (${ph})
  `).get(...vocabIntIds);

  return { persons: personRows.length, artworks: cnt.cnt, tier };
}

async function countAboutActor(name) {
  let total = 0;
  let url = `https://data.rijksmuseum.nl/search/collection?aboutActor=${encodeURIComponent(name)}`;
  while (url) {
    const res = await fetch(url);
    const j = await res.json();
    const items = j.orderedItems || [];
    total += items.length;
    url = j.next?.id || null;
  }
  return total;
}

console.log('| Name                   | depictedPerson | aboutActor | persons | tier      | ratio |');
console.log('|------------------------|---------------:|-----------:|--------:|-----------|-------|');

for (const name of testNames) {
  const dp = countDepicted(name);
  const aa = await countAboutActor(name);
  const ratio = dp.artworks > 0 ? (aa / dp.artworks).toFixed(1) + 'x' : aa > 0 ? '∞' : '—';
  console.log(`| ${name.padEnd(22)} | ${String(dp.artworks).padStart(14)} | ${String(aa).padStart(10)} | ${String(dp.persons).padStart(7)} | ${dp.tier.padEnd(9)} | ${ratio.padStart(5)} |`);
}
