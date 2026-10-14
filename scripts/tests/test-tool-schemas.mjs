/**
 * tools/list contract surface: what hosts read about every tool before calling it.
 *
 * Failure modes guarded:
 *   - A schema is not a valid JSON Schema 2020-12 document, still declares the
 *     draft-07 dialect, or uses a draft-07-only construct (tuple `items[]`,
 *     boolean exclusive bounds, `dependencies`, `definitions`).
 *   - A schema contains a `$ref`: claude.ai fails to resolve them, so every
 *     shape must be inlined.
 *   - A tool silently ignores an unknown argument instead of rejecting it, so a
 *     removed or misspelt param (e.g. search_artwork's old creatorGender or
 *     provenance) would run as an unfiltered query; the error must name the key.
 *   - A tool's annotations drift: `destructiveHint` defaults to true when absent,
 *     so hosts would prompt before read-only calls; `openWorldHint` must be true
 *     exactly for tools that reach a live external service at call time.
 *
 * Runs against the fixture vocab DB so the DB-gated tools register.
 * Run: node scripts/tests/test-tool-schemas.mjs   (needs ./dist)
 */
import Ajv2020 from "ajv/dist/2020.js";
import { connectFixtureClient } from "./fixture-client.mjs";

const META_2020_12 = "https://json-schema.org/draft/2020-12/schema";

let passed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) passed++;
  else { failures.push(msg); console.log(`  ✗ ${msg}`); }
}

const client = await connectFixtureClient("tool-schemas");
const { tools } = await client.listTools();

// ── 1. JSON Schema 2020-12 ──────────────────────────────────────────
console.log("1. Every input/output schema is clean JSON Schema 2020-12");
const ajv = new Ajv2020({ strict: false, allowUnionTypes: true, validateFormats: false });
for (const t of tools) {
  for (const [kind, schema] of [["inputSchema", t.inputSchema], ["outputSchema", t.outputSchema]]) {
    if (!schema) continue;
    const where = `${t.name}.${kind}`;
    check(!schema.$schema || schema.$schema === META_2020_12, `${where} declares $schema ${schema.$schema}`);
    // Validate against the 2020-12 meta-schema whatever the declared tag says.
    const valid = ajv.validateSchema({ ...schema, $schema: META_2020_12 });
    check(valid, `${where} is not a valid 2020-12 schema: ${JSON.stringify(ajv.errors?.slice(0, 2))}`);
    // The meta-schema rejects tuple `items` and boolean exclusive bounds, but
    // still accepts these two as deprecated keywords.
    const json = JSON.stringify(schema);
    check(!/"(definitions|dependencies)":/.test(json), `${where} uses draft-07 definitions/dependencies`);
    check(!json.includes('"$ref"'), `${where} contains a $ref`);
  }
}

// ── 2. Annotations ──────────────────────────────────────────────────
console.log("2. Every tool carries the expected annotations");
const READ_CLOSED = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const READ_OPEN = { ...READ_CLOSED, openWorldHint: true };
const VIEWER = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const EXPECTED = {
  search_artwork: READ_CLOSED,
  search_persons: READ_CLOSED,
  get_artwork_details: READ_CLOSED,
  collection_stats: READ_CLOSED,
  semantic_search: READ_CLOSED,
  multimodal_search: READ_CLOSED,
  find_similar: READ_OPEN,            // rijksmuseum.nl visual-similarity channel
  search_provenance: READ_CLOSED,
  search_inscriptions: READ_CLOSED,
  get_recent_changes: READ_OPEN,      // live OAI-PMH
  list_curated_sets: READ_CLOSED,
  browse_set: READ_CLOSED,
  get_conservation_history: READ_CLOSED,
  get_artwork_bibliography: READ_CLOSED,
  find_artworks_citing_publication: READ_CLOSED,
  inspect_artwork_image: READ_OPEN,   // iiif.micr.io
  get_artwork_image: { ...VIEWER, openWorldHint: true },
  remount_viewer: VIEWER,
  navigate_viewer: VIEWER,
  poll_viewer_commands: VIEWER,
};
for (const t of tools) {
  const expected = EXPECTED[t.name];
  check(expected, `${t.name} has no entry in EXPECTED — add one`);
  for (const [key, value] of Object.entries(expected ?? {})) {
    check(t.annotations?.[key] === value, `${t.name}.annotations.${key} is ${t.annotations?.[key]}, expected ${value}`);
  }
}
// semantic_search and multimodal_search need their vector DB + model, which CI does not have.
const OPTIONAL = new Set(["semantic_search", "multimodal_search"]);
const missing = Object.keys(EXPECTED).filter((n) => !OPTIONAL.has(n) && !tools.some((t) => t.name === n));
check(missing.length === 0, `tools not registered: ${missing.join(", ")}`);

// ── 3. Unknown arguments are rejected ───────────────────────────────
console.log("3. Every tool rejects an unknown argument, naming it");
for (const t of tools) {
  let text;
  try {
    const r = await client.callTool({ name: t.name, arguments: { notAParam: 1 } });
    text = r.isError ? (r.content?.[0]?.text ?? "") : null;
  } catch (e) {
    text = e.message;
  }
  check(text !== null, `${t.name} accepted an unknown argument`);
  check(text === null || /Unrecognized key.*notAParam/s.test(text), `${t.name} error does not name the unknown key: ${text?.slice(0, 120)}`);
}
await client.close();

console.log(`\n${passed} passed, ${failures.length} failed (${tools.length} tools)`);
process.exit(failures.length ? 1 : 0);
