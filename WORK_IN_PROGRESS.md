# WORK IN PROGRESS — watertight STL from flattened SVG regions

Branch: `feature/flatten-palette-snap`. The working tree carries the whole
flatten/manifold/watertight feature as **uncommitted changes** to
`src/main.ts`, `src/utils/svg-flatten.ts`, `src/3d/svg-to-3d.ts`,
`src/3d/stl-export.ts` — do not commit, revert, or reset them.

## Status

The transformation pipeline runs end-to-end on the real poster SVG and
produces a binary STL, but **the STL is not watertight**: 2 non-manifold
edges (each shared by 4 triangles). Root cause is identified (below); the
fix is **not yet implemented**.

## How to run the pipeline test (materialized)

```bash
./run-pipeline.sh "export-2026-08-06 232814.svg"
```

`run-pipeline.sh` bundles `run-pipeline.ts` (esbuild) and runs it with a
clean environment. `run-pipeline.ts` mirrors the app's button handlers in
`src/main.ts` with the app's default settings (index.html):

1. Simplify colors — weighted k-means to 4 colors (skipped when the source
   has ≤ target colors).
2. Flatten — `flattenSVG` (vector-native boolean flatten, palette snap).
3. Parse flattened SVG — `SVGLoader` + `calculateBoundingBox` +
   `calculateScaleFactor`.
4. `createManifoldGroupForExport` → `createScaledClone` (long side = 100 mm,
   0.2 mm/layer, all colors 1 layer) → `exportToSTLBlob` (binary).
5. Watertight check — re-reads the STL **from disk** and verifies at float32
   bit precision (what a slicer sees): every undirected edge shared by
   exactly 2 triangles, every directed edge exactly once (consistent
   winding), positive signed volume. Also prints Euler characteristic and
   bbox. Writes `<svg-name>.stl` next to the input.

Args: `./run-pipeline.sh <svg> [targetColors=4] [layerHeightMM=0.2] [exportLongSideMM=100]`.
Exit code: 0 = watertight, 1 = pipeline/check failed, 2 = timeout (10 min).
Runtime: ~3 min for the real poster (flatten ~80 s, `removeRegionOverlaps`
~60 s).

Verified on `test-simple.svg` (3 shapes, no background): PASS, 0 non-manifold
edges, volume exactly 2000.00 mm³. Note its Euler characteristic is 0, not 2:
the green rect and blue circle are tangent (point contact), which the builder
resolves into a hairline through-slot — a genuine genus-1 feature, still
manifold. Euler is informational only, not a pass criterion.

## Findings — run on `export-2026-08-06 232814.svg` (2026-10-11)

Input: VTracer SVG, viewBox `0 0 1237 1793`, 67 paths, 42 distinct fill
colors, 252 KB.

Pipeline log:

- Simplify: 42 → 4 colors (k-means is randomized; one run gave
  `#f5bf33 #1e2c3f #f6f6f2 #d1b659`).
- Flatten: 67 shapes → 33 non-overlapping regions; coverage OK
  (tiles 2217941.0 / 2217941.0 units²); ~79 s.
- `svgToRegions`: 92 regions.
- `removeRegionOverlaps`: fixed=33, rejected=0; ~60 s. Area sum afterwards:
  2217940.9901 → **9.9e-3 units² uncovered in total** (micro-holes).
- Manifold build: 60560 faces, 1 mesh; export weld removed 4
  duplicate/degenerate faces → 60556 triangles; STL 2.96 MB
  (3,027,884 bytes).
- Export size: 68.99 × 100.00 mm (portrait, long side 100 mm), z ∈ [0, 0.2].

STL check (file re-read from disk):

- 60556 triangles, 30212 unique vertices.
- Edge histogram: `{2: 90830, 4: 2}` → **2 non-manifold edges**.
- 4 mis-oriented directed edges (each direction of the 2 bad edges appears
  twice — consistent orientation, but 4-valent).
- Signed volume 1379.81 mm³ = expected 68.9905 × 100 × 0.2 ✓ (geometry and
  scale are correct; only the seam is broken).
- bbox x [0, 68.991], y [-100, 0], z [0, 0.2] mm ✓.
- Euler V−E+F = −64 (not meaningful while non-manifold edges exist).
- **WATERTIGHT: FAIL.**

### The 2 non-manifold edges

