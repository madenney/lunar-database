#!/usr/bin/env python3
"""Build the whole-database download archive from the replay archive on disk.

Every real .slp under --archive becomes one entry: its .slpz copy from --slpz when
there is one, otherwise the raw .slp (files slpz can't compress). Symlinks are
skipped, like the crawler. Entries are stored uncompressed (the .slpz files are
already compressed) under the archive's own paths: netplay/..., tournament/...

Writes OUT.part, renames it to OUT when complete, and writes OUT.json with
{snapshotAt, replayCount, slpzEntries, rawEntries, bytes}. snapshotAt is when the
file listing was taken; replays added after it are not in the archive.

  build_full_db.py --archive DIR --slpz DIR --out FILE
  build_full_db.py --verify FILE     check entry count and size against FILE.json
"""
import argparse, datetime, json, os, sys, zipfile


def real_replays(root):
    """Relative paths of every real .slp under root, sorted. Never follows symlinks."""
    found = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if not os.path.islink(os.path.join(dirpath, d)))
        for name in filenames:
            path = os.path.join(dirpath, name)
            if name.lower().endswith(".slp") and not os.path.islink(path) and os.path.isfile(path):
                found.append(os.path.relpath(path, root))
    found.sort()
    return found


def build(archive, slpz_root, out):
    snapshot = datetime.datetime.now(datetime.timezone.utc)
    replays = real_replays(archive)
    print(f"{len(replays):,} replays listed at {snapshot.isoformat()}", flush=True)

    part = out + ".part"
    counts = {"slpz": 0, "raw": 0}
    with zipfile.ZipFile(part, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
        for i, rel in enumerate(replays, 1):
            slpz = os.path.join(slpz_root, rel[:-4] + ".slpz")
            if os.path.isfile(slpz):
                zf.write(slpz, rel[:-4] + ".slpz")
                counts["slpz"] += 1
            else:
                src = os.path.join(archive, rel)
                if not os.path.isfile(src):  # removed since the listing
                    continue
                zf.write(src, rel)
                counts["raw"] += 1
            if i % 100_000 == 0:
                print(f"{i:,}/{len(replays):,} added, {os.path.getsize(part) / 1e12:.2f} TB", flush=True)

    with open(part, "rb+") as f:
        os.fsync(f.fileno())
    os.rename(part, out)
    info = {
        "snapshotAt": snapshot.isoformat(),
        "replayCount": counts["slpz"] + counts["raw"],
        "slpzEntries": counts["slpz"],
        "rawEntries": counts["raw"],
        "bytes": os.path.getsize(out),
    }
    with open(out + ".json", "w") as f:
        json.dump(info, f, indent=2)
    print(json.dumps(info), flush=True)


def verify(out):
    with open(out + ".json") as f:
        info = json.load(f)
    size = os.path.getsize(out)
    with zipfile.ZipFile(out) as zf:  # reads the central directory only
        entries = len(zf.infolist())
    problems = []
    if size != info["bytes"]:
        problems.append(f"size {size} != recorded {info['bytes']}")
    if entries != info["replayCount"]:
        problems.append(f"{entries} entries != recorded {info['replayCount']}")
    if problems:
        sys.exit("verify FAILED: " + "; ".join(problems))
    print(f"verify ok: {entries:,} entries, {size:,} bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive")
    ap.add_argument("--slpz")
    ap.add_argument("--out")
    ap.add_argument("--verify", metavar="FILE")
    a = ap.parse_args()
    if a.verify:
        verify(a.verify)
    elif a.archive and a.slpz and a.out:
        build(a.archive, a.slpz, a.out)
    else:
        ap.error("pass --archive, --slpz and --out, or --verify FILE")
