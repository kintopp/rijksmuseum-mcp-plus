# LLM Audit Manifest

Tracks which provenance-audit batches have been collected, by whom, when, and at what cost. Enables cross-session reconstruction when the JSON files themselves are regenerated or lost.

## Why

The `data/audit/` directory is gitignored (large JSON files), but this manifest is committed so future sessions can verify which audits have been done and which still need to run. Pre-flight check via `scripts/verify-audit-files.mjs`.

## Conventions

- **Filename:** `audit-<mode>-<descriptor>.json` where descriptor indicates the source DB version and date (e.g. `v0.24-128residuals-2026-04-19`).
- **Required entries** block `POST-REPARSE-STEPS` if invalid. Optional entries warn only.
- **Cost** is the estimated dollar cost reported by the audit script (Batches API, 50% discount applied).

## Required (block POST-REPARSE-STEPS)

| File | Mode | Batch ID | Model | Records | Date | Cost | Purpose |
|---|---|---|---|---|---|---|---|
| `audit-type-classification-2026-03-22.json` | type-classification | `msgbatch_012x3E1JSK2qySwLUe5wNazS` | sonnet-4 | 146 | 2026-03-22 | — | Step 1a: classify unknown events |
| `audit-position-enrichment-r1.json` | position-enrichment | `msgbatch_019BsSjpVnxxDX8QJumqiWxw` | sonnet-4 | 758 | 2026-03-22 | $6.29 | Step 1c: R1 party positions |
| `audit-position-enrichment-r2.json` | position-enrichment | `msgbatch_01ApQm2wUMwmCWtuiNpnNV3G` | sonnet-4 | 333 | 2026-03-22 | — | Step 1d: R2 party positions |
| `audit-party-disambiguation-r1.json` | party-disambiguation | `msgbatch_01DbNPMdgRHfv9h2ZgHttz6b` | sonnet-4 | 212 | 2026-03-22 | — | Step 1e: R1 long-phrase decomposition |
| `audit-party-disambiguation-r2.json` | party-disambiguation | `msgbatch_01YB9gWyEiwbPAFEKfbXTRUK` | sonnet-4 | 153 | 2026-03-22 | — | Step 1f: R2 long-phrase decomposition |

## Optional (warn-only — do not block release)

| File | Mode | Batch ID | Model | Records | Date | Cost | Purpose | Status |
|---|---|---|---|---|---|---|---|---|
| `audit-party-disambiguation-v0.24-128residuals-2026-04-19.json` | party-disambiguation | `msgbatch_0158friaz6ATxF2qeDB56Qg5` | sonnet-4-6 | 126 | 2026-04-19 | $0.83 | v0.24 post-reparse: 128 long-phrase residuals the v0.23.1 backfill couldn't match | Applied |
| `audit-field-correction-v0.24-2026-04-19.json` | field-correction | `msgbatch_01GSCo3JCfNdsY22wUFHgTHQ` | haiku-4.5 | 200 | 2026-04-19 | $0.51 | Step 7a: #149 truncated locations, #119 wrong locations, #116 missing receivers. 262 corrections applied (all ≥0.7 conf) | Applied |
| `audit-event-reclassification-v0.24-2026-04-19.json` | event-reclassification | `msgbatch_01BZY6NsEmHL5wTWz3CrrRvw` | sonnet-4-6 | 200 | 2026-04-19 | $1.42 | Step 7b: #87 phantom events, #103 alternatives, #104 location-as-event. 66 applied (59 phantoms + 5 merges + 2 alternatives). 3 records returned malformed character-stream output — filtered safely. | Applied |
| `audit-event-splitting-v0.24-2026-04-19.json` | event-splitting | `msgbatch_013ZjjPDeQLot9nUrSVCBDCc` | sonnet-4-6 | 500 | 2026-04-19 | $4.14 | Step 7c: #99 gap-bridge, #117 bequest chain, #125 multi-transfer, #102 catalogue fragment. 91 artworks split, 619 events inserted. MUST run last (renumbers sequences). | Applied |

### Superseded

The three 2026-03-25 dry-run audit files (`audit-field-correction-2026-03-25.json`, `audit-event-reclassification-2026-03-25.json`, `audit-event-splitting-2026-03-25.json`) were sampleSize-2/3 test artifacts with `meta.dryRun: true` and zero collected results. They were never promoted to real batches; the four Applied rows above replace them for v0.24.

## When updating this manifest

1. After any new `audit-*-batch.mjs` run, append a row here with the batch ID, model, record count, date, and estimated cost.
2. When re-submitting (e.g. for a new DB version), use a fresh filename with the DB version in the descriptor. Do NOT overwrite old audits; they're historical record.
3. Promote entries from Optional to Required when the corresponding writeback is part of the default POST-REPARSE-STEPS path.

## Notes

- The 2026-03-25 Step 7 audits were sample dry-runs (`meta.dryRun: true`, `sampleSize: 2-3`) that were never promoted to real batches. The POST-REPARSE-STEPS on 2026-04-19 ran without them, relying on a v0.23.1 backfill + a targeted 128-residual disambiguation audit instead.
- Full writeback history and per-batch costs are in `scripts/POST-REPARSE-STEPS.md` (file) and commit messages for the writeback scripts.
