#!/usr/bin/env python3
"""
Build iconclass.db from the CC0 Iconclass data dump.

Usage:
    python scripts/build-iconclass-db.py [--data-dir /tmp/data] [--vocab-db data/vocabulary.db] [--output data/iconclass.db]

Inputs:
    - Iconclass CC0 data dump (https://github.com/iconclass/data)
    - vocabulary.db (optional, for artwork counts)

Output:
    - iconclass.db (~136 MB) with FTS5 search across 13 languages
"""

import argparse
import json
import os
import glob
import sqlite3
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path


def parse_notations(notations_path: str) -> dict[str, dict]:
    """Parse notations.txt into {notation: {children: [], refs: []}}."""
    entries: dict[str, dict] = {}
    current: dict | None = None

    with open(notations_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue

            if line == "$":
                if current and current.get("notation"):
                    entries[current["notation"]] = {
                        "children": current.get("children", []),
                        "refs": current.get("refs", []),
                    }
                current = None
                continue

            tag = line[0]
            value = line[2:] if len(line) > 2 else ""

            if tag == "N":
                current = {"notation": value, "children": [], "refs": []}
            elif tag == "C" and current:
                current["children"].append(value)
                current["_last_tag"] = "C"
            elif tag == ";" and current:
                # Continuation of children or refs (same as previous tag)
                # In notations.txt, ; after C means more children, ; after R means more refs
                if current.get("_last_tag") == "R":
                    current["refs"].append(value)
                else:
                    current["children"].append(value)
            elif tag == "R" and current:
                current["refs"].append(value)
                current["_last_tag"] = "R"
            elif tag == "K" and current:
                # K lines in notations.txt are key references, ignore for now
                pass

    # Handle last entry if file doesn't end with $
    if current and current.get("notation"):
        entries[current["notation"]] = {
            "children": current.get("children", []),
            "refs": current.get("refs", []),
        }

    return entries


def compute_paths(entries: dict[str, dict]) -> dict[str, list[str]]:
    """Compute ancestor path (root→parent) for each notation using child→parent reverse map."""
    # Build child→parent map
    parent_of: dict[str, str] = {}
    for notation, data in entries.items():
        for child in data["children"]:
            parent_of[child] = notation

    # Compute paths
    paths: dict[str, list[str]] = {}
    for notation in entries:
        ancestors = []
        current = notation
        while current in parent_of:
            current = parent_of[current]
            ancestors.append(current)
        ancestors.reverse()  # root→parent order
        paths[notation] = ancestors

    return paths


def parse_text_files(txt_dir: str) -> list[tuple[str, str, str]]:
    """Parse txt/{lang}/txt_{lang}_*.txt files. Returns [(notation, lang, text)]."""
    rows = []
    for lang_dir in sorted(Path(txt_dir).iterdir()):
        if not lang_dir.is_dir():
            continue
        lang = lang_dir.name
        for txt_file in sorted(lang_dir.glob("txt_*.txt")):
            with open(txt_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.rstrip("\n")
                    if "|" not in line:
                        continue
                    notation, text = line.split("|", 1)
                    if notation and text:
                        rows.append((notation, lang, text))
    return rows


def parse_keyword_files(kw_dir: str) -> list[tuple[str, str, str]]:
    """Parse kw/{lang}/kw_{lang}_*.txt files. Returns [(notation, lang, keyword)]."""
    rows = []
    for lang_dir in sorted(Path(kw_dir).iterdir()):
        if not lang_dir.is_dir():
            continue
        lang = lang_dir.name
        for kw_file in sorted(lang_dir.glob("kw_*.txt")):
            with open(kw_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.rstrip("\n")
                    if "|" not in line:
                        continue
                    notation, keyword = line.split("|", 1)
                    if notation and keyword:
                        rows.append((notation, lang, keyword))
    return rows


def get_iconclass_commit(data_dir: str) -> str:
    """Get git commit hash of the iconclass data repo."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=data_dir,
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.stdout.strip() if result.returncode == 0 else "unknown"
    except Exception:
        return "unknown"


def get_vocab_db_version(vocab_db_path: str) -> str:
    """Get version info from vocabulary.db if available."""
    if not os.path.exists(vocab_db_path):
        return "none"
    try:
        conn = sqlite3.connect(f"file:{vocab_db_path}?mode=ro", uri=True)
        # Try to get a meaningful version indicator
        row = conn.execute("SELECT COUNT(*) FROM artworks").fetchone()
        conn.close()
        return f"{row[0]} artworks" if row else "unknown"
    except Exception:
        return "unknown"


def load_artwork_counts(vocab_db_path: str) -> dict[str, int]:
    """Cross-reference vocabulary.db to get per-notation artwork counts."""
    if not os.path.exists(vocab_db_path):
        print("  No vocabulary.db found — skipping artwork counts")
        return {}

    print(f"  Loading artwork counts from {vocab_db_path}...")
    conn = sqlite3.connect(f"file:{vocab_db_path}?mode=ro", uri=True)

    # Count artworks per iconclass notation via mappings + vocabulary tables
    rows = conn.execute("""
        SELECT v.notation, COUNT(DISTINCT m.object_number) as cnt
        FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE m.field = 'subject' AND v.notation IS NOT NULL AND v.notation != ''
        GROUP BY v.notation
    """).fetchall()

    conn.close()
    counts = {notation: cnt for notation, cnt in rows}
    total = sum(counts.values())
    print(f"  Found counts for {len(counts)} notations ({total:,} total artwork-notation links)")
    return counts


def build(data_dir: str, vocab_db_path: str, output_path: str):
    start = time.time()

    # Ensure output directory exists
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    # Remove existing DB
    if os.path.exists(output_path):
        os.remove(output_path)

    conn = sqlite3.connect(output_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = OFF")  # Speed up bulk inserts

    # ── Phase 1: Parse and insert notations ──────────────────────────
    print("Phase 1: Parsing notations...")
    notations_path = os.path.join(data_dir, "notations.txt")
    entries = parse_notations(notations_path)
    paths = compute_paths(entries)
    print(f"  Parsed {len(entries)} notations")

    conn.execute("""
        CREATE TABLE notations (
            notation TEXT PRIMARY KEY,
            path TEXT,
            children TEXT,
            refs TEXT,
            rijks_count INTEGER DEFAULT 0
        )
    """)

    rows = []
    for notation, data in entries.items():
        rows.append((
            notation,
            json.dumps(paths.get(notation, [])),
            json.dumps(data["children"]),
            json.dumps(data["refs"]),
        ))

    conn.executemany(
        "INSERT INTO notations (notation, path, children, refs) VALUES (?, ?, ?, ?)",
        rows,
    )
    conn.commit()
    print(f"  Inserted {len(rows)} notations")

    # ── Phase 2: Parse and insert texts ──────────────────────────────
    print("Phase 2: Parsing texts...")
    txt_dir = os.path.join(data_dir, "txt")
    text_rows = parse_text_files(txt_dir)
    print(f"  Parsed {len(text_rows)} text entries")

    conn.execute("""
        CREATE TABLE texts (
            notation TEXT,
            lang TEXT,
            text TEXT
        )
    """)
    # Filter out orphan rows referencing notations not in the parsed entries
    valid_notations = set(entries.keys())
    text_rows = [(n, l, t) for n, l, t in text_rows if n in valid_notations]
    conn.executemany("INSERT INTO texts VALUES (?, ?, ?)", text_rows)
    conn.execute("CREATE INDEX idx_texts_not ON texts(notation)")
    conn.commit()

    # FTS5 for texts
    conn.execute("""
        CREATE VIRTUAL TABLE texts_fts USING fts5(
            text,
            content=texts,
            content_rowid=rowid
        )
    """)
    conn.execute("INSERT INTO texts_fts(texts_fts) VALUES('rebuild')")
    conn.commit()
    print(f"  Built texts_fts index")

    # ── Phase 3: Parse and insert keywords ───────────────────────────
    print("Phase 3: Parsing keywords...")
    kw_dir = os.path.join(data_dir, "kw")
    kw_rows = parse_keyword_files(kw_dir)
    print(f"  Parsed {len(kw_rows)} keyword entries")

    conn.execute("""
        CREATE TABLE keywords (
            notation TEXT,
            lang TEXT,
            keyword TEXT
        )
    """)
    kw_rows = [(n, l, k) for n, l, k in kw_rows if n in valid_notations]
    conn.executemany("INSERT INTO keywords VALUES (?, ?, ?)", kw_rows)
    conn.execute("CREATE INDEX idx_kw_not ON keywords(notation)")
    conn.commit()

    # FTS5 for keywords
    conn.execute("""
        CREATE VIRTUAL TABLE keywords_fts USING fts5(
            keyword,
            content=keywords,
            content_rowid=rowid
        )
    """)
    conn.execute("INSERT INTO keywords_fts(keywords_fts) VALUES('rebuild')")
    conn.commit()
    print(f"  Built keywords_fts index")

    # ── Phase 4: Cross-reference artwork counts ──────────────────────
    print("Phase 4: Cross-referencing artwork counts...")
    counts = load_artwork_counts(vocab_db_path)
    if counts:
        conn.executemany(
            "UPDATE notations SET rijks_count = ? WHERE notation = ?",
            [(cnt, notation) for notation, cnt in counts.items()],
        )
        conn.commit()
        matched = conn.execute("SELECT COUNT(*) FROM notations WHERE rijks_count > 0").fetchone()[0]
        print(f"  Updated {matched} notations with artwork counts")

    # ── Phase 5: Version info and VACUUM ─────────────────────────────
    print("Phase 5: Finalizing...")
    conn.execute("""
        CREATE TABLE version_info (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    """)

    built_at = datetime.now(timezone.utc).isoformat()
    iconclass_commit = get_iconclass_commit(data_dir)
    vocab_version = get_vocab_db_version(vocab_db_path)

    conn.executemany("INSERT INTO version_info VALUES (?, ?)", [
        ("built_at", built_at),
        ("vocab_db_version", vocab_version),
        ("iconclass_data_commit", iconclass_commit),
    ])
    conn.commit()

    print("  Running VACUUM...")
    conn.execute("VACUUM")
    conn.close()

    elapsed = time.time() - start
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"\nDone! {output_path} ({size_mb:.1f} MB) in {elapsed:.1f}s")
    print(f"  Notations: {len(entries)}")
    print(f"  Texts: {len(text_rows)}")
    print(f"  Keywords: {len(kw_rows)}")
    print(f"  Iconclass commit: {iconclass_commit[:7]}")
    print(f"  Vocab DB version: {vocab_version}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build iconclass.db from CC0 data dump")
    parser.add_argument("--data-dir", default="/tmp/data", help="Path to iconclass/data clone")
    parser.add_argument("--vocab-db", default="data/vocabulary.db", help="Path to vocabulary.db for artwork counts")
    parser.add_argument("--output", default="data/iconclass.db", help="Output path for iconclass.db")
    args = parser.parse_args()

    build(args.data_dir, args.vocab_db, args.output)
