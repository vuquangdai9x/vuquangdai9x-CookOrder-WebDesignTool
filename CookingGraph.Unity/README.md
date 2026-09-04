# Cooking Graph

Unity 6 UPM package for editing CookOrder graph JSON, synchronizing runtime ScriptableObjects, and parsing ingredient/customer level strings.

Install the package from disk through Unity Package Manager, then open **Window > Cooking Graph > Node Editor**.

The graph JSON remains the source of truth. Without a config, generated runtime assets are written to `Assets/_Production/Map-<map-id>/Graph`.

## Gameplay rules

[GAMEPLAY_RULES.md](GAMEPLAY_RULES.md) is the full specification of the cooking graph and of the play-mode simulation — data model, level-string grammar, the tick loop, picking, cooking, serving, dirty dishes, win/lose conditions, boosters and Save Me. Read it before building the gameplay scene: this package ships the data and the translators, not the simulation.

## Runtime translators

```csharp
IngredientQueueData queues = IngredientQueueTranslator.Parse(queueString, graphAsset);
GridLayoutData grid = GridLayoutTranslator.Parse(gridString, graphAsset);
CustomerOrderData customers = CustomerOrderTranslator.Parse(customerString, graphAsset);

// The grid string is a flat run of cells in scan order; the map header supplies the shape.
GridCellData cell = grid.CellAt(2, 1);
bool blocked = cell.Has(CellStatusId.Blocked);

// Queue ingredients expose both the positional index and typed asset.
int ingredientIndex = queues.columns[0].items[0].index;
IngredientNodeAsset ingredient = queues.columns[0].items[0].ingredient;

// Customer members expose their positional index and resolved node asset.
int memberIndex = customers.customers[0].dishes[0].root.index;
CookingNodeAsset memberAsset = customers.customers[0].dishes[0].root.asset;

// All three formats support canonical round-tripping.
string queueAgain = IngredientQueueTranslator.Serialize(queues);
string gridAgain = GridLayoutTranslator.Serialize(grid);
string customersAgain = CustomerOrderTranslator.Serialize(customers);
```

Use the overloads that receive `CookingGraphAsset` for runtime data. They reject unresolved table indices and populate asset references. The graph-less overloads remain available for syntax-only parsing and canonical interchange; their asset-reference fields are null.

The customer translator accepts the graph grammar (`{c0:...}` / `{g0:...}`) only. `TryParse` overloads return a `CookingGraphFormatException` containing the failing source position and context.

To identify an assembled dish from the cooked ingredients currently placed in it, pass their
positional ingredient indices as a flat list. The translator preserves duplicates and rebuilds the
resolved composite/group tree used by `DishOrderData`:

```csharp
var cooked = new[] { bunIndex, cheeseIndex, cheeseIndex };
OrderMemberData structure = CompositeStructureTranslator.Translate(
    graphAsset,
    cooked,
    warning => Debug.LogWarning(warning));

if (structure != null)
{
    var composite = (CompositeNodeAsset)structure.asset;
    // structure.members contains the reconstructed ingredient/group/composite nesting.
}
```

Only an exact valid match is returned: every supplied item must be consumed, a base must be
present, required toppings and group quantities must be satisfied, and slot/option maximums are
honoured. `TryTranslate` is available for a boolean result, while `FindBestComposite` returns only
the matched `CompositeNodeAsset`. If several structures match, graph `idTable.composite` order is
the stable tie-breaker; the first is returned and the callback receives a warning (or Unity logs
the warning when no callback is supplied). Invalid ingredient indices throw; no exact match
returns `null`/`false`.

The grid string carries no dimensions of its own, so only the graph overload can shape it: it checks the cell count against `gridWidth * gridHeight` — a grid of the wrong length silently shifts every later cell, so it is rejected rather than padded — fills in `width`/`height`, and verifies that any Ingredient-slot cell resolves through the ingredient id table. Read that one back with `GridLayoutTranslator.TryGetIngredientSlot`; it is the only cell effect whose parameters name a node, since OrderLock counts customers and ColorLock names a key colour. `GridLayoutTranslator.Blank(graph)` produces an all-blank grid string for a new level.

