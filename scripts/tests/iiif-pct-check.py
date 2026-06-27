#!/usr/bin/env python3
"""Check whether the Micrio IIIF server (iiif.micr.io) honours pct: region requests.

Adapted from globalise-mcp's iiif_pct_check.py. The Micrio server advertises IIIF
Image API 3.0 Level 2, and inspect_artwork_image relies on pct: region cropping
working correctly (see src/registration/tools/viewer.ts — the "3px fudge" for
pct-region server rounding). This is the re-runnable artifact that PROVES that
reliance holds: it decodes the actual JPEG dimensions of each crop, so it can tell
"region honoured" from "silently ignored (server returned the full image)" from
"400" — a distinction byte-size alone cannot make.

Strategy:
  1. Resolve a real IIIF id (default: the Night Watch, SK-C-5 -> PJEZO) either via
     --id, or from the local vocab DB by objectNumber (artworks.object_number ->
     artworks.iiif_id).
  2. Fetch info.json: report width/height, @context, profile, and whether
     regionByPct is advertised (v3 extraFeatures, with a v2 profile[].supports
     fallback).
  3. Build region/size variants matching THIS project's URL contract
     (/{region}/{size}/{rotation}/{quality}.jpg, width-only {w}, size as used by
     RijksmuseumApiClient.fetchRegionBase64). For each, report HTTP status,
     content-type, byte size, and the ACTUAL decoded JPEG dimensions, then classify:
       OK              decoded crop matches the expected region dimensions
       SILENTLY-IGNORED  decoded dims match the full image (region was dropped)
       MISMATCH        decoded but neither expected nor full — investigate
       HTTP <code>     non-200
  4. Print a final PASS/FAIL verdict on "pct: region cropping honoured".

Usage:
    python3 scripts/tests/iiif-pct-check.py                 # Night Watch via local DB
    python3 scripts/tests/iiif-pct-check.py --object SK-A-1718
    python3 scripts/tests/iiif-pct-check.py --id PJEZO      # skip the DB entirely
    python3 scripts/tests/iiif-pct-check.py --db /path/to/vocabulary.db

Stdlib only — no pip dependencies, so it runs anywhere Python 3 does.
"""
import argparse
import json
import sqlite3
import struct
import sys
import urllib.error
import urllib.request
from pathlib import Path

IIIF_BASE = "https://iiif.micr.io"
DEFAULT_OBJECT = "SK-C-5"          # The Night Watch
DEFAULT_ID = "PJEZO"              # SK-C-5's IIIF id — fallback when no DB is present
DEFAULT_DB = Path("data/vocabulary.db")
UA = {"User-Agent": "rijksmuseum-mcp-plus-iiif-pct-check/1.0 (arno.bosse@gmail.com)"}

# Region we probe: a 10%-of-image crop offset 25% in from the top-left.
PCT = (25.0, 25.0, 10.0, 10.0)
TEST_W = 400  # width for the width-only {w}, size tests


def get(url, timeout=30, accept=None):
    headers = dict(UA)
    if accept:
        headers["Accept"] = accept
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, dict(r.headers), r.read()


def jpeg_dims(data):
    """Return (w, h) from a JPEG by scanning SOFn markers. None on failure."""
    if data[:2] != b"\xff\xd8":
        return None
    i = 2
    n = len(data)
    while i + 9 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        # SOF0..SOF15 except DHT(C4) DAC(C8) RSTn etc.
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                      0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        seg_len = struct.unpack(">H", data[i + 2:i + 4])[0]
        i += 2 + seg_len
    return None


def resolve_iiif_id(args):
    """Return (iiif_id, source_description). Honours --id, else the local DB."""
    if args.id:
        return args.id, f"--id {args.id}"
    db = Path(args.db)
    if db.exists():
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            row = con.execute(
                "SELECT iiif_id FROM artworks WHERE object_number = ?",
                (args.object,),
            ).fetchone()
            con.close()
            if row and row[0]:
                return row[0], f"{args.object} via {db}"
            print(f"WARNING: {args.object} not found (or no iiif_id) in {db}")
        except sqlite3.Error as e:
            print(f"WARNING: DB lookup failed ({e})")
    else:
        print(f"WARNING: vocab DB not found at {db}")
    if args.object == DEFAULT_OBJECT:
        print(f"Falling back to hardcoded default id {DEFAULT_ID} ({DEFAULT_OBJECT})")
        return DEFAULT_ID, f"hardcoded fallback ({DEFAULT_OBJECT})"
    print("ERROR: could not resolve an IIIF id. Pass --id or a valid --db/--object.")
    sys.exit(1)


