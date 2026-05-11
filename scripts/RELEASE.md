# Release & Deploy Sequence

A release combines code changes, DB updates, and a GitHub release tag. The full sequence is below. Allow ~30 min start-to-finish assuming fast network for asset upload.

## Phase 0: Pre-flight (do this even if you have a state memo — commits may have landed since)

1. **Verify commits to ship:**
   ```bash
   git log origin/main..HEAD --oneline
   ```
   Confirm every commit is intentional for this release. Unexpected commits? Cherry-pick or wait.

2. **Verify untracked files:**
   ```bash
   git status --short
   ```
   Every untracked file must be intentionally held back (one-off scripts, drafts, etc.). Confirm ambiguous cases with the user before pushing.

3. **Cross-check release notes against source of truth.** Grep the notes for every numeric claim (counts, sizes, phantom-record counts, row totals) and verify each against the actual artifact — script comments, `collection_stats`, `ls -lh`, `sha256sum`. A typo here becomes a permanent part of the published release.

4. **Dump current Railway env:**
   ```bash
   railway variables --service rijksmuseum-mcp-plus --json
   ```
   Note any dead references (URLs for split-out services, stale paths, etc.). Plan to delete them alongside a DB swap to save a redeploy cycle. Also note the current `*_DB_URL` values so you have a rollback target.

## Phase A: Code (safe, backward-compatible)

1. **Push code to `main`** — Railway auto-deploys. Code must have backward compat guards for any new DB columns so the server works with the old DB until the DB is upgraded.

2. **Wait for the code deploy and confirm healthy.** Deploys typically complete in **60–90s**; the 360s healthcheck timeout is an upper bound, not an expected wait. Poll:
   ```bash
   curl https://rijksmuseum-mcp-plus-production.up.railway.app/health
   curl https://rijksmuseum-mcp-plus-production.up.railway.app/ready
   ```
   `health` returning `{"status":"ok","version":"0.XX.0",...}` proves new code boots against the old DB — i.e. backward-compat guards hold. `/ready: warm` additionally proves the ONNX model + filtered-KNN paths load against the old schema (catches v0.XX-only column refs that would break warm-up).

## Phase B: DB upgrade (destructive production action — always ask for confirmation)

> **Timing warning: Between swapping vocab and embeddings DBs, semantic_search returns silently-wrong results.** Embedding art_ids do not align with the new vocab DB rows (≈99% mismatch after a harvest). Example: after vocab-only swap, art_id `RP-T-1948-397` still holds the v0.22 vector for "Moonlit River Landscape with Fishermen", but reconstructSourceText pulls the v0.24 title for that art_id — which is "Griekse klederdracht". Do both swaps **back-to-back**. Do not demo, announce, or leave the server idle in this window.

### Shell quoting: `railway ssh` + zsh

`railway ssh --service <name> -- <cmd>` runs `<cmd>` inside the container, but zsh expands globs on the **local** shell first. Unmatched globs abort the whole command line with `no matches found` — and with `&&` chaining, the error may come from the second command while the first silently succeeded. Two safe patterns:

```bash
# Safe: literal paths only
railway ssh --service rijksmuseum-mcp-plus -- mv /data/vocabulary.db /data/vocabulary.db.bak

# Safe: wrap remote globs in sh -c with single-quoted payload
railway ssh --service rijksmuseum-mcp-plus -- sh -c 'ls -la /data/vocabulary*'

# To list /data safely without globs:
railway ssh --service rijksmuseum-mcp-plus -- ls -la /data/
```

Never chain `&&` across two `railway ssh` calls if one uses a local glob — verify each step independently instead.

### For each DB that changed

Two DBs on this server's Railway volume: vocabulary, embeddings. (Iconclass moved to a separate service in v0.23.1 — see Phase B-bis.)

**Pre-publish backfills (vocabulary.db only).** Run idempotent backfills against the freshly harvested local DB *before* compression so the curated state is baked into the released `.db.gz`:

