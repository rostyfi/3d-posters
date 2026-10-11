# Watertightness investigation — controlling-agent loop

Goal: make the SVG → STL pipeline produce a **watertight** STL for
`export-2026-08-06 232814.svg` (and in general).

## The loop

1. The controlling agent (this session) investigates and writes each idea as
   an MD file in this folder (`idea-NN-<slug>.md`), ranked by priority.
2. A subagent executes the highest-priority **not yet executed** idea.
3. When the subagent is done, the controller:
   - reviews the subagent's diff,
   - runs the fast checks (typecheck, synthetic tests),
   - runs the **gate**: `./run-pipeline.sh "export-2026-08-06 232814.svg"`
     (~3 min) and checks `WATERTIGHT: PASS`, 0 non-manifold edges,
     0 mis-oriented edges, volume ≈ 1379.81 mm³, Euler V−E+F = 2,
   - appends a `## Result (controller)` section to the executed idea file,
   - updates the status table below,
   - if the gate fails: reviews the remaining MD files, revises or writes the
     next idea, and loops. If the gate passes: done.

## Status

| Idea | File | Status | Gate result |
|------|------|--------|-------------|
| 01 | idea-01-fill-micro-holes.md | executed (subagent stopped before reporting; fix left uncommitted in the working tree) | FAIL — 12 non-manifold edges (was 2) |
| 02 | idea-02-builder-vertex-weld.md | pending | — |
| 03 | idea-03-weld-tolerance-reduction.md | pending | — |
| 04 | idea-04-tolerant-edge-pairing.md | pending | — |

Loop paused 2026-10-11: the controller teleported into remote execution and
the idea-01 subagent was stopped. Original instruction preserved in
`exploration_loop.md`. Pre-fix state committed and force-pushed to remote
`master` (`b048cf4`).

## Context

- Full findings and root-cause analysis: `../WORK_IN_PROGRESS.md`.
- Pipeline test runner: `../run-pipeline.sh` (see its header for usage).
- Failure being fixed: the poster STL has 2 non-manifold edges (4 triangles
  each) — a zero-thickness double wall created when the export vertex weld
  merges the two opposing walls of a micro-hole that is narrower than the
  weld grid (1e-4 mm ≈ 1.79e-3 view units at the default 100 mm export).
- Environment: `node` on the ambient PATH is broken (LD_LIBRARY_PATH points
  at a VSCode extension dir). Always run node via
  `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/rost node ...`
  (`run-pipeline.sh` does this itself).
- The working tree carries the whole flatten/manifold/watertight feature as
  uncommitted changes — never commit, revert, or reset them.
