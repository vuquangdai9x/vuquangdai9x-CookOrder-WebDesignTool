# CookOrder Level Design Tool — Implementation Plan

Companion to [GDD.md](GDD.md) and [SHEET_STRUCTURE.md](SHEET_STRUCTURE.md). Stack: **Vite + TypeScript + vanilla DOM** (no framework, no canvas — the game is discrete UI elements; DOM gives free hit-testing, easy table UIs, and inspectability for designers). Tests: **Vitest**. Static build; runs fully in browser, no server.

**Status: Phases 1–5 complete, plus the ToolDesign layout rework (Phase 7), the cooking-tool/animation model (Phase 8), and a UX polish pass (Phase 9).** 72 tests green. Remaining work is Map 2's level import, blocked on its recipe encoding.

## Architecture principles

- **Deterministic sim core** in pure TS (`src/core/`, no DOM imports), driven by the host with `tick(dt)`. No timers of its own, so playtests are reproducible and headless validation is possible.
- **Registry pattern for all extensible behavior**: effect handlers, cell types, and customer types are registered by id in code; their *definitions* (id, name, icon, description, param defs) are designer-edited data. Unknown ids resolve to permissive no-op handlers with a one-time console warning, so designer data can never crash the sim.
- **String formats round-trip**: parsers are the single source of truth used by the editor, the sim, and CSV export.
- **Sheet is read-only**: the linked design Google Sheet is imported (legacy formats converted on the fly); **saving exports CSV downloads**, never writes back.

## Directory layout

```
src/
  core/
    types.ts            model: ids, definitions, tools, map/level schemas
    parser.ts           queue/grid/customer parse + serialize
    registry.ts         effect / cell-type / customer-type registries
    effects.ts          built-in behaviors (registers into the registries)
    sim.ts              deterministic state machine (tools + flights)
  data/
    config/general/     cross-map tables (statuses, colours, weather, meta)
    config/map1-burger/ map, ingredients, cooked, cooking-tools, dishes, levels
    config/map2-.../    same shape; levels empty pending the encoding question
    configLoader.ts     turns the config tree into the runtime model
    sheetSource.ts      Google Sheet CSV read + CSV export save
    legacyConvert.ts    legacy sheet formats -> canonical
    mapLoader.ts        JSON string form <-> parsed MapDef
    validate.ts         level warnings surfaced in Design mode
  ui/
    dom.ts              el() / button() helpers
    icon.ts             Drive images with emoji fallback
    history.ts          per-section undo/redo + dirty state
    contextMenu.ts      right-click menus with inline sub-editors
    design/             section shell + customer/grid/queue sections
    play/               board renderer, effectsLayer (flights + particles)
  main.ts               shell: mode tabs, sheet load, CSV export
```

## Phase 1 — Core data model & parsers ✅

