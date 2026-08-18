# Cooking Graph

Unity 6 UPM package for editing CookOrder graph JSON, synchronizing runtime ScriptableObjects, and parsing ingredient/customer level strings.

Install the package from disk through Unity Package Manager, then open **Window > Cooking Graph > Node Editor**.

The graph JSON remains the source of truth. Without a config, generated runtime assets are written to `Assets/_Production/Map-<map-id>/Graph`.

## Runtime translators

```csharp
IngredientQueueData queues = IngredientQueueTranslator.Parse(queueString);
CustomerOrderData customers = CustomerOrderTranslator.Parse(customerString);

// Both formats support canonical round-tripping.
string queueAgain = IngredientQueueTranslator.Serialize(queues);
string customersAgain = CustomerOrderTranslator.Serialize(customers);
```

The customer translator accepts the graph grammar (`{c0:...}` / `{g0:...}`) only. `TryParse` overloads return a `CookingGraphFormatException` containing the failing source position and context.

## Generation

Create a **Cooking Graph > Generation Config** asset from Unity's **Assets > Create** menu and select it in the node-editor toolbar to customize the destination. Its output-folder format is project-relative: `{0}` is the config's map index and `{1}` is the sanitized graph map id. For example, `Assets/_Production/Map-{0}-{1}/Graph` resolves to `Assets/_Production/Map-2-coffee/Graph`.

The first successful generation creates typed node assets and one `CookingGraphAsset`. Later runs are labeled **Sync** and update active assets in place so their GUIDs remain stable. Removed graph nodes are detached from the runtime graph but their asset files are retained and reported as orphans.

Local image paths, direct `imageURL` values, and Drive IDs remain in interchangeable JSON but are not copied into runtime assets or included in synchronization fingerprints. Assign a `Sprite` to each generated node asset; the editor canvas uses it in preference to the JSON emoji.
