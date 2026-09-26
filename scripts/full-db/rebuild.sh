#!/usr/bin/env bash
# Rebuild the whole-database download: build → verify → upload → register.
# Runs on the worker, where the archive is local disk. Run it detached:
#
#   nohup scripts/full-db/rebuild.sh > /dev/null 2>&1 &
#   tail -f "$FULL_DB_WORK/rebuild.log"
#
# Steps are resumable: an unpublished build (lunar_db_full.zip + .json) is reused, so
# a failed upload can be retried by running the script again. Once registered, the
# next run builds a new snapshot; --fresh forces one. The live download keeps
# serving the old archive until the upload completes, and the site keeps the old
# size/date until the new one is registered.
#
# Env (defaults are the worker's layout):
#   SLP_ROOT_DIR, SLPZ_ARCHIVE_DIR   replay archive and its .slpz mirror (from .env)
#   FULL_DB_WORK                     build directory, on a different disk from the archive
#   RCLONE, RCLONE_DEST              rclone binary and destination directory
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$APP_DIR"
if [ -f .env ]; then
  SLP_ROOT_DIR="${SLP_ROOT_DIR:-$(grep -E '^SLP_ROOT_DIR=' .env | cut -d= -f2-)}"
  SLPZ_ARCHIVE_DIR="${SLPZ_ARCHIVE_DIR:-$(grep -E '^SLPZ_ARCHIVE_DIR=' .env | cut -d= -f2-)}"
fi
: "${SLP_ROOT_DIR:?SLP_ROOT_DIR not set}"
: "${SLPZ_ARCHIVE_DIR:?SLPZ_ARCHIVE_DIR not set}"
WORK="${FULL_DB_WORK:-$HOME/Projects/worker/shared_folder_2/full_db}"
RCLONE="${RCLONE:-$HOME/Projects/worker/shared_folder/_bulk/rclone}"
RCLONE_DEST="${RCLONE_DEST:-b2s3:lm-replays/archive/}"
ZIP="$WORK/lunar_db_full.zip"
LOG="$WORK/rebuild.log"

mkdir -p "$WORK"
exec 9>"$WORK/.lock"
flock -n 9 || { echo "another rebuild is running" >&2; exit 1; }
log() { echo "=== $(date '+%F %T') $* ===" | tee -a "$LOG"; }
trap 'log "FAILED at line $LINENO (rerun to resume)"' ERR

# A registered build has been published; the next run starts a new snapshot.
if [ "${1:-}" = "--fresh" ] || [ -f "$ZIP.registered" ]; then
  rm -f "$ZIP" "$ZIP.json" "$ZIP.part" "$ZIP.registered"
fi

if [ -f "$ZIP" ] && [ -f "$ZIP.json" ]; then
  log "reusing existing build $(cat "$ZIP.json" | tr -d '\n ')"
else
  rm -f "$ZIP.part"
  log "build start: $SLP_ROOT_DIR (+ $SLPZ_ARCHIVE_DIR) -> $ZIP"
  nice -n 10 ionice -c2 -n7 python3 scripts/full-db/build_full_db.py \
    --archive "$SLP_ROOT_DIR" --slpz "$SLPZ_ARCHIVE_DIR" --out "$ZIP" >> "$LOG" 2>&1
  log "build done"
fi

python3 scripts/full-db/build_full_db.py --verify "$ZIP" >> "$LOG" 2>&1
BYTES=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bytes"])' "$ZIP.json")
REPLAYS=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["replayCount"])' "$ZIP.json")
SNAPSHOT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["snapshotAt"])' "$ZIP.json")

log "upload start: $(numfmt --to=iec "$BYTES") to $RCLONE_DEST"
"$RCLONE" copyto "$ZIP" "${RCLONE_DEST%/}/lunar_db_full.zip" \
  --s3-no-check-bucket --s3-disable-checksum \
  --s3-chunk-size 256M --s3-upload-concurrency 8 \
  --stats 2m --stats-one-line --log-file "$LOG" --log-level INFO
REMOTE=$("$RCLONE" lsjson "${RCLONE_DEST%/}/lunar_db_full.zip" --s3-no-check-bucket \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["Size"])')
if [ "$REMOTE" != "$BYTES" ]; then
  log "upload FAILED: remote size $REMOTE != local $BYTES (rerun to retry)"
  exit 1
fi
log "upload done ($REMOTE bytes)"

npm run --silent register-full-db -- --size "$BYTES" --replays "$REPLAYS" --snapshot "$SNAPSHOT" >> "$LOG" 2>&1
touch "$ZIP.registered"
log "registered: $REPLAYS replays, $BYTES bytes, snapshot $SNAPSHOT — COMPLETE"
