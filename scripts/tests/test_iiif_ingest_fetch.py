"""Unit tests for shard selection and IIIF fetch logic.

Run with: python3 scripts/tests/test_iiif_ingest_fetch.py
"""
from __future__ import annotations
import importlib.util
import sqlite3
import sys
import tempfile
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))  # so `import _iiif_ingest_state` works inside the main module

# Load scripts/ingest-iiif-tarballs.py under a stable module name; the hyphen in
# the filename blocks plain `import`.
_spec = importlib.util.spec_from_file_location(
    "ingest_iiif_tarballs", SCRIPTS_DIR / "ingest-iiif-tarballs.py"
)
assert _spec and _spec.loader
ingest = importlib.util.module_from_spec(_spec)
sys.modules["ingest_iiif_tarballs"] = ingest
_spec.loader.exec_module(ingest)


def _seed_test_db(db_path: Path):
    con = sqlite3.connect(str(db_path))
    con.executescript(
        """
        CREATE TABLE artworks (
          art_id INTEGER PRIMARY KEY,
          object_number TEXT,
          has_image INTEGER,
          iiif_id TEXT
        );
        INSERT INTO artworks (art_id, object_number, has_image, iiif_id) VALUES
          (0,  'SK-A-0',  1, 'AAA00'),
          (1,  'SK-A-1',  1, 'BBB01'),
          (2,  'SK-A-2',  0, NULL),
          (3,  'SK-A-3',  1, NULL),
          (10, 'SK-A-10', 1, 'CCC10'),
          (11, 'SK-A-11', 1, 'DDD11'),
          (20, 'SK-A-20', 1, 'EEE20');
        """
    )
    con.commit()
    con.close()


def test_pick_artworks_for_shard_mod_arithmetic():
    with tempfile.TemporaryDirectory() as td:
        db = Path(td) / "vocabulary.db"
        _seed_test_db(db)

        # total_shards=10, shard_id=0 → art_id % 10 == 0 → art_ids 0, 10, 20
        # of these, has_image=1 AND iiif_id IS NOT NULL: all three.
        got = ingest.pick_artworks_for_shard(db, shard_id=0, total_shards=10)
        assert set(got.keys()) == {"AAA00", "CCC10", "EEE20"}
        assert got["AAA00"]["art_id"] == 0
        assert got["AAA00"]["object_number"] == "SK-A-0"

        # shard_id=1 → art_ids 1, 11 (skip art_id=3: no iiif_id).
        got = ingest.pick_artworks_for_shard(db, shard_id=1, total_shards=10)
        assert set(got.keys()) == {"BBB01", "DDD11"}


def test_pick_artworks_empty_shard_returns_empty_dict():
    with tempfile.TemporaryDirectory() as td:
        db = Path(td) / "vocabulary.db"
        _seed_test_db(db)
        got = ingest.pick_artworks_for_shard(db, shard_id=7, total_shards=10)
        assert got == {}


from unittest.mock import MagicMock


def test_iiif_url_format():
    assert ingest.iiif_url("KMFvF", "1568,") == "https://iiif.micr.io/KMFvF/full/1568,/0/default.jpg"
    assert ingest.iiif_url("KMFvF", "max") == "https://iiif.micr.io/KMFvF/full/max/0/default.jpg"


def _resp(status: int, body: bytes = b""):
    r = MagicMock()
    r.status_code = status
    r.content = body if status == 200 else b""
    return r


def test_fetch_one_success_at_1568():
    session = MagicMock()
    session.get.return_value = _resp(200, b"image-bytes-here")

    result = ingest.fetch_one(session, "KMFvF", sizes=["1568,", "max"], max_attempts_per_size=3, backoff_base=0)

    assert result.ok is True
    assert result.size_used == "1568,"
    assert result.body == b"image-bytes-here"
    assert result.last_status == 200
    assert session.get.call_count == 1


def test_fetch_one_fallback_to_max_on_400():
    session = MagicMock()
    session.get.side_effect = [_resp(400), _resp(200, b"smaller")]

    result = ingest.fetch_one(session, "K", sizes=["1568,", "max"], max_attempts_per_size=3, backoff_base=0)

    assert result.ok is True
    assert result.size_used == "max"
    assert result.body == b"smaller"
    assert session.get.call_count == 2


def test_fetch_one_retries_on_5xx_then_succeeds():
    session = MagicMock()
    session.get.side_effect = [_resp(503), _resp(503), _resp(200, b"ok")]

    result = ingest.fetch_one(session, "K", sizes=["1568,"], max_attempts_per_size=3, backoff_base=0)

    assert result.ok is True
    assert session.get.call_count == 3


def test_fetch_one_gives_up_after_exhausting_ladder():
    session = MagicMock()
    session.get.side_effect = [_resp(503), _resp(503), _resp(503), _resp(503), _resp(503), _resp(503)]

    result = ingest.fetch_one(session, "K", sizes=["1568,", "max"], max_attempts_per_size=3, backoff_base=0)

    assert result.ok is False
    assert result.last_status == 503
    assert session.get.call_count == 6


