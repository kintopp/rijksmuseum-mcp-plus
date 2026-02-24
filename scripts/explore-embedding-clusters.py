#!/usr/bin/env python3
"""
Exploratory analysis of Rijksmuseum embedding clusters.
Samples embeddings, reduces dimensions with UMAP, clusters with HDBSCAN,
and labels clusters using vocabulary DB metadata.
"""

import sqlite3
import struct
import random
import numpy as np
import pandas as pd
from pathlib import Path

# ── Config ──────────────────────────────────────────────
EMBEDDINGS_DB = Path(__file__).parent.parent / "data" / "embeddings.db"
VOCAB_DB = Path(__file__).parent.parent / "data" / "vocabulary.db"
SAMPLE_SIZE = 20_000
RANDOM_SEED = 42
OUTPUT_DIR = Path(__file__).parent.parent / "offline" / "explorations" / "embedding-clusters"

# ── 1. Sample embeddings ────────────────────────────────
print(f"Loading embeddings from {EMBEDDINGS_DB}...")
edb = sqlite3.connect(str(EMBEDDINGS_DB))
total = edb.execute("SELECT COUNT(*) FROM artwork_embeddings").fetchone()[0]
print(f"Total embeddings: {total:,}")

# Reservoir sampling: fetch IDs first, then retrieve only selected BLOBs
# (ORDER BY RANDOM() would materialise all 831K BLOBs into a temp sort buffer)
random.seed(RANDOM_SEED)
all_ids = edb.execute("SELECT art_id FROM artwork_embeddings").fetchall()
sampled = random.sample(all_ids, min(SAMPLE_SIZE, len(all_ids)))
sampled_ids = [r[0] for r in sampled]

BATCH_SIZE = 990
rows = []
for batch_start in range(0, len(sampled_ids), BATCH_SIZE):
    batch = sampled_ids[batch_start:batch_start + BATCH_SIZE]
    ph = ",".join("?" * len(batch))
    rows.extend(edb.execute(
        f"SELECT art_id, object_number, embedding FROM artwork_embeddings WHERE art_id IN ({ph})",
        batch,
    ).fetchall())
edb.close()
print(f"Sampled {len(rows):,} embeddings")

art_ids = [r[0] for r in rows]
object_numbers = [r[1] for r in rows]

# Decode int8 blobs → numpy array
def decode_int8_blob(blob):
    return np.array(struct.unpack(f'{len(blob)}b', blob), dtype=np.int8)

embeddings = np.array([decode_int8_blob(r[2]) for r in rows], dtype=np.float32)
print(f"Embedding matrix shape: {embeddings.shape}")

# ── 2. Fetch metadata from vocab DB ────────────────────
print(f"\nFetching metadata from {VOCAB_DB}...")
vdb = sqlite3.connect(str(VOCAB_DB))

# Check if integer-encoded schema
has_int = vdb.execute(
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='field_lookup'"
).fetchone()[0] > 0

