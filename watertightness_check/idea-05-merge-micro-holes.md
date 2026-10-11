# Idea 05 — Merge micro-holes into an adjacent region (ring surgery)

Priority: 1 (replaces idea 01's approach). Status: pending.

## Diagnosis of the idea-01 failure (controller, seeded e2e diagnostic)

The idea-01 fill (`fillMicroHoles`) is correct at the regions level — its fill
regions' edges pair exactly with their neighbors — but it creates
**sub-weld-grid sliver regions**, and the export vertex weld then mangles
them:

- The STL has 12 non-manifold edges at 2 spots. Each spot is a tiny triangle
  whose 3 edges are shared by 3 triangles: two coincident zero-area triangles
  with opposite winding plus one real triangle (at both z=0 and z=0.2).
- Both spots are corners of fill regions: r#116 (area 2.367e-5 units², a
  sliver ~2e-4 units ≈ 1.1e-5 mm wide at its hairline end) and r#119 (area
  6.6e-7 units²). The weld grid (`WELD_TOLERANCE`) is 1e-4 mm ≈ 1.79e-3 view
  units — the fills are ~100x narrower, so the weld merges vertices across
  the sliver, collapsing its top/bottom triangles into coincident
  opposite-winding pairs (count-3 edges).
- Region-level checks (seeded, self-consistent run): 0 pairwise overlaps,
  0 wall-emitting edges below 2x weld grid — the fill boundaries pair
  correctly; the problem is purely the fill regions' sub-weld-grid width.

Root cause: **any feature narrower than the weld grid gets mangled by the
export weld.** Filling a sub-weld-grid hole with a sliver region just moves
the problem (double walls → mangled sliver faces).

## The idea

**Absorb each micro-hole into an adjacent region by ring surgery** — no new
region, no sliver. The host region's ring detours around the hole, so the
hole's area becomes part of the host and the hole's other boundary edges pair
exactly with their regions. Remove `fillMicroHoles` entirely.

For a hole loop with directed edges e1 (host region H: A→B), e2 (B→C), …,
en (Z→A): replace H's ring edge A→B with the reversed remaining loop path
A→Z→…→C→B (edges en…e2 reversed in order and direction). H's ring then
encloses H + the hole; e2…en pair exactly with their regions' edges; e1
becomes interior and disappears. (The hole is always on the opposite side of
the host's edge from the host's interior, so the reversed detour bulges into
the hole — the winding works out for either loop orientation.)

## Where

`src/3d/svg-to-3d.ts` only:

- Remove `fillMicroHoles` (function + its call in
  `createManifoldGroupForExport`).
- Add `function mergeMicroHoles(regions: Region[]): number` at the same
  location, called at the same place: after `await removeRegionOverlaps(regions);`
  and before `buildManifoldGeometry(...)`.

## Algorithm

1. **Collect directed ring edges** per region face: for each region, each
   `polygon.faces` face, each edge (start→end), remembering
   (region index, face index, edge index, coordinates). Skip zero-length
   edges. Track the extent (max coordinate range) for the width threshold.
2. **Undirected edge map** keyed by `edgeKey` (MANIFOLD_Q snapped,
   direction-insensitive — the same key the builder uses). **Wall-emitting
   edges** = keys with exactly one directed edge in total (the builder walls
   exactly those: the outer canvas boundary plus every hole boundary; a key
   used twice by the same region, e.g. an earcut bridge, is paired and emits
   no wall — excluded by the same count).
3. **Trace closed loops** over the directed wall-emitting edges: chain by
   snapped endpoint key (edge a→b continues with an unused edge starting at
   b) until the loop closes. Each loop is one boundary component: the outer
   canvas boundary, or a hole.
4. **Measure each loop**: shoelace area, perimeter, width proxy
   `w = 2 * area / perimeter` (thin slit ≈ short dimension; round hole ≈
   radius). **Micro-hole**: `w < 2 * extent * 1e-6` (extent × 1e-6 is the
   STL weld grid in view units at the default 100 mm export; factor 2 is a
   safety margin). The outer boundary is huge — never merged. Holes wider
   than the threshold are legitimate slits — leave them (their walls do not
   weld → manifold).
