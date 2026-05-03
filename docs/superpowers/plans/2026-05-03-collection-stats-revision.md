# collection_stats v0.27 Schema-Drift Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `collection_stats` back into alignment with the v0.26/v0.27 vocabulary.db schema by exposing the meaningful dimensions and filters the DB now supports — four field_lookup rows currently dark to stats (`productionRole`, `profession`, `birthPlace`, `deathPlace`), creator demographics (`gender`, birth-cohort dims), `placeType`, `partyRole`, `exhibition` filter, `parseMethod` filter, four provenance event-level booleans, and a family of `has*` boolean filters — and refreshing the tool description so its examples and per-filter copy reflect the current toolkit (especially the `search_persons → vocab ID` workflow).

**Architecture:** All additions land in two files. Data layer (`src/api/VocabularyDb.ts`) gets new entries in `VOCAB_DIMENSION_DEFS` / `PROV_DIMENSION_DEFS` / `STATS_VOCAB_FILTERS`, new branches in `artworkDimensionSql` for the special-cased dims (gender, creatorBirthDecade, creatorBirthCentury, placeType), new fields on `CollectionStatsParams` for each new filter, and a single new SQL block in `computeCollectionStats` for the cross-cutting `has*` booleans. Tool surface (`src/registration.ts`) gets matching Zod schema additions on the `inputSchema`, a refreshed multi-line description with an updated examples block, and assignment of every new filter into `params`. Tests are stdio MCP-client probes that mirror the existing `test-collection-stats-new-dimensions.mjs` pattern.

**Tech Stack:** TypeScript (NodeNext ESM), `better-sqlite3`, `@modelcontextprotocol/sdk` Client + StdioClientTransport for tests, Zod for schemas. No new dependencies.

**Out of scope (deferred):** `rights` / `importance` / `attributionQualifier` dims; `relatedRelationship` dim and edge-level filters; `recordCreatedFrom/To` and `recordModifiedFrom/To` filters; `museumRoom` / `museumFloor` dims. These are still real gaps; just not in this revision.

---

## File Structure

**Modify:**
- `src/api/VocabularyDb.ts` — `CollectionStatsParams` interface (~line 499), `VOCAB_DIMENSION_DEFS` (line 588), `PROV_DIMENSION_DEFS` (line 600), `STATS_DIMENSION_NAMES` (line 618), `STATS_VOCAB_FILTERS` (line 682), `artworkDimensionSql` (line 3604), `computeCollectionStats` (line 3760).
- `src/registration.ts` — `collection_stats` tool description and `inputSchema` (lines ~3210–3273) + `args → params` assignments and filter-summary builder (lines ~3276–3338).
- `CLAUDE.md` — short note in the "Architecture → Key files" or "Common Errors" section reflecting the new dimension/filter inventory.

**Create:**
- `scripts/tests/test-collection-stats-tier1.mjs` — covers Tasks 1–3 (4 new field_lookup dims, gender, creator-birth cohorts).
- `scripts/tests/test-collection-stats-tier2.mjs` — covers Tasks 4–6 (exhibition filter, parseMethod + provenance booleans, partyRole).
- `scripts/tests/test-collection-stats-tier3.mjs` — covers Tasks 7–9 (placeType, has*-boolean family, description-content assertion).

---

## Task 1: Surface four existing field_lookup rows as dimensions

**Why:** `production_role` (1.36M mappings), `profession` (459K), `birth_place` (196K), `death_place` (181K) are all rows in `field_lookup` with substantial mapping coverage. They are filterable on `search_artwork` but invisible to `collection_stats`. Adding them is mechanical: append to `VOCAB_DIMENSION_DEFS`.

`productionRole` records the role a creator played in *making* an object — "designer", "engraver", "publisher", "printmaker" — and is independent of who the principal artist was. (Distinct from the provenance-side `party_role`, which records who did what in a *transaction* and is not part of this task.)

**Files:**
- Modify: `src/api/VocabularyDb.ts`
- Modify: `src/registration.ts`
- Create: `scripts/tests/test-collection-stats-tier1.mjs`

- [ ] **Step 1: Create the tier-1 test file with the field-lookup section**

Write `scripts/tests/test-collection-stats-tier1.mjs`:

```javascript
/**
 * Tests for collection_stats schema-drift revision (Tier 1).
 * Run:  node scripts/tests/test-collection-stats-tier1.mjs
 * Requires: npm run build first.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let passed = 0; let failed = 0; const failures = [];
function assert(cond, msg) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); } }
function section(name) { console.log(`\n${"═".repeat(60)}\n  ${name}\n${"═".repeat(60)}`); }
async function call(name, args) { const r = await client.callTool({ name, arguments: args }); return { text: r.content?.[0]?.text ?? "", isError: !!r.isError }; }

const transport = new StdioClientTransport({
  command: "node", args: ["dist/index.js"], cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "test-collection-stats-tier1", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

// ══════════════════════════════════════════════════════════════════
//  1. New vocab dimensions: productionRole, profession, birthPlace, deathPlace
// ══════════════════════════════════════════════════════════════════
section("1. New vocab dimensions");
for (const dim of ["productionRole", "profession", "birthPlace", "deathPlace"]) {
  const { text, isError } = await call("collection_stats", { dimension: dim, topN: 5 });
  assert(!isError, `${dim} dimension returns no error`);
  const entryLines = text.split("\n").filter(l => /^\s+\S.*\d+(,\d+)*\s+\(\d/.test(l));
  assert(entryLines.length >= 3, `${dim} returns at least 3 entries (got ${entryLines.length})`);
}
{
  const { text, isError } = await call("collection_stats", { dimension: "type", topN: 3, productionRole: "printmaker" });
  assert(!isError, "productionRole filter returns no error");
  assert(text.includes("productionRole="), "filter summary shows productionRole=…");
}

await client.close();
console.log(`\n${"─".repeat(60)}\nTier 1: ${passed} passed, ${failed} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node scripts/tests/test-collection-stats-tier1.mjs`
Expected: section 1 fails — four unknown dimensions, one unknown filter arg.

- [ ] **Step 3: Extend `VOCAB_DIMENSION_DEFS`**

In `src/api/VocabularyDb.ts` (around line 588):

```typescript
const VOCAB_DIMENSION_DEFS: ReadonlyArray<{ label: string; field: string; vocabType?: string }> = [
  { label: "type",            field: "type" },
  { label: "material",        field: "material" },
  { label: "technique",       field: "technique" },
  { label: "creator",         field: "creator" },
  { label: "depictedPerson",  field: "subject", vocabType: "person" },
  { label: "depictedPlace",   field: "subject", vocabType: "place" },
  { label: "productionPlace", field: "spatial" },
  { label: "sourceType",      field: "source_type" },
  { label: "productionRole",  field: "production_role" },
  { label: "profession",      field: "profession" },
  { label: "birthPlace",      field: "birth_place", vocabType: "place" },
  { label: "deathPlace",      field: "death_place", vocabType: "place" },
];
```

- [ ] **Step 4: Extend `CollectionStatsParams` and `STATS_VOCAB_FILTERS`**

In `CollectionStatsParams` (around line 499):

```typescript
  productionRole?: string;
  profession?: string;
  birthPlace?: string;
  deathPlace?: string;
