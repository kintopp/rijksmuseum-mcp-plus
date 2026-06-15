/**
 * Unit tests for buildContentBlocks (src/utils/responseShape.ts).
 *
 * Run:  node scripts/tests/test-response-shape.mjs
 * Requires: npm run build (imports from dist/).
 *
 * Note: the STRUCTURED_CONTENT=false requirement is satisfied by construction —
 * the JSON fallback lives in content[], returned regardless of EMIT_STRUCTURED.
 */

import { deepStrictEqual } from "node:assert";
import {
  buildContentBlocks,
  DEFAULT_JSON_TEXT_BUDGET,
  SAFE_RESULT_BUDGET,
} from "../../dist/utils/responseShape.js";

// ── Pass/fail counters ────────────────────────────────────────────────────────

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

// ── Case 1: Legacy single block ───────────────────────────────────────────────

section("Case 1: Legacy single block (no humanText)");

{
  const blocks = buildContentBlocks({ a: 1 }, undefined, {
    jsonText: false,
    structuredContentEmitted: true,
  });
  assert(blocks.length === 1, "length is 1");
  let parsed;
  try {
    parsed = JSON.parse(blocks[0].text);
    deepStrictEqual(parsed, { a: 1 });
    passed++;
    console.log("  ✓ blocks[0].text parses to {a:1}");
  } catch (e) {
    failed++;
    failures.push(`blocks[0].text parses to {a:1} — ${e.message}`);
    console.log(`  ✗ blocks[0].text parses to {a:1} — ${e.message}`);
  }
}

// ── Case 2: No duplication when jsonText off ──────────────────────────────────

section("Case 2: No duplication when jsonText off");

{
  const blocks = buildContentBlocks({ a: 1 }, "human", {
    jsonText: false,
    structuredContentEmitted: true,
  });
  assert(blocks.length === 1, "length is 1");
  assert(blocks[0].text === "human", 'blocks[0].text === "human"');
}

// ── Case 3: Small-tool parseable JSON ────────────────────────────────────────

section("Case 3: Small-tool parseable JSON");

let case3Blocks;
{
  case3Blocks = buildContentBlocks({ a: 1, b: "x" }, "human", {
    jsonText: true,
    structuredContentEmitted: true,
  });
  assert(case3Blocks.length === 2, "length is 2");
  assert(case3Blocks[0].text === "human", 'blocks[0].text === "human"');
  try {
    const parsed = JSON.parse(case3Blocks[1].text);
    deepStrictEqual(parsed, { a: 1, b: "x" });
    passed++;
    console.log('  ✓ JSON.parse(blocks[1].text) deep-equals {a:1,b:"x"}');
  } catch (e) {
    failed++;
    failures.push(`JSON.parse(blocks[1].text) deep-equals {a:1,b:"x"} — ${e.message}`);
    console.log(`  ✗ JSON.parse(blocks[1].text) deep-equals {a:1,b:"x"} — ${e.message}`);
  }
}

// ── Case 4: Per-copy cap → marker ─────────────────────────────────────────────

section("Case 4: Per-copy cap → marker");

{
  const blocks = buildContentBlocks({ a: 1 }, "human", {
    jsonText: true,
    maxJsonTextBytes: 2,
    structuredContentEmitted: true,
  });
  assert(blocks.length === 2, "length is 2");
  try {
    const marker = JSON.parse(blocks[1].text);
    assert(marker.jsonTextFallback === "omitted", 'marker.jsonTextFallback === "omitted"');
    assert(marker.reason === "exceeds_copy_cap", 'marker.reason === "exceeds_copy_cap"');
  } catch (e) {
    failed++;
    failures.push(`case 4 marker parse — ${e.message}`);
    console.log(`  ✗ case 4 marker parse — ${e.message}`);
  }
}

// ── Case 5: Heavy payload over per-copy cap (non-duplication) ─────────────────

section("Case 5: Heavy payload over per-copy cap (non-duplication)");

{
  const big = { blob: "x".repeat(DEFAULT_JSON_TEXT_BUDGET + 100) };
  const blocks = buildContentBlocks(big, "human", {
    jsonText: true,
    structuredContentEmitted: true,
  });
  assert(blocks.length === 2, "length is 2");
  assert(
    !blocks[1].text.includes("x".repeat(DEFAULT_JSON_TEXT_BUDGET + 100)),
    "blocks[1].text does not contain the oversized blob",
  );
  try {
    const marker = JSON.parse(blocks[1].text);
    assert(marker.reason === "exceeds_copy_cap", 'marker.reason === "exceeds_copy_cap"');
  } catch (e) {
    failed++;
    failures.push(`case 5 marker parse — ${e.message}`);
    console.log(`  ✗ case 5 marker parse — ${e.message}`);
  }
}

// ── Case 6: Projected-total ceiling guard (structuredContent-aware) ───────────

section("Case 6: Projected-total ceiling guard (structuredContent-aware)");

