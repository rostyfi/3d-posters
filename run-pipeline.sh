#!/bin/bash
# =============================================================================
# 3D Posters - headless transformation pipeline test
# =============================================================================
# Runs the full SVG -> STL pipeline on an SVG file with the app's default
# settings (mirrors the button handlers in src/main.ts):
#
#   simplify colors -> flatten (vector-native) -> manifold 3D group ->
#   scaled clone -> binary STL -> watertight check on the STL file
#
# The STL is written next to the input SVG (<name>.stl). The watertight check
# re-reads the STL from disk and verifies, at float32 bit precision (what a
# slicer sees): every edge shared by exactly 2 triangles, consistent winding
# (every directed edge exactly once), positive signed volume.
#
# Usage:
#   ./run-pipeline.sh <svg-file> [targetColors=4] [layerHeightMM=0.2] [exportLongSideMM=100]
#
# Example:
#   ./run-pipeline.sh "export-2026-08-06 232814.svg"
#
# Exit code: 0 = STL is watertight, 1 = pipeline/check failed, 2 = timeout.
# Runtime: ~3 min for a real poster (the flatten step is CPU-heavy).
# =============================================================================
set -e
cd "$(dirname "$0")"

SVG="${1:?Usage: ./run-pipeline.sh <svg-file> [targetColors=4] [layerHeightMM=0.2] [exportLongSideMM=100]}"
shift || true

# Bundle the TypeScript runner (esbuild ships with Vite).
node_modules/.bin/esbuild run-pipeline.ts \
  --bundle --platform=node --format=cjs \
  --outfile=.run-pipeline.cjs --external:jsdom --log-level=warning

# Run with a clean environment: the ambient LD_LIBRARY_PATH (a VSCode
# extension directory) breaks the system node binary with GLIBCXX errors.
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="${HOME:-/home/rost}" \
  node .run-pipeline.cjs "$SVG" "$@"
