"""Benchmark whether Tigris throttling is per-bucket/credential or per-tenant.

Mounts two Railway/Tigris buckets (indexed-toolchest in US-West, roomy-drum in US-East)
on every Modal container and runs five phases with disjoint key slices:

  1. West-N2  — 2 workers reading WEST only
  2. West-N4  — 4 workers reading WEST only
  3. East-N2  — 2 workers reading EAST only
  4. East-N4  — 4 workers reading EAST only
  5. Dual-N4  — 2 workers reading WEST + 2 workers reading EAST simultaneously

Disjoint key slices per bucket:
  - Phase 1 & 3:    keys[0..39]      (2 workers × 20)
  - Phase 2 & 4:    keys[40..119]    (4 workers × 20)
  - Phase 5:        keys[120..159]   (2+2 workers × 20, fresh for both sides)

The Dual-N4 aggregate tells us the throttle scope:
  - ≈ sum(West-N2 + East-N2)    → per-bucket/credential → sharding wins
  - ≈ max(West-N4, East-N4)     → per-tenant            → buckets don't help
  - between                       → partial independence

Run:
  export RAILWAY_WEST_KEY=... RAILWAY_WEST_SECRET=... RAILWAY_WEST_BUCKET=...
  export RAILWAY_EAST_KEY=... RAILWAY_EAST_SECRET=... RAILWAY_EAST_BUCKET=...
  ~/miniconda3/envs/embeddings/bin/modal run scripts/tests/bench-dual-bucket.py
"""

import os
import time

import modal

# Bucket identifiers (metadata, not secrets) — needed on both local and remote sides.
WEST_BUCKET = os.environ.get("RAILWAY_WEST_BUCKET", "indexed-toolchest-yrqgfc9")
EAST_BUCKET = os.environ.get("RAILWAY_EAST_BUCKET", "roomy-drum-tqirbncqucjpzl")
TIGRIS_ENDPOINT = "https://t3.storageapi.dev"
KEY_PREFIX = "fanout2/"

# Generated filename style produced by prior session's seed: 5-char alphanumeric + ".jpg".
# We list at runtime in the local entrypoint rather than hardcoding.

image = modal.Image.debian_slim()
app = modal.App("rijks-dual-bucket-bench", image=image)


def make_secret(env_key_var: str, env_secret_var: str) -> modal.Secret:
    # Values captured here at local deploy time are embedded in the app; on the
    # remote the module re-imports without these env vars set, hence .get("") —
    # the empty-dict object is never used at runtime, only satisfies decorator.
    return modal.Secret.from_dict({
        "AWS_ACCESS_KEY_ID": os.environ.get(env_key_var, ""),
        "AWS_SECRET_ACCESS_KEY": os.environ.get(env_secret_var, ""),
        "AWS_REGION": "auto",  # critical — without this Mountpoint hangs at startup
    })


west_mount = modal.CloudBucketMount(
    bucket_name=WEST_BUCKET,
    bucket_endpoint_url=TIGRIS_ENDPOINT,
    secret=make_secret("RAILWAY_WEST_KEY", "RAILWAY_WEST_SECRET"),
    read_only=True,
)
east_mount = modal.CloudBucketMount(
    bucket_name=EAST_BUCKET,
    bucket_endpoint_url=TIGRIS_ENDPOINT,
    secret=make_secret("RAILWAY_EAST_KEY", "RAILWAY_EAST_SECRET"),
    read_only=True,
)


@app.function(volumes={"/west": west_mount, "/east": east_mount}, max_containers=4)
def read_batch(job: tuple[str, list[str]]) -> tuple[str, float, int, int]:
    """Read a list of keys from the designated bucket mount, byte-by-byte.

    Returns (bucket_label, wall_seconds, bytes_read, num_keys).
    """
    import time as _time

    bucket_label, keys = job
    mount_dir = "/west" if bucket_label == "WEST" else "/east"

    t0 = _time.monotonic()
    total = 0
    for key in keys:
        with open(f"{mount_dir}/{key}", "rb") as f:
            total += len(f.read())
    return (bucket_label, _time.monotonic() - t0, total, len(keys))


