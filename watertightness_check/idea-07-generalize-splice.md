# Idea 07 — Generalize the merge splice to the host's maximal chain

Priority: 1. Status: pending.

## Diagnosis (from the idea-06 subagent's instrumented run + controller review)

Idea 06's decomposition works (gate run 1: WATERTIGHT: PASS), but most
splices fail validation (16/19, 21/27, 44/45 across runs). Cause: when the
host region contributes a **multi-edge chain** to the hole cycle (e.g.
`runs=[33:2,59:1]` — region 33 contributes 2 consecutive edges, region 59
one), the current splice replaces ONE host edge with the reversed path
around the WHOLE cycle. That reversed path re-inserts the host's own chain
vertices (already present in the host's ring) → self-touching ring →
flatten-js `isValid()` fails → the whole region rebuild is rejected — and
because the rebuild is per-region, one bad splice dooms the region's good
splices too. The splice is only correct when the host's run in the cycle is
a single edge.

## The idea

**Generalize the splice to replace the host's whole maximal chain.** For a
cycle with edges e_0..e_{m-1} (e_i = v_i → v_{i+1 mod m}) and the host's
maximal chain e_j..e_{j+k-1} (ring path v_j → v_{j+1} → … → v_{j+k}):

- delete the chain's interior ring vertices (v_{j+1}..v_{j+k-1}),
- insert the reversed remaining path's interior vertices
  (v_{j-1}, v_{j-2}, …, v_{j+k+1}) between v_j and v_{j+k}.

The detour's edges are the remaining cycle edges reversed → they pair
exactly with their regions; the chain's edges become interior and
disappear; the host absorbs the hole. No self-touching (the chain's own
vertices are deleted, not re-inserted).

Also:

- **Full vertex sequence from the walk**: build the cycle's vertex sequence
  as start vertex + (each edge's start if it snapped-different from the
  previous end — a proximity-gap vertex) + end, deduped by snapped key.
  The current code uses only edge start vertices, which misses gap vertices
  and mishandles 2-edge slit cycles (pts.length < 3 → skipped). With the full
  sequence, a 2-edge slit cycle (two near-coincident edges, endpoints
  snapped-different) has 4 vertices and merges like any other cycle.
- **Host pick**: among the cycle's edges whose PREVIOUS cycle edge
  (circularly) belongs to a different region (i.e. the first edge of a
  maximal run — the splice anchors at the chain's first ring edge), pick the
  largest-area region. (If every edge of the cycle belongs to one region — a
  self-hole — skip the cycle.)
- **Per-face fallback**: when rebuilding a host polygon, if a face's spliced
  ring fails (`addFace` throws / invalid), retry that face WITHOUT its
  splices (original ring) so the region's other splices survive; count the
  dropped splices as failed validation.

## Where

`src/3d/svg-to-3d.ts` only — inside `mergeMicroHoles` (the per-cycle splice
and the rebuild walk). Keep the call site and the decomposition from idea 06.

## Algorithm changes (inside mergeMicroHoles, per simple cycle)

1. **Full pts**: walk the cycle's edges in order; maintain the previous end
   point; for each edge, if its start snapped-differs from the previous end,
   push the previous end first (gap vertex), then push the edge's start; at
   the end push the last edge's end if it snapped-differs from the first
   vertex. Dedupe consecutive snapped-equal points; drop the closing
   duplicate. (For exact-match cycles this equals the current pts.)
2. **Host**: scan the cycle's edges; a candidate is an edge whose previous
   cycle edge (circularly) has a different region; among candidates pick the
   largest-area region. If none (single-region cycle), skip.
3. **Chain**: from the host edge, extend forward (circularly) while the next
   cycle edge has the host's region → run length k. The chain's ring path is
   v_j → … → v_{j+k} (k edges, k−1 interior ring vertices).
4. **Insert**: the reversed remaining path's interior vertices:
   v_{j-1}, v_{j-2}, …, v_{j+k+1} — i.e. the start vertices of the remaining
   cycle edges (e_{j-1}, e_{j-2}, …, e_{j+k}) in that order, taken from the
   full pts (which includes gap vertices).
5. **Splice record**: keyed by the host edge's ring edge index `a`:
   `{ insert: V2[], skip: k - 1 }`. The rebuild walk: at ring edge `a`, emit
   ring[a] (v_j), emit `insert`, then advance the edge index by `skip`
   (dropping the chain's interior ring vertices v_{j+1}..v_{j+k-1}), and
   continue at the edge starting at v_{j+k}.
6. **Rebuild with per-face fallback**: for each affected host polygon, for
   each face: build the spliced ring; try `addFace`; on failure, retry the
   face with its original (unspliced) ring and count the dropped splices as
   failed validation. Accept the rebuild if the polygon is non-empty, valid,
   and has positive area.
7. **Log** (unchanged format):
   `mergeMicroHoles: merged=N micro-hole(s) into M region(s) (scanned K walk(s), S simple cycle(s), F failed validation)`.

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
   - edge histogram all-2s.
   Euler V−E+F is informational (genuine hairline through-slots wider than
   the weld grid remain and lower it by 2 each — do NOT require Euler = 2).
   **Run the gate 3 times**: the k-means palette is randomized per run —
   all 3 should print WATERTIGHT: PASS.

## Constraints

- Minimal diff, `src/3d/svg-to-3d.ts` only (inside `mergeMicroHoles`). Match
  the existing code style. Remove any debug/temporary logging you add.
- Do **not** commit anything. Do not touch other files.
- Report back: what you changed, key test output lines, and the gate
  result(s). If a gate run fails, report the `mergeMicroHoles` log line and
  the STL check output — do not spin for more than ~40 minutes total.

## Result (controller)

Subagent `wt-idea-07` implemented this idea (full vertex sequence with
gap vertices, host = run-start edge with largest area, maximal-chain
splice with `{insert, skip}`, circular rebuild walk, per-face fallback).
It got stuck after implementing; the controller interrupted it and ran the
verification: typecheck PASS, `test-stl-e2e.ts` PASS, `test-manifold.ts`
PASS, `test-simple.svg` PASS (2000.00 mm³).

Gate run 1 (controller, random palette): **FAIL** — 6 count-4 edges at 3
spots, but `mergeMicroHoles: merged=27 ... (scanned 23 walk(s), 28 simple
cycle(s), 0 failed validation)` — the splices are recorded, validation
passes, yet the holes are NOT absorbed (the bad spots persist unchanged,
e.g. the (615.0, 507.0) figure-eight edges remain unpaired post-merge).

Controller's instrumented run (temporary per-cycle logging, since removed)
plus code review found the bug: **the rebuild walk never pushes
`sp.insert`** — it emits `orig[ei]`, advances by `1 + sp.skip` (deleting the
chain's interior ring vertices), but the detour vertices are never
inserted. The comment says "emit each edge's start vertex, then the insert
vertices of the splice on that edge" — the second half was lost when the
walk was restructured for skip handling in idea 07. So every merge is a
no-op (the host's ring is merely shortcut across the chain; the hole is
unchanged and its edges stay unpaired → double walls → count-4).

→ Idea 08: one-line fix — in the rebuild walk, push `sp.insert` after
`orig[ei]` when a splice is present.
