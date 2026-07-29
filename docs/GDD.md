# CookOrder — Game Design Document

> Scope note: this document describes the **gameplay simulated by the web level-design tool**. The shipping game is built in Unity; this tool exists so designers can author and playtest maps/levels quickly in a browser, with data eventually synced to Google Sheets.

## 1. Overview

CookOrder is a queue-management cooking puzzle. The player pulls raw ingredients from a small number of visible queues; each pulled ingredient is automatically prepared and cooked into one or more **cooked ingredients** that land on a limited output grid. Customers arrive with orders composed of cooked ingredients; the game automatically serves them from the grid. The player's entire skill expression is **which queue to pull from, and when** — managing grid space, order demand, and ingredient supply.

- **Win**: serve all N customers of the level.
- **Lose**: an output (cooked ingredient or dirty dish) has no free grid cell to land in; or the OutOfIngredient event fires with its default handler.

## 2. Core Loop

```
pick queue top → (prepare → cook, timed) → cooked ingredient(s) land on grid
                                              ↓ (automatic)
customer order needs matched from grid → dish completes → customer pays & leaves
                                              ↓
                     dirty dish returns to grid (stacks) → cleaned by sweeper / staff
```

### 2.1 Ingredient queues

- The level has **X queues** (initial design: 3).
- Only the **top item** of each queue can be picked. The **next 2 items** are visible (preview); everything deeper is hidden.
- Queue items are typed:
  - **Ingredient** — a raw ingredient id from the map's ingredient set.
  - **Sweeper** — a utility object; picking it skips the cook pipeline and instantly clears the **oldest dirty-dish stack** (the whole stack).
  - *(extensible — future object types may be added)*
- Queue items may carry **effects** (see §5), e.g. freezed, locked, key-holder.

### 2.2 Cooking tools

- Each map defines its **cooking tools** (`cooking-tools.json`). A tool has an integer id, name, **number of slots**, a **cooking time**, and a list of **recipes** mapping one raw ingredient to what comes out and **how many pieces** (e.g. the Chopping Board turns 1 tomato into 2 tomato slices).
- Picking an ingredient sends it to the tool that has a recipe for it. **An ingredient with no recipe in any tool needs no processing** and goes straight to the grid (Map 1: Ice).
- A tool processes as many ingredients at once as it has slots. **When every slot is busy**, behaviour follows a per-level toggle:
  - **Block the pick** (default) — the queue tile cannot be picked until a slot frees.
  - **Park raw on the grid** — the raw ingredient goes to the grid and waits; the moment a slot opens, parked raws are checked **first** and moved into the tool ahead of any new pick.
- **Speed** is a single option group: **×1 / ×2 / ×3 / Skip**. Skip resolves everything instantly with no animation.

Map 1 tools: **Soda Machine** (1 slot, 2s — cup → soda), **Chopping Board** (1 slot, 1s — bun → 1 sliced bun; tomato, lettuce, onion, cheese → 2 pieces each), **Pan** (2 slots, 3s — patty → cooked patty, egg → fried egg).

### 2.2.1 Movement and timing

Every hand-off is a **flight**: the item is shown travelling from one place to the next, and **the next logic step only runs when it lands**. Arriving in a tool slot is what starts cooking; arriving on the grid is what triggers order matching; arriving at a customer is what fills the dish. The flights are queue→tool, queue→grid, tool→grid, grid→tool (a parked raw being reclaimed) and grid→customer.

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
- When all dishes of a customer are complete, the customer **pays and leaves**, freeing the slot.
- Some (rare) customers have a **time limit**; failing it is a per-level designer decision (default: customer leaves unserved — configurable behavior, see events §6).

### 2.5 Dirty dishes

- Every departing (served) customer returns **one dirty dish** placed on the grid.
- Dirty dishes **stack** in a single cell up to **N per stack** (per-level config). When a stack is full, the next dirty dish starts a **new stack in the first free cell** (scan order).
- Dirty stacks **occupy grid cells** and block cooked-ingredient placement. A dirty dish with **no cell to go to → lose**.
- Cleaning:
  - **Sweeper** (queue object): instantly clears the oldest stack.
  - **Staff** (special customer type): occupies a customer slot on arrival, immediately removes up to **X oldest dirty stacks**, requires no dishes, then leaves. Authored as a customer with an **empty dish list** (`0;0;`), since the customer string has no type field.
- The dirty dish is **abstract** — each map skins it (plate, cup, box, …).

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
| Cooked ingredients (per map) | id, name, icon fileId |
| Cooking tools (per map) | id, name, numSlots, cookingTime, recipes (in → out × amount) |
| Effect/status definitions (global) | id, name, icon, description, param definitions `<name, data-type>` |
| Grid cell types (global) | id, name, icon, description, param definitions `<name, data-type>` |
| Customer types (global) | id, name, icon, description, param definitions `<name, data-type>` |

