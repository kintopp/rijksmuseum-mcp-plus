# Post-Reparse Steps

After a full `batch-parse-provenance.mjs` re-parse, the following must be re-applied in order. The re-parse drops and recreates `provenance_events` and `provenance_parties`, wiping all post-parse enrichments.

## Order matters

Steps must run sequentially — later steps depend on earlier ones.

## Step 1: LLM writeback scripts

These restore LLM-classified data from audit JSON files:

```bash
# 1a. Type classifications (170 events → transfer_type + transfer_category)
node scripts/writeback-type-classifications.mjs

# 1b. Transfer category rule (6,233 events → ambiguous → ownership)
node scripts/writeback-transfer-category.mjs

# 1c. Position enrichment R1 (258 parties → party_position)
node scripts/writeback-position-enrichment.mjs --input data/audit-position-enrichment-r1.json

# 1d. Position enrichment R2 (12 parties)
node scripts/writeback-position-enrichment.mjs --input data/audit-position-enrichment-r2.json

# 1e. Party disambiguation R1 (213 disambiguations)
node scripts/writeback-party-disambiguation.mjs --input data/audit-party-disambiguation-r1.json

# 1f. Party disambiguation R2 (154 disambiguations)
node scripts/writeback-party-disambiguation.mjs --input data/audit-party-disambiguation-r2.json

# 1g. Residual null-position cleanup (121+ artifact parties deleted)
node scripts/writeback-residual-nulls.mjs

# 1h. Enrichment reasoning backfill (7,182 rows)
node scripts/backfill-enrichment-reasoning.mjs
```

## Step 2: Deterministic writeback scripts

These extract metadata from event text — no LLM needed:

```bash
# 2a. Unsold prices — "bought in at fl. X" (598 events)
node scripts/writeback-unsold-prices.mjs

# 2b. Missing receivers — "to the [Name]" tail parties (793 parties)
node scripts/writeback-missing-receivers.mjs
```

## Step 3: Batch price flag

The `batch_price` column is created by the re-parse schema, but detection is also in the parser code. If the column needs to be populated on an existing DB without re-parse:

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

## Step 4: Manual corrections

These are case-by-case fixes that no script covers. Source: `scripts/manual-corrections-2026-03-23.csv`.

```sql
-- Item 1: RP-T-00-232(R) — lot number 1346 parsed as year
UPDATE provenance_events SET date_year = NULL, date_expression = NULL,
  enrichment_reasoning = 'Date removed: 1346 is a lot number (no. 1346), not a year. Artwork created 1640-1649.'
WHERE artwork_id = 44310 AND sequence = 1;
UPDATE provenance_periods SET begin_year = NULL
WHERE artwork_id = 44310 AND sequence = 1 AND begin_year = 1346;

-- Item 3a: RP-T-1947-25 seq 11 — unsold auction without 'sale' prefix → sale
UPDATE provenance_events SET transfer_type = 'sale', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Auction event at Gilhofer & Ranschburg with lot number — sale context despite missing "sale" prefix.'
WHERE artwork_id = 13609 AND sequence = 11;

-- Item 3b: SK-A-345 seq 2 — false unsold flag on collection event
UPDATE provenance_events SET unsold = 0 WHERE artwork_id = 173085 AND sequence = 2;

-- Item 3c: SK-C-128 seq 1 — false unsold flag on loan event
UPDATE provenance_events SET unsold = 0 WHERE artwork_id = 190572 AND sequence = 1;

-- Item 4: AK-MAK-179 seq 3 — post-auction sale misclassified as unknown
UPDATE provenance_events SET transfer_type = 'sale', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Reclassified: "bought in by Cassirer from whom, RM. 800, to the Vereniging" is a post-auction sale.'
WHERE artwork_id = 152446 AND sequence = 3;

-- Item 5: BK-NM-9720 seq 1 — bibliographic reference
UPDATE provenance_events SET enrichment_reasoning = 'Bibliographic reference (De Gruyter 2010, p. 291) — not a provenance event.'
WHERE artwork_id = 277996 AND sequence = 1;

-- Item 6: BK-C-2018-2 seq 1 — object-part cross-reference
UPDATE provenance_events SET is_cross_ref = 1,
  enrichment_reasoning = 'Object-part cross-reference label (BK-KOG-585 top section).'
WHERE artwork_id = 816454 AND sequence = 1;

-- Item 7: E.C. Lorentz — bare name → collection
UPDATE provenance_events SET transfer_type = 'collection', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Bare name in AAM convention — E.C. Lorentz held the artwork before passing it to his niece P. van Gilst.'
WHERE artwork_id = 118239 AND sequence = 1;

-- Item 8: Charter Room parties — locations, not parties
DELETE FROM provenance_parties WHERE party_name IN ('Charter Room in Leiden Town Hall', 'the Charter Room of this institution');
-- Then rebuild parties JSON for affected events (artwork_ids: 10076, 10991, 199081, 204376, 8606)
```

