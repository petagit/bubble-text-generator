#!/usr/bin/env bash
# Serve the bubble text generator over http://localhost so Web Workers and
# OffscreenCanvas work reliably (file:// blocks both in some browsers).
cd "$(dirname "$0")"
PORT="${PORT:-8765}"
echo "Serving on http://localhost:$PORT"
( sleep 0.5 && open "http://localhost:$PORT/index.html" ) &
exec python3 -m http.server "$PORT"
