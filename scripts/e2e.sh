#!/usr/bin/env bash
# 端到端自检：用临时库起服务，跑完即停，不污染 data/ 下的正式台账。
set -e
cd "$(dirname "$0")/.."
PORT=${E2E_PORT:-$(node -e 'console.log(4000 + Math.floor(Math.random()*20000))')}
TMPDIR_DB=$(mktemp -d)
DB_PATH="$TMPDIR_DB/e2e.json" PORT="$PORT" setsid node server.js >/tmp/core-ledger-e2e.log 2>&1 < /dev/null &
SRV=$!
cleanup() { kill -- -"$SRV" 2>/dev/null || true; rm -rf "$TMPDIR_DB"; }
trap cleanup EXIT
READY=0
for _ in $(seq 1 50); do
  if curl -s -o /dev/null "http://localhost:$PORT/api/samples"; then READY=1; break; fi
  if ! kill -0 "$SRV" 2>/dev/null; then echo "server exited early:"; cat /tmp/core-ledger-e2e.log; exit 1; fi
  sleep 0.1
done
[ "$READY" = 1 ] || { echo "server not ready"; cat /tmp/core-ledger-e2e.log; exit 1; }
BASE="http://localhost:$PORT" node scripts/e2e-check.mjs
