# Cooking Graph

Unity 6 UPM package for editing CookOrder graph JSON, synchronizing runtime ScriptableObjects, and parsing ingredient/customer level strings.

Install the package from disk through Unity Package Manager, then open **Window > Cooking Graph > Node Editor**.

The graph JSON remains the source of truth. Without a config, generated runtime assets are written to `Assets/_Production/Map-<map-id>/Graph`.

## Gameplay rules

[GAMEPLAY_RULES.md](GAMEPLAY_RULES.md) is the full specification of the cooking graph and of the play-mode simulation — data model, level-string grammar, the tick loop, picking, cooking, serving, dirty dishes, win/lose conditions, boosters and Save Me. Read it before building the gameplay scene: this package ships the data and the translators, not the simulation.

## Runtime translators

```csharp
IngredientQueueData queues = IngredientQueueTranslator.Parse(queueString, graphAsset);
CustomerOrderData customers = CustomerOrderTranslator.Parse(customerString, graphAsset);

// Queue ingredients expose both the positional index and typed asset.
int ingredientIndex = queues.columns[0].items[0].index;
IngredientNodeAsset ingredient = queues.columns[0].items[0].ingredient;

// Customer members expose their positional index and resolved node asset.
int memberIndex = customers.customers[0].dishes[0].root.index;
CookingNodeAsset memberAsset = customers.customers[0].dishes[0].root.asset;

// Both formats support canonical round-tripping.
string queueAgain = IngredientQueueTranslator.Serialize(queues);
string customersAgain = CustomerOrderTranslator.Serialize(customers);
```

Use the overloads that receive `CookingGraphAsset` for runtime data. They reject unresolved table indices and populate asset references. The graph-less overloads remain available for syntax-only parsing and canonical interchange; their asset-reference fields are null.

The customer translator accepts the graph grammar (`{c0:...}` / `{g0:...}`) only. `TryParse` overloads return a `CookingGraphFormatException` containing the failing source position and context.

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
