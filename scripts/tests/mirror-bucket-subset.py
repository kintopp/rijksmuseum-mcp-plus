"""Mirror a prefix from one Railway/Tigris bucket to another via laptop pass-through.

Idempotent: skips keys that already exist at the destination with matching size.

Usage:
    # Fetch credentials for both buckets first:
    #   railway bucket credentials --bucket indexed-toolchest --json > /tmp/src-creds.json
    #   railway bucket credentials --bucket roomy-drum        --json > /tmp/dst-creds.json
    # Then run:
    uv run --with boto3 python scripts/tests/mirror-bucket-subset.py \\
        --src-creds /tmp/src-creds.json \\
        --dst-creds /tmp/dst-creds.json \\
        --prefix fanout2/

Egress bucket→laptop and ingress laptop→bucket are both free on Tigris.
"""

import argparse
import concurrent.futures as cf
import json
import sys
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
    keys = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            keys.append((obj["Key"], obj["Size"]))
    return keys


def head_size(s3, bucket: str, key: str) -> int | None:
    try:
        r = s3.head_object(Bucket=bucket, Key=key)
        return r["ContentLength"]
    except s3.exceptions.ClientError as e:
        if e.response["Error"]["Code"] in {"404", "NoSuchKey", "NotFound"}:
            return None
        raise


def copy_one(src_s3, dst_s3, src_bucket, dst_bucket, key, src_size, dst_existing_sizes):
    if dst_existing_sizes.get(key) == src_size:
        return ("skip", key, 0)
    body = src_s3.get_object(Bucket=src_bucket, Key=key)["Body"].read()
    dst_s3.put_object(Bucket=dst_bucket, Key=key, Body=body)
    return ("copy", key, len(body))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src-creds", required=True, type=Path)
    ap.add_argument("--dst-creds", required=True, type=Path)
    ap.add_argument("--prefix", required=True)
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--limit", type=int, default=0, help="Max keys to copy (0 = all)")
    args = ap.parse_args()

    src_creds = json.loads(args.src_creds.read_text())
    dst_creds = json.loads(args.dst_creds.read_text())
    src_bucket = src_creds["bucketName"]
    dst_bucket = dst_creds["bucketName"]

    src_s3 = make_client(src_creds)
    dst_s3 = make_client(dst_creds)

    print(f"src: {src_bucket}  ({src_creds['endpoint']})")
    print(f"dst: {dst_bucket}  ({dst_creds['endpoint']})")
    print(f"prefix: {args.prefix}")

    print("listing source…")
    src_keys = list_prefix(src_s3, src_bucket, args.prefix)
    src_keys.sort(key=lambda kv: kv[0])
    if args.limit:
        src_keys = src_keys[: args.limit]
    src_total = sum(sz for _, sz in src_keys)
    print(f"  {len(src_keys):,} keys, {src_total/1e6:.1f} MB total")

    print("listing destination (for skip check)…")
    dst_keys = list_prefix(dst_s3, dst_bucket, args.prefix)
    dst_existing = {k: sz for k, sz in dst_keys}
    print(f"  {len(dst_keys):,} existing keys at destination")

    needed = [(k, sz) for k, sz in src_keys if dst_existing.get(k) != sz]
    print(f"  {len(needed):,} keys to copy, {sum(sz for _, sz in needed)/1e6:.1f} MB")

    if not needed:
        print("nothing to do.")
        return

    t0 = time.monotonic()
    copied = skipped = 0
    bytes_copied = 0
    with cf.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = [
            pool.submit(copy_one, src_s3, dst_s3, src_bucket, dst_bucket, k, sz, dst_existing)
            for k, sz in needed
        ]
        for i, fut in enumerate(cf.as_completed(futs), 1):
            action, key, nbytes = fut.result()
            if action == "copy":
                copied += 1
                bytes_copied += nbytes
            else:
                skipped += 1
            if i % 50 == 0 or i == len(futs):
                elapsed = time.monotonic() - t0
                rate = bytes_copied / elapsed / 1e6 if elapsed > 0 else 0
                print(f"  [{i:>4}/{len(futs)}]  copied={copied}  skipped={skipped}  {bytes_copied/1e6:.1f} MB  {rate:.1f} MB/s")

    elapsed = time.monotonic() - t0
    print(f"done in {elapsed:.1f}s — copied {copied}, skipped {skipped}, {bytes_copied/1e6:.1f} MB")


if __name__ == "__main__":
    sys.exit(main())
