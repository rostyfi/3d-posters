# Idea 08 — Apply the detour insert in the rebuild walk (one-line fix)

Priority: 1. Status: pending.

## Diagnosis (controller, from the idea-07 result)

Idea 07's merge records every splice correctly (instrumented run: 27 splices
recorded, 0 failed validation) but the holes are never absorbed: the bad
spots persist with their edges unpaired. Code review found the bug in the
rebuild walk inside `mergeMicroHoles` (src/3d/svg-to-3d.ts):

```ts
while (advanced < n) {
  raw.push(orig[ei]);
  const sp = byEdge.get(ei);
  const step = sp ? 1 + sp.skip : 1;   // deletes the chain's interior ring vertices
  ei = (ei + step) % n;
  advanced += step;
}
```

It pushes `orig[ei]` and advances by `1 + sp.skip`, but **never pushes
`sp.insert`** — the detour vertices are computed and stored in the splice
record (`{ insert, skip }`) yet never emitted. The comment above the walk
says "emit each edge's start vertex, then the insert vertices of the splice
on that edge" — the second half was lost when the walk was restructured for
skip handling. Result: every merge merely shortcuts the host's ring across
the chain; the hole is unchanged, its edges stay unpaired, both sides emit
walls, the export weld merges them → count-4 double walls.

## The fix (one line)

In the rebuild walk, after `raw.push(orig[ei]);`, emit the splice's insert
vertices:

```ts
while (advanced < n) {
  raw.push(orig[ei]);
  const sp = byEdge.get(ei);
  if (sp) for (const p of sp.insert) raw.push(p);   // <-- add this
  const step = sp ? 1 + sp.skip : 1;
  ei = (ei + step) % n;
  advanced += step;
}
```

The walk then emits v_j, the detour's interior vertices, skips the chain's
interior ring vertices (advance by `1 + skip`), and continues at v_{j+k} —
the host's ring detours around the hole and absorbs it, and the detour's
edges pair exactly with the other regions' edges.

## Where

`src/3d/svg-to-3d.ts` only — the one line above inside `mergeMicroHoles`'s
rebuild walk. Nothing else.

## Acceptance criteria

1. `npm run typecheck` passes.
2. Synthetic tests pass (`test-stl-e2e.ts` → ALL E2E SCENARIOS PASSED;
   `test-manifold.ts` → ALL SCENARIOS PASSED; bundle + run with esbuild and
   `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/rost node ...`).
   Clean up the `.test-*.cjs` bundles afterwards.
3. `cp test-simple.svg /tmp/ && ./run-pipeline.sh /tmp/test-simple.svg`
   → `WATERTIGHT: PASS`, volume 2000.00 mm³.
4. Gate (the controller runs it): `./run-pipeline.sh "export-2026-08-06 232814.svg"`
   → `WATERTIGHT: PASS` with 0 non-manifold edges, 0 mis-oriented edges,
   volume ≈ 1379.81 mm³, edge histogram all-2s. (Euler is informational —
   do NOT require Euler = 2.)

## Constraints

- One-line diff in `src/3d/svg-to-3d.ts` only. Do not touch anything else.
- Do **not** commit anything.
- Note: the working tree currently has a one-word uncommitted change (the
  word `export` on `mergeMicroHoles`, added by the controller for
  diagnostics) — leave it or remove it, the function stays either way.
- Report back: the diff, typecheck result, synthetic test results, and
  test-simple result. (The controller runs the poster gate.)