```

In `STATS_VOCAB_FILTERS` (around line 682):

```typescript
const STATS_VOCAB_FILTERS: readonly StatsVocabFilter[] = [
  { key: "type",            fields: ["type"] },
  { key: "material",        fields: ["material"] },
  { key: "technique",       fields: ["technique"] },
  { key: "creator",         fields: ["creator"] },
  { key: "productionPlace", fields: ["spatial"],            vocabType: "place" },
  { key: "depictedPerson",  fields: ["subject"],            vocabType: "person" },
  { key: "depictedPlace",   fields: ["subject", "spatial"], vocabType: "place" },
  { key: "subject",         fields: ["subject"] },
  { key: "iconclass",       fields: ["subject"], exactNotation: true },
  { key: "collectionSet",   fields: ["collection_set"],     vocabType: "set" },
  { key: "theme",           fields: ["theme"] },
  { key: "sourceType",      fields: ["source_type"] },
  { key: "productionRole",  fields: ["production_role"] },
  { key: "profession",      fields: ["profession"] },
  { key: "birthPlace",      fields: ["birth_place"],        vocabType: "place" },
  { key: "deathPlace",      fields: ["death_place"],        vocabType: "place" },
];
```

- [ ] **Step 5: Add to the tool surface**

In `src/registration.ts` `inputSchema`, alongside `theme`:

```typescript
          productionRole: optStr().describe("Filter to artworks where a creator has this production role (e.g. 'printmaker', 'publisher', 'designer'). The role records what the creator did in making the object, distinct from the provenance-side party role."),
          profession: optStr().describe("Filter to artworks where a creator has this profession (partial match)."),
          birthPlace: optStr().describe("Filter to artworks where a creator was born in this place (partial match)."),
          deathPlace: optStr().describe("Filter to artworks where a creator died in this place (partial match)."),
```

In the `args → params` block:

```typescript
        if (args.productionRole) params.productionRole = args.productionRole as string;
        if (args.profession) params.profession = args.profession as string;
        if (args.birthPlace) params.birthPlace = args.birthPlace as string;
        if (args.deathPlace) params.deathPlace = args.deathPlace as string;
```

In `filterParts`:

```typescript
        if (params.productionRole) filterParts.push(`productionRole=${params.productionRole}`);
        if (params.profession) filterParts.push(`profession=${params.profession}`);
        if (params.birthPlace) filterParts.push(`birthPlace=${params.birthPlace}`);
        if (params.deathPlace) filterParts.push(`deathPlace=${params.deathPlace}`);
