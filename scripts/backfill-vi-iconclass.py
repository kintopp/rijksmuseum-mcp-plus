#!/usr/bin/env python3
"""
Backfill VisualItem-sourced Iconclass concepts into vocabulary.db (#203).

One-shot post-harvest pass. For each artwork in the `artwork_hmo_ids` lookup
(#253), reconstructs the HMO URI, derives the VisualItem URI (/200 -> /202
prefix swap), fetches the VI's Linked Art JSON, and extracts Iconclass concepts
from `represents_instance_of_type`. Any Type entity not yet in the vocabulary
table is resolved via Phase 2's resolve_uri() and persisted; the resulting
iconclass mapping is inserted into `mappings` with field='subject', merging
transparently with OAI-PMH-sourced subjects via INSERT OR IGNORE.

Progress is tracked in `vi_iconclass_progress`. Supports --resume to pick up
after an interrupt.

Pre-condition: the target DB must have `artwork_hmo_ids` populated (#253). On a
fresh v0.25+ harvest this happens automatically in `run_phase3()`. For pre-#253
backups that still have `linked_art_uri`, run `scripts/materialize-artwork-hmo-ids.py`
first.

Usage:
    python scripts/backfill-vi-iconclass.py                    # fresh run
    python scripts/backfill-vi-iconclass.py --resume           # keep progress table
    python scripts/backfill-vi-iconclass.py --limit 1000       # smoke test
    python scripts/backfill-vi-iconclass.py --threads 12       # thread pool size

Design doc: ~/.claude/plans/structured-gliding-quail.md
Upstream issue: kintopp/rijksmuseum-mcp-plus-offline#203
"""

import argparse
import sqlite3
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from importlib import import_module
from pathlib import Path

import requests

# Force line-buffered stdout so progress prints appear in `tee` output
# immediately, regardless of whether the interpreter is invoked with `-u`.
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

harvest = import_module("harvest-vocabulary-db")
get_http_session = harvest.get_http_session
resolve_uri = harvest.resolve_uri
VOCAB_INSERT_SQL = harvest.VOCAB_INSERT_SQL
VEI_INSERT_SQL = harvest.VEI_INSERT_SQL
LINKED_ART_BASE = harvest.LINKED_ART_BASE
USER_AGENT = harvest.USER_AGENT

DEFAULT_DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"
DEFAULT_THREADS = 12
BATCH_SIZE = 500
HMO_URI_PREFIX = "https://id.rijksmuseum.nl/200"
VI_URI_PREFIX = "https://id.rijksmuseum.nl/202"

PROGRESS_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS vi_iconclass_progress (
    object_number       TEXT PRIMARY KEY,
    status              TEXT NOT NULL,
    error_reason        TEXT,
    vi_mappings_added   INTEGER NOT NULL DEFAULT 0,
    new_types_resolved  INTEGER NOT NULL DEFAULT 0,
    processed_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)
"""
PROGRESS_INDEX_SQL = (
    "CREATE INDEX IF NOT EXISTS idx_vi_prog_status ON vi_iconclass_progress(status)"
)
PROGRESS_UPSERT_SQL = """
INSERT INTO vi_iconclass_progress
    (object_number, status, error_reason, vi_mappings_added, new_types_resolved)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(object_number) DO UPDATE SET
    status             = excluded.status,
    error_reason       = excluded.error_reason,
    vi_mappings_added  = excluded.vi_mappings_added,
    new_types_resolved = excluded.new_types_resolved,
    processed_at       = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
"""

# Matches the OAI-PMH-sourced subject mapping pattern already used in Phase 4.
MAPPING_INSERT_SQL = """
    INSERT OR IGNORE INTO mappings (artwork_id, vocab_rowid, field_id)
    SELECT a.art_id, v.vocab_int_id, f.id
    FROM artworks a, vocabulary v, field_lookup f
    WHERE a.object_number = ? AND v.id = ? AND f.name = 'subject'
