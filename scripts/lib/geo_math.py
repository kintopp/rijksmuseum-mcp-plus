"""Shared geographic math helpers.

Antimeridian-safe haversine plus pairwise-spread helpers used by:
  - harvest-vocabulary-db.py propagate_place_coordinates (#255 dateline fix)
  - post_run_diagnostics.py compute_areal_pollution
  - tests/audit_broader_id_spread.py
"""
from __future__ import annotations

import math


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km.

    sin²(dlam/2) folds the longitude difference modulo 2π, so the
    antimeridian (lon=180 ↔ -180) is handled correctly without any
    modular arithmetic on the inputs.
    """
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 6371.0 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def max_pairwise_km(pts: list[tuple[float, float]],
                    early_exit_km: float | None = None) -> float:
    """Max great-circle distance across every pair of points.

    If ``early_exit_km`` is supplied, returns as soon as any pair exceeds
    the threshold — useful when the caller only needs a boolean
    "≥ threshold?" answer.
    """
    if len(pts) < 2:
        return 0.0
    best = 0.0
    for i in range(len(pts)):
        lat1, lon1 = pts[i]
        for j in range(i + 1, len(pts)):
            lat2, lon2 = pts[j]
            d = haversine_km(lat1, lon1, lat2, lon2)
            if d > best:
                best = d
                if early_exit_km is not None and best >= early_exit_km:
                    return best
    return best


def trimmed_pairwise_km(pts: list[tuple[float, float]], drop: int = 2,
                        early_exit_km: float | None = None) -> float:
    """Max pairwise km after dropping the ``drop`` farthest-from-group points.

    "Farthest from group" = highest sum-of-distances to all other points
    (eccentricity). This lets a cluster of nearby children survive even
    if 1-2 are on the wrong continent from a Phase 3b misclassification.

    Returns untrimmed max when ``len(pts) <= drop + 1`` (too few to trim).
    """
    if len(pts) <= drop + 1:
        return max_pairwise_km(pts, early_exit_km=early_exit_km)

    scores: list[float] = []
    for i, p in enumerate(pts):
        s = 0.0
        for j, q in enumerate(pts):
            if i != j:
                s += haversine_km(p[0], p[1], q[0], q[1])
        scores.append(s)

    drop_idxs = set(sorted(range(len(pts)), key=lambda i: scores[i], reverse=True)[:drop])
    kept = [p for i, p in enumerate(pts) if i not in drop_idxs]
    return max_pairwise_km(kept, early_exit_km=early_exit_km)
