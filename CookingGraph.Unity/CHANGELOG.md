# Changelog

## 0.2.0

- Added `CookingEstimatorBot`, an online Unity runtime port of the web estimator's demand scoring.
- Added snapshot and command interfaces covering visible queue status, authoritative pickupables,
  grid and in-flight/tool commitments, active customer orders, and preview orders.
- Picks are revision-checked and reserved per item, allowing another legal queue to be picked while
  earlier visual flights are still animating without duplicate commands or double-ordering supply.
- Added runtime tests for base priority, queue lookahead, stale snapshots, and overlapping animations.
- Added a complete game-system integration guide for adapters, logical/visual state separation,
  atomic command handling, lifecycle, diagnostics, and integration tests.
- Added first-class Save Me bag contents to bot snapshots. Bag units satisfy demand before queue
  scoring and transfer exactly once into committed supply when their exit animation begins.
- Fixed the bot accepting frozen ingredients from a stale/incorrect `pickupables` list. Frozen,
  locked, or departing leaders and combined/linked members are now filtered by visible status.
- Added the `CookingBotPickingStrategy` enum and live `SetPickingStrategy` API with Balanced,
  GridSafe, FrontLoaded, FinishFirst, ChainFirst, ScarcityFirst, and NoPreview presets.
- Added live `intelligent` control from 0 (fully random legal picks) to 1 (fully strategic), with
  runtime switching on the next tick and decision/command telemetry.

## 0.1.2

- Added `GridLayoutTranslator`, completing the set of three level-string translators. It parses and
  serializes the prep-grid string, and its graph overload checks the cell count against the map's
  `gridWidth * gridHeight`, fills in the grid shape (`CellAt(x, y)`), and resolves Ingredient-slot
  cells through the ingredient id table.
- Added `CellStatusId` for the cell-type ids a grid string carries.

## 0.1.1

- Preservation slots are now a first-class part of the package: the `preservation` edge kind, the
  tool's `preservationSlots` field, `CookingGraphAsset.preservationEdges`, and
  `CookingGraphPreservation` for resolving a wired ingredient or group into the concrete set a
  tool's buffer accepts.
- Graph validation checks that a tool's buffer size and its preservation wiring agree, and that a
  tool takes at most one preservation edge.
- Added the schema fields the web editor already writes: `imageURL` on ingredient/tool/dirty nodes
  and `emoji` on composites. As before, artwork fields stay in the JSON and out of runtime assets
  and sync fingerprints.
- Deleting a node now also removes preservation edges that referenced it.
- Fixed the Editor test assembly failing to compile (`JToken` has no `Add`).
- Added GAMEPLAY_RULES.md — the full cooking-graph and play-mode simulation specification.

## 0.1.0

- Initial graph editor, translators, runtime assets, and synchronization workflow.
