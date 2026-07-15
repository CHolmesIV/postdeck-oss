#!/usr/bin/env bash
set -euo pipefail

# Finder / osascript launch with a minimal PATH that lacks Homebrew, so node
# and npm are not found. Put them on PATH before doing anything.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO_ROOT/logs"
URL="http://127.0.0.1:4520"
HEALTH_URL="$URL/api/health"

mkdir -p "$LOG_DIR"
is_running() { curl --silent --fail --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; }
start_server() {
  echo "Starting PostDeck..."
  nohup npm start >"$LOG_DIR/postdeck-launcher.out.log" 2>"$LOG_DIR/postdeck-launcher.err.log" &
}
cd "$REPO_ROOT"
if ! is_running; then
  start_server
  for _ in {1..20}; do sleep 1; is_running && break; done
fi
open "$URL"
