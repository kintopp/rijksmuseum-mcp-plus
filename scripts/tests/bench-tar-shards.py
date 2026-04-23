"""Benchmark tar-sharded reads vs many-small-file reads from a Tigris bucket.

Four modes, one single-bucket Modal run, executed in this order so the "tar" modes
aren't penalised by the leaky-bucket throttle drain that a long baseline would cause:

  B. Mount,  read 1 × all.tar (~322 MB)           single container
  C. boto3,  direct get_object of all.tar         single container
  D. Mount,  read 4 × shard-N.tar (~80 MB each)   4 containers via .map()
  A. Mount,  read 898 individual files (baseline) single container

Assumes pack-bucket-tars.py has already populated bucket:/tars/ with those 5 tars.

Run:
    export RAILWAY_WEST_KEY=... RAILWAY_WEST_SECRET=... RAILWAY_WEST_BUCKET=...
    ~/miniconda3/envs/embeddings/bin/modal run scripts/tests/bench-tar-shards.py
"""

import os
import time

import modal

BUCKET = os.environ.get("RAILWAY_WEST_BUCKET", "indexed-toolchest-yrqgfc9")
TIGRIS_ENDPOINT = "https://t3.storageapi.dev"
FILE_PREFIX = "fanout2/"
TAR_PREFIX = "tars/"
NUM_SHARDS = 4

image = modal.Image.debian_slim().pip_install("boto3")
app = modal.App("rijks-tar-shard-bench", image=image)

bucket_secret = modal.Secret.from_dict(
    {
        "AWS_ACCESS_KEY_ID": os.environ.get("RAILWAY_WEST_KEY", ""),
        "AWS_SECRET_ACCESS_KEY": os.environ.get("RAILWAY_WEST_SECRET", ""),
        "AWS_REGION": "auto",
    }
)

mount = modal.CloudBucketMount(
    bucket_name=BUCKET,
    bucket_endpoint_url=TIGRIS_ENDPOINT,
    secret=bucket_secret,
    read_only=True,
)


@app.function(
    volumes={"/bucket": mount},
    secrets=[bucket_secret],  # exposes creds as env vars for the Mode-C boto3 client
    max_containers=4,
    timeout=900,  # Mode A (hundreds of small GETs) can take many minutes at the throttle floor
)
def do_read(job: tuple[str, list[str]]) -> tuple[str, float, int]:
    """Read one or more keys according to the job's mode.

    job = (mode, keys):
      mode="mount-files"  -> keys = list of S3 keys, read each via the FS mount
      mode="mount-tar"    -> keys = [one tar key], read whole tar via mount
      mode="boto3-tar"    -> keys = [one tar key], read whole tar via boto3 GetObject
    """
    import time as _time

    mode, keys = job
    t0 = _time.monotonic()
    total = 0

    if mode == "mount-files":
        for k in keys:
            with open(f"/bucket/{k}", "rb") as f:
                total += len(f.read())
    elif mode == "mount-tar":
        for k in keys:
            with open(f"/bucket/{k}", "rb") as f:
                while chunk := f.read(8 * 1024 * 1024):
                    total += len(chunk)
    elif mode == "boto3-tar":
        import boto3
        from botocore.config import Config

        s3 = boto3.client(
            "s3",
            endpoint_url=TIGRIS_ENDPOINT,
            region_name="auto",
            config=Config(s3={"addressing_style": "virtual"}, retries={"max_attempts": 5}),
        )
        for k in keys:
            body = s3.get_object(Bucket=BUCKET, Key=k)["Body"]
            while chunk := body.read(8 * 1024 * 1024):
                total += len(chunk)
    else:
        raise ValueError(f"unknown mode: {mode}")

    return (mode, _time.monotonic() - t0, total)


@app.local_entrypoint()
def main():
    import boto3
    from botocore.config import Config

    s3_local = boto3.client(
        "s3",
        endpoint_url=TIGRIS_ENDPOINT,
        aws_access_key_id=os.environ["RAILWAY_WEST_KEY"],
        aws_secret_access_key=os.environ["RAILWAY_WEST_SECRET"],
        region_name="auto",
        config=Config(s3={"addressing_style": "virtual"}),
    )

    # List the 898 individual file keys.
    file_keys: list[str] = []
    for page in s3_local.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=FILE_PREFIX):
        for obj in page.get("Contents", []):
            file_keys.append(obj["Key"])
    file_keys.sort()
    print(f"file keys in {FILE_PREFIX}: {len(file_keys)}")

    # Verify expected tars exist.
    expected_tars = [f"{TAR_PREFIX}all.tar"] + [f"{TAR_PREFIX}shard-{i}.tar" for i in range(NUM_SHARDS)]
    tar_listing = {
        obj["Key"]: obj["Size"]
        for page in s3_local.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=TAR_PREFIX)
        for obj in page.get("Contents", [])
    }
    missing = [t for t in expected_tars if t not in tar_listing]
    if missing:
        raise SystemExit(f"missing tars: {missing}. run pack-bucket-tars.py first.")
    for k in expected_tars:
        print(f"  {k}: {tar_listing[k] / 1e6:.1f} MB")

    def report(mode_label: str, results: list[tuple[str, float, int]], wall: float):
        total_bytes = sum(r[2] for r in results)
        worker_walls = [r[1] for r in results]
        inside_max = max(worker_walls)
        agg = total_bytes / wall / 1e6 if wall > 0 else 0
        per_rates = [r[2] / r[1] / 1e6 for r in results if r[1] > 0]
        spread = f"{min(per_rates):.2f}…{max(per_rates):.2f}" if len(per_rates) > 1 else f"{per_rates[0]:.2f}"
        print(
            f"{mode_label:22s}  wall={wall:>6.1f}s  inside={inside_max:>6.1f}s  "
            f"total={total_bytes / 1e6:>6.1f}MB  agg={agg:>5.2f}MB/s  per-worker {spread}MB/s"
        )

    # Warm one container with a tiny read — boots mount and Mountpoint metadata.
    print("warming…")
    _ = list(do_read.map([("mount-files", [file_keys[800]])]))
    print("warm.\n")

    # Mode B — single container, mount read of one 322 MB tar.
    t0 = time.monotonic()
    res = list(do_read.map([("mount-tar", [f"{TAR_PREFIX}all.tar"])]))
    report("B. mount 1x322MB tar", res, time.monotonic() - t0)

    # Mode C — single container, boto3 direct get_object of same tar.
    t0 = time.monotonic()
    res = list(do_read.map([("boto3-tar", [f"{TAR_PREFIX}all.tar"])]))
    report("C. boto3 1x322MB tar", res, time.monotonic() - t0)

    # Mode D — 4 containers in parallel, each reading its shard via mount.
    shard_jobs = [("mount-tar", [f"{TAR_PREFIX}shard-{i}.tar"]) for i in range(NUM_SHARDS)]
    t0 = time.monotonic()
    res = list(do_read.map(shard_jobs))
    report("D. mount 4x80MB shards", res, time.monotonic() - t0)

    # Mode A — baseline: single container reading 200 individual files via mount,
    # comparable byte count (~71 MB) to one shard tar (~80 MB), so the 1-GET vs
    # many-small-GETs comparison is apples-to-apples.
    t0 = time.monotonic()
    res = list(do_read.map([("mount-files", file_keys[:200])]))
    report("A. mount 200 files", res, time.monotonic() - t0)
