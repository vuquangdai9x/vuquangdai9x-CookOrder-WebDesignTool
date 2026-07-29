# ToolDesign

UX and interaction flow for the windows. See `CLAUDE.md` for file/function
reference; this doc focuses on what the designer sees and does.

## Shared shell (both windows)

- Header bar: Map dropdown → Level dropdown (level list depends on chosen map), a loader label,
  an unsaved-changes indicator (`🔴 Unsaved` badge + `+N / -N` add/remove counters), a primary
  **Save** button, and a **⋮ kebab menu** for secondary actions (Undo/Redo, Clear All, etc.).
- On open: fetches dropdown data, auto-detects Map/Level from the active sheet row/selection,
  then loads that level's data.
- Switching Map or Level reloads data for the new selection and resets undo history.
- Undo/Redo: `Ctrl+Z` / `Ctrl+Y` (or Ctrl+Shift+Z), backed by an in-memory history stack pushed
  on every mutating action (`saveState(actionName, addedDelta, removedDelta)`); the add/remove
  counters and unsaved badge are derived from `historyIndex !== lastSavedHistoryIndex`.
- `beforeunload` guard warns if there's an unsaved history position.
- Save is explicit and async via `google.script.run`; nothing auto-persists to the sheet.
- A plain 256px footer sits at the bottom of every page (credit line only — no controls).

## Page Layout

Design mode is a **single scrolling page**, not three separate modal windows — the "windows"
below are sections of one page, stacked top-to-bottom in the order a designer thinks through a
level and the order a player experiences it:

1. **Customer Config** (top) — who arrives, in what order, wanting what.
2. **Grid Config** (middle) — the board those orders get served onto.
3. **Ingredient Queue Reorder** (bottom) — the supply that feeds the grid.

All three sections share the header bar's Map/Level dropdowns, but each keeps its **own**
Save button, unsaved badge, and undo/redo history stack — switching Map/Level reloads and resets
all three at once; saving one section does not touch the others' pending edits.

**Play mode mirrors the same three-tier layout** (Customer / Grid / Queue, top-to-bottom), so a
designer playtesting a level doesn't have to relearn where things are. The one structural
difference: the middle tier is **one panel split left/right**, not the grid alone —
**Grid on the left, Preparing/Cooking pipeline on the right**. It's a single section because the
two are one visual flow: a picked ingredient enters the pipeline on the right, and the cooked
result travels left onto the grid the moment it finishes, landing in the first free cell. Keeping
them side-by-side in one panel (rather than stacked as independent panels) makes that hand-off
readable at a glance instead of requiring the eye to jump between two panels' worth of state.

## Customer Config window

Purpose: build the ordered arrival sequence of customers for a level and the dish(es) each one
orders.

- Customers render as an **ordered row of cards** (left-to-right = arrival order), each
  draggable to reorder (`Sortable`), plus a trailing "+" card to append a new customer.
- Each card shows: its position number, a **wait-time** badge (patience timer; "∞" when 0), a
  **weather-effect** toggle icon (whether bad weather halves this customer's patience), and its
  dish chip rows.
- Right-click a card → context menu: **Insert Before/After** (blank customer), **Duplicate**,
  **Mark as Staff** (clears all dishes — a dish-less customer occupies a slot only to clear dirty
  stacks and needs nothing served), **Remove**.
- Staff cards render visually distinct (muted card style + apron badge) since they never show an
  order and leave immediately.
- **Per-dish editing**: each dish is a row of cooked-ingredient chips with a trailing "+" chip
  that opens the same thumbnail-grid picker style as the Ingredient Queue's Quick Add Pool. A
  trailing "+ Dish" chip under the last dish row adds another dish to that customer.
  - Right-click a chip → remove it from the dish.
  - Right-click a dish's empty area → per-effect toggles (dish effects) with inline param inputs,
    same visual language as ingredient statuses in the queue window.
- Wait-time and weather-effect are editable inline on the card (number input / toggle) — no modal
  needed for the common case.
- Cards get the same dashed change-tracking outline used in the other two windows: **green** if
  the customer is new since the last save, **yellow** if it's the same customer edited (params,
  or a dish grew), **red** if the order actually shrank — a dish or a needed cooked ingredient was
  removed. Matched by a hidden per-customer identity so drag-reordering never reads as a change.
- Live validation banner mirrors the queue window's Recipe Pieces foldout: flags cooked
  ingredients the orders need more of than the queues can currently supply, and flags orders
  referencing a cooked ingredient id that doesn't exist in the map's table.
- **Save Customers**: same optimistic local edit + explicit Save pattern as the other two
  sections — clears unsaved flags without disturbing the other sections' pending state.

## Ingredient Queue Reorder window

