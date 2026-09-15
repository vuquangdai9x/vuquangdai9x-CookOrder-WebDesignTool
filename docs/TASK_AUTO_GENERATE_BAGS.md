# Task guide — Auto Generate queues with bag amounts

**Status:** open task. Everything else of the "bag" feature is done (see `CookingGraph.Unity/GAMEPLAY_RULES.md`
§4.1, §9.4, §10.2, §12 and `docs/ToolDesign.md` → Bags). This file is the hand-off for the one piece that
was deliberately deferred: making **Auto Generate** emit bag amounts.

## 1. What already exists (read these first)

| Thing | Where | Notes |
|---|---|---|
| Queue-string grammar `<id>[:<amount>]#effect…` | `src/core/parser.ts` (`parseQueues`, `serializeQueues`, `queueItemAmount`) | amount ≤ 1 is never written; `QueueItem.amount?: number` in `src/core/types.ts`. |
| Bag runtime behaviour | `src/core/nodeSim.ts` (`bag` cell, `reclaimBagItems`, held outputs, `gridJams`) | A bag of N lands on ONE grid cell and drains one piece at a time. Every process is now 1-in/1-out for the single-input case, so pieces = slot amount. |
| Stack range per ingredient | graph field `stackMin` / `stackMax` (`schema.json`, `nodeGraphTypes.ts`), indexed as `ix.stackRange[dense] = {min,max}` (`src/core/nodeIndex.ts`) | Pickupable leaves are 1–5, everything else 1–3 on Burger/Coffee after the migration. Validated by `INV-STACK-RANGE`. |
| Range warning | `bagsOutsideStackRange()` in `src/ui/levelpath/validateLevel.ts`; Recipe Pieces badge in `src/ui/design/queueSection.ts` | Soft warning only. The generator MUST stay inside the range so its output never warns. |
| Old-data migration | `src/data/bagMigration.ts`, lookups in `src/data/config/nodegraph/migration/` | Not the generator's concern; listed so you don't reinvent it. |
| Piece demand/supply | `nodeDemandByRaw`, `nodePickupSequence`, `leavesFor` in `src/ui/nodedesign/nodeQueueGenerate.ts`; `supplyByRaw` in `src/data/recipeDemand.ts` (already counts bag pieces) | `covers = yield × usageNum` per leaf; with 1-out processes `yield` is 1 for the migrated maps but keep the multiplication — other maps may still author `amount > 1`. |

## 2. Current generator pipeline (what to change)

```
customers ──► nodePickupSequence(ix, ids, customers)      // one dense leaf per PIECE, arrival order
           ──► generateNodeQueueLanes(opts)               // round-robin deal into lanes, then shuffle
                  lanes: number[][]  (DATA ids, one per slot)
           ──► generateLevel.ts (~line 514) / queueSection "Auto Generate" button
                  serializeQueues(lanes.map(id => ({kind:"ingredient", id, effects:[]})))
           ──► placeQueueObstacles(...)                    // src/ui/levelpath/obstacles.ts — adds effects/groups
```

Call sites of `generateNodeQueueLanes`:
- `src/ui/levelpath/generateLevel.ts` (`buildCandidate`, ~line 514) — the whole-level pipeline (Level Path Generate / Batch generate).
- `src/ui/nodedesign/index.ts` → `queueDeps.generateLanes` → `src/ui/design/queueSection.ts` Auto Generate button / `autoGenerateQueueDialog.ts`.
- Tests: `src/ui/nodedesign/queueWiring.test.ts`, `src/ui/nodedesign/nodeQueueDemand.test.ts`, `src/data/nodeSlotValidate.test.ts` ("the queue generator supplies every input"), `src/ui/levelpath/generateLevel.test.ts`.

## 3. Target behaviour

1. `generateNodeQueueLanes` returns **slots**, not bare ids: `{ id: number; amount: number }[][]` (or `QueueItem[][]`). Keep a
   thin adapter if you don't want to touch every caller at once, but the pipeline in `generateLevel.ts` must
   serialize the amount.
2. **Grouping rule:** walk the piece sequence in arrival order; consecutive pieces of the same leaf collapse into one
   slot while `amount < stackMax[leaf]`. Never emit a slot with `amount < stackMin` unless it is the leftover tail
   and no more pieces of that leaf exist (then it is fine — a leftover below `stackMin` is still a legal slot; the
   range warning only concerns designers' hand edits, but prefer padding the *previous* bag instead when that keeps
   it ≤ `stackMax`).
   - Only **pickupable** ids are queued (existing behaviour); use `ix.stackRange[dense]` for the range, default `{1,1}`.
   - Pieces are counted after `covers` (yield × usageNum), exactly as today — a bag of 3 must still cover 3 dish slots.
