#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$HOME/Desktop/PostDeck.command"
cat > "$TARGET" <<INNER
#!/usr/bin/env bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\$PATH"
exec "$REPO_ROOT/scripts/open-postdeck.command"
INNER
chmod +x "$TARGET"
echo "Installed Desktop launcher (wrapper) at: $TARGET"