if has_int:
    # Get field IDs for key fields
    field_map = dict(vdb.execute("SELECT name, id FROM field_lookup").fetchall())

    # Object type (field: object_type)
    type_field_id = field_map.get("type")
    creator_field_id = field_map.get("creator")
    subject_field_id = field_map.get("subject")
    material_field_id = field_map.get("material")
    technique_field_id = field_map.get("technique")

    # Guard: warn about missing field IDs (None → SQL NULL → silent empty results)
    for name, fid in [("type", type_field_id), ("creator", creator_field_id),
                      ("subject", subject_field_id), ("material", material_field_id),
                      ("technique", technique_field_id)]:
        if fid is None:
            print(f"  WARNING: field '{name}' not found in field_lookup — metadata will be missing")

    field_ids = [fid for fid in [type_field_id, creator_field_id, subject_field_id,
                                  material_field_id, technique_field_id] if fid is not None]

    meta = {}
    for art_id, obj_num in zip(art_ids, object_numbers):
        meta[art_id] = {"object_number": obj_num, "types": [], "creators": [], "subjects": [], "materials": [], "techniques": []}

    # Batch query in chunks to stay within SQLITE_LIMIT_VARIABLE_NUMBER
    print("  Querying mappings...")
    if not field_ids:
        print("  WARNING: no valid field IDs — skipping metadata query")
    else:
        BATCH = 990 - len(field_ids)  # leave room for field ID params
        field_ph = ",".join("?" * len(field_ids))
        for batch_start in range(0, len(art_ids), BATCH):
            batch_ids = art_ids[batch_start:batch_start + BATCH]
            ph = ",".join("?" * len(batch_ids))
            query = f"""
                SELECT m.artwork_id, m.field_id, COALESCE(v.label_en, v.label_nl)
                FROM mappings m
                JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
                WHERE m.artwork_id IN ({ph})
                  AND m.field_id IN ({field_ph})
            """
            params = batch_ids + field_ids
            for art_id, field_id, label in vdb.execute(query, params):
                if art_id not in meta:
                    continue
                if field_id == type_field_id:
                    meta[art_id]["types"].append(label)
                elif field_id == creator_field_id:
                    meta[art_id]["creators"].append(label)
                elif field_id == subject_field_id:
                    meta[art_id]["subjects"].append(label)
                elif field_id == material_field_id:
                    meta[art_id]["materials"].append(label)
                elif field_id == technique_field_id:
                    meta[art_id]["techniques"].append(label)

    print(f"  Got metadata for {len(meta):,} artworks")
else:
    print("  WARNING: Text-schema DB, falling back to simple query")
    meta = {aid: {"object_number": on, "types": [], "creators": [], "subjects": [], "materials": [], "techniques": []}
            for aid, on in zip(art_ids, object_numbers)}

vdb.close()

# ── 3. UMAP dimensionality reduction ───────────────────
print("\nRunning UMAP (this may take a minute)...")
import umap

reducer = umap.UMAP(
    n_components=2,
    n_neighbors=30,
    min_dist=0.1,
    metric="cosine",
    random_state=RANDOM_SEED,
    verbose=True,
)
coords_2d = reducer.fit_transform(embeddings)
print(f"UMAP output shape: {coords_2d.shape}")

# ── 4. HDBSCAN clustering ──────────────────────────────
print("\nRunning HDBSCAN clustering...")
import hdbscan

clusterer = hdbscan.HDBSCAN(
    min_cluster_size=100,
    min_samples=10,
    metric="euclidean",  # on UMAP coords
    cluster_selection_method="eom",
)
labels = clusterer.fit_predict(coords_2d)
n_clusters = len(set(labels)) - (1 if -1 in labels else 0)
n_noise = (labels == -1).sum()
print(f"Found {n_clusters} clusters, {n_noise:,} noise points ({n_noise/len(labels)*100:.1f}%)")

# ── 5. Analyze clusters ────────────────────────────────
print("\nAnalyzing cluster compositions...")
from collections import Counter

cluster_profiles = {}
for cluster_id in sorted(set(labels)):
    if cluster_id == -1:
        continue
    mask = labels == cluster_id
    cluster_size = mask.sum()

    # Aggregate metadata
    type_counts = Counter()
    creator_counts = Counter()
    subject_counts = Counter()
    material_counts = Counter()
    technique_counts = Counter()

    for i in np.where(mask)[0]:
        aid = art_ids[i]
        m = meta[aid]
        type_counts.update(m["types"])
        creator_counts.update(m["creators"])
        subject_counts.update(m["subjects"])
        material_counts.update(m["materials"])
        technique_counts.update(m["techniques"])

    cluster_profiles[cluster_id] = {
        "size": int(cluster_size),
        "top_types": type_counts.most_common(5),
        "top_creators": creator_counts.most_common(5),
        "top_subjects": subject_counts.most_common(10),
        "top_materials": material_counts.most_common(5),
        "top_techniques": technique_counts.most_common(5),
        "centroid": coords_2d[mask].mean(axis=0),
    }

