#!/usr/bin/env bash
# Backup lm-database-v2 (SLP index + this API's own usage events) to Backblaze B2,
# client-side encrypted (age) and immutable (B2 Object Lock default retention).
#
# Standalone — NOT wired into the app process. Run on-demand or via cron.
# Plan: database/BACKUP_PLAN.md §6 ; SECURITY_HARDENING.md MIGRATION #3.
#
# Recovery: see RESTORE section at bottom. Decrypting requires the age PRIVATE key,
# which is stored OFFLINE (not on this host) — see project memory project_db_backup.
set -euo pipefail

# --- config (non-secret) ---
DB="lm-database-v2"
BUCKET="lm-db-index-backup"
PREFIX="db"
# age PUBLIC recipient (safe to commit; the private key lives offline only):
AGE_RECIPIENT="age1phqw5uzqhd0pj4sdye6j4s2z4sd8yqn5xu2dje622wcklx5y2q2s69vrh7"
RCLONE_REMOTE="b2backup"            # rclone remote holding the scoped db-backup B2 key
BIN="$HOME/.local/bin"
RCLONE="$BIN/rclone"
AGE="$BIN/age"
MONGODUMP="/usr/bin/mongodump"
# Optional dead-man's-switch (healthchecks.io). Pinged ONLY on success; a missed
# ping = failure caught. Set via env: BACKUP_HEALTHCHECK_URL=...
HEALTHCHECK_URL="${BACKUP_HEALTHCHECK_URL:-}"

# --- run ---
TS="$(date -u +%Y/%m/%d_%H%M%S)"
DEST="${RCLONE_REMOTE}:${BUCKET}/${PREFIX}/${TS}.gz.age"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT      # transient scratch only; nothing persists locally

echo "[$(date -uIs)] dumping $DB ..."
"$MONGODUMP" --db="$DB" --gzip --archive="$TMP/dump.gz" --quiet

echo "[$(date -uIs)] encrypting (age) ..."
"$AGE" -r "$AGE_RECIPIENT" -o "$TMP/dump.gz.age" "$TMP/dump.gz"

echo "[$(date -uIs)] checksum ..."
( cd "$TMP" && sha256sum dump.gz.age > dump.gz.age.sha256 )

echo "[$(date -uIs)] uploading -> $DEST ..."
"$RCLONE" copyto "$TMP/dump.gz.age"        "$DEST"        --s3-no-check-bucket
"$RCLONE" copyto "$TMP/dump.gz.age.sha256" "${DEST}.sha256" --s3-no-check-bucket

echo "[$(date -uIs)] DONE: $DEST ($(numfmt --to=iec "$(stat -c%s "$TMP/dump.gz.age")"))"

# success ping (only reached if everything above succeeded under set -e)
if [ -n "$HEALTHCHECK_URL" ]; then
  curl -fsS -m 10 "$HEALTHCHECK_URL" >/dev/null 2>&1 || true
fi

# --- RESTORE (manual, needs the OFFLINE age private key) ---
#   rclone copyto b2backup:lm-db-index-backup/db/<path>.gz.age ./dump.gz.age
#   rclone copyto b2backup:lm-db-index-backup/db/<path>.gz.age.sha256 ./dump.gz.age.sha256
#   sha256sum -c dump.gz.age.sha256                          # integrity
#   age -d -i <your-private-key-file> -o dump.gz dump.gz.age # decrypt (offline key)
#   mongorestore --gzip --archive=dump.gz --nsFrom 'lm-database-v2.*' --nsTo 'restore_test.*'
#   # then compare counts vs production, drop restore_test