def approx(a, b, tol):
    return a is not None and b is not None and abs(a - b) <= tol


def classify(decoded, expected, full_equiv):
    """OK / SILENTLY-IGNORED / MISMATCH / decode-failed, comparing decoded dims."""
    if decoded is None:
        return "decode-failed (not a JPEG?)"
    ew, eh = expected
    fw, fh = full_equiv
    # Generous per-axis tolerance: covers the documented pct-rounding (~3px) and
    # the server's own floor/round of derived crop pixels.
    tol_w = max(4, round(0.02 * ew))
    tol_h = max(4, round(0.02 * eh))
    dw, dh = decoded
    if approx(dw, ew, tol_w) and approx(dh, eh, tol_h):
        return "OK"
    if approx(dw, fw, max(4, round(0.02 * fw))) and approx(dh, fh, max(4, round(0.02 * fh))):
        return "SILENTLY-IGNORED (returned full image)"
    return f"MISMATCH (expected ~{ew}x{eh}, full would be ~{fw}x{fh})"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--object", default=DEFAULT_OBJECT,
                    help=f"objectNumber to resolve via the local DB (default {DEFAULT_OBJECT})")
    ap.add_argument("--id", default=None, help="IIIF id to probe directly (skips the DB)")
    ap.add_argument("--db", default=str(DEFAULT_DB), help=f"vocab DB path (default {DEFAULT_DB})")
    ap.add_argument("--width", type=int, default=TEST_W,
                    help=f"width for the width-only size tests (default {TEST_W})")
    ap.add_argument("--timeout", type=int, default=60, help="per-request timeout seconds")
    args = ap.parse_args()

    iiif_id, source = resolve_iiif_id(args)
    base = f"{IIIF_BASE}/{iiif_id}"
    print("=== IIIF pct: region check ===")
    print(f"server : {IIIF_BASE}")
    print(f"id     : {iiif_id}  ({source})")

    print("\n=== 1. info.json ===")
    info_url = f"{base}/info.json"
    print(info_url)
    try:
        status, hdr, body = get(info_url, timeout=args.timeout, accept="application/json")
    except urllib.error.URLError as e:
        print("FAILED:", e)
        sys.exit(1)
    info = json.loads(body)
    W, H = info.get("width"), info.get("height")
    print(f"status={status} content-type={hdr.get('Content-Type')}")
    print(f"width={W} height={H}")
    print("@context:", info.get("@context"))
    prof = info.get("profile")
    print("profile:", json.dumps(prof) if not isinstance(prof, str) else prof)
    # IIIF v3 puts feature support under extraFeatures; v2 under profile[1].supports.
    advertised = False
    extra = info.get("extraFeatures")
    if extra:
        print("extraFeatures:", extra)
        advertised = "regionByPct" in extra
    if isinstance(prof, list):
        for p in prof:
            if isinstance(p, dict) and "supports" in p:
                print("  supports:", p["supports"])
                advertised = advertised or ("regionByPct" in p["supports"])
    print(f"regionByPct advertised: {advertised}")

    if not W or not H:
        print("ERROR: info.json missing width/height — cannot build region tests.")
        sys.exit(1)

    # Pixel coordinates for PCT (25,25,10,10) and the crop's native dimensions.
    pox, poy, pcw, pch = PCT
    px, py = int(W * pox / 100), int(H * poy / 100)
    pw, ph = int(W * pcw / 100), int(H * pch / 100)
    w = args.width
    # Expected proportional height when scaling the crop to width w.
    crop_h_at_w = round(ph * w / pw) if pw else 0
    full_h_at_w = round(H * w / W) if W else 0

    print(f"\nProbe region: pixels {px},{py},{pw},{ph}  ==  pct:25,25,10,10")
    print(f"Expected native crop ~ {pw} x {ph};  scaled to width {w} ~ {w} x {crop_h_at_w}")

    # Each test: (label, url, expected_dims, full_equiv_dims, kind).
    #   kind "info" -> reported only (e.g. full/max: the server may cap /max/ via an
    #                  unadvertised maxArea/maxWidth, which is IIIF-legal — measure it)
    #   kind "self" -> instrument self-test (validates the decoder + scaling math)
    #   kind "pct"  -> counted toward the pct: verdict
    # full_equiv = what you'd get if the region were dropped but the size applied
    # to the FULL image — the signature of a silently-ignored region.
    tests = [
        ("control: full / max (server max-size cap)",
         f"{base}/full/max/0/default.jpg", (W, H), (W, H), "info"),
        (f"self-test: full / {w},",
         f"{base}/full/{w},/0/default.jpg", (w, full_h_at_w), (w, full_h_at_w), "self"),
        ("pixel region / max",
         f"{base}/{px},{py},{pw},{ph}/max/0/default.jpg", (pw, ph), (W, H), "self"),
        (f"pixel region / {w},",
         f"{base}/{px},{py},{pw},{ph}/{w},/0/default.jpg", (w, crop_h_at_w), (w, full_h_at_w), "self"),
        ("PCT region / max",
         f"{base}/pct:25,25,10,10/max/0/default.jpg", (pw, ph), (W, H), "pct"),
        (f"PCT region / {w},  (what inspect_artwork_image uses)",
         f"{base}/pct:25,25,10,10/{w},/0/default.jpg", (w, crop_h_at_w), (w, full_h_at_w), "pct"),
        ("PCT region / pct:50",
         f"{base}/pct:25,25,10,10/pct:50/0/default.jpg",
         (round(pw * 0.5), round(ph * 0.5)), (round(W * 0.5), round(H * 0.5)), "pct"),
    ]

    print("\n=== 2. Region requests ===")
    pct_results = []
    for label, url, expected, full_equiv, kind in tests:
        print(f"\n[{label}]")
        print(f"  {url}")
        try:
            st, h, b = get(url, timeout=args.timeout, accept="image/jpeg,image/*")
            dims = jpeg_dims(b)
            print(f"  status={st}  type={h.get('Content-Type')}  bytes={len(b)}")
            if kind == "info":
                # /max is server-discretionary; report the cap rather than pass/fail.
                if dims:
                    pct_native = round(100 * dims[0] / W, 1) if W else "?"
                    note = ("== native" if approx(dims[0], W, 4)
                            else f"capped to {dims[0]}x{dims[1]} = {pct_native}% of native width")
                    print(f"  decoded={dims}  native={W}x{H}  =>  {note}")
                else:
                    print(f"  decoded={dims}  native={W}x{H}  =>  decode-failed (not a JPEG?)")
                verdict = "info"
            else:
                verdict = classify(dims, expected, full_equiv)
                print(f"  decoded={dims}  expected~{expected}  =>  {verdict}")
        except urllib.error.HTTPError as e:
            verdict = f"HTTP {e.code}"
            print(f"  HTTP {e.code} {e.reason}")
        except Exception as e:  # noqa: BLE001 — surface anything as a test signal
            verdict = f"ERROR {type(e).__name__}"
            print(f"  ERROR {type(e).__name__}: {e}")
        if kind == "pct":
            pct_results.append((label, verdict))

    print("\n=== 3. Verdict: pct: region cropping ===")
    ok = [r for r in pct_results if r[1] == "OK"]
    bad = [r for r in pct_results if r[1] != "OK"]
    for label, verdict in pct_results:
        flag = "✓" if verdict == "OK" else "✗"
        print(f"  {flag} {label}: {verdict}")
    if bad:
        print(f"\nFAIL: {len(bad)}/{len(pct_results)} pct: variants did not honour the region.")
        if not advertised:
            print("(regionByPct was NOT advertised in info.json — consistent with the failures.)")
        sys.exit(1)
    print(f"\nPASS: all {len(ok)} pct: variants cropped correctly — "
          "inspect_artwork_image's reliance on pct: regions holds.")


if __name__ == "__main__":
    main()