Both are the same XY edge at z = 0 and z = 0.2:
(30.9409, −32.7579) → (30.9434, −32.7518) mm, i.e. view units
(554.77, 587.349) → (554.815, 587.24), length ≈ 0.118 units. Each is shared
by 4 triangles: two top faces (regions r#5 and r#69) plus two coincident
walls with opposite normals (±(0.924, −0.382, 0)) — a **zero-thickness double
wall**.

### Root cause — a micro-hole narrower than the STL weld grid

Three regions meet at view ≈ (554.77–554.815, 587.24–587.349):

- r#5 — sliver, `#f5bf33`, area 0.458 units²
- r#49 — background, `#1e2c3f`, area 327727.8
- r#69 — `#f6f6f2`, area 107339.0

Between them is a **thin triangular hole**: (554.815, 587.24) →
(554.77, 587.349) → (554.7703, 587.3483) → close. Width 7.14e-4 units
(≈ 3.98e-5 mm), area ≈ 4.1e-5 units². Probing its centroid
(554.7926, 587.2943): covered by **no** region.

Chain of failure:

1. The hole's 3 boundary edges are unpaired in `buildManifoldGeometry`'s
   edgeMap (each belongs to a different region) → each region emits a wall
   along its edge. That is correct for a real hole.
2. The hole is **narrower than the STL weld grid**: `WELD_TOLERANCE` =
   1e-4 mm ≈ 1.79e-3 view units at a 100 mm export. `repairFaces`
   (stl-export.ts) welds vertices on that grid, so the two opposing walls
   (r#5's and r#69's) merge into one → their top and bottom edges become
   4-valent → non-manifold.

The hole exists **before** `removeRegionOverlaps` too (then a larger triangle
(554.77, 587.349), (554.77, 587.329), (554.776, 587.755), area ≈ 4e-3,
probe (554.7715, 587.4455) uncovered). The overlap-removal surgery welded
part of it (the r#5/r#49 edge now pairs exactly) but left the thin triangle.

### Origin of the hole

`flattenSVG` emits path data rounded to 3 decimals (`roundPathNumbers`).
Rounding turns sub-quantum gaps between near-coincident boundaries into
hairline **gaps** (holes). `checkFlattenCoverage` tolerates holes below
`max(canvasArea*1e-4, 64*PERTURB_EPS*perimeter)` ≈ 388 units² as "sub-pixel
noise" — harmless for area, but holes **narrower than the weld grid** break
the STL (their walls get welded into double walls). `removeRegionOverlaps`
only fixes hairline *overlaps*, not gaps.

### Global scan (near-coincident edge pairs, tol 2e-3, distinct MANIFOLD_Q-snapped keys)

7 pairs total (15041 pairs have identical snapped keys — fine):

- 1 × offset 7.14e-4 units — the failure above.
- 2 × offset 1e-3 at (795.211–795.34, 1752.561–1754.762) — 5.6e-5 mm, below
  the weld grid; did **not** produce non-manifold edges in this run (likely
  weld-cell straddling). Watch item.
- 4 × offset 2e-3 at (70.75–70.842, 1678.85–1679.725) — 1.1e-4 mm, above
  the weld grid → hairline slit (double walls that do not weld) — manifold,
  invisible, fine.

Minor: one zero-area triangle (3 distinct collinear vertices) survives
`repairFaces` (only same-cell vertex collapse is removed). It does not break
manifoldness, but some slicers dislike zero-area faces.

## Candidate fixes (not implemented)

1. **Fill micro-holes before the manifold build (preferred).** Trace
   unpaired-edge loops (holes) from the region rings — the same edgeMap the
   builder uses — and for each loop narrower than the weld grid (relative
   epsilon, e.g. `extent * 1e-6` ≈ 1.79e-3 units here, matching the 100 mm
   export weld grid), add a fill region: `new Polygon()` +
   `addFace(loopPoints)` with an adjacent region's color (or
   `HOLE_FILL_COLOR`). The hole's edges then pair exactly → no walls → clean
   manifold. Invisible (≤ 1e-4 mm). Must run after `removeRegionOverlaps`,
   before `buildManifoldGeometry` (e.g. at the top of
   `createManifoldGroupForExport`). Holes *wider* than the weld grid must be
   left alone (they are legitimate slits / artwork holes).
2. **Relative vertex weld in the builder** (coarsen `MANIFOLD_Q` or
   union-find vertices within a tolerance). Risky: can collapse genuine
   1e-3-scale features (the flatten output is 3-decimal rounded, so distinct
   vertices are often exactly 1e-3 apart) and leaves duplicate vertices in
   rings.
3. **Reduce `WELD_TOLERANCE`** below the hole width. Fragile: it must stay
   ≥ float32 ULP (~1.2e-5 mm at 100 mm) to merge rounding duplicates, and
   the hole width in mm depends on the export scale.
4. **Tolerant edge pairing in the builder** (match near-coincident edges
   within a tolerance). Dangerous: for gaps *above* the weld grid it would
   turn the current manifold slits (double walls, correct) into open cracks
   (count-1 boundary edges). Only safe paired with a guarantee that the
   weld closes the gap.

After a fix, re-run `./run-pipeline.sh "export-2026-08-06 232814.svg"` and
expect: 0 non-manifold edges, 0 mis-oriented edges, volume ≈ 1379.81 mm³,
Euler V−E+F = 2 (the poster is a full slab once the hole is filled; genuine
point-contact slots would lower it by 2 each).

## Environment notes

- `node` on the ambient PATH is broken: `LD_LIBRARY_PATH` points at a VSCode
  extension dir (`mistralai.mistral-vibe-code-1.23.0-linux-x64/bin/_internal`)
  and the system node fails with GLIBCXX errors. Run node via
  `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/rost node ...`
  (`run-pipeline.sh` does this). Node v22.22.1.
- The repo's synthetic tests (`test-stl-e2e.ts`, `test-manifold.ts`,
  `test-flatten-winding.ts`, `test-coverage.ts`) cover small synthetic SVGs;
  the real-poster failure mode (micro-holes from 3-decimal path rounding) is
  not covered by them.
- The failing STL from the run above is kept at
  `export-2026-08-06 232814.stl` (2.96 MB) for inspection.

---

## RESOLVED 2026-10-11 — watertightness achieved (exploration loop, ideas 01–09)

Final state: `./run-pipeline.sh "export-2026-08-06 232814.svg"` →
**WATERTIGHT: PASS, 3/3 runs** (the k-means palette is randomized per run):

| Run | non-manifold | mis-oriented | volume | edge histogram | Euler V−E+F |
|-----|--------------|--------------|--------|----------------|-------------|
| 1 | 0 | 0 | 1379.81 mm³ | all-2s (96942) | −6 |
| 2 | 0 | 0 | 1379.81 mm³ | all-2s (95724) | −4 |
| 3 | 0 | 0 | 1379.81 mm³ | all-2s (95208) | 0 |

Euler is informational only: the poster keeps legitimate hairline
through-slots wider than the weld grid (their walls do not weld → manifold),
so V−E+F is not required to be 2.

### The fix that landed (idea 09, in `mergeMicroHoles`, src/3d/svg-to-3d.ts)

`mergeMicroHoles` absorbs each micro-hole (a hairline gap narrower than the
STL weld grid, 1e-4 mm ≈ 1.79e-3 view units at the 100 mm export) into an
adjacent region by ring surgery, so the hole's boundary edges pair exactly in
the builder's edge map — no walls, no weld-collapsed double walls. Idea 09
fixed the three defects that made idea 08's splices fail validation (37 of
44 dropped, holes left unmerged):

