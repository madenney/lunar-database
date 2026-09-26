#!/usr/bin/env bash
# Start a stats-extraction runner on a helper machine (not the worker, which uses
# its own .env). Reads settings from $LUNAR_STATS_ENV (default
# ~/.config/lunar-stats/env): MONGODB_URI through an SSH tunnel to the worker's
# MongoDB, plus SLP_ROOT_DIR / SLPZ_ARCHIVE_DIR / SLPZ_BINARY for the NFS-mounted
# archive. Opens the tunnel if it isn't up, then runs detached and logs.
#
#   scripts/stats/run-extractor.sh --detail-dir DIR [--workers N] [--max-shards N]
#   STATS_NAMESPACE=pilot scripts/stats/run-extractor.sh ...
#
# Env: LUNAR_STATS_TUNNEL_KEY (ssh identity for the tunnel), LUNAR_STATS_LOG.
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV_FILE="${LUNAR_STATS_ENV:-$HOME/.config/lunar-stats/env}"
LOG="${LUNAR_STATS_LOG:-$HOME/lunar-stats-${STATS_NAMESPACE:-main}.log}"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a

if ! ss -ltn | grep -q '127.0.0.1:27018 '; then
  ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
    ${LUNAR_STATS_TUNNEL_KEY:+-i "$LUNAR_STATS_TUNNEL_KEY"} \
    -f -N -L 127.0.0.1:27018:127.0.0.1:27017 matt@192.168.1.132
fi

nohup nice -n 5 npm run --silent extract-stats -- "$@" >> "$LOG" 2>&1 < /dev/null &
echo "runner started (pid $!), log: $LOG"
