# Idea 06 — Decompose hole walks into simple cycles before merging

Priority: 1. Status: pending.

## Diagnosis of the idea-05 failure (controller, seeded e2e diagnostic)

`mergeMicroHoles` works for simple hole loops (seed-7 run: merged 6 of 23
loops) but the gate still fails with count-4 double-wall edges. Both
remaining spots are micro-holes whose boundary is a **figure-eight** — two
tiny holes sharing a vertex. Example (seed 7, spot (615.0, 507.0)): 6
wall-emitting edges from r#14/r#50/r#58 form two triangles sharing vertex
B = (615.0000, 507.0000):

- lobe 1: B→D→E→B, D = (614.9800, 507.0000), E = (614.9803, 507.0000)
- lobe 2: A→B→C→A, A = (615.0100, 506.9690), C = (615.0100, 506.9691)

The loop tracer chains these into ONE closed 6-edge walk (the figure-eight).
The width check passes (w ≈ 8.7e-5 < 3.6e-3), but the splice replaces the
host's edge with the reversed remaining path — which revisits the shared
vertex B → the rebuilt ring is self-touching → `addFace`/`isValid()` fails →
the merge is silently skipped → the hole remains → both sides emit walls →
the export weld merges them → count-4 double wall.

A second, related fragility: chaining by exact `MANIFOLD_Q`-snapped keys can
dead-end when consecutive boundary edges meet at vertices that snap to
different cells (near-coincident vertices ~1e-4 apart).

## The idea

**Decompose each traced closed walk into simple cycles (split at repeated
vertices), then width-check and merge each simple cycle independently.** A
simple cycle has no repeated vertices, so the splice produces a valid simple
ring and the merge succeeds. Also chain by nearest unused outgoing edge
(within ~2e-3 units) when the exact snapped key has none, and log validation
failures so skipped merges are visible.

## Where

`src/3d/svg-to-3d.ts` only — modify `mergeMicroHoles` (the loop-tracing part).
Keep the call site in `createManifoldGroupForExport` unchanged.

## Algorithm changes (inside mergeMicroHoles)

1. **Chaining**: at each vertex, first try an unused outgoing edge at the
   exact snapped key; if none, pick the unused outgoing edge whose start is
   NEAREST to the current end, within 2e-3 units (the 3-decimal rounding
   quantum + margin). Prevents dead ends at near-coincident vertices.
2. **Decompose into simple cycles**: after a walk closes, walk its vertex
   sequence (snapped keys). If a vertex repeats at positions j < l, split the
   walk into two closed walks: edges[j..l-1] (from vj to vl, closed since
   vj == vl) and edges[l..] + edges[..j-1] (from vl around to vj). Recurse
   until no walk has a repeated vertex. Each resulting simple cycle is one
   hole loop. (The outer canvas boundary is a simple cycle — huge — never
   merged.)
3. **Per simple cycle**: measure (shoelace area, perimeter,
   w = 2*area/perimeter), apply the same width criterion
   (`w < 2 * extent * 1e-6`), pick the host (largest-area contributor),
   splice (the existing logic — correct for simple cycles), rebuild +
   validate.
4. **Log**: `mergeMicroHoles: merged=N micro-hole(s) into M region(s) (scanned K walk(s), S simple cycle(s), F failed validation)` — so skipped merges are visible.

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
   **Run the gate 3 times**: the k-means palette is randomized per run —
   the gate should pass for different palettes (idea 05 failed with
   different palettes in different ways).

## Constraints

- Minimal diff, `src/3d/svg-to-3d.ts` only (inside `mergeMicroHoles`). Match
  the existing code style.
- Do **not** commit anything. Do not touch other files.
- Report back: what you changed, key test output lines, and the gate
  result(s).

## Result (controller)

Subagent `wt-idea-06` implemented this idea faithfully (proximity chaining
fallback, `decomposeWalk` simple-cycle decomposition, per-cycle processing,
validation-failure logging; debug instrumentation removed afterwards).
`npm run typecheck` PASS, `test-stl-e2e.ts` PASS, `test-manifold.ts` PASS,
`test-simple.svg` PASS (2000.00 mm³).

Gate — 3 runs (random palettes):

| Run | mergeMicroHoles | STL check | Result |
|---|---|---|---|
| 1 | merged=3, 16 failed validation | 63576 tris, NM=0, MO=0, vol 1379.81, hist all-2s | **WATERTIGHT: PASS** |
| 2 | merged=6, 21 failed validation | 63676 tris, NM=4 (count-4), MO=8 | FAIL |
| 3 | merged=0, 44 failed validation | 60556 tris, NM=2 (count-4), MO=4 | FAIL |

**1 of 3 gate runs pass.** The decomposition works (run 1 is watertight), but
the subagent's instrumented diagnosis (since reverted) exposed the remaining
bug: **most splices fail validation** (16/19, 21/27, 44/45). Cause: when the
host region contributes a MULTI-EDGE chain to the hole cycle (e.g.
`runs=[33:2,59:1]`), the splice replaces ONE host edge with the reversed
path around the WHOLE cycle — re-inserting the host's own chain vertices
(already in its ring) → self-touching ring → `isValid()` fails → the whole
region rebuild is rejected (and one bad splice dooms the region's good ones).
The splice is only correct when the host's run in the cycle is a single edge.

Note: Euler V−E+F is not 2 in any run (−28, −26, −64) — the poster has
hairline gaps WIDER than the weld grid that are deliberately left as manifold
through-slots (each lowers Euler by 2). Euler is informational; the runner's
PASS criteria are 0 non-manifold edges, 0 mis-oriented edges, volume > 0 —
met by run 1.

→ Idea 07: generalize the splice to replace the host's maximal chain (delete
the chain's interior ring vertices, insert the reversed remaining path's
interior vertices), build the cycle's full vertex sequence from the walk
(including proximity-gap vertices, so 2-edge slit cycles work), and rebuild
per-face with fallback (drop only the offending splices).