3. **Randomisation:** bag size should vary between `stackMin..stackMax` using the injected `random` (deterministic
   with `randomSeed`), not always `stackMax`. Suggest: pick a target size per bag uniformly in the range, then fill.
   Expose a knob in the dialog/config (`bagFill: "min" | "random" | "max"`, default `random`) so a designer can turn
   bags off for a map by choosing `min` (== 1 for leaves with `stackMin` 1).
4. **Shuffle:** `limitedDisplacementShuffle` / `curveDisplacementShuffle` operate on **slots** (a bag moves as one),
   so shuffle *after* grouping. Shuffle distance therefore means "slots", as before.
5. **Obstacles** (`placeQueueObstacles`) parse the string it receives; effects/groups attach per slot — no change needed,
   but confirm Freeze/Hidden/HoldingKey land on bag slots too (they should; bags are ordinary slots).
6. **Grid pressure:** a bag occupies a cell while it drains. The pipeline's verify step (`estimateNodeDifficulty`) already
   models this; expect more `grid-overflow`/`deadlock` verdicts on tight grids and let the seed search handle it. Do
   not raise `stackMax` to compensate — that is the designer's dial.
7. **Recipe Pieces / validation** already count pieces (`supplyByRaw`, `bagsOutsideStackRange`) — nothing to do,
   but the generated level must show `have == need` and zero range warnings.

## 4. Unity side (second half of the task) - just read but skip implement for now until I specially ask for

`CookingGraph.Unity/Runtime/Generation/IngredientQueueGenerator.cs` is the C# port of the same generator
(`PickupSequence`, `Generate`, `GenerateString`). Mirror the grouping rule using `IngredientNodeAsset.stackMin/stackMax`
and write `QueueItemData.amount`; `IngredientQueueTranslator.SerializeItem` already emits `<id>:<amount>`. Add cases
to `Tests/Runtime/GeneratorTests.cs`. Also add `amount` to `Runtime/Autoplay/CookingBotContracts.cs`
(`BotQueueItemState`) so the estimator bot sees bag sizes — that is a separate small task if the Unity runtime has not
implemented bags yet.

## 5. Suggested plan of work

1. `nodeQueueGenerate.ts`: add `groupIntoBags(sequence, ix, random, mode)` → `{ leaf, amount }[]`; change
   `generateNodeQueueLanes` to deal *bags* round-robin and return `{ id, amount }[][]`. Keep `nodePickupSequence` as is.
2. Update the two call sites to serialize `amount` (`queueItemAmount`/`serializeQueues` handle ≤1).
3. Add the `bagFill` option to `AutoGenerateQueueDialog` (Design) and the Level Path config bar / `resolveConfig` in
   `generateLevel.ts`; persist it with the other generator fields (`LevelData.designNote`-adjacent columns are in
   `src/data/csvColumns.ts`; follow how `shuffleCurve` is stored).
4. Tests: total pieces per leaf unchanged vs. today's sequence; every generated amount within
   `[stackMin, stackMax]`; deterministic under a seed; `bagFill: "min"` reproduces the pre-bag output on a graph whose
   ranges are all 1–1; obstacles still attach; a whole `generateLevel` run yields Recipe Pieces `have == need`.
5. Update `GAMEPLAY_RULES.md` (§4.1 generator note), `docs/ToolDesign.md` (Auto Generate dialog), `docs/LevelDesignProcess.md`
   if it describes the generator, and `CookingGraph.Unity/CHANGELOG.md`.
6. Re-run **Validate all** on Burger and Coffee; note verdict changes in the pipeline repo's dev-log.

## 6. Verification checklist

- `npx vitest run` — baseline has 16 known data-drift failures (nodeIndex/nodeOrder/nodeSim dirty-object & usageNum
  fixtures, levelCompression, nodeMapScan, sheetSource, gridSection, nodeQueueDemand). No new failures.
- `npm run typecheck`, `npm run mcp:typecheck`.
- Browser: Design → Auto Generate on a Burger level → tiles show `×N` badges within 1–5 for leaves, Recipe Pieces
  `have == need`, no orange (out-of-range) badges; Play the level.
- Unity tests written even if they cannot be run locally.
