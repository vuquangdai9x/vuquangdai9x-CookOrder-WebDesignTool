# Google Sheet Structure

Linked sheet: **the user's own spreadsheet id** — none is checked into source or docs (see
[ToolDesign.md](ToolDesign.md)'s Shared shell section: the Sheet ID field starts empty, and only
someone who already has their project's own id can pull its live data through this tool).

Reads go through the **Sheets API v4** with a per-user OAuth token (Google Identity Services) — not
a CSV export proxy. **Writing is supported**: per-section and per-level "⇪ Write to sheet" actions
push individual rows back to the linked sheet (`src/data/sheetWrite.ts`, column mapping in
`config/general/sheet-write-columns.json`), in addition to (not instead of) the CSV export button.
A bundled Map 1 snapshot ships with the tool so it's usable offline / with no sheet configured.

## Tabs

| Tab | Content | Used by tool |
|---|---|---|
| **Global Definition** | Multi-block layout: maps index, weather, emotions, ingredient/grid-cell/customer statuses, key colors, a dish-combo reference table, a customer/pet-type table (cosmetic, unused by the sim), and the loose key/value blocks (hearts, serveTray, saveMe, rewards, features, home) | yes |
| **Booster_config** | Two tables: the booster actions (`ID\|Title\|Details\|LvUnlock\|Free\|Price\|MaxAds\|DataList\|DataValueList`) and the Save Me variants (out-of-slot, out-of-time), same column shape | yes |
| **MapDefinition** | Per-map sections, each starting at a row whose first cell names the map (e.g. `Map1_burger`, `Map2_donut`) — holds that map's tools/upgrade-cost table, dirty-objects table, cooked-ingredients table, raw-ingredients/recipes table (`Tool-Required` can be a comma list for a multi-step recipe, e.g. `2,3`), a level-pack/IAP-cost table, and a pet/customer-decoration table | Map 1's section only — Map 2/3 are still in progress and not data-ready, so their sections are read for structural reference but not imported |
| **MapLevelProgress** | One row per level (`Map\|Level\|ID\|Title\|Weather\|Tag\|Customers\|Grid\|Queues\|concat-data\|Note\|E-TimePlay\|E-WinRate\|R-TimePlay\|R-WinRate`) — the actual authored level content. Only rows with populated `Customers`/`Queues` are "data-ready" | yes, Map 1 rows 1–15 only (16–25 exist as placeholders with empty data) |

## Key definition tables

**Raw ingredients — Map 1 (burger)**: ids 0–8 are the original burger set (Bun, Patty, Tomato,
Lettuce, Onion, Cheese, Egg, Soda, Ice). Ids 9–15 (Chicken Wing, Chicken Thigh, Chicken Nugget,
Potato, Chili Bowl, Cheese Sauce, Chive) were merged in from Map 2's `MapDefinition` section to
exercise chained-tool processing and multi-use serving in the sim — see "Chained recipes and
multi-use ingredients" below. They aren't referenced by any level's queue/order data yet.

**Ingredient statuses**: 0 None, 1 Freeze, 2 Hidden, 3 HoldingKey.
**Grid cell statuses**: 0 Normal, 1 Blocked, 2 OrderLock, 3 IngredientSlot, 4 ColorLock.
**Key colors**: 0 None, 1 Red, 2 Yellow, 3 Green, 4 Blue, 5 Purple.
**Weather**: Normal, Rainy, Sunny, Freeze, Stormy (added this pass) — each row now also carries a
`fileId`/`emoji`, enrichment only, nothing reads them yet.
**Level tags**: `""` (None), Hard, Super Hard (added this pass, with `rewardWin`/`fileId`/`emoji`
enrichment from the Global Definition difficulty table).

### Icons

Definition rows carry their icon as a `fileId` (Google Drive) field plus an `emoji` fallback, with
an optional bundled local image tried first. See [src/ui/icon.ts](../src/ui/icon.ts).

### Where each block landed

