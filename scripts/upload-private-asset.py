#!/usr/bin/env python3
"""
Upload a file to the private Railway bucket and write a presigned GET URL (max 7 days)
to --url-out, so the link never lands in terminal output or shell history.

Credentials: `railway bucket credentials --bucket <name> --json > creds.json` (keep it 0600).

Usage:
  ~/miniconda3/envs/embeddings/bin/python scripts/upload-private-asset.py \
    --creds creds.json --file data/gemma.db.gz --key gemma/v2/gemma.db.gz --url-out url.txt
"""

import argparse
import json
import os

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config

ap = argparse.ArgumentParser()
ap.add_argument("--creds", required=True)
ap.add_argument("--file", required=True)
ap.add_argument("--key", required=True)
ap.add_argument("--url-out", required=True)
ap.add_argument("--concurrency", type=int, default=2, help="parallel parts; high values saturate a home uplink and break DNS")
ap.add_argument("--expires", type=int, default=7 * 24 * 3600)
args = ap.parse_args()

c = json.load(open(args.creds))
s3 = boto3.client(
    "s3", endpoint_url=c["endpoint"], region_name=c.get("region") or "auto",
    aws_access_key_id=c["accessKeyId"], aws_secret_access_key=c["secretAccessKey"],
    config=Config(s3={"addressing_style": "virtual"}, retries={"max_attempts": 10, "mode": "standard"}),
)
s3.upload_file(args.file, c["bucketName"], args.key, Config=TransferConfig(max_concurrency=args.concurrency))
head = s3.head_object(Bucket=c["bucketName"], Key=args.key)
assert head["ContentLength"] == os.path.getsize(args.file), "size mismatch after upload"
url = s3.generate_presigned_url("get_object", Params={"Bucket": c["bucketName"], "Key": args.key}, ExpiresIn=args.expires)
fd = os.open(args.url_out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write(url)
print(f"uploaded s3://{c['bucketName']}/{args.key} ({head['ContentLength']:,} bytes); URL → {args.url_out}")
