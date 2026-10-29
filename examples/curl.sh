#!/usr/bin/env bash
# o2api — quick curl examples
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8787}"
MODEL="${MODEL:-$(curl -s "$BASE/v1/models" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"][0]["id"])')}"

echo "→ model: $MODEL"

echo
echo "== non-stream =="
curl -s "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hi in one word.\"}]}" \
  | python3 -m json.tool

echo
echo "== stream =="
curl -sN "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d "{\"model\":\"$MODEL\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Count 1 to 5.\"}]}"

echo
echo "== multi-turn (x-session-id) =="
curl -s "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' \
  -H 'x-session-id: demo-1' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"My name is Kerem.\"}]}" >/dev/null
curl -s "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' \
  -H 'x-session-id: demo-1' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"What is my name?\"}]}" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["choices"][0]["message"]["content"])'
