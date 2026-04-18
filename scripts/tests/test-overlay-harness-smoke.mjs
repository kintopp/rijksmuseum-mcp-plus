/**
 * Overlay harness smoke-test runbook. Not executed by `npm test`.
 *
 * Preconditions:
 *   1. `npm run build` — so dist/index.js exists
 *   2. ANTHROPIC_API_KEY in ~/.env
 *   3. offline/overlay-test/cases/sk-a-2152-insects/ground-truth.graffle authored by curator
 *
 * Procedure:
 *
 *   # 1. Extract ground truth
 *   node scripts/tests/overlay-extract-ground-truth.mjs \
 *        offline/overlay-test/cases/sk-a-2152-insects/ground-truth.graffle \
 *        offline/overlay-test/cases/sk-a-2152-insects/ground-truth.json
 *
 *   # 2. Pilot run (Sonnet, 3 features × 3 runs × 2 conditions = 18 calls, ~$0.15)
 *   node scripts/tests/overlay-run.mjs \
 *        offline/overlay-test/experiments/p2-pct-vs-pixel \
 *        --pilot
 *
 *   # 3. Agentic stub smoke (one feature, end-to-end)
 *   node scripts/tests/overlay-harness-agentic.mjs \
 *        offline/overlay-test/experiments/p2-pct-vs-pixel \
 *        --feature "Damselfly"
 *
 * Expected outputs:
 *   - ground-truth.json with N features, each with bbox_pct + label
 *   - {ts}-claude-sonnet-4-6.{json,md} in experiments/p2-pct-vs-pixel/results/
 *   - stub-agentic-{ts}.json with trace.overlays.length >= 1
 *
 * AFTER pilot — threshold calibration:
 *   Inspect the pilot results markdown, then edit config.mjs's `expected` field:
 *     expected: {
 *       hypothesis: "pixel condition improves coordinate accuracy over pct",
 *       thresholds: [
 *         { metric: "median_iou", min_delta: 0.10 },
 *         { metric: "median_center_offset_pct", max_delta: -2.0 }
 *       ],
 *       verdict: "either_threshold"
 *     }
 *   Commit inside the submodule.
 *
 * FULL run (locked threshold):
 *   node scripts/tests/overlay-run.mjs offline/overlay-test/experiments/p2-pct-vs-pixel
 *   # (no --pilot flag; full feature set × 5 runs per condition, ~$2 on Sonnet)
 */
console.error("This is a manual runbook. See source for procedure.");
process.exit(0);
