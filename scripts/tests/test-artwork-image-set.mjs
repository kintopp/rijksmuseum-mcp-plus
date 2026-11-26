/**
 * get_artwork_image with objectNumbers: the offline paths (fixture DB, no IIIF
 * fetch). The live path — one viewUUID, order kept, remount to item 2 — is in
 * test-remount-viewer.mjs §7, which needs the real DB and network.
 *
 * Failure modes guarded:
 *   - neither or both of objectNumber/objectNumbers accepted silently
 *   - an empty or over-long list accepted
 *   - unresolvable items reported without their object number, out of order,
 *     or twice when the caller repeats one
 *   - a list whose items all fail returning a success
 *   - the single-objectNumber path changing its error
 *   - the schema still marking objectNumber as required
 *
 * Fixture: FX-2 and FX-5 have no iiif_id; NOPE-1 / NOPE-2 are not in the DB.
 * Every item here fails before any IIIF fetch, so the test needs no network.
 *
 * Run:  node scripts/tests/test-artwork-image-set.mjs
 */
import { connectFixtureClient } from "./fixture-client.mjs";

let failed = 0;
function check(cond, msg) {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failed++;
}

const client = await connectFixtureClient("artwork-image-set");

async function call(args) {
  try {
    return await client.callTool({ name: "get_artwork_image", arguments: args });
  } catch (err) {
    return { thrown: err };
  }
}
const textOf = (r) => r.content?.find((c) => c.type === "text")?.text ?? "";
const rejected = (r) => Boolean(r.thrown) || r.isError === true;

const EXACTLY_ONE = "Provide exactly one of objectNumber or objectNumbers.";

console.log("\n1. Schema");
const { tools } = await client.listTools();
const schema = tools.find((t) => t.name === "get_artwork_image")?.inputSchema;
check(!(schema?.required ?? []).includes("objectNumber"), "objectNumber is no longer required");
const listProp = schema?.properties?.objectNumbers;
check(listProp?.type === "array" && listProp?.maxItems === 20 && listProp?.minItems === 1,
  `objectNumbers is an array of 1-20 (got ${JSON.stringify(listProp && { type: listProp.type, minItems: listProp.minItems, maxItems: listProp.maxItems })})`);

console.log("\n2. Exactly one of the two parameters");
const neither = await call({});
check(rejected(neither) && textOf(neither) === EXACTLY_ONE, `neither → "${EXACTLY_ONE}" (got ${JSON.stringify(textOf(neither))})`);
const both = await call({ objectNumber: "FX-1", objectNumbers: ["FX-1"] });
check(rejected(both) && textOf(both) === EXACTLY_ONE, `both → "${EXACTLY_ONE}" (got ${JSON.stringify(textOf(both))})`);
check(neither.structuredContent === undefined, "the error carries no structuredContent");

console.log("\n3. List length");
// Pin the validation message: unknown items fail on their own, so a bare
// isError would pass even if the cap were lifted.
const empty = await call({ objectNumbers: [] });
check(textOf(empty) === "Input validation error: Invalid arguments for tool get_artwork_image: objectNumbers: Too small: expected array to have >=1 items",
  `an empty list fails validation (got ${JSON.stringify(textOf(empty))})`);
const tooMany = await call({ objectNumbers: Array.from({ length: 21 }, (_, i) => `NOPE-${i}`) });
check(textOf(tooMany) === "Input validation error: Invalid arguments for tool get_artwork_image: objectNumbers: Too big: expected array to have <=20 items",
  `21 items fail validation (got ${JSON.stringify(textOf(tooMany))})`);

console.log("\n4. Every item fails");
const allBad = await call({ objectNumbers: ["NOPE-1", "FX-2", "NOPE-1", "FX-5", "NOPE-2"] });
const expected =
  "None of the artworks could be shown: " +
  "NOPE-1: no artwork found for this object number; " +
  "FX-2: no image available for this artwork; " +
  "FX-5: no image available for this artwork; " +
  "NOPE-2: no artwork found for this object number";
check(allBad.isError === true, "the result is an error");
check(textOf(allBad) === expected, `message names each item once, in order (got ${JSON.stringify(textOf(allBad))})`);
check(allBad.structuredContent?.error === expected, "structuredContent.error carries the same message");
check(allBad.structuredContent?.objectNumber === "NOPE-1", "structuredContent.objectNumber is the first item");

console.log("\n5. Single objectNumber is unchanged");
const single = await call({ objectNumber: "NOPE-1" });
check(single.isError === true && textOf(single) === "No artwork found for this object number",
  `unknown objectNumber keeps its error (got ${JSON.stringify(textOf(single))})`);
check(single.structuredContent?.sequence === undefined, "a single-artwork result has no sequence");

await client.close();
console.log(failed === 0 ? "\nAll checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
