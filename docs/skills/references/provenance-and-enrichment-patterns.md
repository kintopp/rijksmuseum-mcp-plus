# Provenance Data Model and Query Patterns

Reference material for `search_provenance`. Consult this file when you need to
interpret raw provenance text, understand the data model, or construct
specialised query patterns beyond the examples in the main skill.

> **v0.3.0 audit status (2026-05-03):** the CMOA/AAM data model is unchanged. Coverage counts re-derived from the v0.27-RC1 vocab DB (~360K artworks with `creditLine` vs ~49K with parsed provenance). `parseMethod` shares re-confirmed (peg 80.1% / cross_ref 19.6% / llm_structural 0.2% / credit_line 0.1%). Audit-trail vocabulary cross-reference added. Items still flagged for live spot-tests:
> - **`hasGap` + `dateFrom`/`dateTo` interaction** — verify artwork-level vs event-level filtering described under "Wartime provenance".
> - **`transferType=["by_descent","widowhood"]` + `layer="periods"`** — verify end-to-end parse against current `search_provenance` implementation.

## Contents

1. [Provenance Text Format (AAM Standard)](#provenance-text-format-aam-standard)
2. [Transfer Types (CMOA/PLOD-aligned Vocabulary)](#transfer-types-cmoaplod-aligned-vocabulary)
3. [Party Roles and Positions](#party-roles-and-positions)
4. [Date Representation](#date-representation)
5. [Historical Currencies](#historical-currencies)
6. [Enrichment Provenance](#enrichment-provenance)
7. [Parse Method Values](#parse-method-values)
8. [Provenance Facets](#provenance-facets)
9. [Tested Query Patterns](#tested-query-patterns)

---

## Provenance Text Format (AAM Standard)

The Rijksmuseum's provenance text follows the **AAM (American Alliance of
Museums) standard** for provenance notation:

- **Semicolon-delimited events**: each ownership change is separated by `;` — `Owner A, City, date; Owner B, City, date`
- **Chronological order**: earliest known owner first, current holder last
- **Bare names = ownership**: a name without a transfer keyword (e.g. `Pieter Six (1618–1707), Amsterdam`) indicates an ownership period — classified as `collection`
- **Ellipsis = gap**: `…` or `...` marks a gap in the documented chain
- **Curly braces = citations**: `{Bredius 1935, p. 47}` are bibliographic references, not provenance events
- **Question mark = uncertainty**: `? sale, Amsterdam, 1804` — the transfer or attribution is uncertain
- **Cross-references**: `(see also SK-A-3137)` links to pendant or companion works that share provenance
- **Life dates**: `Name (1650–1720)` — dates in parentheses after a name are birth–death years, not event dates

The Rijksmuseum extends the AAM standard with Dutch-language keywords
(`schenking` = gift, `bruikleen` = loan, `verwerving` = acquisition,
`aangekocht` = purchased) and institutional conventions (`Inv.` = inventory
reference, `L.` = Lugt collector mark number).

---

## Transfer Types (CMOA/PLOD-aligned Vocabulary)

Transfer types follow the **CMOA Art Tracks thesaurus** (Carnegie Museum of
Art, [github.com/cmoa/art-tracks](https://github.com/cmoa/art-tracks)),
aligned with the **PLOD framework** (Art Institute of Chicago).

| Type | Category | Description |
|------|----------|-------------|
| `sale` | ownership | Sale, purchase, or auction (includes "purchased by", "acquired from"). Includes unsold lots — check `unsold` flag. |
| `by_descent` | ownership | Inheritance to a named relative (son, daughter, nephew, heir, etc.) |
| `widowhood` | ownership | Inheritance specifically to a widow or widower |
| `inheritance` | ownership | Generic inheritance (no specific relationship identified) |
| `bequest` | ownership | Testamentary gift |
| `gift` | ownership | Donation, gift, or presentation |
| `commission` | ownership | Commissioned creation |
| `exchange` | ownership | Exchange or swap |
| `confiscation` | ownership | Seized by authority |
| `theft` | ownership | Stolen |
| `looting` | ownership | Looted (wartime) |
| `recuperation` | ownership | Recovered by Allied forces (post-WWII, distinct from restitution) |
| `restitution` | ownership | Legally returned to original owner |
| `collection` | ownership | Bare-name ownership period (AAM convention — no transfer keyword) |
| `inventory` | ownership | Documented in an estate inventory or attestation |
| `loan` | custody | On loan (temporary custody, no ownership change) |
| `deposit` | custody | On deposit or in storage |
| `transfer` | ownership | Administrative or intra-organisational transfer (predominantly ownership; a handful of custody/ambiguous variants also exist) |
| `non_provenance` | — | Text identified as non-provenance content (citations, notes, inventory references); exclude from provenance analysis |
| `unknown` | ambiguous | Parser could not classify (includes cross-references) |

Extensions beyond CMOA: `recuperation` (physical recovery vs legal return),
`collection` (AAM bare-name convention), `inventory` (attestation events).

**Event flags:**

| Flag | On type | Meaning |
|------|---------|---------|
| `unsold: true` | `sale` | Auction lot was unsold, bought in, or withdrawn. No ownership transfer occurred. Filter these when analysing actual sales. |
| `batchPrice: true` | any with price | The price is an en bloc / batch total for multiple artworks, not an individual price. **Always filter these when ranking or comparing prices** — they massively distort rankings (e.g. the single fl. 6,350,000 Mannheimer sale is attributed to several hundred individual objects). |

**Inheritance granularity**: use `by_descent` for works inherited by named
relatives, `widowhood` for widow/widower inheritance specifically, or
`inheritance` for the generic case. To catch all inheritance-related transfers:
`transferType: ["by_descent", "widowhood", "inheritance"]`.

---

## Party Roles and Positions

Each party in a provenance event has a **role** (what they did) and a
**position** (their side of the transfer):

| Role | Position | Context |
|------|----------|---------|
| `buyer` | receiver | Sale events |
| `seller` | sender | Sale events |
| `donor` | sender | Gift events |
| `recipient` | receiver | Gift, transfer, deposit events |
| `heir` | receiver | Bequest, inheritance events |
| `lender` | sender | Loan events |
| `borrower` | receiver | Loan events |
| `patron` | receiver | Commission events |
| `collector` | receiver | Collection events |
| `consignor` | sender | Sale events (owner delivering work to auction/dealer) |
| `dealer` / `intermediary` / `auctioneer` | agent | Facilitated without owning |

The table above lists the canonical role values. LLM enrichment also introduces
granular variants (`his widow`, `his son`, `his daughter`, `seller/consignor`,
`dealer/intermediary`, etc.) — dozens of them, each with small counts. When
filtering by role, a broad `party=` search or a `LIKE` match on the canonical
stem catches more than an exact role match.

Positions (`sender`/`receiver`/`agent`) are derived from roles via deterministic
mapping, with LLM enrichment for ambiguous cases. The `positionMethod` field
tracks how each party's position was determined: `role_mapping` (deterministic),
`llm_enrichment` (LLM-classified), `llm_structural` (LLM resolved from event
structure), or `llm_disambiguation` (LLM-resolved merged party text).

Coverage: ~90K parties across ~100K events. Not all events have named parties —
bare-name `collection` events and cross-references often lack structured party
data. (Spot-checked 2026-05-03 against the v0.27-RC1 DB: ~49K artworks have at
least one parsed provenance event.)

---

## Date Representation

Dates use qualified single years with temporal bounds, similar to the **EDTF
(Extended Date/Time Format)** approach:

| Expression | `dateYear` | `dateQualifier` | Interpretation |
|------------|-----------|-----------------|----------------|
| `1808` | 1808 | — | Exact year |
| `c. 1700` | 1700 | `circa` | Approximate (±10 years in Layer 2) |
| `before 1800` / `by 1800` | 1800 | `before` | Terminal bound only |
| `after 1945` | 1945 | `after` | Start bound only |
| `1560-70` | 1565 | — | Midpoint of range |
| `possibly 1767` | 1767 | `circa` | Uncertain attribution |
| `1858 or earlier` | 1858 | `before` | Terminal bound |

---

## Historical Currencies

Prices are stored in their original historical currency — no inflation
adjustment or cross-currency conversion is performed. Currency values observed
in the data: `guilders`, `pounds`, `francs`, `livres`, `napoléons`, `guineas`,
`belgian_francs`, `deutschmarks`, `reichsmarks`, `swiss_francs`, `euros`,
`dollars`, `yen`, `marks`. Pre-decimal notations (£.s.d, fl. X:Y:-) are
converted to decimal equivalents of the base currency unit.

Note on batch prices: *en bloc* prices (a batch sold together, e.g. the
entire Mannheimer collection for fl. 6,350,000) are attributed to every
individual item in the batch. These events are flagged with `batchPrice: true`
— always filter them out when ranking or comparing prices.

---

## Enrichment Provenance

Every record carries provenance-of-provenance metadata tracking how it was
determined:

- `parseMethod`: how the event was parsed (`peg`, `cross_ref`, `llm_structural`, `credit_line`; `regex_fallback` is legacy and unused)
- `categoryMethod`: how the transfer type/category was determined (`type_mapping` = parser, `rule:transfer_is_ownership` = validated rule, `llm_enrichment` = LLM)
- `positionMethod` (on parties): how the party position was determined (`role_mapping` = parser, `llm_enrichment` = LLM, `llm_structural` = LLM from event structure, `llm_disambiguation` = LLM-decomposed merged text)
- `enrichmentReasoning`: the LLM's reasoning for any non-deterministic decision

When results contain LLM-enriched records, `search_provenance` provides a URL
to an enrichment review page (at `${PUBLIC_URL}/enrichment-review/:uuid`,
TTL-cached for 30 minutes) showing the full methodology and reasoning for
each decision. **Always show this URL to the user.**

### Two complementary audit layers

The four fields above (`parseMethod`, `categoryMethod`, `positionMethod`,
`enrichmentReasoning`) are **event-level** audit metadata — they record how
each parsed provenance event was produced.

In v0.27 the vocabulary DB also carries an **entity-level** 3-tier audit
vocabulary that runs alongside this:

| Tier | Meaning |
|------|---------|
| `deterministic` | Source-derived without inference (e.g. exact-match alt-name from authority files) |
| `inferred` | Algorithmically inferred (e.g. fuzzy-match alt-name not yet reviewed) |
| `manual` | Human-reviewed (e.g. fuzzy-match alt-name confirmed by reviewer) |

This 3-tier vocabulary appears on `entity_alt_names.tier`, on geo-enrichment
audit columns (`coord_method` / `placetype_source`), and on the entity-level
audit twins of provenance enrichment. Don't confuse them — *event*-level
methods (`peg` / `cross_ref` / `llm_enrichment` / `llm_structural`) describe
the parsed event provenance, while the 3-tier vocabulary describes the
provenance of supporting entity data (places, alt-names, external IDs) that
the event references.

### Querying by enrichment method

`categoryMethod` and `positionMethod` are input filters on `search_provenance`,
not just output fields. Use them to audit LLM-mediated interpretations:

```python
search_provenance(categoryMethod="llm_enrichment", maxResults=10)
# → artworks where transfer type was classified by LLM (low hundreds of events)

search_provenance(positionMethod="llm_enrichment", maxResults=10)
# → artworks where party position was assigned by LLM

search_provenance(positionMethod="llm_disambiguation", maxResults=10)
# → artworks where merged party text was decomposed by LLM (low hundreds of splits)
```

For collection-wide distribution of methods:
```python
collection_stats(dimension="categoryMethod")
collection_stats(dimension="positionMethod")
collection_stats(dimension="parseMethod")
```

---

## Parse Method Values

The `parseMethod` field records how each provenance record was processed:

| Value | Share (v0.27-RC1) | Description |
|-------|-------------------|-------------|
| `peg` | 80.1% | PEG grammar parser — highest confidence |
| `cross_ref` | 19.6% | Cross-reference links |
| `llm_structural` | 0.2% | LLM-resolved structural cases the PEG grammar could not parse |
| `credit_line` | 0.1% | Inferred from the museum's credit line field when the provenance chain lacked acquisition information |
| `regex_fallback` | — | Legacy, currently unused |

`credit_line` events are particularly useful: they recover acquisition context
(donor name, purchase fund) that the provenance text omits. Re-derive these
shares any time after a new harvest with `collection_stats(dimension="parseMethod")`.

---

## Provenance Facets

`search_provenance` supports `facets: true`, returning 5 facet dimensions
alongside chain results:

- **transferType**: distribution of transfer types in matching events
- **decade**: temporal distribution of matching events
- **location**: geographic distribution (city-level, top 20)
- **transferCategory**: ownership vs custody vs ambiguous
- **partyPosition**: sender vs receiver vs agent

All entries include `count` and `percentage`.

```python
# Faceted overview of wartime confiscations
search_provenance(transferType="confiscation", dateFrom=1933, dateTo=1945, facets=true)
# → chains + facets showing location distribution, party positions

# Faceted overview of a dealer's activity
search_provenance(party="Goudstikker", facets=true)
# → chains + transferType breakdown, decade distribution, locations

# Faceted audit of LLM-classified events
search_provenance(categoryMethod="llm_enrichment", facets=true)
# → which transfer types and decades were affected by LLM classification
```

---

## Tested Query Patterns

### Collector profiling

```python
# All works associated with a collector across all event types
search_provenance(party="Mannheimer", maxResults=50)

# Collector as seller specifically
search_provenance(party="Goupil", maxResults=20)
# Then filter results: role="seller" + position="sender" to map direction of trade

# Ownership durations for a family name
search_provenance(layer="periods", ownerName="Six",
                  sortBy="duration", sortOrder="desc", maxResults=20)
```

### Acquisition channel analysis

```python
# creditLine covers ~360K artworks — far more than parsed provenance (~49K).
# (Recounted 2026-05-03 against the v0.27-RC1 DB.)
# Use it to profile how the museum acquired works from a donor or fund
search_artwork(creditLine="Drucker-Fraser", compact=true)
search_artwork(creditLine="Vereniging Rembrandt", type="painting", compact=true)
```

### Wartime provenance

```python
# Anti-join: confiscated but never restituted
search_provenance(transferType="confiscation",
                  excludeTransferType="restitution", maxResults=20)

# Works with documented gaps + events in the wartime period
# Note: hasGap is artwork-level (any gap anywhere in the chain);
# dateFrom/dateTo filters on event date_year. The gap itself may fall
# outside the target range — always inspect the returned chain to confirm.
# ⚠ TODO (v0.3.0 audit): re-validate the artwork-level vs event-level
# semantics against the current search_provenance implementation.
search_provenance(hasGap=true, creator="Rembrandt",
                  dateFrom=1933, dateTo=1945, maxResults=20)

# Recuperation events (Allied recovery, distinct from legal restitution)
search_provenance(transferType="recuperation", maxResults=20)
```

### Price and market history

```python
# Most expensive recorded transactions in guilders
# Check batchPrice on results — true means en bloc total, not individual price
search_provenance(hasPrice=true, currency="guilders",
                  sortBy="price", sortOrder="desc", maxResults=20)

# Price history for a specific work
search_provenance(objectNumber="SK-A-2344", layer="events")
# → Inspect price field per event for the full transaction history
# → Check unsold flag: unsold lots have prices (reserve/hammer) but no sale occurred
```

### Multi-generation family collections

```python
# ⚠ TODO (v0.3.0 audit): verify that transferType arrays still parse end-to-end
# against the current search_provenance with layer="periods". (Period rows don't
# carry transfer_type directly — the filter applies to the period's acquisition
# event.)
search_provenance(transferType=["by_descent", "widowhood"],
                  layer="periods", minDuration=50,
                  sortBy="duration", sortOrder="desc", maxResults=20)
```

### Chronological exploration

```python
# Earliest documented provenance events in the collection
search_provenance(dateFrom=1400, dateTo=1500, sortBy="dateYear",
                  sortOrder="asc", maxResults=20)
```

### Decade-level time series

Use `collection_stats` for single-call time series — no manual pagination loop needed:

```python
# Sale events per decade 1600–1900
collection_stats(dimension="provenanceDecade", transferType="sale",
                 dateFrom=1600, dateTo=1900)
# → 1600s  234  (3.2%)
#   1610s  456  (6.1%)
#   ...

# Half-century bins
collection_stats(dimension="provenanceDecade", transferType="sale",
                 dateFrom=1600, dateTo=1900, binWidth=50)

# Confiscation events by decade (wartime distribution)
collection_stats(dimension="provenanceDecade", transferType="confiscation")
# → reveals 1790s + 1940s bimodal pattern (French Revolution + WWII)
```