```bash
# Theme English labels (top-100 by DF) — see #300, scripts/README.md "Enrichment & Backfill"
python3 scripts/backfills/2026-05-01-apply-theme-en-labels.py --apply

# Coord-method authority audit-trail — see scripts/backfill_coord_method_authority.py
python3 scripts/backfill_coord_method_authority.py --apply

# Curated VEI additions: authority concordances discovered out-of-band that
# the harvest pipeline didn't surface (e.g. Wikidata QIDs found via online
# research after the dump was made). Source: data/curated-vei-additions.csv.
# MUST run before promote_snapshot_backfill_to_authority.py so the new
# concordances are visible when that script checks VEI for authority backing.
python3 scripts/apply_curated_vei_additions.py

# Tier-correction: promote 'v0.25-snapshot-backfill:*' rows whose underlying
# authority is verifiable in vocabulary_external_ids from coord_method='inferred'
# to 'deterministic'. The snapshot prefix on coord_method_detail is preserved as
# an honest provenance breadcrumb. ~2,000 rows in v0.30; idempotent (no-op when
# nothing to promote).
python3 scripts/promote_snapshot_backfill_to_authority.py

# Strict 'Rijks-supplied IDs only' coord backfill (3,547 places: 3,130 TGN-RDF + 417
# Wikidata-P625). Reads data/tgn-rdf-rijks-tgn-authoritative.csv and
# data/tgn-rdf-rijks-wikidata-coords.csv. Writes lat/lon + coord_method/_detail
# only — does NOT touch external_id (left as the harvest set it).
python3 scripts/apply_rijks_authority_coords.py

# Phase-2-extended: promote 'inferred + reconciliation' rows that have a
# Rijks-supplied Wikidata QID in VEI (but were never in the TGN-RDF
# discrepancies CSV because they have no TGN equivalent). Fetches Wikidata
# P625 with on-disk cache (data/inferred-rijks-wikidata-coords.csv).
# ~430 promotions in v0.30; idempotent; --skip-fetch uses cache only.
python3 scripts/promote_inferred_via_rijks_wikidata.py

# Phase-2-extended (TGN edition): the same pattern, but for places with a
# Rijks-supplied TGN ID. Targets 'inferred + reconciliation' rows whose TGN
# concordance is verifiable in the Rijksmuseum dump (filters out
# reconciliation-introduced TGN IDs). Fetches TGN-RDF via parallel sessions
# in batch_geocode.geocode_getty_rdf. Cache: data/inferred-rijks-tgn-coords.csv.
# ~2,770 promotions in v0.30; idempotent; --skip-fetch uses cache only.
python3 scripts/promote_inferred_via_rijks_tgn.py

# Aggressive NULL-detail recovery: for the ~4,549 rows that are
# coord_method='inferred' with NULL coord_method_detail (legacy pre-audit-trail
# coords with no provenance), check whether ANY Rijks-supplied authority in VEI
# (Wikidata, TGN, GeoNames) can provide a coord. If yes, overwrite the existing
# coord with the authority value and tier-promote to 'deterministic'. ~186
# promotions in v0.30; the rest are stripped by the next script.
# Cache: data/null-detail-authority-coords.csv. Reads GEONAMES_USERNAME from .env.
python3 scripts/promote_null_detail_via_authority.py

# Areal flag for places where TGN's RDF response confirmed no centroid AND
# the placetype is non-settlement (Branch D of the original revalidate_tgn_rdf
# logic, applied to the no_coords rows that promote_inferred_via_rijks_tgn.py
# skipped silently). 9 rows in v0.30: city squares, capes, lakes, etc.
# Idempotent.
python3 scripts/apply_tgn_areal_flag.py

# Curated label corrections: typos / spelling errors that originate in
# Rijksmuseum's source data and survive harvests. Source:
# data/curated-label-corrections.csv. Currently 1 row in v0.30
# (Boxburghshire -> Roxburghshire). Safety: refuses to overwrite if
# DB's current label doesn't match the recorded old_label.
python3 scripts/apply_curated_label_corrections.py

# Curated coord corrections: rows promoted to a specific authority tier
# (e.g. 'wikidata_p625') whose lat/lon was never updated to match the
# authority. Distinct from the manual-override flow below — these rows
# stay in their authority tier; only the coord is corrected.
# Source: data/curated-coord-corrections.csv. Currently 3 rows in v0.30.
python3 scripts/apply_curated_coord_corrections.py

# Curated place overrides (manual exceptions where Rijks's TGN equivalent is
# demonstrably wrong per artwork evidence — currently 3 rows: Ohio, Montmorency,
# Bournemouth). Order vs. apply_rijks_authority_coords.py doesn't matter
# functionally — both scripts read curated-place-overrides.csv to exclude these
# vocab_ids — but conceptually 'default first, exceptions second' reads more
# clearly.
python3 scripts/apply_curated_place_overrides.py

# FINAL STEP — two-tier geo policy: strip lat/lon AND coord_method from
# EVERY place whose coord_method is not 'deterministic' (i.e. not traceable
# to a Rijks-supplied authority ID). This wipes the entire 'inferred' tier
# (WHG / Wikidata / Pleiades reconciliations, parent/city fallbacks, country
# centroids) and the small 'manual' centroid tier — too many of those coords
# were confidently wrong (homonym collisions, areal entities reduced to a
# point, POIs on a city centroid). Also clears orphan coord_method_detail
# strings left on NULL-coord rows by backfill_place_geo_from_v025.py
# (~3,499 of them). After this the DB has just two states: 'deterministic'
# (kept) and NULL (unenriched). ~3,042 coord rows stripped vs the pre-strip
# v0.30 build; coverage settles around the deterministic share (~56% of
# places). vocabulary_external_ids rows are preserved so a future authority
# publication re-geocodes these places automatically on the next harvest.
# Idempotent. MUST run last.
#
# NOTE: this makes the upstream 'inferred'-producing steps effectively
# no-ops (their output is wiped here) — apply_curated_place_overrides.py,
# the MANUAL_CENTROID slot in enrichment_methods.py, backfill_place_geo_
# from_v025.py, promote_inferred_via_rijks_{tgn,wikidata}.py, etc. They're
# left in the chain for now; a follow-up should prune the dead ones.
python3 scripts/strip_non_authority_coords.py
```

