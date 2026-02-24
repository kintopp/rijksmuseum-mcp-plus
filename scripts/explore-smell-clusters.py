#!/usr/bin/env python3
"""
Smell-focused embedding cluster analysis for the Rijksmuseum collection.

Strategy:
1. Encode multilingual smell queries (EN + NL + FR + DE + LA) using the same
   E5 model that produced the DB embeddings.
2. Find top-K nearest embeddings for each query (the "smell core").
3. For each core artwork, find its nearest neighbors in embedding space
   to capture associated/adjacent concepts.
4. Cluster with fine granularity (small min_cluster_size).
5. Generate interactive HTML with smell at the center.
"""

import sqlite3
import struct
import json
import numpy as np
from pathlib import Path
from collections import Counter

# ── Config ──────────────────────────────────────────────
EMBEDDINGS_DB = Path(__file__).parent.parent / "data" / "embeddings.db"
VOCAB_DB = Path(__file__).parent.parent / "data" / "vocabulary.db"
OUTPUT_DIR = Path(__file__).parent.parent / "offline" / "explorations" / "embedding-clusters"
RANDOM_SEED = 42
np.random.seed(RANDOM_SEED)

# Per-query top-K, and neighbor expansion K
QUERY_TOP_K = 300        # top matches per smell query
NEIGHBOR_K = 20           # neighbors per core artwork
TOTAL_TARGET = 20_000     # target sample size (fill remainder with random)

# ── Smell queries ───────────────────────────────────────
# E5 models require "query: " prefix for queries, "passage: " for documents.
# The DB was built with "passage: " prefix on the composite text.
SMELL_QUERIES = [
    # English — odours, scents
    "query: smell odour scent fragrance perfume",
    "query: flowers fragrance rose tulip aromatic bouquet",
    "query: perfume bottle flacon eau de cologne",
    "query: incense burning smoke aromatic resin",
    "query: spices pepper cinnamon clove nutmeg aromatic trade",
    "query: cheese market food stench",
    "query: fish market herring stink odour",
    "query: tobacco pipe smoking smell",
    "query: decay rot putrid corpse death stench",
    "query: apothecary pharmacy herbs medicinal smell",
    "query: kitchen cooking food preparation aroma",
    "query: wine beer brewery tavern fermentation",

    # English — the act of smelling
    "query: smelling sniffing nose holding nose",
    "query: woman smelling flower rose sniffing",
    "query: man holding his nose disgusted by smell stench",
    "query: dog sniffing tracking scent",
    "query: five senses smell olfaction",
    "query: allegory of smell sense of smell personification",

    # English — olfaction as concept
    "query: vanitas still life transience decay",
    "query: miasma plague disease bad air pestilence",
    "query: garden of eden paradise fragrant flowers",

    # Dutch — geuren, reuk
    "query: geur reuk stank parfum welriekend",
    "query: bloemen geur roos tulp boeket welriekend",
    "query: parfumfles reukflesje eau de cologne",
    "query: wierook branden rook aromatisch",
    "query: specerijen peper kaneel kruidnagel nootmuskaat",
    "query: kaasmarkt stank markt voedsel",
    "query: vismarkt haring stank vis",
    "query: tabak pijp roken",
    "query: bederf verrotting lijk dood stank",
    "query: apotheek kruiden geneesmiddel geur",
    "query: keuken koken eten bereiding aroma",
    "query: wijn bier brouwerij herberg gisting",

    # Dutch — het ruiken
    "query: ruiken snuiven neus neus dichtknijpen",
    "query: vrouw ruikt aan bloem roos snuiven",
    "query: man houdt neus dicht walging stank",
    "query: hond snuffelen spoor geur",
    "query: vijf zintuigen reuk reukvermogen",
    "query: allegorie van de reuk zintuig personificatie",

    # Dutch — reuk als concept
    "query: vanitas stilleven vergankelijkheid verval",
    "query: miasma pest ziekte slechte lucht pestilentie",
    "query: tuin van Eden paradijs geurige bloemen",

    # French
    "query: odeur parfum senteur fragrance olfaction",
    "query: fleurs parfum rose tulipe bouquet aromatique",
    "query: sens de l'odorat allégorie cinq sens",

    # German
    "query: Geruch Duft Gestank Parfüm wohlriechend",
    "query: Blumen Duft Rose Tulpe Strauß aromatisch",
    "query: fünf Sinne Geruchssinn Allegorie Riechen",

    # Latin (historical art terminology)
    "query: odor olfactus nasus incensum",
]

# ── 1. Load all embeddings ──────────────────────────────
print("Loading all embeddings (this may take a moment)...")
edb = sqlite3.connect(str(EMBEDDINGS_DB))
rows = edb.execute("SELECT art_id, object_number, embedding FROM artwork_embeddings").fetchall()
edb.close()

all_art_ids = np.array([r[0] for r in rows])
all_obj_nums = np.array([r[1] for r in rows])

def decode_int8_blob(blob):
    return np.array(struct.unpack(f'{len(blob)}b', blob), dtype=np.float32)

print("Decoding embeddings (float16 to save memory)...")
all_embeddings = np.array([decode_int8_blob(r[2]) for r in rows], dtype=np.float16)
del rows  # free memory early
# Normalize for cosine similarity (compute in float32, store float16)
norms = np.linalg.norm(all_embeddings.astype(np.float32), axis=1, keepdims=True).astype(np.float16)
norms[norms == 0] = 1
all_embeddings_normed = all_embeddings / norms
del all_embeddings, norms  # only keep normed version
print(f"Loaded {len(all_embeddings_normed):,} embeddings, shape {all_embeddings_normed.shape}")

# ── 2. Encode smell queries ─────────────────────────────
print("\nEncoding smell queries with multilingual-e5-small...")
from sentence_transformers import SentenceTransformer

import logging
logging.getLogger("sentence_transformers").setLevel(logging.WARNING)
model = SentenceTransformer("intfloat/multilingual-e5-small")
query_embeddings = model.encode(SMELL_QUERIES, normalize_embeddings=True, show_progress_bar=False)
del model  # free ~100MB
print(f"Encoded {len(SMELL_QUERIES)} queries, shape {query_embeddings.shape}")

# ── 3. Find smell core (top-K per query) ────────────────
print(f"\nFinding top-{QUERY_TOP_K} matches per query...")
core_indices = set()
query_scores = {}  # track best score per artwork across all queries

