# Estimator Bot Integration Guide

`CookingEstimatorBot` is an online autoplay controller for the CookOrder gameplay runtime. It uses
the same demand-oriented scoring model as the web difficulty estimator, but it replans from the
game's current authoritative state before every pick.

The bot does not own the gameplay simulation or move scene objects. It can use logical tool/merge
activity as a non-blocking decision barrier; your game provides two small adapters:

- `ICookingBotStateReader` builds a consistent `BotGameState` snapshot.
- `ICookingBotCommandSink` validates and commits one queue pick.

The intended data flow is:

```text
gameplay model -> ICookingBotStateReader -> CookingEstimatorBot
       ^                                      |
       |                                      v
animation/view <- committed logical pick <- ICookingBotCommandSink
```

## 1. Create and run the bot

Create one bot for the current level. Call `Init` at the start of every level, including another
level on the same map; this clears pending item reservations and resets deterministic tie-breaking.

```csharp
private CookingEstimatorBot _bot;

void StartLevel(CookingGraphAsset graph)
{
    _bot = new CookingEstimatorBot(gameBotStateReader, gameBotCommandSink);
    _bot.Init(graph);
}

void Update()
{
    if (autoPlayEnabled)
        _bot.Tick(); // At most one accepted logical pick per call.
}
```

Calling `Tick` every frame is valid. The bot itself enforces `pickIntervalSeconds` against the
snapshot's gameplay clock, so an extra tap scheduler is optional. When a work-wait strategy is
active, keep calling `Tick`; it returns `false` until the reported tool and merge counts reach zero.

Do not call `Tick` recursively from a gameplay `StateChanged` callback. Let the current call return
and schedule the next decision for the next frame or scheduler pulse.

## 2. Implement the state reader

`ReadState` must return one internally consistent snapshot from the authoritative gameplay model,
not from animated transforms or view objects. Do not mutate or recycle its lists until `Tick`
returns.

```csharp
public sealed class GameBotBridge : MonoBehaviour,
    ICookingBotStateReader,
    ICookingBotCommandSink
{
    [SerializeField] private CookingGraphAsset graph;

    private CookingEstimatorBot _bot;

    private void Awake()
    {
        _bot = new CookingEstimatorBot(this, this);
        _bot.Init(graph);
    }

    private void Update()
    {
        if (GameSession.IsPlaying && GameSession.AutoPlayEnabled)
            _bot.Tick();
    }

    public BotGameState ReadState()
    {
        var result = new BotGameState
        {
            revision = GameSession.Revision,
            gameplayTimeSeconds = GameSession.GameplayTime,
            isPlaying = GameSession.IsPlaying,
            activeToolProcessCount = GameSession.ProgressableToolJobs.Count,
            activeMergeAnimationCount = GameSession.LogicalMergeTransitions.Count
        };

        // Adapt the sections described below from your logical game model.
        AddVisibleQueues(result);
        AddPickupableActions(result);
        AddGrid(result);
        AddSaveMeBag(result);
        AddCommittedIngredients(result);
        AddActiveOrders(result);
        AddPreviewOrders(result);
        return result;
    }

    public bool TryPick(BotPickCommand command)
    {
        // See section 4 for the required atomic validation/commit sequence.
        return TryCommitBotPick(command);
    }
}
```

`GameSession` and the helper methods above are placeholders for your game systems. The important
part is which logical data each helper supplies.

`gameplayTimeSeconds` must be a monotonic level clock that advances only while gameplay is running.
It lets the bot enforce its pick cadence consistently across variable frame rates and pauses.

`activeToolProcessCount` includes only jobs that can complete through passage of gameplay time. A
partial multi-input tool that needs another queue ingredient is not active; counting it would
deadlock the bot before it can pick the missing input. `activeMergeAnimationCount` includes
merge/combine transitions whose completion still changes logical routing, serving, or capacity.
Do not include queue departure tweens, particles, customer reactions, or a merge tween whose
logical result was already committed.

### Visible queues

Create one `BotQueueLaneState` per game queue, preserving queue indices. `items` is front-first and
contains only rows visible to the player.

For every item:

