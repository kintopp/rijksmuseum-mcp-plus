/**
 * Unit test for OAI-PMH deleted-record surfacing.
 *
 * The Rijksmuseum OAI endpoint declares <deletedRecord>persistent</deletedRecord>,
 * so removals are published as <header status="deleted"> entries (no <metadata>).
 * These tests feed fixture XML through the client's own XMLParser config (by
 * stubbing the HTTP layer) and assert that listIdentifiers / listRecords flag
 * deleted records with `deleted: true` and fall back to the LOD URI as the key.
 *
 * Live deletions are near-zero in this collection, so a fixture is the only way
 * to exercise this path end-to-end.
 *
 * Run:  node scripts/tests/test-oai-deletions.mjs
 * Requires: npm run build (imports from dist/)
 */
import { OaiPmhClient } from "../../dist/api/OaiPmhClient.js";

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function section(name) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${"═".repeat(60)}`);
}

/** Build a client whose HTTP layer returns a fixed XML body. */
function clientReturning(xml) {
  const client = new OaiPmhClient();
  client.http = { get: async () => ({ data: xml }) };
  return client;
}

const NS =
  'xmlns="http://www.openarchives.org/OAI/2.0/" ' +
  'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ' +
  'xmlns:ore="http://www.openarchives.org/ore/terms/" ' +
  'xmlns:edm="http://www.europeana.eu/schemas/edm/" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/"';

// ── Fixtures ────────────────────────────────────────────────────────

const LIST_IDENTIFIERS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH ${NS}>
  <responseDate>2026-06-16T08:00:00Z</responseDate>
  <request verb="ListIdentifiers" metadataPrefix="edm">https://data.rijksmuseum.nl/oai</request>
  <ListIdentifiers>
    <header status="deleted">
      <identifier>https://id.rijksmuseum.nl/999999</identifier>
      <datestamp>2026-06-16T08:00:00Z</datestamp>
    </header>
    <header>
      <identifier>https://id.rijksmuseum.nl/2001</identifier>
      <datestamp>2026-06-09T10:19:51Z</datestamp>
      <setSpec>26151</setSpec>
    </header>
  </ListIdentifiers>
</OAI-PMH>`;

const LIST_RECORDS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH ${NS}>
  <responseDate>2026-06-16T08:00:00Z</responseDate>
  <request verb="ListRecords" metadataPrefix="edm">https://data.rijksmuseum.nl/oai</request>
  <ListRecords>
    <record>
      <header status="deleted">
        <identifier>https://id.rijksmuseum.nl/999999</identifier>
        <datestamp>2026-06-16T08:00:00Z</datestamp>
      </header>
    </record>
    <record>
      <header>
        <identifier>https://id.rijksmuseum.nl/2001</identifier>
        <datestamp>2026-01-28T07:15:24Z</datestamp>
        <setSpec>26151</setSpec>
      </header>
      <metadata>
        <rdf:RDF ${NS}>
          <ore:Aggregation rdf:about="https://id.rijksmuseum.nl/2001/aggregation">
            <edm:aggregatedCHO>
              <edm:ProvidedCHO rdf:about="https://id.rijksmuseum.nl/2001">
                <dc:identifier>RP-P-TEST-1</dc:identifier>
                <dc:title xml:lang="en">Test Title</dc:title>
              </edm:ProvidedCHO>
            </edm:aggregatedCHO>
          </ore:Aggregation>
        </rdf:RDF>
      </metadata>
    </record>
  </ListRecords>
</OAI-PMH>`;

// ══════════════════════════════════════════════════════════════════
section("1. listIdentifiers — deleted header flagging");

const ids = await clientReturning(LIST_IDENTIFIERS_XML).listIdentifiers({ from: "2026-06-16" });
assert(ids.records.length === 2, "two headers parsed");

const delHeader = ids.records.find((r) => r.identifier === "https://id.rijksmuseum.nl/999999");
const liveHeader = ids.records.find((r) => r.identifier === "https://id.rijksmuseum.nl/2001");

assert(delHeader?.deleted === true, "deleted header carries deleted:true");
assert(delHeader?.datestamp === "2026-06-16T08:00:00Z", "deleted header keeps its datestamp");
assert(liveHeader?.deleted === undefined, "live header has no deleted flag (omitted, not false)");
assert(Array.isArray(liveHeader?.setSpecs) && liveHeader.setSpecs[0] === "26151", "live header keeps setSpecs");

// ══════════════════════════════════════════════════════════════════
section("2. listRecords — deleted record short-circuit");

const recs = await clientReturning(LIST_RECORDS_XML).listRecords({ from: "2026-06-16" });
assert(recs.records.length === 2, "two records parsed");

const delRec = recs.records.find((r) => r.lodUri === "https://id.rijksmuseum.nl/999999");
const liveRec = recs.records.find((r) => r.objectNumber === "RP-P-TEST-1");

assert(delRec?.deleted === true, "deleted record carries deleted:true");
assert(delRec?.objectNumber === "", "deleted record has empty objectNumber (no metadata block)");
assert(delRec?.lodUri === "https://id.rijksmuseum.nl/999999", "deleted record lodUri falls back to header identifier");
assert(delRec?.title === null && delRec?.creator === null, "deleted record fields resolve null/empty");

assert(liveRec?.deleted === undefined, "live record has no deleted flag");
assert(liveRec?.objectNumber === "RP-P-TEST-1", "live record parses objectNumber from metadata");
assert(liveRec?.title === "Test Title", "live record parses title from metadata");

// ══════════════════════════════════════════════════════════════════
console.log(`\n${"─".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("  All OAI deletion tests passed ✓");