5. **Merge each micro-hole loop**:
   a. **Host** = the loop's edge whose region has the largest area (any
      contributor works; largest is most robust).
   b. **Splice**: in the host's face ring, replace the host's directed edge
      A→B with the reversed remaining loop path (A→Z→…→C→B): insert the
      reversed path's interior vertices between A and B. Dedupe consecutive
      vertices that snapped to the same `vertKey`.
   c. **Rebuild the host's polygon**: `new Polygon()` + `addFace` per face
      (the spliced face with its new ring; all other faces unchanged) — the
      same construction `svgToRegions` uses. Validate
      (`!isEmpty() && isValid() && area() > 0`); on any failure, leave the
      host unchanged (the hole stays a manifold slit).
   d. Loops are edge-disjoint, so collect all splices per host face and
      rebuild each affected polygon once.
6. **Log**: `mergeMicroHoles: merged=N micro-hole(s) into M region(s) (scanned K boundary loop(s))`.

Why this is clean:

- The hole's area becomes part of the host — no new region, no sliver.
- The host's new ring uses the hole's other edges verbatim (exact vertices)
  → exact edge-map pairing → no walls, no double walls.
- The host's old edge becomes interior and disappears.
- No sub-weld-grid feature remains for the export weld to mangle.
- The volume change is the holes' area × height (≈ 6e-6 mm³ — negligible).

## Acceptance criteria

1. `npm run typecheck` passes (strict TS; tsconfig covers `src`).
2. Synthetic tests pass. Bundle and run them like the pipeline runner
   (node on the ambient PATH is broken — always use `env -i`):
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
4. Gate: `./run-pipeline.sh "export-2026-08-06 232814.svg"` (~3 min; run in
   background and poll the log) → `WATERTIGHT: PASS` with:
   - non-manifold edges = 0, mis-oriented edges = 0,
   - signed volume ≈ 1379.81 mm³,
   - Euler V−E+F = 2,
   - edge histogram all-2s.
   **Run the gate 2–3 times**: the k-means palette is randomized per run, so
   the gate should pass for different palettes too.

## Constraints

- Minimal diff, `src/3d/svg-to-3d.ts` only; remove `fillMicroHoles`
  completely (function + call site). Match the existing code style.
- Do **not** commit anything. Do not touch other files.
- Note: the working tree currently has a one-word uncommitted change
  (`export` on `fillMicroHoles`, added by the controller for diagnostics) —
  it disappears when the function is removed.
- Report back: what you changed (files/functions), the test outputs (key
  lines), and the gate result(s).

## Result (controller)

Subagent `wt-idea-05` implemented this idea faithfully (reviewed: the splice
logic is correct for simple loops; `fillMicroHoles` fully removed; call site
updated). The subagent got stuck after its first gate run; the controller
interrupted it and ran the gate itself.

- `npm run typecheck`: PASS (subagent's run).
- Gate run 1 (subagent, random palette): **FAIL** — 4 non-manifold edges
  (count-4, double walls) at 2 spots, 63676 triangles.
- Gate run 2 (controller, random palette): **FAIL** — 2 non-manifold edges
  (count-4, the original 554.77 double wall), 60556 triangles,
  `mergeMicroHoles: merged=0 ... (scanned 42 boundary loop(s))` — with this
  palette no loop was merged at all.
- Seeded self-consistent diagnostic (seed 7): `merged=6 ... (scanned 23)`,
  still 4 count-4 edges at 2 spots.

Diagnosis: the merge works for SIMPLE hole loops, but the remaining bad
spots are micro-holes whose boundary is a **figure-eight** — two tiny holes
sharing a vertex. Example (seed 7, spot (615.0, 507.0)): 6 wall-emitting
edges from r#14/r#50/r#58 form two triangles sharing vertex
(615.0000, 507.0000). The tracer chains them into ONE closed 6-edge walk;
the width check passes, but the splice's reversed detour revisits the shared
vertex → the rebuilt ring is self-touching → `addFace`/`isValid()` fails →
the merge is silently skipped → the hole remains → double wall → count-4.
Related fragility: chaining by exact MANIFOLD_Q-snapped keys can dead-end at
near-coincident vertices.

→ Idea 06: decompose traced walks into simple cycles (split at repeated
vertices) before merging; chain by proximity as a fallback.
