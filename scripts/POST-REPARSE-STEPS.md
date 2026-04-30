# Post-Reparse Steps

After a full `batch-parse-provenance.mjs` re-parse, the following must be re-applied in order. The re-parse drops and recreates `provenance_events` and `provenance_parties`, wiping all post-parse enrichments.

## Order matters

Steps must run sequentially — later steps depend on earlier ones.

## After re-harvests: `--id-remap` is mandatory

The harvest's Phase 3 integer-encoding assigns fresh `art_id` values per harvest. Audit JSONs reference both the v0.25-era `artwork_id` AND the stable `object_number`. Without `--id-remap`, writebacks resolve `artwork_id` literally and corrupt rows belonging to whichever artworks happened to land at those integer IDs in the new harvest. **Always pass `--id-remap` when applying audit-JSON-driven writebacks (1a, 1c, 1d, 1e, 1f, 1h, 7a, 7b, 7c) to a re-harvested DB.** Pure rule-based writebacks (1b, 1g, 2a, 2b) don't take the flag — they don't reference audit-JSON IDs.

## Step 1: LLM writeback scripts

These restore LLM-classified data from audit JSON files:

```bash
# 1a. Type classifications (164 events → transfer_type + transfer_category)
node scripts/writeback-type-classifications.mjs --id-remap

# 1b. Transfer category rule (~6,200 events → ambiguous → ownership)
node scripts/writeback-transfer-category.mjs

# 1c. Position enrichment R1 (~258 parties → party_position)
node scripts/writeback-position-enrichment.mjs --input data/audit/audit-position-enrichment-r1.json --id-remap

# 1d. Position enrichment R2 (~12 parties)
node scripts/writeback-position-enrichment.mjs --input data/audit/audit-position-enrichment-r2.json --id-remap

# 1e. Party disambiguation R1 (~213 disambiguations)
node scripts/writeback-party-disambiguation.mjs --input data/audit/audit-party-disambiguation-r1.json --id-remap

# 1f. Party disambiguation R2 (~154 disambiguations)
node scripts/writeback-party-disambiguation.mjs --input data/audit/audit-party-disambiguation-r2.json --id-remap

# 1g. Residual null-position cleanup (~190 artifact parties deleted)
node scripts/writeback-residual-nulls.mjs

# 1h. Enrichment reasoning backfill (~6,300 rows)
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

## Step 3: Batch price flag — REDUNDANT after Step 0

Skip this step when you've just run `batch-parse-provenance.mjs` (Step 0). The PEG parser sets `batch_price` directly during reparse via `BATCH_PRICE_RE` in `src/provenance-peg.ts:29`, covering both priced and unpriced text-pattern matches (~17K rows total; ~3,900 of those carry a parsed price).

The SQL below remains useful only when you need to populate `batch_price` on an existing DB **without** doing a Step 0 reparse — e.g. patching an old DB where the column was added later. Running it after Step 0 re-flags a subset of already-flagged rows (no harm, no useful work).

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

## Step 5: Credit-line reclassifications

8 credit-line events misclassified as purchase by the credit-line heuristic. The 9th
(artwork_id=813082, RP-T-2025-20) was confirmed correct and needs no correction.
Source: commit dd9999c, reconstructed from DB state 2026-04-02.

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
-- object_number = RP-T-2025-20, sequence = 2.
```

## Step 6: Party corrections from null-position cleanup

7 manual party corrections (3 splits, 2 renames, 1 position assignment, 1 receiver extraction).
Source: commit dd9999c session, reconstructed from DB state 2026-04-02.

Note: the Museum Het Broekerhuis splits (14945/14947/14948) and the Reaelen-eiland renames
(194553) were applied by the LLM disambiguation writeback scripts (Steps 1e/1f), not ad-hoc SQL.
They will be restored automatically when those writebacks re-run. The corrections below are the
ones that were applied as ad-hoc SQL and are NOT covered by any writeback script.

