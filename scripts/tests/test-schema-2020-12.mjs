/**
 * JSON Schema 2020-12 conformance check for SDK-emitted tool schemas (SEP-2106).
 *
 * Connects over stdio, pulls the ACTUAL SDK-emitted inputSchema/outputSchema for
 * every registered tool via tools/list, and for each schema:
 *   1. records the declared `$schema` dialect tag (draft-07 vs 2020-12 vs none);
 *   2. validates it as a structurally valid 2020-12 document (Ajv2020 meta-schema,
 *      with `$schema` forced to the 2020-12 URI so the check is dialect-independent);
 *   3. scans for genuinely-incompatible draft-07-only constructs (tuple `items[]`,
 *      boolean `exclusiveMinimum/Maximum`, `dependencies`, `definitions`).
 *
 * Background: originally run 2026-05-30 under Zod v3, when the SDK's compat layer
 * emitted a `$schema: draft-07` dialect tag (spec-legal but non-canonical). Re-run
 * post Zod-v4 bump (zod ^4.4.0) to see whether the v4 branch now emits 2020-12.
 *
 * Run:  ENABLE_FIND_SIMILAR=true node scripts/tests/test-schema-2020-12.mjs
 * Uses: @modelcontextprotocol/sdk Client + StdioClientTransport (stdio mode)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import AjvModule from "ajv/dist/2020.js";

const Ajv2020 = AjvModule.default ?? AjvModule.Ajv2020 ?? AjvModule;
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const META_2020_12 = "https://json-schema.org/draft/2020-12/schema";

// ── Structural scan for draft-07-only / 2020-12-incompatible constructs ──
function scanDraft07Constructs(node, pathStr, hits) {
  if (Array.isArray(node)) {
    node.forEach((n, i) => scanDraft07Constructs(n, `${pathStr}[${i}]`, hits));
    return;
  }
  if (!node || typeof node !== "object") return;

  // tuple form: `items` as an array is draft-07; 2020-12 uses `prefixItems`
  if (Array.isArray(node.items)) hits.push(`${pathStr}.items[] (tuple → use prefixItems)`);
  // draft-04 boolean exclusive bounds (draft-07 made them numeric)
  if (typeof node.exclusiveMinimum === "boolean") hits.push(`${pathStr}.exclusiveMinimum:boolean`);
  if (typeof node.exclusiveMaximum === "boolean") hits.push(`${pathStr}.exclusiveMaximum:boolean`);
  // draft-07 `dependencies` split into dependentRequired/dependentSchemas in 2020-12
  if ("dependencies" in node) hits.push(`${pathStr}.dependencies (→ dependentRequired/Schemas)`);
  // draft-07 `definitions` bucket renamed `$defs` in 2019-09+
  if ("definitions" in node) hits.push(`${pathStr}.definitions (→ $defs)`);

  for (const [k, v] of Object.entries(node)) {
    if (k === "$schema" || k === "$id") continue;
    if (v && typeof v === "object") scanDraft07Constructs(v, `${pathStr}.${k}`, hits);
  }
}

// ── Connect ──────────────────────────────────────────────────────────
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true", ENABLE_FIND_SIMILAR: "true" },
});
const client = new Client({ name: "test-schema-2020-12", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

const { tools } = await client.listTools();
console.log(`Pulled ${tools.length} tools from tools/list\n`);

const ajv = new Ajv2020({ strict: false, allowUnionTypes: true, validateFormats: false });

const dialectTally = {};        // e.g. { "draft-07": N, "2020-12": M, "(none)": K }
let schemaCount = 0;
let hardFailures = 0;
let structuralHits = 0;
const failDetails = [];

function dialectOf(schema) {
  const s = schema?.$schema;
  if (!s) return "(none)";
  if (s.includes("2020-12")) return "2020-12";
  if (s.includes("2019-09")) return "2019-09";
  if (s.includes("draft-07")) return "draft-07";
  if (s.includes("draft-04")) return "draft-04";
  return s;
}

function checkSchema(toolName, kind, schema) {
  if (!schema) return; // tool exposes no schema of this kind
  schemaCount++;

  const dialect = dialectOf(schema);
  dialectTally[dialect] = (dialectTally[dialect] ?? 0) + 1;

  // (2) structural validity as a 2020-12 document — force the dialect tag so the
  //     meta-schema choice is independent of what the SDK declared.
  const clone = structuredClone(schema);
  clone.$schema = META_2020_12;
  let valid = false;
  try {
    valid = ajv.validateSchema(clone);
  } catch (e) {
    valid = false;
    ajv.errors = [{ message: `threw: ${e.message}` }];
  }
  if (!valid) {
    hardFailures++;
    failDetails.push(`  ✗ ${toolName}.${kind}: ${JSON.stringify(ajv.errors?.slice(0, 3))}`);
  }

  // (3) draft-07-only construct scan
  const hits = [];
  scanDraft07Constructs(schema, `${toolName}.${kind}`, hits);
  if (hits.length) {
    structuralHits += hits.length;
    failDetails.push(`  ⚠ ${toolName}.${kind}: ${hits.join(", ")}`);
  }
}

for (const t of tools) {
  checkSchema(t.name, "inputSchema", t.inputSchema);
  checkSchema(t.name, "outputSchema", t.outputSchema);
}

// ── Report ───────────────────────────────────────────────────────────
console.log("═".repeat(64));
console.log("  JSON Schema 2020-12 conformance — SDK-emitted tool schemas");
console.log("═".repeat(64));
console.log(`Tools:              ${tools.length}`);
console.log(`Schemas checked:    ${schemaCount} (input + output across all tools)`);
console.log(`Zod:                ${JSON.parse((await import("node:fs")).readFileSync(path.join(PROJECT_DIR, "package.json"), "utf8")).dependencies.zod}`);
console.log(`\nDeclared $schema dialect tally:`);
for (const [d, n] of Object.entries(dialectTally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${d.padEnd(12)} ${n}`);
}
console.log(`\nStructural 2020-12 validity:  ${hardFailures === 0 ? "✓ all valid" : `✗ ${hardFailures} FAILED`}`);
console.log(`Draft-07-only constructs:     ${structuralHits === 0 ? "✓ none" : `⚠ ${structuralHits} found`}`);
if (failDetails.length) {
  console.log(`\nDetails:`);
  failDetails.forEach((d) => console.log(d));
}

await client.close();

const clean = hardFailures === 0 && structuralHits === 0;
const draft07 = (dialectTally["draft-07"] ?? 0) > 0;
console.log(`\n${clean ? "PASS" : "FAIL"} — structurally ${clean ? "clean" : "NOT clean"}; ` +
  `dialect tag: ${draft07 ? "still emits draft-07 (SEP-2106 swap still pending)" : "no draft-07 tag (SEP-2106 dialect item may be closable)"}`);
process.exit(clean ? 0 : 1);