| Block | Destination |
|---|---|
| Maps index | `general/maps.json` |
| Weather | `general/weather.json` |
| Level-tag / difficulty table | `general/tags.json` |
| Ingredient statuses | `general/ingredient-statuses.json` |
| Grid cell statuses | `general/cell-statuses.json` |
| Key colours | `general/key-colors.json` |
| Key/value blocks (hearts, serveTray, saveMe, rewards, features, home) | `general/meta.json` |
| Booster actions + Save Me variants | `general/boosters.json` |
| Customer/pet-type table, dish-combo table (already matched `dishes.json` — no changes needed) | `general/misc-definitions.json` (unmatched tables only — kept for reference, not wired into any type or Design-mode editor) |
| Map 1 tools table | `map1-burger/cooking-tools.json` |
| Map 1 dirty-objects table | `map1-burger/dirty-objects.json` |
| Map 1 raw-ingredients/recipes table | `map1-burger/ingredients.json` + `cooking-tools.json` (recipes) |
| Map 1 cooked-ingredients table | `map1-burger/cooked-ingredients.json` |
| Map 1's level-pack/IAP-cost table, pet/customer-decoration table | `map1-burger/misc.json` (unmatched tables — reference only) |
| `MapLevelProgress` rows (Map 1 only) | `map1-burger/levels.json` |

Cook times and the raw→cooked mapping live in each map's `cooking-tools.json`, not per-ingredient —
a tool defines what it converts, how long it takes, and how many pieces it yields.

## Chained recipes and multi-use ingredients

Two mechanics were added specifically to exercise sheet features that didn't previously have an
engine equivalent — see [GDD.md](GDD.md) §2.2 and §2.4 for the gameplay rules:

- **Chained (multi-step) recipes**: the raw-ingredients table's `Tool-Required` column can list more
  than one tool id, comma-separated (e.g. Potato: `2,3` = Cutting Board, then Fryer, before its
  2-piece output). This is `ToolRecipe.chainTools` in the data model.
- **Multi-use cooked ingredients**: the cooked-ingredients table's `UsageNum` column, when > 1,
  means a single instance can be served that many times before it's consumed (e.g. Cheese Sauce,
  `UsageNum: 3`, shared across three dishes before it's used up). This is `CookedIngredientDef.usageNum`.
- The same table's `RequiredBase` column can list **several** ids (e.g. `9,10,11,12`), meaning the
  ingredient can serve once **any one** of them is already in the dish — not all of them. This is
  `CookedIngredientDef.baseId: Id | Id[]`.

## Customer-string field count (sheet vs. canonical)

`MapLevelProgress`'s `Customers` column uses 6 `;`-separated fields per customer —
`avatarVariant;waitTime;unknownFlag;weatherEff;unknownFlag2;dishes` — two more than the tool's
canonical 4-field format (`typeId;waitTime;weatherEff;dishes`, see [GDD.md](GDD.md) §7.3). The two
extra fields (a per-customer cosmetic avatar/pet variant id, and an unexplained 0/1 flag with no
current meaning) don't correspond to anything in `CustomerConfig` — designer decision was to drop
them on import rather than guess at their purpose or extend the type for unknown fields, so
`levels.json` only carries `waitTime`/`weatherEff`/`dishes` from this column, with `typeId` always
defaulting to `0` (Customer). Grid/Queue columns import unchanged — their `#effectId:param` grammar
already matches the canonical format exactly.

## Tool renaming

Map 1's cooking tools were renamed to match `MapDefinition`'s tools table — **Griddle** (was Pan),
**Coca Machine** (was Soda Machine), **Cutting Board** (unchanged) — confirmed by identical
`fileId`s between the old and new names, i.e. this is a rename/reorder, not new stations. Two new
tools, **Fryer** and **Flour**, were added from the same table; Flour has no recipes yet (map1
doesn't use it), and Fryer now processes the merged chicken ingredients (§ above).

## Data quirks noticed

- `MapLevelProgress` levels 16–25 (map 1) and all of map 2/3 have empty `Customers`/`Queues` — not
  yet authored; only Map 1 levels 1–15 were imported.
- Scenario level 1_3 has one customer with an empty `waitTime` field (`0;;0;0;0;…`) — treated as 0.
- `MapDefinition`'s summary row states Map 1's planned total as 25 levels; only 1–15 have real data
  today (`map.json`'s `numLevels: 25` reflects the planned total, not the currently-authored count).
- Grid-lock data (the `Grid` column) is empty for every `MapLevelProgress` row in this export — the
  existing hand-authored lock data in `levels.json` (levels with `#`-effect grid cells) was left
  untouched rather than being blanked out by an empty sheet column.
- Win condition in the sheet is star-score based; the tool intentionally uses the simplified "serve
  all customers" rule (designer decision, carried over from the previous sheet).
