"""Generate fuzzy-match candidates between EDM actors-dump prefLabels and
vocabulary.label_{en,nl} for type IN ('group', 'organisation'), at progressively
looser tiers, for human/LLM review.

Read-only. Emits a TSV at data/audit/group-altname-fuzzy-candidates.tsv.

Tiers (lowest = highest confidence):
  0  exact case-sensitive match
  1  case-insensitive + whitespace-collapsed
  2  diacritic-stripped (Unicode NFKD → ASCII via unidecode)
  3  punctuation-stripped (drop .,&-'`"() and collapse spaces)
  4  token-set Jaccard ≥ 0.8 (handles word reordering, e.g. "Goupil & Cie" ↔ "Cie. Goupil")
  5  Levenshtein-bounded fuzzy match (rapidfuzz token_set_ratio ≥ 80
     OR normalised edit-distance similarity ≥ 0.85), token-anchored

Tier 5 is gated on shared 4+ char tokens to keep the comparison space tractable
and reduce false positives on short / common strings.

Each candidate row also carries:
  - artwork_count for the vocab row (importance signal — creator-instances)
  - already_in_db (true if this exact (entity_id, alt_label) pair is present)
  - all altLabels of the EDM agent (context for review)

Sort: tier ASC (best first), artwork_count DESC, vocab_label ASC.
"""

from __future__ import annotations

import csv
import re
import sqlite3
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from pathlib import Path

from rapidfuzz import fuzz
from unidecode import unidecode

PROJECT_DIR = Path(__file__).resolve().parents[1]
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"
EDM_ZIP = Path.home() / "Downloads" / "rijksmuseum-data-dumps" / "201911-rma-edm-actors.zip"
OUT_TSV = PROJECT_DIR / "data" / "audit" / "group-altname-fuzzy-candidates.tsv"

NS = {
    "edm": "http://www.europeana.eu/schemas/edm/",
    "skos": "http://www.w3.org/2004/02/skos/core#",
    "dc":   "http://purl.org/dc/elements/1.1/",
}

PUNCT_RE = re.compile(r"[.,&\-'`\"()]+")
WS_RE = re.compile(r"\s+")

# Tokens shorter than this are not used as anchors for tier-5 candidate generation
ANCHOR_MIN_LEN = 4
# Tokens appearing in more vocab labels than this are excluded from the anchor index
# (they're too generic — "museum", "stichting", "amsterdam" — and explode the candidate set)
ANCHOR_MAX_DOCFREQ = 200
# Per-agent candidate cap (after anchor expansion); if exceeded, intersect anchors
ANCHOR_PER_AGENT_CAP = 500
# Tier-5 thresholds
TIER5_TOKEN_SET_RATIO = 80   # rapidfuzz fuzz.token_set_ratio
TIER5_RATIO = 85             # rapidfuzz fuzz.ratio (normalised edit similarity)


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def norm_ws(s: str) -> str:
    return WS_RE.sub(" ", s.strip()).lower()


def norm_diacritic(s: str) -> str:
    return WS_RE.sub(" ", unidecode(s).strip()).lower()


def norm_punct(s: str) -> str:
    return WS_RE.sub(" ", PUNCT_RE.sub(" ", unidecode(s)).strip()).lower()


def tokens(s: str) -> set[str]:
    return {t for t in norm_punct(s).split(" ") if t}


def jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def iter_edm_agents(zip_path: Path):
    """Yield (uri, pref_label, [alt_labels]) for each <edm:Agent> with altLabels."""
    with zipfile.ZipFile(zip_path) as z:
        with z.open(z.namelist()[0]) as f:
            for _, elem in ET.iterparse(f, events=("end",)):
                if elem.tag == f"{{{NS['edm']}}}Agent":
                    uri = elem.get(f"{{http://www.w3.org/1999/02/22-rdf-syntax-ns#}}about", "")
                    pref = None
                    alts: list[str] = []
                    for child in elem:
                        if child.tag == f"{{{NS['skos']}}}prefLabel" and child.text:
                            pref = child.text.strip()
                        elif child.tag == f"{{{NS['skos']}}}altLabel" and child.text:
                            alts.append(child.text.strip())
                    if pref and alts:
                        yield uri, pref, alts
                    elem.clear()