## Generation

Create a **Cooking Graph > Generation Config** asset from Unity's **Assets > Create** menu and select it in the node-editor toolbar to customize the destination. Its output-folder format is project-relative: `{0}` is the config's map index and `{1}` is the sanitized graph map id. For example, `Assets/_Production/Map-{0}-{1}/Graph` resolves to `Assets/_Production/Map-2-coffee/Graph`.

The first successful generation creates typed node assets and one `CookingGraphAsset`. Later runs are labeled **Sync** and update active assets in place so their GUIDs remain stable. Removed graph nodes are detached from the runtime graph but their asset files are retained and reported as orphans.

Local image paths, direct `imageURL` values, and Drive IDs remain in interchangeable JSON but are not copied into runtime assets or included in synchronization fingerprints. Assign a `Sprite` to each generated node asset; the editor canvas uses it in preference to the JSON emoji.

## Preservation slots

A tool may declare `preservationSlots` — waiting positions outside its recipe layout — plus one
`preservation` edge naming what they accept. A matching pickup enters the buffer first, advances
into a free process slot on its own, and is refused while every position is occupied. The edge may
point at a group, in which case the buffer accepts every concrete option of that group:

```csharp
// Concrete ingredients this tool's buffer accepts, groups already expanded.
IReadOnlyList<IngredientNodeAsset> accepted = CookingGraphPreservation.IngredientsFor(graph, tool);

// The reverse: tools a pickup may be buffered in, in graph order.
IReadOnlyList<ToolNodeAsset> tools = CookingGraphPreservation.ToolsFor(graph, ingredient);

// Both at once, for a runtime that indexes this up front.
Dictionary<ToolNodeAsset, List<IngredientNodeAsset>> lookup = CookingGraphPreservation.BuildLookup(graph);
```

Validation treats the slot count and the wiring as one rule: slots with nothing wired can never be
entered, and an edge with no slots declares a buffer that does not exist. Either half alone is an
error, because in play both look like a silent stall.

## Estimator autoplay bot

`CookingEstimatorBot` is the runtime, online counterpart of the web difficulty estimator. Supply
small adapters for `ICookingBotStateReader` and `ICookingBotCommandSink`, then call `Tick()` from
your gameplay update loop. See the complete [game-system integration guide](Runtime/Autoplay/README.md)
for field mappings, adapter examples, atomic command handling, animation overlap, and tests.

Minimal setup:

```csharp
var bot = new CookingEstimatorBot(stateReader, commandSink);
bot.Init(graphAsset);

// Update: one accepted logical pick at most; this never waits for a visual animation.
bot.Tick();
```

The reader snapshot contains visible queue items and statuses, the authoritative pickupable action
list, grid and Save Me bag contents, in-flight/tool commitments, active orders, and composite-only preview orders.
The command includes both `observedRevision` and `expectedItemId`; the sink should reject it when
either is stale.

An accepted command must update **logical** gameplay state immediately: increment the revision,
remove/disable the queue item, and add its ingredient to `committedIngredients` before starting the
visual flight. The animation then runs independently. On the next frame the bot can pick another
legal queue, and the already-flying ingredient is included in demand accounting, so the bot neither
waits for every animation nor orders the same requirement twice. `Departing` queue items may remain
in the snapshot for rendering but are ignored as queue supply.

The game may switch predefined picking behaviour at any time; for example,
`bot.SetPickingStrategy(CookingBotPickingStrategy.GridSafe)` takes effect on the next `Tick` without
reinitializing the graph or clearing in-flight reservations. `bot.SetIntelligent(0.5f)` can also
change the bot from fully strategic (`1`) toward fully random (`0`) on the next `Tick`; random
picks still exclude frozen and otherwise illegal items.

Failed runs can also teach the next run without storing hidden queue data. Pass a
`CookingBotFailureKnowledge` object to `Init(graph, knowledge)`, then call
`AccumulateFailure(report)` after loss and persist the returned serializable object. It stores only
bounded aggregate pressure such as grid risk, dirty buildup, urgency, scarcity, and chain stalls.
