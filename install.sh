#!/usr/bin/env bash
# opencode2api installer — puts a global `opencode2api` command on your PATH.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$DIR/bin/opencode2api.mjs"
TARGET="/usr/local/bin/opencode2api"

chmod +x "$BIN"

if [ -w "/usr/local/bin" ]; then
  ln -sf "$BIN" "$TARGET"
  echo "✅ installed: $TARGET"
elif command -v sudo >/dev/null 2>&1; then
  sudo ln -sf "$BIN" "$TARGET"
  echo "✅ installed with sudo: $TARGET"
else
  echo "⚠️  /usr/local/bin is not writable. Add this alias instead:"
  echo
  echo "    echo \"alias opencode2api='node $BIN'\" >> ~/.bashrc"
  echo "    source ~/.bashrc"
  exit 0
fi

echo
echo "Try it:"
echo "    opencode2api --help"
echo "    opencode2api            # http://127.0.0.1:8787/v1"
