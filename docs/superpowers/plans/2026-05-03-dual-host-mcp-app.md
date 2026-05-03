# Dual-host MCP App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the artwork viewer work in OpenAI hosts (ChatGPT, Codex, Goose) without regressing claude.ai or Claude Desktop, while staying forward-compatible with ext-apps PR #295 (`widgetSessionId`) and issue #558 (multi-instance `updateModelContext` scoping).

**Architecture:** Two orthogonal opt-ins layered onto the existing viewer: `RIJKS_OPENAI_STICKY_VIEWER=1` adds `_meta.ui.resourceUri` + `openai/outputTemplate` to viewer-touching tools so OpenAI hosts keep the iframe mounted, and `RIJKS_VIEWER_MODE=notebook|live` (with per-call override) controls `widgetSessionId` minting. A `host-bridge.ts` seam stub keeps a future Apps SDK adapter port a one-file change.

**Tech Stack:** TypeScript, MCP SDK, ext-apps `App` class, Vite-bundled viewer, existing standalone-Node test scripts (no test framework).

**Spec:** `docs/superpowers/specs/2026-05-03-dual-host-mcp-app-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/registration.ts` | modify | Env-resolved constants + helpers; tool `_meta` wiring; mode-aware `viewUUID` selection on `get_artwork_image` |
| `apps/artwork-viewer/src/host-bridge.ts` | **create** | Single seam between viewer and host bridge; today returns ext-apps `App`, future contingency injection point for Apps SDK adapter |
| `apps/artwork-viewer/src/viewer.ts` | modify | Replace bare `new App(...)` with `createHostBridge(...)`; tag both `updateModelContext` call sites with `viewUUID` |
| `scripts/tests/test-sticky-viewer-meta.mjs` | **create** | Integration test exercising the four flag/mode combinations across the five viewer-touching tools |
| `package.json` | modify | Wire new test into `test:all` |
| `scripts/tests/cdp-observe-viewer.mjs` | modify | Add `--four-call-trace` mode that dumps timestamped event traces for the smoke-test sequence |
| `offline/runbooks/openai-host-smoke-test.md` | **create (submodule)** | Manual cross-host smoke-test runbook; results template |

---

## Task 1: Server-side scaffolding (env constants, helpers, `_meta` plumbing)

Behaviour-neutral with both flags off. Establishes the helpers Tasks 2 and 3 wire in.

**Files:**
- Modify: `src/registration.ts:29` (near `ARTWORK_VIEWER_RESOURCE_URI`), `src/registration.ts:108-134` (response types + `structuredResponse`)

- [ ] **Step 1: Verify the build is clean before starting**

```bash
cd /Users/abosse/Documents/GitHub/rijksmuseum-mcp-plus
npm run build && npm run test:all && npm run lint
```

Expected: build succeeds, tests pass (139/0 + 31/0 + others), lint clean.

- [ ] **Step 2: Extend response types and `structuredResponse` with optional `_meta`**

Edit `src/registration.ts` lines 108-134. Replace the existing block with:

```ts
type ToolResponse = {
  content: [{ type: "text"; text: string }];
  _meta?: Record<string, unknown>;
};
type StructuredToolResponse = ToolResponse & { structuredContent: Record<string, unknown> };

function errorResponse(message: string): ToolResponse {
  // Never emit structuredContent here — a bare { error } won't conform to
  // any tool's outputSchema (which has required fields like totalResults,
  // results, etc.) and causes the SDK to reject with -32602.
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

/** Return both structured content (for apps/typed clients) and text content (for LLMs).
 *  Set STRUCTURED_CONTENT=false to omit structuredContent (workaround for client bugs). */
const EMIT_STRUCTURED = process.env.STRUCTURED_CONTENT !== "false";

function structuredResponse(
  data: object,
  textContent?: string,
  meta?: Record<string, unknown>,
): ToolResponse | StructuredToolResponse {
  const text = textContent ?? JSON.stringify(data, null, 2);
  const base: ToolResponse = { content: [{ type: "text", text }] };
  if (meta) base._meta = meta;
  if (!EMIT_STRUCTURED) return base;
  return { ...base, structuredContent: data as Record<string, unknown> };
}

/** Conditionally attach an outputSchema when structured content is enabled. */
function withOutputSchema<T>(schema: T): { outputSchema: T } | Record<never, never> {
  return EMIT_STRUCTURED ? { outputSchema: schema } : {};
}
```

(Note: `errorResponse` already exists higher up; we do **not** redefine it — the snippet above is the contiguous block to replace, but verify by reading lines 108-139 first and only replacing the parts that match.)

- [ ] **Step 3: Add env-resolved constants + helpers near `ARTWORK_VIEWER_RESOURCE_URI`**

Insert immediately after line 29 (`const ARTWORK_VIEWER_RESOURCE_URI = "ui://rijksmuseum/artwork-viewer.html";`):

```ts
const STICKY_VIEWER = process.env.RIJKS_OPENAI_STICKY_VIEWER === "1";
const VIEWER_MODE: "notebook" | "live" =
  process.env.RIJKS_VIEWER_MODE === "live" ? "live" : "notebook";

/** Build registration-time `_meta` for a viewer-aware tool, gated by STICKY_VIEWER.
 *  When sticky is off, returns undefined so the tool registration is unchanged. */
function viewerToolMeta(opts: { appOnly?: boolean } = {}): Record<string, unknown> | undefined {
  if (!STICKY_VIEWER) return undefined;
  const ui: Record<string, unknown> = { resourceUri: ARTWORK_VIEWER_RESOURCE_URI };
  if (opts.appOnly) ui.visibility = ["app"];
  return {
    ui,
    "openai/outputTemplate": ARTWORK_VIEWER_RESOURCE_URI,  // OpenAI Apps SDK compat alias
  };
}

/** Build per-result `_meta` echoing the targeted viewUUID as widgetSessionId.
 *  Always emits the session echo (forward-compat for ext-apps#295);
 *  resourceUri/outputTemplate are gated by STICKY_VIEWER. */
function viewerResultMeta(viewUUID: string): Record<string, unknown> {
  const ui: Record<string, unknown> = { widgetSessionId: viewUUID };
  if (STICKY_VIEWER) ui.resourceUri = ARTWORK_VIEWER_RESOURCE_URI;
  const meta: Record<string, unknown> = {
    ui,
    "openai/widgetSessionId": viewUUID,
  };
  if (STICKY_VIEWER) meta["openai/outputTemplate"] = ARTWORK_VIEWER_RESOURCE_URI;
  return meta;
}
```

