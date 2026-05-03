#!/usr/bin/env node
/**
 * DEPRECATED — v0.19-era feature tests. Predates clusters A–F (v0.27).
 * Still functionally passes because the exercised filters survived, but the
 * coverage is partial vs. the current tool surface. Kept for historical
 * reference; do not extend — write new tests against the current surface
 * instead.
 *
 * Targeted tests for all v0.19 features:
 *   1. Compact mode — IDs only, no enrichment, totalResults
 *   2. aboutActor — searches both depicted persons and creators
 *   3. imageAvailable — filters to artworks with images
 *   4. BM25 ranking — FTS path when title + vocab filter combine
 *   5. Importance ordering — default sort for non-FTS queries
 *   6. Semantic search — no-subjects embeddings, extended filters
 *   7. Extended semantic filters — aboutActor, imageAvailable, collectionSet, etc.
 *   8. Geo-spatial queries — nearPlace with proximity search
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});

const client = new Client({ name: "v019-feature-test", version: "1.0" });
await client.connect(transport);
console.log("Connected\n");

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { console.log(`  \u2713 ${label}`); passed++; }
  else { console.log(`  \u2717 ${label}`); failed++; }
}

async function call(name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    return r.structuredContent ?? (r.content?.[0]?.text ? JSON.parse(r.content[0].text) : r);
  } catch (e) {
    return { _error: e.message };
  }
}

// ════════════════════════════════════════════════════════════
//  1. COMPACT MODE
// ════════════════════════════════════════════════════════════
console.log("════════════════════════════════════════════════════════════");
console.log("  1. Compact mode");
console.log("════════════════════════════════════════════════════════════\n");

console.log("--- 1a: compact returns ids, no results array ---");
let r = await call("search_artwork", { subject: "windmill", compact: true });
check("Has ids array", Array.isArray(r?.ids));
check("ids are strings", typeof r?.ids?.[0] === "string");
check("Has totalResults (single filter)", typeof r?.totalResults === "number" && r.totalResults > 0);
check("No results array", r?.results === undefined);
check("Source is vocabulary", r?.source === "vocabulary");
console.log(`    -> ${r?.totalResults} windmill artworks, ${r?.ids?.length} IDs returned`);

console.log("\n--- 1b: compact with multiple filters (no totalResults) ---");
r = await call("search_artwork", { creator: "Rembrandt", material: "paper", compact: true });
check("Returns ids", r?.ids?.length > 0);
// Multi-filter compact skips COUNT for performance — totalResults is undefined
check("totalResults undefined (multi-filter optimization)", r?.totalResults === undefined);
console.log(`    -> ${r?.ids?.length} Rembrandt paper IDs returned`);

console.log("\n--- 1c: compact with zero results ---");
r = await call("search_artwork", { creator: "Rembrandt", material: "plastic", compact: true });
check("Zero results: ids empty", r?.ids?.length === 0);

console.log("\n--- 1d: compact vs full — same single filter, counts match ---");
const compactR = await call("search_artwork", { type: "painting", compact: true });
const fullR = await call("search_artwork", { type: "painting", compact: false, maxResults: 5 });
check("Compact has totalResults", typeof compactR?.totalResults === "number" && compactR.totalResults > 0);
check("Full results returned", fullR?.results?.length > 0);
check("Compact count >= full returned", compactR?.totalResults >= fullR?.results?.length);
console.log(`    -> Compact: ${compactR?.totalResults} paintings, Full: ${fullR?.results?.length} returned`);


// ════════════════════════════════════════════════════════════
//  2. aboutActor
// ════════════════════════════════════════════════════════════
console.log("\n════════════════════════════════════════════════════════════");
console.log("  2. aboutActor (searches depicted + creators)");
console.log("════════════════════════════════════════════════════════════\n");

console.log("--- 2a: aboutActor finds works BY an artist ---");
r = await call("search_artwork", { aboutActor: "Rembrandt", type: "painting", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
const hasRembrandt = r?.results?.some(x => x.creator?.toLowerCase().includes("rembrandt"));
check("Includes works created by Rembrandt", hasRembrandt);

console.log("\n--- 2b: aboutActor finds works DEPICTING a person ---");
r = await call("search_artwork", { aboutActor: "Willem III", maxResults: 10 });
check("Returns results", r?.results?.length > 0);
console.log(`    -> ${r?.totalResults ?? r?.results?.length} results about Willem III`);

console.log("\n--- 2c: aboutActor vs creator — aboutActor is broader ---");
const creatorOnly = await call("search_artwork", { creator: "Vermeer", compact: true });
const aboutActorR = await call("search_artwork", { aboutActor: "Vermeer", compact: true });
// Both are single-filter, so totalResults is available
check("aboutActor count >= creator count", (aboutActorR?.totalResults ?? aboutActorR?.ids?.length) >= (creatorOnly?.totalResults ?? creatorOnly?.ids?.length));
console.log(`    -> creator: ${creatorOnly?.totalResults ?? creatorOnly?.ids?.length}, aboutActor: ${aboutActorR?.totalResults ?? aboutActorR?.ids?.length}`);

console.log("\n--- 2d: aboutActor with non-existent person ---");
r = await call("search_artwork", { aboutActor: "Xyzzy Nonexistent Person" });
check("Zero or no results", (r?.results?.length ?? 0) === 0 || r?.totalResults === 0);


// ════════════════════════════════════════════════════════════
//  3. imageAvailable
// ════════════════════════════════════════════════════════════
console.log("\n════════════════════════════════════════════════════════════");
console.log("  3. imageAvailable filter");
console.log("════════════════════════════════════════════════════════════\n");

console.log("--- 3a: imageAvailable=true narrows results ---");
// Use multi-filter (subject + imageAvailable) — totalResults won't be available
const withImageR = await call("search_artwork", { subject: "portrait", imageAvailable: true, compact: true });
const withImageCount = withImageR?.ids?.length ?? 0;
check("Returns IDs with image filter", withImageCount > 0);

console.log("--- 3b: without imageAvailable returns more IDs ---");
const allPortraitsR = await call("search_artwork", { subject: "portrait", compact: true });
const allCount = allPortraitsR?.totalResults ?? allPortraitsR?.ids?.length ?? 0;
check("All portraits >= with-image portraits", allCount >= withImageCount);
console.log(`    -> With image: ${withImageCount} IDs, All: ${allCount}`);

console.log("\n--- 3c: imageAvailable=false is a no-op (not routed as filter) ---");
const falseImageR = await call("search_artwork", { subject: "portrait", imageAvailable: false, compact: true });
// imageAvailable=false should behave identically to omitting it
check("imageAvailable=false same count as no filter", (falseImageR?.totalResults ?? falseImageR?.ids?.length) === allCount);

console.log("\n--- 3d: imageAvailable with other filters ---");
r = await call("search_artwork", { type: "painting", creator: "Rembrandt", imageAvailable: true, maxResults: 3 });
check("Returns results", r?.results?.length > 0);


// ════════════════════════════════════════════════════════════
//  4. BM25 RANKING (title + vocab filter → FTS path)
// ════════════════════════════════════════════════════════════
console.log("\n════════════════════════════════════════════════════════════");
console.log("  4. BM25 ranking (FTS path)");
console.log("════════════════════════════════════════════════════════════\n");

console.log("--- 4a: title + subject triggers FTS path ---");
r = await call("search_artwork", { title: "stilleven", subject: "flowers", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
const hasTitleMatch = r?.results?.some(x => x.title?.toLowerCase().includes("stilleven"));
check("Results contain title term", hasTitleMatch);
console.log(`    -> Top: ${r?.results?.[0]?.objectNumber} "${r?.results?.[0]?.title?.slice(0, 60)}"`);

console.log("\n--- 4b: title alone goes through vocab FTS (v0.19 all-vocab routing) ---");
r = await call("search_artwork", { title: "nachtwacht", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
check("Source is vocabulary", r?.source === "vocabulary");
check("Has totalResults", r?.totalResults > 0);
const hasNachtwacht = r?.results?.some(x => x.title?.toLowerCase().includes("nachtwacht"));
check("Results contain 'nachtwacht'", hasNachtwacht);
console.log(`    -> ${r?.totalResults} results, top: ${r?.results?.[0]?.objectNumber} "${r?.results?.[0]?.title?.slice(0, 60)}"`);

console.log("\n--- 4c: title + type triggers FTS ---");
r = await call("search_artwork", { title: "landschap", type: "painting", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
check("Source is vocabulary (FTS)", r?.source === "vocabulary");
// FTS matches on title_all_text (all 6 title variants including Dutch),
// but the displayed title is English-preferred — check for "Landscape" instead
const hasLandscape = r?.results?.some(x => x.title?.toLowerCase().includes("landscape"));
check("Results contain English equivalent", hasLandscape);

console.log("\n--- 4d: title + creator triggers FTS ---");
r = await call("search_artwork", { title: "zelfportret", creator: "Rembrandt", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
check("Source is vocabulary (FTS)", r?.source === "vocabulary");
console.log(`    -> Top: ${r?.results?.[0]?.objectNumber} "${r?.results?.[0]?.title?.slice(0, 60)}"`);

console.log("\n--- 4e: English title search ---");
r = await call("search_artwork", { title: "night watch", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
console.log(`    -> ${r?.totalResults} results, top: ${r?.results?.[0]?.objectNumber} "${r?.results?.[0]?.title?.slice(0, 60)}"`);


// ════════════════════════════════════════════════════════════
//  5. IMPORTANCE ORDERING
// ════════════════════════════════════════════════════════════
console.log("\n════════════════════════════════════════════════════════════");
console.log("  5. Importance ordering");
console.log("════════════════════════════════════════════════════════════\n");

console.log("--- 5a: type=painting without text filter → importance order ---");
r = await call("search_artwork", { type: "painting", maxResults: 10 });
check("Returns results", r?.results?.length > 0);
const topIds = r?.results?.map(x => x.objectNumber) ?? [];
console.log(`    -> Top 5: ${topIds.slice(0, 5).join(", ")}`);
// Night Watch (SK-C-5) should be in the top results (rank 2 with current importance scores)
const nightWatchRank = topIds.indexOf("SK-C-5") + 1;
check("Night Watch in top 5", nightWatchRank > 0 && nightWatchRank <= 5);
if (nightWatchRank > 0) console.log(`    -> Night Watch at rank ${nightWatchRank}`);

console.log("\n--- 5b: type=print → importance order (different top) ---");
r = await call("search_artwork", { type: "print", maxResults: 5 });
check("Returns print results", r?.results?.length > 0);
console.log(`    -> Top: ${r?.results?.[0]?.objectNumber} "${r?.results?.[0]?.title?.slice(0, 50)}"`);

console.log("\n--- 5c: importance order is stable (same query twice) ---");
const r1 = await call("search_artwork", { type: "painting", maxResults: 5 });
const r2 = await call("search_artwork", { type: "painting", maxResults: 5 });
const ids1 = r1?.results?.map(x => x.objectNumber).join(",");
const ids2 = r2?.results?.map(x => x.objectNumber).join(",");
check("Same order on repeat", ids1 === ids2);

console.log("\n--- 5d: BM25 overrides importance when title present ---");
r = await call("search_artwork", { title: "nachtwacht", type: "painting", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
console.log(`    -> BM25 top: ${r?.results?.[0]?.objectNumber} "${r?.results?.[0]?.title?.slice(0, 60)}"`);

console.log("\n--- 5e: importance ordering for drawings ---");
r = await call("search_artwork", { type: "drawing", maxResults: 5 });
check("Returns drawing results", r?.results?.length > 0);
console.log(`    -> Top: ${r?.results?.[0]?.objectNumber} "${r?.results?.[0]?.title?.slice(0, 50)}"`);


// ════════════════════════════════════════════════════════════
//  6. SEMANTIC SEARCH — no-subjects embeddings
// ════════════════════════════════════════════════════════════
console.log("\n════════════════════════════════════════════════════════════");
console.log("  6. Semantic search (no-subjects embeddings)");
console.log("════════════════════════════════════════════════════════════\n");

console.log("--- 6a: conceptual query ---");
r = await call("semantic_search", { query: "winter landscape with ice skating", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
check("Has searchMode", r?.searchMode === "semantic");
check("Has returnedCount", typeof r?.returnedCount === "number");
check("Has similarityScore", r?.results?.[0]?.similarityScore != null);
check("Has sourceText", typeof r?.results?.[0]?.sourceText === "string" && r.results[0].sourceText.length > 0);
console.log(`    -> Top: ${r?.results?.[0]?.objectNumber} (score: ${r?.results?.[0]?.similarityScore?.toFixed(3)})`);
console.log(`    -> "${r?.results?.[0]?.title?.slice(0, 70)}"`);

console.log("\n--- 6b: atmospheric/emotional query ---");
r = await call("semantic_search", { query: "melancholic lonely figure in dark room", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
check("Has similarity scores", r?.results?.every(x => x.similarityScore != null));
console.log(`    -> Top: ${r?.results?.[0]?.objectNumber} "${r?.results?.[0]?.title?.slice(0, 60)}" (${r?.results?.[0]?.similarityScore?.toFixed(3)})`);

console.log("\n--- 6c: Dutch language query ---");
r = await call("semantic_search", { query: "scheepvaart en handel in de Gouden Eeuw", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
console.log(`    -> Top: ${r?.results?.[0]?.objectNumber} "${r?.results?.[0]?.title?.slice(0, 60)}" (${r?.results?.[0]?.similarityScore?.toFixed(3)})`);

console.log("\n--- 6d: cross-language query (German) ---");
r = await call("semantic_search", { query: "Blumenstrauß in einer Vase", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
console.log(`    -> Top: ${r?.results?.[0]?.objectNumber} "${r?.results?.[0]?.title?.slice(0, 60)}" (${r?.results?.[0]?.similarityScore?.toFixed(3)})`);

console.log("\n--- 6e: sourceText reflects no-subjects strategy ---");
r = await call("semantic_search", { query: "artist self-portrait looking at viewer", maxResults: 1 });
check("Has sourceText", r?.results?.[0]?.sourceText?.length > 0);
const src = r?.results?.[0]?.sourceText ?? "";
console.log(`    -> sourceText preview: "${src.slice(0, 120)}..."`);

console.log("\n--- 6f: scores decrease monotonically ---");
r = await call("semantic_search", { query: "Dutch Golden Age interior scene", maxResults: 10 });
check("Returns multiple results", r?.results?.length > 1);
let monotonic = true;
for (let i = 1; i < (r?.results?.length ?? 0); i++) {
  if (r.results[i].similarityScore > r.results[i - 1].similarityScore) { monotonic = false; break; }
}
check("Scores decrease monotonically", monotonic);


// ════════════════════════════════════════════════════════════
//  7. EXTENDED SEMANTIC FILTERS
// ════════════════════════════════════════════════════════════
console.log("\n════════════════════════════════════════════════════════════");
console.log("  7. Extended semantic search filters");
console.log("════════════════════════════════════════════════════════════\n");

console.log("--- 7a: semantic + type filter ---");
r = await call("semantic_search", { query: "stormy sea with ships", type: "painting", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
check("searchMode is semantic+filtered", r?.searchMode === "semantic+filtered");
console.log(`    -> Top: ${r?.results?.[0]?.objectNumber} "${r?.results?.[0]?.title?.slice(0, 60)}"`);

console.log("\n--- 7b: semantic + creator filter ---");
r = await call("semantic_search", { query: "biblical scene", creator: "Rembrandt", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
check("Filtered mode", r?.searchMode === "semantic+filtered");
console.log(`    -> Top: ${r?.results?.[0]?.objectNumber} "${r?.results?.[0]?.title?.slice(0, 60)}"`);

console.log("\n--- 7c: semantic + aboutActor ---");
r = await call("semantic_search", { query: "royal portrait", aboutActor: "Willem", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
check("Filtered mode", r?.searchMode === "semantic+filtered");
console.log(`    -> ${r?.returnedCount} results`);

console.log("\n--- 7d: semantic + imageAvailable ---");
r = await call("semantic_search", { query: "Japanese porcelain with floral decoration", imageAvailable: true, maxResults: 5 });
check("Returns results", r?.results?.length > 0);
check("Filtered mode", r?.searchMode === "semantic+filtered");

console.log("\n--- 7e: semantic + creationDate ---");
r = await call("semantic_search", { query: "tulip", creationDate: "17*", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
check("Filtered mode", r?.searchMode === "semantic+filtered");
console.log(`    -> Top: ${r?.results?.[0]?.objectNumber} "${r?.results?.[0]?.title?.slice(0, 60)}"`);

console.log("\n--- 7f: semantic + material filter ---");
r = await call("semantic_search", { query: "landscape", material: "canvas", type: "painting", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
check("Filtered mode", r?.searchMode === "semantic+filtered");

console.log("\n--- 7g: semantic with impossible filter combo → zero results ---");
r = await call("semantic_search", { query: "anything", creator: "Xyzzy Nonexistent", maxResults: 5 });
check("Zero results", r?.returnedCount === 0 || r?.results?.length === 0);
if (r?.warnings?.length > 0) console.log(`    -> Warning: ${r.warnings[0]}`);

console.log("\n--- 7h: semantic + multiple filters (type + creator + date) ---");
r = await call("semantic_search", { query: "night scene", type: "painting", creator: "Rembrandt", creationDate: "164*", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
console.log(`    -> ${r?.returnedCount} results, top: ${r?.results?.[0]?.objectNumber} "${r?.results?.[0]?.title?.slice(0, 50)}"`);


// ════════════════════════════════════════════════════════════
//  8. GEO-SPATIAL QUERIES (nearPlace)
// ════════════════════════════════════════════════════════════
console.log("\n════════════════════════════════════════════════════════════");
console.log("  8. Geo-spatial queries (nearPlace)");
console.log("════════════════════════════════════════════════════════════\n");

console.log("--- 8a: nearPlace basic — artworks near Amsterdam ---");
const t0 = Date.now();
r = await call("search_artwork", { nearPlace: "Amsterdam", type: "painting", maxResults: 5 });
const geoMs = Date.now() - t0;
check("Returns results", r?.results?.length > 0);
check("Has referencePlace", typeof r?.referencePlace === "string" && r.referencePlace.includes("Amsterdam"));
// Results should have distance info
const hasDistance = r?.results?.some(x => x.distance_km != null || x.nearestPlace != null);
check("Results have distance/nearestPlace", hasDistance);
console.log(`    -> ref: ${r?.referencePlace}, ${geoMs}ms`);
if (r?.results?.[0]) console.log(`    -> Top: ${r.results[0].objectNumber} near ${r.results[0].nearestPlace} (${r.results[0].distance_km} km)`);

console.log("\n--- 8b: nearPlace with radius ---");
r = await call("search_artwork", { nearPlace: "Delft", nearPlaceRadius: 10, type: "painting", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
// All results should be within 10 km of Delft
const allWithin10 = r?.results?.every(x => x.distance_km == null || x.distance_km <= 10);
check("All within 10 km radius", allWithin10);
console.log(`    -> ref: ${r?.referencePlace}`);
r?.results?.forEach((x, i) => console.log(`    ${i + 1}. ${x.objectNumber} ${x.nearestPlace} (${x.distance_km} km)`));

console.log("\n--- 8c: nearPlace performance (should be fast with v0.19 indexes) ---");
const t1 = Date.now();
const geoR1 = await call("search_artwork", { nearPlace: "Paris", type: "print", maxResults: 10 });
const geoTime1 = Date.now() - t1;
check("Returns results", geoR1?.results?.length > 0);
check("Response time < 5s", geoTime1 < 5000);
console.log(`    -> ${geoR1?.results?.length} results in ${geoTime1}ms`);

console.log("\n--- 8d: nearPlace with non-geocoded place ---");
r = await call("search_artwork", { nearPlace: "Xyzzy Nonexistent Place", maxResults: 3 });
// Should return 0 results or a warning
const noGeo = (r?.results?.length ?? 0) === 0 || r?.warnings?.length > 0;
check("No results or warning for unknown place", noGeo);
if (r?.warnings?.[0]) console.log(`    -> Warning: ${r.warnings[0].slice(0, 80)}`);

console.log("\n--- 8e: nearPlace sorted by distance (closest first) ---");
r = await call("search_artwork", { nearPlace: "Haarlem", subject: "church", maxResults: 10 });
check("Returns results", r?.results?.length > 0);
let distSorted = true;
for (let i = 1; i < (r?.results?.length ?? 0); i++) {
  const prev = r.results[i - 1].distance_km;
  const curr = r.results[i].distance_km;
  if (prev != null && curr != null && curr < prev) { distSorted = false; break; }
}
check("Results sorted by distance", distSorted);
console.log(`    -> ref: ${r?.referencePlace}`);
r?.results?.slice(0, 3).forEach((x, i) => console.log(`    ${i + 1}. ${x.objectNumber} ${x.nearestPlace} (${x.distance_km} km)`));

console.log("\n--- 8f: nearPlace with small radius → fewer results ---");
const wideR = await call("search_artwork", { nearPlace: "Amsterdam", type: "painting", nearPlaceRadius: 50, compact: true });
const narrowR = await call("search_artwork", { nearPlace: "Amsterdam", type: "painting", nearPlaceRadius: 5, compact: true });
const wideCount = wideR?.ids?.length ?? 0;
const narrowCount = narrowR?.ids?.length ?? 0;
check("Wide radius >= narrow radius", wideCount >= narrowCount);
console.log(`    -> 50 km: ${wideCount} IDs, 5 km: ${narrowCount} IDs`);

console.log("\n--- 8g: nearPlace + creator intersection ---");
r = await call("search_artwork", { nearPlace: "Amsterdam", creator: "Rembrandt", maxResults: 5 });
check("Returns results", r?.results?.length > 0);
const hasRembrandtGeo = r?.results?.some(x => x.creator?.toLowerCase().includes("rembrandt"));
check("Results by Rembrandt", hasRembrandtGeo);
console.log(`    -> Top: ${r?.results?.[0]?.objectNumber} near ${r?.results?.[0]?.nearestPlace} (${r?.results?.[0]?.distance_km} km)`);

console.log("\n--- 8h: multi-word place resolution ---");
r = await call("search_artwork", { nearPlace: "Oude Kerk Amsterdam", maxResults: 5 });
check("Returns results or resolves place", r?.results?.length > 0 || r?.referencePlace != null);
if (r?.referencePlace) console.log(`    -> Resolved: ${r.referencePlace}`);
if (r?.warnings?.[0]) console.log(`    -> Warning: ${r.warnings[0].slice(0, 100)}`);


// ════════════════════════════════════════════════════════════
//  RESULTS
// ════════════════════════════════════════════════════════════
console.log("\n════════════════════════════════════════════════════════════");
console.log(`  RESULTS: Passed ${passed}, Failed ${failed}`);
console.log("════════════════════════════════════════════════════════════\n");

await client.close();
process.exit(failed > 0 ? 1 : 0);
