#!/usr/bin/env bash
set -euo pipefail

# lm-database deployment setup
# Run from the project root: sudo bash deploy/setup.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DEPLOY_USER="${DEPLOY_USER:-matt}"

echo "=== lm-database deployment setup ==="
echo "Project dir: $PROJECT_DIR"
echo "Deploy user: $DEPLOY_USER"
echo ""

# --- Preflight checks ---
if [[ $EUID -ne 0 ]]; then
  echo "Error: Run this script with sudo"
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "Error: Node.js is not installed"
  exit 1
fi

if ! command -v cloudflared &>/dev/null; then
  echo "Error: cloudflared is not installed"
  echo "Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

if ! systemctl is-active --quiet mongod; then
  echo "Warning: mongod is not running. Start it with: sudo systemctl start mongod"
fi

# --- Check for required files ---
if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  echo "Error: .env file not found. Copy .env.example and fill in values:"
  echo "  cp .env.example .env"
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/dist/index.js" ]]; then
  echo "Building TypeScript..."
  su - "$DEPLOY_USER" -c "cd $PROJECT_DIR && npm run build"
fi

# --- Cloudflare tunnel credentials ---
CRED_FILE="/etc/cloudflared/credentials.json"
CF_CONFIG="/etc/cloudflared/config.yml"

mkdir -p /etc/cloudflared

if [[ ! -f "$CRED_FILE" ]]; then
  # Check if user has credentials in their home dir
  USER_CRED=$(find "/home/$DEPLOY_USER/.cloudflared" -name "*.json" -not -name "config.json" 2>/dev/null | head -1)
  if [[ -n "$USER_CRED" ]]; then
    echo "Copying tunnel credentials from $USER_CRED"
    cp "$USER_CRED" "$CRED_FILE"
    chmod 600 "$CRED_FILE"
    chown "$DEPLOY_USER:$DEPLOY_USER" "$CRED_FILE"
  else
    echo "Error: No tunnel credentials found."
    echo "Either:"
    echo "  1. Run 'cloudflared tunnel login' and 'cloudflared tunnel create lm-database' first"
    echo "  2. Copy the credentials JSON to $CRED_FILE"
    exit 1
  fi
fi

# Copy cloudflared config
echo "Installing cloudflared config to $CF_CONFIG"
cp "$SCRIPT_DIR/cloudflared.yml" "$CF_CONFIG"

# --- Install systemd services ---
echo "Installing systemd services..."

cp "$SCRIPT_DIR/lm-database-api.service" /etc/systemd/system/
cp "$SCRIPT_DIR/lm-database-tunnel.service" /etc/systemd/system/

# Update WorkingDirectory in API service to actual project path
sed -i "s|WorkingDirectory=.*|WorkingDirectory=$PROJECT_DIR|" /etc/systemd/system/lm-database-api.service
sed -i "s|EnvironmentFile=.*|EnvironmentFile=$PROJECT_DIR/.env|" /etc/systemd/system/lm-database-api.service
sed -i "s|User=.*|User=$DEPLOY_USER|" /etc/systemd/system/lm-database-api.service
sed -i "s|User=.*|User=$DEPLOY_USER|" /etc/systemd/system/lm-database-tunnel.service

systemctl daemon-reload

# --- Enable and start ---
echo ""
echo "Enabling services..."
systemctl enable lm-database-api.service
systemctl enable lm-database-tunnel.service

echo "Starting services..."
systemctl start lm-database-api.service
systemctl start lm-database-tunnel.service

sleep 3

echo ""
echo "=== Status ==="
systemctl --no-pager status lm-database-api.service | head -5
echo ""
systemctl --no-pager status lm-database-tunnel.service | head -5
echo ""
echo "Done! API should be live at https://api.lunarmelee.com"
echo ""
echo "Useful commands:"
echo "  sudo systemctl status lm-database-api"
echo "  sudo systemctl status lm-database-tunnel"
echo "  sudo journalctl -u lm-database-api -f"
echo "  sudo journalctl -u lm-database-tunnel -f"