- [ ] **Step 4: Run build + tests to verify no behaviour change**

```bash
npm run build && npm run test:all && npm run lint
```

Expected: identical pass counts to Step 1 (helpers are unused).

- [ ] **Step 5: Commit**

```bash
git add src/registration.ts
git commit -m "$(cat <<'EOF'
feat: add sticky-viewer + viewer-mode scaffolding (#287)

Env-resolved constants RIJKS_OPENAI_STICKY_VIEWER and RIJKS_VIEWER_MODE,
plus viewerToolMeta() / viewerResultMeta() helpers and an optional _meta
parameter on structuredResponse. No tool wiring yet; behaviour-neutral
with both flags off (the default).

Spec: docs/superpowers/specs/2026-05-03-dual-host-mcp-app-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Mode arg + mode-aware `viewUUID` selection on `get_artwork_image`

Adds `mode: "notebook" | "live"` to `get_artwork_image` input. In `live` mode, the most-recently-accessed `viewUUID` is reused (atomic content swap mirroring `remount_viewer`); in `notebook` mode, a fresh UUID is minted per call.

**Files:**
- Test: `scripts/tests/test-viewer-mode.mjs` (create)
- Modify: `src/registration.ts:1900-1947` (input schema + handler)

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/test-viewer-mode.mjs`:

```js
/**
 * Test suite for get_artwork_image's mode arg + RIJKS_VIEWER_MODE env (#287).
 *
 * Run:  node scripts/tests/test-viewer-mode.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

function section(name) {
  console.log(`\n${"═".repeat(60)}\n  ${name}\n${"═".repeat(60)}`);
}

function parseSc(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

async function spawnClient(env) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: PROJECT_DIR,
    env: { ...process.env, STRUCTURED_CONTENT: "true", ...env },
  });
  const client = new Client({ name: "test-viewer-mode", version: "0.1" });
  await client.connect(transport);
  return { client, transport };
}

// ══════════════════════════════════════════════════════════════════
// 1. Default (env unset, no per-call mode) → notebook → fresh UUIDs
// ══════════════════════════════════════════════════════════════════

section("1. Default (notebook) mints a fresh viewUUID per call");

{
  const { client, transport } = await spawnClient({});
  const a = parseSc(await client.callTool({ name: "get_artwork_image", arguments: { objectNumber: "SK-C-5" } }));
  const b = parseSc(await client.callTool({ name: "get_artwork_image", arguments: { objectNumber: "SK-A-1115" } }));
  assert(typeof a.viewUUID === "string" && a.viewUUID.length === 36, `first call returned a viewUUID`);
  assert(typeof b.viewUUID === "string" && b.viewUUID.length === 36, `second call returned a viewUUID`);
  assert(a.viewUUID !== b.viewUUID, `notebook: distinct viewUUIDs (${a.viewUUID.slice(0,8)} vs ${b.viewUUID.slice(0,8)})`);
  await transport.close();
}

// ══════════════════════════════════════════════════════════════════
// 2. RIJKS_VIEWER_MODE=live → reuses most-recent viewUUID
// ══════════════════════════════════════════════════════════════════

section("2. RIJKS_VIEWER_MODE=live reuses most-recent viewUUID");

{
  const { client, transport } = await spawnClient({ RIJKS_VIEWER_MODE: "live" });
  const a = parseSc(await client.callTool({ name: "get_artwork_image", arguments: { objectNumber: "SK-C-5" } }));
  const b = parseSc(await client.callTool({ name: "get_artwork_image", arguments: { objectNumber: "SK-A-1115" } }));
  assert(a.viewUUID === b.viewUUID, `live: same viewUUID across calls (${a.viewUUID.slice(0,8)})`);
  assert(b.objectNumber === "SK-A-1115", `live: second call's payload reflects new artwork`);
  await transport.close();
}

// ══════════════════════════════════════════════════════════════════
// 3. Per-call mode arg overrides env
// ══════════════════════════════════════════════════════════════════

section("3. Per-call mode arg overrides env");

{
  const { client, transport } = await spawnClient({ RIJKS_VIEWER_MODE: "live" });
  const a = parseSc(await client.callTool({ name: "get_artwork_image", arguments: { objectNumber: "SK-C-5", mode: "notebook" } }));
  const b = parseSc(await client.callTool({ name: "get_artwork_image", arguments: { objectNumber: "SK-A-1115", mode: "notebook" } }));
  assert(a.viewUUID !== b.viewUUID, `mode=notebook overrides env=live (distinct UUIDs)`);
  await transport.close();
}

{
  const { client, transport } = await spawnClient({});
  const a = parseSc(await client.callTool({ name: "get_artwork_image", arguments: { objectNumber: "SK-C-5", mode: "live" } }));
  const b = parseSc(await client.callTool({ name: "get_artwork_image", arguments: { objectNumber: "SK-A-1115", mode: "live" } }));
  assert(a.viewUUID === b.viewUUID, `mode=live overrides env=notebook (same UUID)`);
  await transport.close();
}

// ══════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════

