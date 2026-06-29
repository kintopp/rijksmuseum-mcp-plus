/**
 * Hermetic guard: the committed provenance parser must equal a fresh regen
 * of src/provenance-grammar.peggy. Fails if a grammar edit landed without
 * running `npm run build:peggy` (the parser would be stale at runtime).
 *
 * Run:  node scripts/tests/test-parser-drift.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const grammar = path.join(root, "src", "provenance-grammar.peggy");
const committed = path.join(root, "src", "provenance-parser.generated.js");
const peggyBin = path.join(root, "node_modules", ".bin", "peggy");
const tmp = path.join(mkdtempSync(path.join(tmpdir(), "peggy-drift-")), "regen.js");

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.log(`  ✗ ${msg}`); } }

execFileSync(peggyBin, ["--format", "es", "-o", tmp, grammar], { cwd: root });
const fresh = readFileSync(tmp, "utf8");
const onDisk = readFileSync(committed, "utf8");
assert(fresh === onDisk,
  "committed provenance-parser.generated.js equals a fresh regen of the grammar (run `npm run build:peggy` if this fails)");

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`);
process.exit(failed > 0 ? 1 : 0);
