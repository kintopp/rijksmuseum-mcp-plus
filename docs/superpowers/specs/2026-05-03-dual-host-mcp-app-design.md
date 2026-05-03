# Dual-host MCP App design (Anthropic ext-apps + OpenAI Apps SDK)

**Status:** Draft (brainstormed 2026-05-03). Tracks issue [#287](https://github.com/kintopp/rijksmuseum-mcp-plus-offline/issues/287) and the [#60](https://github.com/kintopp/rijksmuseum-mcp-plus-offline/issues/60) lookahead.

**Goal.** Make the artwork viewer (`apps/artwork-viewer/`) work in OpenAI hosts (ChatGPT, Codex, and Goose) without regressing claude.ai or Claude Desktop, while staying forward-compatible with three pending ext-apps drafts: PR [#295](https://github.com/modelcontextprotocol/ext-apps/pull/295) (`widgetSessionId`), issue [#558](https://github.com/modelcontextprotocol/ext-apps/issues/558) (multi-instance `updateModelContext` scoping), and the `pip` display mode (deferred — no host implements it).

**What's already shipped (out of scope of this spec).**
- Subtask 1 of #287 — tolerant `app.ontoolresult` (commit `cb2f112`, viewer.ts:91-121).
- Subtask 2 of #287 — `deliveryState` / `recentlyPolledByViewer` / `pendingCommandCount` / `lastPolledAt` replacing the misleading `viewerConnected` boolean (commit `4e8a496`, registration.ts:2313-2337, 2508-2522).
- Standard `_meta.ui.resourceUri` already on `get_artwork_image` (registration.ts:1919), `remount_viewer` (1975), and `poll_viewer_commands` (2556).

This spec covers Subtask 3 (gated metadata + cross-host smoke test) plus a forward-compatibility design that lets the same code base satisfy ext-apps today, the #295/#558 drafts when they merge, and OpenAI's Apps SDK now.

## Architecture

Two orthogonal opt-ins layered onto the existing viewer:

1. **`RIJKS_OPENAI_STICKY_VIEWER=1`** — adds `_meta.ui.resourceUri` (MCP Apps standard) plus `_meta["openai/outputTemplate"]` (OpenAI compat alias) to `inspect_artwork_image` and `navigate_viewer`; adds the OpenAI alias only to `poll_viewer_commands` (which already carries the standard key with `visibility: ["app"]`). Tells hosts that the tool result belongs to the artwork-viewer iframe so OpenAI hosts keep the iframe mounted across calls. No-op default off.
2. **`RIJKS_VIEWER_MODE=notebook|live`** (default `notebook`) plus per-call `mode` arg on `get_artwork_image` — controls `widgetSessionId` minting. Notebook mints fresh per call (each `get_artwork_image` becomes its own iframe; preserves the lab-notebook history that the Anthropic-host workflow depends on). Live reuses the most-recently-accessed `viewUUID` for the MCP session (single rolling viewer; matches what OpenAI hosts naturally expect from an Apps SDK widget).

The `widgetSessionId` field name is from PR ext-apps#295 (unmerged). Anthropic hosts ignore unknown `_meta` keys today, so landing the field now is forward-compatible at zero cost; when #295 merges, the viewer is already wired.

### Flag interaction matrix

| Sticky off | Sticky on |
|---|---|
| **Notebook** (default): today's behaviour. Each `get_artwork_image` opens a fresh iframe; `inspect`/`navigate` carry no resource URI; OpenAI hosts tear down between calls (the bug). | **Notebook + sticky** (the threaded-needle cell): each `get_artwork_image` mints a fresh `widgetSessionId` so Anthropic hosts preserve history; `_meta.ui.resourceUri` on follow-up tools so OpenAI hosts keep the iframe mounted. |
| **Live**: single rolling viewer via reused `viewUUID`/`widgetSessionId`; later `get_artwork_image` calls replace the previous iframe in Anthropic hosts (when #295 lands). | **Live + sticky**: single rolling viewer plus sticky URI. The "OpenAI-native" mode. |

## Server-side changes (`src/registration.ts`)

### New constants and helpers (near `ARTWORK_VIEWER_RESOURCE_URI`, line 29)

```ts
const STICKY_VIEWER = process.env.RIJKS_OPENAI_STICKY_VIEWER === "1";
const VIEWER_MODE: "notebook" | "live" =
  process.env.RIJKS_VIEWER_MODE === "live" ? "live" : "notebook";

// Build registration-time _meta for a viewer-aware tool, gated by STICKY_VIEWER.
function viewerToolMeta(opts: { appOnly?: boolean } = {}): Record<string, unknown> | undefined {
  if (!STICKY_VIEWER) return undefined;
  const meta: Record<string, unknown> = {
    ui: { resourceUri: ARTWORK_VIEWER_RESOURCE_URI },
    "openai/outputTemplate": ARTWORK_VIEWER_RESOURCE_URI,
  };
  if (opts.appOnly) (meta.ui as Record<string, unknown>).visibility = ["app"];
  return meta;
}

// Per-result _meta — echoes the targeted viewUUID as widgetSessionId so the
// host knows which iframe instance this output belongs to. Always emits the
// session echo; resourceUri is gated by STICKY_VIEWER.
function viewerResultMeta(viewUUID: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    ui: { widgetSessionId: viewUUID },
    "openai/widgetSessionId": viewUUID,
  };
  if (STICKY_VIEWER) {
    (meta.ui as Record<string, unknown>).resourceUri = ARTWORK_VIEWER_RESOURCE_URI;
    meta["openai/outputTemplate"] = ARTWORK_VIEWER_RESOURCE_URI;
  }
  return meta;
}
```

### Per-tool wiring

| Tool | Registration `_meta` | Result `_meta` | Notes |
|---|---|---|---|
| `get_artwork_image` (1900) | already has standard `ui.resourceUri`; merge in `viewerToolMeta()` for the OpenAI alias when sticky | merge in `viewerResultMeta(viewUUID)` post-mint | gains `mode` arg + mode-aware `viewUUID` selection (see below) |
| `inspect_artwork_image` (2022) | `_meta: viewerToolMeta()` (new) | merge in `viewerResultMeta(activeViewUUID)` when an active viewer was found (~line 2255-2272) | model-visible |
| `navigate_viewer` (2341) | `_meta: viewerToolMeta()` (new) | merge in `viewerResultMeta(args.viewUUID)` | model-visible |
| `remount_viewer` (1958) | already complete | merge in `viewerResultMeta(args.viewUUID)` | `visibility: ["app"]` preserved |
| `poll_viewer_commands` (2544) | already has standard key; merge in OpenAI alias via `viewerToolMeta({ appOnly: true })` | none (no model-visible payload) | `visibility: ["app"]` preserved |

### Mode-aware `viewUUID` selection in `get_artwork_image`

Replace the unconditional `randomUUID()` at registration.ts:1932 with:

```ts
inputSchema: z.object({
  objectNumber: z.string().describe("..."),
  mode: z.enum(["notebook", "live"]).optional()
    .describe(
      "Viewer lifecycle mode. 'notebook' (default) opens a fresh viewer per call so prior viewers stay scrollable as a visual record. " +
      "'live' reuses the most-recent viewer in this session for a single rolling iframe. " +
      "Falls back to RIJKS_VIEWER_MODE env (default 'notebook')."
    ),
}).strict() as z.ZodTypeAny,

// In handler:
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
```

`live` mode reuse mirrors `remount_viewer`'s atomic swap; the viewer's existing `applyMountedArtwork(data, { isSeed: true })` path (viewer.ts:108) already handles content swaps correctly, so no viewer-side change is needed for the reuse path beyond payload tagging.

## Viewer-side changes (`apps/artwork-viewer/`)

### `updateModelContext` payload tagging (viewer.ts:777-789 and viewer.ts:514)

Tag every `updateModelContext` write with `viewUUID` so the model can disambiguate notebook viewers and so we have empirical evidence for ext-apps#558:

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
  });
}
```

The text-line addition is the cheap-and-portable fallback (works today on every host that routes `updateModelContext` at all — costs a few model tokens). The `_meta.ui.widgetSessionId` is the spec-aligned hook so that if any host implements instance-scoped routing per #558, our payload self-identifies. The second `updateModelContext` call at viewer.ts:514 (highlight flow) gets the same treatment with the active `viewUUID`.

### Bridge seam stub (`apps/artwork-viewer/src/host-bridge.ts`)

Replace the bare `new App(...)` at viewer.ts:69-73 with a single indirection so a future Subtask-4 adapter port has a clean injection point:

```ts
// apps/artwork-viewer/src/host-bridge.ts
import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';

