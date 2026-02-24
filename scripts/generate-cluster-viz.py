#!/usr/bin/env python3
"""
Generate an interactive HTML visualization of embedding clusters using Plotly.
Loads the pre-computed cluster data and enriches with vocab DB metadata.
"""

import sqlite3
import json
import numpy as np
from pathlib import Path
from collections import Counter

DATA_DIR = Path(__file__).parent.parent / "offline" / "explorations" / "embedding-clusters"
VOCAB_DB = Path(__file__).parent.parent / "data" / "vocabulary.db"
OUTPUT = DATA_DIR / "cluster-explorer.html"

# ── Load pre-computed data ──────────────────────────────
print("Loading cluster data...")
data = np.load(DATA_DIR / "cluster-data.npz", allow_pickle=True)
coords = data["coords_2d"]
labels = data["labels"]
art_ids = data["art_ids"]
object_numbers = data["object_numbers"]

n_total = len(labels)
n_clusters = len(set(labels)) - (1 if -1 in labels else 0)
print(f"Loaded {n_total:,} points, {n_clusters} clusters")

# ── Fetch metadata ──────────────────────────────────────
print("Fetching metadata from vocab DB...")
vdb = sqlite3.connect(str(VOCAB_DB))

# Guard: require integer-encoded schema (v0.13+)
has_int = vdb.execute(
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='field_lookup'"
).fetchone()[0] > 0
if not has_int:
    raise RuntimeError("vocabulary.db uses the old text schema; requires v0.13+ integer-encoded DB")

field_map = dict(vdb.execute("SELECT name, id FROM field_lookup").fetchall())

type_fid = field_map.get("type")
creator_fid = field_map.get("creator")
subject_fid = field_map.get("subject")
material_fid = field_map.get("material")
technique_fid = field_map.get("technique")

# Guard: warn about missing field IDs
for name, fid in [("type", type_fid), ("creator", creator_fid),
                  ("subject", subject_fid), ("material", material_fid),
                  ("technique", technique_fid)]:
    if fid is None:
        print(f"  WARNING: field '{name}' not found in field_lookup — metadata will be missing")

field_ids = [fid for fid in [type_fid, creator_fid, subject_fid,
                              material_fid, technique_fid] if fid is not None]

# Fetch titles and vocab metadata in batches to stay within SQLITE_LIMIT_VARIABLE_NUMBER
BATCH = 990
title_map = {}
id_list = art_ids.tolist()
for batch_start in range(0, len(id_list), BATCH):
    batch = id_list[batch_start:batch_start + BATCH]
    ph = ",".join("?" * len(batch))
    for art_id, obj_num, title in vdb.execute(
        f"SELECT art_id, object_number, title FROM artworks WHERE art_id IN ({ph})",
        batch
    ):
        title_map[art_id] = title or ""

# Fetch vocab metadata
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
        for art_id, field_id, label in vdb.execute(query, params):
            if art_id not in meta:
                continue
            if field_id == type_fid:
                meta[art_id]["types"].append(label)
            elif field_id == creator_fid:
                meta[art_id]["creators"].append(label)
            elif field_id == subject_fid:
                meta[art_id]["subjects"].append(label)
            elif field_id == material_fid:
                meta[art_id]["materials"].append(label)
            elif field_id == technique_fid:
                meta[art_id]["techniques"].append(label)

vdb.close()
print(f"Fetched metadata for {len(meta):,} artworks")

# ── Build cluster labels ────────────────────────────────
cluster_labels = {}
cluster_sizes = {}
for cid in sorted(set(labels)):
    mask = labels == cid
    size = int(mask.sum())
    cluster_sizes[int(cid)] = size
    if cid == -1:
        cluster_labels[-1] = "Noise"
        continue
    type_counts = Counter()
    subject_counts = Counter()
    technique_counts = Counter()
    for i in np.where(mask)[0]:
        aid = int(art_ids[i])
        type_counts.update(meta[aid]["types"])
        subject_counts.update(meta[aid]["subjects"])
        technique_counts.update(meta[aid]["techniques"])
    parts = []
    if type_counts:
        parts.append(type_counts.most_common(1)[0][0])
    if subject_counts:
        parts.append(subject_counts.most_common(1)[0][0])
    label = " · ".join(parts) if parts else f"Cluster {cid}"
    cluster_labels[int(cid)] = label

# ── Build hover text ────────────────────────────────────
print("Building hover text...")
hover_texts = []
for i in range(n_total):
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
        lines.append(f"Subjects: {', '.join(m['subjects'][:3])}")
    if m["materials"]:
        lines.append(f"Material: {', '.join(m['materials'][:2])}")
    if m["techniques"]:
        lines.append(f"Technique: {', '.join(m['techniques'][:2])}")
    hover_texts.append("<br>".join(lines))