@app.local_entrypoint()
def main():
    # Local-only I/O: list keys via boto3 on the laptop, then pass slices into .map()
    import boto3
    from botocore.config import Config

    west_s3 = boto3.client(
        "s3",
        endpoint_url=TIGRIS_ENDPOINT,
        aws_access_key_id=os.environ["RAILWAY_WEST_KEY"],
        aws_secret_access_key=os.environ["RAILWAY_WEST_SECRET"],
        region_name="auto",
        config=Config(s3={"addressing_style": "virtual"}),
    )

    keys: list[str] = []
    for page in west_s3.get_paginator("list_objects_v2").paginate(
        Bucket=WEST_BUCKET, Prefix=KEY_PREFIX
    ):
        for obj in page.get("Contents", []):
            keys.append(obj["Key"])
    keys.sort()
    print(f"available keys in {KEY_PREFIX}: {len(keys)}")
    BATCH = 60  # files per worker per phase
    need = BATCH * 8  # 4 workers × 60 × 2 (phases 2+5) — plus room for warmup keys[800..]
    if len(keys) < need:
        raise SystemExit(f"need at least {need} keys, got {len(keys)}")

    def phase(name: str, jobs: list[tuple[str, list[str]]]):
        n = len(jobs)
        t0 = time.monotonic()
        results = list(read_batch.map(jobs))
        wall = time.monotonic() - t0

        worker_walls = [r[1] for r in results]
        worker_bytes = [r[2] for r in results]
        total_bytes = sum(worker_bytes)
        inside_max = max(worker_walls)
        agg_mbs = total_bytes / wall / 1e6 if wall > 0 else 0
        per_rates = [b / w / 1e6 for b, w in zip(worker_bytes, worker_walls) if w > 0]
        print(
            f"{name:10s}  N={n}  wall={wall:>5.1f}s  inside={inside_max:>5.1f}s  "
            f"total={total_bytes / 1e6:>6.1f}MB  agg={agg_mbs:>5.2f}MB/s  "
            f"per-worker {min(per_rates):.2f}…{max(per_rates):.2f}MB/s"
        )
        return results

    # Warm-up — boot 4 containers with both mounts attached, using keys at the far end
    # (keys[800..803], 1 each) so no byte we measure in phases 1-5 is in any page cache.
    print("warming 4 containers…")
    warm_jobs = [
        ("WEST", [keys[800]]),
        ("WEST", [keys[801]]),
        ("EAST", [keys[802]]),
        ("EAST", [keys[803]]),
    ]
    _ = list(read_batch.map(warm_jobs))
    print("warm.")
    print()

    def slice_(start: int, n: int, step: int) -> list[list[str]]:
        return [keys[start + i * step : start + (i + 1) * step] for i in range(n)]

    # Phase 1 — West N=2, keys[0..2B]
    phase("West-N2", [("WEST", s) for s in slice_(0, 2, BATCH)])

    # Phase 2 — West N=4, keys[2B..6B]
    phase("West-N4", [("WEST", s) for s in slice_(2 * BATCH, 4, BATCH)])

    # Phase 3 — East N=2, keys[0..2B] (different bucket = independent cache)
    phase("East-N2", [("EAST", s) for s in slice_(0, 2, BATCH)])

    # Phase 4 — East N=4, keys[2B..6B]
    phase("East-N4", [("EAST", s) for s in slice_(2 * BATCH, 4, BATCH)])

    # Phase 5 — Dual N=4, keys[6B..8B] fresh on both sides
    phase(
        "Dual-N4",
        [("WEST", s) for s in slice_(6 * BATCH, 2, BATCH)]
        + [("EAST", s) for s in slice_(6 * BATCH, 2, BATCH)],
    )