console.log(`\n${"═".repeat(60)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(60)}\n`);
if (failed > 0) { failures.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
process.exit(0);
```

- [ ] **Step 2: Run the test against the current (un-modified) build to confirm it fails**

```bash
npm run build && node scripts/tests/test-viewer-mode.mjs
```

Expected: FAIL — section 2 (`live: same viewUUID across calls`) fails because the current handler always mints a fresh UUID. Section 3's `mode` arg is also rejected because the schema doesn't yet declare it (Zod's `.strict()` rejects unknown keys with -32602).

- [ ] **Step 3: Add `mode` to the input schema**

Edit `src/registration.ts:1912-1916` (the `inputSchema` block on `get_artwork_image`):

```ts
inputSchema: z.object({
  objectNumber: z
    .string()
    .describe("The object number of the artwork (e.g. 'SK-C-5')"),
  mode: z
    .enum(["notebook", "live"])
    .optional()
    .describe(
      "Viewer lifecycle mode. 'notebook' (default) opens a fresh viewer per call so prior viewers stay scrollable as a visual record. " +
      "'live' reuses the most-recent viewer in this session for a single rolling iframe. " +
      "Falls back to RIJKS_VIEWER_MODE env (default 'notebook')."
    ),
}).strict() as z.ZodTypeAny,
```

- [ ] **Step 4: Replace the handler's UUID-mint block with mode-aware selection**

Edit `src/registration.ts:1932-1946` (inside `withLogging("get_artwork_image", async (args) => { ... })`). Replace the block starting at the `viewUUID` mint through the final `return structuredResponse(...)`:

```ts
      const effectiveMode = args.mode ?? VIEWER_MODE;
      let viewUUID: string;
      let reused = false;

      if (effectiveMode === "live") {
        let mostRecent: { uuid: string; lastAccess: number } | null = null;
        for (const [uuid, q] of viewerQueues) {
          if (!mostRecent || q.lastAccess > mostRecent.lastAccess) {
            mostRecent = { uuid, lastAccess: q.lastAccess };
          }
        }
        if (mostRecent) {
          viewUUID = mostRecent.uuid;
          const queue = viewerQueues.get(viewUUID)!;
          // Atomic content swap, same invariants as remount_viewer (registration.ts:2008-2012):
          // do NOT touch lastPolledAt — the iframe is already polling this UUID and
          // will pick up the new artwork's image on its next render cycle.
          queue.objectNumber = payload.data.objectNumber;
          queue.imageWidth = payload.width;
          queue.imageHeight = payload.height;
          queue.activeOverlays = [];
          queue.lastAccess = Date.now();
          reused = true;
        } else {
          viewUUID = randomUUID();
        }
      } else {
        viewUUID = randomUUID();
      }

      if (!reused) {
        viewerQueues.set(viewUUID, {
          commands: [],
          createdAt: Date.now(),
          lastAccess: Date.now(),
          objectNumber: payload.data.objectNumber,
          imageWidth: payload.width,
          imageHeight: payload.height,
          activeOverlays: [],
        });
      }

      const viewerData: InferOutput<typeof ImageInfoOutput> = { ...payload.data, viewUUID };
      const text = `${payload.narrationPrefix} | viewUUID: ${viewUUID}`;
      return structuredResponse(viewerData, text);
```

- [ ] **Step 5: Run the new test + the existing remount-viewer test to verify**

```bash
npm run build && node scripts/tests/test-viewer-mode.mjs && node scripts/tests/test-remount-viewer.mjs
```

Expected: both pass. `test-viewer-mode.mjs` reports 7/0; `test-remount-viewer.mjs` reports 21/0.

- [ ] **Step 6: Commit**

```bash
git add src/registration.ts scripts/tests/test-viewer-mode.mjs
git commit -m "$(cat <<'EOF'
feat: viewer mode arg + mode-aware viewUUID selection (#287)

Adds optional `mode: "notebook" | "live"` arg on get_artwork_image,
falling back to RIJKS_VIEWER_MODE env (default notebook). Live mode
reuses the most-recently-accessed viewUUID and atomically swaps the
queue's content (mirroring remount_viewer's invariants — lastPolledAt
is preserved). New test scripts/tests/test-viewer-mode.mjs verifies
notebook/live behaviour and per-call override across env settings.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Sticky-viewer `_meta` wiring across viewer-touching tools

Adds `_meta.ui.resourceUri` + `openai/outputTemplate` (gated by `RIJKS_OPENAI_STICKY_VIEWER=1`) to `inspect_artwork_image` and `navigate_viewer`; adds the OpenAI alias only to `poll_viewer_commands`. Threads `viewerResultMeta(viewUUID)` into all five tools' result responses.

**Files:**
- Test: `scripts/tests/test-sticky-viewer-meta.mjs` (create)
- Modify: `package.json:23` (wire test into `test:all`)
- Modify: `src/registration.ts:1900-2570` (five tool registrations + handlers)

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/test-sticky-viewer-meta.mjs`:

```js
/**
 * Test suite for RIJKS_OPENAI_STICKY_VIEWER + viewerResultMeta echo (#287).
 *
 * Verifies the four flag/mode combinations:
 *   sticky=0 / sticky=1 × notebook / live
 * across the five viewer-touching tools:
 *   get_artwork_image, inspect_artwork_image, navigate_viewer,
 *   remount_viewer, poll_viewer_commands.
 *
 * Run:  node scripts/tests/test-sticky-viewer-meta.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RESOURCE_URI = "ui://rijksmuseum/artwork-viewer.html";

let passed = 0, failed = 0;
const failures = [];
const assert = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
};
const section = (n) => console.log(`\n${"═".repeat(60)}\n  ${n}\n${"═".repeat(60)}`);
const parseSc = (r) => r.structuredContent ?? JSON.parse(r.content[0].text);

async function spawnClient(env) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: PROJECT_DIR,
    env: { ...process.env, STRUCTURED_CONTENT: "true", ...env },
  });
  const client = new Client({ name: "test-sticky-viewer-meta", version: "0.1" });
  await client.connect(transport);
  return { client, transport };
}

function findTool(toolsList, name) {
  return toolsList.tools.find((t) => t.name === name);
}

// ══════════════════════════════════════════════════════════════════
// 1. Sticky off — registration _meta absent on inspect/navigate;
//    standard ui.resourceUri still present on get/remount/poll.
// ══════════════════════════════════════════════════════════════════

section("1. Sticky off (default): registration _meta is unchanged");

{
  const { client, transport } = await spawnClient({});
  const tools = await client.listTools();

  const inspect = findTool(tools, "inspect_artwork_image");
  const navigate = findTool(tools, "navigate_viewer");
  const get = findTool(tools, "get_artwork_image");
  const poll = findTool(tools, "poll_viewer_commands");
  const remount = findTool(tools, "remount_viewer");

  assert(!inspect?._meta, `inspect_artwork_image has no _meta when sticky=0`);
  assert(!navigate?._meta, `navigate_viewer has no _meta when sticky=0`);
  assert(get?._meta?.ui?.resourceUri === RESOURCE_URI, `get_artwork_image still carries standard ui.resourceUri`);
  assert(poll?._meta?.ui?.resourceUri === RESOURCE_URI, `poll_viewer_commands still carries standard ui.resourceUri`);
  assert(remount?._meta?.ui?.resourceUri === RESOURCE_URI, `remount_viewer still carries standard ui.resourceUri`);
  assert(!get?._meta?.["openai/outputTemplate"], `get_artwork_image has no OpenAI alias when sticky=0`);

  await transport.close();
}

// ══════════════════════════════════════════════════════════════════
// 2. Sticky on — both standard + OpenAI alias on all five tools;
//    inspect/navigate gain _meta.
// ══════════════════════════════════════════════════════════════════

section("2. Sticky on: standard + OpenAI alias appear on all five tools");

{
  const { client, transport } = await spawnClient({ RIJKS_OPENAI_STICKY_VIEWER: "1" });
  const tools = await client.listTools();

  for (const name of ["get_artwork_image", "inspect_artwork_image", "navigate_viewer", "remount_viewer", "poll_viewer_commands"]) {
    const tool = findTool(tools, name);
    assert(tool?._meta?.ui?.resourceUri === RESOURCE_URI, `${name}: _meta.ui.resourceUri set`);
    assert(tool?._meta?.["openai/outputTemplate"] === RESOURCE_URI, `${name}: openai/outputTemplate alias set`);
  }

  // App-only tools preserve visibility:["app"]
  assert(JSON.stringify(findTool(tools, "poll_viewer_commands")?._meta?.ui?.visibility) === '["app"]', `poll_viewer_commands preserves visibility:["app"]`);
  assert(JSON.stringify(findTool(tools, "remount_viewer")?._meta?.ui?.visibility) === '["app"]', `remount_viewer preserves visibility:["app"]`);

  await transport.close();
}

// ══════════════════════════════════════════════════════════════════
// 3. Tool-result _meta — widgetSessionId echoed on every viewer-aware call
// ══════════════════════════════════════════════════════════════════

section("3. Tool-result _meta echoes widgetSessionId");

{
  const { client, transport } = await spawnClient({ RIJKS_OPENAI_STICKY_VIEWER: "1" });

  const r1 = await client.callTool({ name: "get_artwork_image", arguments: { objectNumber: "SK-C-5" } });
  const uuid = parseSc(r1).viewUUID;
  assert(r1._meta?.ui?.widgetSessionId === uuid, `get_artwork_image result echoes widgetSessionId`);
  assert(r1._meta?.ui?.resourceUri === RESOURCE_URI, `get_artwork_image result carries resourceUri when sticky=1`);
  assert(r1._meta?.["openai/widgetSessionId"] === uuid, `get_artwork_image result has OpenAI session alias`);

  const r2 = await client.callTool({ name: "inspect_artwork_image", arguments: { objectNumber: "SK-C-5", region: "pct:0,0,50,50", viewUUID: uuid } });
  assert(r2._meta?.ui?.widgetSessionId === uuid, `inspect_artwork_image result echoes widgetSessionId`);

  const r3 = await client.callTool({ name: "navigate_viewer", arguments: { viewUUID: uuid, commands: [{ action: "navigate", region: "pct:25,25,30,30" }] } });
  assert(r3._meta?.ui?.widgetSessionId === uuid, `navigate_viewer result echoes widgetSessionId`);

  await transport.close();
}

// ══════════════════════════════════════════════════════════════════
// 4. Sticky off: result _meta still emits widgetSessionId (forward-compat)
//    but no resourceUri on the response.
// ══════════════════════════════════════════════════════════════════

section("4. Sticky off: result _meta carries widgetSessionId only");

{
  const { client, transport } = await spawnClient({});
  const r1 = await client.callTool({ name: "get_artwork_image", arguments: { objectNumber: "SK-C-5" } });
  const uuid = parseSc(r1).viewUUID;
  assert(r1._meta?.ui?.widgetSessionId === uuid, `get_artwork_image result echoes widgetSessionId even when sticky=0`);
  assert(!r1._meta?.ui?.resourceUri, `get_artwork_image result has no resourceUri when sticky=0`);
  assert(!r1._meta?.["openai/outputTemplate"], `get_artwork_image result has no OpenAI alias when sticky=0`);
  await transport.close();
}

// ══════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════

console.log(`\n${"═".repeat(60)}\n  Results: ${passed} passed, ${failed} failed\n${"═".repeat(60)}\n`);
if (failed > 0) { failures.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
process.exit(0);
```

- [ ] **Step 2: Run the test against the current (un-wired) build to confirm it fails**

```bash
npm run build && node scripts/tests/test-sticky-viewer-meta.mjs
```

Expected: section 2 fails (no `openai/outputTemplate` anywhere; inspect/navigate have no `_meta`); section 3 fails (no result `_meta`); section 4 fails (no result `_meta`). Section 1 likely passes since `inspect`/`navigate` already lack `_meta`, but section 1's checks for the standard `ui.resourceUri` on `get`/`poll`/`remount` should also pass.

- [ ] **Step 3: Wire `viewerToolMeta()` into `get_artwork_image` registration**

Edit `src/registration.ts:1918-1920`. Replace:

```ts
      _meta: {
        ui: { resourceUri: ARTWORK_VIEWER_RESOURCE_URI },
      },
```

with:

```ts
      _meta: viewerToolMeta() ?? { ui: { resourceUri: ARTWORK_VIEWER_RESOURCE_URI } },
```

(When sticky is on, `viewerToolMeta()` returns the standard URI plus the OpenAI alias. When sticky is off, the fallback preserves today's behaviour.)

Then, inside the handler, change the final return at registration.ts:1944-1945 (the line returning `structuredResponse(viewerData, text)`):

```ts
      return structuredResponse(viewerData, text, viewerResultMeta(viewUUID));
```

- [ ] **Step 4: Wire `viewerToolMeta()` and result-meta echo into `remount_viewer`**

Edit `src/registration.ts:1973-1978`. Replace:

```ts
      _meta: {
        ui: {
          resourceUri: ARTWORK_VIEWER_RESOURCE_URI,
          visibility: ["app"],
        },
      },
```

with:

```ts
      _meta: viewerToolMeta({ appOnly: true }) ?? {
        ui: { resourceUri: ARTWORK_VIEWER_RESOURCE_URI, visibility: ["app"] },
      },
```

Update the handler's final return at registration.ts:2015-2016:

```ts
      const viewerData: InferOutput<typeof ImageInfoOutput> = { ...payload.data, viewUUID: args.viewUUID };
      const text = `Remounted viewer ${args.viewUUID.slice(0, 8)} → ${payload.data.objectNumber}`;
      return structuredResponse(viewerData, text, viewerResultMeta(args.viewUUID));
```

(The earlier error-return at registration.ts:1987-1991 does not get a `viewUUID` echo because no viewer was found.)

- [ ] **Step 5: Wire `viewerToolMeta()` into `inspect_artwork_image` registration**

Edit `src/registration.ts:2022-2024` — inside the `server.registerTool` call's options object, after `...withOutputSchema(InspectImageOutput),` add:

```ts
      _meta: viewerToolMeta(),  // undefined when sticky=0 — registration unchanged
```

This adds the new key inside the options object (which already has `title`, `annotations`, `description`, `inputSchema`, `...withOutputSchema(...)`). When `viewerToolMeta()` returns `undefined`, the SDK treats the absent key as before.

- [ ] **Step 6: Add result-meta echo to `inspect_artwork_image` handler**

Find the success-path return inside `withLogging("inspect_artwork_image", ...)` — there's a `structuredResponse(...)` call that returns the InspectImageOutput. The handler builds `data` and `text`, then calls `structuredResponse(data, text)`. Append `viewerResultMeta(activeViewUUID)` only when `activeViewUUID` is set:

Locate the success return (after the caption is built, around registration.ts:2280-2310 — read the file to verify). Wrap the final return:

```ts
      return structuredResponse(
        data,
        caption,
        activeViewUUID ? viewerResultMeta(activeViewUUID) : undefined,
      );
```

(The error-path returns through `cropError(...)` do not get a result-meta echo because they don't necessarily target a single viewer.)

- [ ] **Step 7: Wire `viewerToolMeta()` into `navigate_viewer` registration**

Edit `src/registration.ts:2392` (the `server.registerTool` options block). After `...withOutputSchema(NavigateViewerOutput),` add:

```ts
      _meta: viewerToolMeta(),
```

- [ ] **Step 8: Add result-meta echo to `navigate_viewer` handler**

Locate the final `structuredResponse(navData, text)` call inside `withLogging("navigate_viewer", ...)` (around registration.ts:2530, read to confirm). Replace with:

```ts
      return structuredResponse(navData, text, viewerResultMeta(args.viewUUID));
```

(`args.viewUUID` is always present on `navigate_viewer` calls — it's required in the input schema.)

- [ ] **Step 9: Wire `viewerToolMeta({ appOnly: true })` into `poll_viewer_commands`**

Edit `src/registration.ts:2554-2559`. Replace:

```ts
      _meta: {
        ui: {
          resourceUri: ARTWORK_VIEWER_RESOURCE_URI,
          visibility: ["app"],
        },
      },
```

with:

```ts
      _meta: viewerToolMeta({ appOnly: true }) ?? {
        ui: { resourceUri: ARTWORK_VIEWER_RESOURCE_URI, visibility: ["app"] },
      },
```

(`poll_viewer_commands` does not get result-meta — its response is not viewer-payload-shaped and the iframe consumes it directly.)

- [ ] **Step 10: Run the new test + existing tests**

```bash
npm run build && node scripts/tests/test-sticky-viewer-meta.mjs && node scripts/tests/test-remount-viewer.mjs && node scripts/tests/test-viewer-mode.mjs && npm run test:all && npm run lint
```

Expected: all pass. `test-sticky-viewer-meta.mjs` should report ~22/0 (5 sticky-off + 12 sticky-on registration + 3 result-echo + 3 sticky-off result + minor variations).

- [ ] **Step 11: Wire the new test into `test:all`**

Edit `package.json:23`. Append the new test to the chain:

```json
    "test:all": "node scripts/tests/test-pure-functions.mjs && node scripts/tests/test-provenance-parser.mjs && node scripts/tests/test-provenance-peg.mjs && node scripts/tests/test-overlay-scoring.mjs && node scripts/tests/test-viewer-mode.mjs && node scripts/tests/test-sticky-viewer-meta.mjs",
```

Run `npm run test:all` to confirm both new tests are picked up and pass.

- [ ] **Step 12: Commit**

```bash
git add src/registration.ts scripts/tests/test-sticky-viewer-meta.mjs package.json
git commit -m "$(cat <<'EOF'
feat: sticky-viewer _meta wiring across viewer-touching tools (#287)

Wires viewerToolMeta()/viewerResultMeta() into the five viewer-touching
tools (get_artwork_image, inspect_artwork_image, navigate_viewer,
remount_viewer, poll_viewer_commands).

When RIJKS_OPENAI_STICKY_VIEWER=1, registration _meta carries both the
standard ui.resourceUri and the OpenAI Apps SDK compat alias
(openai/outputTemplate). All viewer-aware tool results echo
ui.widgetSessionId for ext-apps PR #295 forward-compat (and openai-
namespaced alias). Behaviour-neutral when both flags default to off.

New test scripts/tests/test-sticky-viewer-meta.mjs validates the matrix.
Wired into test:all.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `host-bridge.ts` seam stub

Single seam between the viewer and whichever host bridge is active. Today returns ext-apps `App` directly; future Subtask-4 contingency port (Apps SDK adapter) injects through this single point without touching the rest of the viewer.

**Files:**
- Create: `apps/artwork-viewer/src/host-bridge.ts`
- Modify: `apps/artwork-viewer/src/viewer.ts:15-73` (imports + `new App` call)

- [ ] **Step 1: Create `host-bridge.ts`**

Write `apps/artwork-viewer/src/host-bridge.ts`:

```ts
/**
 * Single seam between the viewer and whichever host bridge is active.
 *
 * Today: returns the ext-apps `App` directly. If empirical smoke tests
 * (offline/runbooks/openai-host-smoke-test.md) show OpenAI hosts can't
 * speak the standard MCP Apps `ui/*` JSON-RPC bridge despite current
 * docs, this is the one place an `@mcp-ui/server@5.16.3`-style adapter
 * would be injected. See issue #287 Subtask 4 for the contingency plan.
 */
import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';

export interface HostBridgeConfig {
  appInfo: ConstructorParameters<typeof App>[0];
  capabilities: ConstructorParameters<typeof App>[1];
  options: ConstructorParameters<typeof App>[2];
}

export function createHostBridge(cfg: HostBridgeConfig): App {
  // Per current OpenAI docs (developers.openai.com/apps-sdk/mcp-apps-in-chatgpt),
  // ChatGPT implements the standard MCP Apps `ui/*` bridge, so ext-apps' App
  // is sufficient on every host. Subtask 4 is the contingency port if smoke
  // tests prove that's wrong on a target host.
  return new App(cfg.appInfo, cfg.capabilities, cfg.options);
}
```

- [ ] **Step 2: Replace `new App(...)` in viewer.ts with `createHostBridge`**

Edit `apps/artwork-viewer/src/viewer.ts:15-21`. The current import:

```ts
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from '@modelcontextprotocol/ext-apps/app-with-deps';
```

Drop the `App` symbol from this import (still used for the type below) and add the bridge import. Replace lines 15-21 with:

```ts
import {
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from '@modelcontextprotocol/ext-apps/app-with-deps';

import { createHostBridge } from './host-bridge.js';
```

Then replace lines 69-73 (the `new App(...)` call):

```ts
const app = createHostBridge({
  appInfo: { name: 'Rijksmuseum Artwork Viewer', version: '1.0.0' },
  capabilities: { tools: { listChanged: false }, availableDisplayModes: ['inline', 'fullscreen'] },
  options: { autoResize: true },
});
```

- [ ] **Step 3: Build and verify the viewer compiles + bundles**

```bash
npm run build && npm run test:viewer-build
```

Expected: build succeeds, viewer-build test passes (bundled assets in `dist/`).

- [ ] **Step 4: Commit**

```bash
git add apps/artwork-viewer/src/host-bridge.ts apps/artwork-viewer/src/viewer.ts
git commit -m "$(cat <<'EOF'
refactor: host-bridge seam for future Apps SDK adapter port (#287)

Replaces the bare `new App(...)` in viewer.ts with createHostBridge()
indirection. Today the seam returns ext-apps App directly — zero
behaviour change. If empirical smoke tests show OpenAI hosts need an
Apps SDK adapter despite current docs (#287 Subtask 4 contingency),
the adapter injects through this single point instead of refactoring
the viewer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Tag `updateModelContext` payloads with `viewUUID`

Tags both `app.updateModelContext` call sites with the active viewUUID — text-line in the content (cheap-and-portable, works on every host today) and `_meta.ui.widgetSessionId` (spec-aligned hook for ext-apps#558 instance-scoped routing).

**Files:**
- Modify: `apps/artwork-viewer/src/viewer.ts:514-518` (highlight flow)
- Modify: `apps/artwork-viewer/src/viewer.ts:777-789` (mount-time updateModelContext)

- [ ] **Step 1: Update the mount-time `updateModelContext`**

Edit `apps/artwork-viewer/src/viewer.ts:777-789`. Replace the entire `updateModelContext` function:

```ts
function updateModelContext(data: ArtworkImageData): void {
  const lines = [
    `Viewing artwork: ${data.title}`,
    `Creator: ${data.creator}`,
    `Date: ${data.date}`,
    `Object number: ${data.objectNumber}`,
    `Image size: ${data.width}x${data.height}`,
  ];
  if (data.viewUUID) lines.push(`Viewer session: ${data.viewUUID.slice(0, 8)}`);

  app.updateModelContext({
    content: [{ type: 'text', text: lines.join('. ') }],
    _meta: data.viewUUID ? { ui: { widgetSessionId: data.viewUUID } } : undefined,
  } as Parameters<typeof app.updateModelContext>[0]);
}
```

(The `as Parameters<...>` cast is in case the ext-apps `UpdateModelContextParams` type does not yet declare `_meta` — Anthropic hosts ignore unknown keys per spec, but TypeScript may not. Verify by reading `node_modules/@modelcontextprotocol/ext-apps/dist/...` — drop the cast if `_meta` is already in the type.)

- [ ] **Step 2: Update the highlight-flow `updateModelContext`**

Edit `apps/artwork-viewer/src/viewer.ts:514-517`. The current call shape (read the file at that line range to confirm exact text — the surrounding code resembles):

```ts
    app.updateModelContext({
      content: [{ type: 'text', text: `Highlighted region added: ${region}` }],
    });
```

Replace with:

```ts
    app.updateModelContext({
      content: [{ type: 'text', text: `Highlighted region added: ${region}${currentData?.viewUUID ? ` (viewer ${currentData.viewUUID.slice(0, 8)})` : ''}` }],
      _meta: currentData?.viewUUID ? { ui: { widgetSessionId: currentData.viewUUID } } : undefined,
    } as Parameters<typeof app.updateModelContext>[0]);
```

- [ ] **Step 3: Build and verify**

```bash
npm run build && npm run test:viewer-build && npm run test:all
```

Expected: build succeeds, test:viewer-build passes, test:all passes (139+31+7+22+others).

- [ ] **Step 4: Smoke-check via dev-host harness (optional, recommended)**

```bash
npm run dev:viewer
# Open http://localhost:5173/dev-host.html in a browser, mount SK-C-5,
# observe console: should see updateModelContext calls with the new
# "Viewer session: <uuid8>" line in the text payload.
```

This is a sanity check, not a test gate. Skip if the time cost outweighs the value.

- [ ] **Step 5: Commit**

```bash
git add apps/artwork-viewer/src/viewer.ts
git commit -m "$(cat <<'EOF'
feat: tag updateModelContext payloads with viewUUID (#287, #558)

Both updateModelContext call sites in the viewer now carry the active
viewUUID — as a text line ("Viewer session: <uuid8>") for cheap-and-
portable disambiguation on every host today, and as
_meta.ui.widgetSessionId for forward-compat with ext-apps#558's
instance-scoped routing direction.

Empirical evidence to cite when commenting on ext-apps#558.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `--four-call-trace` mode for `cdp-observe-viewer.mjs`

Adds a structured-event-trace mode to the existing CDP observer so the four-call sequence from `offline/feedback/codex-viewer-disappearance-2026-04-25.md` can be captured deterministically for claude.ai and Claude Desktop. ChatGPT, Codex, and Goose remain manual (no stable CDP attach).

**Files:**
- Modify: `scripts/tests/cdp-observe-viewer.mjs`

- [ ] **Step 1: Add CLI flag parsing and trace-output destination**

Edit `scripts/tests/cdp-observe-viewer.mjs`. After the existing `const TARGET_URL_PREFIX = ...;` line near the top (around line 32), add:

```js
const FOUR_CALL_TRACE = process.argv.includes('--four-call-trace');
const TRACE_OUT = (() => {
  if (!FOUR_CALL_TRACE) return null;
  const flagIdx = process.argv.indexOf('--out');
  if (flagIdx >= 0 && process.argv[flagIdx + 1]) return process.argv[flagIdx + 1];
  const hostHint = process.env.HOST_HINT || 'unknown';
  const date = new Date().toISOString().slice(0, 10);
  return `offline/feedback/openai-host-smoke-test-${date}-${hostHint}.jsonl`;
})();
```

- [ ] **Step 2: Add an event-emitting helper that writes to the trace file**

Add immediately after the helper definitions (around the `tag()` function at line 48-50):

```js
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const traceWrite = (() => {
  if (!TRACE_OUT) return () => {};
  mkdirSync(dirname(TRACE_OUT), { recursive: true });
  console.log(`${ts()} ${tag('trace', COLOR.magenta)} writing JSONL trace to ${TRACE_OUT}`);
  return (event) => {
    const line = JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n';
    appendFileSync(TRACE_OUT, line);
  };
})();
```

- [ ] **Step 3: Tap into existing event sources to also emit trace events**

Within the existing console-tail handlers (the ones that currently call `console.log` for viewer-iframe console mirrors and `ontoolresult` events — read `cdp-observe-viewer.mjs` lines ~60-200 to locate the exact sites), add a `traceWrite(...)` call alongside the existing log emit.

For example, where the script currently does:

```js
console.log(`${ts()} ${tag('viewer', COLOR.cyan)} ${msg.text()}`);
```

Add immediately after:

```js
traceWrite({ source: 'viewer-console', level: msg.type(), text: msg.text() });
```

Apply the same pattern to:
- host-frame console (`source: 'host-console'`)
- `ontoolresult` events (`source: 'ontoolresult'`, include the parsed result shape)
- toolbar button state flips (`source: 'toolbar-state'`)
- `viewerRelatedIndex` / `seedObjectNumber` reads (`source: 'viewer-state'`)

Each `traceWrite` call is one line — does not change console output.

- [ ] **Step 4: Document the new mode in the script header**

Edit the comment block at the top of `cdp-observe-viewer.mjs`. After the `Usage:` block, add:

```js
 *   To capture a JSONL trace for the #287 four-call smoke-test sequence:
 *     HOST_HINT=claude-desktop node scripts/tests/cdp-observe-viewer.mjs \
 *       --four-call-trace [--out path/to/trace.jsonl]
 *   Default trace path: offline/feedback/openai-host-smoke-test-<date>-<host>.jsonl
```

- [ ] **Step 5: Smoke-run the new mode locally**

```bash
# Terminal 1: launch Chrome with remote debugging
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-cdp-rijks \
  http://localhost:5173/dev-host.html &

# Terminal 2:
npm run dev:viewer

# Terminal 3:
HOST_HINT=local-dev node scripts/tests/cdp-observe-viewer.mjs --four-call-trace --out /tmp/test-trace.jsonl
```

In the dev-host browser, mount SK-C-5 and exercise once. Then:

```bash
head -5 /tmp/test-trace.jsonl
wc -l /tmp/test-trace.jsonl
```

Expected: each line is a parseable JSON object with `t`, `source`, and content keys. At least 5 lines for a single mount.

- [ ] **Step 6: Commit**

```bash
git add scripts/tests/cdp-observe-viewer.mjs
git commit -m "$(cat <<'EOF'
feat: --four-call-trace mode for cdp-observe-viewer (#287)

Adds a JSONL trace mode to the existing read-only CDP observer so the
four-call smoke-test sequence (#287) can be captured deterministically
for claude.ai and Claude Desktop. Default trace path:
offline/feedback/openai-host-smoke-test-<date>-<HOST_HINT>.jsonl.

ChatGPT, Codex, and Goose remain manual — no stable CDP attach.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Smoke-test runbook (offline submodule)

Manual cross-host runbook plus a dated results-report template. Lives in the `offline/` submodule; commit happens inside the submodule, then the parent repo bumps the submodule pointer.

**Files:**
- Create: `offline/runbooks/openai-host-smoke-test.md` (in submodule)

- [ ] **Step 1: Verify the submodule is on its own working branch**

```bash
cd /Users/abosse/Documents/GitHub/rijksmuseum-mcp-plus/offline
git status
git log --oneline -5
```

Expected: a clean working tree on the submodule's tracked branch (per CLAUDE.md, submodule pointer is at `d5dbad7` — verify via `git -C .. submodule status`).

- [ ] **Step 2: Author the runbook**

Create `offline/runbooks/openai-host-smoke-test.md` (note: `mkdir -p offline/runbooks` first if the directory doesn't exist):

```markdown
# OpenAI Host Smoke Test (#287)

**Purpose.** Empirically test the lifecycle hypothesis behind issue #287: does adding `_meta.ui.resourceUri` + `openai/outputTemplate` to `inspect_artwork_image` / `navigate_viewer` (gated by `RIJKS_OPENAI_STICKY_VIEWER=1`) keep the iframe mounted in OpenAI hosts (Codex, ChatGPT, Goose) without regressing the lab-notebook history workflow in claude.ai / Claude Desktop?

**Spec:** `docs/superpowers/specs/2026-05-03-dual-host-mcp-app-design.md`
**Plan:** `docs/superpowers/plans/2026-05-03-dual-host-mcp-app.md`

## Setup

- Rebuild and confirm tests pass: `npm run build && npm run test:all`.
- Run the server locally for stdio hosts (Claude Desktop, Codex via npx-wrapper, Goose):
  ```bash
  RIJKS_OPENAI_STICKY_VIEWER=0 node dist/index.js   # baseline
  RIJKS_OPENAI_STICKY_VIEWER=1 node dist/index.js   # experimental
  ```
- For HTTP hosts (claude.ai, ChatGPT), deploy a preview instance to Railway with the appropriate env var. Note the `PUBLIC_URL` for the connector.
- For Goose: install via `brew install goose` (or follow https://block.github.io/goose/docs/quickstart) and add the local server as an extension.

## Four-call sequence

Per host, in a fresh conversation, ask the host LLM to:

1. Open SK-C-5: "Show me Rembrandt's Night Watch (SK-C-5)."
2. Inspect a region: "Inspect the bottom-left quarter (`region: pct:0,0,50,50`)."
3. Add an overlay: "Add an overlay around the central figure (`region: pct:25,25,30,30`)."
4. Inspect with overlays: "Inspect the central figure region with overlays visible (`region: pct:25,25,30,30, show_overlays: true`)."

For Claude Desktop and claude.ai, run `cdp-observe-viewer.mjs --four-call-trace` in parallel to capture the JSONL trace:

```bash
HOST_HINT=claude-desktop node scripts/tests/cdp-observe-viewer.mjs --four-call-trace
```

For ChatGPT, Codex, and Goose: take screenshots after each call.

## Per-host observation table (copy this template into the dated report)

| Step | Iframe state (mounted/torn-down/replaced) | Tool result `_meta` echoed back? | `widgetSessionId` visible to model in narration? | `updateModelContext` reached model? |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |

## Five-host matrix

Run the four-call sequence three times per host (plus an `RIJKS_VIEWER_MODE=live` per-call variant on the first call):

| Host | sticky=0 (today) | sticky=1, notebook | sticky=1, live |
|---|---|---|---|
| Codex | baseline (iframe disappears, per existing trace) | does it stay mounted? | does single-iframe replace cleanly? |
| ChatGPT | baseline (state-sync silent) | does `updateModelContext` reach model? | replace + state-sync? |
| Goose | baseline | history preserved per `widgetSessionId`? does #558 last-write-wins manifest? | single iframe replaces? |
| claude.ai | history preserved (today) | history preserved or collapsed? | rolling viewer works? |
| Claude Desktop | history preserved (today) | history preserved or collapsed? | rolling viewer works? |

## Decision rule (locks the flag default)

After the matrix is populated:

- **Both Anthropic hosts preserve history with sticky=1, notebook *and* OpenAI hosts keep iframe mounted** → ship `RIJKS_OPENAI_STICKY_VIEWER=1` as default-on; drop the flag entirely in v0.28.
- **Anthropic hosts collapse history with sticky=1, notebook** → leave sticky as opt-in default-off; document the trade-off. File a follow-up on ext-apps#558 with the empirical evidence.
- **OpenAI hosts still tear down with sticky=1** → standard-bridge hypothesis is wrong despite the docs; activate Subtask 4 (port the v5.16.3 adapter through the `host-bridge.ts` seam). File issue with OpenAI Apps SDK with the trace.
- **Goose collapses last-write-wins on `updateModelContext`** → confirms #558's concern; comment on #558 with the artwork-exploration trace as empirical input. (Independent of the flag-default decision.)

## Results

Save dated reports to `offline/feedback/openai-host-smoke-test-<date>.md`. The JSONL traces from the CDP observer go to `offline/feedback/openai-host-smoke-test-<date>-<host>.jsonl`.
```

- [ ] **Step 3: Commit inside the submodule**

```bash
cd /Users/abosse/Documents/GitHub/rijksmuseum-mcp-plus/offline
git add runbooks/openai-host-smoke-test.md
git commit -m "$(cat <<'EOF'
runbooks: openai host smoke test (#287)

Five-host (Codex, ChatGPT, Goose, claude.ai, Claude Desktop) manual
runbook + decision rule. Pairs with cdp-observe-viewer.mjs
--four-call-trace for the two CDP-attachable hosts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Update the submodule pointer in the parent repo**

```bash
cd /Users/abosse/Documents/GitHub/rijksmuseum-mcp-plus
git add offline
git commit -m "$(cat <<'EOF'
chore(offline): pin to runbook for #287 smoke test

Bumps the offline submodule pointer to include the openai-host smoke
test runbook (offline/runbooks/openai-host-smoke-test.md).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Final verification — full test suite + lint + clean status**

```bash
npm run build && npm run test:all && npm run test:viewer-build && npm run lint
git status
```

Expected: all green; `git status` shows a clean tree (or only the expected `offline/` modifications you've already committed).

---

## Acceptance criteria

- `npm run test:all` passes (existing + `test-viewer-mode.mjs` + `test-sticky-viewer-meta.mjs`).
- `npm run test:viewer-build` passes.
- `npm run lint` clean.
- With `RIJKS_OPENAI_STICKY_VIEWER=0` and `RIJKS_VIEWER_MODE` unset, behaviour is byte-identical to today's main on all five viewer-touching tools.
- With `RIJKS_OPENAI_STICKY_VIEWER=1`, all five tools advertise `_meta.ui.resourceUri` + `openai/outputTemplate`; `inspect_artwork_image` / `navigate_viewer` registration `_meta` is no longer absent. Tool results carry `_meta.ui.widgetSessionId` matching the targeted `viewUUID`.
- With `RIJKS_VIEWER_MODE=live` (or per-call `mode: "live"`), consecutive `get_artwork_image` calls reuse the most-recently-accessed `viewUUID`; queue content swaps atomically; `lastPolledAt` is preserved.
- `apps/artwork-viewer/src/host-bridge.ts` exists; `viewer.ts` is the only file that imports `createHostBridge`.
- `apps/artwork-viewer/src/viewer.ts` `updateModelContext` payloads include `Viewer session: <uuid8>` in the text content and `_meta.ui.widgetSessionId` when a `viewUUID` is known.
- `scripts/tests/cdp-observe-viewer.mjs --four-call-trace` writes a JSONL trace to `offline/feedback/openai-host-smoke-test-<date>-<HOST_HINT>.jsonl`.
- `offline/runbooks/openai-host-smoke-test.md` exists in the submodule and is reachable via the submodule pointer.

## Out of scope (do **not** do in this plan)

- Run the actual five-host smoke test (manual; happens after this plan ships).
- Implement the Apps SDK adapter inside `host-bridge.ts` (only the seam lands; the adapter is a follow-up only if smoke tests force it).
- Add `'pip'` to `availableDisplayModes` (deferred per spec).
- Remove the deprecated `viewerConnected` field (v0.28 cleanup).
- Push to `origin/main` (per CLAUDE.md, every push needs explicit go-ahead — these commits stay local until the user says push).
- Comment on ext-apps#558 (a follow-up after the smoke test produces empirical evidence to cite).
