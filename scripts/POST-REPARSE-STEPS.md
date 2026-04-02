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
node scripts/writeback-position-enrichment.mjs --input data/audit/audit-position-enrichment-r1.json

# 1d. Position enrichment R2 (12 parties)
node scripts/writeback-position-enrichment.mjs --input data/audit/audit-position-enrichment-r2.json

# 1e. Party disambiguation R1 (213 disambiguations)
node scripts/writeback-party-disambiguation.mjs --input data/audit/audit-party-disambiguation-r1.json

# 1f. Party disambiguation R2 (154 disambiguations)
node scripts/writeback-party-disambiguation.mjs --input data/audit/audit-party-disambiguation-r2.json

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

8 credit-line events misclassified as purchase by the credit-line heuristic. The 9th
(artwork_id=813082, RP-T-2025-20) was confirmed correct and needs no correction.
Source: commit dd9999c, reconstructed from DB state 2026-04-02.

```sql
-- 5a. RP-T-1967-90 — bare name with Lugt number → collection
UPDATE provenance_events SET transfer_type = 'collection', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Bare name with Lugt number (L.2987) and life dates — AAM convention for a collector/owner. Credit-line heuristic misclassified as purchase.'
WHERE artwork_id = 21712 AND sequence = 1 AND parse_method = 'credit_line';

-- 5b. AK-MAK-361 — exchange, not purchase
UPDATE provenance_events SET transfer_type = 'exchange', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Text explicitly states "partly in exchange for an unknown object". Credit-line heuristic misclassified as purchase.'
WHERE artwork_id = 148342 AND sequence = 2 AND parse_method = 'credit_line';

-- 5c. AK-MAK-1293 — citation fragment leak, not a provenance event
UPDATE provenance_events SET transfer_type = 'unknown', transfer_category = 'ambiguous',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Citation fragment leak ("Note RMA.") — not a provenance event. Credit-line heuristic misclassified as purchase.'
WHERE artwork_id = 150495 AND sequence = 4 AND parse_method = 'credit_line';

-- 5d. BK-1970-99 — physical event description, not ownership transfer
UPDATE provenance_events SET transfer_type = 'unknown', transfer_category = 'ambiguous',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Physical event description (pulpit dismantled, 1874) — not an ownership transfer. Credit-line heuristic misclassified as purchase.'
WHERE artwork_id = 275981 AND sequence = 2 AND parse_method = 'credit_line';

-- 5e. RP-P-1995-1 — bare name with city → collection
UPDATE provenance_events SET transfer_type = 'collection', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Bare name with city (Schweinfurt) — AAM convention for a collector/owner. Credit-line heuristic misclassified as purchase.'
WHERE artwork_id = 291046 AND sequence = 1 AND parse_method = 'credit_line';

-- 5f. RP-P-1997-116 — bare name → collection
UPDATE provenance_events SET transfer_type = 'collection', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Bare name — collector/owner. Credit-line heuristic misclassified as purchase.'
WHERE artwork_id = 329004 AND sequence = 2 AND parse_method = 'credit_line';

-- 5g. BK-NM-10513 — provenance origin from building facade → collection
UPDATE provenance_events SET transfer_type = 'collection', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Uncertain provenance origin from a building facade — describes where the object was found, not a sale. Credit-line heuristic misclassified as purchase.'
WHERE artwork_id = 556616 AND sequence = 1 AND parse_method = 'credit_line';

-- 5h. RP-P-2021-37 — bare name → collection
UPDATE provenance_events SET transfer_type = 'collection', transfer_category = 'ownership',
  category_method = 'llm_enrichment',
  enrichment_reasoning = 'Bare name — collector/owner. Credit-line heuristic misclassified as purchase.'
WHERE artwork_id = 727109 AND sequence = 1 AND parse_method = 'credit_line';

-- 5i. RP-T-2025-20 — confirmed correct (sale to art dealer). No correction needed.
-- artwork_id = 813082, sequence = 2.
```

## Step 6: Party corrections from null-position cleanup

7 manual party corrections (3 splits, 2 renames, 1 position assignment, 1 receiver extraction).
Source: commit dd9999c session, reconstructed from DB state 2026-04-02.