Canonical formats (differ from the sheet's legacy forms, per designer decisions):

- Queue `0,1#1:5,0%1,7,7` — unchanged from the sheet. Sweepers use **negative ids** so they can't collide with ingredient ids.
- Grid cells `#typeId:param:param` (legacy `4#1#1` converted on import).
- Customer `waitTime;weatherEff;dishes` — legacy `delay`/`completePrev`/`vip` and LvConfig star-scores/waitTimeScale are dropped.
- Dish ids `.`-separated; legacy digit-runs still parse.

## Data layer ✅

`GoogleSheetCsvSource` reads the linked sheet live via per-tab CSV export through the Vite dev proxy (`/gsheet`, `secure:false` for SSL-inspecting networks). Save = `exportProjectCsv()` downloads `map*_levels.csv` + `map*_definitions.csv`. A bundled Map 1 snapshot ships for offline start.

## Phase 2 — Definition tables UI ✅

`ui/design/tableEditor.ts` is a generic editor (add/delete row, typed cells, optional per-row sub-editor). Instantiated for effects, cell types, customer types (global — with param-definition sub-editors), and raw ingredients, cooked ingredients, cook mappings (per map). Level CRUD lives in the Design sidebar.

## Phase 3 — Level editor ✅

`ui/design/levelEditor.ts`: level meta fields, grid painter (cell-type palette, click to paint, param prompts), queue editor (per-queue lists, reorder, add/remove, effect assignment), customer editor (waitTime/weatherEff, dishes as cooked-ingredient chips, dish effects). Every panel shows a live canonical-string preview that also **accepts pasted strings, including the sheet's legacy forms** (auto-converted). Verified: pasting `1,,4#2#1,,,,,3#5,,` yields `#1,,#4:2:1,,,,,#3:5,,`.

## Phase 4 — Play mode ✅

`core/sim.ts` implements queues (top pickable, 2 previews), the prepare→cook pipeline, first-free-cell grid placement respecting locks, serve slots with FCFS auto-matching, patience timers (0 = infinite; halved for `weatherEff` customers on non-Normal weather), dirty-dish stacking, win (all customers served) and lose (`grid-overflow`, `dirty-overflow`, `out-of-ingredient`, `customer-timeout`). `OutOfIngredient` is overridable via `SimOptions.onOutOfIngredient` (default: lose).

Two ordering rules matter and are covered by regression tests:
- Within a tick, the sim **settles** (fill slots → auto-serve, repeating while progress is made) *before* patience timers are decremented, so food landing this step counts as delivered and a customer entering a freed slot gets their turn at the grid immediately.
- **Skip** calls `fastForward()`, which steps only as far as the next completion or timeout — never past a moment that would change the outcome — and stops when the level needs another pick.

`ui/play/` renders queues (with effect badges and a green highlight on ingredients the current orders need), pipeline progress bars, the grid with lock progress labels, customer cards with dish chips and timers, HUD, event log, and the win/lose overlay.

## Phase 5 — Effect & behavior registries ✅

Built-ins matching the sheet's tables: queue effects **Freeze** (1), **Link** (2, placeholder), **HoldingKey** (3); cell types **Blocked** (1), **OrderLock** (2), **IngredientLock** (3), **ColorLock** (4); queue object **sweeper**; customer type **staff** (a dish-less customer). Adding a new effect requires only a registry entry plus a definition row.

## Phase 7 — ToolDesign layout rework ✅

Replaced the tabbed Design view and 2-column Play board with the layout specified in [ToolDesign.md](ToolDesign.md).

- **Shared infrastructure**: `ui/icon.ts` (Drive images with emoji fallback, backed by the three `data/icons/*.json` tables), `ui/history.ts` (per-section undo/redo + dirty state + `+N/-N` counters, `Ctrl+Z`/`Ctrl+Y`), `ui/contextMenu.ts` (right-click menus with inline sub-editors: number fields, thumbnail pickers, colour swatches), `ui/design/section.ts` (section shell: title, dirty badge, Save, kebab).
- **Design page**: one scrolling page — `customerSection.ts` (draggable ordered cards, inline wait-time/weather, dish chip rows, staff toggle), `gridSection.ts` (cell painter with per-type inline param editors), `queueSection.ts` (Sortable lanes with cross-lane tile drag, per-tile status menus, Remove Mode, Quick Add drawer, Auto-Generate, Shuffle, zoom, Recipe Pieces foldout with the two warning badges). Definitions tables moved behind a "Definitions…" overlay.
- **Play page**: same three tiers; the middle tier is one panel split grid-left / Preparing-Cooking-right. The view rebuilds its DOM only when [`playStructureKey`](../src/ui/play/structureKey.ts) changes and patches timers/progress bars/HUD in place otherwise — rebuilding every animation frame destroyed the tile between its `mousedown` and `mouseup`, which made ingredients unclickable.
- **Cross-section live recompute**: customer and grid commits re-render the queue's Recipe Pieces foldout, so piece and key/lock counts follow edits immediately (this is what ToolDesign's "Refresh Grid & Recipe Counts" existed to do).
- **Cell type 3** became IngredientSlot (`[ingredientId, amount]`); the sim now tracks `picksByIngredient`.
- Drafts persist to `localStorage`; switching level/mode or reloading the sheet with unsaved sections prompts first.

Verified in-browser: all 29 Drive icons load (no fallbacks); Freeze applies an icy tile with a `🧊3` badge; ColorLock and IngredientSlot paint with swatch/thumbnail and params; undo/redo/save cycle the dirty badge; the grid/cooking split sits side-by-side above 900px and stacks below; level 1_1 wins 7/7; level 1_11 shows both ColorLock cells with red/blue swatches and `0/1 keys`.

## Phase 8 — Cooking tools, config tree & animation ✅

- **Config restructure**: every ConfigTables block became JSON under `src/data/config/`, split into `general/` and one `map<index>-<id>/` folder per map (see [SHEET_STRUCTURE.md](SHEET_STRUCTURE.md) for the block → file table). Icons are now a `fileId` on each definition row rather than a separate icon table, so `src/data/icons/` and `initialData.ts` are gone.
- **Cooking tools replace the pipeline**: `CookingToolDef` (id, name, numSlots, cookingTime, recipes `in → out × amount`) is the single source for what an ingredient becomes and how long it takes; per-ingredient `prepareTime`/`cookTime` and the `cookMappings` table were removed. An ingredient with no recipe passes straight to the grid.
- **Out-of-slot policy** (toolbar dropdown, per level): `block-pick` disables the tile with a reason, or `park-on-grid` parks the raw on the grid and reclaims it — checked ahead of new picks — as soon as a slot frees.
- **Flight gating**: transfers are `Flight` records the host animates; `completeFlight()` applies the effect and runs the next logic step, so cooking starts on arrival at a slot and matching runs on arrival at the grid. `instantFlights` (default true) keeps the sim usable headlessly; the play view passes false and Skip resolves everything instantly.
- **Play visuals**: `ui/play/effectsLayer.ts` flies items point-to-point with WAAPI arcs and fires a particle burst plus a light tint when an order completes; serveable customers are highlighted; ×1/×2/×3/Skip is one radio group.