# ── Generate Plotly JSON traces ─────────────────────────
print("Generating Plotly traces...")

# Color palette — 35 clusters + noise
COLORS = [
    "#636EFA", "#EF553B", "#00CC96", "#AB63FA", "#FFA15A",
    "#19D3F3", "#FF6692", "#B6E880", "#FF97FF", "#FECB52",
    "#1F77B4", "#FF7F0E", "#2CA02C", "#D62728", "#9467BD",
    "#8C564B", "#E377C2", "#7F7F7F", "#BCBD22", "#17BECF",
    "#AEC7E8", "#FFBB78", "#98DF8A", "#FF9896", "#C5B0D5",
    "#C49C94", "#F7B6D2", "#C7C7C7", "#DBDB8D", "#9EDAE5",
    "#393B79", "#637939", "#8C6D31", "#843C39", "#7B4173",
    "#BD9E39",
]

traces = []

# Noise first (so it's behind)
noise_mask = labels == -1
if noise_mask.any():
    traces.append({
        "x": coords[noise_mask, 0].tolist(),
        "y": coords[noise_mask, 1].tolist(),
        "text": [hover_texts[i] for i in np.where(noise_mask)[0]],
        "customdata": [str(object_numbers[i]) for i in np.where(noise_mask)[0]],
        "mode": "markers",
        "type": "scattergl",
        "name": f"Noise ({noise_mask.sum():,})",
        "marker": {"color": "#ddd", "size": 3, "opacity": 0.3},
        "hovertemplate": "%{text}<extra>Noise</extra>",
        "visible": "legendonly",
    })

# Each cluster
for idx, cid in enumerate(sorted(c for c in set(labels) if c != -1)):
    mask = labels == cid
    color = COLORS[idx % len(COLORS)]
    label = cluster_labels[int(cid)]
    size = cluster_sizes[int(cid)]
    traces.append({
        "x": coords[mask, 0].tolist(),
        "y": coords[mask, 1].tolist(),
        "text": [hover_texts[i] for i in np.where(mask)[0]],
        "customdata": [str(object_numbers[i]) for i in np.where(mask)[0]],
        "mode": "markers",
        "type": "scattergl",
        "name": f"{cid}: {label} ({size:,})",
        "marker": {"color": color, "size": 4, "opacity": 0.6},
        "hovertemplate": "%{text}<extra>Cluster " + str(cid) + "</extra>",
    })

# Centroid annotations
annotations = []
for cid in sorted(c for c in set(labels) if c != -1):
    mask = labels == cid
    cx, cy = coords[mask].mean(axis=0)
    short_label = cluster_labels[int(cid)]
    if len(short_label) > 40:
        short_label = short_label[:37] + "..."
    annotations.append({
        "x": float(cx), "y": float(cy),
        "text": f"<b>{cid}</b>: {short_label}",
        "showarrow": False,
        "font": {"size": 9, "color": "#333"},
        "bgcolor": "rgba(255,255,255,0.8)",
        "bordercolor": "#999",
        "borderwidth": 1,
        "borderpad": 2,
    })

layout = {
    "title": {
        "text": f"Rijksmuseum Collection — Embedding Clusters<br><sub>20,000 of 831,667 artworks · {n_clusters} clusters · UMAP + HDBSCAN</sub>",
        "font": {"size": 18},
    },
    "xaxis": {"title": "UMAP 1", "showgrid": False, "zeroline": False},
    "yaxis": {"title": "UMAP 2", "showgrid": False, "zeroline": False, "scaleanchor": "x"},
    "hovermode": "closest",
    "legend": {
        "title": {"text": "Clusters (click to toggle)"},
        "font": {"size": 10},
        "itemsizing": "constant",
        "tracegroupgap": 2,
    },
    "annotations": annotations,
    "paper_bgcolor": "#fafafa",
    "plot_bgcolor": "#fff",
    "margin": {"t": 80, "b": 50, "l": 50, "r": 20},
}

# ── Pre-compute data extent (exclude noise for tighter fit) ──────
non_noise = labels != -1
extent_coords = coords[non_noise] if non_noise.any() else coords
data_extent = {
    "xMin": float(extent_coords[:, 0].min()), "xMax": float(extent_coords[:, 0].max()),
    "yMin": float(extent_coords[:, 1].min()), "yMax": float(extent_coords[:, 1].max()),
}