1. **Insertion-splice for degenerate collinear cycles** (m === 3, k === 1,
   a chain endpoint lying strictly inside a complement edge): the cycle is a
   zero-area slit whose complement is a spike retracing the chain's line; the
   detour-splice would self-touch at the junction vertex. Instead the
   spanning complement edge is split at the chain endpoint in its OWNER's
   ring (`{ insert: [endpoint], skip: 0 }`) — the owner's new edge pairs with
   the host's chain, the host's ring is untouched. The insertion typically
   pinches the owner's ring (the endpoint visited twice); the builder's
   `splitRingAtRepeats` drops the degenerate spike lobe and keeps the main
   ring whose closing edge is K→J.
2. **Pinch-tolerant probe** (`ringAcceptable`): a rebuilt ring is accepted
   iff it has positive area and every lobe of the builder's own
   `splitRingAtRepeats` is a simple ring. Pinched rings (two holes sharing a
   corner vertex, both spliced into one host face) are accepted — the builder
   splits them into simple lobes (`splitSelfTouchingIslands`) and opens the
   point contact (`resolvePointContacts`). Crossings, collinear overlaps and
   vertex-on-edge touches are still rejected (the builder cannot handle
   those).
3. **Per-splice fallback**: a face's splices are applied one at a time
   (tentative = accepted set + next splice, kept only if acceptable), so a
   splice that genuinely breaks the ring drops only itself instead of
   dropping the whole face's splices.
4. **Guard**: cycles whose complement contains host-owned edges (the host has
   a second run in the cycle) are skipped — the detour would retrace the
   host's own edges into coincident doubled edges.

Result: `mergeMicroHoles: merged=19..42 ... 0 failed validation` across the
three gate runs (was 37 failed in idea 08).

### Iteration history (each idea diagnosed the next failure)

- idea 01 (fill micro-holes with sliver regions): FAIL — the fills are
  sub-weld-grid slivers; the weld collapses them into coincident
  opposite-winding pairs (12 count-3 edges).
- idea 05 (merge via ring surgery): FAIL — figure-eight hole walks (two
  holes sharing a vertex) splice a self-touching ring (4 count-4 edges).
- idea 06 (decompose walks into simple cycles): 1 of 3 gate runs PASS —
  multi-edge host chains re-insert the host's own chain vertices.
- idea 07 (generalize the splice to the maximal chain): FAIL — the rebuild
  walk never pushed `sp.insert` (6 count-4 edges, every merge a no-op).
- idea 08 (apply the insert, one line): FAIL — 2 count-4 edges at the
  original 554.77 spot; 37 of 44 splices fail validation (the three defects
  above, diagnosed by an instrumented in-process run, `inspect-e2e.ts`
  seed 7).
- idea 09: **PASS 3/3.**

Full per-idea write-ups: `watertightness_check/idea-01..09-*.md` (each with a
`## Result (controller)` section); loop protocol and status table:
`watertightness_check/README.md`; original loop instruction:
`watertightness_check/exploration_loop.md`.