def test_fetch_one_404_is_permanent_across_ladder():
    session = MagicMock()
    session.get.side_effect = [_resp(404), _resp(404)]

    result = ingest.fetch_one(session, "K", sizes=["1568,", "max"], max_attempts_per_size=3, backoff_base=0)

    assert result.ok is False
    assert result.last_status == 404
    assert session.get.call_count == 2  # one try per size, no retries


import hashlib
import io
import tarfile


def test_pack_tarball_from_disk_files():
    with tempfile.TemporaryDirectory() as td:
        dl_dir = Path(td)
        payloads = {"A": b"a" * 100, "B": b"b" * 200, "C": b"c" * 50}
        for iid, body in payloads.items():
            (dl_dir / f"{iid}.jpg").write_bytes(body)

        tar_bytes, sha = ingest.pack_tarball(dl_dir, list(payloads.keys()))

        assert hashlib.sha256(tar_bytes).hexdigest() == sha
        with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as tf:
            members = tf.getmembers()
            assert {m.name for m in members} == {"A.jpg", "B.jpg", "C.jpg"}
            for m in members:
                iid = m.name.removesuffix(".jpg")
                extracted = tf.extractfile(m).read()
                assert extracted == payloads[iid]


def test_build_manifest_reflects_state_and_tar():
    from _iiif_ingest_state import ShardState
    s = ShardState(shard_id=7, total_shards=200, iiif_size="1568,")
    s.expected["A"] = {"art_id": 1, "object_number": "SK-A-1"}
    s.expected["B"] = {"art_id": 2, "object_number": "SK-A-2"}
    s.downloaded["A"] = {"bytes": 100, "sha256": "aaa", "size_used": "1568,", "saved_at": "t"}
    s.failed_dead["B"] = {"reason": "HTTP 404 at both sizes", "last_status": 404}

    manifest = ingest.build_manifest(s, tar_bytes_len=12345, tar_sha256="abc")

    assert manifest["shard_id"] == 7
    assert manifest["total_shards"] == 200
    assert manifest["iiif_size"] == "1568,"
    assert manifest["expected_count"] == 2
    assert manifest["downloaded_count"] == 1
    assert manifest["dead_count"] == 1
    assert manifest["tar_bytes"] == 12345
    assert manifest["tar_sha256"] == "abc"
    assert set(manifest["members"].keys()) == {"A"}
    assert manifest["members"]["A"]["bytes"] == 100
    assert set(manifest["dead"].keys()) == {"B"}


def test_is_case_sensitive_dir_detects_macos_default():
    """`/private/tmp` on stock macOS APFS Data is case-insensitive — verify probe agrees."""
    with tempfile.TemporaryDirectory(dir="/tmp") as td:
        # We don't assert a specific value (depends on the FS the test runs on),
        # we assert determinism: probe leaves no junk files behind.
        result = ingest._is_case_sensitive_dir(Path(td))
        assert isinstance(result, bool)
        assert not list(Path(td).iterdir()), "case-sensitivity probe left files behind"


def test_check_case_collisions_flags_collision_on_case_insensitive_fs():
    """Repro of the v0.24 ingest bug: two iiif_ids case-folding equal must error fast."""
    with tempfile.TemporaryDirectory(dir="/tmp") as td:
        if ingest._is_case_sensitive_dir(Path(td)):
            print("(skipped: /tmp is case-sensitive on this machine)")
            return
        s = ingest.ShardState(shard_id=0, total_shards=200, iiif_size="1568,")
        s.expected = {"jWNRD": {"art_id": 1, "object_number": "X"},
                      "JWNrd": {"art_id": 2, "object_number": "Y"}}
        try:
            ingest._check_case_collisions(s, Path(td))
        except SystemExit as e:
            assert "case-collision" in str(e)
            assert "case-insensitive" in str(e)
            return
        raise AssertionError("expected SystemExit was not raised")


def test_check_case_collisions_passes_when_no_collisions():
    """No case-folded duplicates → no error regardless of FS."""
    with tempfile.TemporaryDirectory(dir="/tmp") as td:
        s = ingest.ShardState(shard_id=0, total_shards=200, iiif_size="1568,")
        s.expected = {"AAA00": {"art_id": 1, "object_number": "X"},
                      "BBB01": {"art_id": 2, "object_number": "Y"}}
        ingest._check_case_collisions(s, Path(td))  # must not raise


if __name__ == "__main__":
    test_pick_artworks_for_shard_mod_arithmetic()
    test_pick_artworks_empty_shard_returns_empty_dict()
    test_iiif_url_format()
    test_fetch_one_success_at_1568()
    test_fetch_one_fallback_to_max_on_400()
    test_fetch_one_retries_on_5xx_then_succeeds()
    test_fetch_one_gives_up_after_exhausting_ladder()
    test_fetch_one_404_is_permanent_across_ladder()
    test_pack_tarball_from_disk_files()
    test_build_manifest_reflects_state_and_tar()
    test_is_case_sensitive_dir_detects_macos_default()
    test_check_case_collisions_flags_collision_on_case_insensitive_fs()
    test_check_case_collisions_passes_when_no_collisions()
    print("ok")
