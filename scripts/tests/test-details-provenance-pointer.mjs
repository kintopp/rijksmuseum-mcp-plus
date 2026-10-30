#!/usr/bin/env node
/**
 * test-details-provenance-pointer.mjs — get_artwork_details reports provenance as
 * recorded and points to search_provenance for the structured chain.
 *
 * Failure modes:
 *  1. The request-time parsed chain is still returned (structuredContent or schema).
 *  2. The parsed text summary is still rendered.
 *  3. The pointer appears with nothing to show (no events, or a cross-reference to no artwork).
 *  4. The count includes cross-reference events.
 *  5. The count disagrees with search_provenance on an artwork without cross-references.
 *  6. A cross-reference-only artwork gives no pointer to where its chain is recorded.
 *  7. An artwork with events and a cross-reference omits the cross-reference, or sends
 *     the reader to the target instead of this object's chain.
 *  8. A target that is not an artwork, a null target, or the artwork itself reads as a real pointer.
 *  9. The target field is missing from tools/list, or non-null without provenance tables.
 */
import Database from "better-sqlite3";
import { buildFixture } from "./build-fixture-vocab-db.mjs";
import { connectFixtureClient } from "./fixture-client.mjs";

const FX1_TEXT = "Jan Six, Amsterdam; to the museum, 1900";
const FX2_TEXT = "See the provenance for FX-1.";
const FX3_TEXT = "…; unknown";
const FX5_TEXT = "Jan Six, Amsterdam; see also FX-1.";
const FX6_TEXT = "See the provenance in Hoek 1985.";
const FX7_TEXT = "Anna Collector; see Hoek 1985.";
const FX8_TEXT = "See the provenance elsewhere.";
const FX9_TEXT = "See the provenance for FX-9.";

const dbPath = buildFixture("fixture-details-provenance-seed.db");
const raw = new Database(dbPath);
const setText = raw.prepare("UPDATE artworks SET provenance_text = ? WHERE object_number = ?");
setText.run(FX1_TEXT, "FX-1");
setText.run(FX2_TEXT, "FX-2");
setText.run(FX3_TEXT, "FX-3");
setText.run(FX5_TEXT, "FX-5");
setText.run(FX6_TEXT, "FX-6");
setText.run(FX7_TEXT, "FX-7");
setText.run(FX8_TEXT, "FX-8");
setText.run(FX9_TEXT, "FX-9");
const ev = raw.prepare(`INSERT INTO provenance_events
  (artwork_id, sequence, raw_text, transfer_type, parties, is_cross_ref, cross_ref_target) VALUES (?, ?, ?, ?, '[]', ?, ?)`);
ev.run(1, 1, "Jan Six, Amsterdam", "collection", 0, null);
ev.run(1, 2, "to the museum, 1900", "sale", 0, null);
ev.run(2, 1, FX2_TEXT, "unknown", 1, "FX-1");
ev.run(5, 1, "Jan Six, Amsterdam", "collection", 0, null);
ev.run(5, 2, "to the museum, 1901", "sale", 0, null);
ev.run(5, 3, "see also FX-1", "unknown", 1, "FX-1");
ev.run(6, 1, FX6_TEXT, "unknown", 1, "Hoek 1985");
ev.run(7, 1, "Anna Collector", "collection", 0, null);
ev.run(7, 2, "see Hoek 1985", "unknown", 1, "Hoek 1985");
ev.run(8, 1, FX8_TEXT, "unknown", 1, null);
ev.run(9, 1, FX9_TEXT, "unknown", 1, "FX-9");
raw.close();

const noTablesPath = buildFixture("fixture-details-provenance-absent.db");
const rawNoTables = new Database(noTablesPath);
rawNoTables.exec("DROP TABLE IF EXISTS provenance_parties; DROP TABLE IF EXISTS provenance_periods; DROP TABLE provenance_events;");
rawNoTables.close();

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

function checkRow(objectNumber, { sc, text }, { count, target = null, provenance, contains = [], excludes = [], pointer }) {
  check(`${objectNumber}: provenanceEventCount is ${count}`, sc.provenanceEventCount === count, `got ${sc.provenanceEventCount}`);
  check(`${objectNumber}: provenanceCrossRefTarget is ${target}`, sc.provenanceCrossRefTarget === target, `got ${sc.provenanceCrossRefTarget}`);
  if (pointer) check(`${objectNumber}: pointer line is exact`, text.split("\n").includes(pointer), text);
  else check(`${objectNumber}: no pointer line`, !/^Provenance (events|recorded)/m.test(text), text);
  check(`${objectNumber}: provenance is ${JSON.stringify(provenance)}`, sc.provenance === provenance, `got ${JSON.stringify(sc.provenance)}`);
  for (const s of contains) check(`${objectNumber}: text contains ${s}`, text.includes(s));
  for (const s of excludes) check(`${objectNumber}: text omits ${s}`, !text.includes(s));
}

