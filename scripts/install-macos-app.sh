#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="PostDeck"
APP_PATH="$HOME/Desktop/${APP_NAME}.app"
ICON_PNG="${1:-$REPO_ROOT/assets/postdeck-icon.png}"
TMP_DIR="$(mktemp -d)"
ICONSET_DIR="$TMP_DIR/postdeck.iconset"
ICON_ICNS="$TMP_DIR/postdeck.icns"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if [ ! -f "$ICON_PNG" ]; then
  echo "Missing icon PNG: $ICON_PNG" >&2
  exit 1
fi

mkdir -p "$ICONSET_DIR"

make_icon() {
  local size="$1"
  local out="$2"
  sips -z "$size" "$size" "$ICON_PNG" --out "$out" >/dev/null
}

make_icon 16   "$ICONSET_DIR/icon_16x16.png"
make_icon 32   "$ICONSET_DIR/icon_16x16@2x.png"
make_icon 32   "$ICONSET_DIR/icon_32x32.png"
make_icon 64   "$ICONSET_DIR/icon_32x32@2x.png"
make_icon 128  "$ICONSET_DIR/icon_128x128.png"
make_icon 256  "$ICONSET_DIR/icon_128x128@2x.png"
make_icon 256  "$ICONSET_DIR/icon_256x256.png"
make_icon 512  "$ICONSET_DIR/icon_256x256@2x.png"
make_icon 512  "$ICONSET_DIR/icon_512x512.png"
make_icon 1024 "$ICONSET_DIR/icon_512x512@2x.png"

iconutil -c icns "$ICONSET_DIR" -o "$ICON_ICNS"

rm -rf "$APP_PATH"
osacompile -o "$APP_PATH" <<OSA
on run
  do shell script quoted form of "$REPO_ROOT/scripts/open-postdeck.command"
end run
OSA

cp "$ICON_ICNS" "$APP_PATH/Contents/Resources/applet.icns"

echo "Installed app launcher at: $APP_PATH"