export interface HostBridgeConfig {
  appInfo: ConstructorParameters<typeof App>[0];
  capabilities: ConstructorParameters<typeof App>[1];
  options: ConstructorParameters<typeof App>[2];
}

export function createHostBridge(cfg: HostBridgeConfig): App {
  return new App(cfg.appInfo, cfg.capabilities, cfg.options);
}
```

```ts
// viewer.ts (replaces lines 69-73):
import { createHostBridge } from './host-bridge.js';

const app = createHostBridge({
  appInfo: { name: 'Rijksmuseum Artwork Viewer', version: '1.0.0' },
  capabilities: { tools: { listChanged: false }, availableDisplayModes: ['inline', 'fullscreen'] },
  options: { autoResize: true },
});
```

Zero behaviour change today. The seam is what makes Subtask 4 a one-file port instead of a viewer-wide refactor if smoke-test results force it.

## Testing

### New test (`scripts/tests/test-sticky-viewer-meta.mjs`)

Validates `_meta` shape across all four flag/mode combinations using the existing stdio MCP-Client pattern from `test-inspect-navigate.mjs`. Asserts:

- Sticky off: registration `_meta` is absent on `inspect_artwork_image` / `navigate_viewer`; result `_meta.ui.widgetSessionId` is still echoed when a `viewUUID` is targeted.
- Sticky on, notebook: each `get_artwork_image` returns a distinct `viewUUID`; registration `_meta` carries both standard and OpenAI-alias keys on the model-visible viewer tools; result `_meta.ui.resourceUri` is present.
- Sticky on, live: consecutive `get_artwork_image` calls return the same `viewUUID` (most-recent reuse); queue content swaps atomically; `lastPolledAt` is not reset on reuse.
- `mode` per-call arg overrides `RIJKS_VIEWER_MODE` env in both directions.

### Existing tests must pass unchanged

`test-pure-functions.mjs`, `test-tool-descriptions.mjs`, `test-remount-viewer.mjs`, `test-inspect-navigate.mjs`, `test-viewer-build`. With both flags off/default, behaviour is identical to today's main.

## Smoke-test runbook (`offline/runbooks/openai-host-smoke-test.md`)

Drives the four-call sequence from `offline/feedback/codex-viewer-disappearance-2026-04-25.md`:

1. `get_artwork_image SK-A-1115` (default + `mode:"live"` variant)
2. `inspect_artwork_image SK-A-1115 region:pct:0,0,50,50`
3. `navigate_viewer SK-A-1115 add_overlay pct:25,25,30,30`
4. `inspect_artwork_image SK-A-1115 region:pct:25,25,30,30 show_overlays:true`

Per-host observations to record (markdown table per host):

| Step | Iframe state (mounted/torn-down/replaced) | Tool result `_meta` echoed back? | `widgetSessionId` visible to model in narration? | `updateModelContext` reached model? |

Five-host matrix — `RIJKS_OPENAI_STICKY_VIEWER` × `RIJKS_VIEWER_MODE` × per-call `mode`:

| Host | sticky=0 (today) | sticky=1, notebook | sticky=1, live |
|---|---|---|---|
| Codex | baseline (iframe disappears) | does it stay mounted? | does single-iframe replace cleanly? |
| ChatGPT | baseline (state-sync silent) | does `updateModelContext` reach model? | replace + state-sync? |
| Goose | baseline | history preserved per `widgetSessionId`? does #558 last-write-wins manifest? | single iframe replaces? |
| claude.ai | history preserved (today) | history preserved or collapsed? | rolling viewer works? |
| Claude Desktop | history preserved (today) | history preserved or collapsed? | rolling viewer works? |

**Tooling.** Manual checklist driven in each host. For claude.ai and Claude Desktop, extend `scripts/tests/cdp-observe-viewer.mjs` with a `--four-call-trace` mode that dumps timestamped console + `ontoolresult` events to `offline/feedback/openai-host-smoke-test-<date>-<host>.jsonl`. ChatGPT, Codex, and Goose stay manual (no stable CDP attach surface). Results land in a single dated report `offline/feedback/openai-host-smoke-test-<date>.md`.

## Decision rule (locks the flag default after smoke-test)

After the matrix is populated:

- **Both Anthropic hosts preserve history with sticky=1, notebook *and* OpenAI hosts keep iframe mounted** → ship `RIJKS_OPENAI_STICKY_VIEWER=1` as default-on; drop the flag entirely in v0.28.
- **Anthropic hosts collapse history with sticky=1, notebook** → leave sticky as opt-in default-off; ship the runbook + this design doc as the user-facing toggle. File a follow-up on ext-apps#558 with the empirical evidence.
- **OpenAI hosts still tear down with sticky=1** → standard-bridge hypothesis is wrong despite the docs; activate Subtask 4 (port the v5.16.3 adapter through the `host-bridge.ts` seam). File issue with OpenAI Apps SDK with the trace.
- **Goose collapses last-write-wins on `updateModelContext`** → confirms #558's concern; comment on #558 with the artwork-exploration trace as empirical input. (Independent of the flag-default decision.)

## Acceptance criteria

- Server: `RIJKS_OPENAI_STICKY_VIEWER` and `RIJKS_VIEWER_MODE` env handling plus per-call `mode` arg on `get_artwork_image`. With both flags off/default, `npm test:all` is unchanged. With sticky=1, `_meta.ui.resourceUri` plus `openai/outputTemplate` appear on `inspect_artwork_image` / `navigate_viewer` registration *and* in tool-result `_meta`. Result `_meta` always carries `ui.widgetSessionId` matching the targeted `viewUUID`.
- Live-mode reuse: consecutive `get_artwork_image` calls with `mode:"live"` mutate the existing queue atomically; `viewUUID` is reused; `remount_viewer`'s no-`lastPolledAt`-touch invariant is preserved.
- Viewer: `updateModelContext` payload includes `Viewer session: <uuid8>` line and `_meta.ui.widgetSessionId`. `host-bridge.ts` is the only `new App(...)` site in the viewer.
- Tests: new `scripts/tests/test-sticky-viewer-meta.mjs` validates `_meta` shape across all four flag/mode combinations. Existing tests pass unchanged.
- Runbook: `offline/runbooks/openai-host-smoke-test.md` exists; `cdp-observe-viewer.mjs --four-call-trace` mode is implemented; one dated results report exists in `offline/feedback/`.
- Public engagement: comment posted on ext-apps#558 with the artwork-exploration framing and the `viewUUID`-tagged `updateModelContext` payload as evidence.

## Out of scope

- Subtask 4 adapter implementation — only the seam lands. Adapter port is a follow-up issue, only if smoke tests force it.
- PiP support — deferred per design discussion. `availableDisplayModes` stays `['inline', 'fullscreen']`.
- `text/html+skybridge` MIME — per current OpenAI docs, `text/html;profile=mcp-app` is the recommended primary type.
- Removing the deprecated `viewerConnected` field — already deprecated; v0.28 cleanup.
- Stage 5.5 v0.26 geocoding pipeline and other unrelated v0.27-RC threads.

## References

- Issue [#287](https://github.com/kintopp/rijksmuseum-mcp-plus-offline/issues/287) — viewer OpenAI host compatibility (this spec covers Subtask 3 + #60 lookahead).
- Issue [#60](https://github.com/kintopp/rijksmuseum-mcp-plus-offline/issues/60) — ext-apps drafts for scrolling-out-of-view.
- ext-apps [PR #295](https://github.com/modelcontextprotocol/ext-apps/pull/295) — `widgetSessionId`.
- ext-apps [issue #558](https://github.com/modelcontextprotocol/ext-apps/issues/558) — multi-instance `updateModelContext` scoping.
- ext-apps [issue #412](https://github.com/modelcontextprotocol/ext-apps/issues/412), [#430](https://github.com/modelcontextprotocol/ext-apps/issues/430), [#41](https://github.com/modelcontextprotocol/ext-apps/issues/41) — PiP and reusable views (deferred).
- OpenAI Apps SDK reference: https://developers.openai.com/apps-sdk/reference
- OpenAI MCP Apps in ChatGPT: https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt
- ext-apps [migration doc](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/migrate_from_openai_apps.md) — reverse-direction reference.
- `@mcp-ui/server@5.16.3` — Apps SDK adapter source for the contingency port: `npm view @mcp-ui/server@5.16.3 dist.tarball`, `dist/src/adapters/appssdk/`.
- Codex symptoms: `offline/feedback/codex-viewer-disappearance-2026-04-25.md`.
