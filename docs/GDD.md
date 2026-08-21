# CookOrder — Game Design Document

> Scope note: this document describes the **gameplay simulated by the web level-design tool**. The shipping game is built in Unity; this tool exists so designers can author and playtest maps/levels quickly in a browser, with data eventually synced to Google Sheets.

## 1. Overview

CookOrder is a queue-management cooking puzzle. The player pulls raw ingredients from a small number of visible queues; each pulled ingredient is automatically prepared and cooked into one or more **cooked ingredients** that land on a limited output grid. Customers arrive with orders composed of cooked ingredients; the game automatically serves them from the grid. The player's entire skill expression is **which queue to pull from, and when** — managing grid space, order demand, and ingredient supply.

- **Win**: serve all N customers of the level.
- **Lose**, one of four reasons: a cooked ingredient has no free grid cell to land in (`grid-overflow`); a dirty dish has no free grid cell to land in (`dirty-overflow`); the queues run dry with orders still outstanding and nothing left in flight — the OutOfIngredient event's default handler (`out-of-ingredient`); or a customer's patience timer expires (`customer-timeout`).
- **Save Me**: on any loss, the player may be offered one more chance instead of the plain failure screen (see §2.6) — accepting collapses the grid into a backpack and resumes play, so a "loss" isn't always final.

## 2. Core Loop

```
pick queue top → (prepare → cook, timed) → cooked ingredient(s) land on grid
                                              ↓ (automatic)
customer order needs matched from grid → dish completes → customer pays & leaves
                                              ↓
                     dirty dish returns to grid (stacks) → cleaned by sweeper / staff
```

### 2.1 Ingredient queues

- The level has **X queues** (initial design: 3), up to 5.
- Only the **top item** of each queue can be picked (unless the Ingredient Pick booster is armed — see §2.6). The rest of the visible window is preview-only; everything deeper is hidden.
- **Visible row window** is a per-map setting (`visibleRows`, default **3** = 1 pickable front row + 2 preview rows), not a fixed constant — a designer can widen or narrow how much lookahead a map gives the player.
- Queue items are typed:
  - **Ingredient** — a raw ingredient id from the map's ingredient set.
  - **Sweeper** — a utility object; picking it skips the cook pipeline and instantly clears the **oldest dirty-dish stack** (the whole stack).
  - *(extensible — future object types may be added)*
- Queue items may carry **effects** (see §5), e.g. Freeze, HoldingKey.

#### 2.1.1 Combined and linked slots

Two neighboring queue items can be grouped so they behave as more than independent single slots — authored in Design mode by multi-selecting cells and choosing Combine or Link (see [ToolDesign.md](ToolDesign.md)). Grouping is geometry over the dense queue grid (column = queue index, row = depth, 0 = front); it's stored separately from the queue contents so the two-string round-trip stays exact even with no groups authored (see §7.1).

- **Combined**: a 4-connected block of cells (any shape, can span several columns and rows) that moves and is picked **as one rigid unit**. If any of its cells can't rise, none of it does — and the plain cells behind it, in every column it occupies, are blocked too, so a stuck block can leave a visible hole in the queue. Picking it from any of its front-row columns dispatches every member at once.
- **Linked**: a chain of 2+ cells, **one per column**, spanning a single unbroken run of **adjacent** columns (Design mode's Link action refuses any other shape — two cells in the same column, a gap between columns, or more than one cell per column). Unlike Combined, linking **never restricts movement** — each member rises independently at its own pace. The whole chain is pickable only once **every** member has reached its column's front row; then all of them fly together in one pick. The UI draws a rope between each pair of column-adjacent members so the player can see how far apart a chain's members currently are.
- A hand-authored level string can in principle describe a linked chain that isn't one-per-column/contiguous (the data model itself doesn't enforce it), but Design mode's own authoring tool never produces one — the constraint is a UX guardrail, not a simulation invariant.

### 2.2 Cooking tools