| Field | Game mapping |
|---|---|
| `itemId` | Stable, unique id for this item instance. Never derive identity from row/index alone. |
| `kind` | `Ingredient` or `Sweeper`. |
| `ingredient` | The graph's `IngredientNodeAsset`; use `null` when a hidden row must not reveal its identity. |
| `status` | `Ready`, `Hidden`, `Frozen`, `Locked`, or `Departing`. |

An accepted item may remain in the visible list as `Departing` while its tween runs. The scorer
ignores it as queue supply.

### Pickupable actions

`BotGameState.pickupables` is authoritative. Add an option only when the game would accept that
queue click at the snapshot revision. This list, rather than `BotQueueItemStatus.Ready`, decides
whether the bot may issue a command. As defense in depth, the bot also rejects an option when its
leader or any listed combined/linked member has visible status `Frozen`, `Locked`, or `Departing`,
even if a buggy or one-frame-stale adapter included that option. `Hidden` remains eligible when the
game lists it as pickupable, allowing the same deliberate gamble as gameplay.

For a normal item, set:

```csharp
result.pickupables.Add(new BotPickupOption
{
    queueIndex = queue.Index,
    itemId = front.InstanceId,
    ingredients = new List<IngredientNodeAsset> { front.Ingredient },
    footprint = predictedGridFootprint
});
```

For a combined or linked pickup, `itemId` is the clicked/leading item, while `consumedItemIds` and
`ingredients` contain every item consumed by that one atomic click:

```csharp
result.pickupables.Add(new BotPickupOption
{
    queueIndex = clickedQueueIndex,
    itemId = leader.InstanceId,
    consumedItemIds = group.Items.Select(item => item.InstanceId).ToList(),
    ingredients = group.Items.Select(item => item.Ingredient).ToList(),
    footprint = group.PredictedGridFootprint
});
```

Set `picksSweeper = true` for a sweeper action. `footprint = 0` lets the bot derive ingredient
footprint from graph recipe yields; provide the real footprint when game-specific routing knows it
more accurately.

Do not expose an action when any member is frozen/locked, a linked member has not reached the front,
a destination tool/preservation slot is full, or the current out-of-slot policy would reject it.

### Grid

Add every logical grid position to `grid.cells`, including blocked or locked positions:

| `kind` | Required data |
|---|---|
| `Empty` | Set `canHoldItem = false` if the empty-looking cell is blocked/locked. |
| `Raw` | Set `ingredient`. It is expanded through the graph when calculating committed supply. |
| `Cooked` | Set `ingredient` and `usesLeft`. |
| `Dirty` | Set `dirtyCount` when available. |
| `Backpack` | Marks the bag's occupied grid cell. Prefer the first-class `saveMeBag` field for contents. |

Do not also add grid contents to `committedIngredients`; that would count the same supply twice.

### Save Me bag

The autoplay bot never activates Save Me. Normal solve attempts use only ordinary legal queue
picks; reserve the Save Me action for a separate economy estimate (for example, expected booster
cost after a failed no-rescue run). The fields below are read-only state integration: if the host
game has already created a bag, the bot must know its contents so it does not repurchase duplicate
ingredients.

When a Save Me backpack exists, set `BotGameState.saveMeBag` and expose every unit the bot is
allowed to know. The bag is already-owned supply, so the scorer satisfies order demand from it
before valuing another queue pickup:

```csharp
result.saveMeBag = new BotSaveMeBagState
{
    bagId = backpack.InstanceId,
    items = backpack.Items.Select((item, index) => new BotSaveMeBagItemState
    {
        itemId = item.InstanceId,
        ingredient = item.Ingredient
    }).ToList()
};
```

Follow the web Save Me representation: one list entry is one usable ingredient unit. If a cooked
grid item entered the bag with `usesLeft = 3`, expose three bag entries for that ingredient. Raw
items retain their raw ingredient asset, so the graph scorer can trace them through their remaining
tool chain.

The grid must still contain one `BotGridItemKind.Backpack` cell because the bag occupies space. When
`saveMeBag` is non-null, the scorer ignores the legacy `BotGridCellState.ingredients` list on that
cell, preventing the contents from being counted twice. For older adapters, leaving `saveMeBag`
null and putting the units in the Backpack cell's `ingredients` list remains supported.

