#!/usr/bin/env bash
# o2api installer — puts a global `o2api` command on your PATH.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$DIR/bin/o2api.mjs"
TARGET="/usr/local/bin/o2api"

chmod +x "$BIN"

if [ -w "/usr/local/bin" ]; then
  ln -sf "$BIN" "$TARGET"
  ln -sf "$BIN" "/usr/local/bin/opencode2api" 2>/dev/null || true
  echo "✅ installed: $TARGET"
elif command -v sudo >/dev/null 2>&1; then
  sudo ln -sf "$BIN" "$TARGET"
  sudo ln -sf "$BIN" "/usr/local/bin/opencode2api" 2>/dev/null || true
  echo "✅ installed with sudo: $TARGET"
else
  echo "⚠️  /usr/local/bin is not writable. Add this alias instead:"
  echo
  echo "    echo \"alias o2api='node $BIN'\" >> ~/.bashrc"
  echo "    source ~/.bashrc"
  exit 0
fi

echo
echo "Try it:"
echo "    o2api --help"
echo "    o2api            # http://127.0.0.1:8787/v1"
