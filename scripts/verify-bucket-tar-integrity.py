"""Verify the bytes inside a bucket tarball match the sidecar manifest's sha256s.

The original ingest run uses `pack_tarball()` to read JPEGs from an SSD download
dir keyed by iiif_id. On a case-insensitive filesystem (e.g. macOS APFS without
the case-sensitive variant), two iiif_ids that differ only by letter case
collapse to one physical file at write time but are still added to the tar
under both arcnames. The manifest, recording sha256 of the in-memory HTTP
response body, would then be correct for one arcname and wrong for the other.

This script pulls a shard's tarball from the bucket, streams through every
member, hashes the bytes, and compares each member's hash to the manifest's
recorded `members[<iiif_id>].sha256`. It does NOT modify the bucket.

Usage:
    uv run --with boto3 python scripts/verify-bucket-tar-integrity.py --shard-id 0
"""
from __future__ import annotations
import argparse
import hashlib
import json
import sys
import tarfile
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--creds", type=Path, default=Path("/tmp/src-creds.json"))
    ap.add_argument("--shard-id", type=int, required=True)
    ap.add_argument("--show-mismatches", type=int, default=20,
                    help="Print up to N mismatches in detail (default 20)")
    args = ap.parse_args()

    import boto3
    from botocore.config import Config
    creds = json.loads(args.creds.read_text())
    s3 = boto3.client(
        "s3",
        endpoint_url=creds["endpoint"],
        aws_access_key_id=creds["accessKeyId"],
        aws_secret_access_key=creds["secretAccessKey"],
        region_name=creds["region"],
        config=Config(s3={"addressing_style": "virtual"}, retries={"max_attempts": 5}),
    )
    bucket = creds["bucketName"]
    tar_key = f"tarballs/shard-{args.shard_id:03d}.tar"
    manifest_key = f"tarballs/shard-{args.shard_id:03d}.manifest.json"

    print(f"shard {args.shard_id:03d}", flush=True)
    manifest = json.loads(s3.get_object(Bucket=bucket, Key=manifest_key)["Body"].read())
    print(f"  manifest:  members={len(manifest['members'])}  dead={len(manifest['dead'])}  "
          f"declared tar_bytes={manifest['tar_bytes']:,}  tar_sha256={manifest['tar_sha256']}", flush=True)

    head = s3.head_object(Bucket=bucket, Key=tar_key)
    print(f"  bucket:    size={head['ContentLength']:,}", flush=True)

    print(f"  streaming tar and hashing every member…", flush=True)
    body = s3.get_object(Bucket=bucket, Key=tar_key)["Body"]
    full_hasher = hashlib.sha256()
    raw_total = 0

    class TeeReader:
        """Hashes every byte read while passing them through to tarfile."""
        def __init__(self, src):
            self.src = src
        def read(self, n=-1):
            nonlocal raw_total
            buf = self.src.read(n) if n != -1 else self.src.read()
            full_hasher.update(buf)
            raw_total += len(buf)
            return buf

    tee = TeeReader(body)
    found: dict[str, str] = {}
    n_members = 0
    with tarfile.open(fileobj=tee, mode="r|") as tf:
        for member in tf:
            if not member.isfile():
                continue
            f = tf.extractfile(member)
            assert f is not None
            h = hashlib.sha256()
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                h.update(chunk)
            iid = member.name.removesuffix(".jpg")
            found[iid] = h.hexdigest()
            n_members += 1
            if n_members % 500 == 0:
                print(f"    [{n_members:>4}] hashed", flush=True)

    # Drain remaining bytes (tar trailer/padding) THROUGH the tee so the
    # whole-object sha covers every byte of the bucket object — tarfile's
    # streaming reader does not always read to EOF.
    while True:
        chunk = tee.read(1024 * 1024)
        if not chunk:
            break

    overall = full_hasher.hexdigest()
    print(f"  hashed {n_members} members; overall tar sha256 = {overall}")
    print(f"  manifest declared tar sha256                 = {manifest['tar_sha256']}")
    print(f"  whole-tar match: {'OK' if overall == manifest['tar_sha256'] else 'MISMATCH'}")

    # Per-member compare.
    mismatches: list[tuple[str, str, str]] = []
    missing_in_tar: list[str] = []
    extra_in_tar: list[str] = []
    declared = manifest["members"]
    for iid, meta in declared.items():
        if iid not in found:
            missing_in_tar.append(iid)
            continue
        if found[iid] != meta["sha256"]:
            mismatches.append((iid, meta["sha256"], found[iid]))
    for iid in found:
        if iid not in declared:
            extra_in_tar.append(iid)

    print(f"\n  per-member sha256 results:")
    print(f"    matches      : {n_members - len(mismatches) - len(extra_in_tar)} / {len(declared)}")
    print(f"    mismatches   : {len(mismatches)}")
    print(f"    in tar but not in manifest: {len(extra_in_tar)}")
    print(f"    in manifest but not in tar: {len(missing_in_tar)}")

    if mismatches:
        print(f"\n  first {min(args.show_mismatches, len(mismatches))} mismatches:")
        for iid, declared_sha, actual_sha in mismatches[: args.show_mismatches]:
            print(f"    {iid:>10}  declared={declared_sha[:16]}…  actual={actual_sha[:16]}…")
        # Group: how many mismatched iiif_ids share their actual hash with another iiif_id?
        # That fingerprints case-collision: the wrong member's bytes equal its case-twin's bytes.
        actual_to_iid: dict[str, list[str]] = {}
        for iid, _decl, act in mismatches:
            actual_to_iid.setdefault(act, []).append(iid)
        twin_matches = 0
        for actual_sha, iids in actual_to_iid.items():
            for wrong_iid in iids:
                # Look up which declared iiif_id has this sha256.
                for cand_iid, cand_meta in declared.items():
                    if cand_iid != wrong_iid and cand_meta["sha256"] == actual_sha:
                        if cand_iid.lower() == wrong_iid.lower():
                            twin_matches += 1
                            break
        print(f"\n  mismatches whose actual bytes equal their case-twin's declared bytes: {twin_matches}/{len(mismatches)}")

    return 0 if not mismatches and not missing_in_tar else 2


if __name__ == "__main__":
    sys.exit(main())