Verified in-browser against real Map 1 data: the three tools render with their real slot counts and times, a greedy bot wins level 1_1 (7/7 in 9s), `block-pick` reports "Chopping Board is full" while `park-on-grid` puts the raw on the grid, and the Definitions overlay lists the cooking-tools table (CSV export includes it).

## Phase 9 — UX polish ✅

- **Footer**: 256px, centered credit line, appended after `<main>`.
- **Customer row fix**: `.customer-cards.play` switched from flex+`overflow-x:auto` to a grid with an inline `grid-template-columns` sized to the exact rendered card count — the flex row could clip the 2nd/3rd card without scrolling; the grid can't, by construction. Only one masked "?" lookahead card renders (was `pending.slice(0,4)`), matching the two-serveable-plus-one-hidden design.
- **Portrait play layout**: `.play-page` fixes `height: min(calc(100vh - 10rem), 920px)` with `aspect-ratio: 3/4` and `width: auto`, so on desktop the zone is height-driven and derives a 3:4 width, with internal scroll as a fallback and a `max-width:480px` media query reverting to full-width on true portrait devices. `--tile` is overridden smaller inside `.play-page`. Cooking tools moved from a side column to a compact horizontal strip below the grid (`.middle-split` is now `flex-direction:column`; tool cards show name+icon only, slot/time detail moved to the `title` tooltip) — "keep it min size" per the designer.
- **Foldable toolbar**: the map/level/speed/policy group (`.toolbar-config`) collapses behind a `▾/▸ Config` toggle; the HUD (live game state, not config) always stays visible. Toolbar padding/font shrunk so it reads as a slim strip either way.
- **Change-tracking borders** (Design mode): [`changeTracking.ts`](../src/ui/design/changeTracking.ts) tags every queue item/lane and customer with a `_cid` at creation (an enumerable field that survives `structuredClone` but is ignored by the parsers/serializers, so it never leaks into saved strings) and diffs the live draft against `Section.savedState`. Dashed outline: green `changed-added` (new), yellow `changed-modified` (edited), red `changed-removed-inside` (lost a child — a lane that lost a tile, a customer whose order shrank). Grid cells are diffed positionally (no id needed, cells can't reorder). 11 unit tests in `changeTracking.test.ts`; verified live for all four elements (tile/lane/cell/customer-card) and confirmed Save clears every indicator.
- **Scoped serve celebration + scale-out**: the play view now rebuilds each tier (customers/middle/queues) independently via three structure keys (`structureKey.ts`) instead of one page-wide key. `EffectsLayer.celebrateAndRemove()` bursts particles and shrinks the *real* served customer's card to zero in place; `PlayView.pendingExits` holds the customers-tier rebuild until that animation resolves, so the old card visibly finishes leaving before the next customer/mystery card appears — the other two tiers keep updating normally during the hold. Verified end-to-end in-browser by monkey-patching `Element.animate` to auto-finish (the sandboxed preview pane freezes both rAF and WAAPI timelines when hidden, confirmed via a raw `.finished` promise that never resolved after 1s), which let the real `dispatchFlights`/`playCelebrations`/`syncPage` code path run and confirmed the card stays through one `syncPage()` call while `pendingExits` is non-empty and is replaced only after it drains.

## Phase 6 — Data polish (remaining)

- **Map 2 import — blocked.** Map 2's scenario recipes use composite ids (`20012`, `30201`, `703`) that encode piece + modifier(s) + size rather than the plain per-ingredient digit-runs Map 1 uses. Decoding them needs the designer's rule before import can be trusted; guessing would silently produce wrong orders.
- Live-parse ConfigTables / Ingredient_config so definitions follow the sheet without code edits (currently a static copy under `src/data/config/`).
- CSV export column review with the designer.

## Verification

- `npm run typecheck` and `npm test` (35 tests).
- `npm run dev`, then in the browser: Design mode round-trips level 1_11's ColorLock grid and key-holder queue items and converts pasted legacy strings; Play mode wins level 1_1 (7/7), shows Freeze as a disabled item with "Frozen until 5 picks (now 1)", and opens 1_11's red ColorLock once the red key is picked; "⟳ Load from Sheet" reports "live Google Sheet" and matches the bundled snapshot.
- Note: the rAF play loop pauses when the browser tab isn't compositing (standard browser behavior); use Skip to advance in that situation.