# ── Write HTML ──────────────────────────────────────────
print("Writing HTML...")

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Rijksmuseum Embedding Clusters</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #fafafa; }}
  #controls {{ padding: 12px 20px; display: flex; gap: 16px; align-items: center; background: #fff; border-bottom: 1px solid #e0e0e0; }}
  #controls button {{
    padding: 6px 14px; border: 1px solid #ccc; border-radius: 4px;
    background: #fff; cursor: pointer; font-size: 13px;
  }}
  #controls button:hover {{ background: #f0f0f0; }}
  #controls .info {{ color: #666; font-size: 13px; margin-left: auto; }}
  kbd {{ background: #eee; padding: 1px 5px; border-radius: 3px; border: 1px solid #ccc; font-size: 11px; }}
  #plot {{ width: 100vw; height: calc(100vh - 48px); }}

  /* Cluster detail panel */
  #detail-panel {{
    display: none; position: fixed; right: 20px; top: 60px;
    width: 340px; max-height: calc(100vh - 80px); overflow-y: auto;
    background: #fff; border: 1px solid #ccc; border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.15); padding: 16px; z-index: 100;
    font-size: 13px; line-height: 1.5;
  }}
  #detail-panel h3 {{ margin-bottom: 8px; font-size: 15px; }}
  #detail-panel .close {{ position: absolute; top: 8px; right: 12px; cursor: pointer; font-size: 18px; color: #999; }}
  #detail-panel .close:hover {{ color: #333; }}
  #detail-panel .stat {{ margin: 4px 0; }}
  #detail-panel .stat b {{ color: #444; }}
  #detail-panel .bar-container {{ margin: 12px 0 4px; }}
  #detail-panel .bar-label {{ font-size: 12px; color: #666; margin-bottom: 4px; }}
  #detail-panel .bar {{
    display: flex; align-items: center; margin: 2px 0; font-size: 12px;
  }}
  #detail-panel .bar-fill {{
    height: 16px; background: #636EFA; border-radius: 2px; margin-right: 6px;
    min-width: 2px; transition: width 0.3s;
  }}
  #detail-panel .bar-text {{ white-space: nowrap; color: #555; }}

  /* Keyboard shortcut help overlay */
  #help-overlay {{
    display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    z-index: 200; justify-content: center; align-items: center;
  }}
  #help-overlay.visible {{ display: flex; }}
  #help-box {{
    background: #fff; border-radius: 10px; padding: 24px 32px;
    max-width: 420px; box-shadow: 0 8px 30px rgba(0,0,0,0.3);
  }}
  #help-box h3 {{ margin: 0 0 14px; font-size: 16px; }}
  #help-box table {{ border-collapse: collapse; width: 100%; }}
  #help-box td {{ padding: 4px 0; font-size: 13px; }}
  #help-box td:first-child {{ font-family: monospace; font-weight: bold; color: #444; padding-right: 16px; white-space: nowrap; }}
  #help-box .section {{ font-weight: bold; color: #888; padding-top: 10px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }}

  /* Zoom indicator toast */
  #zoom-toast {{
    display: none; position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: rgba(0,0,0,0.75); color: #fff; padding: 6px 16px; border-radius: 20px;
    font-size: 13px; z-index: 150; pointer-events: none; transition: opacity 0.3s;
  }}
</style>
</head>
<body>

<div id="controls">
  <button onclick="toggleLabels()"><kbd>L</kbd> Labels</button>
  <button onclick="toggleNoise()"><kbd>N</kbd> Noise</button>
  <button onclick="showAllClusters()"><kbd>A</kbd> All</button>
  <button onclick="resetZoom()"><kbd>0</kbd> Reset</button>
  <button onclick="toggleHelp()"><kbd>?</kbd> Shortcuts</button>
  <span class="info">Click point → Rijksmuseum · Double-click legend → isolate · <kbd>?</kbd> for all shortcuts</span>
</div>

<div id="plot"></div>

<div id="detail-panel">
  <span class="close" onclick="closePanel()">&times;</span>
  <div id="detail-content"></div>
</div>

<div id="zoom-toast"></div>

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
      <tr><td>?  H</td><td>Toggle this help</td></tr>
      <tr><td>Esc</td><td>Close panels / help</td></tr>
    </table>
  </div>
</div>

<script>
const traces = {json.dumps(traces)};
const layout = {json.dumps(layout)};
const dataExtent = {json.dumps(data_extent)};
const clusterMeta = {json.dumps({int(k): {
    "label": cluster_labels[int(k)],
    "size": cluster_sizes[int(k)]
} for k in set(labels) if k != -1})};

const NOISE_TRACE_IDX = {0 if noise_mask.any() else -1};
const config = {{
  responsive: true,
  scrollZoom: true,
  modeBarButtonsToRemove: ['lasso2d', 'select2d'],
  displaylogo: false,
}};

let labelsVisible = true;

Plotly.newPlot('plot', traces, layout, config);

// Click to open artwork on Rijksmuseum website
document.getElementById('plot').on('plotly_click', function(data) {{
  if (data.points.length > 0) {{
    const objNum = data.points[0].customdata;
    if (objNum) {{
      window.open('https://www.rijksmuseum.nl/nl/collectie/' + objNum, '_blank');
    }}
  }}
}});

