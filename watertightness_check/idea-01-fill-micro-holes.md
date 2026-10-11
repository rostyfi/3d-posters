# Idea 01 — Fill micro-holes narrower than the STL weld grid

Priority: 1 (top). Status: pending.

## Problem

`./run-pipeline.sh "export-2026-08-06 232814.svg"` produces a non-watertight
STL: 2 non-manifold edges, each shared by 4 triangles (a zero-thickness double
wall). Full analysis in `../WORK_IN_PROGRESS.md`.

Root cause chain:

1. The flatten step emits path data rounded to 3 decimals, which turns
   sub-quantum gaps between near-coincident boundaries into hairline **holes**
   (uncovered area between regions). `checkFlattenCoverage` tolerates them as
   sub-pixel noise; `removeRegionOverlaps` only fixes overlaps, not gaps.
2. In `buildManifoldGeometry` (src/3d/svg-to-3d.ts) a hole's boundary edges
   are unpaired in the edge map, so each neighboring region emits a wall
   along its edge — correct for a real hole.
3. But when the hole is **narrower than the STL weld grid**
   (`WELD_TOLERANCE` = 1e-4 mm in src/3d/stl-export.ts ≈ 1.79e-3 view units at
   the default 100 mm export), `repairFaces`' vertex weld merges the two
   opposing walls into one → their top and bottom edges become 4-valent →
   non-manifold STL.

Concrete instance: a thin triangular hole (width 7.14e-4 units ≈ 3.98e-5 mm)
between regions r#5 (`#f5bf33` sliver), r#49 (`#1e2c3f` background) and r#69
(`#f6f6f2`) at view ≈ (554.77–554.815, 587.24–587.349), vertices
(554.815, 587.24), (554.77, 587.349), (554.7703, 587.3483).

## The idea

**Fill micro-holes before the manifold geometry is built.** After
`removeRegionOverlaps` and before `buildManifoldGeometry`, find uncovered
gaps (closed loops of wall-emitting edges) whose width is below the weld
grid, and add a fill region covering each one. The fill region's edges are
the exact same vertices as the neighbors' edges, so they pair exactly in the
edge map → no walls → the gap is covered by top + bottom faces → manifold.

## Where to implement

`src/3d/svg-to-3d.ts` only:

- Add `function fillMicroHoles(regions: Region[]): number` (returns the
  number of holes filled) near `removeRegionOverlaps`.
- Call it in `createManifoldGroupForExport` between
  `await removeRegionOverlaps(regions);` and
  `const geometry = buildManifoldGeometry(regions, colorHeights, layerHeightMM);`.
- Reuse what is already in the file: `MANIFOLD_Q`, `vertKey`, `edgeKey`,
  the `Region` type, `Polygon` and `point` from `@flatten-js/core`.

## Algorithm

1. **Collect directed ring edges.** For every region, for every face of
   `polygon.faces`, walk the face's vertices in order (each edge
   `e.start → e.end`; the file's `segmentsOf` shows how). Remember the
   owning region index per directed edge.
2. **Build the undirected edge map** keyed by `edgeKey(a, b)` (MANIFOLD_Q
   snapped, direction-insensitive — the same key the builder uses). Count
   directed edges per key and the set of distinct region indices per key.
3. **Wall-emitting edges** = keys with exactly **one** directed edge in
   total (the builder emits a wall exactly when its edge-map list contains no
   entry from a *different* region; a key used twice by the same region, e.g.
   an earcut bridge, is treated as paired and emits no wall — exclude those).
   These are precisely the edges the builder will wall: the outer canvas
   boundary plus every hole boundary.
4. **Trace closed loops** over the directed wall-emitting edges: chain by
   snapped endpoint key (the edge `a→b` continues with an unused edge
   starting at `b`) until the loop closes. Each loop is one boundary
   component: the outer boundary, or a hole. (At a vertex with several
   candidate outgoing edges, any unused one works for simple pinches; a
   wrong pick yields a self-intersecting fill polygon, which `addFace`
   rejects — see step 7.)
5. **Measure each loop**: shoelace area over the loop points, perimeter, and
   a width proxy `w = 2 * area / perimeter` (for a thin slit ≈ its short
   dimension; for a round hole ≈ its radius — a width proxy for both).
6. **Fill criterion**: fill when `w < 2 * extent * 1e-6`, where `extent` =
   max coordinate range over all region vertices. Rationale:
   `extent * 1e-6` is the STL weld grid (1e-4 mm) in view units at the
   default 100 mm export (mm per view unit = 100 / extent); the factor 2 is
   a safety margin for weld-cell straddling. For the poster
   (extent ≈ 1793) the threshold is ≈ 3.6e-3 units ≈ 2e-4 mm — far below
   print resolution (0.1 mm layer height), so filling is invisible.
   Holes wider than the threshold are legitimate slits / artwork holes —
   leave them (their walls do not weld → manifold). The outer canvas
   boundary loop is huge → never filled.