## Step 5: Credit-line reclassifications

9 credit-line events misclassified as sale. Source: commit dd9999c.

```sql
-- See commit dd9999c for full SQL (9 UPDATE statements on artwork_ids:
-- 21712, 148342, 150495, 275981, 291046, 329004, 556616, 727109, 813082)
```

## Step 6: Party corrections from null-position cleanup

10 manual party corrections (splits, renames, deletes). Source: commit dd9999c session.

```sql
-- See conversation log 2026-03-23 for full SQL covering:
-- 14945/14947/14948 (Museum Het Broekerhuis split)
-- 50272 (Zierikzee city-name delete)
-- 118239 (E.C. Lorentz → receiver)
-- 182809 (John Smith rename from price fragment)
-- 194553 seq 8-11 (Huys te Nigtevegt / Reaelen-eiland corrections)
```

## Step 7: LLM structural corrections

These restore LLM-based structural corrections from audit JSON files.
Order within: field corrections first (don't depend on sequence numbers),
then reclassifications (may delete events), then splits (renumber sequences).

```bash
# 7a. Field corrections: locations + missing receivers (~55 events)
node scripts/writeback-field-corrections.mjs --input data/audit-field-correction-YYYY-MM-DD.json

# 7b. Event reclassifications: phantoms, location-as-event, alternatives (~25 events)
node scripts/writeback-event-reclassification.mjs --input data/audit-event-reclassification-YYYY-MM-DD.json

# 7c. Event splits: multi-transfer, bequest chain, gap bridge (~50 events)
node scripts/writeback-event-splitting.mjs --input data/audit-event-splitting-YYYY-MM-DD.json
```

**Order rationale:** 7a modifies fields on existing events (safe). 7b deletes/merges events (may affect event counts but not sequences used by 7c). 7c renumbers sequences per artwork (must run last because it rebuilds the sequence space).

## Verification

After all steps, verify:

```sql
-- Non-cross-ref unknowns should be 3
SELECT COUNT(*) FROM provenance_events WHERE transfer_type = 'unknown' AND is_cross_ref = 0;

-- Null-position parties should be 0
SELECT COUNT(*) FROM provenance_parties WHERE party_position IS NULL AND position_method IS NULL;

-- Unsold events should be 666 (663 sale + 3 edge cases)
SELECT COUNT(*) FROM provenance_events WHERE unsold = 1;

-- Batch prices should be ~3,769
SELECT COUNT(*) FROM provenance_events WHERE batch_price = 1;

-- Enrichment reasoning coverage should be full
SELECT COUNT(*) FROM provenance_parties WHERE position_method LIKE 'llm%' AND enrichment_reasoning IS NULL;
-- Should be 0

-- Structural corrections applied (Step 7)
SELECT correction_method, COUNT(*) FROM provenance_events
WHERE correction_method IS NOT NULL GROUP BY 1;

-- No orphaned parties after event deletions/splits
SELECT COUNT(*) FROM provenance_parties pp
WHERE NOT EXISTS (SELECT 1 FROM provenance_events pe
  WHERE pe.artwork_id = pp.artwork_id AND pe.sequence = pp.sequence);
-- Should be 0

-- Sequence integrity (no duplicates after splits)
SELECT artwork_id FROM provenance_events
GROUP BY artwork_id, sequence HAVING COUNT(*) > 1;
-- Should be 0

-- All corrected events have reasoning
SELECT COUNT(*) FROM provenance_events
WHERE correction_method IS NOT NULL AND enrichment_reasoning IS NULL;
-- Should be 0
```