for qi, qemb in enumerate(query_embeddings):
    sims = all_embeddings_normed @ qemb  # cosine similarity
    top_k_idx = np.argpartition(sims, -QUERY_TOP_K)[-QUERY_TOP_K:]
    for idx in top_k_idx:
        idx = int(idx)
        score = float(sims[idx])
        core_indices.add(idx)
        if idx not in query_scores or score > query_scores[idx]:
            query_scores[idx] = score

print(f"Smell core: {len(core_indices):,} unique artworks (from {len(SMELL_QUERIES)} queries × {QUERY_TOP_K})")

# ── 4. Expand with neighbors ────────────────────────────
print(f"\nExpanding with {NEIGHBOR_K} neighbors per core artwork...")
# Use batch matrix multiplication for neighbor expansion (much faster)
# Take top core artworks by smell score, expand in batches
core_with_scores = [(idx, query_scores[idx]) for idx in core_indices]
core_with_scores.sort(key=lambda x: -x[1])
expansion_sample = [idx for idx, _ in core_with_scores[:2000]]

neighbor_indices = set()
# Transpose once (float32 for matmul precision)
emb_T = all_embeddings_normed.astype(np.float32).T  # (384, 831K)
BATCH = 50
for batch_start in range(0, len(expansion_sample), BATCH):
    batch_idx = expansion_sample[batch_start:batch_start + BATCH]
    if batch_start % 500 == 0:
        print(f"  Expanding batch {batch_start}/{len(expansion_sample)}...")
    batch_embs = all_embeddings_normed[batch_idx].astype(np.float32)  # (50, 384)
    sims = batch_embs @ emb_T  # (50, 831K)
    for row in sims:
        top_idx = np.argpartition(row, -NEIGHBOR_K)[-NEIGHBOR_K:]
        neighbor_indices.update(int(x) for x in top_idx)
    del sims
del emb_T

all_selected = core_indices | neighbor_indices
print(f"After expansion: {len(all_selected):,} artworks")

# ── 5. Cap at target size, fill remainder with random ───
if len(all_selected) > TOTAL_TARGET:
    # Keep all core, trim neighbors randomly
    pure_neighbors = list(neighbor_indices - core_indices)
    np.random.shuffle(pure_neighbors)
    max_neighbors = max(0, TOTAL_TARGET - len(core_indices))
    keep_neighbors = set(pure_neighbors[:max_neighbors])
    all_selected = core_indices | keep_neighbors
    print(f"Trimmed to {len(all_selected):,} (kept all {len(core_indices):,} core)")

remaining = TOTAL_TARGET - len(all_selected)
if remaining > 0:
    available = set(range(len(all_art_ids))) - all_selected
    random_fill = set(np.random.choice(list(available), size=min(remaining, len(available)), replace=False))
    all_selected = all_selected | random_fill
    print(f"Added {len(random_fill):,} random background points → total {len(all_selected):,}")

# Convert to sorted array for consistent indexing
selected_indices = np.array(sorted(all_selected))
art_ids = all_art_ids[selected_indices]
object_numbers = all_obj_nums[selected_indices]
embeddings = all_embeddings_normed[selected_indices].astype(np.float32)

# Track which are core vs expansion vs background
is_core = np.array([idx in core_indices for idx in selected_indices])
is_neighbor = np.array([idx in neighbor_indices and idx not in core_indices for idx in selected_indices])
is_background = ~is_core & ~is_neighbor

# Best smell score per artwork (0 for non-core)
smell_scores = np.array([query_scores.get(int(idx), 0.0) for idx in selected_indices])

print(f"\nFinal sample: {len(art_ids):,} artworks")
print(f"  Core (smell-related): {is_core.sum():,}")
print(f"  Neighbors (associated): {is_neighbor.sum():,}")
print(f"  Background (random): {is_background.sum():,}")

# Free large arrays
del all_embeddings_normed, all_art_ids, all_obj_nums

# ── 6. UMAP ────────────────────────────────────────────
print("\nRunning UMAP...")
import umap

reducer = umap.UMAP(
    n_components=2,
    n_neighbors=30,
    min_dist=0.05,  # tighter for finer clusters
    metric="cosine",
    random_state=RANDOM_SEED,
    verbose=False,
)
coords_2d = reducer.fit_transform(embeddings)
print(f"UMAP done, shape {coords_2d.shape}")

# ── 7. HDBSCAN with fine granularity ───────────────────
print("\nRunning HDBSCAN (fine granularity)...")
import hdbscan

clusterer = hdbscan.HDBSCAN(
    min_cluster_size=60,   # finer than generic (100) but not too granular
    min_samples=10,
    metric="euclidean",
    cluster_selection_method="eom",
)
labels = clusterer.fit_predict(coords_2d)
n_clusters = len(set(labels)) - (1 if -1 in labels else 0)
n_noise = (labels == -1).sum()
print(f"Found {n_clusters} clusters, {n_noise:,} noise points ({n_noise/len(labels)*100:.1f}%)")

# ── 8. Fetch metadata ──────────────────────────────────
print("\nFetching metadata...")
vdb = sqlite3.connect(str(VOCAB_DB))
field_map = dict(vdb.execute("SELECT name, id FROM field_lookup").fetchall())

type_fid = field_map.get("type")
creator_fid = field_map.get("creator")
subject_fid = field_map.get("subject")
material_fid = field_map.get("material")
technique_fid = field_map.get("technique")

# Guard: warn about missing field IDs
for name, fid_val in [("type", type_fid), ("creator", creator_fid),
                      ("subject", subject_fid), ("material", material_fid),
                      ("technique", technique_fid)]:
    if fid_val is None:
        print(f"  WARNING: field '{name}' not found in field_lookup — metadata will be missing")

field_ids = [fid_val for fid_val in [type_fid, creator_fid, subject_fid,
                                      material_fid, technique_fid] if fid_val is not None]

# Titles — batched to stay within SQLITE_LIMIT_VARIABLE_NUMBER
BATCH = 990
title_map = {}
id_list = art_ids.tolist()
for batch_start in range(0, len(id_list), BATCH):
    batch = id_list[batch_start:batch_start + BATCH]
    ph = ",".join("?" * len(batch))
    for aid, on, title in vdb.execute(
        f"SELECT art_id, object_number, title FROM artworks WHERE art_id IN ({ph})",
        batch
    ):
        title_map[aid] = title or ""