Each script is idempotent — re-running on an already-backfilled DB updates 0 rows.

```bash
# 3. Compress (locally) and record SHA-256
gzip -k -f data/<db-file>.db
shasum -a 256 data/<db-file>.db.gz

# 4. Create GitHub pre-release with the asset (provides download URL)
gh release create v0.XX --prerelease data/<db-file>.db.gz \
  --title "v0.XX" --notes-file RELEASE_NOTES_v0.XX.md

# 5. Rename old DB on Railway volume (required — see note below)
railway ssh --service rijksmuseum-mcp-plus -- mv /data/<db-file>.db /data/<db-file>.db.bak

# 5b. (Optional) Delete any dead env vars now — `variable delete` does NOT trigger a deploy,
#     so bundle these here to piggy-back on the step 6 deploy.
railway variable delete <DEAD_VAR> --service rijksmuseum-mcp-plus

# 6. Update the DB URL env var (this triggers the one automatic redeploy + download)
#    Use `railway variables --set` or the MCP set-variables tool.
railway variables --set "<DB_URL_VAR>=https://github.com/kintopp/rijksmuseum-mcp-plus/releases/download/v0.XX/<db-file>.db.gz" \
  --service rijksmuseum-mcp-plus

# 7. Verify (see "Verification queries" below)

# 8. Delete the backup once verified
railway ssh --service rijksmuseum-mcp-plus -- rm /data/<db-file>.db.bak
```

**Steps 5+6 are both required.** `ensureDb()` checks for a validation table, not DB version. If the old DB exists and passes validation, the download is skipped regardless of the URL. The old DB must be moved aside first. The running server keeps serving from the renamed inode (open file descriptor) until the new container replaces it — so the rename is safe under live traffic.

**One DB at a time.** Complete steps 5–8 for one DB, confirm it is healthy, then start the next. Do not rename multiple DBs before verifying the first upgrade succeeded. BUT do not linger — the intermediate-window warning above applies.

**Railway `variable delete` quirks** (learned 2026-04-20):
- Does **not** accept `--skip-deploys` (exits with `unexpected argument '--skip-deploys' found`).
- Does **not** trigger a redeploy. The variable leaves the running container's environment only on the next redeploy from another cause.
- Practical consequence: delete dead vars in step 5b above so the step 6 `set` triggers the one productive deploy.

### Verification queries

Run these after each DB swap's deploy completes:

**Vocab DB swap verification:**
```
collection_stats(dimension: "type")
```
- Confirm `Total artworks: <N>` matches the release-notes count exactly (e.g. 833,432 for v0.24).
- For v0.24+ specifically: `collection_stats(dimension: "categoryMethod")` returns the enrichment-audit-trail dimension. A pre-v0.24 DB rejects the dimension entirely, so this is a definitive v0.24-or-later check.

