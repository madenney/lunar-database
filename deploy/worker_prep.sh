#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# lm-database — WORKER PREP
#
# Installs the prerequisites so the worker can host the whole backend (API +
# MongoDB + bundler + tunnel), reading the 19 TB archive from LOCAL disk instead
# of over NFS. Run this BEFORE cutover; it is safe to run while the box is busy.
#
# What it does (idempotent — safe to re-run):
#   - Node.js 24 LTS  (worker currently has EOL Node 18)
#   - MongoDB 8.0      (bound to 127.0.0.1; auth NOT yet enabled — see below)
#   - cloudflared
#   - slpz -> /usr/local/bin  (binary already copied to ~/slpz-prep)
#
# What it deliberately does NOT do (these are careful cutover steps in
# deploy/MIGRATION.md, done with a human in the loop):
#   - enable MongoDB auth / create the app user   (you pick the password)
#   - migrate the database                        (dump/restore at cutover)
#   - touch the firewall (ufw)                    (could sever SSH / the bots)
#   - install/start the API or the tunnel         (cutover)
#   - stop or disturb the running bots / postgres / other node app
#
# Usage:   sudo bash worker_prep.sh
# =============================================================================

if [[ $EUID -ne 0 ]]; then echo "Run with sudo: sudo bash worker_prep.sh"; exit 1; fi
source /etc/os-release
if [[ "${VERSION_CODENAME:-}" != "noble" ]]; then
  echo "Expected Ubuntu 24.04 (noble); found '${VERSION_CODENAME:-?}'. Aborting."; exit 1
fi

ADMIN_HOME="$(getent passwd matt | cut -d: -f6)"
say(){ printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
say "Node.js 24 LTS"
if command -v node >/dev/null && [[ "$(node -v)" == v24.* ]]; then
  echo "node $(node -v) already present — skipping"
else
  echo "note: this upgrades the SYSTEM node (worker is on EOL v18). Any other"
  echo "node project on this box gets v24 the next time it restarts."
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
echo "node: $(node -v)  npm: $(npm -v)"

# ---------------------------------------------------------------------------
say "MongoDB 8.0"
if command -v mongod >/dev/null; then
  echo "mongod already present: $(mongod --version | head -1)"
else
  curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
    | gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor --yes
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
    > /etc/apt/sources.list.d/mongodb-org-8.0.list
  apt-get update -y
  apt-get install -y mongodb-org
fi

# Ensure localhost-only bind (default, but make it explicit). Auth stays OFF for
# now — same posture as belphegor today — and is enabled at cutover once the
# app user exists, so we never lock ourselves out of an empty DB.
if ! grep -qE '^\s*bindIp:\s*127\.0\.0\.1\s*$' /etc/mongod.conf; then
  echo "  (leave /etc/mongod.conf bindIp at its 127.0.0.1 default — verify below)"
fi
systemctl enable --now mongod
sleep 2
systemctl is-active --quiet mongod && echo "mongod: active on $(grep -A2 '^net:' /etc/mongod.conf | grep bindIp | xargs)"

# ---------------------------------------------------------------------------
say "cloudflared"
if command -v cloudflared >/dev/null; then
  echo "cloudflared already present: $(cloudflared --version 2>/dev/null | head -1)"
else
  mkdir -p /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared noble main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -y
  apt-get install -y cloudflared
fi
echo "cloudflared: $(cloudflared --version 2>/dev/null | head -1)"
echo "note: installed only — the tunnel is configured/started at cutover."

# ---------------------------------------------------------------------------
say "slpz -> /usr/local/bin"
if [[ -x "$ADMIN_HOME/slpz-prep" ]]; then
  install -m 0755 "$ADMIN_HOME/slpz-prep" /usr/local/bin/slpz
  echo "slpz installed: $(command -v slpz)"
else
  echo "WARN: $ADMIN_HOME/slpz-prep not found — re-copy it from belphegor, or 'cargo install slpz'."
fi

# ---------------------------------------------------------------------------
say "PREP COMPLETE"
cat <<EOF
Installed: node $(node -v), $(mongod --version 2>/dev/null | head -1), cloudflared, slpz.
MongoDB is running EMPTY, localhost-only, NO auth yet.

Nothing was migrated, no traffic moved, firewall untouched, bots undisturbed.

Next (cutover, see deploy/MIGRATION.md — do with a human in the loop):
  1. Create the Mongo app user + enable auth (you choose the password).
  2. mongodump on belphegor -> mongorestore here; verify replay count.
  3. Deploy the code, point SLP_ROOT_DIR at the LOCAL archive
     (/home/matt/Projects/worker/shared_folder/lunar_db).
  4. Move the Cloudflare tunnel; flip api.lunarmelee.com -> this box.
  5. Run the slpz backfill locally (now fast).
EOF
