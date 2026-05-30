/**
 * Tests for compileTextQuery — the structured textQuery DSL → FTS5 MATCH
 * compiler (#363).
 *
 * Run:  node scripts/tests/test-text-query-dsl.mjs
 * Requires: npm run build (imports from dist/). The live-DB smoke section is
 * skipped automatically if data/vocabulary.db is absent.
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { compileTextQuery, TEXT_QUERY_MAX_TERMS } from "../../dist/utils/db.js";

const ok = (dsl) => {
  const r = compileTextQuery(dsl);
  assert.ok(!("error" in r), `expected success, got error: ${r.error}`);
  return r.match;
};
const err = (dsl) => {
  const r = compileTextQuery(dsl);
  assert.ok("error" in r, `expected error, got match: ${r.match}`);
  return r.error;
};

// ── 1. Golden strings: each clause type ─────────────────────────────────
const ALL = "{title_all_text description_text inscription_text narrative_text}";

assert.equal(
  ok({ must: [{ field: "description", phrase: "water lilies" }] }),
  `{description_text} : ("water lilies")`,
  "phrase → quoted, column-scoped",
);
assert.equal(
  ok({ must: [{ field: "title", any: ["cats", "dogs"] }] }),
  `{title_all_text} : ("cats" OR "dogs")`,
  "any → OR of tokens",
);
assert.equal(
  ok({ must: [{ field: "inscription", prefix: "sculp" }] }),
  `{inscription_text} : ("sculp"*)`,
  "prefix → quoted stem + *",
);
assert.equal(
  ok({ must: [{ field: "inscription", anyPrefix: ["sculp", "incid"], any: ["fecit"] }] }),
  `{inscription_text} : ("fecit" OR "sculp"* OR "incid"*)`,
  "anyPrefix + any OR-combined within clause",
);
assert.equal(
  ok({ must: [{ phrase: "test" }] }),
  `${ALL} : ("test")`,
  "no field → all four content columns (no provenance/credit_line)",
);
assert.equal(
  ok({ must: [{ field: "inscription", near: { terms: ["gesigneerd", "gedateerd"], distance: 4 } }] }),
  `{inscription_text} : (NEAR("gesigneerd" "gedateerd", 4))`,
  "near → flat NEAR()",
);

// ── 2. NEAR OR-of-proximity expansion (FTS5 forbids OR inside NEAR) ──────
assert.equal(
  ok({ must: [{ field: "inscription", near: { terms: [["inven", "delineav"], "sculp"], distance: 6 } }] }),
  `{inscription_text} : (NEAR("inven" "sculp", 6) OR NEAR("delineav" "sculp", 6))`,
  "near with OR-slot → cartesian product of flat NEARs",
);

// ── 3. Assembly: must AND should-group NOT mustNot ──────────────────────
assert.equal(
  ok({
    should: [
      { field: "description", phrase: "beeldenstorm" },
      { field: "curatorialNarrative", any: ["iconoclasm", "iconoclastic"] },
    ],
    mustNot: [{ field: "title", phrase: "geschiedenis" }],
  }),
  `({description_text} : ("beeldenstorm") OR {narrative_text} : ("iconoclasm" OR "iconoclastic")) NOT {title_all_text} : ("geschiedenis")`,
  "scenario 26: should-group NOT mustNot",
);
assert.equal(
  ok({
    must: [
      { field: "inscription", anyPrefix: ["inven", "delineav"] },
      { field: "inscription", anyPrefix: ["sculp", "incid"], any: ["fecit"] },
      { field: "inscription", prefix: "excud" },
    ],
  }),
  `{inscription_text} : ("inven"* OR "delineav"*) AND {inscription_text} : ("fecit" OR "sculp"* OR "incid"*) AND {inscription_text} : ("excud"*)`,
  "scenario 28: multi-clause AND chain",
);
assert.match(
  ok({ must: [{ phrase: "a" }], should: [{ phrase: "b" }, { phrase: "c" }] }),
  /AND \(.* OR .*\)$/,
  "must AND (should-group)",
);

// ── 4. Injection: user text can never break out of its quoted leaf ──────
// A phrase trying to inject an operator + column filter must stay one inert,
// column-scoped quoted phrase, with every embedded quote doubled (FTS5 escape).
const inj = ok({ must: [{ field: "description", phrase: 'x" OR title_all_text : "y' }] });
assert.ok(inj.startsWith('{description_text} : ("') && inj.endsWith('")'), "stays one column-scoped quoted phrase");
const innerPhrase = inj.slice('{description_text} : ("'.length, -2);
assert.ok(!innerPhrase.replace(/""/g, "").includes('"'), "every embedded quote is doubled — no breakout");
// Token injection: operator chars and parens are stripped; the leaf stays quoted.
const injTok = ok({ must: [{ field: "title", any: ["a) OR (b", "NEAR"] }] });
assert.ok(!/\)\s*OR\s*\(/.test(injTok.replace(`{title_all_text} : (`, "")), "parens stripped from tokens");
assert.equal(
  ok({ must: [{ field: "title", any: ["AND"] }] }),
  `{title_all_text} : ("AND")`,
  "reserved word AND stays a quoted literal, not an operator",
);

// ── 5. Constraint errors ────────────────────────────────────────────────
err({});                                                   // empty
err({ mustNot: [{ phrase: "x" }] });                       // mustNot-only (binary NOT needs operand)
err({ must: [{ field: "bogus", phrase: "x" }] });          // unknown field
err({ must: [{ near: { terms: ["only-one"], distance: 4 } }] }); // near needs ≥2 slots
err({ must: [{ near: { terms: ["a", "b"], distance: 0 } }] });   // non-positive distance
// All-punctuation positive terms escape to empty → no usable terms.
err({ must: [{ field: "title", phrase: "()" }] });
// Cap: build a near whose cartesian product exceeds the cap.
const big = Array.from({ length: 7 }, () => ["x1", "x2", "x3"]); // 3^7 = 2187 combos
err({ must: [{ field: "title", near: { terms: big, distance: 3 } }] });
assert.ok(TEXT_QUERY_MAX_TERMS >= 8, "cap is a sane constant");

// ── 6. Live-DB smoke: compiled strings run and return expected counts ────
const DB_PATH = "data/vocabulary.db";
if (fs.existsSync(DB_PATH)) {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(DB_PATH, { readonly: true });
  const count = (match) =>
    db.prepare("SELECT COUNT(*) n FROM artwork_texts_fts WHERE artwork_texts_fts MATCH ?").get(match).n;

  // No throw + matches the counts documented in research-scenarios.md.
  const m26 = ok({
    should: [
      { field: "description", phrase: "beeldenstorm" },
      { field: "curatorialNarrative", any: ["iconoclasm", "iconoclastic"] },
    ],
    mustNot: [{ field: "title", phrase: "geschiedenis" }],
  });
  assert.equal(count(m26), 53, "scenario 26 live count");

  const m28 = ok({
    must: [
      { field: "inscription", anyPrefix: ["inven", "delineav"] },
      { field: "inscription", anyPrefix: ["sculp", "incid"], any: ["fecit"] },
      { field: "inscription", prefix: "excud" },
    ],
  });
  assert.equal(count(m28), 46, "scenario 28 live count");

  const m27 = ok({ must: [{ field: "description", near: { terms: ["gesigneerd", "gedateerd"], distance: 4 } }] });
  assert.equal(count(m27), 268, "scenario 27 live count");

  // Injection string must execute safely (no SQLITE_ERROR) and not over-match.
  assert.doesNotThrow(() => count(inj), "injection string executes safely");
  db.close();
  console.log("live-DB smoke: 4 checks passed");
} else {
  console.log(`live-DB smoke: SKIPPED (${DB_PATH} not present)`);
}

console.log("✓ test-text-query-dsl: all assertions passed");