# Vocab — batched
meta = {int(aid): {"types": [], "creators": [], "subjects": [], "materials": [], "techniques": []}
        for aid in art_ids}

if not field_ids:
    print("  WARNING: no valid field IDs — skipping vocab metadata query")
else:
    field_ph = ",".join("?" * len(field_ids))
    MBATCH = BATCH - len(field_ids)
    for batch_start in range(0, len(id_list), MBATCH):
        batch = id_list[batch_start:batch_start + MBATCH]
        ph = ",".join("?" * len(batch))
        query = f"""
            SELECT m.artwork_id, m.field_id, COALESCE(v.label_en, v.label_nl)
            FROM mappings m
            JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
            WHERE m.artwork_id IN ({ph})
              AND m.field_id IN ({field_ph})
        """
        params = batch + field_ids
        for aid, fid, label in vdb.execute(query, params):
            if aid not in meta:
                continue
            if fid == type_fid: meta[aid]["types"].append(label)
            elif fid == creator_fid: meta[aid]["creators"].append(label)
            elif fid == subject_fid: meta[aid]["subjects"].append(label)
            elif fid == material_fid: meta[aid]["materials"].append(label)
            elif fid == technique_fid: meta[aid]["techniques"].append(label)

vdb.close()

# ── 9. Classify clusters by smell relevance ────────────
print("\nClassifying clusters by smell relevance...")

# Smell-related keywords for classification
SMELL_KEYWORDS = {
    # Direct smell
    "smell", "scent", "odour", "odor", "fragrance", "perfume", "olfaction",
    "stench", "stink", "aroma", "aromatic", "fragrant", "reuk", "geur",
    "stank", "parfum", "welriekend", "ruiken",
    # Five senses
    "five senses", "vijf zintuigen", "sense of smell", "zintuig",
    # Smell-adjacent subjects
    "flower", "flowers", "bloem", "bloemen", "rose", "roos", "tulip", "tulp",
    "bouquet", "boeket", "garland",
    "spice", "spices", "specerij", "specerijen", "pepper", "peper",
    "cinnamon", "kaneel", "clove", "kruidnagel", "nutmeg", "nootmuskaat",
    "incense", "wierook", "smoke", "rook",
    "tobacco", "tabak", "pipe", "pijp", "smoking", "roken",
    "cheese", "kaas", "fish", "vis", "herring", "haring",
    "wine", "wijn", "beer", "bier", "brewery", "brouwerij",
    "kitchen", "keuken", "cooking", "koken",
    "apothecary", "apotheek", "pharmacy", "herbs", "kruiden",
    "decay", "bederf", "rot", "verrotting", "corpse", "lijk",
    "perfume bottle", "reukflesje", "flacon",
    "nose", "neus", "sniffing", "snuiven",
    "vanitas", "still life", "stilleven",
    "garden", "tuin", "paradise", "paradijs",
    "plague", "pest", "miasma",
    "dog", "hond",  # often depicted sniffing
}

cluster_profiles = {}
for cid in sorted(set(labels)):
    if cid == -1:
        continue
    mask = labels == cid
    cluster_size = int(mask.sum())

    core_count = int(is_core[mask].sum())
    neighbor_count = int(is_neighbor[mask].sum())
    bg_count = int(is_background[mask].sum())
    avg_smell_score = float(smell_scores[mask][smell_scores[mask] > 0].mean()) if (smell_scores[mask] > 0).any() else 0.0
    core_fraction = core_count / cluster_size

    type_counts = Counter()
    creator_counts = Counter()
    subject_counts = Counter()
    material_counts = Counter()
    technique_counts = Counter()
    smell_subject_hits = Counter()

    for i in np.where(mask)[0]:
        aid = int(art_ids[i])
        m = meta[aid]
        type_counts.update(m["types"])
        creator_counts.update(m["creators"])
        subject_counts.update(m["subjects"])
        material_counts.update(m["materials"])
        technique_counts.update(m["techniques"])
        for subj in m["subjects"]:
            subj_lower = subj.lower()
            for kw in SMELL_KEYWORDS:
                if kw in subj_lower:
                    smell_subject_hits[subj] += 1
                    break

    # Classify: core (>50% core), associated (20-50%), peripheral (<20%)
    if core_fraction > 0.5:
        zone = "core"
    elif core_fraction > 0.15:
        zone = "associated"
    else:
        zone = "peripheral"

    cluster_profiles[cid] = {
        "size": cluster_size,
        "core_count": core_count,
        "neighbor_count": neighbor_count,
        "bg_count": bg_count,
        "core_fraction": core_fraction,
        "avg_smell_score": avg_smell_score,
        "zone": zone,
        "top_types": type_counts.most_common(5),
        "top_creators": creator_counts.most_common(5),
        "top_subjects": subject_counts.most_common(10),
        "top_materials": material_counts.most_common(5),
        "top_techniques": technique_counts.most_common(5),
        "smell_subjects": smell_subject_hits.most_common(10),
        "centroid": coords_2d[mask].mean(axis=0).tolist(),
    }

# Label
def label_cluster(p):
    parts = []
    if p["top_types"]:
        parts.append(p["top_types"][0][0])
    if p["top_subjects"]:
        parts.append(p["top_subjects"][0][0])
    return " · ".join(parts) if parts else "?"

for cid, p in cluster_profiles.items():
    p["label"] = label_cluster(p)

# Stats
core_clusters = [cid for cid, p in cluster_profiles.items() if p["zone"] == "core"]
assoc_clusters = [cid for cid, p in cluster_profiles.items() if p["zone"] == "associated"]
periph_clusters = [cid for cid, p in cluster_profiles.items() if p["zone"] == "peripheral"]
print(f"  Core smell clusters: {len(core_clusters)}")
print(f"  Associated clusters: {len(assoc_clusters)}")
print(f"  Peripheral clusters: {len(periph_clusters)}")