Effect/cell-type/customer-type **definitions are metadata** (designer-editable); their **behaviors are registered in code** via extensible registries (see §5). The definitions tables mirror the designer's existing Google Sheet schema.

The config lives as JSON under `src/data/config/`: cross-map tables in **`general/`** (ingredient statuses, cell statuses, customer types, key colours, weather, emotions, meta key-values) and one folder per map named **`map<index>-<id>/`** (`map1-burger/`, `map2-chicken_fried/`) holding that map's `map.json`, `ingredients.json`, `cooked-ingredients.json`, `cooking-tools.json`, `dishes.json` and `levels.json`. Every definition row carries its artwork as a Google Drive **`fileId`** plus an `emoji` fallback.

## 5. Effects & Extensibility

Effects can attach to **queue items**, **grid cells**, and **dishes**. Each effect instance = `effectId` + ordered param list (params typed per the definition table).

Built-in behaviors (initial set; all implemented as registry handlers so future maps can add more without touching core sim):

| Effect | Attaches to | Behavior (default design) |
|---|---|---|
| Freezed | queue item | Cannot be picked until the player picks `param0` other items. |
| Locked | queue item | Cannot be picked until a matching key is consumed. |
| Key-holder | queue item | Picking it unlocks the matching locked cell/item (`param0` = lock id). |
| Blocked | grid cell | Cell never accepts items. |
| Locked | grid cell | Cell accepts items only after unlocked by key. |

Customer-type behaviors use the same registry pattern; built-ins: **normal** (orders dishes) and **staff** (clears X dirty stacks, see §2.5).

## 6. Events

The sim raises named events that levels/maps can bind handlers to (extensible):

- **OutOfIngredient** — all queues empty while orders remain unfilled. Default handler: **lose**. Future handlers: random ingredient spawn, etc. (Designers are expected to balance ingredient counts against orders; this is a safety net.)
- **GridOverflow** — an output had no free cell. Handler: lose.
- **CustomerTimeout** — a time-limited customer expired.
- **CustomerServed**, **LevelWin**, **LevelLose** — for UI/telemetry hooks.

## 7. Level Data — String Formats

All three level-config strings are authored/parsed by the tool and must **round-trip** (parse → serialize → identical string). General grammar: `#effectId` attaches an effect; `:param` after an effect adds one param (repeatable: `#4:1:1` = effect 4 with params [1,1]).

### 7.1 Ingredient queues

```
0,1#4:5,0,1%0,0,1,0%1,7,1,7,7
```

- `%` separates queues; `,` separates items within a queue (listed top-first).
- Each item: `itemId` + optional effects (`1#4:5` = item 1 with effect 4, param 5).
- Sweepers and other non-ingredient objects use reserved ids in the queue-item id space (mapping defined in the map's object table).

### 7.2 Grid config

```
,,#4:1:1,,,,,#3#2:1,,
```

- `,` separates cells in scan order (W×H entries); empty entry = blank cell.
- Each cell: optional cell-type/effect list (`#3#2:1` = effect 3, then effect 2 with param 1).

### 7.3 Customer queue

```
0;0;1.0.6,0.1.2.5#4|60;1;0.1.2.3.6#5:4#2:1,1.0.5.2.3|...
```

- `|` separates customers; `;` separates the 3 customer params: `waitTime ; weatherEff ; order`.
  - `waitTime`: patience timer in seconds, 0 = no limit.
  - `weatherEff`: 1 = customer affected by weather (halved timer + minigame in the real game).
  - (The sheet's legacy 6-param form also had `delay`, `completePrev`, `vip` — dropped from the game; the import converter strips them.)
- The order: `,` separates dishes; inside a dish, cooked-ingredient ids are separated by `.` (e.g. `0.1.2.5`), followed by optional dish effects (`#4`). The parser also accepts legacy digit-run form (`0125#4`) when all ids are single-digit.

## 8. The Tool: Modes

- **Design mode**: table editors for all definition tables (§4); level editor with grid painter, queue editor, and customer/order editor that read/write the string formats (§7); map & level management.
- **Play mode**: full playable simulation of a selected level with speed controls (x1/x2/x3/skip), restart, and win/lose reporting. Cosmetic extras (e.g. rearranging grid items) don't affect sim outcome.
- Runs entirely in the browser, no server. No player-progress persistence.
- **Data source**: the design Google Sheet (`1wayrsZlHCTtuMGD1Qft2Fmaeb19b-ULfO2F6abTlAEA`) is linked **read-only**; the tool imports its legacy formats and converts them (see [SHEET_STRUCTURE.md](SHEET_STRUCTURE.md)). **Saving exports CSV files** for download instead of writing back to the sheet. A bundled Map 1 snapshot ships with the tool for offline use.
