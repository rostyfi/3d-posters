# Idea 04 — Tolerant edge pairing in the builder's wall emission

Priority: 4 (last resort). Status: pending.

## Problem

Same as idea 01: `buildManifoldGeometry`'s edge map keys edges on the fixed
`MANIFOLD_Q = 1e-4` grid, so near-coincident boundaries (offsets up to ~2e-3
view units) are not paired → both regions emit walls → double wall.

## The idea

Make the wall-emission neighbor lookup tolerant: when the exact
`edgeMap.get(edgeKey(pi, pj))` finds no other region, search a spatial index
of edges (bucketed by quantized midpoint, like `VertexGrid`) for a
near-coincident edge from another region (both endpoints within `TOL`,
either orientation) and use that region's height as `neighborH`.

## Risks (why this is priority 4 — dangerous)

- For gaps **above** the weld grid this turns today's manifold slits (double
  walls that do not weld → every edge 2-valent) into **open cracks** (the top
  faces' shared edge would have only 1 user → boundary edge → non-manifold).
  It is only safe for gaps the export weld is guaranteed to close, i.e.
  `TOL` must stay below the weld grid in view units at the export scale —
  which the builder does not know (the export size is chosen later in the
  UI).
- Partial overlaps of edges (T-junctions inside a near-coincident pair) need
  the same splitting logic as `splitRing`, or the pairing misses and the
  double wall returns.
- It papers over the hole instead of filling it: the top/bottom faces still
  have a sub-weld-grid gap that only the export weld closes.

If pursued, it must be combined with a guarantee that the weld closes the
gap (e.g. also snap the paired edges to identical vertices), which makes it
close to idea 02.

## Acceptance criteria

Same gate as idea 01: `./run-pipeline.sh "export-2026-08-06 232814.svg"` →
`WATERTIGHT: PASS`, 0 non-manifold edges, volume ≈ 1379.81 mm³, Euler = 2;
`npm run typecheck` clean; `test-stl-e2e.ts` and `test-manifold.ts` pass;
`test-simple.svg` still passes.

## Constraints

- Minimal diff in `src/3d/svg-to-3d.ts` only; no commits; do not revert the
  existing uncommitted working-tree changes.
