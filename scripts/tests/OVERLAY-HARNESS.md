# Overlay-Accuracy Harness

Measurement scaffolding for evaluating how well LLMs place bounding-box overlays on crops of paintings served by this MCP server. Motivating use-case: [issue #247](https://github.com/kintopp/rijksmuseum-mcp-plus-offline/issues/247) — silent coordinate drift in LLM annotation workflows.

## Why this is in the repo

Two user-visible behaviours in `src/registration.ts` are informed by measurements produced with this harness:

- `inspect_artwork_image`'s `size` parameter defaults to **1568** and maxes at **2016**. Both are multiples of 28, aligning with Claude's internal image-tiling grid so bounding-box coordinates emitted by the LLM land cleanly in the image's coordinate space. 1568 is Claude Sonnet 4.6's native-resolution ceiling; 2016 is the highest ×28 value that stays within Claude Opus 4.7's per-image token budget for common painting aspect ratios.
- The tool descriptions in the MCP protocol surface support crop-local `crop_pixels:` coordinates for `add_overlay` when paired with `relativeTo` and `relativeToSize`. Evidence shows Opus-class models produce more accurate overlays with pixel framing.

Full written verdicts, per-run result JSON, and the curator-authored ground-truth files all live in the private `offline/` submodule under `offline/overlay-test/`. Start at `offline/overlay-test/FINDINGS.md` for the summary; each experiment has its own `VERDICT.md`.

## What's in this directory

The public-repo side is the *tooling*:

| File | Purpose |
|---|---|
| `overlay-extract-ground-truth.mjs` | parse OmniGraffle `.graffle` → ground-truth JSON (library + CLI) |
| `overlay-scoring.mjs` | IoU, centroid offset, size ratio, crop-local → full-image projection |
| `overlay-config.mjs` | Zod schemas + loaders for cases and experiments |
| `overlay-harness-fixed-crop.mjs` | Phase A — single-call estimation, fixed pre-computed crop |
| `overlay-harness-agentic.mjs` | Phase B stub — agent-loop smoke test (one feature, one condition) |
| `overlay-harness-p1.mjs` | P1 two-pass harness with `sharp`-based overlay compositor |
| `overlay-harness-p7-replay.mjs` | P7 replay: synthesize out-of-bounds warning, retry, score |
| `overlay-run.mjs` | CLI entrypoint for Phase A experiments |
| `test-overlay-scoring.mjs` | unit tests for pure math (registered in `npm run test:all`) |
| `test-overlay-harness-smoke.mjs` | manual runbook (prints usage, does not execute) |

All scripts are ES modules; most imports resolve from the project's `node_modules/` so they must live inside the project tree.

## Running

Requires:
- `npm run build` (for `dist/index.js`, which the harness spawns via stdio)
- `ANTHROPIC_API_KEY` in env or `~/.env`
- For harness use: the private `offline/` submodule initialised (ground-truth files live there)

Minimal example (Phase A, pilot on Sonnet):

```bash
node scripts/tests/overlay-run.mjs \
  offline/overlay-test/experiments/p2-pct-vs-pixel \
  --pilot
```

Omit `--pilot` for a full sweep. Add `--model claude-opus-4-7` to use Opus. See `test-overlay-harness-smoke.mjs` for the full runbook including P7 replay and extraction steps.

## Extending

New experiments are **config-driven**: add a directory under `offline/overlay-test/experiments/` with a `config.mjs` declaring the experiment shape (harness type, case reference, conditions, prompts). The existing `p2-pct-vs-pixel/` and `p1-show-overlays/` configs are the working examples.

New cases (artwork + ground-truth tuples) go under `offline/overlay-test/cases/` with an OmniGraffle source file and a `case.mjs` metadata pointer. The extractor produces the JSON the harness reads.