# ── 6. Generate labels for clusters ────────────────────
def summarize_cluster(profile):
    """Generate a short label from top metadata."""
    parts = []
    if profile["top_types"]:
        parts.append(profile["top_types"][0][0])
    if profile["top_subjects"]:
        parts.append(profile["top_subjects"][0][0])
    if profile["top_techniques"]:
        parts.append(f"({profile['top_techniques'][0][0]})")
    return " · ".join(parts) if parts else "?"

for cid, prof in cluster_profiles.items():
    prof["label"] = summarize_cluster(prof)

# ── 7. Save results ────────────────────────────────────
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Save cluster report
report_path = OUTPUT_DIR / "cluster-report.md"
with open(report_path, "w") as f:
    f.write("# Rijksmuseum Embedding Cluster Analysis\n\n")
    f.write(f"**Sample size:** {SAMPLE_SIZE:,} of {total:,} embeddings\n")
    f.write(f"**Clusters found:** {n_clusters}\n")
    f.write(f"**Noise points:** {n_noise:,} ({n_noise/len(labels)*100:.1f}%)\n\n")

    for cid in sorted(cluster_profiles.keys()):
        p = cluster_profiles[cid]
        f.write(f"## Cluster {cid}: {p['label']}\n")
        f.write(f"**Size:** {p['size']:,} artworks ({p['size']/SAMPLE_SIZE*100:.1f}%)\n\n")

        f.write("**Object types:** ")
        f.write(", ".join(f"{t} ({c})" for t, c in p["top_types"]))
        f.write("\n\n")

        f.write("**Top creators:** ")
        f.write(", ".join(f"{t} ({c})" for t, c in p["top_creators"]))
        f.write("\n\n")

        f.write("**Top subjects:** ")
        f.write(", ".join(f"{t} ({c})" for t, c in p["top_subjects"]))
        f.write("\n\n")

        f.write("**Top materials:** ")
        f.write(", ".join(f"{t} ({c})" for t, c in p["top_materials"]))
        f.write("\n\n")

        f.write("**Top techniques:** ")
        f.write(", ".join(f"{t} ({c})" for t, c in p["top_techniques"]))
        f.write("\n\n---\n\n")

print(f"Report saved to {report_path}")

# ── 8. Visualization ───────────────────────────────────
print("\nGenerating visualization...")
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

fig, ax = plt.subplots(1, 1, figsize=(16, 12))

# Plot noise points first (grey, small)
noise_mask = labels == -1
ax.scatter(
    coords_2d[noise_mask, 0], coords_2d[noise_mask, 1],
    c="lightgrey", s=1, alpha=0.3, label="noise", zorder=1
)

# Build a colour palette that handles >20 clusters without wrapping
# Combine tab20 + tab20b for 40 distinct colours; fall back to HSV for more
_base_colors = (list(matplotlib.colormaps["tab20"].colors)
                + list(matplotlib.colormaps["tab20b"].colors))
if n_clusters <= len(_base_colors):
    _palette = _base_colors[:n_clusters]
else:
    _hsv = matplotlib.colormaps["hsv"]
    _palette = [_hsv(i / n_clusters) for i in range(n_clusters)]

for i, cid in enumerate(sorted(cluster_profiles.keys())):
    mask = labels == cid
    color = _palette[i]
    ax.scatter(
        coords_2d[mask, 0], coords_2d[mask, 1],
        c=[color], s=3, alpha=0.5, zorder=2
    )
    # Label at centroid
    cx, cy = cluster_profiles[cid]["centroid"]
    ax.annotate(
        f"{cid}: {cluster_profiles[cid]['label']}",
        (cx, cy),
        fontsize=7,
        fontweight="bold",
        ha="center",
        bbox=dict(boxstyle="round,pad=0.3", facecolor="white", edgecolor="grey", alpha=0.8),
        zorder=3,
    )