Note: the Museum Het Broekerhuis splits (14945/14947/14948) and the Reaelen-eiland renames
(194553) were applied by the LLM disambiguation writeback scripts (Steps 1e/1f), not ad-hoc SQL.
They will be restored automatically when those writebacks re-run. The corrections below are the
ones that were applied as ad-hoc SQL and are NOT covered by any writeback script.

```sql
-- 6a. BK-NM-8477 (artwork_id=50272) seq 2 — extract receiver "museum" from event text
--     Parser's parseRest() missed the tail party "to the museum".
INSERT OR IGNORE INTO provenance_parties (artwork_id, sequence, party_idx, party_name,
  party_role, party_position, position_method, enrichment_reasoning)
VALUES (50272, 2, 1, 'museum', 'buyer', 'receiver', 'llm_enrichment',
  'Extracted from event text: receiver "museum" found in "to the/to [Name]" pattern. Parser''s parseRest() missed this tail party.');

-- 6b. NG-2020-17 (artwork_id=118239) seq 1 — bare name E.C. Lorentz → receiver
UPDATE provenance_parties SET party_position = 'receiver',
  position_method = 'llm_enrichment',
  enrichment_reasoning = 'Bare name in unknown event — person who held the artwork (receiver in AAM bare-name convention).'
WHERE artwork_id = 118239 AND sequence = 1 AND party_name = 'E.C. Lorentz';

-- 6c. SK-A-484 (artwork_id=182809) seq 5 — rename price fragment out of party name
UPDATE provenance_parties SET party_name = 'John Smith',
  party_position = 'agent', position_method = 'llm_enrichment',
  enrichment_reasoning = 'Renamed from "200 gns by the dealer John Smith" — price fragment (200 gns) merged into party name by parser. John Smith is the dealer (agent).'
WHERE artwork_id = 182809 AND sequence = 5 AND party_idx = 0;

-- 6d. SK-A-1928 (artwork_id=194553) seq 10 — rename Reaelen-eiland out of party name
UPDATE provenance_parties SET party_name = 'Jan van Andel',
  party_position = 'receiver', position_method = 'llm_enrichment',
  enrichment_reasoning = 'Renamed from "Reaelen-eiland to Jan van Andel" — Reaelen-eiland is a location/estate ("sold with Reaelen-eiland"), Jan van Andel (Burgomaster of Vreeland) is the buyer.'
WHERE artwork_id = 194553 AND sequence = 10 AND party_idx = 0;

-- 6e. SK-A-1928 (artwork_id=194553) seq 11 — rename Realen-eiland out of party name
UPDATE provenance_parties SET party_name = 'Gerrit Gijsbertus van den Andel',
  party_position = 'receiver', position_method = 'llm_enrichment',
  enrichment_reasoning = 'Renamed from "Realen-eiland to his son Gerrit Gijsbertus van den Andel" — Realen-eiland is a location/estate, Gerrit Gijsbertus van den Andel is the heir ("his son").'
WHERE artwork_id = 194553 AND sequence = 11 AND party_idx = 0;

-- 6f. BK-NM-8476 (artwork_id=50261) — Zierikzee city name → receiver
--     Zierikzee is a city, not a person, but in AAM bare-name convention it indicates
--     prior ownership/holding. Assigned position rather than deleted.
UPDATE provenance_parties SET party_position = 'receiver',
  position_method = 'llm_enrichment',
  enrichment_reasoning = 'Zierikzee is a city name. Given the AAM bare-name convention and the subsequent donation event suggesting prior ownership, this likely indicates the artwork was held/owned by someone in Zierikzee. Following AAM convention, the named location represents the receiver/holder.'
WHERE artwork_id = 50261 AND sequence = 1 AND party_name = 'Zierikzee';
```

## Step 7: LLM structural corrections

These restore LLM-based structural corrections from audit JSON files.
Order within: field corrections first (don't depend on sequence numbers),
then reclassifications (may delete events), then splits (renumber sequences).

```bash
# 7a. Field corrections: locations + missing receivers (~55 events)
node scripts/writeback-field-corrections.mjs --input data/audit/audit-field-correction-2026-03-25.json

# 7b. Event reclassifications: phantoms, location-as-event, alternatives (~25 events)
node scripts/writeback-event-reclassification.mjs --input data/audit/audit-event-reclassification-2026-03-25.json

# 7c. Event splits: multi-transfer, bequest chain, gap bridge (~50 events)
node scripts/writeback-event-splitting.mjs --input data/audit/audit-event-splitting-2026-03-25.json
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
