#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# lm-database deployment setup
#
# This script sets up everything needed to run the API on a fresh machine:
#   - Creates a dedicated service user (lm-database) with no privileges
#   - Creates required directories with correct ownership
#   - Sets up the firewall (ufw)
#   - Installs systemd services for the API and Cloudflare tunnel
#   - Copies cloudflared credentials
#
# Prerequisites (install manually before running):
#   - Node.js (v20+)
#   - MongoDB (v7+)
#   - cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
#   - slpz binary (cargo install slpz, then copy to /usr/local/bin/slpz)
#
# Usage:
#   sudo bash deploy/setup.sh                     # first time, or re-run to update
#   DEPLOY_ADMIN=matt sudo bash deploy/setup.sh   # use a different admin user
#
# The script is idempotent — safe to re-run anytime.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# DEPLOY_ADMIN is YOUR personal user account (for building, git, etc.)
# The API itself runs as the locked-down lm-database user.
DEPLOY_ADMIN="${DEPLOY_ADMIN:-matt}"
SERVICE_USER="lm-database"
SERVICE_GROUP="lm-database"

INSTALL_DIR="/opt/lm-database"
TEMP_DIR="/var/lib/lm-database/temp"
LOG_DIR="/opt/lm-database/logs"

echo "=== lm-database deployment setup ==="
echo "Project dir:   $PROJECT_DIR"
echo "Install dir:   $INSTALL_DIR"
echo "Admin user:    $DEPLOY_ADMIN"
echo "Service user:  $SERVICE_USER"
echo ""

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------

if [[ $EUID -ne 0 ]]; then
  echo "Error: Run this script with sudo"
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "Error: Node.js is not installed"
  echo "Install: https://nodejs.org/en/download/"
  exit 1
fi

if ! command -v mongod &>/dev/null; then
  echo "Error: MongoDB is not installed"
  echo "Install: https://www.mongodb.com/docs/manual/installation/"
  exit 1
fi

if ! command -v cloudflared &>/dev/null; then
  echo "Error: cloudflared is not installed"
  echo "Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  echo "Error: .env file not found. Copy .env.example and fill in values:"
  echo "  cp .env.example .env && nano .env"
  exit 1
fi

if ! systemctl is-active --quiet mongod; then
  echo "Warning: mongod is not running. Start it with: sudo systemctl start mongod"
fi

# ---------------------------------------------------------------------------
# 1. Create service user
# ---------------------------------------------------------------------------

echo "--- Creating service user ---"

if id "$SERVICE_USER" &>/dev/null; then
  echo "User '$SERVICE_USER' already exists"
else
  useradd \
    --system \
    --shell /usr/sbin/nologin \
    --home-dir "$INSTALL_DIR" \
    --no-create-home \
    "$SERVICE_USER"
  echo "Created user '$SERVICE_USER'"
fi

# ---------------------------------------------------------------------------
# 2. Create directories
# ---------------------------------------------------------------------------

echo "--- Creating directories ---"

mkdir -p "$INSTALL_DIR"
mkdir -p "$TEMP_DIR"
mkdir -p "$LOG_DIR"

# The SLP replay directory needs to be readable by the service user.
# We add lm-database to a group that can read the drive, or set ACLs.
# For now, make the replay dir world-readable (it's not sensitive).
# Update SLP_ROOT_DIR in .env to point to the correct path on this machine.

# ---------------------------------------------------------------------------
# 3. Build and install application
# ---------------------------------------------------------------------------

echo "--- Building application ---"

if [[ ! -f "$PROJECT_DIR/dist/index.js" ]] || [[ "$PROJECT_DIR/src" -nt "$PROJECT_DIR/dist/index.js" ]]; then
  su - "$DEPLOY_ADMIN" -c "cd $PROJECT_DIR && npm run build"
fi

# Sync built application to install dir
echo "Syncing to $INSTALL_DIR..."
rsync -a --delete \
  --exclude='.git' \
  --exclude='.claude' \
  --exclude='crawl.log' \
  --exclude='src/' \
  "$PROJECT_DIR/" "$INSTALL_DIR/"

# ---------------------------------------------------------------------------
# 4. Set ownership and permissions
# ---------------------------------------------------------------------------

echo "--- Setting permissions ---"

# Application files owned by service user, readable only by them
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR"
chmod 750 "$INSTALL_DIR"

# .env contains secrets — owner-only
chmod 600 "$INSTALL_DIR/.env"

# Temp dir for job compression/bundling
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$TEMP_DIR"
chmod 750 "$TEMP_DIR"

# SLP replay files need to be readable by the service user.
# If they're on an external drive, the simplest approach is an ACL:
SLP_DIR=$(grep '^SLP_ROOT_DIR=' "$INSTALL_DIR/.env" | cut -d= -f2- | tr -d '"' | tr -d "'")
if [[ -n "$SLP_DIR" && -d "$SLP_DIR" ]]; then
  echo "Setting read access on SLP directory: $SLP_DIR"
  setfacl -R -m u:"$SERVICE_USER":rX "$SLP_DIR" 2>/dev/null || {
    echo "Warning: setfacl failed. Install acl package or manually grant read access:"
    echo "  sudo setfacl -R -m u:$SERVICE_USER:rX $SLP_DIR"
  }
else
  echo "Warning: SLP_ROOT_DIR not found or not set. Update .env and re-run."
