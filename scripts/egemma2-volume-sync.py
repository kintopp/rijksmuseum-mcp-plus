#!/usr/bin/env python3
"""
Resumable upload of a staged JPEG folder to the egemma2-pool Modal Volume: uploads only
files not already on the Volume, in small batches, so a dropped connection costs one batch.
Touches <stage>/.uploaded when the Volume holds every file.

    python scripts/egemma2-volume-sync.py data/egemma2-test/compare/pool-vectors-n20000-s11-t560.jpegs
"""

import sys
import time
from pathlib import Path

import modal

VOLUME = "egemma2-pool"
BATCH = 500
ATTEMPTS = 8


def remote_names(vol: modal.Volume, remote_dir: str) -> set[str]:
    try:
        return {Path(e.path).name for e in vol.listdir(remote_dir)}
    except Exception:  # directory not created yet
        return set()


def main(stage: Path) -> None:
    vol = modal.Volume.from_name(VOLUME, create_if_missing=True)
    remote_dir = f"/{stage.name}"
    local = sorted(p for p in stage.glob("*.jpg"))
    for attempt in range(1, ATTEMPTS + 1):
        have = remote_names(vol, remote_dir)
        todo = [p for p in local if p.name not in have]
        print(f"attempt {attempt}: {len(have)}/{len(local)} on Volume, {len(todo)} to upload", flush=True)
        if not todo:
            (stage / ".uploaded").touch()
            print("UPLOADED")
            return
        try:
            for i in range(0, len(todo), BATCH):
                with vol.batch_upload(force=True) as up:
                    for p in todo[i:i + BATCH]:
                        up.put_file(p, f"{remote_dir}/{p.name}")
                print(f"  batch {i // BATCH + 1}/{-(-len(todo) // BATCH)} done", flush=True)
        except Exception as e:
            print(f"  failed: {type(e).__name__}: {e}; retrying in {30 * attempt}s", flush=True)
            time.sleep(30 * attempt)
    sys.exit("Volume still incomplete after all attempts")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