- Each map defines its **cooking tools** (`cooking-tools.json`). A tool has an integer id, name, **number of slots**, a **cooking time**, and a list of **recipes** mapping one raw ingredient to what comes out and **how many pieces** (e.g. the Cutting Board turns 1 tomato into 2 tomato slices).
- Picking an ingredient sends it to the tool that has a recipe for it. **An ingredient with no recipe in any tool needs no processing** and goes straight to the grid (Map 1: Ice, Chili Bowl, Cheese Sauce).
- A recipe may be a **chain**: `chainTools` lists further tool ids the ingredient hops through, in order, after the first one, before its final output is produced (e.g. Map 1's Potato: Cutting Board, then Fryer, then 2 pieces). Each hop still takes that tool's own `cookingTime`; if the next tool in the chain has no free slot, the item just waits at its current tool and retries every tick until one opens up — it never spills onto the grid mid-chain.
- A tool processes as many ingredients at once as it has slots. **When every slot is busy**, behaviour follows a per-level toggle:
  - **Block the pick** (default) — the queue tile cannot be picked until a slot frees.
  - **Park raw on the grid** — the raw ingredient goes to the grid and waits; the moment a slot opens, parked raws are checked **first** and moved into the tool ahead of any new pick.
- **A tool with no ingredient in the current level's queues is greyed out** in Play mode's tool bar (not clickable-relevant, purely informational) — see [ToolDesign.md](ToolDesign.md).
- **Speed** is a single option group: **×1 / ×2 / ×3 / Skip**. Skip resolves everything instantly with no animation.

Map 1 tools: **Griddle** (2 slots, 3s — patty → cooked patty, egg → fried egg), **Coca Machine** (1 slot, 2s — cup → soda), **Cutting Board** (1 slot, 1s — bun → 1 sliced bun; tomato, lettuce, onion, cheese, chive → 2 pieces each; potato → chains to the Fryer, see above), **Fryer** (1 slot, 1s — chicken wing/thigh/nugget → 1 piece each; also potato's second chain step), **Flour** (1 slot, 1s, no recipes yet).

### 2.2.1 Movement and timing

Every hand-off is a **flight**: the item is shown travelling from one place to the next, and **the next logic step only runs when it lands**. Arriving in a tool slot is what starts cooking; arriving on the grid is what triggers order matching; arriving at a customer is what fills the dish. The flights are queue→tool, queue→grid, tool→grid, tool→tool (a chained recipe's mid-hop, §2.2), grid→tool (a parked raw being reclaimed), grid→customer, and backpack→customer (Save Me, §2.7).

**Skip-the-grid direct serving**: before a freshly finished tool output (or a no-tool-needed queue pick) lands on the grid, the sim checks whether an active customer's dish already wants it right now (their base requirement met, not already covered by another in-flight serve). If so, it flies **straight to that customer** (`tool-to-customer` / `queue-to-customer`) instead of landing on the grid at all. A **multi-use** ingredient (`usageNum > 1`, see §2.4) always lands on the grid instead, so the rest of its uses aren't thrown away on a single direct serve.

### 2.3 Output grid

- A **W×H grid** (initial design: 5×2) holds cooked ingredients waiting to be served.
- Placement is automatic: **first free cell in scan order** (left→right, top→bottom). A free cell is blank — not blocked, not locked, not occupied by a cooked ingredient or dirty stack.
- Cells have a **cell type** (blank / blocked / locked / …, see §5). Blocked cells never accept items; locked cells accept items only after being unlocked (e.g. by a key-holder ingredient).
- If a cooked ingredient finishes and **no free cell exists → lose**.

### 2.4 Customers & serving

- Customers arrive in a **designer-configured order**.
- There are **1–2 concurrent serveable slots** (per-level config). Customers beyond the serveable slots may already **show their order** (so the player can plan) but **cannot be served** until a slot frees up.
- Each customer orders **one or more dishes**; each dish is an **ad-hoc list of cooked ingredient ids** (dishes are not predefined entities — the order string fully defines them). Dishes may carry effects.
- **Serving is automatic**: whenever a needed cooked ingredient is present on the grid, the system moves it to the customer's dish. Priority between concurrent customers: first-come-first-served (earlier customer slot fills first).
- Some cooked ingredients require a **base** already in the same dish before they can be served (a stacking rule): Map 1's burger toppings (Cooked Patty, Tomato Slice, Lettuce Cut, Cheese Slice, Fried Egg) need the Sliced Bun there first, and Ice needs the Soda Cup there first. `baseId` can also list **several** ids, in which case the requirement is met by **any one** of them (e.g. Chili Bowl/Cheese Sauce/Chive need any one of the four fried chicken/potato bases already in the dish, not all four). This is per-dish, not per-customer — each dish must independently have its base served before its dependents follow. A dish that orders a dependent without also ordering (at least one of) its base(s) can never complete, so designers must always pair them in the order string. See `baseId` in §4.
- Some cooked ingredients are **multi-use** (`usageNum` in §4, e.g. a shared sauce): a single instance on the grid can be served that many times before it's consumed, showing a remaining-uses badge in Play mode instead of disappearing after the first serve.
- When all dishes of a customer are complete, the customer **pays and leaves**, freeing the slot.
- Some (rare) customers have a **time limit**; failing it is a per-level designer decision (default: customer leaves unserved — configurable behavior, see events §6).

### 2.5 Dirty dishes

- Every departing (served) customer returns dirty dish(es) placed on the grid: **one per dish that contained a cooked ingredient with a defined dirty-object source** (`DirtyObjectDef.sourceCookedId`, see §4) — e.g. a customer served a burger dish AND a soda dish leaves both a dirty plate and a dirty cup. Maps that don't define any dirty-object types keep the legacy behavior: exactly one generic dirty dish per served customer, regardless of dish count.
- Dirty dishes **stack by type** in a single cell up to **N per stack** (per-level config, `dirtyStackHeight`). When a type's open stack is full, its next dirty dish starts a **new stack in the first free cell** (scan order); a different type never joins that stack. This includes multiple dishes of the same type left behind by **one** customer in the same instant — they stack together like any other same-type dishes, not one-per-cell.
- Dirty stacks **occupy grid cells** and block cooked-ingredient placement. A dirty dish with **no cell to go to → lose** (`dirty-overflow`, distinct from a cooked ingredient's `grid-overflow`).
- Cleaning:
  - **Sweeper** (queue object): instantly clears the oldest stack.
  - **Staff** (special customer type, typeId 1 — see §4/§7.3): occupies a customer slot on arrival, immediately removes up to **X oldest dirty stacks** (the 5th string field), requires no dishes, then leaves.
  - **Clean Table** booster (see §2.6): clears a designer-tunable number of stacks (or all of them) on demand.
- The dirty dish is **abstract by default** — each map can skin it per type (plate, cup, box, …) via the dirty-objects table, falling back to one generic sentinel image for maps that don't.

### 2.6 Boosters

Six game-wide booster actions, defined once for the whole game (`src/data/config/general/boosters.json`, not per-map, not Design-mode-editable — static JSON). Each level starts with its own **charge count per booster** (`boosterCharges`, default `[3,3,3,3]` — 4 entries, ids 4–5 always start at 0 charges, see below — when a level doesn't specify its own); a charge is spent only when the booster actually changes something.

| # | Name | Effect |
|---|---|---|
| 0 | **Shift-up Row** | Rotates every queue column up one instance: the front item(s) leave, everything behind shifts up, and the displaced item(s) refill at the **back** of their own column. A combined block moves as one unit and keeps its group tag; a linked member moves alone (linking never restricts movement). |
| 1 | **Ingredient Pick** | Arms a mode that expands the visible window to `numRowPick` rows (default 7) and makes **every** visible slot pickable, not just the front — including picking a combined block or a not-yet-all-front linked chain from any position. A charge is spent only on an actual successful pick; arming and then canceling (or missing) costs nothing. |
| 2 | **Clean Table** | Clears `numCleanStack` dirty stacks, oldest first; `-1` (the default) clears all of them. |
| 3 | **Auto Complete Dish** | Finishes one remaining dish of the left-most active customer. For each cooked ingredient the dish still needs, it draws from **backpack → grid → queue**, in that priority order, and the whole dish completes **atomically** — if any single ingredient can't be found anywhere, nothing is taken. A queue-sourced raw that yields more than one piece per pick is only partially consumed per use: it stays visibly in the queue, and a running tally of "parts already taken" is kept, until enough parts have accumulated to match its yield — only then is it actually removed. |
| 4 | **Refill Customer Time** | Defined (name/icon/economy fields) but **not yet wired into the sim** — `boosterCharges` never grants it any charges, so its button always renders disabled. Placeholder from the sheet's Booster_config tab. |
| 5 | **More Grid Slot** | Same as above — defined, always 0 charges, no sim behavior yet. |

Each booster row also carries **economy fields** from the sheet (`code`, `lvUnlock`, `free`, `price`, `maxAds`) — reference data only; this level-design tool has no IAP/currency system, so nothing reads them. `boosters.json` also has a `saveMeVariants` array (the sheet's two Save Me trigger conditions — out-of-slot, out-of-time — each with the same economy fields) that isn't wired into the sim's single unified `saveMe()` either; see §2.7.

### 2.7 Save Me

On any loss, instead of the plain failure screen, the player may be offered a **Save Me** rescue — as long as at least one use remains (`saveMeCount`, global param; `-1` means unlimited). Accepting:

1. Sweeps every cooked or raw ingredient off the grid into a **backpack**. A raw is converted through its own tool recipe first (so the backpack only ever holds finished cooked ids); a raw with no recipe goes in as-is. Dirty stacks are left untouched.
2. Resets every active customer's patience timer, so a `customer-timeout` loss can't immediately re-fire on the very next tick.
3. Returns the run to `playing`.

Declining shows the normal failure overlay instead. Once collapsed, the backpack is a first-class ingredient source: whenever a customer needs a cooked ingredient the backpack holds, it's served from there **before** the grid is even checked (same priority Auto Complete Dish uses) — with its own fly-to-customer animation. The backpack cell is cleared only once every item in it has been drained.

## 3. Game Structure

- **Maps**: each map defines its own set of raw ingredients, cooked ingredients, cook mappings, and visual theme (incl. dirty-dish skin).
- **Levels**: each map contains an ordered list of levels; players progress **linearly**.
- **Level scenario** (designer-configured):
  - Grid size and per-cell type/effects.
  - Number of queues and the exact ordered contents of each queue (with per-item effects).
  - The exact customer sequence with per-customer params and orders.
  - Level params: serveable slot count, dirty-stack height N, win target, etc.

## 4. Definitions & Data Model

All element definitions live in **tables** (Google Sheets-backed; table UI in the tool), each row keyed by an **integer id**.

| Table | Columns (minimum) |
|---|---|
| Raw ingredients (per map) | id, name, code, price, numSlices, icon fileId |
| Cooked ingredients (per map) | id, name, icon fileId, `baseId` (optional — another cooked ingredient id, or any one of several, required in the dish first, see §2.4), `usageNum` (optional, > 1 = can be served that many times before it's consumed, see §2.4) |
| Cooking tools (per map) | id, name, numSlots, cookingTime, recipes (in → out × amount, each optionally carrying `chainTools` — further tool ids to hop through first, see §2.2) |
| Dirty objects (per map, optional) | id, name, icon fileId, `sourceCookedId` (which cooked ingredient's presence in a dish spawns this type, see §2.5) |
| Effect/status definitions (global) | id, name, icon, description, param definitions `<name, data-type>` |
| Grid cell types (global) | id, name, icon, description, param definitions `<name, data-type>` |
| Customer types (global) | id, name, icon, description, param definitions `<name, data-type>` |
| Boosters (global, static) | id, name, icon, description, param definitions `<name, data-type>`, plus sheet economy fields (`code`, `lvUnlock`, `free`, `price`, `maxAds` — reference only, unused by the sim) — plus a `params` block of game-wide tuning (row counts, charge counts, the backpack's icon spec, see §2.6/§2.7) and a `saveMeVariants` array (also reference only). Not sheet-live-synced and not Design-mode-editable; hand-authored/imported JSON only. |

Effect/cell-type/customer-type **definitions are metadata** (designer-editable); their **behaviors are registered in code** via extensible registries (see §5). The definitions tables mirror the designer's existing Google Sheet schema. Boosters are the one exception — game-wide, not per-map, imported from the sheet's `Booster_config` tab but not kept live-synced or Design-mode-editable.

The config lives as JSON under `src/data/config/`: cross-map tables in **`general/`** (`ingredient-statuses.json`, `cell-statuses.json`, `customer-types.json`, `key-colors.json`, `weather.json`, `emotions.json`, `tags.json`, `meta.json`, `boosters.json`, `maps.json`, `misc-definitions.json`) and one folder per map named **`map<index>-<id>/`** (`map1-burger/`, `map2-chicken_fried/`) holding that map's `map.json`, `ingredients.json`, `cooking-tools.json`, `levels.json`, and whichever of `cooked-ingredients.json`, `dishes.json`, `dirty-objects.json`, `customer-avatars.json`, `recipe-parts.json`, `misc.json` that map defines (a map missing `cooked-ingredients.json` derives its cooked set from its tools' recipe outputs instead). `misc-definitions.json`/`misc.json` hold sheet sub-tables that don't correspond to any other config file (kept for reference, not wired into any runtime type — same treatment as `dishes.json`). Every definition row carries its artwork as a Google Drive **`fileId`** plus an `emoji` fallback, with an optional bundled local image tried first. Only Map 1 is currently wired into the running tool; Map 2's config exists on disk but has no map switcher in the UI yet. Map 1's raw/cooked ingredient tables include ids 9–15, merged in from Map 2's sheet section to exercise chained recipes and multi-use serving (§2.2/§2.4) — not yet referenced by any level's queue/order data.

## 5. Effects & Extensibility

Effects can attach to **queue items**, **grid cells**, and **dishes**. Each effect instance = `effectId` + ordered param list (params typed per the definition table).

Built-in behaviors (all implemented as registry handlers so future maps can add more without touching core sim, except Freeze — see below):

| Effect | Attaches to | Behavior (current design) |
|---|---|---|
| Freeze | queue item | Cannot be picked until `param0` picks of an **adjacent** slot (4-connected in the queue grid: same column one row off, or an adjacent column same row) have happened — not just any `param0` picks anywhere. Each frozen item tracks its own remaining count, decremented by every adjacent pick, down to 0. This needs per-item state and the picked cell's coordinates, which the generic effect-registry hook can't carry, so it's special-cased directly in `sim.ts` rather than going through the registry like the others. |
| Hidden | queue item | The slot renders as `?` instead of its ingredient until it reaches the front row — or, for a member of a **combined** block, until that block fronts. Purely informational: it never blocks a pick, and it does not reveal early for the Ingredient Pick booster, so spending that booster on a `?` is a gamble. Not to be confused with combined/linked **queue groups** (§2.1.1), which are data (`QueueGroup`), not a per-item effect. |
| HoldingKey | queue item | Picking it grants one key of `param0` (colorId), which can open a matching ColorLock cell. |
| Blocked | grid cell | Cell never accepts items. |
| OrderLock | grid cell | Cell accepts items only once `param0` customers have been served. |
| Ingredient-slot | grid cell | Cell accepts items only once `param1` picks of ingredient `param0` have happened. |
| ColorLock | grid cell | Cell accepts items only once `param1` keys of color `param0` have been collected. |

Customer-type behaviors use the same registry pattern; built-ins: **normal** (orders dishes) and **staff** (clears X dirty stacks, see §2.5).

## 6. Events

The sim raises named events that levels/maps can bind handlers to (extensible):

- **OutOfIngredient** — all queues empty, nothing in flight or parked, orders remain unfilled, and the backpack (if any) is empty too. Default handler: **lose**. Future handlers: random ingredient spawn, etc. (Designers are expected to balance ingredient counts against orders; this is a safety net.)
- **GridOverflow** — a finished cooked ingredient had no free cell. Handler: lose.
- **DirtyOverflow** — a dirty dish had no free cell. Handler: lose.
- **CustomerTimeout** — a time-limited customer expired.
- **Saved** — a Save Me rescue was accepted, reversing a loss back to `playing` (see §2.7). The only place `status` ever moves backwards.
- **CustomerServed**, **LevelWin**, **LevelLose** — for UI/telemetry hooks.

## 7. Level Data — String Formats

All three level-config strings are authored/parsed by the tool and must **round-trip** (parse → serialize → identical string). General grammar: `#effectId` attaches an effect; `:param` after an effect adds one param (repeatable: `#4:1:1` = effect 4 with params [1,1]).

### 7.1 Ingredient queues

```
0,1,0%0,0,1%1,7,1,7,7$0-0,1-0;0-2,0-3$1-1,2-1
```

- `%` separates queues (columns); `,` separates items within a queue, listed front-first (row 0 first).
- Each item: `itemId` + optional effects (`1#4:5` = item 1 with effect 4, param 5).
- Sweepers and other non-ingredient objects use reserved ids in the queue-item id space (`SWEEPER_ID = -1`; mapping defined in the map's object table).
- **Combined/linked groups** (§2.1.1) are an optional trailer, `$<combinedSlots>$<linkedSlots>`, on the same string:
  - Each section lists groups separated by `;`, and each group lists its member cells separated by `,`.
  - A cell is `<x>-<y>` — `x` = column (queue index), `y` = row (0 = front); both are always non-negative, so `-` is an unambiguous separator.
  - Combined groups come first, then linked. Either (or both) sections may be empty.
  - **Both `$` sections are omitted entirely when there are no groups at all** — a group-less queue string has no trailing `$` and round-trips byte-for-byte identical to a string authored before grouping existed.
  - Example above: two combined blocks (`0-0,1-0` and `0-2,0-3`) and one linked chain (`1-1,2-1`).

### 7.2 Grid config

```
,,#4:1:1,,,,,#3#2:1,,
```

- `,` separates cells in scan order (W×H entries); empty entry = blank cell.
- Each cell: optional cell-type/effect list (`#3#2:1` = effect 3, then effect 2 with param 1).

### 7.3 Customer queue

```
0;0;0;1.0.6,0.1.2.5#4|1;0;0;;3|0;60;1;0.1.2.3.6#5:4#2:1,1.0.5.2.3|...
```

- `|` separates customers; `;` separates the customer params: `typeId ; waitTime ; weatherEff ; order [; staffAmount [; customerIndex]]`.
  - `typeId`: row id from the **customer types** definition table (§4) — `0` = Customer (orders dishes), `1` = Staff (see below); new types are just new rows plus a registered behavior, no format change needed.
  - `waitTime`: patience timer in seconds, 0 = no limit.
  - `weatherEff`: 1 = customer affected by weather (halved timer + minigame in the real game).
  - `staffAmount` (5th field, optional): for Staff, how many dirty stacks they clear on arrival (even a not-full stack counts); absent = 1. Meaningless for other types.
  - `customerIndex` (6th field, optional): row index into the customer catalog (`config/general/customers.csv`) this arrival's identity/avatar is pinned to; absent or blank = random (a Type=Normal row from the current map, chosen at render time). Writing a customerIndex with no staffAmount leaves the 5th field blank — `typeId;waitTime;weatherEff;order;;customerIndex` — the same blank-field convention Staff's empty dish list already uses.
  - (The sheet's legacy 6-param form also had `delay`, `completePrev`, `vip` — dropped from the game; the import converter strips them. The parser also still accepts the pre-typeId 3- and 4-field forms — `waitTime;weatherEff;order` and `waitTime;weatherEff;;staffAmount` — inferring `typeId` from whether the dish list is empty; re-serializing always emits the current typeId-first form.)
- The order: `,` separates dishes; inside a dish, cooked-ingredient ids are separated by `.` (e.g. `0.1.2.5`), followed by optional dish effects (`#4`). The parser also accepts legacy digit-run form (`0125#4`) when all ids are single-digit. Staff has no order (empty field between the two `;;`).

## 8. The Tool: Modes

- **Design mode**: table editors for all definition tables (§4); level editor with grid painter, queue editor (incl. combined/linked-slot authoring, §2.1.1), and customer/order editor that read/write the string formats (§7); level add/remove; per-map settings (grid size, dirty-stack height, visible-row window).
- **Play mode**: full playable simulation of a selected level with speed controls (x1/x2/x3/skip), pause/restart, the boosters panel and Save Me flow (§2.6/§2.7), an in-tool auto-play bot for quick win-rate checks (Random/Greedy strategies — no lookahead search), and a win/lose overlay with a **Next Level** shortcut on a win (when a following level exists). Cosmetic extras (e.g. rearranging grid items) don't affect sim outcome.
- **The app opens in Play mode by default.** Switching modes never re-picks a level — Design and Play mode share one "current level" selection, kept in sync in both directions.
- Runs entirely in the browser, no server. No player-progress persistence (a level's *edits* persist locally via `localStorage`, not a player's play-through state).
- **Data source**: reads live level data from a **Google Sheet** the user themselves points it at, via the Sheets API v4 with a per-user OAuth token (Google Identity Services) — there is no spreadsheet id baked into the tool's source; a "Sheet ID" field in the header starts empty and only reads/writes whatever id is pasted in, so live data is only ever available to someone who already has their project's own id. With nothing pasted in, no Google auth is attempted at all. **Writing** pushes individual sections/levels back to that same sheet, in addition to (not instead of) exporting the whole project as CSV for download. A bundled Map 1 snapshot ships with the tool so it's usable offline / with no sheet configured — see [SHEET_STRUCTURE.md](SHEET_STRUCTURE.md) for the sheet's own legacy format and how it's converted.
