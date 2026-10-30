#!/usr/bin/env node
/**
 * test-details-provenance-pointer.mjs — get_artwork_details reports provenance as
 * recorded and points to search_provenance for the structured chain.
 *
 * Failure modes:
 *  1. The request-time parsed chain is still returned (structuredContent or schema).
 *  2. The parsed text summary is still rendered.
 *  3. The pointer appears with no real events to show (no events, cross-reference only).
 *  4. The count includes cross-reference events.
 *  5. The count disagrees with search_provenance on an artwork without cross-references.
 */
import Database from "better-sqlite3";
import { buildFixture } from "./build-fixture-vocab-db.mjs";
import { connectFixtureClient } from "./fixture-client.mjs";

const FX1_TEXT = "Jan Six, Amsterdam; to the museum, 1900";
const FX2_TEXT = "See the provenance for FX-1.";
const FX3_TEXT = "…; unknown";

const dbPath = buildFixture("fixture-details-provenance-seed.db");
const raw = new Database(dbPath);
const setText = raw.prepare("UPDATE artworks SET provenance_text = ? WHERE object_number = ?");
setText.run(FX1_TEXT, "FX-1");
setText.run(FX2_TEXT, "FX-2");
setText.run(FX3_TEXT, "FX-3");
const ev = raw.prepare(`INSERT INTO provenance_events
  (artwork_id, sequence, raw_text, transfer_type, parties, is_cross_ref) VALUES (?, ?, ?, ?, '[]', ?)`);
ev.run(1, 1, "Jan Six, Amsterdam", "collection", 0);
ev.run(1, 2, "to the museum, 1900", "sale", 0);
ev.run(2, 1, FX2_TEXT, "unknown", 1);
raw.close();

const client = await connectFixtureClient("details-provenance", { VOCAB_DB_PATH: dbPath });

let failed = 0;
function check(label, cond, detail = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${cond || !detail ? "" : `\n     ${detail}`}`);
  if (!cond) failed++;
}

async function details(objectNumber) {
  const r = await client.callTool({ name: "get_artwork_details", arguments: { objectNumber } });
  if (r.isError) throw new Error(`get_artwork_details ${objectNumber}: ${r.content?.[0]?.text}`);
  return {
    sc: r.structuredContent,
    text: r.content.filter(c => c.type === "text").map(c => c.text).join("\n"),
  };
}

function checkRow(objectNumber, { sc, text }, { count, provenance, contains = [], excludes = [] }) {
  check(`${objectNumber}: provenanceEventCount is ${count}`, sc.provenanceEventCount === count, `got ${sc.provenanceEventCount}`);
  check(`${objectNumber}: provenance is ${JSON.stringify(provenance)}`, sc.provenance === provenance, `got ${JSON.stringify(sc.provenance)}`);
  for (const s of contains) check(`${objectNumber}: text contains ${s}`, text.includes(s));
  for (const s of excludes) check(`${objectNumber}: text omits ${s}`, !text.includes(s));
}

try {
  const fx1 = await details("FX-1");
  const fx4 = await details("FX-4");
  const pointer = `Provenance events: 2 parsed. Full chain: search_provenance(objectNumber="FX-1")`;

  console.log("1. Artwork with real stored events");
  checkRow("FX-1", fx1, {
    count: 2,
    provenance: FX1_TEXT,
    contains: [`[Provenance] ${FX1_TEXT}`],
    excludes: ["[Provenance parsed]", "Acquired:", "Earliest:"],
  });
  check("FX-1: pointer is a line of its own", fx1.text.split("\n").includes(pointer), fx1.text);

  console.log("\n2. Cross-reference only: raw text, no pointer");
  checkRow("FX-2", await details("FX-2"), {
    count: 0,
    provenance: FX2_TEXT,
    contains: [`[Provenance] ${FX2_TEXT}`],
    excludes: ["Provenance events:"],
  });

  console.log("\n3. Text without stored events: raw text, no pointer");
  checkRow("FX-3", await details("FX-3"), {
    count: 0,
    provenance: FX3_TEXT,
    contains: [`[Provenance] ${FX3_TEXT}`],
    excludes: ["Provenance events:"],
  });

  console.log("\n4. No provenance");
  checkRow("FX-4", fx4, {
    count: 0,
    provenance: null,
    excludes: ["[Provenance]", "Provenance events:"],
  });

  console.log("\n5. Chain removed from the wire shape");
  check("FX-1: structuredContent has no provenanceChain", !("provenanceChain" in fx1.sc));
  check("FX-4: structuredContent has no provenanceChain", !("provenanceChain" in fx4.sc));
  const { tools } = await client.listTools();
  const props = tools.find(t => t.name === "get_artwork_details")?.outputSchema?.properties ?? {};
  check("outputSchema has provenanceEventCount", "provenanceEventCount" in props);
  check("outputSchema lacks provenanceChain", !("provenanceChain" in props));

  console.log("\n6. The pointer leads to what the count promises");
  const sp = await client.callTool({ name: "search_provenance", arguments: { objectNumber: "FX-1" } });
  const events = sp.structuredContent?.results?.[0]?.events;
  check("search_provenance(FX-1) returns 2 events", events?.length === 2, `got ${events?.length}: ${sp.content?.[0]?.text}`);
} finally {
  await client.close();
}

console.log(failed > 0 ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed > 0 ? 1 : 0);
