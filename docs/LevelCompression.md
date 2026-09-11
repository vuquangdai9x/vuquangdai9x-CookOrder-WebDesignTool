# Compressed level strings

Design keeps its readable `customerString`, `queueString`, and map-sized grid.
Local drafts additionally record `customerCompressed` and `queuesCompressed`.
These are derived from the readable strings when saving and when opening Remote
Data, so editing a level cannot leave an old export in the tool panel.

Remote Data appends **Customer-compressed** and **Queues-compressed** below the
existing fields on both the sheet and tool sides. Their default sheet columns
are **V** (zero-based 21) and **W** (22). Both mappings can be changed under
Config. Existing P/R columns continue to contain readable customers/queues.
Per-field, per-level, map-wide, and all-map Apply operations include the new
fields and retain the existing undo/redo behavior.

Applying one compressed sheet field decodes it into its readable Design field.
A whole-level Apply accepts old rows with blank V/W, or compressed-only rows
with blank readable customer/queue fields. If both representations are present
and disagree, the whole Apply is rejected; apply the desired individual field
and then write the corrected level back to the sheet. Malformed compression is
reported without partially applying the row or batch.

## Wire format

Nonempty strings use `z1_` followed by **unpadded Base64url of raw DEFLATE
compressed UTF-8 bytes**. This is raw DEFLATE, not a zlib or gzip container.
The alphabet is `A-Z`, `a-z`, `0-9`, `_`, `-`; no whitespace or padding is emitted.
Empty source strings remain empty. Nonempty exports are always encoded, even
when a very short source would be smaller uncompressed. Decoders also accept
unprefixed readable strings for compatibility. The decoded size limit is 1 MiB.

The web tool uses `fflate` and Unity uses `System.IO.Compression.DeflateStream`.
Fixed test fixtures cover nested orders, quantities, customer identities, staff,
effects, sweepers, queue groups, and empty queue columns.

Firebase **values** are strings; the restricted identifier rules in the docs
apply to parameter **keys**. Base64url is safe inside string values and the JSON
REST request. Firebase limits the sum of parameter value strings in a project
to 1,000,000 characters; compression does not remove that aggregate limit.
Sources: [Firebase constraints](https://firebase.google.com/docs/remote-config/quotas-limits),
[Firebase REST value schema](https://firebase.google.com/docs/reference/remote-config/rest/v1/RemoteConfig#RemoteConfigParameterValue),
[Base64url](https://www.rfc-editor.org/rfc/rfc4648.html#section-5).

## Firebase and Unity

Push Remote Config preserves the existing key and three-part envelope:

```text
<customerCompressed>~<grid>~<queuesCompressed>
```

Base64url cannot contain `~`. Split with empty entries preserved, then pass each
field to the corresponding translator:

```csharp
var fields = value.Split(new[] { '~' }, System.StringSplitOptions.None);
var customers = CustomerOrderTranslator.Parse(fields[0], graphAsset);
var grid = GridLayoutTranslator.Parse(fields[1], graphAsset);
var queues = IngredientQueueTranslator.Parse(fields[2], graphAsset);
```

The customer and queue translators automatically decode `z1_`. Their serializers
still produce readable strings. `LevelStringCompression.Decode` is also public
for callers that need the original string before parsing.

Remote grid values with no cell effects are empty (both sheet export and Firebase).
Explicit effects, including `#0`, are retained. Applying an empty grid from the
sheet restores the map-sized blank grid in Design. In Unity the graph-aware
grid parser expands an empty string to `gridWidth * gridHeight` blank cells;
nonempty grids still require an exact cell count. Grid serialization now emits
empty for an all-blank grid. Syntax-only grid parsing cannot infer dimensions
and retains its one-blank-cell interpretation of an empty string.

Deploy the updated Unity package before publishing compressed values to clients.