{
  const mid = { blob: "y".repeat(70000) };

  // 6a: without structuredContent — projected total ≈ 70 KB ≤ SAFE_RESULT_BUDGET → JSON included
  const blocks6a = buildContentBlocks(mid, "human", {
    jsonText: true,
    maxJsonTextBytes: 200000,
    structuredContentEmitted: false,
  });
  assert(blocks6a.length === 2, "6a: length is 2");
  try {
    const parsed = JSON.parse(blocks6a[1].text);
    deepStrictEqual(parsed, mid);
    passed++;
    console.log("  ✓ 6a: JSON.parse(blocks[1].text) deep-equals mid (JSON is included)");
  } catch (e) {
    failed++;
    failures.push(`6a: JSON.parse(blocks[1].text) deep-equals mid — ${e.message}`);
    console.log(`  ✗ 6a: JSON.parse(blocks[1].text) deep-equals mid — ${e.message}`);
  }

  // 6b: with structuredContent — projected total ≈ 140 KB > SAFE_RESULT_BUDGET → marker
  const blocks6b = buildContentBlocks(mid, "human", {
    jsonText: true,
    maxJsonTextBytes: 200000,
    structuredContentEmitted: true,
  });
  assert(blocks6b.length === 2, "6b: length is 2");
  try {
    const marker = JSON.parse(blocks6b[1].text);
    assert(
      marker.reason === "exceeds_result_ceiling",
      '6b: marker.reason === "exceeds_result_ceiling"',
    );
    assert(
      !blocks6b[1].text.includes("y".repeat(70000)),
      "6b: blocks[1].text does not contain the blob",
    );
  } catch (e) {
    failed++;
    failures.push(`6b: marker parse — ${e.message}`);
    console.log(`  ✗ 6b: marker parse — ${e.message}`);
  }
}

// ── Case 7: Image/base64 guard ────────────────────────────────────────────────

section("Case 7: Image/base64 guard");

{
  const imageObj = { image: "A".repeat(40000) };
  const blocks = buildContentBlocks(imageObj, "narration", {
    jsonText: true,
    structuredContentEmitted: true,
  });
  assert(blocks.length === 2, "length is 2");
  assert(
    !blocks.some((b) => b.text.includes("A".repeat(40000))),
    "no block contains the 40K-char run",
  );
  try {
    const marker = JSON.parse(blocks[1].text);
    assert(
      marker.reason === "exceeds_copy_cap",
      'marker.reason === "exceeds_copy_cap" (40 KB trips the 20 KB per-copy cap)',
    );
  } catch (e) {
    failed++;
    failures.push(`case 7 marker parse — ${e.message}`);
    console.log(`  ✗ case 7 marker parse — ${e.message}`);
  }
}

// ── Case 8: Never concatenated ────────────────────────────────────────────────

section("Case 8: Never concatenated (block[0] is verbatim human text)");

{
  // Two-block cases: 3, 4, 5, 6b, 7
  const cases = [
    buildContentBlocks({ a: 1, b: "x" }, "human", {
      jsonText: true,
      structuredContentEmitted: true,
    }),
    buildContentBlocks({ a: 1 }, "human", {
      jsonText: true,
      maxJsonTextBytes: 2,
      structuredContentEmitted: true,
    }),
    buildContentBlocks({ blob: "x".repeat(DEFAULT_JSON_TEXT_BUDGET + 100) }, "human", {
      jsonText: true,
      structuredContentEmitted: true,
    }),
    buildContentBlocks({ blob: "y".repeat(70000) }, "human", {
      jsonText: true,
      maxJsonTextBytes: 200000,
      structuredContentEmitted: true,
    }),
    buildContentBlocks({ image: "A".repeat(40000) }, "narration", {
      jsonText: true,
      structuredContentEmitted: true,
    }),
  ];
  const humanStrings = ["human", "human", "human", "human", "narration"];
  cases.forEach((blocks, i) => {
    assert(
      blocks[0].text === humanStrings[i],
      `case-${i + 1} two-block: blocks[0].text equals human string exactly`,
    );
  });
}

// ── Case 9: Spec annotations on two-block results ─────────────────────────────

section("Case 9: Spec annotations on two-block results");

{
  // Case 3 result (already computed as case3Blocks)
  assert(
    case3Blocks[0].annotations?.priority === 1,
    "case3: blocks[0].annotations.priority === 1",
  );
  assert(
    Array.isArray(case3Blocks[0].annotations?.audience) &&
      case3Blocks[0].annotations.audience.includes("assistant"),
    "case3: blocks[0].annotations.audience includes 'assistant'",
  );
  assert(
    case3Blocks[1].annotations?.priority === 0,
    "case3: blocks[1].annotations.priority === 0",
  );
  assert(
    case3Blocks[1].annotations?.audience === undefined,
    "case3: blocks[1].annotations.audience is undefined (inversion-footgun guard)",
  );

  // Single-block results (cases 1 and 2) must have no annotations
  const single1 = buildContentBlocks({ a: 1 }, undefined, {
    jsonText: false,
    structuredContentEmitted: true,
  });
  assert(
    single1[0].annotations === undefined,
    "case1 single-block: blocks[0].annotations === undefined",
  );
  const single2 = buildContentBlocks({ a: 1 }, "human", {
    jsonText: false,
    structuredContentEmitted: true,
  });
  assert(
    single2[0].annotations === undefined,
    "case2 single-block: blocks[0].annotations === undefined",
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  Passed: ${passed}  Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\n  Failures:`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log(`${"═".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
