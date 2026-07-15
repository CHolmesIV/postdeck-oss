#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE="$SCRIPT_DIR/open-postdeck.command"
TARGET="$HOME/Desktop/PostDeck.command"

if [ ! -f "$SOURCE" ]; then
  echo "Missing launcher source: $SOURCE" >&2
  exit 1
fi

cp "$SOURCE" "$TARGET"
chmod +x "$TARGET"
echo "Installed Desktop launcher at: $TARGET"