When a bag unit starts an automatic bag-to-tool or bag-to-customer flight, remove it from
`saveMeBag.items`, add the flight to `committedIngredients`, and increment `revision` atomically.
The ingredient remains counted exactly once throughout the animation.

### In-flight and tool commitments

`committedIngredients` contains every ingredient already owned by the player but not represented by
a raw/backpack grid cell. Include items in:

- queue-to-tool flights;
- bag-to-tool and bag-to-customer flights after the item leaves `saveMeBag`;
- preservation buffers;
- tool input slots;
- active cooking jobs;
- intermediate chain-tool flights;
- tool-to-grid flights.

Create the commitment at the exact moment the queue pick is logically accepted—not when its
animation arrives:

```csharp
result.committedIngredients.Add(new BotCommittedIngredientState
{
    ingredient = flight.Ingredient,
    amount = flight.Amount,
    sourceItemId = flight.SourceQueueItemId
});
```

This is essential for correct overlapping picks. Without it, the bot sees an ingredient flying on
screen as missing and may pick another copy for the same order.

### Active customer orders

Add customers currently eligible to receive food to `customerOrders`, in service priority order.
For every exact dish slot, provide:

- `ingredient`: the required produced ingredient;
- `filled`: whether that slot has already been served;
- `isBase`: whether this is the dish/composite base;
- `gateOpen`: whether this slot may be served now.

Set `isStaff = true` for staff customers. The scorer ignores their food demand.

### Preview orders

Add upcoming customers to `previewOrders`, in arrival order. Each preview exposes only its
`CompositeNodeAsset` dish types. The bot expands their possible graph slots at low confidence, like
the web estimator, without pretending to know exact hidden topping choices.

The scorer uses at most the first three previews.

## 3. Revision and item identity contract

`BotGameState.revision` is a monotonically increasing logical-state version. Increment it whenever
a change can affect legality or scoring, including:

- accepting a queue pick;
- queue shifting, thawing, unlocking, hiding, or revealing;
- a tool slot becoming occupied/free;
- a cooking or flight state transition;
- a grid item landing, serving, or becoming dirty;
- active or preview customers changing.

The bot sends both `observedRevision` and `expectedItemId`. The command sink must reject a command
if either no longer matches. Queue index alone is not identity because another item may shift into
that index before the command is applied.

## 4. Commit a pick atomically

`ICookingBotCommandSink.TryPick` runs on the gameplay thread. It should follow this order:

1. Confirm the level is still playing.
2. Require `command.observedRevision == currentRevision`.
3. Resolve `command.queueIndex` and verify its current clicked/front item has
   `command.expectedItemId`.
4. Re-run the game's normal `CanPick` validation. Never give the bot a privileged pick path.
5. Atomically remove/reserve every affected queue item, create its logical in-flight/tool
   commitment, apply immediate queue/group effects, and increment the revision.
6. Start visual animations from the committed logical result.
7. Return `true`.

Return `false` without changing state when any validation fails. A rejection is normal—the bot will
read a fresh snapshot and replan on its next `Tick`.

Conceptual implementation:

```csharp
public bool TryPick(BotPickCommand command)
{
    if (!GameSession.IsPlaying) return false;
    if (command.observedRevision != GameSession.Revision) return false;

    var queue = GameSession.Queues.ElementAtOrDefault(command.queueIndex);
    if (queue == null || queue.ClickTarget.InstanceId != command.expectedItemId) return false;
    if (!GameSession.CanPick(queue)) return false;

    // CommitPick changes authoritative state and Revision before it starts/queues presentation.
    var committedPick = GameSession.CommitPick(queue);
    GamePresentation.Animate(committedPick);
    return true;
}
```

## 5. Pick cadence and work-settling strategies

`pickIntervalSeconds` always sets the earliest gameplay time for the next accepted pick. A separate
`CookingBotWorkWaitStrategy` decides whether active tool processing and logical merge transitions
must also finish. Treat each accepted pickup as a logical transaction whose presentation can finish
later:

