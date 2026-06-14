/**
 * Tests for the enrichment review HTML generator.
 *
 * Covers the display-layer fixes for the three symptoms found in production review pages:
 *   1. Chain-of-thought prose leaked into `enrichment_reasoning` (#87 phantom batch) must be
 *      suppressed, while clean reasoning passes through verbatim.
 *   3. Structural corrections (#125 splits etc.) stamp ONE explanation onto every child event
 *      AND its parties; the page must show that explanation once, not ~20×.
 *
 * Run: node scripts/tests/test-enrichment-review-html.mjs  (needs `npx tsc` / `npm run build` first)
 */
import { generateEnrichmentReviewHtml, looksLikeChainOfThought } from "../../dist/enrichmentReviewHtml.js";

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { console.error(`  FAIL ${name}`); failures++; }
}
function count(haystack, needle) {
  let n = 0, i = 0;
  for (;;) { const j = haystack.indexOf(needle, i); if (j === -1) break; n++; i = j + needle.length; }
  return n;
}

// Clean group-level explanation (the real SK-A-4717 #125 split reasoning shape).
const SPLIT_REASONING =
  "The raw text for sequence 3 has been erroneously merged into a single event by the parser. " +
  "It actually contains six distinct, sequential provenance events separated by ellipses and semicolons.";

// Leaked chain-of-thought (the real SK-A-379 #87 phantom reasoning shape).
const COT_REASONING =
  "Wait — on closer inspection this event is actually a real loan event, flanked by two bibliographic " +
  "citations. Re-examining: the loan is real and valid provenance. Nevertheless, because the candidate " +
  "list only flags seq 7, the loan to Bonnefantenmuseum is a real provenance event and should NOT be reclassified.";

// Production stores a bare 'llm_structural' on split-derived parties (the ':#125' suffix the
// event keeps is not recorded on party rows) — exercise that so the cross-method merge is tested.
const splitParties = (...names) =>
  names.map(name => ({ name, role: null, position: "receiver", positionMethod: "llm_structural", enrichmentReasoning: SPLIT_REASONING }));

const ev = (sequence, transferType, correctionMethod, reasoning, parties = []) => ({
  sequence, rawText: `raw ${sequence}`, gap: false, transferType, unsold: false, batchPrice: false,
  dateYear: null, categoryMethod: "type_mapping", correctionMethod, enrichmentReasoning: reasoning, parties,
});

const data = {
  query: "test",
  artworks: [
    {
      objectNumber: "SPLIT-1", title: "Split case", creator: "anon",
      events: [
        ev(1, "sale", "llm_structural:#125", SPLIT_REASONING, splitParties("Campan", "Shchukin")),
        ev(2, "collection", "llm_structural:#125", SPLIT_REASONING, splitParties("Goudstikker", "Thyssen")),
        ev(3, "by_descent", "llm_structural:#125", SPLIT_REASONING, splitParties("Bentinck", "Museum")),
      ],
    },
    {
      objectNumber: "COT-1", title: "Chain-of-thought case", creator: "anon",
      events: [ev(7, "non_provenance", "llm_structural:#87", COT_REASONING)],
    },
    {
      objectNumber: "NULLR", title: "Null reasoning case", creator: "anon",
      events: [
        ev(1, "sale", "llm_structural:#116", null),
        ev(2, "gift", "llm_structural:#116", null),
      ],
    },
  ],
};

const html = generateEnrichmentReviewHtml(data);

console.log("Symptom 3 — duplicated reasoning collapses to one block:");
// 3 events + 6 parties = 9 entries share SPLIT_REASONING, but it must render exactly once.
check("split reasoning shown exactly once", count(html, "six distinct") === 1);
check("collapses to a single shared-explanation block", count(html, "one shared explanation") === 1);
check("grouped target summary present", html.includes("9 enrichments (one shared explanation)"));
check("group badge uses the namespaced method label", html.includes("multi-transfer merge"));
check("every event target still listed", html.includes("Event 1 → ") && html.includes("Event 2 → ") && html.includes("Event 3 → "));
check("party targets still listed", html.includes('"Campan"') && html.includes('"Museum"'));

console.log("Symptom 1 — chain-of-thought suppressed, clean reasoning preserved:");
check("CoT prose removed (no 'on closer inspection')", !html.includes("on closer inspection"));
check("CoT prose removed (no 'Re-examining')", !html.includes("Re-examining"));
check("neutral note shown instead", html.includes("verbose model reasoning omitted"));
check("clean split reasoning NOT flagged", html.includes("It actually contains six distinct"));

console.log("No false-collapse — independent null-reasoning enrichments stay separate:");
check("two '(no reasoning recorded)' blocks", count(html, "(no reasoning recorded)") === 2);

console.log("Unit — looksLikeChainOfThought:");
check("clean reasoning → false", looksLikeChainOfThought(SPLIT_REASONING) === false);
check("CoT reasoning → true", looksLikeChainOfThought(COT_REASONING) === true);
check("'actually contains' not a false trigger", looksLikeChainOfThought("It actually contains six distinct events.") === false);

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll enrichment-review-html checks passed.");