7. **Fill**: for each micro-hole loop, append
   `{ color: <color of a region that contributed an edge to the loop>,
      polygon }` to `regions`, where `polygon = new Polygon()` and
   `polygon.addFace(loopPoints.map(p => point(p.x, p.y)))` — the same
   construction `svgToRegions` uses. Dedupe consecutive loop points that
   snapped to the same key. Wrap in try/catch and skip degenerate loops.
   Verify `!polygon.isEmpty() && polygon.area() > 0`; if the winding makes
   the face negative, reverse the loop. (`extractIslands` →
   `contoursToIslands` classifies by winding number and is robust to
   orientation, but keep the face valid.)
   - Color choice: an adjacent region's color, so the fill inherits that
     region's height and no new palette color is introduced. (If every
     adjacent region has height 0 the fill is dropped too — harmless, there
     is no material there anyway.)
8. **Log** like `removeRegionOverlaps` does:
   `fillMicroHoles: filled=N micro-hole(s) (scanned M boundary loop(s))`.

## Why this is safe

- Only uncovered gaps narrower than ~2e-4 mm are filled — invisible at print
  resolution and far below the STL weld grid.
- The fill region's edges are the exact vertices of the neighbors' edges →
  exact edge-map pairing → no walls, no double walls, no cracks.
- Holes wider than the weld grid are untouched (they are manifold slits).
- The outer boundary is untouched (huge width).

## Acceptance criteria

1. `npm run typecheck` passes (strict TS; tsconfig covers `src`).
2. Synthetic tests still pass. Bundle and run them exactly like the pipeline
   runner does (node on the ambient PATH is broken — always use `env -i`):
   ```
   node_modules/.bin/esbuild test-stl-e2e.ts --bundle --platform=node --format=cjs --outfile=.test-stl-e2e.cjs --external:jsdom
   env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/rost node .test-stl-e2e.cjs
   # expect: ALL E2E SCENARIOS PASSED
   node_modules/.bin/esbuild test-manifold.ts --bundle --platform=node --format=cjs --outfile=.test-manifold.cjs --external:jsdom
   env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/rost node .test-manifold.cjs
   # expect: ALL SCENARIOS PASSED
   ```
   Clean up the `.test-*.cjs` bundles afterwards.
3. `cp test-simple.svg /tmp/ && ./run-pipeline.sh /tmp/test-simple.svg`
   → `WATERTIGHT: PASS`, volume 2000.00 mm³.
4. Gate (the controller re-runs this too):
   `./run-pipeline.sh "export-2026-08-06 232814.svg"` (~3 min; run in
   background and poll the log) → `WATERTIGHT: PASS` with:
   - non-manifold edges = 0, mis-oriented edges = 0,
   - signed volume ≈ 1379.81 mm³,
   - Euler V−E+F = 2,
   - edge histogram all-2s.

## Constraints

- Minimal diff, `src/3d/svg-to-3d.ts` only. Match the existing code style.
- Do **not** commit anything. Do not revert or modify the existing
  uncommitted working-tree changes beyond your fix.
- Do not touch `src/3d/stl-export.ts`, `src/utils/svg-flatten.ts`,
  `src/main.ts` unless strictly necessary (they are not, for this idea).
- Report back: what you changed (files/functions), the test outputs (key
  lines), and the poster gate result.

## Result (controller)

Subagent `wt-idea-01` implemented this idea as an uncommitted working-tree
change: `fillMicroHoles` in `src/3d/svg-to-3d.ts` (+149 lines, purely
additive), wired into `createManifoldGroupForExport` between
`removeRegionOverlaps` and `buildManifoldGeometry`. The subagent was stopped
before reporting; the controller ran the remaining checks:

- `npm run typecheck`: **PASS**.
- Gate `./run-pipeline.sh "export-2026-08-06 232814.svg"`: **FAIL**.
  `fillMicroHoles: filled=36 micro-hole(s) (scanned 42 boundary loop(s))`,
  but the builder then reported `18 non-manifold edges detected` and the STL
  has **12 non-manifold edges** (histogram `{2: 90594, 3: 12}`, 12
  mis-oriented), 60408 triangles, volume 1379.81 mm³ (correct), Euler
  V−E+F = 6.

The fill removed the original double wall (was: 2 edges shared by 4
triangles) but introduced count-3 edges: the fill regions' boundaries do
not pair cleanly with their neighbors everywhere — likely loop-tracing at
pinch vertices, T-junction mismatches between the fill ring and the
neighbors' rings, or fill/neighbor overlaps (the builder's diagnostic blames
overlapping input regions). Next iteration should inspect the 12 bad edges
(5 distinct XY locations, at z=0 and z=0.2) and the corresponding fill
regions.

Status: loop paused — the controller teleported into remote execution. The
fix is uncommitted in the working tree; the pre-fix state is on remote
`master` (commit `b048cf4`).