| Time | Logical state | Visual state | Bot action |
|---|---|---|---|
| Frame 100, rev 41 | Queue A and B are pickupable | Idle | Bot chooses A. |
| Same frame, rev 42 | A is removed/reserved and its ingredient is committed | A begins flying | Sink returns `true`. |
| Before cadence expires, rev 42 | B remains pickupable; A is already counted as supply | A is still flying | Bot waits, even if `Tick` is called. |
| Cadence expires, rev 42 | B remains pickupable; A is already counted as supply | A may still be flying | Interval-only may choose B; wait-for-work checks tool/merge counts. |
| Later | A moves between tool/grid states without duplicating supply | A animation arrives | No wait or special bot callback is needed. |

The default cadence is 1 gameplay second and can be configured or changed at runtime:

```csharp
var settings = new EstimatorBotSettings
{
    pickIntervalSeconds = 0.5f,
    workWaitStrategy = CookingBotWorkWaitStrategy.Adaptive
};
var bot = new CookingEstimatorBot(reader, sink, settings);

// Recalculate the current cooldown and use 0.25 seconds for later picks.
bot.SetPickIntervalSeconds(0.25f);

// The next Tick will additionally wait for active tool and logical merge work.
bot.SetWorkWaitStrategy(CookingBotWorkWaitStrategy.WaitForToolAndMerge);
```

The setter is live: it recalculates the current deadline from the last accepted pick, so no
reinitialization is required. The work strategy setter is also live and affects the next tick.

| Work strategy | Behaviour after the interval expires |
|---|---|
| `Adaptive` | First run overlaps work; a retry initialized with non-timeout failure knowledge waits for tool and merge work. |
| `IntervalOnly` | May pick while tool/merge work continues, subject to legality and capacity. |
| `WaitForToolAndMerge` | Returns `false` until both active counts are zero, then replans from the fresh snapshot. |

This is a non-blocking barrier: never await a coroutine inside `Tick`, and never stop scheduling it.
`IsWaitingForWorkCompletion` identifies this case. Unrelated presentation animation can continue in
every mode. After the barrier, the bot also projects occupied cells, committed ingredients, and the
candidate footprint. It defers only when those eventual outputs exceed safe capacity. Inspect
`IsWaitingForGridCapacity`, `LastDecision.projectedGridLoad`, and
`LastDecision.usableGridCapacity` when diagnosing a false `Tick()` result.

The projection evaluates committed and candidate ingredients together through the graph. For
example, a committed coffee bean/ground coffee and a newly selected cup become one coffee-machine
output, rather than two independent future grid items. This prevents a full-grid deadlock where
the bot used to reject the exact complementary input needed to drain Map 2's multi-input tools.
Explicit `BotPickupOption.footprint` values are still honored for game-specific linked pickups.

Use per-action legality in `pickupables`. For example, a queue whose destination tool is full may be
temporarily absent while another queue remains available. Avoid conditions such as
`if (AnyAnimationRunning) return no pickupables;` because that recreates the global wait the bot is
designed to avoid.

`CookingEstimatorBot` also keeps short-lived reservations for accepted item ids. They protect
against a bridge that returns the previous snapshot for one frame. Reservations are reconciled
after the revision advances and the accepted ids disappear from `pickupables`; they are a race
guard, not a substitute for immediate authoritative state updates.

## 6. Lifecycle and pause handling

- Call `Init(graph)` once at every level start/restart.
- Set `isPlaying = false`, or stop calling `Tick`, while paused or after win/loss.
- Do not reuse item instance ids after restarting a level.
- Keep all bot calls on Unity's main thread because snapshots contain `ScriptableObject` references.
- To disable autoplay, stop scheduling `Tick`; do not destroy in-flight logical commitments.

## 7. Tuning and diagnostics

### Listen to verbose runtime decisions

Verbose logging is disabled by default. Implement `ICookingBotVerboseLogListener`, register it, and
enable it whenever you need a decision trace. The bot sends records synchronously from the thread
that calls `Tick`, so the listener should do little work and queue expensive serialization or
telemetry for later.

