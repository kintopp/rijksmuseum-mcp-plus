# Release & Deploy Sequence

A release combines code changes, DB updates, and a GitHub release tag. The full sequence:

## Phase A: Code (safe, backward-compatible)

1. **Push code to `main`** — Railway auto-deploys. Code must have backward compat guards for any new DB columns so the server works with the old DB until the DB is upgraded.
2. **Wait for the code deploy to complete and pass healthcheck** before proceeding to Phase B. The healthcheck timeout is 360s (6 min). Wait at least that long, then confirm `/health` returns `ok` with the new version. Starting Phase B while Phase A is still deploying causes Railway to queue overlapping deploys, which can lead to a deploy trying to start with a missing DB.

## Phase B: DB upgrade (risky, requires confirmation)

Two DBs on this server's Railway volume: vocabulary, embeddings. (Iconclass moved to a separate service in v0.23.1 — see Phase B-bis below.) For each DB that changed:

```bash
# 3. Compress
gzip -k -f data/<db-file>.db

# 4. Create GitHub pre-release with the asset (provides download URL)
gh release create v0.XX --prerelease data/<db-file>.db.gz --title "v0.XX" --notes "..."

# 5. Rename old DB on Railway volume (required — see warning below)
railway ssh -- mv /data/<db-file>.db /data/<db-file>.db.bak

# 6. Update the DB URL env var (triggers automatic redeploy + download)
railway variables --set "<DB_URL_VAR>=https://github.com/kintopp/rijksmuseum-mcp-plus/releases/download/v0.XX/<db-file>.db.gz"

# 7. Verify server is healthy (/health, warm-cache, spot checks)

# 8. Delete the backup
railway ssh -- rm /data/<db-file>.db.bak
```

**Steps 5+6 are both required.** `ensureDb()` checks for a validation table — not DB version. If the old DB exists and passes validation, the download is skipped regardless of the URL. The old DB must be moved out of the way first via `railway ssh`.

**One DB at a time.** Complete steps 5–8 for one DB, confirm it is healthy, then start the next. Do not rename multiple DBs before verifying the first upgrade succeeded.

**Fallback if download fails:** Restore the backup immediately:
```bash
railway ssh -- mv /data/<db-file>.db.bak /data/<db-file>.db
```
Then trigger a restart (`railway up` or redeploy). The server will use the old DB — code has backward compat guards for missing columns.

**This is a destructive production action — always ask the user for confirmation before running steps 5–8.** Do not execute autonomously.

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

9. **Promote pre-release to final and mark as Latest:** `gh release edit v0.XX --prerelease=false --latest`
10. **Move the `latest` tag** to the new release: `git tag -f latest v0.XX && git push -f origin latest`
11. Update version references (package.json, MEMORY.md, etc.)