# ── 10. Build hover text ────────────────────────────────
print("\nBuilding hover text...")
hover_texts = []
for i in range(len(art_ids)):
    aid = int(art_ids[i])
    obj = str(object_numbers[i])
    m = meta[aid]
    title = title_map.get(aid, "")
    lines = [f"<b>{title or obj}</b>"]
    if title:
        lines.append(f"Object: {obj}")
    if m["creators"]:
        lines.append(f"Creator: {', '.join(m['creators'][:2])}")
    if m["types"]:
        lines.append(f"Type: {', '.join(m['types'][:2])}")
    if m["subjects"]:
        lines.append(f"Subjects: {', '.join(m['subjects'][:4])}")
    if m["materials"]:
        lines.append(f"Material: {', '.join(m['materials'][:2])}")
    score = smell_scores[i]
    if score > 0:
        lines.append(f"Smell score: {score:.3f}")
    tag = "core" if is_core[i] else ("neighbor" if is_neighbor[i] else "background")
    lines.append(f"Origin: {tag}")
    hover_texts.append("<br>".join(lines))

# ── 11. Generate HTML ──────────────────────────────────
print("\nGenerating interactive HTML...")

ZONE_COLORS = {
    "core": {"base": "#E63946", "light": "#FF6B6B"},      # red — smell center
    "associated": {"base": "#457B9D", "light": "#7FB3D3"}, # blue — associated
    "peripheral": {"base": "#BBBBBB", "light": "#DDDDDD"}, # grey — background context
}

CLUSTER_COLORS = [
    # Warm reds/oranges for core
    "#E63946", "#D62828", "#F77F00", "#FCBF49", "#E76F51",
    "#C1121F", "#FF6B35", "#FF9F1C", "#E85D04", "#DC2F02",
    "#9D0208", "#F4845F", "#EE6C4D", "#BC4749", "#FF4D6D",
    "#C9184A", "#FF758F", "#A4133C", "#800F2F", "#590D22",
    # Cool blues for associated
    "#457B9D", "#1D3557", "#2A9D8F", "#264653", "#168AAD",
    "#006D77", "#0077B6", "#0096C7", "#00B4D8", "#48CAE4",
    "#3A86FF", "#023E8A", "#0353A4", "#006466", "#065A60",
    # Greens/teals for additional
    "#40916C", "#52B788", "#74C69D", "#95D5B2", "#2D6A4F",
    "#1B4332", "#081C15", "#344E41", "#588157", "#3A5A40",
    # Purples for extras
    "#7B2CBF", "#9D4EDD", "#C77DFF", "#5A189A", "#3C096C",
    "#10002B", "#7209B7", "#560BAD", "#480CA8", "#3F37C9",
]

traces = []

# Noise
noise_mask = labels == -1
if noise_mask.any():
    traces.append({
        "x": coords_2d[noise_mask, 0].tolist(),
        "y": coords_2d[noise_mask, 1].tolist(),
        "text": [hover_texts[i] for i in np.where(noise_mask)[0]],
        "customdata": [str(object_numbers[i]) for i in np.where(noise_mask)[0]],
        "mode": "markers",
        "type": "scattergl",
        "name": f"Noise ({noise_mask.sum():,})",
        "marker": {"color": "#eee", "size": 2, "opacity": 0.2},
        "hovertemplate": "%{text}<extra>Noise</extra>",
        "visible": "legendonly",
    })

# Clusters grouped by zone
for zone, zone_label in [("core", "SMELL CORE"), ("associated", "ASSOCIATED"), ("peripheral", "PERIPHERAL")]:
    zone_cids = sorted([cid for cid, p in cluster_profiles.items() if p["zone"] == zone])
    for ci, cid in enumerate(zone_cids):
        mask = labels == cid
        p = cluster_profiles[cid]

        if zone == "core":
            color = CLUSTER_COLORS[ci % 20]
            size = 5
            opacity = 0.7
        elif zone == "associated":
            color = CLUSTER_COLORS[20 + ci % 15]
            size = 4
            opacity = 0.5
        else:
            color = CLUSTER_COLORS[(35 + ci) % len(CLUSTER_COLORS)]
            size = 3
            opacity = 0.3

        short_label = p["label"][:50]
        smell_pct = f" [{p['core_fraction']*100:.0f}% smell]" if p["core_fraction"] > 0 else ""

        traces.append({
            "x": coords_2d[mask, 0].tolist(),
            "y": coords_2d[mask, 1].tolist(),
            "text": [hover_texts[i] for i in np.where(mask)[0]],
            "customdata": [str(object_numbers[i]) for i in np.where(mask)[0]],
            "mode": "markers",
            "type": "scattergl",
            "name": f"[{zone[0].upper()}] {cid}: {short_label}{smell_pct} ({p['size']})",
            "marker": {"color": color, "size": size, "opacity": opacity},
            "hovertemplate": "%{text}<extra>" + f"Cluster {cid} ({zone})" + "</extra>",
            "legendgroup": zone,
            "legendgrouptitle": {"text": zone_label} if ci == 0 else None,
            "visible": True if zone != "peripheral" else "legendonly",
        })

# Annotations for core + associated only
annotations = []
for cid, p in cluster_profiles.items():
    if p["zone"] == "peripheral":
        continue
    cx, cy = p["centroid"]
    short = p["label"][:35] + ("..." if len(p["label"]) > 35 else "")
    prefix = "🔴 " if p["zone"] == "core" else "🔵 "
    annotations.append({
        "x": cx, "y": cy,
        "text": f"{prefix}<b>{cid}</b>: {short}",
        "showarrow": False,
        "font": {"size": 8 if p["zone"] == "associated" else 9, "color": "#222"},
        "bgcolor": "rgba(255,255,255,0.85)",
        "bordercolor": "#E63946" if p["zone"] == "core" else "#457B9D",
        "borderwidth": 1,
        "borderpad": 2,
    })

layout = {
    "title": {
        "text": f"Rijksmuseum Collection — Smell & Olfaction Clusters<br><sub>{len(art_ids):,} artworks · {len(core_clusters)} smell-core · {len(assoc_clusters)} associated · {len(periph_clusters)} peripheral clusters</sub>",
        "font": {"size": 18},
    },
    "xaxis": {"title": "UMAP 1", "showgrid": False, "zeroline": False},
    "yaxis": {"title": "UMAP 2", "showgrid": False, "zeroline": False, "scaleanchor": "x"},
    "hovermode": "closest",
    "showlegend": False,
    "annotations": annotations,
    "paper_bgcolor": "#fafafa",
    "plot_bgcolor": "#fff",
    "margin": {"t": 80, "b": 50, "l": 50, "r": 20},
}