```csharp
public sealed class BotLogListener : ICookingBotVerboseLogListener
{
    public void OnCookingBotVerboseLog(CookingBotVerboseLog entry)
    {
        Debug.Log($"[CookingBot] {entry.kind}: {entry.message} " +
                  $"rev={entry.revision} queue={entry.queueIndex} item={entry.itemId} " +
                  $"score={entry.score} pending={entry.pendingPickCount}");
    }
}

var listener = new BotLogListener();
bot.SetVerboseLogging(true, listener);

// This takes effect immediately; later ticks allocate and emit no log records.
bot.SetVerboseLogging(false);

// The listener can also be replaced or cleared independently.
bot.SetVerboseLogListener(otherListener);
```

`CookingBotVerboseLogKind` distinguishes initialization/configuration changes, missing or stopped
state, cooldown and work-completion waits, no-decision ticks, selected decisions, grid-pressure deferrals, rejected
commands, accepted picks, reconciled pending reservations, and accumulated failure knowledge.
Every entry also captures applicable revision/time, command and queue identity, score, strategy,
intelligence, cadence, projected grid load, and pending-pick count. A scalar value of `-1` means it
does not apply to that event. The listener is not coupled to `UnityEngine.Debug`, so production code
can send the same records to an overlay, file, test recorder, or telemetry pipeline.

### Change strategy while the bot is running

Strategies are predefined by `CookingBotPickingStrategy` and can be changed without calling
`Init` again:

```csharp
bot.SetPickingStrategy(CookingBotPickingStrategy.GridSafe);

// The next Tick uses GridSafe. In-flight and pending pick reservations are preserved.
bot.Tick();
```

| Strategy | Picking behaviour |
|---|---|
| `Balanced` | Default web-estimator weights. |
| `GridSafe` | Avoids speculative work and expensive detours as free grid space falls. |
| `FrontLoaded` | Strongly favors immediately useful bases and open slots. |
| `FinishFirst` | Prioritizes open slots and nearly completed dishes. |
| `ChainFirst` | Starts long and multi-input cooking chains earlier. |
| `ScarcityFirst` | Protects requirements with little visible queue supply. |
| `NoPreview` | Ignores upcoming customer previews and focuses on active orders. |

`PickingStrategy` reports the active value. The chosen strategy is also copied into
`LastDecision.pickingStrategy` and `BotPickCommand.pickingStrategy` for telemetry. Changing strategy
takes effect on the next decision and does not reset graph indexes, random tie-break progress, or
accepted item reservations.

### Change intelligence while the bot is running

`intelligent` controls how consistently the bot follows its active strategy:

```csharp
bot.SetIntelligent(0.65f);

// The next Tick has a 65% chance to use strategy scoring and a 35% chance to pick randomly.
bot.Tick();
```

- `1` always uses the current `CookingBotPickingStrategy`, matching the original bot behaviour.
- `0` picks uniformly at random from the currently legal pickup options.
- Values between `0` and `1` use the strategy with that probability on each `Tick`.

The value is initialized from `EstimatorBotSettings.intelligent`, defaults to `1`, and is clamped
when passed to `SetIntelligent`. Changing it preserves the graph, strategy, random-generator
progress, and pending reservations. Random mode still applies all legality checks: frozen, locked,
departing, stale, and already-reserved items cannot be selected. The active value is available as
`bot.Intelligent` and copied to `LastDecision.intelligent` and `BotPickCommand.intelligent`.

### Learn from a failed run

Failure knowledge is an ordinary serializable object owned by the game. Pass it to `Init`, report
the failure after the run ends, then save and reuse the returned object:

```csharp
var knowledge = loadResult ?? new CookingBotFailureKnowledge();
bot.Init(graph, knowledge);

// Run Tick normally. After the level fails:
knowledge = bot.AccumulateFailure(new CookingBotFailureReport
{
    reason = CookingBotFailureReason.GridOverflow,
    progress01 = 0.6f // optional; use -1 when unavailable
});
SaveKnowledge(knowledge);

// Retry with the accumulated grid-pressure lesson.
bot.Init(graph, knowledge);
```

