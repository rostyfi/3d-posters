# Idea 02 — Relative vertex weld in the manifold builder

Priority: 2 (fallback if idea 01 fails or leaves holes). Status: pending.

## Problem

Same as idea 01: micro-holes / near-coincident region boundaries (offsets up
to ~2e-3 view units, from 3-decimal path rounding and boolean-op noise) are
not paired by `buildManifoldGeometry`'s edge map, which keys edges on a fixed
`MANIFOLD_Q = 1e-4` grid. Unpaired edges emit walls; when the offset is below
the STL weld grid (1e-4 mm ≈ 1.79e-3 view units at the default 100 mm export),
the export weld merges the opposing walls → 4-valent edges → non-manifold STL.

## The idea

Weld near-coincident vertices **relatively** in the builder, so that region
boundaries which the export weld would merge are already exactly coincident
before the edge map is built:

- Replace/augment the fixed `MANIFOLD_Q` snapping of ring vertices with a
  union-find over all ring vertices: two vertices are in the same cluster
  when they are within `TOL` (e.g. `TOL = extent * 1e-6` ≈ the weld grid in
  view units at the default 100 mm export, possibly ×2 safety), and each
  cluster snaps to one representative point (e.g. its first vertex).
- Rebuild every ring from the snapped representatives (dropping consecutive
  duplicates), then proceed with splitRing / edge map / emission as today.

## Risks (why this is priority 2, not 1)

- The flatten output is rounded to 3 decimals, so genuinely distinct
  vertices are often exactly 1e-3 units apart. A weld at ~1.8e-3 units can
  collapse real features: zero-length ring edges (skipped by the wall loop),
  repeated vertices in rings (degenerate triangulation triangles), changed
  topology.
- Snapping moves vertices by up to TOL — invisible (≤ 1e-4 mm), but it
  changes the geometry everywhere, not just at holes.
- Interacts with `splitRing` (T-junction splits) and `resolvePointContacts`
  (nudges): both assume the current quantization semantics.

## Acceptance criteria

Same gate as idea 01: `./run-pipeline.sh "export-2026-08-06 232814.svg"` →
`WATERTIGHT: PASS`, 0 non-manifold edges, volume ≈ 1379.81 mm³, Euler = 2;
`npm run typecheck` clean; `test-stl-e2e.ts` and `test-manifold.ts` pass;
`test-simple.svg` still passes with volume 2000.00 mm³.

## Constraints

- Minimal diff in `src/3d/svg-to-3d.ts` only; no commits; do not revert the
  existing uncommitted working-tree changes.
