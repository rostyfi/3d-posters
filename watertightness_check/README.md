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
     (~3 min, run 3× — the k-means palette is randomized per run) and
     checks `WATERTIGHT: PASS`, 0 non-manifold edges, 0 mis-oriented
     edges, volume ≈ 1379.81 mm³, edge histogram all-2s. (Euler V−E+F is
     informational only — the poster has legitimate hairline through-slots
     wider than the weld grid; do NOT require Euler = 2.)
   - appends a `## Result (controller)` section to the executed idea file,
   - updates the status table below,
   - if the gate fails: reviews the remaining MD files, revises or writes the
     next idea, and loops. If the gate passes: done.

## Status

| Idea | File | Status | Gate result |
|------|------|--------|-------------|
| 01 | idea-01-fill-micro-holes.md | executed, committed + pushed (`3b678b5`) | FAIL — 12 non-manifold edges (was 2) |
| 02 | idea-02-builder-vertex-weld.md | pending (fallback — no longer needed) | — |
| 03 | idea-03-weld-tolerance-reduction.md | pending (fallback — no longer needed) | — |
| 04 | idea-04-tolerant-edge-pairing.md | pending (fallback — no longer needed) | — |
| 05 | idea-05-merge-micro-holes.md | executed (subagent wt-idea-05; uncommitted in working tree) | FAIL — 4 count-4 edges (figure-eight hole walks) |
| 06 | idea-06-simple-cycle-decomposition.md | executed (subagent wt-idea-06; uncommitted in working tree) | 1 of 3 gate runs PASS (multi-edge-chain splices fail validation) |
| 07 | idea-07-generalize-splice.md | executed (subagent wt-idea-07; uncommitted in working tree) | FAIL — 6 count-4 edges (rebuild walk never applies the insert) |
| 08 | idea-08-apply-insert.md | executed (subagent wt-idea-08; uncommitted in working tree) | FAIL — 2 count-4 edges at 554.77 (37 of 44 splices fail validation) |
| 09 | idea-09-insertion-splice-pinch-tolerant-probe.md | executed (subagent wt-idea-09; uncommitted in working tree) | **PASS 3/3 — WATERTIGHT** (0 failed validation, 0 non-manifold, volume 1379.81 mm³) |

**Loop complete 2026-10-11: watertightness achieved** (gate PASS 3/3 across
randomized palettes).

Loop resumed 2026-10-11 (controller back from remote execution). Original
instruction preserved in `exploration_loop.md`. The idea-01 fix is on remote
`master` (`3b678b5`). Controller diagnosis of the 12 count-3 edges: the
idea-01 fills are sub-weld-grid slivers (e.g. 1.1e-5 mm wide vs the 1e-4 mm
weld grid) — the export weld merges vertices across them, collapsing their
faces into coincident opposite-winding pairs. Idea 05 replaced the fill with
ring surgery (merge each micro-hole into an adjacent region). Idea 05's
remaining failure: micro-holes whose boundary is a figure-eight (two holes
sharing a vertex) — the splice revisits the shared vertex, the rebuilt ring
is self-touching, validation fails, the merge is skipped. Idea 06 decomposes
traced walks into simple cycles before merging (1 of 3 gate runs now PASS).
Idea 06's remaining failure: when the host region contributes a multi-edge
chain to the hole cycle, the splice re-inserts the host's own chain vertices
→ self-touching ring → validation fails (most splices fail). Idea 07
generalizes the splice to replace the host's whole maximal chain — but its
rebuild walk never applies the insert (the detour vertices), so every merge
is a no-op and the holes persist. Idea 08 is the one-line fix: push
`sp.insert` in the rebuild walk. Idea 08's gate run then merged 7 holes but
37 of 44 splices still failed validation: the controller instrumented
`mergeMicroHoles` and ran the full pipeline in-process with a seeded RNG
(`inspect-e2e.ts`, seed 7) — the failures were (a) degenerate detours for
zero-area collinear slits (the detour retraces the chain's line and
self-touches at the junction vertex), (b) the probe rejecting pinched rings
(a vertex visited twice — two holes sharing a corner, both spliced into one
host face) that the builder handles fine via `splitRingAtRepeats` +
`resolvePointContacts`, and (c) the per-face fallback dropping a whole face's
splices when one splice broke. Idea 09 fixes all three: an insertion-splice
for the collinear m=3/k=1 cycles (split the spanning complement edge at the
chain endpoint in its owner's ring — the host's ring is untouched), a
pinch-tolerant lobe-based probe, and per-splice incremental fallback, plus a
guard skipping cycles whose complement contains host-owned edges. Gate:
PASS 3/3, failed validations 37 → 0.

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