# ── Build cluster detail JSON for the panel ─────────
cluster_detail_json = {}
for cid, p in list(cluster_profiles.items()):
    cluster_detail_json[int(cid)] = {
        "label": p["label"],
        "zone": p["zone"],
        "size": p["size"],
        "core_count": p["core_count"],
        "core_fraction": round(p["core_fraction"] * 100, 1),
        "avg_smell_score": round(p["avg_smell_score"], 3),
        "top_types": p["top_types"][:5],
        "top_creators": p["top_creators"][:5],
        "top_subjects": p["top_subjects"][:8],
        "smell_subjects": p["smell_subjects"][:8],
        "top_materials": p["top_materials"][:5],
        "top_techniques": p["top_techniques"][:5],
    }

# ── Build legend items for the custom sidebar ───────────
legend_items = []
trace_idx = 1 if noise_mask.any() else 0  # 0 is noise only if noise trace was emitted
for zone, zone_label in [("core", "SMELL CORE"), ("associated", "ASSOCIATED"), ("peripheral", "PERIPHERAL")]:
    zone_cids = sorted([cid for cid, p in cluster_profiles.items() if p["zone"] == zone])
    if not zone_cids:
        continue
    legend_items.append({"type": "group", "label": zone_label, "zone": zone})
    for ci, cid in enumerate(zone_cids):
        p = cluster_profiles[cid]
        # Determine color (must match trace generation order)
        if zone == "core":
            color = CLUSTER_COLORS[ci % 20]
        elif zone == "associated":
            color = CLUSTER_COLORS[20 + ci % 15]
        else:
            color = CLUSTER_COLORS[(35 + ci) % len(CLUSTER_COLORS)]

        short_label = p["label"][:45]
        smell_pct = f" [{p['core_fraction']*100:.0f}%]" if p["core_fraction"] > 0 else ""
        legend_items.append({
            "type": "cluster",
            "cid": int(cid),
            "traceIdx": trace_idx,
            "label": f"{cid}: {short_label}{smell_pct}",
            "color": color,
            "size": p["size"],
            "zone": zone,
        })
        trace_idx += 1

# Pre-compute data extent for zoom (exclude noise — it's hidden by default)
non_noise_cids = [cid for cid in sorted(set(labels)) if cid != -1]
if non_noise_cids:
    all_x = np.concatenate([coords_2d[labels == cid, 0] for cid in non_noise_cids])
    all_y = np.concatenate([coords_2d[labels == cid, 1] for cid in non_noise_cids])
else:
    # Fallback: all points are noise
    all_x = coords_2d[:, 0]
    all_y = coords_2d[:, 1]
data_extent = {
    "xMin": float(np.min(all_x)), "xMax": float(np.max(all_x)),
    "yMin": float(np.min(all_y)), "yMax": float(np.max(all_y)),
}