def main() -> int:
    log(f"DB: {DB_PATH}")
    log(f"EDM zip: {EDM_ZIP}")
    log(f"Output TSV: {OUT_TSV}")

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    # Build vocab side: list of (vocab_id, type, label, lang)
    log("Loading vocabulary (groups + organisations)...")
    vocab_rows: list[tuple[str, str, str, str]] = []
    for r in conn.execute(
        "SELECT id, type, label_en, label_nl FROM vocabulary "
        "WHERE type IN ('group', 'organisation')"
    ):
        if r["label_en"]:
            vocab_rows.append((r["id"], r["type"], r["label_en"].strip(), "en"))
        if r["label_nl"]:
            vocab_rows.append((r["id"], r["type"], r["label_nl"].strip(), "nl"))
    log(f"  Loaded {len(vocab_rows):,} (vocab_id, label) pairs")

    # Pre-compute normalisations on the vocab side
    log("Pre-computing normalised forms + token-anchor index for vocab labels...")
    vocab_norm = []  # (vocab_id, type, label, lang, ns_lower, diac_lower, punct_lower, tok_set)
    anchor_to_vocab_idx: dict[str, list[int]] = defaultdict(list)  # token -> [indices into vocab_norm]
    for vocab_id, vtype, label, lang in vocab_rows:
        ns = norm_ws(label)
        diac = norm_diacritic(label)
        punct = norm_punct(label)
        tok = tokens(label)
        vocab_norm.append((vocab_id, vtype, label, lang, ns, diac, punct, tok))
        idx = len(vocab_norm) - 1
        for t in tok:
            if len(t) >= ANCHOR_MIN_LEN:
                anchor_to_vocab_idx[t].append(idx)
    log(f"  Anchor tokens (≥{ANCHOR_MIN_LEN} chars): {len(anchor_to_vocab_idx):,} distinct")

    # Drop hyper-common anchors (too generic to be useful for fuzzy matching)
    common = {t: len(idxs) for t, idxs in anchor_to_vocab_idx.items() if len(idxs) > ANCHOR_MAX_DOCFREQ}
    for t in common:
        del anchor_to_vocab_idx[t]
    log(f"  Dropped {len(common):,} hyper-common anchors (docfreq > {ANCHOR_MAX_DOCFREQ})")
    if common:
        top = sorted(common.items(), key=lambda kv: -kv[1])[:10]
        log(f"  Sample dropped: {top}")
    log(f"  Final anchor index: {len(anchor_to_vocab_idx):,} tokens")

    # Index by exact and normalised forms for tiers 0-3
    exact_to_idx: dict[str, list[int]] = defaultdict(list)
    ws_to_idx: dict[str, list[int]] = defaultdict(list)
    diac_to_idx: dict[str, list[int]] = defaultdict(list)
    punct_to_idx: dict[str, list[int]] = defaultdict(list)
    for i, (_vid, _vt, label, _lang, ns, diac, punct, _tok) in enumerate(vocab_norm):
        exact_to_idx[label].append(i)
        ws_to_idx[ns].append(i)
        diac_to_idx[diac].append(i)
        punct_to_idx[punct].append(i)

    # Existing entity_alt_names — for marking already_in_db
    log("Loading existing entity_alt_names...")
    existing = set(
        (eid, name) for eid, name in conn.execute(
            "SELECT entity_id, name FROM entity_alt_names"
        )
    )
    log(f"  Existing rows: {len(existing):,}")

    # Build vocab_id → vocab_int_id map for artwork_count lookups (deferred — only computed
    # for matched candidates at TSV-writing time, since the full GROUP BY against the 14.8M-row
    # mappings table without a vocab_rowid index is unworkably slow).
    vocab_id_to_int = {
        r["id"]: r["vocab_int_id"] for r in conn.execute(
            "SELECT id, vocab_int_id FROM vocabulary WHERE type IN ('group','organisation')"
        )
    }
    creator_field_id = conn.execute(
        "SELECT id FROM field_lookup WHERE name='creator'"
    ).fetchone()[0]
    log(f"  Will defer artwork_count to candidate-only pass (creator field_id={creator_field_id})")
    artwork_counts: dict[str, int] = {}  # populated lazily below

    # Walk the EDM dump and emit candidates
    log("Walking EDM actors dump and generating candidates per tier...")
    candidates = []  # list of dicts (one per row in the TSV)
    seen_pairs: set[tuple[int, str]] = set()  # (vocab_idx, alt_label) to dedupe across tiers

    def emit(tier, vocab_idx, alt, edm_uri, edm_pref, all_alts, score, distance, notes):
        key = (vocab_idx, alt)
        if key in seen_pairs:
            return
        seen_pairs.add(key)
        v = vocab_norm[vocab_idx]
        vid = v[0]
        candidates.append({
            "tier": tier,
            "score": f"{score:.3f}" if score is not None else "",
            "distance": str(distance) if distance is not None else "",
            "vocab_id": vid,
            "vocab_type": v[1],
            "vocab_label": v[2],
            "vocab_lang": v[3],
            "artwork_count": artwork_counts.get(vid, 0),
            "edm_uri": edm_uri,
            "edm_pref_label": edm_pref,
            "edm_alt_label": alt,
            "edm_all_alts": "; ".join(all_alts),
            "already_in_db": str((vid, alt) in existing).lower(),
            "notes": notes,
        })

    n_agents = 0
    n_with_match = 0
    tier_counts = defaultdict(int)

    for edm_uri, pref, alts in iter_edm_agents(EDM_ZIP):
        n_agents += 1
        had_match = False

        pref_ns = norm_ws(pref)
        pref_diac = norm_diacritic(pref)
        pref_punct = norm_punct(pref)
        pref_tok = tokens(pref)

        # Tier 0: exact case-sensitive
        for idx in exact_to_idx.get(pref, []):
            for alt in alts:
                emit(0, idx, alt, edm_uri, pref, alts, 1.0, 0, "exact match")
                tier_counts[0] += 1
                had_match = True

        # Tier 1: case-insensitive + ws-collapsed
        for idx in ws_to_idx.get(pref_ns, []):
            v = vocab_norm[idx]
            if v[2] == pref:  # already covered by tier 0
                continue
            for alt in alts:
                emit(1, idx, alt, edm_uri, pref, alts, 1.0, 0, "case+whitespace")
                tier_counts[1] += 1
                had_match = True

        # Tier 2: diacritic-stripped
        for idx in diac_to_idx.get(pref_diac, []):
            v = vocab_norm[idx]
            if v[4] == pref_ns:  # already covered by tier 0/1
                continue
            for alt in alts:
                emit(2, idx, alt, edm_uri, pref, alts, 1.0, 0, "diacritic strip")
                tier_counts[2] += 1
                had_match = True

        # Tier 3: punctuation-stripped
        for idx in punct_to_idx.get(pref_punct, []):
            v = vocab_norm[idx]
            if v[5] == pref_diac:  # already covered by tier 0/1/2
                continue
            for alt in alts:
                emit(3, idx, alt, edm_uri, pref, alts, 1.0, 0, "punctuation strip")
                tier_counts[3] += 1
                had_match = True

        # Tier 4 + 5: token-anchored fuzzy. Gather candidate vocab indices via shared anchor tokens.
        # Anchor tokens that survive ANCHOR_MAX_DOCFREQ pruning. If still too many, fall back to
        # intersection across the agent's distinct anchor tokens (must share ALL anchor tokens).
        per_anchor: list[set[int]] = []
        for t in pref_tok:
            if len(t) >= ANCHOR_MIN_LEN and t in anchor_to_vocab_idx:
                per_anchor.append(set(anchor_to_vocab_idx[t]))
        if not per_anchor:
            cand_idx: set[int] = set()
        else:
            cand_idx = set().union(*per_anchor)
            if len(cand_idx) > ANCHOR_PER_AGENT_CAP and len(per_anchor) > 1:
                # Intersect: agent must share every anchor token with the candidate
                cand_idx = set.intersection(*per_anchor)
        # Strip already-handled tier 0-3 indices
        cand_idx -= set(exact_to_idx.get(pref, []))
        cand_idx -= set(ws_to_idx.get(pref_ns, []))
        cand_idx -= set(diac_to_idx.get(pref_diac, []))
        cand_idx -= set(punct_to_idx.get(pref_punct, []))

        for idx in cand_idx:
            v = vocab_norm[idx]
            v_tok = v[7]
            jac = jaccard(pref_tok, v_tok)

            # Tier 4: token-set Jaccard ≥ 0.8
            if jac >= 0.8:
                for alt in alts:
                    emit(4, idx, alt, edm_uri, pref, alts, jac, None,
                         f"token-set jaccard={jac:.2f}")
                    tier_counts[4] += 1
                    had_match = True
                continue

            # Tier 5: rapidfuzz, two complementary scorers, must clear both bars
            ts = fuzz.token_set_ratio(pref_punct, v[6])
            r = fuzz.ratio(pref_diac, v[5])
            if ts >= TIER5_TOKEN_SET_RATIO and r >= TIER5_RATIO:
                # Approx Levenshtein distance via the ratio: distance ≈ (100 - r) / 100 * max(len)
                approx_dist = round((100 - r) / 100 * max(len(pref_diac), len(v[5])))
                score = (ts + r) / 200.0
                for alt in alts:
                    emit(5, idx, alt, edm_uri, pref, alts, score, approx_dist,
                         f"fuzzy token_set={ts}, ratio={r}")
                    tier_counts[5] += 1
                    had_match = True

        if had_match:
            n_with_match += 1

    log(f"  Walked {n_agents:,} agents-with-altLabels, matched {n_with_match:,}")
    log(f"  Per-tier candidate counts: {dict(tier_counts)}")
    log(f"  Total unique candidates (after dedup across tiers): {len(candidates):,}")

    # Compute artwork_count only for the distinct candidate vocab_ids (small set vs full 40K)
    distinct_candidate_vids = {c["vocab_id"] for c in candidates}
    log(f"Computing artwork_count for {len(distinct_candidate_vids):,} candidate vocab IDs...")
    if distinct_candidate_vids:
        # batch in groups of 500 to avoid SQL parameter limits
        vids = list(distinct_candidate_vids)
        for chunk_start in range(0, len(vids), 500):
            chunk = vids[chunk_start:chunk_start + 500]
            ints = [vocab_id_to_int[v] for v in chunk if v in vocab_id_to_int]
            if not ints:
                continue
            placeholders = ",".join("?" * len(ints))
            for r in conn.execute(
                f"SELECT m.vocab_rowid, COUNT(DISTINCT m.artwork_id) AS n "
                f"FROM mappings m WHERE m.field_id=? AND m.vocab_rowid IN ({placeholders}) "
                f"GROUP BY m.vocab_rowid",
                [creator_field_id, *ints],
            ):
                # Reverse-lookup vocab_id from vocab_int_id
                pass  # placeholder
            # Reverse map: int → id
            int_to_id = {vocab_id_to_int[v]: v for v in chunk if v in vocab_id_to_int}
            for r in conn.execute(
                f"SELECT m.vocab_rowid, COUNT(DISTINCT m.artwork_id) AS n "
                f"FROM mappings m WHERE m.field_id=? AND m.vocab_rowid IN ({placeholders}) "
                f"GROUP BY m.vocab_rowid",
                [creator_field_id, *ints],
            ):
                vid = int_to_id.get(r[0])
                if vid:
                    artwork_counts[vid] = r[1]
        log(f"  artwork_count map: {len(artwork_counts):,} entries (zero for unmatched)")

    # Backfill artwork_count into candidate rows now
    for c in candidates:
        c["artwork_count"] = artwork_counts.get(c["vocab_id"], 0)

    # Sort: tier ASC, artwork_count DESC, vocab_label ASC
    candidates.sort(key=lambda r: (r["tier"], -r["artwork_count"], r["vocab_label"]))

    # Write TSV
    OUT_TSV.parent.mkdir(parents=True, exist_ok=True)
    cols = [
        "tier", "score", "distance",
        "vocab_id", "vocab_type", "vocab_label", "vocab_lang", "artwork_count",
        "edm_uri", "edm_pref_label", "edm_alt_label", "edm_all_alts",
        "already_in_db", "notes",
    ]
    with OUT_TSV.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, delimiter="\t",
                           quoting=csv.QUOTE_MINIMAL, extrasaction="ignore")
        w.writeheader()
        for row in candidates:
            w.writerow(row)
    log(f"Wrote {len(candidates):,} rows to {OUT_TSV}")

    # Summary stats
    log("")
    log("Summary:")
    log(f"  Total EDM agents with altLabels: {n_agents:,}")
    log(f"  Agents with at least one matched candidate: {n_with_match:,}")
    novel_by_tier = defaultdict(int)
    for r in candidates:
        if r["already_in_db"] == "false":
            novel_by_tier[r["tier"]] += 1
    log(f"  Novel candidates (not yet in entity_alt_names) by tier:")
    for tier in sorted(novel_by_tier.keys()):
        log(f"    tier {tier}: {novel_by_tier[tier]:,}")

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