```sql
-- 6a. BK-NM-8477 seq 2 — extract receiver "museum" from event text
--     Parser's parseRest() missed the tail party "to the museum".
INSERT OR IGNORE INTO provenance_parties (artwork_id, sequence, party_idx, party_name,
  party_role, party_position, position_method, enrichment_reasoning)
VALUES ((SELECT art_id FROM artworks WHERE object_number = 'BK-NM-8477'), 2, 1, 'museum', 'buyer', 'receiver', 'llm_enrichment',
  'Extracted from event text: receiver "museum" found in "to the/to [Name]" pattern. Parser''s parseRest() missed this tail party.');

-- 6b. NG-2020-17 seq 1 — bare name E.C. Lorentz → receiver
UPDATE provenance_parties SET party_position = 'receiver',
  position_method = 'llm_enrichment',
  enrichment_reasoning = 'Bare name in unknown event — person who held the artwork (receiver in AAM bare-name convention).'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'NG-2020-17') AND sequence = 1 AND party_name = 'E.C. Lorentz';

-- 6c. SK-A-484 seq 5 — rename price fragment out of party name
UPDATE provenance_parties SET party_name = 'John Smith',
  party_position = 'agent', position_method = 'llm_enrichment',
  enrichment_reasoning = 'Renamed from "200 gns by the dealer John Smith" — price fragment (200 gns) merged into party name by parser. John Smith is the dealer (agent).'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'SK-A-484') AND sequence = 5 AND party_idx = 0;

-- 6d. SK-A-1928 seq 10 — rename Reaelen-eiland out of party name
UPDATE provenance_parties SET party_name = 'Jan van Andel',
  party_position = 'receiver', position_method = 'llm_enrichment',
  enrichment_reasoning = 'Renamed from "Reaelen-eiland to Jan van Andel" — Reaelen-eiland is a location/estate ("sold with Reaelen-eiland"), Jan van Andel (Burgomaster of Vreeland) is the buyer.'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'SK-A-1928') AND sequence = 10 AND party_idx = 0;

-- 6e. SK-A-1928 seq 11 — rename Realen-eiland out of party name
UPDATE provenance_parties SET party_name = 'Gerrit Gijsbertus van den Andel',
  party_position = 'receiver', position_method = 'llm_enrichment',
  enrichment_reasoning = 'Renamed from "Realen-eiland to his son Gerrit Gijsbertus van den Andel" — Realen-eiland is a location/estate, Gerrit Gijsbertus van den Andel is the heir ("his son").'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'SK-A-1928') AND sequence = 11 AND party_idx = 0;

-- 6f. BK-NM-8476 — Zierikzee city name → receiver
--     Zierikzee is a city, not a person, but in AAM bare-name convention it indicates
--     prior ownership/holding. Assigned position rather than deleted.
UPDATE provenance_parties SET party_position = 'receiver',
  position_method = 'llm_enrichment',
  enrichment_reasoning = 'Zierikzee is a city name. Given the AAM bare-name convention and the subsequent donation event suggesting prior ownership, this likely indicates the artwork was held/owned by someone in Zierikzee. Following AAM convention, the named location represents the receiver/holder.'
WHERE artwork_id = (SELECT art_id FROM artworks WHERE object_number = 'BK-NM-8476') AND sequence = 1 AND party_name = 'Zierikzee';
```

## Step 7: LLM structural corrections