// Save annotations before Plotly mutates the layout object
const savedAnnotations = JSON.parse(JSON.stringify(layout.annotations || []));

function toggleLabels() {{
  labelsVisible = !labelsVisible;
  Plotly.relayout('plot', {{ 'annotations': labelsVisible ? JSON.parse(JSON.stringify(savedAnnotations)) : [] }});
  showToast(labelsVisible ? 'Labels shown' : 'Labels hidden');
}}

function showAllClusters() {{
  const visibility = traces.map(() => true);
  Plotly.restyle('plot', {{ visible: visibility }});
  showToast('All clusters shown');
}}

function resetZoom() {{
  Plotly.relayout('plot', {{
    'xaxis.autorange': true,
    'yaxis.autorange': true,
  }});
  showToast('Fit all');
}}

function closePanel() {{
  document.getElementById('detail-panel').style.display = 'none';
}}

// ── Help overlay ──────────────────────────────────
function toggleHelp() {{
  document.getElementById('help-overlay').classList.toggle('visible');
}}

// ── Zoom toast ────────────────────────────────────
let toastTimeout;
function showToast(msg) {{
  const el = document.getElementById('zoom-toast');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.opacity = '1';
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {{ el.style.opacity = '0'; setTimeout(() => el.style.display = 'none', 300); }}, 1200);
}}

// ── Zoom / pan helpers ────────────────────────────
function getRange() {{
  const plotEl = document.getElementById('plot');
  const xr = plotEl._fullLayout.xaxis.range.map(Number);
  const yr = plotEl._fullLayout.yaxis.range.map(Number);
  return {{ xr, yr }};
}}

function zoomBy(factor) {{
  const {{ xr, yr }} = getRange();
  const xc = (xr[0] + xr[1]) / 2, yc = (yr[0] + yr[1]) / 2;
  const xh = (xr[1] - xr[0]) / 2 * factor, yh = (yr[1] - yr[0]) / 2 * factor;
  Plotly.relayout('plot', {{
    'xaxis.range': [xc - xh, xc + xh],
    'yaxis.range': [yc - yh, yc + yh],
  }});
  const level = Math.round(1 / factor * 100) / 100;
  if (factor < 1) showToast('Zoom in');
  else if (factor > 1) showToast('Zoom out');
}}

function zoomToLevel(level) {{
  // level 1 = fit all, level 2 = 2x, etc.
  const d = dataExtent;
  const xc = (d.xMin + d.xMax) / 2, yc = (d.yMin + d.yMax) / 2;
  const xh = (d.xMax - d.xMin) / 2 / level * 1.05;
  const yh = (d.yMax - d.yMin) / 2 / level * 1.05;
  Plotly.relayout('plot', {{
    'xaxis.range': [xc - xh, xc + xh],
    'yaxis.range': [yc - yh, yc + yh],
  }});
  showToast(level === 1 ? 'Fit all' : level + '\u00d7 zoom');
}}

function panBy(dx, dy) {{
  const {{ xr, yr }} = getRange();
  const xSpan = xr[1] - xr[0], ySpan = yr[1] - yr[0];
  Plotly.relayout('plot', {{
    'xaxis.range': [xr[0] + xSpan * dx, xr[1] + xSpan * dx],
    'yaxis.range': [yr[0] + ySpan * dy, yr[1] + ySpan * dy],
  }});
}}

// ── Noise toggle state ────────────────────────────
let noiseVisible = false;  // starts as legendonly
function toggleNoise() {{
  if (NOISE_TRACE_IDX < 0) return;
  noiseVisible = !noiseVisible;
  Plotly.restyle('plot', {{ visible: noiseVisible ? true : 'legendonly' }}, [NOISE_TRACE_IDX]);
  showToast(noiseVisible ? 'Noise shown' : 'Noise hidden');
}}

// ── Keyboard handler (capture phase — fires before Plotly) ──
window.addEventListener('keydown', function(e) {{
  // Allow normal typing in inputs
  var tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  // Don't intercept Cmd/Ctrl combinations (browser shortcuts)
  if (e.metaKey || e.ctrlKey) return;

  var shift = e.shiftKey;
  var step = shift ? 0.3 : 0.1;
  var handled = true;

  switch(e.key) {{
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
    case 'a': case 'A': showAllClusters(); break;
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

with open(OUTPUT, "w") as f:
    f.write(html)

print(f"\nSaved interactive visualization to:\n  {OUTPUT}")
print(f"  File size: {OUTPUT.stat().st_size / 1024:.0f} KB")
print(f"\nOpen with: open '{OUTPUT}'")