ax.set_title(f"Rijksmuseum Collection — Embedding Clusters (n={SAMPLE_SIZE:,}, {n_clusters} clusters)", fontsize=14)
ax.set_xlabel("UMAP 1")
ax.set_ylabel("UMAP 2")
ax.set_aspect("equal")
plt.tight_layout()

scatter_path = OUTPUT_DIR / "cluster-map.png"
fig.savefig(scatter_path, dpi=150, bbox_inches="tight")
print(f"Scatter plot saved to {scatter_path}")

# ── 9. Cluster connection analysis ─────────────────────
print("\nAnalyzing inter-cluster connections...")
from scipy.spatial.distance import cdist

centroids = np.array([cluster_profiles[cid]["centroid"] for cid in sorted(cluster_profiles.keys())])
cluster_ids_sorted = sorted(cluster_profiles.keys())
distances = cdist(centroids, centroids, metric="euclidean")

# Find nearest neighbors for each cluster
with open(report_path, "a") as f:
    f.write("\n# Inter-Cluster Connections\n\n")
    f.write("Nearest neighbors by UMAP 2D distance. Note: UMAP is a non-metric non-linear projection; "
            "distances between centroids in 2D space are an approximate guide, not a reliable measure "
            "of semantic similarity in the original 384-dimensional embedding space.\n\n")
    for i, cid in enumerate(cluster_ids_sorted):
        dists = distances[i]
        neighbors = np.argsort(dists)[1:4]  # top 3 nearest (skip self)
        f.write(f"**Cluster {cid}** ({cluster_profiles[cid]['label']}):\n")
        for ni in neighbors:
            ncid = cluster_ids_sorted[ni]
            f.write(f"  → Cluster {ncid} ({cluster_profiles[ncid]['label']}) — dist {dists[ni]:.2f}\n")
        f.write("\n")

# ── 10. Connection visualization ────────────────────────
fig2, ax2 = plt.subplots(1, 1, figsize=(14, 10))

# Draw edges between close clusters
threshold = np.percentile(distances[distances > 0], 30)  # connect closest 30%
for i in range(len(cluster_ids_sorted)):
    for j in range(i + 1, len(cluster_ids_sorted)):
        if distances[i, j] < threshold:
            ax2.plot(
                [centroids[i, 0], centroids[j, 0]],
                [centroids[i, 1], centroids[j, 1]],
                "grey", alpha=0.3, linewidth=1, zorder=1
            )

# Draw nodes
sizes = np.array([cluster_profiles[cid]["size"] for cid in cluster_ids_sorted])
sizes_normalized = (sizes / sizes.max()) * 800 + 100

for i, cid in enumerate(cluster_ids_sorted):
    color = _palette[i]
    ax2.scatter(
        centroids[i, 0], centroids[i, 1],
        c=[color], s=sizes_normalized[i], alpha=0.7, edgecolors="black", linewidth=0.5, zorder=2
    )
    ax2.annotate(
        f"{cid}: {cluster_profiles[cid]['label']}\n(n={cluster_profiles[cid]['size']})",
        (centroids[i, 0], centroids[i, 1]),
        fontsize=6,
        ha="center", va="center",
        fontweight="bold",
        zorder=3,
    )

ax2.set_title("Cluster Connections (edges = UMAP proximity, node size = cluster size)", fontsize=13)
ax2.set_aspect("equal")
plt.tight_layout()

network_path = OUTPUT_DIR / "cluster-network.png"
fig2.savefig(network_path, dpi=150, bbox_inches="tight")
print(f"Network plot saved to {network_path}")

# ── 11. Save raw data for further exploration ───────────
np.savez_compressed(
    OUTPUT_DIR / "cluster-data.npz",
    coords_2d=coords_2d,
    labels=labels,
    art_ids=np.array(art_ids),
    object_numbers=np.array(object_numbers),
)
print(f"Raw data saved to {OUTPUT_DIR / 'cluster-data.npz'}")

print("\nDone! Check the output directory for results.")
