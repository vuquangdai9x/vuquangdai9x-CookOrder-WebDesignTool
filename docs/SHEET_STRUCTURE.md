# Google Sheet Structure

Linked sheet: `1wayrsZlHCTtuMGD1Qft2Fmaeb19b-ULfO2F6abTlAEA` (read-only for this tool; **saving exports CSV downloads instead of writing back**). Fetched as CSV per tab via `export?format=csv&gid=…`, proxied through the Vite dev server (`/gsheet/*`) to avoid CORS.

## Tabs

| Tab | gid | Used by tool | Content |
|---|---|---|---|
| Tổng quan / Mục đích / Home / Flow | 0 / 1619950431 / 1648676294 / 430191651 | no | Overview & purpose notes (Vietnamese) |
| RemoteConfig-Maps | 1355692925 | no | Remote-config blob |
| **ConfigTables** | 709436862 | defs (static copy) | Multi-block layout: maps index, weather, emotions, ingredient encodes, dish recipes, **ingredient statuses**, **grid cell statuses**, key colors, misc key-value configs |
| Gameplay | 575122880 | reference | Gameplay rules prose (Vietnamese) |
| Upgrade / Journey / Design vs Demo | — | no | Meta-game design |
| System_Config | 2020840180 | no | Feature unlock levels |
| Ingredient_config | 675328923 | defs (static copy) | Per-map raw ingredients: id code, name, price, mechanic, action counts, cook times, burn |
| Tool_config / Tool_config_1 | 1757733674 / 2117207559 | no | Kitchen tool upgrade tables (knife/pan/fryer…) |
| **Level_overall_config** | 1529635743 | yes | Per-level design metrics + the encoded **LvConfig/MapConfig** strings |
| **TOOL_Level_ingredient_queue** | 266021364 | yes | Per-level **ingredient queue** strings |
| **Level_Scenario_Map1_burger** | 804770440 | yes | Map 1 customer scenarios + encoded **customer** strings |
| **Level_Scenario_Map2_chicken_fried** | 722547124 | yes | Same for Map 2 |
| Booster_config / Restaurant_config / Staff_config | — | no | Boosters, restaurant levels, staff |
| Draft | 1491509214 | no | Scratch |

## Key definition tables (from ConfigTables)

**Ingredient encodes — Map 1 (burger)**: 0 Bun, 1 Patty, 2 Tomato, 3 Lettuce, 4 Onion, 5 Cheese, 6 Egg, 7 Soda(cup), 8 Ice. Dish recipes are digit-runs of these encodes (`10` = Patty+Bun burger, `102` = tomato burger, `78` = ice soda).

**Ingredient statuses**: 0 None, 1 Freeze, 2 Link, 3 HoldingKey.
**Grid cell statuses**: 0 Normal, 1 Blocked, 2 OrderLock (until X orders done), 3 IngredientSlot, 4 ColorLock (serve X key-holding ingredients of matching color).
**Key colors**: 0 None, 1 Red, 2 Yellow, 3 Green, 4 Blue, 5 Purple.

**Cell type 3 (IngredientSlot)** takes params `[ingredientId, amount]` per `docs/ToolDesign.md` — the cell is keyed to one specific ingredient and opens once that many of *that* ingredient have been used. (The sheet's older wording described an "until X ingredients used" any-ingredient counter; the tool follows ToolDesign. No level in the sheet currently uses type 3, so nothing needed migrating.)

### Icons

The definition tables carry their icons as `=IMAGE("https://drive.google.com/uc?export=view&id=…")` formulas, which the CSV export drops. The file ids were recovered from the sheet's `.xlsx` export (`xl/worksheets/sheet4.xml`) and now live in [src/data/icons/](../src/data/icons/) — `ingredients.json`, `ingredientStatuses.json`, `cellStatuses.json` — each row `{ id, name, emoji, fileId }`. The UI renders them via `https://drive.google.com/thumbnail?id=<fileId>&sz=w<size>`, which serves cross-origin (unlike `uc?export=view`); the `emoji` field is the fallback if an image fails to load. See [src/ui/icon.ts](../src/ui/icon.ts).

## Legacy encoded strings (as stored in the sheet)

The big per-map blobs sit in the **first level row** of each map; the tool reads the last non-empty cell of that row:

- `Level_overall_config` → **MapConfig**: levels joined by `|`, each level an **LvConfig**:
  `count;weather;tag;featureUnlock;star1,star2,star3;tools;waitTimeScale;gridString`
  → *StarScores, the blank tools field, and WaitTimeScale are legacy and dropped by the tool* (per designer). Grid cells are `,`-separated, each cell `typeId#param#param` (e.g. `4#1#1` = ColorLock red ×1), blank = normal.
- `TOOL_Level_ingredient_queue` → **Each Map** column: levels joined by `|`, each `queueString;shuffleDistance;`. Queue format matches the tool's canonical one: queues `%`-separated, items `,`-separated, `itemId#statusId:param` (e.g. `2#1:5` = Tomato frozen for 5 picks, `6#3:1` = Egg holding a red key).
- `Level_Scenario_Map*` → **FINAL** cell on the header row: levels joined by `~`, customers by `|`, each customer
  `delay;waitTime;completePrev;weatherEff;vip;recipes`
  → *delay, completePrev, and vip are legacy and dropped by the tool* (per designer). Recipes: dishes `,`-separated, each dish a digit-run of ingredient encodes + optional `#effect`.

## Canonical formats used by this tool (after conversion)

- **Queue string**: unchanged from sheet — `0,1#1:5,0%1,7,7`.
- **Grid string**: cells `,`-separated, each cell `#typeId:param:param` (legacy `4#1#1` → `#4:1:1`), blank = normal.
- **Customer string**: customers `|`-separated, each `waitTime;weatherEff;dishes`; dish ids `.`-separated (`1.0.2`), legacy digit-runs still parse.
- **Level fields kept**: weather, levelTag, featureUnlock, shuffleDistance, grid 5×2, queue/grid/customer strings.

Conversion code: [src/data/legacyConvert.ts](../src/data/legacyConvert.ts). Live loading: [src/data/sheetSource.ts](../src/data/sheetSource.ts). Bundled Map 1 snapshot: [src/data/map1_burger.json](../src/data/map1_burger.json).

## Map 2 recipe encoding — open question

Map 1 dish recipes are plain digit-runs of ingredient encodes (`102` = Patty+Bun+Tomato). **Map 2 is different**: its scenario recipes are composite ids such as `20012`, `30201`, `703`, `2001`, which appear to encode *piece + modifier(s) + size* using the ConfigTables blocks (pieces: Thigh 0, Wing 1, Breast 2, Nugget 3, Potato 4, Onion 5, Coke 6, Sprite 7; modifiers: Chilly 0, Chives 1, CheeseSauce 2, Ice 3; sizes: Medium 0, Large 1). The digit-count varies (`20`, `200`, `2001`, `20012`), so the field layout is ambiguous. **Map 2 import is deferred until the designer confirms the decoding rule** — guessing would silently produce wrong orders.

## Data quirks noticed

- Level 12 (map 1): LvConfig says 16 customers but the scenario string has 15.
- Levels 12, 14, 15 (map 1) have empty ingredient queues in the sheet (not yet authored).
- Scenario level 3 has one customer with an empty waitTime field (`0;;0;…`) — treated as 0.
- Win condition in the sheet/Gameplay tab is star-score based; the tool intentionally uses the simplified "serve all customers" rule (designer decision).