The bot measures peak grid occupancy, peak dirty occupancy, concurrent committed work, and random
accepted-pick rate from the snapshots it already receives. A grid/dirty overflow while many jobs
are still committed adds bounded `pacingPressure`; on the next run that pressure increases
`pickIntervalSeconds` multiplicatively and tightens the adaptive grid reserve, giving cooking and
serving more time to drain between picks. With the default `Adaptive` work strategy, any accumulated
non-timeout failure also enables the tool/merge completion barrier on the next run, matching the web
solver's synchronized retries. Other failure reasons still add urgency, scarcity, chain, grid, or
dirty pressure. The supplied object is updated in place and returned for persistence.

Customer timeout is deliberately not accumulated as failure knowledge. Keep every expired
`customerIndex` in `BotGameState.timedOutCustomerIndices`, including in the final snapshot after
`isPlaying` becomes false. `TimedOutCustomerIndices` returns the unique sorted ids for the results UI.

Knowledge never stores ingredient assets, item ids, lanes, customer identities, or queue history.
It therefore cannot reveal content below the visible rows. Key saved knowledge by a stable level
and graph-version identifier, and discard it when that configuration changes.

### Custom base weights

Pass an `EstimatorBotSettings` instance to change scoring and lookahead:

```csharp
var settings = new EstimatorBotSettings
{
    intelligent = 0.8f,
    pickIntervalSeconds = 0.5f,
    workWaitStrategy = CookingBotWorkWaitStrategy.Adaptive,
    visibleLookaheadRows = 3,
    respectHiddenStatus = true,
    randomSeed = 12345
};
var bot = new CookingEstimatorBot(reader, sink, settings);
bot.Init(graph);
```

Defaults mirror the web estimator's scoring scenario. In a fair player-facing bot, do not put the
ingredient asset into hidden queue rows; `respectHiddenStatus` is an additional guard when your
debug snapshot still contains that data.

After each `Tick`, inspect:

- `LastDecision.option.queueIndex` and `LastDecision.score`;
- `LastDecision.randomFallback` when no offered action had positive demand value;
- `LastDecision.customerIndex` for the active/preview customer that owned the strongest demand;
- `PendingPickCount` to detect stale bridge snapshots.

## 8. Integration tests to add in the game project

At minimum, test these behaviours against the real gameplay adapter:

1. A stale revision or changed front item is rejected without mutation.
2. The same item instance id is never accepted twice.
3. A second legal queue is accepted while the first pickup animation is still running.
4. In-flight and tool items are counted exactly once as committed supply.
5. Save Me bag contents satisfy demand before the bot chooses another queue copy.
6. A bag item is never present in both `saveMeBag` and `committedIngredients` during a flight.
7. Combined/linked item ids are validated and committed atomically.
8. Frozen, locked, hidden, and full-tool actions are absent from `pickupables` when illegal.
9. Active order slots and preview composites match the UI-visible customer sequence.
10. A mistakenly listed frozen leader or frozen combined/linked member is still rejected by the bot.
11. Calls made before `gameplayTimeSeconds` reaches the next-pick deadline do not submit a command,
    while a legal pick is accepted at the deadline even if an unrelated animation is still running.
12. `WaitForToolAndMerge` preserves the cadence, waits while either logical work count is positive,
    and resumes without a manual pick as soon as both become zero.

## Common integration mistakes

- Reading queue/grid state from animated GameObjects instead of the logical model.
- Incrementing `revision` only after a tween or coroutine finishes.
- Omitting tool slots or flights from `committedIngredients`.
- Omitting Save Me bag contents, causing the bot to pick duplicate ingredients from queues.
- Listing a departing bag item in both `saveMeBag` and `committedIngredients`.
- Listing the same ingredient in both the grid and committed collections.
- Using queue row/index as `itemId` and accidentally accepting a shifted replacement item.
- Exposing all front items as pickupable instead of using the game's real `CanPick` result.
- Revealing hidden ingredient assets to the bot when a fair autoplay agent should not know them.
- Counting a partial multi-input tool or visual-only tween as active work, causing a permanent wait.
- Stopping calls to `Tick` while it reports `IsWaitingForWorkCompletion`.
- Leaving `gameplayTimeSeconds` at zero, which intentionally prevents later paced picks.
