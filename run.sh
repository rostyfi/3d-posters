#!/bin/bash
# =============================================================================
# 3D Posters - one-command run
# =============================================================================
# Installs dependencies (if missing), builds the app, and serves the build.
#
# Usage:
#   ./run.sh          build + serve production build
#   ./run.sh --dev    start the Vite dev server (hot reload, no build needed)
#
# Environment:
#   PORT  port to serve on (default: 4173; dev server uses Vite's default 5173)
# =============================================================================

set -e
cd "$(dirname "$0")"

PORT="${PORT:-4173}"

# ---------------------------------------------------------------------------
# Development mode: just run the dev server (Vite compiles on the fly)
# ---------------------------------------------------------------------------
if [ "$1" = "--dev" ]; then
  if [ ! -d node_modules ]; then
    echo "Installing dependencies..."
    npm install
  fi
  echo "Starting dev server with hot reload..."
  echo "Open http://localhost:5173 - press Ctrl+C to stop"
  npm run dev
  exit 0
fi

# ---------------------------------------------------------------------------
# Production mode: install -> build -> serve
# ---------------------------------------------------------------------------
if ! command -v node > /dev/null 2>&1; then
  echo "Error: Node.js is not installed (v18+ recommended)." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Building the app..."
npm run build

if [ ! -f dist/index.html ]; then
  echo "Error: build output not found in dist/." >&2
  exit 1
fi

echo "Serving on http://localhost:$PORT (press Ctrl+C to stop)"
if command -v xdg-open > /dev/null 2>&1; then
  xdg-open "http://localhost:$PORT" > /dev/null 2>&1 || true
fi
npm run preview -- --port "$PORT" --strictPort
