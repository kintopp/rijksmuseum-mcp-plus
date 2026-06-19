# Post-Reparse Steps

After a full `batch-parse-provenance.mjs` re-parse, enrichments must be re-applied — the re-parse
drops and recreates `provenance_events` / `provenance_parties` / `provenance_periods`, wiping all
post-parse enrichments.

**As of plan 015 Phase 3.2 the canonical path is STORE-DRIVEN:** a content-addressed re-apply
(`reapply-enrichments-from-store.mjs`) that matches each enrichment to the event still carrying the
same `raw_text`, so it survives #390-style re-segmentation instead of mis-targeting on stale
`(artwork_id, sequence)` positions. The old position-keyed writeback path is **retained as a
fallback** in the [Legacy section](#legacy--position-keyed-writeback-path-retained-until-cutover-proven)
at the bottom until the store-driven cutover has run cleanly on a real re-parse + deploy.

> **Validated 2026-06-14** by the Phase 3.2 dress-rehearsal (full re-parse of a DB copy + this exact
> sequence): reproduces the deployed structural state exactly (`#117` 62, `#125` 125, `llm_structural`
> parties 800, events 101,171, periods 81,207, unsold 665; hard invariants 0/0/0; 7d 199/361, 0 skips).
> See `plans/provenance-enrichment-structural-confidence-leak.md` + `plans/015-*.md`.

## Pre-parse: change detection (optional)

Before re-parsing, run the change-detection report to size the re-enrichment surface:

```bash
node scripts/provenance-change-report.mjs --db data/vocabulary.db
```

This diffs `artworks.provenance_text_hash` (current harvest) against the hashes as of the last parse
(`provenance_parse_state`, stamped by `batch-parse-provenance.mjs` at the end of every non-dry-run
parse). It outputs counts for `unchanged / modified / new / removed` artworks and cross-references
`provenance_enrichments` to flag re-enrichment candidates.

**The parser always does a full rebuild** — the report scopes *re-enrichment* (which artworks need a
fresh LLM pass), not *re-parsing*. The `modified ∩ store` and `new` sets are the artworks worth an
LLM re-enrichment pass; everything else re-applies deterministically from the store.

For the first run before any stamp exists, pass `--baseline data/vocabulary.db.pre017-20260614` (or
whichever backup represents the last-parsed state). See `scripts/provenance-change-report.mjs --help`
(or read the script header) for all flags.

## Order matters

Steps run sequentially — later steps depend on earlier ones.

## Precondition: the `provenance_enrichments` store must exist

`reapply` reads the `provenance_enrichments` store. It is a standalone table that **survives the
re-parse** (which only drops the events/parties/periods tables). Build it **once** from the current
enriched DB *before* the first cutover re-parse:

```bash
node scripts/migrate-enrichments-to-store.mjs --value --manual --structural --db data/vocabulary.db
node scripts/tests/verify-enrichment-store-parity.mjs --db data/vocabulary.db   # must be 6/6 PASS
```

Rebuild it only when the audit JSONs or the migrate extractor change (e.g. the plan-015 structural
confidence fix). Ordinary re-parses re-apply from the surviving store; no rebuild needed.

**#397/#408 revert guard:** `--structural` consults `scripts/provenance-revert-denylist.json` and
skips the structural ops the v0.81 audit reverted (60 phantom suppressions, 18 bad bequest splits,
43 Mannheimer reifications, …) — the frozen source audit JSONs still hold them, so a guard-less
rebuild would resurrect the whole batch. If a future revert changes the corrected store, regenerate
the denylist with `node scripts/build-revert-denylist.mjs` **against the corrected store** (running
it against an already-polluted rebuild yields an empty denylist). The migrate run reports
`structural_denied` so the suppression count is visible.

## `--id-remap` is NOT needed on the store path

The store keys on `object_number` (not the per-harvest integer `art_id`), and
`reconstruct-7d-from-baseline.mjs` keys on `(object_number, sequence)` + raw_text — both
harvest-stable. So the store-driven path needs no `--id-remap`; the flag existed only for the
audit-JSON writebacks this path replaces (kept in the Legacy section). The kept rule-based writebacks
(1b/1g/2a/2b) never took it.

## Final cutover order

```
re-parse  →  Step 1 reapply-from-store  →  Step 2 rule-based (1b → 1g → 2a → 2b)
          →  Step 3 batch-price SQL     →  Step 4 7d reconstruct-from-baseline
          →  Verification
```

---

## Step 1 (store-driven): re-apply all LLM + manual enrichments

Subsumes the legacy 1a/1c/1d/1e/1f/1h (type-classifications, position-enrichment,
party-disambiguation, reasoning-backfill), **Step 4** (manual corrections), **Step 5** (credit-line
reclassifications), **Step 6** (party corrections), and **Step 7a/7b/7c** (field-corrections,
reclassifications, splits). One command, content-addressed; order inside is fixed (value → parties
snapshot → field-correction → reclassify → split-last-and-renumber).

```bash
node scripts/reapply-enrichments-from-store.mjs --db data/vocabulary.db
```

**Review the `RECONCILE <json>` line.** `unmatched.text_changed` / `*_dup_cardinality_changed` lists
artworks whose source text changed since the store was built — feed ONLY those deltas to the LLM
re-enrichment path (the ~$4–7 Sonnet/Haiku run), not the whole corpus. A small non-empty `unmatched`
is **expected** and is the intended change-detection signal, not an error.

## Step 2: kept rule-based writebacks

These regenerate deterministically from event text every parse and are **not** in the store (§B).
The legacy Step 1 mixed these (1b/1g) with the LLM writebacks — here they move into Step 2 alongside
the old 2a/2b. Run in this order:

```bash
node scripts/writeback-transfer-category.mjs   # 1b — ~6,200 events: ambiguous → ownership
node scripts/writeback-residual-nulls.mjs      # 1g — delete ~190+ artifact null-position parties
node scripts/writeback-unsold-prices.mjs       # 2a — "bought in at fl. X" (≈596 events)
node scripts/writeback-missing-receivers.mjs   # 2b — "to the [Name]" tail parties (stamps rule:missing_receiver)
```

> The kept rule-based writebacks run **after** `reapply` (i.e. on the post-split event set), vs the
> legacy pre-split order. The dress-rehearsal showed only small deterministic deltas from this
> re-ordering (−4 receivers, +13 null-position, ±~20 category). If exact pre-split parity is ever
> required, run 1b/1g/2a/2b before `reapply` and re-validate.

## Step 3: Batch price flag — REQUIRED

The PEG parser sets some `batch_price` during reparse via `BATCH_PRICE_RE` (`src/provenance-peg.ts:29`),
but that regex is **narrower** than the `LIKE` patterns below (e.g. "…with other objects, fl. 2,000…",
"…six other objects…"). Skipping this SQL drops `batch_price + price_amount` below band. The SQL sets
the flag only — no price/data values change — and is idempotent (~596 net new flags).

```sql
UPDATE provenance_events SET batch_price = 1
WHERE price_amount IS NOT NULL AND is_cross_ref = 0
AND (raw_text LIKE '%en bloc%' OR raw_text LIKE '%_en bloc_%'
  OR raw_text LIKE '%with%other painting%' OR raw_text LIKE '%with%other drawing%'
  OR raw_text LIKE '%with%other object%' OR raw_text LIKE '%with%other work%'
  OR raw_text LIKE '%with%other model%' OR raw_text LIKE '%with%other piece%'
  OR raw_text LIKE '%with%other item%'
  OR raw_text LIKE '%for both no%' OR raw_text LIKE '%for all %'
  OR raw_text LIKE '%with SK-%' OR raw_text LIKE '%with BK-%'
  OR raw_text LIKE '%with RP-%' OR raw_text LIKE '%with AK-%'
  OR raw_text LIKE '%with NG-%');
```

## Step 4: 7d party-extraction (reconstruct from baseline)

The 7d party-extraction (events with 0 extracted parties, `correction_method
'llm_structural:missing_all_parties' / 'missing_sender'`) is **NOT in the store** — `migrate
--structural` reads only the split/reclassify/field-correction audits, and the value path excludes
`llm_structural:%` events. Its audit JSON was never persisted to the repo, so the reproducible path
is to reconstruct from the **previous deploy's DB** (object_number+sequence, raw_text-guarded):

```bash
# dry-run first (no --apply); it is raw_text-guarded and skips any re-segmented event.
node scripts/reconstruct-7d-from-baseline.mjs --base <previous-deploy>.db --apply
```

In the v0.40 baseline this is 199 events / 361 parties (all `position_method='llm_structural'`).
**Keep a copy of the prior deploy DB** for every cutover until 7d is either added to the store as its
own op-kind or its audit JSON is persisted (see plan 015 open items).

---

## Orphan Vocab Audit (harvest v0.24+)

After Phase 4 but before Phase 3, the harvest script exports orphan vocab IDs to
`data/audit/orphan-vocab-ids-v0.24.csv`. Review this file — any legitimate AAT codes
should be added to `EXTERNAL_VOCAB` in `harvest-vocabulary-db.py` and re-seeded
(Phase 0 is idempotent) before running Phase 3.

Phase 3's integer-encoding JOIN silently drops orphan mappings, so this step
prevents data loss.

## Verification

After all steps, verify against the targets below. Targets are framed as
**ranges** not exact counts — re-harvests legitimately drift these by a few
percent. Hard zeros (orphan parties, duplicate sequences, corrected-no-reasoning) are the real
correctness invariants; everything else is sanity-band.

| # | Query | Target range | v0.26 observed (2026-04-30) | Notes |
|---|---|---|---|---|
| 1 | `unknown` non-cross-ref events | 3–25 | 15 | Step-4 7d tightens this; 3 is the floor with full 7d applied |
| 2 | Null-position parties | 0–30 | 22 | Edge cases the rule-based 1g can't classify; 0 only with full 7d |
| 3 | Unsold events | 660–680 | 665 | Stable across re-harvests |
| 4 | Batch-price events with parsed price | 3,700–4,100 | 3,900 | The "real" batch_price metric |
| 5 | Total `batch_price = 1` | 15K–18K | 17,076 | Includes parser-set rows w/ no extracted price |
| 6 | Parties + events missing `enrichment_reasoning` (method `LIKE 'llm%'`) | 0–10 | 5 + 3 = 8 | writeback-clash residue only |
| 7 | Orphaned parties (party with no matching event) | **0** | 0 | Hard invariant |
| 8 | Duplicate `(artwork_id, sequence)` | **0** | 0 | Hard invariant |
| 9 | Corrected events without reasoning | **0** | 0 | Hard invariant |
| 10 | Total events / parties / periods | 100K / 90K / 80K (±5%) | 101,171 / 90,696 / 81,207 | Tracks artwork count linearly |

```sql
-- 1. Non-cross-ref unknowns
SELECT COUNT(*) FROM provenance_events WHERE transfer_type = 'unknown' AND is_cross_ref = 0;
-- 2. Null-position parties
SELECT COUNT(*) FROM provenance_parties WHERE party_position IS NULL AND position_method IS NULL;
-- 3. Unsold events
SELECT COUNT(*) FROM provenance_events WHERE unsold = 1;
-- 4. Batch-price events with parsed price (the meaningful subset)
SELECT COUNT(*) FROM provenance_events WHERE batch_price = 1 AND price_amount IS NOT NULL;
-- 5. Total batch_price
SELECT COUNT(*) FROM provenance_events WHERE batch_price = 1;
-- 6. Enrichment reasoning coverage
SELECT COUNT(*) FROM provenance_parties WHERE position_method LIKE 'llm%' AND enrichment_reasoning IS NULL;
-- Structural corrections applied
SELECT correction_method, COUNT(*) FROM provenance_events WHERE correction_method IS NOT NULL GROUP BY 1;
-- 7. No orphaned parties — HARD INVARIANT
SELECT COUNT(*) FROM provenance_parties pp
WHERE NOT EXISTS (SELECT 1 FROM provenance_events pe
  WHERE pe.artwork_id = pp.artwork_id AND pe.sequence = pp.sequence);
-- 8. Sequence integrity — HARD INVARIANT
SELECT artwork_id FROM provenance_events GROUP BY artwork_id, sequence HAVING COUNT(*) > 1;
-- 9. All corrected events have reasoning — HARD INVARIANT
SELECT COUNT(*) FROM provenance_events WHERE correction_method IS NOT NULL AND enrichment_reasoning IS NULL;
-- 10. Totals
SELECT 'events' AS table_name, COUNT(*) FROM provenance_events UNION ALL
SELECT 'parties', COUNT(*) FROM provenance_parties UNION ALL
SELECT 'periods', COUNT(*) FROM provenance_periods;
```

### Store-path verification (store-driven cutover only)

```bash
# 6/6 PASS: value/parties exact + no guard-evading missing-receiver snapshot
#           + no sub-0.7-confidence / degenerate split store row.
node scripts/tests/verify-enrichment-store-parity.mjs --db data/vocabulary.db
```

Also **record the `reapply` RECONCILE `unmatched` total** and the object_numbers fed to
re-enrichment — do not let a non-zero `unmatched` pass unreviewed.

### Property-based invariant scanners (run before AND after; after must not regress)

Three stdlib Python 3 scanners in the `offline/` submodule assert correctness properties over every
record and catch regressions the aggregates miss:

- `offline/provenance/scan-provenance-compliance.py` — structural / AAM-notation violations.
- `offline/provenance/scan-provenance-timetravel.py` — chronology contradictions.
- `offline/provenance/scan-provenance-typemismatch.py` — transfer-type mismatches.

Each takes no args (hardcodes `data/vocabulary.db`) and writes `provenance-<name>-findings.csv` +
`-report.md` next to itself. Capture the baseline **before** the re-parse, re-run **after**; the
after-counts must not exceed the baseline (drift down is a fix).

```bash
# BEFORE the re-parse — baseline (from repo root):
mkdir -p data/reparse-baseline
for s in compliance timetravel typemismatch; do
  python3 offline/provenance/scan-provenance-$s.py
  cp offline/provenance/provenance-$s-findings.csv data/reparse-baseline/$s.csv
done
# ... run the re-parse + store-driven re-apply, then AFTER — re-run + compare:
for s in compliance timetravel typemismatch; do
  python3 offline/provenance/scan-provenance-$s.py
  echo "$s: baseline=$(($(wc -l <data/reparse-baseline/$s.csv)-1)) after=$(($(wc -l <offline/provenance/provenance-$s-findings.csv)-1))"
done
```

### Parse-regression snapshot diff (which records changed — intended vs collateral)

`scripts/provenance-parse-snapshot.mjs` diffs the per-record parse before vs after and buckets every
artwork (`identical` / `resegmented` / `field_drift` / `source_changed` / `added` / `removed`). Use
the parser-isolating (deterministic) workflow so `field_drift` = true grammar regressions, not
enrichment:

```bash
git checkout <pre-reparse grammar> && npm run build
node scripts/provenance-parse-snapshot.mjs snapshot --out data/parse-snapshots/before.jsonl
git checkout <new grammar> && npm run build
node scripts/provenance-parse-snapshot.mjs snapshot --out data/parse-snapshots/after.jsonl
node scripts/provenance-parse-snapshot.mjs diff \
  --before data/parse-snapshots/before.jsonl --after data/parse-snapshots/after.jsonl \
  --out data/parse-snapshots/report.md
```

Gate: triage the review queue = `field_drift` + `removed` before sign-off. `resegmented` is the
*intended* re-segmentation class (e.g. #390 — spot-check a sample); `source_changed` is upstream
text edits. To validate the **end-to-end** pipeline (parse + store re-apply) rather than just the
grammar, snapshot `--from-db` on both the old and re-parsed DBs instead. Self-test the diff logic:
`node scripts/provenance-parse-snapshot.mjs diff --selftest`.

---

## LEGACY — position-keyed writeback path (RETAINED until cutover proven)

> ⚠️ **Superseded by the store-driven path above (plan 015 Phase 3.2).** Retained as a fallback and
> for provenance until the store-driven cutover has run cleanly on a real re-parse + deploy; then
> these steps (and the `.mjs` scripts they call — `writeback-type-classifications`,
> `-position-enrichment`, `-party-disambiguation`, `-field-corrections`, `-event-reclassification`,
> `-event-splitting`, `backfill-enrichment-reasoning`) can be archived. **Do NOT run both paths on
> the same DB** — they would double-apply. The kept rule-based writebacks (1b/1g/2a/2b), the Step-3
> SQL, and `reconstruct-7d-from-baseline.mjs` are NOT legacy — they remain in the canonical path.

### Legacy `--id-remap` note

The harvest's Phase 3 integer-encoding assigns fresh `art_id` values per harvest. The legacy
audit-JSON writebacks resolve `artwork_id` literally, so **`--id-remap` was mandatory for 1a, 1c, 1d,
1e, 1f, 1h, 7a, 7b, 7c** on a re-harvested DB. Pure rule-based writebacks (1b, 1g, 2a, 2b) don't take
the flag. (The store-driven path is object_number-keyed and needs none of this.)

### Legacy Step 1: LLM writeback scripts

```bash
# 1a. Type classifications (164 events → transfer_type + transfer_category)
node scripts/writeback-type-classifications.mjs --id-remap
# 1b. Transfer category rule (~6,200 events → ambiguous → ownership)   [KEPT — see Step 2]
node scripts/writeback-transfer-category.mjs
# 1c. Position enrichment R1 (~258 parties → party_position)
node scripts/writeback-position-enrichment.mjs --input data/audit/audit-position-enrichment-r1.json --id-remap
# 1d. Position enrichment R2 (~12 parties)
node scripts/writeback-position-enrichment.mjs --input data/audit/audit-position-enrichment-r2.json --id-remap
# 1e. Party disambiguation R1 (~213 disambiguations)
node scripts/writeback-party-disambiguation.mjs --input data/audit/audit-party-disambiguation-r1.json --id-remap
# 1f. Party disambiguation R2 (~154 disambiguations)
node scripts/writeback-party-disambiguation.mjs --input data/audit/audit-party-disambiguation-r2.json --id-remap
# 1g. Residual null-position cleanup (~190 artifact parties deleted)   [KEPT — see Step 2]
node scripts/writeback-residual-nulls.mjs
# 1h. Enrichment reasoning backfill (~6,300 rows)
node scripts/backfill-enrichment-reasoning.mjs
```

### Legacy Step 2: Deterministic writeback scripts  [KEPT — see canonical Step 2]

```bash
node scripts/writeback-unsold-prices.mjs       # 2a
node scripts/writeback-missing-receivers.mjs   # 2b
```

### Legacy Step 4: Manual corrections

Case-by-case fixes (now in the store as `event.manual` / snapshot, source
`scripts/manual-corrections-2026-03-23.csv`).

```sql
-- Item 1: RP-T-00-232(R) — lot number 1346 parsed as year
UPDATE provenance_events SET date_year = NULL, date_expression = NULL,
  enrichment_reasoning = 'Date removed: 1346 is a lot number (no. 1346), not a year. Artwork created 1640-1649.'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'RP-T-00-232(R)') AND sequence = 1;
UPDATE provenance_periods SET begin_year = NULL
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'RP-T-00-232(R)') AND sequence = 1 AND begin_year = 1346;

-- Item 3a: RP-T-1947-25 seq 11 — unsold auction without 'sale' prefix → sale
UPDATE provenance_events SET transfer_type = 'sale', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Auction event at Gilhofer & Ranschburg with lot number — sale context despite missing "sale" prefix.'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'RP-T-1947-25') AND sequence = 11;

-- Item 3b: SK-A-345 seq 2 — false unsold flag on collection event
UPDATE provenance_events SET unsold = 0 WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'SK-A-345') AND sequence = 2;

-- Item 3c: SK-C-128 seq 1 — false unsold flag on loan event
UPDATE provenance_events SET unsold = 0 WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'SK-C-128') AND sequence = 1;

-- Item 4: AK-MAK-179 seq 3 — post-auction sale misclassified as unknown
UPDATE provenance_events SET transfer_type = 'sale', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Reclassified: "bought in by Cassirer from whom, RM. 800, to the Vereniging" is a post-auction sale.'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'AK-MAK-179') AND sequence = 3;

-- Item 5: BK-NM-9720 seq 1 — bibliographic reference
UPDATE provenance_events SET enrichment_reasoning = 'Bibliographic reference (De Gruyter 2010, p. 291) — not a provenance event.'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'BK-NM-9720') AND sequence = 1;

-- Item 6: BK-C-2018-2 seq 1 — object-part cross-reference
UPDATE provenance_events SET is_cross_ref = 1,
  enrichment_reasoning = 'Object-part cross-reference label (BK-KOG-585 top section).'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'BK-C-2018-2') AND sequence = 1;

-- Item 7: E.C. Lorentz — bare name → collection
UPDATE provenance_events SET transfer_type = 'collection', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Bare name in AAM convention — E.C. Lorentz held the artwork before passing it to his niece P. van Gilst.'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'NG-2020-17') AND sequence = 1;

-- Item 8: Charter Room parties — locations, not parties
DELETE FROM provenance_parties WHERE party_name IN ('Charter Room in Leiden Town Hall', 'the Charter Room of this institution');
-- Then rebuild parties JSON for affected events (object_numbers: SK-A-3741, SK-C-1477, SK-A-3742, SK-C-509, SK-A-177)
```

### Legacy Step 5: Credit-line reclassifications

8 credit-line events misclassified as purchase by the credit-line heuristic (the 9th, RP-T-2025-20,
was confirmed correct). Source: commit dd9999c, reconstructed from DB state 2026-04-02.

```sql
-- 5a. RP-T-1967-90 — bare name with Lugt number → collection
UPDATE provenance_events SET transfer_type = 'collection', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Bare name with Lugt number (L.2987) and life dates — AAM convention for a collector/owner. Credit-line heuristic misclassified as purchase.'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'RP-T-1967-90') AND sequence = 1 AND parse_method = 'credit_line';

-- 5b. AK-MAK-361 — exchange, not purchase
UPDATE provenance_events SET transfer_type = 'exchange', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Text explicitly states "partly in exchange for an unknown object". Credit-line heuristic misclassified as purchase.'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'AK-MAK-361') AND sequence = 2 AND parse_method = 'credit_line';

-- 5c. AK-MAK-1293 — citation fragment leak, not a provenance event
UPDATE provenance_events SET transfer_type = 'unknown', transfer_category = 'ambiguous',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Citation fragment leak ("Note RMA.") — not a provenance event. Credit-line heuristic misclassified as purchase.'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'AK-MAK-1293') AND sequence = 4 AND parse_method = 'credit_line';

-- 5d. BK-1970-99 — physical event description, not ownership transfer
UPDATE provenance_events SET transfer_type = 'unknown', transfer_category = 'ambiguous',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Physical event description (pulpit dismantled, 1874) — not an ownership transfer. Credit-line heuristic misclassified as purchase.'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'BK-1970-99') AND sequence = 2 AND parse_method = 'credit_line';

-- 5e. RP-P-1995-1 — bare name with city → collection
UPDATE provenance_events SET transfer_type = 'collection', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Bare name with city (Schweinfurt) — AAM convention for a collector/owner. Credit-line heuristic misclassified as purchase.'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'RP-P-1995-1') AND sequence = 1 AND parse_method = 'credit_line';

-- 5f. RP-P-1997-116 — bare name → collection
UPDATE provenance_events SET transfer_type = 'collection', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Bare name — collector/owner. Credit-line heuristic misclassified as purchase.'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'RP-P-1997-116') AND sequence = 2 AND parse_method = 'credit_line';

-- 5g. BK-NM-10513 — provenance origin from building facade → collection
UPDATE provenance_events SET transfer_type = 'collection', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Uncertain provenance origin from a building facade — describes where the object was found, not a sale. Credit-line heuristic misclassified as purchase.'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'BK-NM-10513') AND sequence = 1 AND parse_method = 'credit_line';

-- 5h. RP-P-2021-37 — bare name → collection
UPDATE provenance_events SET transfer_type = 'collection', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Bare name — collector/owner. Credit-line heuristic misclassified as purchase.'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'RP-P-2021-37') AND sequence = 1 AND parse_method = 'credit_line';

-- 5i. RP-T-2025-20 — confirmed correct (sale to art dealer). No correction needed.
```

### Legacy Step 6: Party corrections from null-position cleanup

7 manual party corrections (3 splits, 2 renames, 1 position assignment, 1 receiver extraction).
Source: commit dd9999c session, reconstructed from DB state 2026-04-02. The Museum Het Broekerhuis
splits and the Reaelen-eiland renames were applied by the LLM disambiguation writebacks (Steps 1e/1f);
the SQL below is only the ad-hoc corrections not covered by any writeback.

```sql
-- 6a. BK-NM-8477 seq 2 — extract receiver "museum" from event text
--     STALE (2026-06-14): this INSERT is a NO-OP. After the #185/Option-B relabel,
--     writeback-missing-receivers (2b) captures this "to the museum" tail as
--     position_method='rule:missing_receiver', so INSERT OR IGNORE changes nothing.
INSERT OR IGNORE INTO provenance_parties (artwork_id, sequence, party_idx, party_name,
  party_role, party_position, position_method, enrichment_reasoning)
VALUES ((SELECT art_id FROM artworks WHERE object_number = 'BK-NM-8477'), 2, 1, 'museum', 'buyer', 'receiver', 'llm_enrichment',
  'Recovered receiver "museum" from a trailing "to [Name]" clause the rule-based parser did not capture.');

-- 6b. NG-2020-17 seq 1 — bare name E.C. Lorentz → receiver
UPDATE provenance_parties SET party_position = 'receiver', position_method = 'llm_enrichment',
  enrichment_reasoning = 'Bare name in unknown event — person who held the artwork (receiver in AAM bare-name convention).'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'NG-2020-17') AND sequence = 1 AND party_name = 'E.C. Lorentz';

-- 6c. SK-A-484 seq 5 — rename price fragment out of party name
UPDATE provenance_parties SET party_name = 'John Smith', party_position = 'agent', position_method = 'llm_enrichment',
  enrichment_reasoning = 'Renamed from "200 gns by the dealer John Smith" — price fragment merged into party name. John Smith is the dealer (agent).'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'SK-A-484') AND sequence = 5 AND party_idx = 0;

-- 6d. SK-A-1928 seq 10 — rename Reaelen-eiland out of party name
UPDATE provenance_parties SET party_name = 'Jan van Andel', party_position = 'receiver', position_method = 'llm_enrichment',
  enrichment_reasoning = 'Renamed from "Reaelen-eiland to Jan van Andel" — Reaelen-eiland is a location/estate, Jan van Andel is the buyer.'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'SK-A-1928') AND sequence = 10 AND party_idx = 0;

-- 6e. SK-A-1928 seq 11 — rename Realen-eiland out of party name
UPDATE provenance_parties SET party_name = 'Gerrit Gijsbertus van den Andel', party_position = 'receiver', position_method = 'llm_enrichment',
  enrichment_reasoning = 'Renamed from "Realen-eiland to his son Gerrit Gijsbertus van den Andel" — Realen-eiland is a location/estate, Gerrit Gijsbertus van den Andel is the heir.'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'SK-A-1928') AND sequence = 11 AND party_idx = 0;

-- 6f. BK-NM-8476 — Zierikzee city name → receiver
UPDATE provenance_parties SET party_position = 'receiver', position_method = 'llm_enrichment',
  enrichment_reasoning = 'Zierikzee is a city name; per AAM bare-name convention + the subsequent donation, it indicates prior ownership/holding (receiver/holder).'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'BK-NM-8476') AND sequence = 1 AND party_name = 'Zierikzee';
```

### Legacy Step 7: LLM structural corrections

Use the `*-v0.24-2026-04-19.json` results-format JSONs (the `2026-03-25` files are dry-run packages
with key `requests` only and fail with `data.results is not iterable`). Order: field corrections →
party extraction (7d) → reclassifications → splits (renumber last).

```bash
# 7a. Field corrections: locations + missing receivers (~250 events)
node scripts/writeback-field-corrections.mjs \
  --input data/audit/audit-field-correction-v0.24-2026-04-19.json --id-remap

# 7d. Party extraction — KEPT in the canonical path as Step 4 (reconstruct-from-baseline).
node scripts/reconstruct-7d-from-baseline.mjs --base <previous-deploy>.db --apply
#     FALLBACK only if no prior DB exists (first-ever 7d) — regenerate via the API, then feed
#     through the field-corrections writeback:
#       ANTHROPIC_API_KEY=$(eval $(grep ANTHROPIC_API_KEY ~/.env | head -1) && echo "$ANTHROPIC_API_KEY") \
#         node scripts/audit-provenance-batch.mjs --mode party-extraction --sample-size 200
#       node scripts/writeback-field-corrections.mjs --input data/audit/audit-party-extraction-<DATE>.json --id-remap

# 7b. Event reclassifications: phantoms, location-as-event, alternatives (~70 events)
node scripts/writeback-event-reclassification.mjs \
  --input data/audit/audit-event-reclassification-v0.24-2026-04-19.json --id-remap

# 7c. Event splits: multi-transfer, bequest chain, gap bridge (~90 artworks → ~620 events)
node scripts/writeback-event-splitting.mjs \
  --input data/audit/audit-event-splitting-v0.24-2026-04-19.json --id-remap
```

**Order rationale:** 7a modifies fields (safe). 7d adds parties to event with none (safe). 7b
deletes/merges events. 7c renumbers sequences per artwork (must run last). The legacy writebacks
filter the audits at `--min-confidence 0.7` (splitting also requires `replacement_events >= 2`) — the
store extractor now mirrors these exact gates (plan 015 structural fix).

## Revision history

- **2026-06-14 (plan 015 Phase 3.2 — store-driven cutover)**: made the content-addressed
  `reapply-enrichments-from-store.mjs` the canonical Step 1, subsuming the legacy 1a/1c/1d/1e/1f/1h +
  Steps 4/5/6 + 7a/7b/7c. Kept the rule-based writebacks (1b/1g/2a/2b), the Step-3 SQL, and 7d
  (`reconstruct-7d-from-baseline`) in the canonical path; demoted the position-keyed writebacks to a
  retained Legacy fallback. Added the store precondition, dropped `--id-remap` from the canonical
  path (object_number-keyed), and added the store-parity verifier to Verification. Validated by the
  Phase 3.2 dress-rehearsal (`plans/provenance-enrichment-structural-confidence-leak.md`).
- **2026-06-14**: added two verification tiers beyond the SQL counts — the property-based invariant
  scanners (before+after, after-≤-baseline gate) and the per-record parse-regression snapshot diff
  (`field_drift`+`removed` review-queue gate).
- **2026-04-30** (v0.26 dress-rehearsal harvest reparse): added `--id-remap` guidance, corrected
  7a/7b/7c to the v0.24-2026-04-19 results-format JSONs, reframed verification targets as ranges.
- **2026-04-30 (later)**: closed #285 by patching `writeback-position-enrichment.mjs` and
  `writeback-type-classifications.mjs` to write `enrichment_reasoning`; target #6 tightened to 0–10.