Purpose: build the ordered sequence of ingredients a player pulls from during a level.

- **Multiple parallel "lanes"** (queues) laid out left-to-right; each lane is an independently
  sortable grid of ingredient tiles plus a trailing "+" tile to insert.
  - Drag a lane's header to reorder lanes (`Sortable` on the lanes container).
  - Drag tiles within/between lanes to reorder or move ingredients (per-lane `Sortable`,
    shared drag group so items cross lanes).
  - Right-click a lane's empty area → **Insert Queue Left/Right**, **Clear Queue**, **Remove
    Queue** (blocked below 1 lane; confirms if non-empty).
  - Clicking a lane sets it "active" (highlighted) — new items (Quick Add, generator output)
    default into whichever lane was last interacted with.
- **Per-tile interaction**:
  - Right-click a tile → context menu: Insert Before/After (opens a mini ingredient picker),
    plus per-status toggles (Freeze, Link, HoldingKey, etc.) each with inline param inputs
    (e.g. Freeze duration, Link "broken" flag, HoldingKey lock-color picker).
  - Hover shows a small "X" remove button.
  - Visual encodes: frozen tiles get an icy CSS filter; linked tiles (not broken) draw a
    connecting "bridge" to the next linked tile in the same lane; HoldingKey shows a
    color-tinted badge bottom-right using the exact `LockColor` hex; other statuses show a
    small icon (+ optional param text) top-left.
  - Change-tracking outline, per tile: **green** if it's new since the last save, **yellow** if
    it's the same tile with a different effect. A tile has no removable children of its own, so
    it never shows red — but the **lane** it used to sit in does, if that tile left it (deleted,
    or dragged to another lane) since the save. Identity is a hidden tag on the tile/lane, so
    reordering by drag never reads as a change.
- **Remove Mode** (toggled from kebab menu): whole-canvas mode where dragging is disabled and
  clicking any tile deletes it immediately (crosshair cursor, red tint); a floating action bar
  offers **Undo All Removes** / **Done**.
- **Quick Add Pool**: slide-up bottom drawer showing every available ingredient thumbnail;
  clicking one appends it to the active lane.
- **Auto-Generate Queue** (kebab menu, green/highlighted): confirms it will overwrite all lanes,
  calls the recipe-piece generator server-side, then round-robins the result evenly across the
  existing lane count so lane lengths stay balanced.
- **Shuffle Queue**: prompts for a max shuffle distance, jitters each lane's item order locally
  (does not cross lanes, does not hit the server).
- **Zoom controls** (+/- buttons or Ctrl+scroll) resize tiles 50%–250%.
- **Recipe Pieces foldout** (collapsible, above the lanes): shows required vs. current
  ingredient-piece totals and a per-ingredient breakdown (short pieces highlighted red), plus a
  parallel **key/lock** breakdown (HoldingKey color counts vs. the grid's ColorLock
  requirements). Two independent warning badges: "Queue can't complete the level" (pieces or
  keys short) and "Key colors don't match the grid's lock amounts" (softer, shown only when
  completable but key counts are off). These recompute live as the designer edits, and are also
  refreshed passively via **Refresh Grid & Recipe Counts** without touching the in-progress queue.
- **Save Order**: pushes all lanes back to the sheet; clears unsaved flags on both the live
  queue and the matching undo-history snapshot (so an immediate undo doesn't resurrect the
  "unsaved" look on already-saved items).

## Grid Config window

Purpose: lay out the merge-grid cell types (locked, ingredient-slot, color-lock, etc.) for a
level.

- Grid rendered as a fixed `cols × rows` CSS grid of cells sized from `config.LEVEL_PATH.MAP_SIZE`.
  Each cell shows a faint `(x,y)` coordinate, its type icon, and any type-specific decoration:
  - Ingredient-slot cells (`encode 3`): corner type icon + centered ingredient thumbnail + amount
    badge bottom-right.
  - ColorLock cells (`encode 4`): color swatch behind a centered type icon + lock-amount badge.
  - Other typed cells: centered icon + any raw params shown as small badges bottom-right.
- **Click or right-click a cell** opens the same context menu: a list of all defined cell types
  (icon + name, current type highlighted) plus **Empty (0)** to clear it. Selecting a type
  swaps the cell immediately and re-renders.
  - Picking the Ingredient-slot type inline-expands an ingredient picker (thumbnail grid) and an
    amount number input.
  - Picking the ColorLock type inline-expands a lock-color swatch picker and a lock-amount
    number input.
  - Any other parameterized type shows a raw `#`-separated params text input as a fallback.
