# Session Changelog — Behavior Modes

Date: 2026-09-15

## Summary

This session added shared raw-packing and tool-processing behavior controls to Play mode and the Difficulty Estimator. The selected pair persists across browser refreshes and is used consistently by live play, estimator simulations, fallback planning, caching, and estimate replay.

The defaults are now:

- Packing mode behavior: **Unpacked raw**
- Tool process behavior: **Auto**

An existing saved browser preference still takes priority over these defaults.

## Play mode

- Replaced the former **When tool is full** dropdown with two behavior dropdowns:
  - **Packing raw / Unpacked raw**
  - **Auto / Wait-order**
- Raw ingredients now always use **Park raw on grid** when they cannot enter a tool.
- Changing either dropdown restarts the current level so state from different behavior rules cannot mix.
- Both dropdown selections are stored in browser local storage and restored after refresh.

### Unpacked raw

- A queue amount expands into separate physical items.
- At most one item can fly directly into an available tool slot; remaining items each require a grid cell.
- The pick is blocked atomically when there are not enough destinations for every expanded item.
- `multipleUsage` ingredients also expand into separate items, each with usage amount `1`; no bag is created.
- Every expanded item flies from the originally picked queue slot.
- Group flight animations launch with a 24 ms stagger, approximately 1–2 frames at 60 FPS.

### Wait-order

- A process starts only when a currently active customer order specifically needs its output path.
- Demand already satisfied or claimed by an in-flight matching ingredient does not authorize duplicate processing.
- A picked unmatched single ingredient parks on the grid.
- In Packing raw mode, unmatched amount ingredients remain in their bag until valid demand appears.

## Difficulty Estimator

- Added the same two dropdowns to the **Scoring Scenario** dialog.
- The dialog reads and updates the same persisted selection used by Play mode.
- Every estimator attempt and learned fallback planner receives the selected behavior configuration.
- Estimator simulations use **Park raw on grid**, matching Play mode.
- Cache identity includes non-default behavior selections to prevent results from one mode being reused for another.
- Estimate results record their behavior modes, and replay remains bound to the modes that generated its steps.

## Validation

- TypeScript typecheck passed.
- Production build passed.
- Focused behavior, persistence, estimator, cache, Wait-order, and Unpacked raw tests passed.
- The full suite completed with 842 passing tests and the same 11 pre-existing fixture/data failures present before the estimator follow-up.