"""


def derive_vi_uri(linked_art_uri: str) -> str | None:
    """Derive the VisualItem URI from an HMO linked_art_uri via /200 -> /202 prefix swap.

    Returns None if the URI doesn't match the expected HMO prefix — caller should
    record this as 'unexpected_uri_pattern' without an HTTP call.
    """
    if not linked_art_uri or not linked_art_uri.startswith(HMO_URI_PREFIX):
        return None
    return VI_URI_PREFIX + linked_art_uri[len(HMO_URI_PREFIX):]


def fetch_vi(vi_uri: str) -> tuple[dict | None, str | None]:
    """Fetch a VisualItem's Linked Art JSON.

    Returns (data, None) on success, (None, reason) on failure where reason is one of:
    vi_http_404, vi_http_410, vi_http_<code>, vi_transient, vi_parse_error.
    """
    try:
        resp = get_http_session().get(
            vi_uri,
            headers={
                "Accept": "application/ld+json",
                "Profile": "https://linked.art/ns/v1/linked-art.json",
                "User-Agent": USER_AGENT,
            },
            timeout=30,
        )
    except (requests.Timeout, requests.ConnectionError):
        return None, "vi_transient"
    except requests.RequestException:
        return None, "vi_transient"

    if resp.status_code == 404:
        return None, "vi_http_404"
    if resp.status_code == 410:
        return None, "vi_http_410"
    if 500 <= resp.status_code < 600:
        return None, "vi_transient"
    if not resp.ok:
        return None, f"vi_http_{resp.status_code}"

    try:
        return resp.json(), None
    except ValueError:
        return None, "vi_parse_error"


def worker_fetch_vi(obj_num: str, linked_art_uri: str) -> dict:
    """Runs in a worker thread. Only fetches the VI — Type resolution happens in the
    main thread so the vocab cache stays single-threaded.

    Returns a dict with keys: object_number, status, error_reason (if error),
    type_uris (if status='done_pending_types').
    """
    vi_uri = derive_vi_uri(linked_art_uri)
    if vi_uri is None:
        return {
            "object_number": obj_num,
            "status": "error",
            "error_reason": "unexpected_uri_pattern",
        }

    data, reason = fetch_vi(vi_uri)
    if data is None:
        return {"object_number": obj_num, "status": "error", "error_reason": reason}

    types = data.get("represents_instance_of_type") or []
    if not types:
        return {"object_number": obj_num, "status": "empty_vi"}

    type_uris = [t.get("id") for t in types if isinstance(t, dict) and t.get("id")]
    if not type_uris:
        return {"object_number": obj_num, "status": "empty_vi"}

    return {
        "object_number": obj_num,
        "status": "done_pending_types",
        "type_uris": type_uris,
    }


def extract_entity_id(uri: str) -> str | None:
    """Extract bare entity ID from a Rijksmuseum URI. resolve_uri() wants the bare ID.

    Accepts both id.rijksmuseum.nl/* (canonical identifier URIs, used inside Linked
    Art payloads) and data.rijksmuseum.nl/* (the data URL that id.* 303-redirects
    to). Returns None for any other host.
    """
    if not uri:
        return None
    for prefix in ("https://id.rijksmuseum.nl/", "https://data.rijksmuseum.nl/"):
        if uri.startswith(prefix):
            return uri[len(prefix):]
    return None


def resolve_type_with_retry(entity_id: str, counters: Counter) -> tuple[dict | None, str | None]:
    """Resolve a Type URI via Phase 2's resolver with inline retry for transients.

    Up to 3 attempts with exponential backoff. Updates counters['type_http_permanent']
    / ['type_http_transient_failed'] on failure. Returns (dict, None) or (None, reason).
    """
    for attempt in range(3):
        result, reason = resolve_uri(entity_id)
        if result is not None:
            return result, None
        # Permanent failures don't retry
        if reason in ("http_404", "http_410") or (reason and reason.startswith("unsupported_type:")):
            counters["type_http_permanent"] += 1
            return None, reason
        # Transient: backoff and retry
        if attempt < 2:
            time.sleep(0.5 * (2 ** attempt))
    counters["type_http_transient_failed"] += 1
    return None, reason


def is_iconclass_classification(resolved: dict) -> tuple[str | None, str | None]:
    """Return (notation, iconclass_uri) if resolved entity is an iconclass classification,
    (None, None) otherwise.

    Harvest's resolve_uri only populates `notation` for places (WKT POINT) — for
    Type entities it leaves notation=None. Fall back to extracting the notation
    from the iconclass.org URL suffix (e.g. https://iconclass.org/49B44 → 49B44).
    """
    if resolved.get("type") != "classification":
        return None, None
    external_id = resolved.get("external_id") or ""
    if "iconclass.org" not in external_id:
        return None, None
    notation = resolved.get("notation") or external_id.rsplit("/", 1)[-1]
    if not notation:
        return None, None
    return notation, external_id


def process_type_uris(
    type_uris: list[str],
    vocab_cache: dict[str, str | None],
    pending_vocab: list[dict],
    pending_vei: list[tuple],
    counters: Counter,
) -> tuple[list[str], int]:
    """For each type_uri, ensure it's resolved (cached or fetched) and return the
    subset (as bare entity IDs) that carry an iconclass notation.

    vocab_cache is single-threaded (main thread only). pending_vocab/pending_vei
    accumulate NEW vocab rows for the current batch's executemany. Cache and
    mapping inserts are both keyed by bare entity ID (matching vocabulary.id).
    Returns (iconclass_entity_ids, new_types_this_artwork) for per-artwork counts.
    """
    iconclass_entity_ids: list[str] = []
    new_types_this_artwork = 0
    for type_uri in type_uris:
        # Cache keys are BARE entity IDs (matching vocabulary.id column).
        # Non-Rijksmuseum Type URIs can't map to our vocab — skip silently.
        entity_id = extract_entity_id(type_uri)
        if entity_id is None:
            continue

        # Cache hit: value is notation-or-None. None means "known non-iconclass".
        if entity_id in vocab_cache:
            if vocab_cache[entity_id]:
                iconclass_entity_ids.append(entity_id)
            continue

        resolved, _ = resolve_type_with_retry(entity_id, counters)
        if resolved is None:
            vocab_cache[entity_id] = None  # failed; mark to skip future artworks
            continue

        notation, iconclass_uri = is_iconclass_classification(resolved)
        if notation is None:
            vocab_cache[entity_id] = None  # resolved but not iconclass
            continue

        # New iconclass Type — persist in the upcoming batch commit
        pending_vocab.append({
            "id": entity_id,
            "type": "classification",
            "label_en": resolved.get("label_en"),
            "label_nl": resolved.get("label_nl"),
            "external_id": iconclass_uri,
            "broader_id": resolved.get("broader_id"),
            "notation": notation,
            "lat": None,
            "lon": None,
        })
        pending_vei.append((entity_id, "iconclass", notation, iconclass_uri))
        vocab_cache[entity_id] = notation
        iconclass_entity_ids.append(entity_id)
        new_types_this_artwork += 1

    return iconclass_entity_ids, new_types_this_artwork


def load_vocab_cache(conn: sqlite3.Connection) -> dict[str, str | None]:
    """Preload the in-memory cache with every classification entry's (id, notation).

    Non-iconclass or classification-without-notation rows get None as the value.
    """
    cache: dict[str, str | None] = {}
    for vid, notation in conn.execute(
        "SELECT id, notation FROM vocabulary WHERE type = 'classification'"
    ):
        cache[vid] = notation if notation else None
    return cache


def select_pending(conn: sqlite3.Connection, resume: bool, limit: int | None) -> list[tuple]:
    """Pick artworks to process. If --resume, skip those already in progress table
    with terminal status (done / empty_vi). Error rows are retried.
    """
    # #253: the backfill needs per-artwork HMO URIs, but linked_art_uri is
    # dropped by Phase 3. Use the permanent artwork_hmo_ids lookup instead and
    # reconstruct the URI at query time.
    query = """
    SELECT a.object_number, 'https://id.rijksmuseum.nl/' || h.hmo_id AS linked_art_uri
    FROM artworks a
    JOIN artwork_hmo_ids h ON h.art_id = a.art_id
    """
    if resume:
        query += """
        WHERE NOT EXISTS (
            SELECT 1 FROM vi_iconclass_progress p
            WHERE p.object_number = a.object_number
              AND p.status IN ('done', 'empty_vi')
        )
        """
    if limit:
        query += f" LIMIT {limit}"
    return conn.execute(query).fetchall()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--db", default=str(DEFAULT_DB_PATH), help="Path to vocabulary.db")
    parser.add_argument("--resume", action="store_true",
                        help="Keep existing progress table; skip already-completed artworks")
    parser.add_argument("--threads", type=int, default=DEFAULT_THREADS,
                        help=f"Worker thread count (default {DEFAULT_THREADS})")
    parser.add_argument("--limit", type=int, default=None,
                        help="Stop after N artworks (smoke test)")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA journal_mode = WAL")

    if not args.resume:
        print("Fresh run: recreating vi_iconclass_progress table.")
        conn.execute("DROP TABLE IF EXISTS vi_iconclass_progress")
    conn.execute(PROGRESS_SCHEMA_SQL)
    conn.execute(PROGRESS_INDEX_SQL)
    conn.commit()

    print("Loading vocab cache...")
    vocab_cache = load_vocab_cache(conn)
    print(f"  {len(vocab_cache):,} classification entries cached.")

    print("Selecting pending artworks...")
    pending = select_pending(conn, args.resume, args.limit)
    total = len(pending)
    if total == 0:
        print("Nothing to do.")
        return 0
    print(f"  {total:,} artworks pending.")

    counters: Counter = Counter()
    status_counts: Counter = Counter()
    error_reason_counts: Counter = Counter()
    processed = 0
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        batch_start = 0
        while batch_start < total:
            batch_end = min(batch_start + BATCH_SIZE, total)
            batch = pending[batch_start:batch_end]

            futures = {
                pool.submit(worker_fetch_vi, obj_num, uri): obj_num
                for obj_num, uri in batch
            }

            pending_vocab: list[dict] = []
            pending_vei: list[tuple] = []
            pending_mappings: list[tuple] = []
            pending_progress: list[tuple] = []

            for future in as_completed(futures):
                try:
                    result = future.result()
                except Exception as exc:
                    obj_num = futures[future]
                    result = {
                        "object_number": obj_num,
                        "status": "error",
                        "error_reason": f"worker_exception:{type(exc).__name__}",
                    }

                obj_num = result["object_number"]
                status = result["status"]
                vi_mappings_added = 0
                new_types_this_artwork = 0

                if status == "done_pending_types":
                    type_uris = result["type_uris"]
                    iconclass_entity_ids, new_types_this_artwork = process_type_uris(
                        type_uris, vocab_cache, pending_vocab, pending_vei, counters
                    )
                    for entity_id in iconclass_entity_ids:
                        pending_mappings.append((obj_num, entity_id))
                    vi_mappings_added = len(iconclass_entity_ids)
                    final_status = "done"
                    error_reason = None
                else:
                    final_status = status
                    error_reason = result.get("error_reason")
                    if error_reason:
                        error_reason_counts[error_reason] += 1

                status_counts[final_status] += 1
                pending_progress.append((
                    obj_num,
                    final_status,
                    error_reason,
                    vi_mappings_added,
                    new_types_this_artwork,
                ))

            # Bulk writes per batch
            if pending_vocab:
                conn.executemany(VOCAB_INSERT_SQL, pending_vocab)
            if pending_vei:
                conn.executemany(VEI_INSERT_SQL, pending_vei)
            if pending_mappings:
                conn.executemany(MAPPING_INSERT_SQL, pending_mappings)
            conn.executemany(PROGRESS_UPSERT_SQL, pending_progress)
            conn.commit()

            processed += len(batch)
            batch_start = batch_end

            elapsed = time.time() - t0
            rate = processed / elapsed if elapsed > 0 else 0
            remaining = (total - processed) / rate if rate > 0 else 0
            print(
                f"  {processed:,}/{total:,} "
                f"({status_counts['done']:,} done, "
                f"{status_counts['empty_vi']:,} empty_vi, "
                f"{status_counts['error']:,} error, "
                f"{rate:.0f}/s, ~{remaining/60:.0f}min left)",
                flush=True,
            )

    elapsed = time.time() - t0
    print(f"\nVI-Iconclass backfill complete in {elapsed/60:.1f}min:")
    print(f"  Processed:          {processed:,}")
    print(f"  Done:               {status_counts['done']:,}")
    print(f"  Empty VI:           {status_counts['empty_vi']:,}")
    print(f"  Errors:             {status_counts['error']:,}")
    for reason, count in sorted(error_reason_counts.items(), key=lambda x: -x[1]):
        print(f"    {reason:<22} {count:,}")
    mappings_added, types_resolved = conn.execute(
        "SELECT COALESCE(SUM(vi_mappings_added), 0), "
        "COALESCE(SUM(new_types_resolved), 0) FROM vi_iconclass_progress"
    ).fetchone()
    print(f"  New mappings added: {mappings_added:,}")
    print(f"  New types resolved: {types_resolved:,}")
    print(f"  Type-level issues:")
    print(f"    Type HTTP permanent:     {counters.get('type_http_permanent', 0):,}")
    print(f"    Type transient failed:   {counters.get('type_http_transient_failed', 0):,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
