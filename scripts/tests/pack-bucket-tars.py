"""Download fanout2/ from a Tigris bucket, pack into tars, upload back under tars/.

Produces:
    tars/all.tar          — single ~322 MB shard (one big object)
    tars/shard-0.tar      — ~80 MB quarter
    tars/shard-1.tar      — ~80 MB quarter
    tars/shard-2.tar      — ~80 MB quarter
    tars/shard-3.tar      — ~80 MB quarter

All five uploaded to the same bucket under tars/. Existing tars at destination are
overwritten (not idempotency-checked — cheaper to just re-pack).

Usage:
    railway bucket credentials --bucket indexed-toolchest --json > /tmp/src-creds.json
    uv run --with boto3 python scripts/tests/pack-bucket-tars.py \\
        --creds /tmp/src-creds.json \\
        --src-prefix fanout2/ \\
        --dst-prefix tars/
"""

import argparse
import concurrent.futures as cf
import io
import json
import sys
import tarfile
import time
from pathlib import Path

import boto3
from botocore.config import Config


def make_client(creds: dict):
    return boto3.client(
        "s3",
        endpoint_url=creds["endpoint"],
        aws_access_key_id=creds["accessKeyId"],
        aws_secret_access_key=creds["secretAccessKey"],
        region_name=creds["region"],
        config=Config(s3={"addressing_style": "virtual"}, retries={"max_attempts": 5}),
    )


def list_prefix(s3, bucket: str, prefix: str) -> list[tuple[str, int]]:
    out = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            out.append((obj["Key"], obj["Size"]))
    return out


def fetch_bytes(s3, bucket: str, key: str) -> bytes:
    return s3.get_object(Bucket=bucket, Key=key)["Body"].read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--creds", required=True, type=Path)
    ap.add_argument("--src-prefix", required=True)
    ap.add_argument("--dst-prefix", default="tars/")
    ap.add_argument("--num-shards", type=int, default=4)
    ap.add_argument("--workers", type=int, default=16)
    args = ap.parse_args()

    creds = json.loads(args.creds.read_text())
    bucket = creds["bucketName"]
    s3 = make_client(creds)

    print(f"bucket: {bucket}")
    print(f"src:    {args.src_prefix}")
    print(f"dst:    {args.dst_prefix}")

    print("listing source…")
    keys = sorted(list_prefix(s3, bucket, args.src_prefix), key=lambda kv: kv[0])
    total = sum(sz for _, sz in keys)
    print(f"  {len(keys):,} keys, {total / 1e6:.1f} MB")

    # Download all in parallel into memory.
    print(f"downloading {len(keys)} files in parallel (workers={args.workers})…")
    t0 = time.monotonic()
    payloads: dict[str, bytes] = {}
    with cf.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(fetch_bytes, s3, bucket, k): k for k, _ in keys}
        for i, fut in enumerate(cf.as_completed(futs), 1):
            k = futs[fut]
            payloads[k] = fut.result()
            if i % 100 == 0 or i == len(futs):
                print(f"  [{i:>4}/{len(futs)}]  {sum(len(v) for v in payloads.values()) / 1e6:.1f} MB")
    download_mb_s = total / (time.monotonic() - t0) / 1e6
    print(f"  download done — {download_mb_s:.1f} MB/s")

    # Pack the "all" tar: every file in key order.
    print("packing tars/all.tar …")
    all_buf = io.BytesIO()
    with tarfile.open(fileobj=all_buf, mode="w") as tf:
        for k, _ in keys:
            data = payloads[k]
            # Store by basename (e.g. "fanout2/AAjhO.jpg" -> "AAjhO.jpg") so tar
            # contents are clean if anyone extracts later.
            name = k.rsplit("/", 1)[-1]
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    all_bytes = all_buf.getvalue()
    print(f"  all.tar: {len(all_bytes) / 1e6:.1f} MB")

    # Pack N shard tars: split keys into N contiguous groups.
    n = args.num_shards
    shard_size = (len(keys) + n - 1) // n
    shard_tars: list[tuple[str, bytes]] = []
    for i in range(n):
        shard_keys = keys[i * shard_size : (i + 1) * shard_size]
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tf:
            for k, _ in shard_keys:
                data = payloads[k]
                name = k.rsplit("/", 1)[-1]
                info = tarfile.TarInfo(name=name)
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
        shard_tars.append((f"shard-{i}.tar", buf.getvalue()))
        print(f"  shard-{i}.tar: {len(shard_tars[-1][1]) / 1e6:.1f} MB ({len(shard_keys)} files)")

    # Upload all tars in parallel.
    uploads = [("all.tar", all_bytes)] + shard_tars
    print(f"uploading {len(uploads)} tars to {args.dst_prefix} …")
    t0 = time.monotonic()

    def put(name_body):
        name, body = name_body
        dst_key = args.dst_prefix + name
        s3.put_object(Bucket=bucket, Key=dst_key, Body=body, ContentType="application/x-tar")
        return dst_key, len(body)

    up_total = 0
    with cf.ThreadPoolExecutor(max_workers=min(len(uploads), args.workers)) as pool:
        for key, size in pool.map(put, uploads):
            up_total += size
            print(f"  uploaded {key} ({size / 1e6:.1f} MB)")
    up_mb_s = up_total / (time.monotonic() - t0) / 1e6
    print(f"  upload done — {up_mb_s:.1f} MB/s")


if __name__ == "__main__":
    sys.exit(main())
