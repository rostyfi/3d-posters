# Idea 09 — Fix the mergeMicroHoles validation failures: insertion-splices for collinear slits, pinch-tolerant probe, per-splice fallback

Priority: 1 (top). Status: pending.

## Diagnosis (controller, instrumented seed-7 run of the full pipeline)

Idea 08's insert fix works (holes really are absorbed now), but the poster
gate still fails: idea-08 gate run 1 → `WATERTIGHT: FAIL`, 2 count-4 edges
at the original 554.77 spot; log `mergeMicroHoles: merged=7 ... (scanned 42
walk(s), 45 simple cycle(s), 37 failed validation)`. The controller
instrumented `mergeMicroHoles` (per-splice + per-face logs, self-intersection
classification, local ring dumps), ran the full pipeline in-process with a
seeded RNG (`inspect-e2e.ts`, seed 7, palette `#e6bb43 #35537b #f6f6f2
#090808`), and analyzed the dumps. Seed 7: 27 splices, 15 failed validation,
12 merged; the final STL has 4 non-manifold edges in 3 spots — **all three
spots are unmerged zero-area (collinear) slits** (e0 at (649.53,484.67) →
spots at P=(650.331,484.039) and K=(649.532,484.670); e1/e2 at
(615.000,507.000)). The instrumentation was removed afterwards; the file is
back to the idea-08 state.

Three distinct defects, all in `mergeMicroHoles` (src/3d/svg-to-3d.ts):

**Defect 1 — degenerate detours for zero-area (collinear) cycles.** About a
third of the micro-hole cycles are exactly collinear (width proxy w = 0, e.g.
`cyc=(649.532,484.039)-(650.331,484.670) w=0.00e+0 m=3 k=1`): the host's
chain edge and the complement path lie on ONE line — the complement is a
"spike" that runs out past the chain's start and back (its middle vertex is a
180° reversal, so the builder's `removeRedundantVertices` keeps it, and the
builder's `splitRing` misses it because its on-segment test compares the
*snapped* grid vertex against the *raw* edge — off by ~4e-5 > its 1e-6
tolerance). The detour-splice for such a cycle retraces the same line: the
rebuilt ring contains a zero-width spike whose far edge passes through the
junction vertex → a genuine self-touch/crossing (e.g. r#48 f#0:
`crossings=1 ... crossAt=(650.331,484.039)-(649.532,484.670) x
(649.525,484.675)-(649.5327,484.6694)`). `probe.isValid()` rejects it. These
holes have vertices within the STL weld grid (e.g. J,K 9.2e-4 view units ≈
5.1e-5 mm < 1e-4 mm), so leaving them unmerged keeps count-4 double walls —
they MUST be fixed, and the detour-splice cannot fix them.

**Defect 2 — the probe is stricter than the builder.** The probe requires
`probe.isValid()` = every face `isSimple` = NO self-intersection of any kind,
including vertex pinches (a ring visiting the same snapped vertex twice). But
the builder explicitly handles pinched rings: `splitSelfTouchingIslands` →
`splitRingAtRepeats` cuts the ring into simple lobes (its doc comment says
"two lobes of a merged region meeting at a point" — exactly our case), and
`resolvePointContacts` opens the resulting point contact. Two micro-holes
that share a corner vertex, both spliced into the same host face, produce
exactly such a pinch (seed 7: r#48 f#0 repeats `862.172,593.219x2` and
`584,531x2` from splice pairs e384+e381 and e1111+e1108; r#58 f#13 repeats
`577.964,523.175x2` from e856+e858) → the probe rejects → the face falls
back → **all** of the face's splices are dropped.

