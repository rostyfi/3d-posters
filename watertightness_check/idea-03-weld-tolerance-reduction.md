# Idea 03 — Reduce the STL export weld tolerance below the hole width

Priority: 3 (fallback). Status: pending.

## Problem

Same as idea 01: the export weld (`WELD_TOLERANCE = 1e-4` mm in
`src/3d/stl-export.ts`, `repairFaces`) merges the two opposing walls of a
micro-hole narrower than the weld grid, creating 4-valent edges.

## The idea

Make the weld grid finer than the micro-hole width so the opposing walls stay
distinct (each wall's top edge then has exactly 2 users: 1 top face + 1
wall → manifold slit, like the holes that are already wider than the grid):

- Reduce `WELD_TOLERANCE` from 1e-4 mm to below the narrowest hole width in
  mm at the default export (the poster's hole is ≈ 3.98e-5 mm; a grid of
  ~1e-5 mm would keep it open).

## Risks (why this is priority 3)

- The weld exists to merge vertices that differ only by float32 rounding.
  float32 ULP at ~100 mm is ≈ 1.2e-5 mm, so the grid cannot go much below
  ~2e-5 mm without failing to merge rounding duplicates → boundary edges →
  non-manifold anyway.
- The hole width in mm depends on the export scale (mm per view unit =
  exportLongSide / extent). A smaller export shrinks the holes in mm and the
  weld merges them again. The fix would be export-size-dependent.
- It treats the symptom (the weld merging walls) rather than the cause (the
  hole), and leaves hairline slits in the model.

## Acceptance criteria

Same gate as idea 01: `./run-pipeline.sh "export-2026-08-06 232814.svg"` →
`WATERTIGHT: PASS`, 0 non-manifold edges, volume ≈ 1379.81 mm³;
`npm run typecheck` clean; `test-stl-e2e.ts` and `test-manifold.ts` pass
(their expected volumes assume exact welding — check they still pass);
`test-simple.svg` still passes.

## Constraints

- Minimal diff in `src/3d/stl-export.ts` only; no commits; do not revert the
  existing uncommitted working-tree changes.
