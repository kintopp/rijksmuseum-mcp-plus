# `data/audit/`

Audit trails, calibration runs, and human-review artifacts produced by the
harvest, provenance, geocoding, and schema-discovery scripts. The directory is
**gitignored** (`data/audit/*` in `.gitignore`) except for the small, stable
docs that index the rest — `README.md` (this file) and `MANIFEST.md` (the LLM
provenance-audit batch ledger). The JSON/CSV/log payloads themselves are
regenerable and not committed. (`phase4-validation/MANIFEST.md` is a local
sub-manifest documenting the PIP-validation runs; it ships next to those runs
rather than being committed.)

Files that drive a re-applyable workflow (the canonical provenance audit JSONs,
`post-harvest-corrections-*.tsv`, `orphan-vocab-ids-v0.24.csv`) are the system
of record for manual interventions that must survive a fresh harvest — see
`scripts/POST-REPARSE-STEPS.md` and `scripts/RELEASE.md`.

Stale, exploratory, and superseded artifacts have been moved to
[`legacy/`](#legacy) (see that section).

### Layout

```
README.md   MANIFEST.md
audit-*.json (+ .state.json), disambig-targets-128-residuals*.json   ← provenance LLM audits (flat — path-coupled, see below)
harvest-audit-v0.24-calibration.json, orphan-vocab-ids-v0.24.csv     ← harvest artifacts referenced by literal path in committed scripts
post-harvest-corrections-2026-04-29.tsv, rejected-altname-candidates.csv
reviews/     ← static HTML review pages
harvest/     ← harvest log + superseded orphan-CSV snapshots
schema/      ← Linked-Art schema-discovery + OAI/LDES coverage reports
<geo dirs>   ← areal-classifier-extension/, cold-rerun-2026-04-28/, stage-e-2026-04-29/, stage-f-2026-04-29/, phase1d-wof/, phase3e-pleiades/, phase4-validation/, globalise-probe/
legacy/      ← superseded / orphaned artifacts
```

The provenance audit JSONs, `orphan-vocab-ids-v0.24.csv`, and
`harvest-audit-v0.24-calibration.json` stay at the directory root because
`scripts/verify-audit-files.mjs`, `MANIFEST.md`, `scripts/POST-REPARSE-STEPS.md`,
`scripts/backfill-enrichment-reasoning.mjs`, the `writeback-*.mjs` scripts,
`harvest-vocabulary-db.py`, `enrich-orphan-vocab-csv.py`, and
`scripts/tests/run-audit-calibration.py` all reference them by literal
`data/audit/<file>` path — moving them would be a coordinated refactor of
committed code, not a free reorg. (`post-harvest-corrections.py` likewise
*writes* to `data/audit/post-harvest-corrections-<timestamp>.tsv`.)

---

## Provenance LLM audits

The canonical provenance audit batches — collected via the Anthropic Batches
API, applied by the `writeback-*.mjs` scripts, and verified before a re-parse by
`scripts/verify-audit-files.mjs`. **`MANIFEST.md` is the authoritative ledger**
(batch IDs, models, record counts, costs, applied status); the table below is a
script cross-reference.

| File(s) | Produced by | Consumed by | Notes |
|---|---|---|---|
| `audit-type-classification-2026-03-22.json` (+ `.state.json`) | `audit-provenance-batch.mjs --mode type-classification` | `writeback-type-classifications.mjs` (default `--input`); `backfill-enrichment-reasoning.mjs` | Step 1a — classify previously-unknown events. Required by `verify-audit-files.mjs`. |
| `audit-position-enrichment-r1.json`, `audit-position-enrichment-r2.json` | `audit-provenance-batch.mjs --mode position-enrichment` (two rounds) | `writeback-position-enrichment.mjs`; `backfill-enrichment-reasoning.mjs`; `generate-position-review.mjs` | Steps 1c/1d — party positions. Required. |
| `audit-party-disambiguation-r1.json`, `audit-party-disambiguation-r2.json` | `audit-disambiguate-parties.mjs` (two rounds; collected by `collect-disambig-results.mjs` / `collect-round1-results.mjs`) | `writeback-party-disambiguation.mjs`; `backfill-enrichment-reasoning.mjs`; `generate-disambig-review.mjs` | Steps 1e/1f — decompose merged sender/receiver/agent party text. Required. |
| `audit-party-disambiguation-v0.24-128residuals-2026-04-19.json` (+ `.state.json`) | `audit-disambiguate-parties.mjs` (one-off, fed by `disambig-targets-128-residuals.json`) | `writeback-party-disambiguation.mjs`; `backfill-enrichment-reasoning.mjs` | v0.24 post-reparse: the 128 long-phrase residuals the v0.23.1 backfill couldn't match. Optional/applied. |
| `disambig-targets-128-residuals.json`, `disambig-targets-128-residuals-applied.json` | Hand-assembled for the 2026-04-19 v0.24 post-reparse session (no producing script) | input / done-marker for the 128-residual audit above | Kept here as the companion input to the canonical 128-residual audit JSON. |
| `audit-field-correction-v0.24-2026-04-19.json` (+ `.state.json`) | `audit-provenance-batch.mjs --mode field-correction` | `writeback-field-corrections.mjs`; `generate-structural-review.mjs --field-correction` | Step 7a — truncated/wrong locations (#149/#119), missing receivers (#116). Optional/applied. |
| `audit-event-reclassification-v0.24-2026-04-19.json` (+ `.state.json`) | `audit-provenance-batch.mjs --mode event-reclassification` | `writeback-event-reclassification.mjs`; `generate-structural-review.mjs --event-reclassification` | Step 7b — phantom events (#87), alternatives (#103), location-as-event (#104). Optional/applied. |
| `audit-event-splitting-v0.24-2026-04-19.json` (+ `.state.json`) | `audit-provenance-batch.mjs --mode event-splitting` | `writeback-event-splitting.mjs`; `generate-structural-review.mjs --event-splitting` | Step 7c — gap-bridge (#99), bequest chain (#117), multi-transfer (#125), catalogue fragment (#102). Optional/applied. Must run last (re-sequences events). |

`.state.json` siblings are the Batches-API resume-state files written by the
audit scripts (poll-state for `--resume`).

### `reviews/`

Static HTML review pages rendered from the audit JSONs (or directly from the DB)
for human spot-checking. The `generate-*-review.mjs` scripts write to `data/` by
default; these copies were placed here by hand.

| File | Produced by |
|---|---|
| `reviews/position-enrichment-review.html` | `generate-position-review.mjs` (reads `audit-position-enrichment-r1/r2.json`) |
| `reviews/party-disambiguation-review.html` | `generate-disambig-review.mjs` (reads `audit-party-disambiguation-r1/r2.json`) |
| `reviews/long-duration-review.html` | `review-long-duration-periods.mjs` (#178 — reads the DB; classifies >200-year periods as legitimate vs artifact) |

(`generate-structural-review.mjs` produces a structural-corrections review page; no copy of it is kept here.)

---

## Harvest audits

`harvest-audit-v0.24-calibration.json` and `orphan-vocab-ids-v0.24.csv` sit at
the directory root (path-coupled — see the Layout note above); the rest is in
`harvest/`.

| File(s) | Produced by | Notes |
|---|---|---|
| `harvest-audit-v0.24-calibration.json` *(root)* | `scripts/tests/run-audit-calibration.py` (exercises `scripts/lib/harvest_audit.py`) | Per-phase harvest audit framework (#222) calibration output — baseline expectations for `run_phase_audit`. |
| `orphan-vocab-ids-v0.24.csv` *(root)* | `harvest-vocabulary-db.py` (Phase 2 orphan dump); enriched by `enrich-orphan-vocab-csv.py` | Vocab IDs referenced by artworks but never resolved (Phase 2 HTTP failures). `harvest-vocabulary-db.py` forces a manual review of this file before proceeding. **Canonical** v0.24 dump (2026-04-16). |
| `harvest/harvest-run-2026-04-14.log` | `harvest-vocabulary-db.py` | Console log of the v0.24 full re-harvest. |
| `harvest/orphan-vocab-ids-v0.24-2026-04-14.csv`, `harvest/orphan-vocab-ids-v0.24-calibration.csv` | `harvest-vocabulary-db.py` (Phase 2 orphan dump) | Earlier-run snapshots of the orphan dump (first full v0.24 attempt / calibration run). Superseded by the root `orphan-vocab-ids-v0.24.csv` but tiny — kept as a record. |

---

## Schema & coverage discovery — `schema/`

All hand-named (`--output`) or one-off outputs; nothing references them by path.
Re-running `discover-linked-art-schema.py --mode ldes` writes fresh
`oai-coverage-v0.26-ldes.*` to the **audit root** (its `audit_dir` is not a CLI
arg), so if that ever happens, fold the new copies in here.

| File(s) | Produced by | Notes |
|---|---|---|
| `schema/schema-discovery-v0.25-pre.{json,log,md}` | `discover-linked-art-schema.py` (custom `--output`) | Exhaustive Linked Art field-path coverage/cardinality analysis run before the v0.25 harvest planning. |
| `schema/schema-discovery-v0.25-pre-33k.{json,log,md}` | `discover-linked-art-schema.py` (custom `--output`) | Re-run of the above against a larger (~33k) artwork sample. |
| `schema/oai-coverage-v0.26-ldes.la-framed.{json,md}`, `schema/oai-coverage-v0.26-ldes.edm-framed.{json,md}` | `discover-linked-art-schema.py --mode ldes` (walks the LDES day-fragments, both framed JSON-LD profiles) | Raw LDES-path-vs-write-set coverage matrices for v0.26 incremental-harvest planning (#186). |
| `schema/oai-coverage-v0.26-summary.md` | hand-written summary, derived from the two `oai-coverage-v0.26-ldes.*` artifacts above | v0.26 coverage-matrix narrative (walk numbers, unmapped paths, recommendations). |
| `schema/schema-org-dump-coverage.md` | hand-written summary, derived from `probe-dumps.py` output cross-referenced with `harvest-vocabulary-db.py` extractors | Per-Schema.org-dump status audit (which of the 13 data-dump archives are mined vs unused) for v0.26 (#270). |

---

## Geocoding pipeline audit trail

Artifacts from the place-geocoding subsystem (`scripts/geocoding/`). The bulk
of these are one-time records from the April 2026 v0.24→v0.25 cold-rerun and
strict-authority-only-policy work; the pipeline itself is still run via
`scripts/geocoding/run_authority_only_geocode.py` (and historically
`run_clean_regeo.py`), so the validation tooling is re-runnable even though
these specific run directories are historical. See `scripts/README.md`
(§ "Geocoding") for the full script inventory and
`offline/` memory notes for the policy history.

| Path | Produced by | Contents / status |
|---|---|---|
| `areal-classifier-extension/` | hand-curated `{tgn,wikidata}-gap.tsv` feed `scripts/lib/placetype_map.py`; `_*.py` helpers + `_tgn_direct_lookup.py` / `_tgn_obsolete_chain.py` (`scripts/geocoding/`) wrote/verified the additions and the `_tgn_*_results.tsv` probes | v0.25 pre-harvest areal-classifier extension (129 AAT + 565 WD entries, 2026-04-26); `summary.md` documents the run. Superseded one-shot curation; the classifier extension is permanent (append-only) in `lib/placetype_map.py`. |
| `cold-rerun-2026-04-28/` | `scripts/geocoding/run_clean_regeo.py` (per-phase logs from `geocode_places.py` 1a–4) + `backfill_vei_from_la.py` (`backfill-vei-places.log`) | Logs from the 2026-04-28 clean re-geocode after the user-gated cold reset. Superseded workflow (`run_clean_regeo.py` predates the authority-only policy). |
| `stage-e-2026-04-29/` | the Stage-E pass: `geocode_places.py --phase 1d/1e/3e` (phase logs), a Layer-B backfill (`layer-b.log`), `phase4_pip_validation.py` (`phase4-pip*.log`), `export_backfill_csv.py` (`backfill-export.log`); `uk-cluster.tsv` hand-pulled UK-admin-area diagnostic dump | Logs from running the new v0.25 phases on top of the cold rerun. Superseded one-time stage. |
| `phase1d-wof/2026-04-29/wof_review.csv` | `geocode_places.py --phase 1d` (`phase_1d_wof`) | Multi-match Who's-On-First admin-polygon candidates routed to human review (single matches auto-accepted to the DB). Unit-tested by `scripts/tests/test-1d-wof.py`. (Phase 1e — RCE-Rijksmonumenten, `phase_1e_rce`, tested by `scripts/tests/test-1e-rce.py` — self-aborted on its pre-flight threshold for this run and produced no output.) |
| `phase3e-pleiades/2026-04-29/pleiades_review.csv` | `geocode_places.py --phase 3e` (`phase_3e_pleiades`) | Ambiguous Pleiades (classical-antiquity gazetteer) candidates for human review. Unit-tested by `scripts/tests/test-3e-pleiades.py`. |
| `phase4-validation/` | `scripts/geocoding/phase4_pip_validation.py` (also `geocode_places.py --phase 4-pip`); referenced by `scripts/tests/test-geocode-bundle.py` | Point-in-polygon audit of every non-NULL coord against WOF admin polygons (DuckDB spatial). Four dated run dirs (`2026-04-28-baseline-v024`, `…-post-cold-rerun`, `2026-04-29-final`, `…-post-bundle`), each with `all_results.csv` / `disagreements.csv` / `summary.txt`. **`phase4-validation/MANIFEST.md`** documents the bucket definitions and run log. The audit tool is re-runnable; these run dirs are historical snapshots. |
| `globalise-probe/2026-04-29/` | `scripts/probe-globalise-overlap.py --output-dir …` | Read-only sizing probe for GLOBALISE/ESTA gazetteer overlap with the cold-rerun DB (`candidates.csv` = per-row match table, `stage-e-regression-check.txt` = summary). One-shot decision probe feeding v0.26 planning. |
| `stage-f-2026-04-29/harvest-person-names.log` | `scripts/harvest-person-names.py` | Log of the targeted person-name-variant refetch run during "Stage F" (not strictly geocoding — bundled in the same April-29 batch). |
| `post-harvest-corrections-2026-04-29.tsv` | `scripts/post-harvest-corrections.py` (writes `data/audit/post-harvest-corrections-<timestamp>.tsv`) | Audit log of re-applying local-vs-prod drift patches lost in the cold rerun (13 TGN-redirect coord overrides + 4 manual `is_areal` flips), with pre/post state per row. The 2026-04-29 log is historical, but `post-harvest-corrections.py` and its source TSVs in `data/backfills/` are **active** — meant to be re-run after every fresh harvest. |

---

## Other

| File | Produced by | Notes |
|---|---|---|
| `rejected-altname-candidates.csv` | the rejected half of the human/LLM review of `group-altname-fuzzy-candidates.tsv` (which `scripts/probe_group_altname_fuzzy_matches.py` emits; the accepted half is applied by `scripts/apply_reviewed_altname_candidates.py`) | Curated record of which fuzzy entity-alt-name candidates were rejected during the v0.26 dress rehearsal (#268). Committed (small, stable). |

---

## `legacy/`

Superseded or orphaned audit artifacts, retained for historical reference only —
**not part of any current workflow** and not referenced by `verify-audit-files.mjs`,
`scripts/POST-REPARSE-STEPS.md`, or any `writeback-*.mjs`.

- **March-2026 PEG-grammar-design exploration** — `audit-pattern-mining-2026-03-21*`, `audit-pattern-mining-2026-03-22*`, `audit-silent-errors-2026-03-21*`, `audit-silent-errors-2026-03-22*`, `audit-structural-signals-2026-03-22*` (each `.json` + `.state.json`). Many iteration variants (`run2`, `deduped`, `deduped-v2/v3`, `exhaustive`, `post-reparse`, `opus`, `sonnet-v2/v3`, …) produced by `audit-provenance-batch.mjs` while designing the provenance PEG grammar. The grammar fixes they informed are baked into `src/provenance-grammar.peggy`; the canonical v0.24 provenance audit set (kept at top level + listed in `MANIFEST.md`) supersedes them.
- **Model-selection comparison** — `pe-comparison-{opus,opus-thinking,opus-v2,sonnet,sonnet-thinking}.{json,state.json}`. Tiny (`sampleSize` ~10) `audit-provenance-batch.mjs --mode position-enrichment` runs from 2026-03-22 used to pick the model for the real position-enrichment batch. Decision made; one-time.
- **Dry-run stubs** — `audit-type-classification-2026-03-23.json`, `audit-event-reclassification-2026-03-25.json`, `audit-event-splitting-2026-03-25.json`, `audit-field-correction-2026-03-25.json` (all `dryRun: true`, `sampleSize` 1–3; never promoted to real batches — see `MANIFEST.md` § "Superseded").
- **Pre-rename duplicates** — `audit-position-enrichment-2026-03-22.{json,state.json}` and `audit-party-disambiguation-2026-03-22.{json,state.json}` are byte-for-byte copies of the canonical `*-r2.json` files (same Batches-API `batchId`), left over from before the `-r1`/`-r2` naming convention. (Some `writeback-*.mjs` scripts still *default* `--input` to these `data/audit-…-2026-03-22.json` basenames, but `POST-REPARSE-STEPS.md` always passes an explicit `--input data/audit/audit-…-r1/r2.json`.)
- **Orphaned review pages** — `type-classification-review.html`, `type-classification-review-all.html`. Ad-hoc HTML renders of the March-2026 type-classification work; no current script generates them (`audit-type-classification-2026-03-22.json` itself is kept at top level).