**Defect 3 — per-face fallback.** When one splice on a face fails validation,
the whole face falls back to its original ring, dropping every splice on it
(seed 7: r#48 f#0 lost 9 splices, r#58 f#13 lost 6 — mostly healthy ones).

Also verified: real (non-collinear) slits with w ≥ ~5e-5 view units are
manifold even when left unmerged (their walls' vertices are far apart, so the
export weld never merges them) — dropping their splices is cosmetically
imperfect but watertight. The holes that MUST be merged are the ones with
vertices inside the weld grid — precisely the degenerate collinear ones.

## The fix (all inside `mergeMicroHoles`, src/3d/svg-to-3d.ts only)

Four parts. Reuse what is already in the file: `MANIFOLD_Q`, `vertKey`,
`edgeKey`, the `Region` type, the `DEdge`/`Splice` interfaces, `Polygon` and
`point` from `@flatten-js/core`, and the module-level `splitRingAtRepeats`
(defined around line 549 — the same split the builder applies).

### Part A — insertion-splice for degenerate collinear cycles

For a cycle with `m === 3 && k === 1` (single-edge host chain J→K, two-edge
complement K→X→J), check whether a chain endpoint lies **strictly inside**
one of the complement edges (perpendicular distance ≤ 1e-6 view units and
strictly between the endpoints):

- J (the chain's start, `wallEdges[cycle[hostAt]].a`) strictly inside the
  complement's first edge `cycle[(hostAt+1)%m]` (K→X), or
- K (the chain's end, `wallEdges[cycle[hostAt]].b`) strictly inside the
  complement's second edge `cycle[(hostAt+2)%m]` (X→J).

If J is strictly inside K→X, then K, J, X are collinear and X→J also lies on
the line — the whole cycle is collinear (zero-area hole). Instead of the
detour-splice, create an **insertion-splice** on the spanning complement
edge's owner: at that edge (its `ri`, `fi`, `ei` are already recorded in the
`DEdge`), record `{ insert: [J], skip: 0 }` (or `{ insert: [K], skip: 0 }`
for the K case). The rebuild walk then splits the owner's ring edge at the
inserted endpoint: the owner's ring gains the edge K→J (or X→K + K→J), which
pairs exactly with the host's chain J→K, and the remaining new edge pairs
with the complement's other edge — **no walls, no degenerate detour, and the
host's ring is never touched**. The insertion typically makes the owner's
ring visit the endpoint twice (a pinch) — that is fine: the builder's
`splitRingAtRepeats` drops the degenerate 2-point lobe (the spike) and keeps
the main ring whose closing edge is K→J. (Verified by hand on seed 7's e0,
e1, e2, e19, e20, e1077, e1108 — all m=3 k=1 spike cases.)

If neither endpoint spans (the complement's middle vertex X lies between J
and K — a straight-through path), fall through to the detour-splice: it is a
harmless no-op there (the builder's `removeRedundantVertices` drops the
collinear detour vertex and the complement vertex, restoring the chain and
pairing it) — do NOT skip these cycles.

Concrete sketch (place right after the chain `k` is computed and before the
detour `insert` is built):

```ts
const onSegStrict = (p: V2, a: V2, b: V2): boolean => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return false;
  const px = p.x - a.x, py = p.y - a.y;
  if (Math.abs(dx * py - dy * px) > 1e-6 * Math.sqrt(len2)) return false;
  const t = (dx * px + dy * py) / len2;
  return t > 1e-12 && t < 1 - 1e-12;
};
if (m === 3 && k === 1) {
  const chainE = wallEdges[cycle[hostAt]];
  const comp1 = wallEdges[cycle[(hostAt + 1) % m]];
  const comp2 = wallEdges[cycle[(hostAt + 2) % m]];
  const J = { x: chainE.ax, y: chainE.ay };
  const K = { x: chainE.bx, y: chainE.by };
  let target: { e: DEdge; pt: V2 } | null = null;
  if (onSegStrict(J, { x: comp1.ax, y: comp1.ay }, { x: comp1.bx, y: comp1.by })) {
    target = { e: comp1, pt: J };
  } else if (onSegStrict(K, { x: comp2.ax, y: comp2.ay }, { x: comp2.bx, y: comp2.by })) {
    target = { e: comp2, pt: K };
  }
  if (target) {
    let byFace = splices.get(target.e.ri);
    if (!byFace) { byFace = new Map(); splices.set(target.e.ri, byFace); }
    let byEdge = byFace.get(target.e.fi);
    if (!byEdge) { byEdge = new Map(); byFace.set(target.e.fi, byEdge); }
    byEdge.set(target.e.ei, { insert: [target.pt], skip: 0 });
    splicedLoops.set(target.e.ri, (splicedLoops.get(target.e.ri) || 0) + 1);
    continue; // this cycle is handled by the insertion-splice
  }
}
```

### Part B — guard: skip cycles whose complement contains host edges

The detour reuses the complement's edges verbatim (reversed). If the host has
a second run inside the same cycle, the complement contains the host's own
edges and the detour would retrace them — coincident doubled edges in the
rebuilt ring. Skip such cycles entirely (before both splice kinds):

```ts
let compHasHost = false;
for (let ci = 0; ci < m; ci++) {
  if (ci >= hostAt && ci < hostAt + k) continue; // the chain itself
  if (wallEdges[cycle[ci]].ri === host.ri) { compHasHost = true; break; }
}
if (compHasHost) continue;
```

(Place after `host`/`k` are known, before Part A.)

### Part C — pinch-tolerant probe (lobe-based)

Replace the per-face probe

```ts
const probe = new Polygon();
try {
  probe.addFace(ring.map((p) => point(p.x, p.y)));
  faceOk = !probe.isEmpty() && probe.isValid() && probe.area() > 0;
} catch { faceOk = false; }
```

with a check that mirrors what the builder can actually handle — split the
ring at repeated snapped vertices (the builder's own `splitRingAtRepeats`)
and require every lobe to be a simple ring:

```ts
const ringAcceptable = (ring: V2[]): boolean => {
  const probe = new Polygon();
  try {
    probe.addFace(ring.map((p) => point(p.x, p.y)));
  } catch { return false; }
  if (probe.isEmpty() || probe.area() <= 0) return false;
  for (const lobe of splitRingAtRepeats(ring)) {
    const lp = new Polygon();
    try {
      lp.addFace(lobe.map((p) => point(p.x, p.y)));
    } catch { return false; }
    if (lp.isEmpty() || !lp.isValid()) return false;
  }
  return true;
};
```

Rationale: pinched rings (a vertex visited twice) are ACCEPTED — the builder
splits them into simple lobes (`splitSelfTouchingIslands`) and opens the point
contact (`resolvePointContacts`). Proper edge crossings, collinear overlaps
and vertex-on-edge touches still fail (the lobe containing them stays
non-simple) — the builder cannot handle those, so rejecting them is correct.
Define `ringAcceptable` as a local function inside `mergeMicroHoles` (it
needs `splitRingAtRepeats`, `Polygon`, `point`).

### Part D — per-splice fallback (incremental application)

Currently the face's splices are applied in one circular walk and validated
once; on failure the whole face falls back to its original ring. Instead,
factor the circular walk into a local helper

```ts
const rebuildRing = (orig: V2[], byEdge: Map<number, Splice>): V2[] => {
  // ... the existing covered/start/walk/dedupe logic, verbatim ...
};
```

and apply the face's splices one at a time: tentatively rebuild with the
accepted set plus the next splice, keep it only if `ringAcceptable`:

```ts
let ring = orig;
let droppedHere = 0;
if (byEdge) {
  let accepted = new Map<number, Splice>();
  for (const [ei, sp] of byEdge) {
    const tentative = new Map(accepted);
    tentative.set(ei, sp);
    const cand = rebuildRing(orig, tentative);
    if (ringAcceptable(cand)) { accepted = tentative; ring = cand; }
    else droppedHere++;
  }
}
try { next.addFace(ring.map((p) => point(p.x, p.y))); }
catch { ok = false; break; }
```

A splice whose detour genuinely breaks the ring drops only itself; the face's
other splices survive. `droppedHere` feeds the existing `dropped` counter
(replacing `dropped += nSplices` in the old fallback branch — that branch
disappears).

Also relax the final per-region acceptance: the rebuilt polygon may contain
pinched faces, so `next.isValid()` must go. Change

```ts
if (ok && !next.isEmpty() && next.isValid() && next.area() > 0) {
```

to

```ts
if (ok && !next.isEmpty() && next.area() > 0) {
```

(Each spliced face was already validated by `ringAcceptable`; unspliced faces
are unchanged from the original polygon.)

Keep the final log line's prefix stable for the controller's parsing:
`mergeMicroHoles: merged=N micro-hole(s) into R region(s) (scanned K walk(s),
S simple cycle(s), F failed validation)` — optionally add an insertion count,
e.g. `... (I insertion-splice(s), scanned ...)`.

## Why this is safe

- The insertion-splice only fires when a chain endpoint lies on a complement
  edge (≤1e-6 off) — which forces the whole m=3 cycle to be collinear, i.e.
  a zero-area hole. Pairing its edges closes it with no gap and no visible
  geometry change; the host's ring is untouched.
- The pinch tolerance matches the builder's designed behavior
  (`splitRingAtRepeats` + `resolvePointContacts`); crossings/overlaps/touches
  are still rejected.
- Real slits wider than the weld grid stay manifold whether or not their
  splice survives; the weld-grid-critical holes (collinear ones) are now
  fixed by the insertion-splice, which cannot fail validation the way the
  degenerate detour did.
- The guard only skips pathological cycles (host with two runs in one
  cycle) that the detour-splice could not fix anyway.

## Acceptance criteria

1. `npm run typecheck` passes (strict TS; tsconfig covers `src`).
2. Synthetic tests still pass. Bundle and run them exactly like the
   pipeline runner does (node on the ambient PATH is broken — always use
   `env -i`):
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
4. Gate (the controller runs it 3× — the palette is randomized):
   `./run-pipeline.sh "export-2026-08-06 232814.svg"` → `WATERTIGHT: PASS`
   with 0 non-manifold edges, 0 mis-oriented edges, volume ≈ 1379.81 mm³,
   edge histogram all-2s. (Euler is informational — do NOT require Euler = 2.)
5. The `mergeMicroHoles` log should show far fewer failed validations than
   idea 08's 37 (ideally the failed count only covers genuinely unfixable
   splices).

## Constraints

- Minimal diff, `src/3d/svg-to-3d.ts` only (all changes inside or immediately
  adjacent to `mergeMicroHoles`; `splitRingAtRepeats` is already module-level
  and must NOT be moved or modified). Match the existing code style.
- Do **not** commit anything. Do not revert or modify the existing
  uncommitted working-tree changes beyond this fix.
- Do not touch `src/3d/stl-export.ts`, `src/utils/svg-flatten.ts`,
  `src/main.ts`.
- The working tree currently has a one-word uncommitted change (the word
  `export` on `mergeMicroHoles`, added by the controller for diagnostics) —
  leave it or remove it, the function stays either way.
- Report back: what you changed (files/functions), the diff summary, the
  test outputs (key lines: typecheck, both synthetic tests, test-simple,
  and the `mergeMicroHoles:` log line from the test-simple run). The
  controller runs the poster gate.

## Result (controller)

Executed by subagent `wt-idea-09`. All four parts implemented as specified
(guard, insertion-splice via `onSegStrict`, lobe-based `ringAcceptable` using
`splitRingAtRepeats`, factored `rebuildRing` + incremental per-splice
fallback, final acceptance without `next.isValid()`); log line format
unchanged. Controller re-ran the fast checks independently:

- `npm run typecheck` — PASS.
- `test-stl-e2e.ts` — ALL E2E SCENARIOS PASSED.
- `test-manifold.ts` — ALL SCENARIOS PASSED.
- `./run-pipeline.sh /tmp/test-simple.svg` — WATERTIGHT: PASS, volume
  2000.00 mm³, histogram `{"2":360}`, 0 non-manifold, 0 mis-oriented.

Poster gate (3 runs — the k-means palette is randomized per run):

| Run | mergeMicroHoles log | non-manifold | mis-oriented | volume | histogram | Euler | verdict |
|-----|--------------------|--------------|--------------|--------|-----------|-------|---------|
| 1 | merged=42 into 13 regions (40 walks, 43 cycles, **0 failed validation**) | 0 | 0 | 1379.81 mm³ | all-2s (96942) | −6 | **WATERTIGHT: PASS** |
| 2 | merged=30 into 9 regions (29 walks, 31 cycles, **0 failed validation**) | 0 | 0 | 1379.81 mm³ | all-2s (95724) | −4 | **WATERTIGHT: PASS** |
| 3 | merged=19 into 6 regions (19 walks, 20 cycles, **0 failed validation**) | 0 | 0 | 1379.81 mm³ | all-2s (95208) | 0 | **WATERTIGHT: PASS** |

Failed validations dropped from 37 (idea 08) to **0** in every run; the
merged count varies with the palette (19–42 holes) as expected. Euler V−E+F
is informational only (legitimate hairline through-slots wider than the
weld grid; observed −6…0 across runs) — not required to be 2.

**Gate: PASS 3/3 — watertightness achieved.** The exploration loop is
complete; ideas 02–04 (fallbacks) are no longer needed.
