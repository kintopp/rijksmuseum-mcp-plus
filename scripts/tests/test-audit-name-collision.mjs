/**
 * Unit tests for buildNameIndex / findShapeCollisions in the schema audit
 * harness. Exercises the fix for the self-collision false-positive on
 * primitive-array fields like `warnings` (both container and element records
 * emitted, resolving to the same leaf name, triggering a bogus collision).
 *
 * No I/O, no MCP, no dist/ build needed — analyzers.mjs is pure ESM.
 *
 * Run: node scripts/tests/test-audit-name-collision.mjs
 */
import { strict as assert } from "node:assert";
import { buildNameIndex, findShapeCollisions } from "./audit/analyzers.mjs";

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

// Case 1: Self-collision is gone — two tools each with container + element record
// for `warnings` should NOT report a collision (the element record is skipped).
test("Self-collision on warnings[] is suppressed", () => {
  const schemas = {
    toolA: [
      { path: "warnings", kind: "array<string>" },
      { path: "warnings[]", kind: "string" },
    ],
    toolB: [
      { path: "warnings", kind: "array<string>" },
      { path: "warnings[]", kind: "string" },
    ],
  };
  const collisions = findShapeCollisions(buildNameIndex(schemas));
  const warningsCollision = collisions.find(c => c.name === "warnings");
  assert.strictEqual(
    warningsCollision,
    undefined,
    `Expected no collision on "warnings", got: ${JSON.stringify(warningsCollision)}`,
  );
});

// Case 2: Legitimate cross-tool collision is preserved — two tools whose
// container records genuinely differ should still be reported.
test("Legitimate cross-tool shape collision is preserved", () => {
  const schemas2 = {
    toolA: [{ path: "foo", kind: "string" }],
    toolB: [{ path: "foo", kind: "number" }],
  };
  const collisions = findShapeCollisions(buildNameIndex(schemas2));
  const fooCollision = collisions.find(c => c.name === "foo");
  assert.ok(
    fooCollision != null,
    `Expected a collision on "foo", got none. All collisions: ${JSON.stringify(collisions)}`,
  );
  assert.ok(
    fooCollision.kinds.includes("string") && fooCollision.kinds.includes("number"),
    `Expected kinds to include "string" and "number", got: ${JSON.stringify(fooCollision.kinds)}`,
  );
});

// Case 3: Nested object-array element survives — results[].title in two tools
// with different kinds should still collide on leaf `title`. The `[]` here is
// interior (results[].title), NOT trailing, so it is NOT filtered out.
test("Nested object-array element collision is preserved", () => {
  const schemas3 = {
    toolA: [{ path: "results[].title", kind: "string" }],
    toolB: [{ path: "results[].title", kind: "number" }],
  };
  const collisions = findShapeCollisions(buildNameIndex(schemas3));
  const titleCollision = collisions.find(c => c.name === "title");
  assert.ok(
    titleCollision != null,
    `Expected a collision on "title", got none. All collisions: ${JSON.stringify(collisions)}`,
  );
  assert.ok(
    titleCollision.kinds.includes("string") && titleCollision.kinds.includes("number"),
    `Expected kinds to include "string" and "number", got: ${JSON.stringify(titleCollision.kinds)}`,
  );
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