fi

# slpz binary needs to be accessible
SLPZ_PATH=$(grep '^SLPZ_BINARY=' "$INSTALL_DIR/.env" | cut -d= -f2- | tr -d '"' | tr -d "'")
SLPZ_PATH="${SLPZ_PATH:-/usr/local/bin/slpz}"
if [[ -f "$SLPZ_PATH" ]]; then
  echo "slpz binary found at $SLPZ_PATH"
  chmod 755 "$SLPZ_PATH"
else
  echo "Warning: slpz binary not found at $SLPZ_PATH"
  echo "  Install: cargo install slpz && sudo cp ~/.cargo/bin/slpz /usr/local/bin/"
fi

# ---------------------------------------------------------------------------
# 5. Firewall (ufw)
# ---------------------------------------------------------------------------

echo "--- Configuring firewall ---"

if ! command -v ufw &>/dev/null; then
  echo "Installing ufw..."
  apt-get install -y ufw
fi

# Allow SSH so we don't lock ourselves out
ufw allow ssh

# Deny everything else inbound by default.
# The API is accessed via Cloudflare Tunnel (outbound connection), not inbound ports.
ufw default deny incoming
ufw default allow outgoing

# Enable if not already active (--force avoids interactive prompt)
if ! ufw status | grep -q "Status: active"; then
  echo "Enabling firewall..."
  ufw --force enable
else
  echo "Firewall already active"
fi

ufw status

# ---------------------------------------------------------------------------
# 6. Cloudflare tunnel credentials
# ---------------------------------------------------------------------------

echo "--- Cloudflare tunnel ---"

CRED_FILE="/etc/cloudflared/credentials.json"
CF_CONFIG="/etc/cloudflared/config.yml"

mkdir -p /etc/cloudflared

if [[ ! -f "$CRED_FILE" ]]; then
  # Look in the admin user's home directory
  USER_CRED=$(find "/home/$DEPLOY_ADMIN/.cloudflared" -name "*.json" -not -name "config.json" 2>/dev/null | head -1)
  if [[ -n "$USER_CRED" ]]; then
    echo "Copying tunnel credentials from $USER_CRED"
    cp "$USER_CRED" "$CRED_FILE"
  else
    echo "Error: No tunnel credentials found."
    echo "  1. Run 'cloudflared tunnel login' as $DEPLOY_ADMIN"
    echo "  2. Run 'cloudflared tunnel create lm-database'"
    echo "  3. Re-run this script"
    exit 1
  fi
fi

# Credentials readable only by service user
chmod 600 "$CRED_FILE"
chown "$SERVICE_USER:$SERVICE_GROUP" "$CRED_FILE"

# Install cloudflared routing config
echo "Installing cloudflared config to $CF_CONFIG"
cp "$SCRIPT_DIR/cloudflared.yml" "$CF_CONFIG"
chown "$SERVICE_USER:$SERVICE_GROUP" "$CF_CONFIG"

# ---------------------------------------------------------------------------
# 7. Install systemd services
# ---------------------------------------------------------------------------

echo "--- Installing systemd services ---"

cp "$SCRIPT_DIR/lm-database-api.service" /etc/systemd/system/
cp "$SCRIPT_DIR/lm-database-tunnel.service" /etc/systemd/system/

# Patch paths — the template uses /opt/lm-database, which is usually correct,
# but override if INSTALL_DIR differs.
if [[ "$INSTALL_DIR" != "/opt/lm-database" ]]; then
  sed -i "s|WorkingDirectory=.*|WorkingDirectory=$INSTALL_DIR|" /etc/systemd/system/lm-database-api.service
  sed -i "s|EnvironmentFile=.*|EnvironmentFile=$INSTALL_DIR/.env|" /etc/systemd/system/lm-database-api.service
fi

systemctl daemon-reload

# ---------------------------------------------------------------------------
# 8. Enable and start services
# ---------------------------------------------------------------------------

echo "--- Starting services ---"

systemctl enable lm-database-api.service
systemctl enable lm-database-tunnel.service

systemctl restart lm-database-api.service
systemctl restart lm-database-tunnel.service

sleep 3

echo ""
echo "=== Status ==="
systemctl --no-pager status lm-database-api.service | head -5
echo ""
systemctl --no-pager status lm-database-tunnel.service | head -5
echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo "=== Done ==="
echo ""
echo "API should be live at https://api.lunarmelee.com"
echo ""
echo "Service user:  $SERVICE_USER (no shell, no sudo, no groups)"
echo "App directory:  $INSTALL_DIR"
echo "Temp directory: $TEMP_DIR"
echo "Firewall:       active (SSH only)"
echo ""
echo "Useful commands:"
echo "  sudo systemctl status lm-database-api"
echo "  sudo systemctl status lm-database-tunnel"
echo "  sudo journalctl -u lm-database-api -f"
echo "  sudo journalctl -u lm-database-tunnel -f"
echo ""
echo "To update after code changes:"
echo "  cd $PROJECT_DIR && npm run build"
echo "  sudo bash deploy/setup.sh"
echo ""
echo "Remaining manual steps:"
echo "  1. Set up MongoDB auth (see TODO in MEMORY.md)"
echo "  2. Set GMAIL_APP_PASSWORD in .env for email alerts"
echo "  3. Run 'npm run create-admin <user> <pass>' to create admin account"
