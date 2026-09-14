# liveops/ — CookOrder live-ops & economy config snapshot

A queryable, version-controlled copy of the designer's **CookOrder GDD sheet** — the source of the
shipping game's remote config (economy, shop, ads, hearts, boosters, Save Me, journey rewards, home
decoration, customer cast, analytics contract). Nothing in the web tool or the Unity game reads
these files; they exist so people and agents can answer "what is the current value of X" without
opening the sheet or a 200-row JSON.

Sheet: `https://docs.google.com/spreadsheets/d/1BIosxNjfnueck5VubwwG6_kW8KRH_-gQU6q1WPy_UNA`

## For agents — read this first

1. **Use the CLI before reading any file under `data/`.** `python liveops/liveops-cli.py tables`
   lists every table with its columns and a one-line note; `show`, `get`, `kv`, `find` answer most
   questions in a few lines. Only open a JSON directly when you need the whole table.
2. **`data/` is generated.** Never hand-edit it. To change a value, change the sheet, then re-run
   `python liveops/import-sheet.py` and commit the diff.
3. **Table names are the Google Sheets table names** (`HeartConfig`, `IAPShop`, `Booster`…), not the
   tab names. The tab is only the folder.
4. **`LevelData` is large and out of scope for pipeline/economy work** — query it with `--where`
   and `--cols`, never dump it whole.
5. Two currencies: **Coin** (soft — level wins, customer coin spawn, journey `soft:`, spent on Home
   Building) and **Gem** (hard — IAP, journey `hard:`, spent on boosters, Save Me, hearts,
   speed-up). `1 Gem = $0.001` (`ItemValue`).

## Layout

```
liveops/
  README.md            this file
  import-sheet.py      downloads the sheet's xlsx export and writes data/  (needs openpyxl)
  import-config.json   per-table hints: forward-fill, dropped columns, notes, excludes
  liveops-cli.py       query data/ (stdlib only)
  data/
    manifest.json      source, import time, every table with sheet/range/columns/rows/note
    <SheetTab>/<TableName>.json   one JSON array of row objects per named table
```

Every named table in the workbook (Google Sheets → *Convert to table*) becomes one file. Adding a
new table to the sheet needs no code change — it appears on the next import. Add a `table_notes`
entry in `import-config.json` so the CLI can describe it.

## CLI

```bash
python liveops/liveops-cli.py tables                         # inventory
python liveops/liveops-cli.py show IAPShop --cols SKU,"Price ($)",Type
python liveops/liveops-cli.py show Booster --where Enable=1
python liveops/liveops-cli.py show HomeBuilding --where Map=1 --cols "Part Id",Price,Title
python liveops/liveops-cli.py show DataTracking --where Event=level_end
python liveops/liveops-cli.py get HeartConfig refillCost      # -> 800
python liveops/liveops-cli.py kv InGameHeartConfig            # whole key/value block as JSON
python liveops/liveops-cli.py find saveme                     # substring search across all tables
python liveops/liveops-cli.py show LevelData --where Map=2 --where Tag=Hard --cols Map,Level,Weather
python liveops/liveops-cli.py manifest
```

`--where` is case-insensitive equality; `*` at either end is a wildcard (`--where SKU=*pack*`).
`--json` prints JSON instead of markdown; `--wide` disables cell truncation.

## Import

```bash
pip install openpyxl                       # once
python liveops/import-sheet.py             # default sheet id, writes liveops/data/
python liveops/import-sheet.py --sheet-id <other-id>
python liveops/import-sheet.py --xlsx export.xlsx   # offline from a File > Download > .xlsx
python liveops/import-sheet.py --exclude LevelData  # skip a table for this run
```

The importer uses the sheet's public xlsx export, so the sheet must be shared as *Anyone with the
link (Viewer)*; no Google credentials are involved. `data/` is wiped and rewritten on every run —
review `git diff liveops/data` before committing.

Import hints (`import-config.json`):

| key | effect |
|---|---|
| `forward_fill` | columns whose blank cells inherit the value above (the sheet's merged-cell layout, e.g. `DataTracking.Category`) |
| `drop_columns` | columns not exported (image formulas, scratch columns) |
| `keep_columns` | derived columns to export anyway |
| `table_notes` | one-line description shown by `tables` / `show` |
| `exclude_tables` | tables never exported |

**Derived columns are not exported.** A column whose every non-empty cell is a formula (concat
strings, `ROW()` indexes, `COUNTIF`s, margin math, lookups such as `Booster.Price`) is sheet-side
derived data, not authored config; the importer drops it and lists it under
`derived_columns_dropped` in `manifest.json`. Pin one with `keep_columns` in `import-config.json`,
or export everything once with `--keep-derived`.

Cell normalisation: integral floats become ints, strings are trimmed, `#REF!`/`#N/A` become `null`,
fully empty rows are skipped.

## What the tables mean (short)

| Table | Meaning |
|---|---|
| `Maps_metadata` | Map order; `Num Required Levels` = levels to clear before the next map unlocks |
| `HeartConfig` / `InGameHeartConfig` | Meta lives (energy) / Save Me continues |
| `RewardConfig` / `DifficultyTag` | Level-win Coin by tag, ad-bonus multipliers |
| `Emotion` | Customer mood by remaining patience → payout fraction and Coin spawn |
| `MechanicFeatures` | Feature flags (`upgradeTool`, `dirtyStack` cap…) |
| `ServeSlots` / `StackConfig` / `ProgressScenario` / `SpeedUpFeature` / `RemoveAds` | Misc global tunables |
| `Booster` / `SaveMe` | Booster + Save Me definitions, unlock level; `Enable 0` = cut. Prices are in `ItemValue` |
| `ItemValue` / `IAPShop` / `Reward7Days` | Gem value of items (incl. the Save Me 1st–4th+ ladder), IAP catalog, daily rewards (empty) |
| `JourneyMilestone` | Coin/Gem rewards at level milestones |
| `HomeBuilding` | Restaurant decoration parts per map, Coin prices |
| `Customers` | Named customer cast (Normal / Shipper / Boss) per map |
| `DataTracking` | Analytics event contract (GA4 + AppsFlyer): category, event, params, notes |
| `ads_*_config`, `admob_config`, `maxads_config`, `Ads*` enums | Ad mediation, placements, caps |
| `LevelData` | Per-level design rows — out of scope here |
| `GraphLookupData`, `Weather`, `GridSlotType`, `IngredientSlotStatus`, `LockColor`, `RecipePieceType`, `CustomerType` | Definition/enum tables |