try {
  const fx1 = await details("FX-1");
  const fx4 = await details("FX-4");
  console.log("1. Artwork with real stored events");
  checkRow("FX-1", fx1, {
    count: 2,
    provenance: FX1_TEXT,
    contains: [`[Provenance] ${FX1_TEXT}`],
    excludes: ["[Provenance parsed]", "Acquired:", "Earliest:"],
    pointer: `Provenance events: 2 parsed. Full chain: search_provenance(objectNumber="FX-1")`,
  });

  console.log("\n2. Cross-reference only: pointer to the target");
  checkRow("FX-2", await details("FX-2"), {
    count: 0,
    target: "FX-1",
    provenance: FX2_TEXT,
    contains: [`[Provenance] ${FX2_TEXT}`],
    pointer: `Provenance recorded on FX-1. Full chain: search_provenance(objectNumber="FX-1")`,
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

  console.log("\n4b. Events plus a cross-reference: count excludes it, pointer stays on this object");
  checkRow("FX-5", await details("FX-5"), {
    count: 2,
    target: "FX-1",
    provenance: FX5_TEXT,
    pointer: `Provenance events: 2 parsed, plus a cross-reference to FX-1. Full chain: search_provenance(objectNumber="FX-5")`,
  });

  console.log("\n4c. Target that is not an artwork, null, or the artwork itself: no target, no cross-reference wording");
  checkRow("FX-6", await details("FX-6"), { count: 0, provenance: FX6_TEXT });
  checkRow("FX-7", await details("FX-7"), {
    count: 1,
    provenance: FX7_TEXT,
    pointer: `Provenance events: 1 parsed. Full chain: search_provenance(objectNumber="FX-7")`,
  });
  checkRow("FX-8", await details("FX-8"), { count: 0, provenance: FX8_TEXT });
  checkRow("FX-9", await details("FX-9"), { count: 0, provenance: FX9_TEXT });

  console.log("\n5. Chain removed from the wire shape");
  check("FX-1: structuredContent has no provenanceChain", !("provenanceChain" in fx1.sc));
  check("FX-4: structuredContent has no provenanceChain", !("provenanceChain" in fx4.sc));
  const { tools } = await client.listTools();
  const props = tools.find(t => t.name === "get_artwork_details")?.outputSchema?.properties ?? {};
  check("outputSchema has provenanceEventCount", "provenanceEventCount" in props);
  check("outputSchema has provenanceCrossRefTarget", "provenanceCrossRefTarget" in props);
  check("outputSchema lacks provenanceChain", !("provenanceChain" in props));

  console.log("\n6. The pointer leads to what the count promises");
  const sp = await client.callTool({ name: "search_provenance", arguments: { objectNumber: "FX-1" } });
  const events = sp.structuredContent?.results?.[0]?.events;
  check("search_provenance(FX-1) returns 2 events", events?.length === 2, `got ${events?.length}: ${sp.content?.[0]?.text}`);
} finally {
  await client.close();
}

console.log("\n7. Provenance tables absent: both fields null");
const noTablesClient = await connectFixtureClient("details-provenance-absent", { VOCAB_DB_PATH: noTablesPath });
try {
  const { sc, text } = await (async () => {
    const r = await noTablesClient.callTool({ name: "get_artwork_details", arguments: { objectNumber: "FX-1" } });
    return { sc: r.structuredContent, text: r.content.filter(c => c.type === "text").map(c => c.text).join("\n") };
  })();
  check("provenanceEventCount is null", sc.provenanceEventCount === null, `got ${sc.provenanceEventCount}`);
  check("provenanceCrossRefTarget is null", sc.provenanceCrossRefTarget === null, `got ${sc.provenanceCrossRefTarget}`);
  check("no pointer line", !/^Provenance (events|recorded)/m.test(text), text);
} finally {
  await noTablesClient.close();
}

console.log(failed > 0 ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed > 0 ? 1 : 0);
