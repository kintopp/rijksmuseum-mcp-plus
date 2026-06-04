#!/usr/bin/env node
/**
 * diagnose-qualifier-details.mjs — Why test-attribution-qualifiers.mjs fails.
 *
 * The test searches `attributionQualifier:X + type:painting`, takes the top hit,
 * then asserts get_artwork_details surfaces qualifier X in its production entries.
 * Search finds the artwork, but get_artwork_details returns null qualifiers. This
 * script proves the cause: the positional safeguard at VocabularyDb.ts:1783 drops
 * ALL qualifiers when the per-artwork count of attribution_qualifier mappings
 * differs from the count of creator mappings.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB = resolve(__dirname, "../../data/vocabulary.db");

const db = new Database(DB, { readonly: true });
const fieldId = (name) =>
  db.prepare("SELECT id FROM field_lookup WHERE name = ?").get(name)?.id;
const CREATOR_FIELD = fieldId("creator");
const QUAL_FIELD = fieldId("attribution_qualifier");

function mappingLabels(objectNumber, field) {
  return db.prepare(
    `SELECT v.label_en, v.label_nl
       FROM artworks a
       JOIN mappings m ON m.artwork_id = a.art_id
       JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
      WHERE a.object_number = ? AND m.field_id = ?`
  ).all(objectNumber, field).map(r => r.label_en || r.label_nl);
}

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "diagnose-qual", version: "1.0" });
await client.connect(transport);

for (const qual of ["attributed to", "workshop of"]) {
  console.log("\n" + "=".repeat(72));
  console.log(`SEARCH attributionQualifier="${qual}" + type=painting`);
  const sr = await client.callTool({
    name: "search_artwork",
    arguments: { attributionQualifier: qual, type: "painting", maxResults: 3 },
  });
  const results = (sr.structuredContent ?? JSON.parse(sr.content[0].text)).results ?? [];
  console.log(`  → ${results.length} results; top: ${results[0]?.objectNumber}`);

  for (const r of results) {
    const on = r.objectNumber;
    const creatorLabels = mappingLabels(on, CREATOR_FIELD);
    const qualLabels = mappingLabels(on, QUAL_FIELD);

    const dr = await client.callTool({ name: "get_artwork_details", arguments: { objectNumber: on } });
    const prod = (dr.structuredContent ?? JSON.parse(dr.content[0].text)).production ?? [];
    const detailsQuals = prod.map(p => p.attributionQualifier);

    const mismatch = creatorLabels.length !== qualLabels.length;
    console.log(`\n  ${on}`);
    console.log(`    DB mappings:  creators=${creatorLabels.length} ${JSON.stringify(creatorLabels)}`);
    console.log(`                  qualifiers=${qualLabels.length} ${JSON.stringify(qualLabels)}`);
    console.log(`    count mismatch (creators != qualifiers)? ${mismatch ? "YES → safeQualifiers=[]" : "no"}`);
    console.log(`    get_artwork_details production[].attributionQualifier: ${JSON.stringify(detailsQuals)}`);
    console.log(`    qualifier "${qual}" present in DB mappings? ${qualLabels.includes(qual)}`);
    console.log(`    qualifier surfaced by get_artwork_details?      ${detailsQuals.filter(Boolean).length > 0}`);
  }
}

await client.close();
db.close();