```

In the description "Artwork dimensions" line, append `, productionRole, profession, birthPlace, deathPlace`.

- [ ] **Step 6: Rebuild and re-run**

Run: `npm run build && node scripts/tests/test-collection-stats-tier1.mjs`
Expected: section 1 passes.

- [ ] **Step 7: Commit**

```bash
git add src/api/VocabularyDb.ts src/registration.ts scripts/tests/test-collection-stats-tier1.mjs
git commit -m "collection_stats: surface 4 existing field_lookup dims + filters"
```

---

## Task 2: Add `gender` dimension and filter

**Why:** v0.26 demographic enrichment populated `vocabulary.gender` for ~72,500 persons. Currently the only path to "female creators per century" is round-tripping through `search_persons`. A direct dimension makes this a one-call query.

**Files:**
- Modify: `src/api/VocabularyDb.ts`
- Modify: `src/registration.ts`
- Modify: `scripts/tests/test-collection-stats-tier1.mjs`

- [ ] **Step 1: Append the gender test section**

In `scripts/tests/test-collection-stats-tier1.mjs`, before `client.close()`:

```javascript
// ══════════════════════════════════════════════════════════════════
//  2. gender dimension + filter
// ══════════════════════════════════════════════════════════════════
section("2. gender dimension + filter");
{
  const { text, isError } = await call("collection_stats", { dimension: "gender" });
  assert(!isError, "gender dimension returns no error");
  assert(text.includes("male"), "male present in gender output");
  assert(text.includes("female"), "female present in gender output");
}
{
  const { text, isError } = await call("collection_stats", { dimension: "century", gender: "female", topN: 5 });
  assert(!isError, "gender filter returns no error");
  assert(text.includes("gender=female"), "filter summary shows gender=female");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node scripts/tests/test-collection-stats-tier1.mjs`
Expected: section 2 fails — `gender` is an unknown dimension and an unknown arg.

- [ ] **Step 3: Add `gender` to data layer**

In `src/api/VocabularyDb.ts` `CollectionStatsParams`:

```typescript
  gender?: string;  // 'male' | 'female' | 'unknown'
```

In `STATS_DIMENSION_NAMES`, append `"gender"`.

In `artworkDimensionSql`, before the final `return null;`:

```typescript
    if (dim === "gender") {
      const fieldId = this.fieldIdMap.get("creator");
      if (fieldId === undefined) return null;
      return {
        sql: `SELECT v.gender AS label, COUNT(DISTINCT m.artwork_id) AS cnt
          FROM mappings m
          JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
          WHERE +m.field_id = ? AND v.gender IS NOT NULL
            AND m.artwork_id IN (SELECT art_id FROM _stats_artworks)
          GROUP BY v.gender ORDER BY cnt DESC LIMIT ? OFFSET ?`,
        extraBindings: [fieldId, topN, offset],
      };
    }
```

In `computeCollectionStats`, alongside `creationDateFrom`:

```typescript
    if (params.gender) {
      const creatorFieldId = this.fieldIdMap.get("creator");
      if (creatorFieldId !== undefined) {
        conditions.push(`a.art_id IN (
          SELECT m.artwork_id FROM mappings m
          JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
          WHERE +m.field_id = ? AND v.gender = ?
        )`);
        bindings.push(creatorFieldId, params.gender);
      }
    }
```

- [ ] **Step 4: Add to the tool surface**

In `src/registration.ts` `inputSchema`:

```typescript
          gender: z.preprocess(stripNull, z.enum(["male", "female", "unknown"]).optional())
            .describe("Filter to artworks where a creator has this gender (from v0.26 demographic enrichment)."),
```

In `args → params`:

```typescript
        if (args.gender) params.gender = args.gender as string;
```

In `filterParts`:

```typescript
        if (params.gender) filterParts.push(`gender=${params.gender}`);
```

In the description "Artwork dimensions" line, append `, gender`.

- [ ] **Step 5: Rebuild and re-run**

Run: `npm run build && node scripts/tests/test-collection-stats-tier1.mjs`
Expected: sections 1+2 pass.

- [ ] **Step 6: Commit**

```bash
git add src/api/VocabularyDb.ts src/registration.ts scripts/tests/test-collection-stats-tier1.mjs
git commit -m "collection_stats: add gender dimension + filter"
```

---

## Task 3: Add `creatorBirthDecade` and `creatorBirthCentury` dimensions

**Why:** ~57K persons have `vocabulary.birth_year`. Generational cohort views ("which decade did the most-collected creators come from?") are currently impossible.

**Files:**
- Modify: `src/api/VocabularyDb.ts`
- Modify: `src/registration.ts`
- Modify: `scripts/tests/test-collection-stats-tier1.mjs`

- [ ] **Step 1: Append the cohort test section**

In `scripts/tests/test-collection-stats-tier1.mjs`, before `client.close()`:

```javascript
// ══════════════════════════════════════════════════════════════════
//  3. creatorBirthDecade + creatorBirthCentury dimensions
// ══════════════════════════════════════════════════════════════════
section("3. creator birth cohort dimensions");
{
  const { text, isError } = await call("collection_stats", { dimension: "creatorBirthDecade", topN: 5 });
  assert(!isError, "creatorBirthDecade returns no error");
  const counts = [...text.matchAll(/(\d{1,3}(?:,\d{3})*)\s+\(\d/g)].map(m => parseInt(m[1].replace(/,/g, ""), 10));
  assert(counts.length >= 3, `creatorBirthDecade returns ≥3 buckets (got ${counts.length})`);
}
{
  const { text, isError } = await call("collection_stats", { dimension: "creatorBirthCentury", topN: 8 });
  assert(!isError, "creatorBirthCentury returns no error");
  assert(text.includes("1500") || text.includes("1600") || text.includes("1700") || text.includes("1800"),
    "creatorBirthCentury surfaces a recognisable century bucket");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node scripts/tests/test-collection-stats-tier1.mjs`
Expected: section 3 fails — both dimensions unknown.

- [ ] **Step 3: Add the dimensions**

In `src/api/VocabularyDb.ts` `STATS_DIMENSION_NAMES`, append `"creatorBirthDecade", "creatorBirthCentury"`.

In `artworkDimensionSql`, before the final `return null;`:

```typescript
    if (dim === "creatorBirthDecade" || dim === "creatorBirthCentury") {
      const fieldId = this.fieldIdMap.get("creator");
      if (fieldId === undefined) return null;
      const bucketWidth = dim === "creatorBirthCentury" ? 100 : binWidth;
      return {
        sql: `SELECT (v.birth_year / ?) * ? AS label, COUNT(DISTINCT m.artwork_id) AS cnt
          FROM mappings m
          JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
          WHERE +m.field_id = ? AND v.birth_year IS NOT NULL
            AND m.artwork_id IN (SELECT art_id FROM _stats_artworks)
          GROUP BY label ORDER BY label LIMIT ? OFFSET ?`,
        extraBindings: [bucketWidth, bucketWidth, fieldId, topN, offset],
      };
    }
```

- [ ] **Step 4: Add to the tool surface**

In `src/registration.ts`, append `, creatorBirthDecade, creatorBirthCentury` to the description "Artwork dimensions" line. No new filters needed (binWidth already supported).

- [ ] **Step 5: Rebuild and re-run**

Run: `npm run build && node scripts/tests/test-collection-stats-tier1.mjs`
Expected: sections 1–3 pass.

- [ ] **Step 6: Commit**

```bash
git add src/api/VocabularyDb.ts src/registration.ts scripts/tests/test-collection-stats-tier1.mjs
git commit -m "collection_stats: add creatorBirthDecade/Century dimensions"
```

---

## Task 4: Add `exhibition` filter (string title match)

**Why:** `exhibition` is already a *dimension* but not a *filter*. To answer "what types of artworks were in exhibition X?" you currently can't.

**Files:**
- Modify: `src/api/VocabularyDb.ts`
- Modify: `src/registration.ts`
- Create: `scripts/tests/test-collection-stats-tier2.mjs`

- [ ] **Step 1: Create the tier-2 test file with the exhibition-filter section**

Write `scripts/tests/test-collection-stats-tier2.mjs`:

```javascript
/**
 * Tests for collection_stats schema-drift revision (Tier 2).
 * Run:  node scripts/tests/test-collection-stats-tier2.mjs
 * Requires: npm run build first.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let passed = 0; let failed = 0; const failures = [];
function assert(cond, msg) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); } }
function section(name) { console.log(`\n${"═".repeat(60)}\n  ${name}\n${"═".repeat(60)}`); }
async function call(name, args) { const r = await client.callTool({ name, arguments: args }); return { text: r.content?.[0]?.text ?? "", isError: !!r.isError }; }

const transport = new StdioClientTransport({
  command: "node", args: ["dist/index.js"], cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "test-collection-stats-tier2", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

// ══════════════════════════════════════════════════════════════════
//  4. exhibition filter
// ══════════════════════════════════════════════════════════════════
section("4. exhibition filter");
{
  // Pick whatever the top exhibition title is — query first
  const { text } = await call("collection_stats", { dimension: "exhibition", topN: 1 });
  const m = text.match(/^\s+(\S.+?)\s+\d+(,\d+)*\s+\(\d/m);
  const topTitle = m?.[1]?.trim();
  assert(!!topTitle, `Recovered top exhibition title (${topTitle})`);
  if (topTitle) {
    const { text: filt, isError } = await call("collection_stats", {
      dimension: "type", topN: 5, exhibition: topTitle,
    });
    assert(!isError, "exhibition filter returns no error");
    assert(filt.includes("exhibition="), "filter summary shows exhibition=…");
  }
}

await client.close();
console.log(`\n${"─".repeat(60)}\nTier 2: ${passed} passed, ${failed} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node scripts/tests/test-collection-stats-tier2.mjs`
Expected: section 4 fails — `exhibition` rejected by strict Zod.

- [ ] **Step 3: Add the filter**

In `src/api/VocabularyDb.ts` `CollectionStatsParams`:

```typescript
  exhibition?: string;
```

In `computeCollectionStats`, alongside `creationDateTo`:

```typescript
    if (params.exhibition) {
      conditions.push(`EXISTS (
        SELECT 1 FROM artwork_exhibitions ae
        JOIN exhibitions e ON e.exhibition_id = ae.exhibition_id
        WHERE ae.art_id = a.art_id
          AND (e.title_en LIKE '%' || ? || '%' COLLATE NOCASE OR e.title_nl LIKE '%' || ? || '%' COLLATE NOCASE)
      )`);
      bindings.push(params.exhibition, params.exhibition);
    }
```

- [ ] **Step 4: Add to the tool surface**

In `src/registration.ts` `inputSchema`:

```typescript
          exhibition: optStr().describe("Filter to artworks shown in an exhibition matching this title (partial match on EN or NL title)."),
```

In `args → params`:

```typescript
        if (args.exhibition) params.exhibition = args.exhibition as string;
```

In `filterParts`:

```typescript
        if (params.exhibition) filterParts.push(`exhibition=${params.exhibition}`);
```

- [ ] **Step 5: Rebuild and re-run**

Run: `npm run build && node scripts/tests/test-collection-stats-tier2.mjs`
Expected: section 4 passes.

- [ ] **Step 6: Commit**

```bash
git add src/api/VocabularyDb.ts src/registration.ts scripts/tests/test-collection-stats-tier2.mjs
git commit -m "collection_stats: add exhibition filter"
```

---

## Task 5: Add `parseMethod` filter and provenance event-level booleans (`unsold`, `uncertain`, `crossRef`, `gap`)

**Why:** `parseMethod` is a dimension but not a filter, blocking "show me only LLM-corrected events". The four boolean flags on `provenance_events` (`unsold`, `uncertain`, `is_cross_ref`, `gap`) are entirely dark.

**Files:**
- Modify: `src/api/VocabularyDb.ts`
- Modify: `src/registration.ts`
- Modify: `scripts/tests/test-collection-stats-tier2.mjs`

- [ ] **Step 1: Append the provenance-boolean test section**

In `scripts/tests/test-collection-stats-tier2.mjs`, before `client.close()`:

```javascript
// ══════════════════════════════════════════════════════════════════
//  5. parseMethod filter + provenance event-level booleans
// ══════════════════════════════════════════════════════════════════
section("5. parseMethod + event booleans");
{
  const { text, isError } = await call("collection_stats", {
    dimension: "transferType", topN: 5, parseMethod: "peg",
  });
  assert(!isError, "parseMethod filter returns no error");
  assert(text.includes("parseMethod=peg"), "filter summary shows parseMethod=peg");
}
for (const flag of ["unsold", "uncertain", "crossRef", "gap"]) {
  const { text, isError } = await call("collection_stats", {
    dimension: "transferType", topN: 3, [flag]: true,
  });
  assert(!isError, `${flag} filter returns no error`);
  assert(text.includes(flag), `filter summary shows ${flag}`);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node scripts/tests/test-collection-stats-tier2.mjs`
Expected: section 5 fails — five unknown filter args.

- [ ] **Step 3: Add the filters to data layer**

In `src/api/VocabularyDb.ts` `CollectionStatsParams`:

```typescript
  parseMethod?: string;
  unsold?: boolean;
  uncertain?: boolean;
  crossRef?: boolean;
  gap?: boolean;
```

In `computeCollectionStats`, inside the `if (this.hasProvenanceTables_)` block where event conds are built (around line 3832), append (these must go *before* the `if (evConds.length > 0)` block that emits the EXISTS clause, so they participate in the same combined subquery):

```typescript
      if (params.parseMethod) { evConds.push("pe.parse_method = ?"); evBindings.push(params.parseMethod); }
      if (params.unsold) { evConds.push("pe.unsold = 1"); }
      if (params.uncertain) { evConds.push("pe.uncertain = 1"); }
      if (params.crossRef) { evConds.push("pe.is_cross_ref = 1"); }
      if (params.gap) { evConds.push("pe.gap = 1"); }
```

- [ ] **Step 4: Add to the tool surface**

In `src/registration.ts` `inputSchema`:

```typescript
          parseMethod: optStr().describe("Filter to artworks with provenance events parsed by this method ('peg', 'cross_ref', 'llm_structural', 'credit_line')."),
          unsold: z.preprocess(stripNull, z.boolean().optional())
            .describe("If true, restrict to artworks with at least one unsold-at-auction provenance event."),
          uncertain: z.preprocess(stripNull, z.boolean().optional())
            .describe("If true, restrict to artworks with at least one provenance event flagged as uncertain."),
          crossRef: z.preprocess(stripNull, z.boolean().optional())
            .describe("If true, restrict to artworks with at least one cross-reference provenance event."),
          gap: z.preprocess(stripNull, z.boolean().optional())
            .describe("If true, restrict to artworks with a gap-marker provenance event."),
```

In `args → params`:

```typescript
        if (args.parseMethod) params.parseMethod = args.parseMethod as string;
        if (args.unsold != null) params.unsold = args.unsold as boolean;
        if (args.uncertain != null) params.uncertain = args.uncertain as boolean;
        if (args.crossRef != null) params.crossRef = args.crossRef as boolean;
        if (args.gap != null) params.gap = args.gap as boolean;
```

In `filterParts`:

```typescript
        if (params.parseMethod) filterParts.push(`parseMethod=${params.parseMethod}`);
        if (params.unsold) filterParts.push("unsold");
        if (params.uncertain) filterParts.push("uncertain");
        if (params.crossRef) filterParts.push("crossRef");
        if (params.gap) filterParts.push("gap");
```

- [ ] **Step 5: Rebuild and re-run**

Run: `npm run build && node scripts/tests/test-collection-stats-tier2.mjs`
Expected: sections 4+5 pass.

- [ ] **Step 6: Commit**

```bash
git add src/api/VocabularyDb.ts src/registration.ts scripts/tests/test-collection-stats-tier2.mjs
git commit -m "collection_stats: add parseMethod + unsold/uncertain/crossRef/gap filters"
```

---

## Task 6: Add `partyRole` dimension and filter

**Why:** `provenance_parties.party_role` is the verbatim verb-derived role each party plays in a single provenance event ("collector", "recipient", "buyer", "heir", "donor"…) — extracted by the parser from the original Dutch/English text. It's distinct from `partyPosition` (a normalised owner/non-owner-agent label) and from `productionRole` (creation-time, not transaction-time). 91K parties; currently dark to stats.

**Files:**
- Modify: `src/api/VocabularyDb.ts`
- Modify: `src/registration.ts`
- Modify: `scripts/tests/test-collection-stats-tier2.mjs`

- [ ] **Step 1: Append the partyRole test section**

In `scripts/tests/test-collection-stats-tier2.mjs`, before `client.close()`:

```javascript
// ══════════════════════════════════════════════════════════════════
//  6. partyRole dimension + filter
// ══════════════════════════════════════════════════════════════════
section("6. partyRole dimension + filter");
{
  const { text, isError } = await call("collection_stats", { dimension: "partyRole", topN: 8 });
  assert(!isError, "partyRole returns no error");
  assert(text.includes("collector") || text.includes("recipient") || text.includes("buyer"),
    "partyRole surfaces a known role");
}
{
  const { text, isError } = await call("collection_stats", { dimension: "type", topN: 3, partyRole: "donor" });
  assert(!isError, "partyRole filter returns no error");
  assert(text.includes("partyRole=donor"), "filter summary shows partyRole=donor");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node scripts/tests/test-collection-stats-tier2.mjs`
Expected: section 6 fails — `partyRole` rejected as both an unknown dimension and an unknown filter arg.

- [ ] **Step 3: Wire `partyRole` into `PROV_DIMENSION_DEFS` and the filter pipeline**

In `src/api/VocabularyDb.ts` `PROV_DIMENSION_DEFS` (around line 600), append the new entry:

```typescript
const PROV_DIMENSION_DEFS: ReadonlyArray<{
  label: string; table: "events" | "parties"; col: string; notNull?: boolean;
}> = [
  { label: "transferType",       table: "events",  col: "transfer_type" },
  { label: "transferCategory",   table: "events",  col: "transfer_category",  notNull: true },
  { label: "provenanceLocation", table: "events",  col: "location",           notNull: true },
  { label: "currency",           table: "events",  col: "price_currency",     notNull: true },
  { label: "categoryMethod",     table: "events",  col: "category_method",    notNull: true },
  { label: "parseMethod",        table: "events",  col: "parse_method" },
  { label: "party",              table: "parties", col: "party_name" },
  { label: "partyPosition",      table: "parties", col: "party_position",     notNull: true },
  { label: "positionMethod",     table: "parties", col: "position_method",    notNull: true },
  { label: "partyRole",          table: "parties", col: "party_role",         notNull: true },
];
```

In `CollectionStatsParams`:

```typescript
  partyRole?: string;
```

In `computeCollectionStats`, inside the `if (this.hasProvenanceTables_)` block where party conditions are built (around line 3848, alongside the existing `params.party` block):

```typescript
      if (params.partyRole && this.hasPartyTable_) {
        ppConds.push("pp.party_role = ?");
        ppBindings.push(params.partyRole);
        conditions.push("EXISTS (SELECT 1 FROM provenance_parties pp WHERE pp.artwork_id = a.art_id AND pp.party_role = ?)");
        bindings.push(params.partyRole);
      }
```

- [ ] **Step 4: Add to the tool surface**

In `src/registration.ts` `inputSchema`, alongside `positionMethod`:

```typescript
          partyRole: optStr().describe("Filter to artworks involving a party with this transaction role (e.g. 'collector', 'donor', 'buyer', 'heir'). Distinct from productionRole, which is the creator's role in making the object."),
```

In `args → params`:

```typescript
        if (args.partyRole) params.partyRole = args.partyRole as string;
```

In `filterParts`:

```typescript
        if (params.partyRole) filterParts.push(`partyRole=${params.partyRole}`);
```

- [ ] **Step 5: Rebuild and re-run**

Run: `npm run build && node scripts/tests/test-collection-stats-tier2.mjs`
Expected: sections 4–6 pass.

- [ ] **Step 6: Commit**

```bash
git add src/api/VocabularyDb.ts src/registration.ts scripts/tests/test-collection-stats-tier2.mjs
git commit -m "collection_stats: add partyRole dim + filter"
```

---

## Task 7: Add `placeType` dimension and filter

**Why:** ~22K places have a non-null `placetype`. Useful for understanding what kind of places dominate subject/production-place mappings (cities vs. countries vs. regions).

**Files:**
- Modify: `src/api/VocabularyDb.ts`
- Modify: `src/registration.ts`
- Create: `scripts/tests/test-collection-stats-tier3.mjs`

- [ ] **Step 1: Create the tier-3 test file with the placeType section**

Write `scripts/tests/test-collection-stats-tier3.mjs`:

```javascript
/**
 * Tests for collection_stats schema-drift revision (Tier 3).
 * Run:  node scripts/tests/test-collection-stats-tier3.mjs
 * Requires: npm run build first.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let passed = 0; let failed = 0; const failures = [];
function assert(cond, msg) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); } }
function section(name) { console.log(`\n${"═".repeat(60)}\n  ${name}\n${"═".repeat(60)}`); }
async function call(name, args) { const r = await client.callTool({ name, arguments: args }); return { text: r.content?.[0]?.text ?? "", isError: !!r.isError }; }

const transport = new StdioClientTransport({
  command: "node", args: ["dist/index.js"], cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "test-collection-stats-tier3", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

// ══════════════════════════════════════════════════════════════════
//  7. placeType dimension + filter
// ══════════════════════════════════════════════════════════════════
section("7. placeType dimension + filter");
{
  const { text, isError } = await call("collection_stats", { dimension: "placeType", topN: 5 });
  assert(!isError, "placeType returns no error");
  // Top placetype is typically the AAT 'cities' or 'countries' URI
  assert(text.includes("vocab.getty.edu/aat") || text.includes("wikidata.org"),
    "placeType output references AAT or Wikidata URIs");
}
{
  const { text, isError } = await call("collection_stats", {
    dimension: "depictedPlace", topN: 5,
    placeType: "http://vocab.getty.edu/aat/300008347",  // 'inhabited places'
  });
  assert(!isError, "placeType filter returns no error");
  assert(text.includes("placeType="), "filter summary shows placeType=…");
}

await client.close();
console.log(`\n${"─".repeat(60)}\nTier 3: ${passed} passed, ${failed} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node scripts/tests/test-collection-stats-tier3.mjs`
Expected: section 7 fails.

- [ ] **Step 3: Add the dimension and filter**

In `src/api/VocabularyDb.ts` `CollectionStatsParams`:

```typescript
  placeType?: string;
```

In `STATS_DIMENSION_NAMES`, append `"placeType"`.

In `artworkDimensionSql`, before the final `return null;`:

```typescript
    if (dim === "placeType") {
      return {
        sql: `SELECT v.placetype AS label, COUNT(DISTINCT m.artwork_id) AS cnt
          FROM mappings m
          JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
          WHERE v.type = 'place' AND v.placetype IS NOT NULL
            AND m.artwork_id IN (SELECT art_id FROM _stats_artworks)
          GROUP BY v.placetype ORDER BY cnt DESC LIMIT ? OFFSET ?`,
        extraBindings: [topN, offset],
      };
    }
```

In `computeCollectionStats`, alongside `creationDateTo`:

```typescript
    if (params.placeType) {
      conditions.push(`a.art_id IN (
        SELECT m.artwork_id FROM mappings m
        JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
        WHERE v.type = 'place' AND v.placetype = ?
      )`);
      bindings.push(params.placeType);
    }
```

- [ ] **Step 4: Add to the tool surface**

In `src/registration.ts` `inputSchema`:

```typescript
          placeType: optStr().describe("Filter to artworks whose places have this placetype URI (e.g. 'http://vocab.getty.edu/aat/300008347' for inhabited places)."),
```

In `args → params`:

```typescript
        if (args.placeType) params.placeType = args.placeType as string;
```

In `filterParts`:

```typescript
        if (params.placeType) filterParts.push(`placeType=${params.placeType}`);
```

In the description "Artwork dimensions" line, append `, placeType`.

- [ ] **Step 5: Rebuild and re-run**

Run: `npm run build && node scripts/tests/test-collection-stats-tier3.mjs`
Expected: section 7 passes.

- [ ] **Step 6: Commit**

```bash
git add src/api/VocabularyDb.ts src/registration.ts scripts/tests/test-collection-stats-tier3.mjs
git commit -m "collection_stats: add placeType dimension + filter"
```

---

## Task 8: Add `has*` boolean filter family (one batch — ten booleans)

**Why:** `hasProvenance` is the only existing boolean. Generalise to `hasInscription`, `hasNarrative`, `hasDimensions`, `hasExhibitions`, `hasExternalIds`, `hasAltNames`, `hasParent`, `hasExaminations`, `hasModifications`, `hasWikidataCreator`. Each is a one-line `EXISTS` or `IS NOT NULL` check; together they let users slice on metadata richness in one call.

**Files:**
- Modify: `src/api/VocabularyDb.ts`
- Modify: `src/registration.ts`
- Modify: `scripts/tests/test-collection-stats-tier3.mjs`

- [ ] **Step 1: Append the has* test section**

In `scripts/tests/test-collection-stats-tier3.mjs`, before `client.close()`:

```javascript
// ══════════════════════════════════════════════════════════════════
//  8. has* boolean filter family
// ══════════════════════════════════════════════════════════════════
section("8. has* booleans");
const HAS_FLAGS = [
  "hasInscription", "hasNarrative", "hasDimensions", "hasExhibitions",
  "hasExternalIds", "hasAltNames", "hasParent", "hasExaminations",
  "hasModifications", "hasWikidataCreator",
];
for (const flag of HAS_FLAGS) {
  const { text, isError } = await call("collection_stats", {
    dimension: "type", topN: 3, [flag]: true,
  });
  assert(!isError, `${flag} filter returns no error`);
  assert(text.includes(flag), `filter summary shows ${flag}`);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node scripts/tests/test-collection-stats-tier3.mjs`
Expected: section 8 fails — ten unknown args.

- [ ] **Step 3: Add filters to data layer**

In `src/api/VocabularyDb.ts` `CollectionStatsParams`:

```typescript
  hasInscription?: boolean;
  hasNarrative?: boolean;
  hasDimensions?: boolean;
  hasExhibitions?: boolean;
  hasExternalIds?: boolean;
  hasAltNames?: boolean;
  hasParent?: boolean;
  hasExaminations?: boolean;
  hasModifications?: boolean;
  hasWikidataCreator?: boolean;
```

In `computeCollectionStats`, alongside `creationDateTo`:

```typescript
    if (params.hasInscription) {
      conditions.push("a.inscription_text IS NOT NULL AND a.inscription_text <> ''");
    }
    if (params.hasNarrative) {
      conditions.push("a.narrative_text IS NOT NULL AND a.narrative_text <> ''");
    }
    if (params.hasDimensions) {
      conditions.push("(a.height_cm > 0 OR a.width_cm > 0 OR a.depth_cm > 0 OR a.diameter_cm > 0)");
    }
    if (params.hasExhibitions) {
      conditions.push("EXISTS (SELECT 1 FROM artwork_exhibitions ae WHERE ae.art_id = a.art_id)");
    }
    if (params.hasExternalIds) {
      conditions.push("EXISTS (SELECT 1 FROM artwork_external_ids x WHERE x.art_id = a.art_id AND x.authority <> 'handle')");
    }
    if (params.hasAltNames) {
      conditions.push(`EXISTS (
        SELECT 1 FROM mappings m
        JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
        JOIN entity_alt_names ean ON ean.entity_id = v.id
        WHERE m.artwork_id = a.art_id
      )`);
    }
    if (params.hasParent) {
      conditions.push("EXISTS (SELECT 1 FROM artwork_parent ap WHERE ap.art_id = a.art_id)");
    }
    if (params.hasExaminations) {
      conditions.push("EXISTS (SELECT 1 FROM examinations ex WHERE ex.art_id = a.art_id)");
    }
    if (params.hasModifications) {
      conditions.push("EXISTS (SELECT 1 FROM modifications mo WHERE mo.art_id = a.art_id)");
    }
    if (params.hasWikidataCreator) {
      const creatorFieldId = this.fieldIdMap.get("creator");
      if (creatorFieldId !== undefined) {
        conditions.push(`a.art_id IN (
          SELECT m.artwork_id FROM mappings m
          JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
          WHERE +m.field_id = ? AND v.wikidata_id IS NOT NULL
        )`);
        bindings.push(creatorFieldId);
      }
    }
```

- [ ] **Step 4: Add to the tool surface**

In `src/registration.ts` `inputSchema`, alongside `imageAvailable`:

```typescript
          hasInscription: z.preprocess(stripNull, z.boolean().optional()).describe("If true, restrict to artworks with non-empty inscription text."),
          hasNarrative: z.preprocess(stripNull, z.boolean().optional()).describe("If true, restrict to artworks with a long-form narrative description."),
          hasDimensions: z.preprocess(stripNull, z.boolean().optional()).describe("If true, restrict to artworks with at least one physical dimension recorded."),
          hasExhibitions: z.preprocess(stripNull, z.boolean().optional()).describe("If true, restrict to artworks with exhibition history."),
          hasExternalIds: z.preprocess(stripNull, z.boolean().optional()).describe("If true, restrict to artworks with a non-handle external identifier."),
          hasAltNames: z.preprocess(stripNull, z.boolean().optional()).describe("If true, restrict to artworks linked to vocabulary entries with alternative names."),
          hasParent: z.preprocess(stripNull, z.boolean().optional()).describe("If true, restrict to artworks that are part of a parent (e.g. album, multi-part object)."),
          hasExaminations: z.preprocess(stripNull, z.boolean().optional()).describe("If true, restrict to artworks with a recorded conservation examination."),
          hasModifications: z.preprocess(stripNull, z.boolean().optional()).describe("If true, restrict to artworks with a recorded modification/intervention."),
          hasWikidataCreator: z.preprocess(stripNull, z.boolean().optional()).describe("If true, restrict to artworks with at least one creator linked to a Wikidata entity."),
```

In `args → params`:

```typescript
        for (const flag of [
          "hasInscription", "hasNarrative", "hasDimensions", "hasExhibitions",
          "hasExternalIds", "hasAltNames", "hasParent", "hasExaminations",
          "hasModifications", "hasWikidataCreator",
        ] as const) {
          if (args[flag] != null) (params as Record<string, unknown>)[flag] = args[flag] as boolean;
        }
```

In `filterParts`:

```typescript
        for (const flag of [
          "hasInscription", "hasNarrative", "hasDimensions", "hasExhibitions",
          "hasExternalIds", "hasAltNames", "hasParent", "hasExaminations",
          "hasModifications", "hasWikidataCreator",
        ] as const) {
          if ((params as Record<string, unknown>)[flag]) filterParts.push(flag);
        }
```

- [ ] **Step 5: Rebuild and re-run**

Run: `npm run build && node scripts/tests/test-collection-stats-tier3.mjs`
Expected: sections 7+8 pass.

- [ ] **Step 6: Commit**

```bash
git add src/api/VocabularyDb.ts src/registration.ts scripts/tests/test-collection-stats-tier3.mjs
git commit -m "collection_stats: add has* metadata-richness boolean filters"
```

---

## Task 9: Refresh tool description, examples block, and dimension/filter inventory

**Why:** The current description was last touched mid-cluster D. It still says `creator: "(partial match)"` without flagging `search_persons`, and the examples block (5 entries) doesn't show any of the new dimensions added in Tasks 1–7.

**Files:**
- Modify: `src/registration.ts` (description string, lines ~3215–3232)
- Modify: `scripts/tests/test-collection-stats-tier3.mjs`

- [ ] **Step 1: Add a description-content test**

In `scripts/tests/test-collection-stats-tier3.mjs`, before `client.close()`:

```javascript
// ══════════════════════════════════════════════════════════════════
//  9. description content reflects new dimensions/filters
// ══════════════════════════════════════════════════════════════════
section("9. description content");
{
  const tools = await client.listTools();
  const t = tools.tools.find(x => x.name === "collection_stats");
  assert(!!t, "collection_stats listed in tools");
  const desc = t?.description ?? "";
  // Spot-check that every new dim shows up in the prose
  for (const dim of [
    "gender", "productionRole", "profession", "birthPlace", "deathPlace",
    "creatorBirthDecade", "creatorBirthCentury", "placeType", "partyRole",
  ]) {
    assert(desc.includes(dim), `description mentions dim '${dim}'`);
  }
  // Examples block should reference search_persons workflow explicitly
  assert(/search_persons/.test(desc), "description mentions search_persons workflow");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node scripts/tests/test-collection-stats-tier3.mjs`
Expected: section 9 fails — `search_persons` not mentioned, several new dims absent from description text.

- [ ] **Step 3: Rewrite the description block**

In `src/registration.ts` (around lines 3215–3232), replace the entire `description:` string with:

```typescript
        description:
          "Use when the user wants aggregate counts, percentages, or distributions across the collection " +
          "(one call instead of search_artwork(compact=true) loops). Returns formatted text tables — no structured output schema. " +
          "Not for individual artwork lookup — use get_artwork_details. Not for similarity — use find_similar.\n\n" +
          "Workflow tip: for high-fidelity creator-based queries, run search_persons first to resolve a vocab ID, then pass the canonical name as 'creator'. " +
          "The string filters here use partial matching, so generic names ('Rembrandt') will match more than the autograph artist.\n\n" +
          "Examples:\n" +
          "- \"What types of artworks have provenance?\" → dimension='type', hasProvenance=true\n" +
          "- \"Gender of creators per century\" → dimension='century', gender='female'\n" +
          "- \"Creator birth-decade cohorts\" → dimension='creatorBirthDecade', topN=20\n" +
          "- \"Production-role breakdown for prints\" → dimension='productionRole', type='print'\n" +
          "- \"Sales by decade 1600–1900\" → dimension='provenanceDecade', transferType='sale', dateFrom=1600, dateTo=1900\n" +
          "- \"How many objects are part of a parent album?\" → dimension='type', hasParent=true\n" +
          "- \"LLM-corrected provenance events\" → dimension='transferType', parseMethod='llm_structural'\n\n" +
          "Artwork dimensions: type, material, technique, creator, depictedPerson, depictedPlace, productionPlace, " +
          "century, decade, height, width, " +
          "gender, " +
          "productionRole, profession, birthPlace, deathPlace, " +
          "creatorBirthDecade, creatorBirthCentury, " +
          "theme (thematic vocab — labels in NL until #300 backfill), sourceType (cataloguing-channel taxonomy — 6 values), " +
          "exhibition (top exhibitions by member count), decadeModified (record_modified bucketed by decade, clamped to 1990–2030), " +
          "placeType.\n" +
          "Provenance dimensions: transferType, transferCategory, provenanceDecade, provenanceLocation, party, partyPosition, partyRole, " +
          "currency, categoryMethod, positionMethod, parseMethod.\n\n" +
          "Filters from both domains combine freely. Artwork filters narrow the artwork set; provenance filters " +
          "further restrict to artworks matching those provenance criteria. Boolean has* filters (hasProvenance, hasInscription, " +
          "hasNarrative, hasDimensions, hasExhibitions, hasExternalIds, hasAltNames, hasParent, hasExaminations, hasModifications, " +
          "hasWikidataCreator) slice on metadata richness. Provenance event-level booleans (unsold, uncertain, crossRef, gap) " +
          "narrow to artworks with at least one matching event.",
```

- [ ] **Step 4: Rebuild and re-run**

Run: `npm run build && node scripts/tests/test-collection-stats-tier3.mjs`
Expected: section 9 passes.

- [ ] **Step 5: Commit**

```bash
git add src/registration.ts scripts/tests/test-collection-stats-tier3.mjs
git commit -m "collection_stats: rewrite description to cover all new dims/filters"
```

---

## Task 10: Update CLAUDE.md inventory line and run full regression

**Why:** Keep CLAUDE.md in sync with the surface, and run a full local regression to catch anything broken in adjacent tests.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Audit the existing CLAUDE.md mentions of collection_stats**

Run: `grep -n "collection_stats\|collection stats" CLAUDE.md`

The expected hits are descriptive prose about workflow tips and the tool's role; locate any sentence that makes a quantitative claim and rewrite to match the new inventory.

- [ ] **Step 2: Update CLAUDE.md if needed**

If a line like "collection_stats covers N dimensions…" exists, update it to match the new total. Otherwise, add a one-line note in the "Common Errors" or "Architecture" section reading:

```markdown
- **`collection_stats` v0.27 surface:** dimensions cover artwork (type/material/technique/creator/places/dates/dims/sourceType/theme/exhibition/decadeModified/gender/productionRole/profession/birthPlace/deathPlace/creatorBirthDecade/creatorBirthCentury/placeType) and provenance (transferType/transferCategory/provenanceDecade/provenanceLocation/party/partyPosition/partyRole/currency/categoryMethod/positionMethod/parseMethod). Filters add cataloguing-richness has*-booleans and provenance event-level booleans (unsold/uncertain/crossRef/gap). Special-case dims (gender, creatorBirth*, placeType) live in `artworkDimensionSql` branches; field_lookup-backed dims auto-route through `VOCAB_DIMENSION_DEFS`; provenance dims (incl. partyRole) auto-route through `PROV_DIMENSION_DEFS`. Note: `productionRole` is the creator's role in making the object; `partyRole` is a party's role inside a provenance transaction — different tables, different semantics.
```

- [ ] **Step 3: Run the full test suite + lint + typecheck**

Run:

```bash
npm run lint
npm run build
node scripts/tests/test-collection-stats-new-dimensions.mjs
node scripts/tests/test-collection-stats-tier1.mjs
node scripts/tests/test-collection-stats-tier2.mjs
node scripts/tests/test-collection-stats-tier3.mjs
npm run test:all
```

Expected: zero failures across all five.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: refresh CLAUDE.md with collection_stats v0.27 inventory"
```

- [ ] **Step 5: Final smoke test against actual MCP client behaviour**

Pick one example from the new description block and run it via the stdio client to confirm output is sane. Run:

```bash
node -e "
import('@modelcontextprotocol/sdk/client/index.js').then(async ({Client}) => {
  const {StdioClientTransport} = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const t = new StdioClientTransport({command:'node', args:['dist/index.js']});
  const c = new Client({name:'smoke', version:'0.1'});
  await c.connect(t);
  const r = await c.callTool({name:'collection_stats', arguments:{dimension:'gender'}});
  console.log(r.content[0].text);
  await c.close();
});
" 2>&1 | head -30
```

Expected: a multi-row distribution with `male` / `female` / `unknown` labels and counts.

---

## Self-review notes

- **Spec coverage.** Every dimension/filter the user kept after the scope reduction is mapped to exactly one task: 4 field_lookup dims incl. productionRole (Task 1), gender (Task 2), creator-birth cohorts (Task 3), exhibition filter (Task 4), parseMethod + 4 provenance booleans (Task 5), partyRole (Task 6), placeType (Task 7), 10 has*-booleans (Task 8). Description refresh (Task 9) and CLAUDE.md hygiene (Task 10) explicitly enumerated.
- **No placeholders.** Every step contains either runnable code, a runnable command, or an explicit edit location with code shown.
- **Type/name consistency.** All filter parameter names match between Zod schema, `args → params`, `filterParts`, `CollectionStatsParams`, and SQL: `productionRole`/`profession`/`birthPlace`/`deathPlace`/`gender`/`exhibition`/`parseMethod`/`unsold`/`uncertain`/`crossRef`/`gap`/`partyRole`/`placeType`/`hasInscription`/`hasNarrative`/`hasDimensions`/`hasExhibitions`/`hasExternalIds`/`hasAltNames`/`hasParent`/`hasExaminations`/`hasModifications`/`hasWikidataCreator`. Dimension names: `gender`/`productionRole`/`profession`/`birthPlace`/`deathPlace`/`creatorBirthDecade`/`creatorBirthCentury`/`partyRole`/`placeType`. The `productionRole` and `partyRole` dimensions/filters are intentionally distinct: the former indexes `mappings` rows under `field_lookup.production_role` (creation-time creator role); the latter indexes `provenance_parties.party_role` (transaction-time role). Both names appear in the description prose so the model can pick the right one.
- **DRY.** `STATS_VOCAB_FILTERS` and `VOCAB_DIMENSION_DEFS` data-driven lists absorb most additions without per-key code. The has*-family uses loops in `args → params` / `filterParts` to avoid 10+ near-identical lines.
- **YAGNI.** `aboutActor` (in `VOCAB_FILTERS` but tangential) is intentionally not surfaced — its semantics overlap with `creator`+`depictedPerson` and would invite confusion. `hasInscription` is included but `hasDescription`/`hasCreditLine`/`hasIIIF` are not, because all three are >60% saturated and would only meaningfully filter "missing-metadata" workflows the user hasn't asked for.
