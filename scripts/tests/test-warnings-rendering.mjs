/**
 * Unit tests for mirrorWarningsToText — the single place warnings reach
 * content[].text. Imports from dist/ (pure compiled output, no side effects).
 *
 * Run: node scripts/tests/test-warnings-rendering.mjs
 */
import { strict as assert } from "node:assert";
import { mirrorWarningsToText } from "../../dist/utils/responseShape.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// Case 1: No human text → passthrough (undefined unchanged)
test("No human text → passthrough", () => {
  const result = mirrorWarningsToText({ warnings: ["a"] }, undefined);
  assert.strictEqual(result, undefined);
});

// Case 2: No warnings key → unchanged
test("No warnings → unchanged", () => {
  const result = mirrorWarningsToText({ results: [] }, "body");
  assert.strictEqual(result, "body");
});

// Case 3: Empty array → unchanged
test("Empty array → unchanged", () => {
  const result = mirrorWarningsToText({ warnings: [] }, "body");
  assert.strictEqual(result, "body");
});

// Case 4: Single warning appended after blank line
test("Single warning appended after blank line", () => {
  const result = mirrorWarningsToText({ warnings: ["x"] }, "body");
  assert.strictEqual(result, "body\n\n⚠ x");
});

// Case 5: Multiple warnings, one per line
test("Multiple warnings, one per line", () => {
  const result = mirrorWarningsToText({ warnings: ["x", "y"] }, "body");
  assert.strictEqual(result, "body\n\n⚠ x\n⚠ y");
});

// Case 6: Empty human text → block only, no leading blank line
test("Empty human text → block only, no leading blank line", () => {
  const result = mirrorWarningsToText({ warnings: ["x"] }, "");
  assert.strictEqual(result, "⚠ x");
});

// Case 7: Non-array `warnings` ignored (defensive)
test("Non-array warnings ignored", () => {
  const result = mirrorWarningsToText({ warnings: "oops" }, "body");
  assert.strictEqual(result, "body");
});

// Case 8: Body never mutated — input object unchanged, result starts with original body
test("Body never mutated, result starts with original body", () => {
  const input = { warnings: ["x"] };
  const body = "body";
  const before = JSON.stringify(input);
  const result = mirrorWarningsToText(input, body);
  // Input object not mutated
  assert.deepStrictEqual(JSON.stringify(input), before);
  // Result starts with the exact original body string
  assert.ok(typeof result === "string" && result.startsWith(body),
    `Expected result to start with "body", got: ${JSON.stringify(result)}`);
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
