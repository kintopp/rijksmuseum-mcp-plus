# Release & Deploy Sequence

A release combines code changes, DB updates, and a GitHub release tag. The full sequence:

## Phase A: Code (safe, backward-compatible)

1. **Push code to `main`** — Railway auto-deploys. Code must have backward compat guards for any new DB columns so the server works with the old DB until the DB is upgraded.
2. **Wait for the code deploy to complete and pass healthcheck** before proceeding to Phase B. The healthcheck timeout is 360s (6 min). Wait at least that long, then confirm `/health` returns `ok` with the new version. Starting Phase B while Phase A is still deploying causes Railway to queue overlapping deploys, which can lead to a deploy trying to start with a missing DB.

## Phase B: DB upgrade (risky, requires confirmation)

Three DBs on the Railway volume: vocabulary, embeddings, iconclass. For each DB that changed:

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

## Phase C: Finalize release

9. **Promote pre-release to final and mark as Latest:** `gh release edit v0.XX --prerelease=false --latest`
10. **Move the `latest` tag** to the new release: `git tag -f latest v0.XX && git push -f origin latest`
11. Update version references (package.json, MEMORY.md, etc.)