**Embeddings DB swap verification:**
```
semantic_search(query: "moonlit harbor with ships")
```
- Rank 1 should be `RP-T-1948-397` "Moonlit River Landscape with Fishermen" (Hendrick Avercamp, 1625), similarity ≈ 0.849.
- If rank 1 is topically unrelated (e.g. "Griekse klederdracht"), the art_ids are still mismatched — the new embeddings DB hasn't landed. Re-check `/data/embeddings.db` size and timestamp via `railway ssh`.
- Note: MCP schemas are `.strict()` — do **not** pass `limit`/`topK` args; semantic_search returns 15 by default.

**Health polling during cutover:** expect a ~60–90s window of `/health` timeouts while the new container fetches and decompresses the gz (embeddings is ~1.1 GB gz → ~2 GB uncompressed). After that window, `/health` + `/ready` should return steadily.

### Fallback if download fails

```bash
railway ssh --service rijksmuseum-mcp-plus -- mv /data/<db-file>.db.bak /data/<db-file>.db
```
Then trigger a restart (`railway redeploy` or set a dummy env var). The server uses the old DB — backward-compat guards in the code keep it functional.

**Reminder: this is a destructive production action. Always ask the user for confirmation before steps 5, 6, and 8.**

## Phase B-bis: Iconclass counts sidecar push (separate service)

Iconclass moved out in v0.23.1 — `lookup_iconclass` was removed and the standalone server `kintopp/rijksmuseum-iconclass-mcp` (live at `https://rijksmuseum-iconclass-mcp-production.up.railway.app/mcp`) handles all Iconclass queries now. The 3.2 GB main `iconclass.db` is owned by that repo and rarely changes.

What this server still owes after a vocab harvest: a fresh ~1.4 MB `iconclass-counts.db` sidecar so the Iconclass server can report up-to-date Rijksmuseum artwork counts per notation. Run from the **iconclass repo**, not this one:

```bash
cd /Users/bosse0000/Documents/GitHub/rijksmuseum-iconclass-mcp
python scripts/export-collection-counts.py \
  --vocab-db /Users/bosse0000/Documents/GitHub/rijksmuseum-mcp-plus/data/vocabulary.db \
  --output data/rijksmuseum-counts.csv
python scripts/build-counts-db.py --counts-csv data/rijksmuseum-counts.csv

gh release upload counts-latest data/iconclass-counts.db --clobber \
  --repo kintopp/rijksmuseum-iconclass-mcp
```

`counts-latest` is a dedicated rolling release tag whose sole asset is the current sidecar; the Iconclass server's Railway deploy picks it up via `COUNTS_DB_URL`. Sidecar build is near-instant.

`scripts/legacy/build-iconclass-db.py` and `scripts/legacy/generate-iconclass-embeddings-modal.py` in *this* repo are legacy artifacts from before the split — kept for reference, no longer part of any release path.

## Phase C: Finalize release

9. **Promote pre-release to final and mark as Latest:**
   ```bash
   gh release edit v0.XX --prerelease=false --latest
   ```

10. **Move the `latest` rolling tag.** `gh release create` creates the new version tag on GitHub only — it is **not** fetched locally until you ask for it. Trying to move `latest` without a fetch fails with `fatal: Failed to resolve 'v0.XX' as a valid ref`.
    ```bash
    git fetch origin --tags           # required — pulls the remote-only v0.XX tag
    git tag -f latest v0.XX
    git push -f origin latest         # force-push of a tag, authorized per this runbook
    ```

11. **Verify release flags.** Note `isLatest` is **not** a field in `gh release view --json`. Use the REST API:
    ```bash
    gh release view v0.XX --json tagName,isPrerelease
    gh api repos/kintopp/rijksmuseum-mcp-plus/releases/latest --jq '.tag_name'
    # should print v0.XX
    ```

12. **Update version references:**
    - `package.json` (usually pre-bumped in Phase A push)
    - `MEMORY.md` Project State line → shipped
    - `MEMORY.md` Current Versions → add as current, demote prior
    - `completed-work.md` Version History → append new entry
    - Delete any `v0XX_release_state.md` project memo (its state is now history)
