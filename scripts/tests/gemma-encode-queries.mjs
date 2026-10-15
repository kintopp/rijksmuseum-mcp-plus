// Encode a query set with the production Gemma query model (dist/api/GemmaModel.js)
// for offline retrieval experiments. Output: JSON [{query, vec: number[768]}].
// Usage: node scripts/tests/gemma-encode-queries.mjs <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { GemmaModel } from "../../dist/api/GemmaModel.js";

const out = process.argv[2];
if (!out) { console.error("usage: gemma-encode-queries.mjs <out.json>"); process.exit(2); }

const compare = JSON.parse(readFileSync("data/egemma2-test/compare/queries.json", "utf8"))
  .filter((q) => q.kind === "text").map((q) => q.query);
const compareText = JSON.parse(readFileSync("data/egemma2-test/corpus/compare-text/queries.json", "utf8"));
// Real multimodal_search queries seen in production /debug/slow-queries (2026-10-15).
const prod = [
  "a kitten climbing out of a guitar", "person sniffing their own hand, smelling fingers",
  "children playing outside on the street", "elephant and motorcycle", "a boy removing fleas from a dog",
  "a woman standing beside a table with bread on it", "a cat sleeping by the fire", "skaters on a frozen canal",
  "red umbrella", "page with a photograph on one half and handwritten text on the other half",
  "ships in a storm at sea", "a dog under a table", "horseman in the snow", "a woman reading a letter by a window",
  "circus poster with elephant and clown", "moonlit harbor with ships", "a parrot in a cage",
];
const queries = [...new Set([...compare, ...compareText, ...prod])];

const model = new GemmaModel();
await model.init();
if (!model.available) process.exit(1);
const rows = [];
for (const query of queries) rows.push({ query, vec: Array.from(await model.embed(query)) });
writeFileSync(out, JSON.stringify(rows));
console.log(`${rows.length} queries → ${out}`);