These restore LLM-based structural corrections from audit JSON files.
Order within: field corrections first (don't depend on sequence numbers),
then party extraction (adds parties to existing events), then reclassifications
(may delete events), then splits (renumber sequences).

**Use the v0.24-2026-04-19 results-format JSONs, NOT the 2026-03-25 dry-run files.**
The `2026-03-25` files in `data/audit/` are staged-but-unrun batch packages
with key `requests` (LLM prompts only, no responses). The writeback scripts
expect key `results` (LLM-completed responses) — passing a dry-run file fails
with `TypeError: data.results is not iterable`. The real completed runs are
the `*-v0.24-2026-04-19.json` files (10–70× larger).

```bash
# 7a. Field corrections: locations + missing receivers (~250 events)
node scripts/writeback-field-corrections.mjs \
  --input data/audit/audit-field-correction-v0.24-2026-04-19.json --id-remap

# 7d. Party extraction: extract parties from events with 0 extracted parties (#116 edge cases)
#     ON-DEMAND: no static audit JSON exists. Generate via
#       ANTHROPIC_API_KEY=$(eval $(grep ANTHROPIC_API_KEY ~/.env | head -1) && echo "$ANTHROPIC_API_KEY") \
#         node scripts/audit-provenance-batch.mjs --mode party-extraction --sample-size 200
#     Then feed through field-corrections writeback:
node scripts/writeback-field-corrections.mjs \
  --input data/audit/audit-party-extraction-<DATE>.json --id-remap

# 7b. Event reclassifications: phantoms, location-as-event, alternatives (~70 events)
node scripts/writeback-event-reclassification.mjs \
  --input data/audit/audit-event-reclassification-v0.24-2026-04-19.json --id-remap

# 7c. Event splits: multi-transfer, bequest chain, gap bridge (~90 artworks → ~620 events)
node scripts/writeback-event-splitting.mjs \
  --input data/audit/audit-event-splitting-v0.24-2026-04-19.json --id-remap
```

**Order rationale:** 7a modifies fields on existing events (safe). 7d adds parties to events with no parties (safe, same writeback as 7a). 7b deletes/merges events (may affect event counts but not sequences used by 7c). 7c renumbers sequences per artwork (must run last because it rebuilds the sequence space).

**Generating 7d audit JSON:**
```bash
ANTHROPIC_API_KEY=$(eval $(grep ANTHROPIC_API_KEY ~/.env | head -1) && echo "$ANTHROPIC_API_KEY") \
  node scripts/audit-provenance-batch.mjs --mode party-extraction --sample-size 200
```

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
percent because the upstream OAI-PMH stream changes (new artworks, edited
provenance text, refined PEG grammar). Hard zeros (orphan parties, duplicate
sequences, corrected-no-reasoning) are the real correctness invariants;
everything else is sanity-band.

| # | Query | Target range | v0.26 observed (2026-04-30) | Notes |
|---|---|---|---|---|
| 1 | `unknown` non-cross-ref events | 3–25 | 15 | Step 7d would tighten this if regenerated; 3 is the v0.25 floor with full 7d applied |
| 2 | Null-position parties | 0–30 | 22 | Edge cases the rule-based 1g can't classify; 0 only achievable with full 7d |
| 3 | Unsold events | 660–680 | 665 | Stable across re-harvests |
| 4 | Batch-price events with parsed price | 3,700–4,100 | 3,900 | The "real" batch_price metric — text-pattern matches that also have a parsed price |
| 5 | Total `batch_price = 1` | 15K–18K | 17,076 | Includes parser-set rows where text matched but no price was extracted |
| 6 | Parties missing `enrichment_reasoning` (where `position_method LIKE 'llm%'`) | 0–300 | 235 | Audit JSONs that didn't carry reasoning strings; non-fatal |
| 7 | Orphaned parties (party with no matching event) | **0** | 0 | Hard invariant |
| 8 | Duplicate `(artwork_id, sequence)` | **0** | 0 | Hard invariant |
| 9 | Corrected events without reasoning | **0** | 0 | Hard invariant |
| 10 | Total events / parties / periods | 100K / 90K / 80K (±5%) | 101,171 / 90,696 / 81,207 | Should track artwork count linearly |

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

-- Structural corrections applied (Step 7)
SELECT correction_method, COUNT(*) FROM provenance_events
WHERE correction_method IS NOT NULL GROUP BY 1;

-- 7. No orphaned parties after event deletions/splits — HARD INVARIANT
SELECT COUNT(*) FROM provenance_parties pp
WHERE NOT EXISTS (SELECT 1 FROM provenance_events pe
  WHERE pe.artwork_id = pp.artwork_id AND pe.sequence = pp.sequence);

-- 8. Sequence integrity (no duplicates after splits) — HARD INVARIANT
SELECT artwork_id FROM provenance_events
GROUP BY artwork_id, sequence HAVING COUNT(*) > 1;

-- 9. All corrected events have reasoning — HARD INVARIANT
SELECT COUNT(*) FROM provenance_events
WHERE correction_method IS NOT NULL AND enrichment_reasoning IS NULL;

-- 10. Totals
SELECT 'events' AS table_name, COUNT(*) FROM provenance_events UNION ALL
SELECT 'parties', COUNT(*) FROM provenance_parties UNION ALL
SELECT 'periods', COUNT(*) FROM provenance_periods;
```

## Revision history

- **2026-04-30** (v0.26 dress-rehearsal harvest reparse): added `--id-remap`
  guidance, flagged Step 3 SQL as redundant after Step 0 (the parser sets
  `batch_price` directly), corrected 7a/7b/7c to point at the v0.24-2026-04-19
  results-format JSONs (the 2026-03-25 files are dry-run packages without
  responses), reframed verification targets as ranges with a v0.26-observed
  column.