- Change-tracking outline per cell, compared position-for-position against the last save (cells
  can't reorder, so no identity tag is needed here): **green** if it was blank and now has a type,
  **yellow** if it had a type and now has a different one, **red** if it had a type and is blank
  again — the cell lost its content, even though visually that leaves it looking empty.
- Kebab menu: **Clear All** (confirms, resets every cell to empty) and Undo/Redo.
- **Save Grid** disables the Map/Level dropdowns and the button during the async save (guards
  against switching level mid-save), serializes cells back to the `#`-joined grid string, then
  clears all `isChanged` flags and syncs the undo-history snapshot that was actually saved
  (captured by index before the async call, so a level switch mid-save can't corrupt state).
- Switching Map re-fetches that map's ingredient pool (for ingredient-slot cells) separately
  from the grid string itself; switching Level with the same map reuses the cached type/pool
  definitions and only re-fetches the lightweight grid string for fast level-to-level switching.
- In Play mode this same grid rendering sits in the **left half** of the middle panel, next to the
  Preparing/Cooking pipeline on the right — see Page Layout above.

## Play Mode

Purpose: let a designer run a level exactly as configured, at variable speed, without leaving the
tool.

- Follows the same **Customer / Grid / Queue** top-to-bottom arrangement as Design mode (see
  Page Layout), so switching between editing and playtesting a level doesn't relocate anything.
- **Portrait play zone**: on desktop, the zone is height-driven — it takes whatever vertical space
  is left under the header/toolbar and above the footer, then derives its width from a fixed
  **3:4** ratio, rather than stretching full width like the toolbar does. Tiles/cells/icons are
  correspondingly smaller than in Design mode so the three tiers stay legible at that narrower
  width; a true-portrait viewport (≤480px) drops the ratio and just uses the full width instead.
- **Top — Customer status**: the serveable customers first (highlighted), then exactly **one**
  masked lookahead card marked **"?"** for whoever's next in line — their order isn't revealed
  until a serve slot actually frees up for them. All cards share a fixed-column grid (never a
  scrolling row), so the 2nd/3rd card is never accidentally clipped off-screen.
- **Middle — Grid + Cooking tools (one panel, top/bottom in portrait)**: the grid takes most of
  the panel's height (same cell rendering as Design mode, now showing live contents — cooked
  items, parked raws, dirty stacks, lock progress — instead of edit state); cooking tools render
  below it as a **compact horizontal strip** — icon + name only, slot count and cook time move
  into the tooltip — sized to content rather than sharing a side-by-side column, since a left/right
  split would leave too little width for either half at portrait size.
- **When a tool is full**, a dropdown in the toolbar picks the behaviour: *Block the pick* (the
  queue tile is disabled with a reason tooltip) or *Park raw on the grid* (the raw ingredient
  waits on the grid, dimmed, and is pulled into the tool ahead of new picks the moment a slot
  frees).
- **Movement**: every hand-off animates as a floating item flying between the two places —
  queue→tool slot, queue→grid, tool→grid, grid→tool (reclaiming a parked raw), grid→customer.
  The animation is the gate: cooking starts when the ingredient *arrives* in the slot, matching
  runs when an item *arrives* on the grid, and a dish fills when the piece *arrives* at the
  customer.
- **Completion feedback**: when a customer's whole order is filled, a burst of particles fires
  from their card and the card itself brightens then **shrinks away to nothing** — only once that
  finishes does the next customer (or the new "?" card) take its place, so the two never overlap.
  Customers currently in a serve slot are highlighted; the "?" card is dimmed/dashed.
- **Bottom — Ingredient queues**: same lane layout as the Design-mode queue window, but each
  lane's top tile is now a clickable "pick" button (disabled + reason tooltip when blocked by an
  effect like Freeze); items the currently-active customers need are highlighted.
- **Config bar folds**: the map/level/speed/tool-full-policy controls stretch full width but stay
  visually small and collapse behind a **▾/▸ Config** toggle; the HUD (elapsed time, served count,
  picks, weather, keys) is live game state, not config, so it never folds away.
- **Speed** is a single option group — ×1 / ×2 / ×3 / **Skip** — where picking one deselects the
  others. Skip runs with **no animation at all**: flights land the instant they are created and
  cooking is fast-forwarded. Pause and Restart sit alongside.
- A win/lose overlay appears over the whole layout when the level resolves, with the reason and a
  Restart button; the three sections stay rendered underneath so the final board state is still
  visible for review.

## Common design patterns worth reusing

- Optimistic local edits + explicit Save, with a history stack doubling as both undo/redo and
  the source of truth for the unsaved-state badge/counters.
- Snapshot the history index being saved (not just "the current one") before save call, so a designer switching level/map mid-save doesn't corrupt state.
- Passive data refreshes (recipe counts, grid string re-fetch) are decoupled from the
  in-progress edit buffer — they never clobber unsaved local changes.
