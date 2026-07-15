#!/usr/bin/env bash
# Install (or remove, with --uninstall) a launchd agent that keeps PostDeck's
# `node src/server.js` running whenever CB's Mac is up — RunAtLoad + KeepAlive.
# See SPEC.md B6 and README.md "launchd agent" section.
#
# Usage:
#   scripts/install-launchd.sh            # install + bootstrap-load
#   scripts/install-launchd.sh --uninstall  # unload + remove the plist
#
# Do NOT run this from an agent session without CB's go-ahead — it registers
# a persistent background process. This script is written to be reviewed with
# `bash -n scripts/install-launchd.sh` before ever being executed.

set -euo pipefail

LABEL="com.postdeck"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/${LABEL}.plist"

# Resolve the repo root (this script lives in <repo>/scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO_ROOT/logs"

NODE_BIN="$(command -v node || true)"

uninstall() {
  echo "Uninstalling launchd agent: $LABEL"
  if launchctl list "$LABEL" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || launchctl unload "$PLIST_PATH" 2>/dev/null || true
  fi
  if [ -f "$PLIST_PATH" ]; then
    rm -f "$PLIST_PATH"
    echo "Removed $PLIST_PATH"
  else
    echo "No plist found at $PLIST_PATH (already uninstalled?)"
  fi
  exit 0
}

if [ "${1:-}" == "--uninstall" ]; then
  uninstall
fi

if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found on PATH. Install Node 20+ first (see README)." >&2
  exit 1
fi

mkdir -p "$PLIST_DIR" "$LOG_DIR"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>src/server.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/postdeck.out.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/postdeck.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
PLIST

echo "Wrote $PLIST_PATH"

# bootstrap (modern launchctl) with a fallback to `load` for older macOS.
if launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null; then
  echo "Loaded via launchctl bootstrap."
else
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"
  echo "Loaded via launchctl load."
fi

echo "Done. Check status with: launchctl list | grep ${LABEL}"
echo "Logs: ${LOG_DIR}/postdeck.out.log and ${LOG_DIR}/postdeck.err.log"
echo "Uninstall with: scripts/install-launchd.sh --uninstall"
