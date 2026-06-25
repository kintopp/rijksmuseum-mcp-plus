/**
 * Hermetic unit test for provenanceMatchedEvents (compact-mode matched-event
 * projection). Locks in plan 044: party role is annotated in the compact
 * `matchedEvents.parties` strings, while the field stays string[].
 *
 * Run:  node scripts/tests/test-provenance-matched-events.mjs
 * Requires: npm run build first (imports the compiled function from dist/).
 */
import assert from "node:assert/strict";
import { provenanceMatchedEvents } from "../../dist/registration/helpers.js";

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// Minimal synthetic ProvenanceArtworkResult — provenanceMatchedEvents reads only
// matched/sequence/transferType/parties/dateExpression/location/price/rawText.
const art = {
  eventCount: 2,
  matchedEventCount: 1,
  events: [
    { matched: false, sequence: 0, transferType: "unknown",
      parties: [{ name: "Ignored (unmatched)", role: "seller" }],
      dateExpression: null, location: null, price: null, rawText: "unmatched event" },
    { matched: true, sequence: 1, transferType: "sale",
      parties: [
        { name: "Jacques Goudstikker", role: "seller" },
        { name: "Hermann Göring", role: "buyer" },
        { name: "Unknown party", role: null },
      ],
      dateExpression: "1940", location: "Amsterdam", price: null,
      rawText: "  sold by Goudstikker to Göring, 1940  " },
  ],
};

check("annotates buyer/seller role in compact matchedEvents.parties", () => {
  const out = provenanceMatchedEvents(art);
  assert.equal(out.length, 1, "only the matched event is returned");
  assert.deepEqual(out[0].parties,
    ["Jacques Goudstikker (seller)", "Hermann Göring (buyer)", "Unknown party"]);
});
check("compact parties stay plain strings (lean shape preserved, no nested objects)", () => {
  const out = provenanceMatchedEvents(art);
  assert.ok(out[0].parties.every((p) => typeof p === "string"), "parties must remain string[]");
});
check("a party with null role keeps its bare name (no empty parentheses)", () => {
  const out = provenanceMatchedEvents(art);
  assert.ok(out[0].parties.includes("Unknown party"), "null-role party should not gain a (…) suffix");
  assert.equal(out[0].rawText, "sold by Goudstikker to Göring, 1940", "rawText is trimmed");
});

console.log(`\n${passed} passed\n`);