# ── Write HTML ──────────────────────────────────────────
html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Rijksmuseum — Smell & Olfaction Clusters</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #fafafa; }}
  #controls {{
    padding: 10px 20px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
    background: #fff; border-bottom: 1px solid #e0e0e0;
  }}
  #controls button {{
    padding: 5px 12px; border: 1px solid #ccc; border-radius: 4px;
    background: #fff; cursor: pointer; font-size: 12px;
  }}
  #controls button:hover {{ background: #f0f0f0; }}
  #controls button.active {{ background: #E63946; color: #fff; border-color: #E63946; }}
  #controls .sep {{ width: 1px; height: 20px; background: #ddd; }}
  #controls .info {{ color: #666; font-size: 12px; margin-left: auto; }}
  kbd {{ background: #eee; padding: 1px 5px; border-radius: 3px; border: 1px solid #ccc; font-size: 11px; }}

  /* ── Layout: sidebar + plot ─────────────────────── */
  #main {{ display: flex; height: calc(100vh - 44px); }}
  #plot {{ flex: 1; min-width: 0; }}

  /* ── Custom legend sidebar ─────────────────────── */
  #sidebar {{
    width: 280px; min-width: 280px; background: #fff;
    border-left: 1px solid #e0e0e0; display: flex; flex-direction: column;
    font-size: 12px; user-select: none;
  }}
  #sidebar-header {{
    padding: 8px 12px; border-bottom: 1px solid #e0e0e0;
    font-weight: 600; font-size: 12px; color: #444;
    display: flex; justify-content: space-between; align-items: center;
  }}
  #sidebar-header button {{
    padding: 2px 8px; border: 1px solid #ccc; border-radius: 3px;
    background: #fff; cursor: pointer; font-size: 10px;
  }}
  #sidebar-header button:hover {{ background: #f0f0f0; }}
  #cluster-list {{
    flex: 1; overflow-y: auto; overflow-x: hidden; padding: 4px 0;
  }}
  .legend-group-title {{
    padding: 6px 12px 2px; font-size: 10px; font-weight: 700; color: #888;
    text-transform: uppercase; letter-spacing: 0.5px; position: sticky;
    top: 0; background: #fff; z-index: 1;
  }}
  .legend-item {{
    display: flex; align-items: center; padding: 3px 12px; cursor: pointer;
    gap: 6px; line-height: 1.3;
  }}
  .legend-item:hover {{ background: #f5f5f5; }}
  .legend-item.dimmed {{ opacity: 0.35; }}
  .legend-swatch {{
    width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0;
  }}
  .legend-label {{
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 11px;
  }}
  .legend-count {{
    color: #999; font-size: 10px; flex-shrink: 0;
  }}

  /* ── Help overlay ──────────────────────────────── */
  #help-overlay {{
    display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    z-index: 200; justify-content: center; align-items: center;
  }}
  #help-overlay.visible {{ display: flex; }}
  #help-box {{
    background: #fff; border-radius: 10px; padding: 24px 32px;
    max-width: 460px; box-shadow: 0 8px 30px rgba(0,0,0,0.3);
  }}
  #help-box h3 {{ margin: 0 0 14px; font-size: 16px; }}
  #help-box table {{ border-collapse: collapse; width: 100%; }}
  #help-box td {{ padding: 3px 0; font-size: 13px; }}
  #help-box td:first-child {{ font-family: monospace; font-weight: bold; color: #444; padding-right: 16px; white-space: nowrap; }}
  #help-box .section {{ font-weight: bold; color: #888; padding-top: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }}

  /* ── Zoom toast ────────────────────────────────── */
  #zoom-toast {{
    display: none; position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: rgba(0,0,0,0.75); color: #fff; padding: 6px 16px; border-radius: 20px;
    font-size: 13px; z-index: 150; pointer-events: none; transition: opacity 0.3s;
  }}

  /* ── Detail panel ──────────────────────────────── */
  #detail-panel {{
    display: none; position: fixed; right: 296px; top: 56px;
    width: 360px; max-height: calc(100vh - 72px); overflow-y: auto;
    background: #fff; border: 1px solid #ccc; border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.15); padding: 16px; z-index: 100;
    font-size: 12px; line-height: 1.5;
  }}
  #detail-panel .close {{ position: absolute; top: 8px; right: 12px; cursor: pointer; font-size: 18px; color: #999; }}
  #detail-panel .close:hover {{ color: #333; }}
  #detail-panel h3 {{ margin-bottom: 6px; font-size: 14px; }}
  #detail-panel .zone-badge {{
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 11px; font-weight: bold; color: #fff; margin-bottom: 8px;
  }}
  #detail-panel .zone-core {{ background: #E63946; }}
  #detail-panel .zone-associated {{ background: #457B9D; }}
  #detail-panel .zone-peripheral {{ background: #999; }}
  #detail-panel .stat {{ margin: 3px 0; }}
  #detail-panel .bar {{
    display: flex; align-items: center; margin: 2px 0; font-size: 11px; gap: 4px;
  }}
  #detail-panel .bar-fill {{
    height: 14px; border-radius: 2px; min-width: 2px;
  }}
  #detail-panel .bar-text {{ white-space: nowrap; color: #555; }}
  #detail-panel .smell-tag {{
    display: inline-block; background: #FFF3F3; border: 1px solid #E63946;
    color: #E63946; padding: 1px 6px; border-radius: 3px; font-size: 10px; margin: 1px;
  }}
  .bar-section {{ margin: 10px 0 4px; font-weight: bold; color: #666; font-size: 11px; text-transform: uppercase; }}
</style>
</head>
<body>

<div id="controls">
  <button onclick="toggleLabels()"><kbd>L</kbd> Labels</button>
  <button onclick="toggleNoise()"><kbd>N</kbd> Noise</button>
  <button onclick="showZone('core')">Core only</button>
  <button onclick="showZone('associated')">Associated</button>
  <button onclick="showZone('all')"><kbd>A</kbd> All</button>
  <div class="sep"></div>
  <button onclick="resetZoom()"><kbd>0</kbd> Reset</button>
  <button onclick="toggleHelp()"><kbd>?</kbd> Shortcuts</button>
  <span class="info">Click point → Rijksmuseum · Click cluster → detail panel</span>
</div>

<div id="main">
  <div id="plot"></div>
  <div id="sidebar">
    <div id="sidebar-header">
      <span>Clusters</span>
      <span>
        <button onclick="showZone('core')" title="Show core only">Core</button>
        <button onclick="showZone('associated')" title="Core + associated">Assoc</button>
        <button onclick="showZone('all')" title="Show all">All</button>
      </span>
    </div>
    <div id="cluster-list"></div>
  </div>
</div>
<div id="zoom-toast"></div>

<div id="detail-panel">
  <span class="close" onclick="closePanel()">&times;</span>
  <div id="detail-content"></div>
</div>

<div id="help-overlay" onclick="toggleHelp()">
  <div id="help-box" onclick="event.stopPropagation()">
    <h3>Keyboard Shortcuts</h3>
    <table>
      <tr><td class="section" colspan="2">Zoom</td></tr>
      <tr><td>+  =</td><td>Zoom in</td></tr>
      <tr><td>-</td><td>Zoom out</td></tr>
      <tr><td>0</td><td>Reset zoom (fit all)</td></tr>
      <tr><td>1</td><td>Zoom to 2&times;</td></tr>
      <tr><td>2</td><td>Zoom to 4&times;</td></tr>
      <tr><td>3</td><td>Zoom to 8&times;</td></tr>
      <tr><td class="section" colspan="2">Pan</td></tr>
      <tr><td>&larr; &rarr; &uarr; &darr;</td><td>Pan in direction</td></tr>
      <tr><td>Shift + arrow</td><td>Pan further</td></tr>
      <tr><td class="section" colspan="2">Display</td></tr>
      <tr><td>L</td><td>Toggle cluster labels</td></tr>
      <tr><td>N</td><td>Toggle noise points</td></tr>
      <tr><td>A</td><td>Show all clusters</td></tr>
      <tr><td>C</td><td>Show only smell-core clusters</td></tr>
      <tr><td>?  H</td><td>Toggle this help</td></tr>
      <tr><td>Esc</td><td>Close panels / help</td></tr>
    </table>
  </div>
</div>

<script>
const traces = {json.dumps(traces)};
const layout = {json.dumps(layout)};
const clusterDetail = {json.dumps(cluster_detail_json)};
const legendItems = {json.dumps(legend_items)};
const dataExtent = {json.dumps(data_extent)};

const config = {{
  responsive: true,
  scrollZoom: true,
  modeBarButtonsToRemove: ['lasso2d', 'select2d'],
  displaylogo: false,
}};

const NOISE_TRACE_IDX = {0 if noise_mask.any() else -1};
let labelsVisible = true;
let noiseVisible = false;
let currentZone = 'associated';  // initial state: core + associated visible
// Save annotations before Plotly mutates the layout object
const savedAnnotations = JSON.parse(JSON.stringify(layout.annotations || []));
// Track visibility per trace index (0=noise, 1..N=clusters)
const traceVisible = traces.map((t, i) => t.visible !== 'legendonly');

Plotly.newPlot('plot', traces, layout, config);

// ── Custom sidebar legend ─────────────────────────
(function buildSidebar() {{
  const list = document.getElementById('cluster-list');
  let html = '';
  for (const item of legendItems) {{
    if (item.type === 'group') {{
      html += '<div class="legend-group-title">' + item.label + '</div>';
    }} else {{
      const dimmed = !traceVisible[item.traceIdx] ? ' dimmed' : '';
      html += '<div class="legend-item' + dimmed + '" data-trace="' + item.traceIdx + '" data-cid="' + item.cid + '">'
        + '<span class="legend-swatch" style="background:' + item.color + '"></span>'
        + '<span class="legend-label" title="' + esc(item.label) + '">' + esc(item.label) + '</span>'
        + '<span class="legend-count">' + item.size + '</span>'
        + '</div>';
    }}
  }}
  list.innerHTML = html;

  // Click = toggle visibility, right-click = show detail panel
  list.addEventListener('click', function(e) {{
    const el = e.target.closest('.legend-item');
    if (!el) return;
    const idx = parseInt(el.dataset.trace);
    toggleTrace(idx);
    el.classList.toggle('dimmed', !traceVisible[idx]);
  }});

  list.addEventListener('dblclick', function(e) {{
    const el = e.target.closest('.legend-item');
    if (!el) return;
    e.preventDefault();
    const cid = parseInt(el.dataset.cid);
    showClusterDetail(cid);
  }});

  list.addEventListener('contextmenu', function(e) {{
    const el = e.target.closest('.legend-item');
    if (!el) return;
    e.preventDefault();
    const cid = parseInt(el.dataset.cid);
    showClusterDetail(cid);
  }});
}})();

function toggleTrace(idx) {{
  traceVisible[idx] = !traceVisible[idx];
  Plotly.restyle('plot', {{ visible: traceVisible[idx] ? true : 'legendonly' }}, [idx]);
}}

function syncSidebarDimming() {{
  document.querySelectorAll('.legend-item').forEach(el => {{
    const idx = parseInt(el.dataset.trace);
    el.classList.toggle('dimmed', !traceVisible[idx]);
  }});
}}

// ── Click to open artwork ─────────────────────────
document.getElementById('plot').on('plotly_click', function(data) {{
  if (data.points.length > 0) {{
    const objNum = data.points[0].customdata;
    if (objNum) {{
      window.open('https://www.rijksmuseum.nl/nl/collectie/' + objNum, '_blank');
    }}
  }}
}});

// ── Zone/cluster display ──────────────────────────
function showZone(zone) {{
  currentZone = zone;
  for (let i = 0; i < traces.length; i++) {{
    if (i === NOISE_TRACE_IDX) {{
      traceVisible[i] = noiseVisible;
      continue;
    }}
    const name = traces[i].name || '';
    if (zone === 'all') {{
      traceVisible[i] = true;
    }} else if (zone === 'core') {{
      traceVisible[i] = name.startsWith('[C]');
    }} else if (zone === 'associated') {{
      traceVisible[i] = name.startsWith('[C]') || name.startsWith('[A]');
    }}
  }}
  const vis = traceVisible.map(v => v ? true : 'legendonly');
  Plotly.restyle('plot', {{ visible: vis }});
  syncSidebarDimming();
  showToast(zone === 'all' ? 'All clusters' : zone === 'core' ? 'Smell core only' : 'Core + associated');
}}

function toggleLabels() {{
  labelsVisible = !labelsVisible;
  // Deep-copy each time — Plotly.relayout mutates the object it receives
  Plotly.relayout('plot', {{ 'annotations': labelsVisible ? JSON.parse(JSON.stringify(savedAnnotations)) : [] }});
  showToast(labelsVisible ? 'Labels shown' : 'Labels hidden');
}}

function toggleNoise() {{
  if (NOISE_TRACE_IDX < 0) return;  // no noise trace exists
  noiseVisible = !noiseVisible;
  traceVisible[NOISE_TRACE_IDX] = noiseVisible;
  Plotly.restyle('plot', {{ visible: noiseVisible ? true : 'legendonly' }}, [NOISE_TRACE_IDX]);
  showToast(noiseVisible ? 'Noise shown' : 'Noise hidden');
}}

function resetZoom() {{
  Plotly.relayout('plot', {{ 'xaxis.autorange': true, 'yaxis.autorange': true }});
  showToast('Fit all');
}}

// ── Zoom/pan (pre-computed extent) ────────────────
let toastTimeout;
function showToast(msg) {{
  const el = document.getElementById('zoom-toast');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.opacity = '1';
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(function() {{
    el.style.opacity = '0';
    setTimeout(function() {{ el.style.display = 'none'; }}, 300);
  }}, 1200);
}}

function getRange() {{
  const pl = document.getElementById('plot')._fullLayout;
  return {{
    xr: [Number(pl.xaxis.range[0]), Number(pl.xaxis.range[1])],
    yr: [Number(pl.yaxis.range[0]), Number(pl.yaxis.range[1])]
  }};
}}

function zoomBy(factor) {{
  const r = getRange();
  const xc = (r.xr[0] + r.xr[1]) / 2;
  const yc = (r.yr[0] + r.yr[1]) / 2;
  const xh = (r.xr[1] - r.xr[0]) / 2 * factor;
  const yh = (r.yr[1] - r.yr[0]) / 2 * factor;
  Plotly.relayout('plot', {{
    'xaxis.range': [xc - xh, xc + xh],
    'yaxis.range': [yc - yh, yc + yh]
  }});
  showToast(factor < 1 ? 'Zoom in' : 'Zoom out');
}}

function zoomToLevel(level) {{
  const d = dataExtent;
  const xc = (d.xMin + d.xMax) / 2;
  const yc = (d.yMin + d.yMax) / 2;
  const xh = (d.xMax - d.xMin) / 2 / level * 1.05;
  const yh = (d.yMax - d.yMin) / 2 / level * 1.05;
  Plotly.relayout('plot', {{
    'xaxis.range': [xc - xh, xc + xh],
    'yaxis.range': [yc - yh, yc + yh]
  }});
  showToast(level === 1 ? 'Fit all' : level + '\u00d7 zoom');
}}

function panBy(dx, dy) {{
  const r = getRange();
  const xs = r.xr[1] - r.xr[0];
  const ys = r.yr[1] - r.yr[0];
  Plotly.relayout('plot', {{
    'xaxis.range': [r.xr[0] + xs * dx, r.xr[1] + xs * dx],
    'yaxis.range': [r.yr[0] + ys * dy, r.yr[1] + ys * dy]
  }});
}}

function closePanel() {{
  document.getElementById('detail-panel').style.display = 'none';
}}

function toggleHelp() {{
  document.getElementById('help-overlay').classList.toggle('visible');
}}

// ── HTML escape helper (prevent XSS from vocab labels) ──
function esc(s) {{
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}}

// ── Detail panel ──────────────────────────────────
function showClusterDetail(cid) {{
  const d = clusterDetail[cid];
  if (!d) return;
  const zoneClass = 'zone-' + d.zone;
  const zoneName = d.zone.charAt(0).toUpperCase() + d.zone.slice(1);

  function renderBars(items, color) {{
    if (!items || !items.length) return '<em>none</em>';
    const maxVal = items[0][1];
    var html = '';
    for (var i = 0; i < items.length; i++) {{
      var w = Math.max(2, (items[i][1] / maxVal) * 150);
      html += '<div class="bar"><div class="bar-fill" style="width:' + w + 'px;background:' + color + '"></div>'
        + '<span class="bar-text">' + esc(items[i][0]) + ' (' + items[i][1] + ')</span></div>';
    }}
    return html;
  }}

  var smellTags = '';
  if (d.smell_subjects && d.smell_subjects.length) {{
    smellTags = '<div class="bar-section">Smell-related subjects</div>';
    for (var i = 0; i < d.smell_subjects.length; i++) {{
      smellTags += '<span class="smell-tag">' + esc(d.smell_subjects[i][0]) + ' (' + d.smell_subjects[i][1] + ')</span> ';
    }}
  }}

  document.getElementById('detail-content').innerHTML =
    '<h3>Cluster ' + cid + ': ' + esc(d.label) + '</h3>'
    + '<span class="zone-badge ' + zoneClass + '">' + zoneName + '</span>'
    + '<div class="stat"><b>Size:</b> ' + d.size + ' artworks</div>'
    + '<div class="stat"><b>Smell core:</b> ' + d.core_count + ' (' + d.core_fraction + '%)</div>'
    + '<div class="stat"><b>Avg smell score:</b> ' + d.avg_smell_score + '</div>'
    + '<div class="bar-section">Top subjects</div>'
    + renderBars(d.top_subjects, '#E63946')
    + smellTags
    + '<div class="bar-section">Object types</div>'
    + renderBars(d.top_types, '#457B9D')
    + '<div class="bar-section">Top creators</div>'
    + renderBars(d.top_creators, '#2A9D8F')
    + '<div class="bar-section">Materials</div>'
    + renderBars(d.top_materials, '#E76F51')
    + '<div class="bar-section">Techniques</div>'
    + renderBars(d.top_techniques, '#264653');

  document.getElementById('detail-panel').style.display = 'block';
}}

// ── Keyboard (capture phase — fires before Plotly) ─
window.addEventListener('keydown', function(e) {{
  // Allow normal typing in inputs
  var tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  // Don't intercept Cmd/Ctrl combinations (browser shortcuts)
  if (e.metaKey || e.ctrlKey) return;

  var shift = e.shiftKey;
  var step = shift ? 0.3 : 0.1;
  var handled = true;

  switch (e.key) {{
    case '+': case '=': zoomBy(0.6); break;
    case '-': case '_': zoomBy(1.5); break;
    case '0': zoomToLevel(1); break;
    case '1': zoomToLevel(2); break;
    case '2': zoomToLevel(4); break;
    case '3': zoomToLevel(8); break;
    case 'ArrowLeft':  panBy(-step, 0); break;
    case 'ArrowRight': panBy(step, 0); break;
    case 'ArrowUp':    panBy(0, step); break;
    case 'ArrowDown':  panBy(0, -step); break;
    case 'l': case 'L': toggleLabels(); break;
    case 'n': case 'N': toggleNoise(); break;
    case 'a': case 'A': showZone(currentZone === 'all' ? 'associated' : 'all'); break;
    case 'c': case 'C': showZone(currentZone === 'core' ? 'associated' : 'core'); break;
    case '?': case 'h': case 'H': toggleHelp(); break;
    case 'Escape':
      document.getElementById('help-overlay').classList.remove('visible');
      closePanel();
      break;
    default:
      handled = false;
  }}

  if (handled) {{
    e.preventDefault();
    e.stopPropagation();
  }}
}}, true);  // ← capture phase: fires BEFORE Plotly's handlers
</script>
</body>
</html>"""

SMELL_HTML = OUTPUT_DIR / "smell-cluster-explorer.html"
with open(SMELL_HTML, "w") as f:
    f.write(html)

# ── 12. Save report ─────────────────────────────────────
report_path = OUTPUT_DIR / "smell-cluster-report.md"
with open(report_path, "w") as f:
    f.write("# Rijksmuseum — Smell & Olfaction Cluster Analysis\n\n")
    f.write(f"**Sample:** {len(art_ids):,} artworks ({is_core.sum():,} smell core + {is_neighbor.sum():,} neighbors + {is_background.sum():,} background)\n")
    f.write(f"**Clusters:** {n_clusters} total ({len(core_clusters)} core, {len(assoc_clusters)} associated, {len(periph_clusters)} peripheral)\n")
    f.write(f"**Noise:** {n_noise:,} ({n_noise/len(labels)*100:.1f}%)\n")
    f.write(f"**Queries:** {len(SMELL_QUERIES)} multilingual (EN, NL, FR, DE, LA)\n\n")

    for zone, label in [("core", "Smell Core"), ("associated", "Associated"), ("peripheral", "Peripheral")]:
        cids = sorted([cid for cid, p in cluster_profiles.items() if p["zone"] == zone],
                      key=lambda c: -cluster_profiles[c]["core_fraction"])
        if not cids:
            continue
        f.write(f"## {label} Clusters\n\n")
        for cid in cids:
            p = cluster_profiles[cid]
            f.write(f"### Cluster {cid}: {p['label']}\n")
            f.write(f"Size: {p['size']} | Core: {p['core_count']} ({p['core_fraction']*100:.0f}%) | Smell score: {p['avg_smell_score']:.3f}\n\n")
            if p["smell_subjects"]:
                f.write(f"**Smell subjects:** {', '.join(f'{s} ({c})' for s, c in p['smell_subjects'])}\n\n")
            f.write(f"**Types:** {', '.join(f'{t} ({c})' for t, c in p['top_types'])}\n")
            f.write(f"**Subjects:** {', '.join(f'{t} ({c})' for t, c in p['top_subjects'])}\n")
            f.write(f"**Creators:** {', '.join(f'{t} ({c})' for t, c in p['top_creators'])}\n")
            f.write(f"**Materials:** {', '.join(f'{t} ({c})' for t, c in p['top_materials'])}\n")
            f.write(f"**Techniques:** {', '.join(f'{t} ({c})' for t, c in p['top_techniques'])}\n\n")

print(f"\nReport: {report_path}")
print(f"Interactive: {SMELL_HTML}")
print(f"  Size: {SMELL_HTML.stat().st_size / 1024:.0f} KB")
print(f"\nOpen with: open '{SMELL_HTML}'")
