# ToolDesign

UX and interaction flow for the windows. See `CLAUDE.md` for file/function
reference; this doc focuses on what the designer sees and does.

## Shared shell (both windows)

The tool runs entirely client-side (Vite + TypeScript, no framework, no server) and currently
wires up a **single map** (Map 1 — burger); Map 2's config exists on disk but has no map picker in
the UI yet, so there's no Map dropdown.

- Header bar (`main.ts`): a **Design/Play mode toggle**, a data-origin label (`bundled Map 1
  snapshot` / `local draft` / `live Google Sheet` / an error string, each falling back to local
  data on failure), a **Sheet ID** text field, and action buttons — **Load from Sheet** (or
  **Sign in with Google** before the first successful auth), **Export CSV**, **Reset draft** —
  collapsed behind a **⋮ kebab menu** on narrow windows.
- **No spreadsheet id is checked into source.** The Sheet ID field starts empty; typing one in is
  what makes "Load from Sheet" (and the silent startup auth check) do anything at all — with
  nothing typed in, no Google auth is attempted and the tool just runs on local/bundled data. This
  is deliberate: only someone who already has their own project's spreadsheet id can pull its live
  data through this tool.
- **The app opens in Play mode by default.** Switching Design ↔ Play never re-picks a level — both
  modes share one "current level" selection that stays in sync in both directions (edit level 1_5
  in Design, switch to Play, land on 1_5).
- **Data flow**: reads go through the Sheets API v4 with a per-user OAuth token (Google Identity
  Services — no backend, no client secret); each user's own Google account access controls what
  they can read. "Save" (per-section, see below) is a **local, optimistic edit** — it commits into
  the in-memory map object and persists to `localStorage` as a draft, nothing round-trips to the
  sheet by itself. Pushing back to the actual sheet is a **separate, explicit** "Write to sheet"
  action per section/level. **Export CSV** downloads the whole project (every level + every
  definition table) as CSV files for external use, independent of both of the above.
- Per-section Undo/Redo backed by an in-memory history stack pushed on every mutating action; the
  unsaved (`🔴 Unsaved`) badge and add/remove counters are derived from the history position versus
  the last-saved position. Switching Level resets each section's history; switching *within* the
  same map keeps everything else.
- `beforeunload` guard warns if Design mode has any unsaved section.
- A plain 256px footer sits at the bottom of every page (credit line only — no controls).

## Page Layout

Design mode is a **single scrolling page**, not three separate modal windows — the "windows"
below are sections of one page, stacked top-to-bottom in the order a designer thinks through a
level and the order a player experiences it:

1. **Customer Config** (top) — who arrives, in what order, wanting what.
2. **Grid Config** (middle) — the board those orders get served onto.
3. **Ingredient Queue Reorder** (bottom) — the supply that feeds the grid.

Two bars sit above the three sections, both scoped to Design mode (not the shared header — see
Shared shell): a **map settings bar** (grid width/height, dirty-stack height, visible-row window —
applies to every level in the map) and a **level bar** (the Level picker plus per-level
weather/tag/unlock/serve-slots fields, `+ Level` / `🗑 Level`, and a **Definitions…** button opening
an overlay panel with the global effect/cell-type/customer-type tables — boosters are the one
definition table **not** here; they're static, hand-authored JSON with no in-tool editor, see
[GDD.md](GDD.md) §2.6). All three sections below share these,
but each keeps its **own** Save button, unsaved badge, and undo/redo history stack — switching
Level reloads and resets all three at once; saving one section does not touch the others' pending
edits.

**Play mode mirrors the same flow with one visual staging tier** (Customer / Serving / Grid / Queue, top-to-bottom), so a
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
- Right-click a card → context menu: **Insert Before/After** (blank customer), **Duplicate**, one
  **Set type: `<name>`** entry per row of the customer-types definition table (currently Customer
  and Staff, but this is data-driven — a new customer type is just a new definition row plus a
  registered behavior, no menu code change needed), and **Remove**. Switching to Staff clears the
  customer's dishes (a dish-less customer occupies a slot only to clear dirty stacks and needs
  nothing served); switching away from Staff seeds one blank dish if it had none.
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

- **Multiple parallel "lanes"** (queues, 1–5) laid out left-to-right as a real dense grid — column
  = queue index, row = depth (0 = front) — with short lanes padded by filler cells so every column
  lines up row-for-row. That grid is what gives a combined/linked group a meaningful (x,y)
  coordinate (see below).
  - Drag a lane's header to reorder lanes (`Sortable`, `handle: ".lane-head"`).
  - Drag tiles within/between lanes to reorder or move ingredients (per-lane `Sortable`, shared
    drag group so items cross lanes).
  - Right-click a lane's empty area → **Insert Column Left/Right** (disabled at 5), **Clear
    Queue**, **Remove Column** (disabled at 1 lane; confirms if non-empty).
  - Clicking a lane sets it "active" (highlighted) — new items (Quick Add, generator output)
    default into whichever lane was last interacted with.
- **Multi-select**: click a tile to select only it; shift-click toggles other tiles in/out of the
  same selection, across lanes. Selection is UI-only state (not an undo step) and drives Combine
  and Link (below); it clears itself once either action runs.
- **Combined and linked slots** (see [GDD.md](GDD.md) §2.1.1 for the gameplay rules) — with 2+
  tiles selected, right-click any of them for two additional menu items:
  - **Combine**: enabled only when the selection is a single 4-connected block (any shape, any
    number of columns/rows). Creates a rigid group that moves and is picked as one unit.
  - **Link**: enabled only when the selection has at most one tile per column and those columns
    form one unbroken adjacent run (no shared column, no gap). Creates a chain that's pickable
    only once every member reaches its own column's front row.
  - Both are disabled if any selected tile already belongs to a group of that kind. Selecting a
    tile that's already grouped and right-clicking instead offers **Uncombine** / **Break Link**.
  - Combined blocks get a shared tint; each *separate* combined group additionally gets its own
    rail color (cycled from a small palette) so two adjacent blocks read apart at a glance. Linked
    chains get a subtler tint plus a dashed rope drawn between each pair of column-adjacent
    members — sorted by column, not by current row, since a chain's members can independently sit
    at different depths. The rope/rail overlay is layered above each lane's own panel background
    but below the tile frames, so only the gap between two tiles actually shows a line.
- **Per-tile interaction** (right-click a tile):
  - **Insert Top** / **Insert Bottom** — opens a thumbnail picker, inserts at the front/back of
    that tile's own lane (not literally before/after the clicked tile).
  - Per-status toggles for **Freeze**, **Hidden** and **HoldingKey**. Freeze and HoldingKey expand
    to inline param inputs (thaw count, lock-color picker); **Hidden** takes no params, so it's a
    plain one-click on/off toggle. A Hidden tile keeps showing its real ingredient art here — a
    designer has to see what they authored — and is marked instead by a dashed tint plus a ❔ badge
    in the top-right corner, which coexists with Freeze's top-left badge and HoldingKey's
    bottom-right one. The `?` mask only happens in Play mode. Note this is unrelated to the
    Combine/Link grouping actions above.
  - **Remove**.
  - Hover also shows a small "X" remove button as a shortcut for the same action.
  - Visual encodes: a **frozen** tile (remaining thaw count > 0) gets an icy CSS filter and a
    corner icon; HoldingKey shows a color-tinted badge bottom-right using the exact key-color hex;
    other statuses show a small icon (+ optional param text) top-left. (Play mode additionally
    shows a live "picks left to break the ice" badge and a landing-particle burst on thaw — Design
    mode has no running sim, so it just shows the static frozen state.)
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
  runs the recipe-piece generator client-side against the orders' required piece counts, then
  round-robins the result evenly across the existing lane count so lane lengths stay balanced.
- **Shuffle Queue**: prompts for a max shuffle distance, jitters each lane's item order locally
  (does not cross lanes).
- **Zoom controls** (+/- buttons or Ctrl+scroll) resize tiles 50%–250%.
- **Recipe Pieces foldout** (collapsible, above the lanes): shows required vs. current
  ingredient-piece totals and a per-ingredient breakdown (short pieces highlighted red), plus a
  parallel **key/lock** breakdown (HoldingKey color counts vs. the grid's ColorLock
  requirements). Two independent warning badges: "Queue can't complete the level" (pieces or
  keys short) and "Key colors don't match the grid's lock amounts" (softer, shown only when
  completable but key counts are off). These recompute live as the designer edits.
- **Save Order**: same local, synchronous commit pattern as the other two sections (see Shared
  shell) — clears unsaved flags on both the live queue and the matching undo-history snapshot (so
  an immediate undo doesn't resurrect the "unsaved" look on already-saved items). A separate
  **⇪ Write to sheet** button is what actually pushes this level's data back to the linked
  spreadsheet.

## Grid Config window

Purpose: lay out the merge-grid cell types (locked, ingredient-slot, color-lock, etc.) for a
level.

- Grid rendered as a fixed `cols × rows` CSS grid of cells sized from the map's own
  `gridWidth`/`gridHeight` (a per-map setting, editable in the map settings bar — see Shared
  shell). Each cell shows a faint `(x,y)` coordinate, its type icon, and any type-specific
  decoration:
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
- **Save Grid**: same local, synchronous commit pattern as the other two sections (see Shared
  shell) — serializes cells back to the `#`-joined grid string, clears change-tracking flags, and
  syncs the undo-history snapshot that was actually saved. A separate **⇪ Write to sheet** button
  pushes this level's data back to the linked spreadsheet.
- Switching Level reuses the same map's cached ingredient pool (for ingredient-slot cells) and
  only re-parses that level's own grid string.
- In Play mode this same grid rendering sits in the **left half** of the middle panel, next to the
  Preparing/Cooking pipeline on the right — see Page Layout above.

## Play Mode

Purpose: let a designer run a level exactly as configured, at variable speed, without leaving the
tool.

- Extends Design mode's **Customer / Grid / Queue** order with one visual-only **Serving** row
  between Customer and Grid, so switching between editing and playtesting keeps the authored
  sections in the same relative positions.
- **Compact play zone**: on desktop, the zone is height-driven — it takes whatever vertical space
  is left under the header/toolbar and above the footer, then derives its width from a fixed
  **9:10** ratio (80% of the former 9:8 width). Tiles/cells/icons are
  correspondingly smaller than in Design mode so the three tiers stay legible at that narrower
  width; a true-portrait viewport (≤480px) drops the ratio and just uses the full width instead.
- **Top — Customer status**: customer arrival order is drawn right-to-left, so the first customer
  owns the far-right position. The next **three** previews sit on the left in the same draw order.
  Each preview is a half-width card with one vertical column of ordered-composite
  emojis; ingredient choices, quantities and toppings remain hidden. The estimator uses this same
  composite-only lookahead rather than treating pending orders as wholly unknown.
- **Serving row**: a compact strip between Customer status and the grid with at most five visual
  dish containers. Served ingredients fly here and merge in base-before-topping order. Once a dish
  is complete, one container (plate/cup/etc., represented by its composite icon) flies to the
  customer. A slot disappears as soon as its completed container starts that flight. Each serving
  slot is exactly one grid-cell size; the serving/grid panels have no inner padding or headings.
  This strip is presentation only and does not add inventory capacity.
- **Customer cards in Design, Play and replay** use two horizontal sections. **Info** is a narrow
  column with `#index`, wait time, weather state and a fully opaque avatar stacked vertically.
  Design-mode wait time supports horizontal mouse dragging for quick adjustment. **Orders** owns
  the dish rows; avatar art never sits behind the order ingredients.
- **Middle — Grid + Cooking tools (one panel, top/bottom in portrait)**: the grid takes most of
  the panel's height (same cell rendering as Design mode, now showing live contents — cooked
  items, parked raws, dirty stacks, lock progress — instead of edit state); cooking tools render
  below it as a **compact horizontal strip** — icon + name only, slot count and cook time move
  into the tooltip — sized to content rather than sharing a side-by-side column, since a left/right
  split would leave too little width for either half at portrait size. A tool **no ingredient in
  the current level needs** (none of its recipes' inputs appear anywhere in the level's queues —
  e.g. a placeholder tool like Flour, or a tool whose ingredients this particular level just
  doesn't use) renders **greyed out** (dimmed + desaturated), with the tooltip noting why; it's
  purely informational, tools were never clickable to begin with.
  - A **cooked ingredient** on the grid that's **multi-use** (`usageNum > 1` — a shared sauce that
    can serve several dishes before it's used up) shows a small `×N` "uses left" badge top-right
    on its cell, decrementing each time it's served instead of disappearing after the first.
- **When a tool is full**, a dropdown in the toolbar picks the behaviour: *Block the pick* (the
  queue tile is disabled with a reason tooltip) or *Park raw on the grid* (the raw ingredient
  waits on the grid, dimmed, and is pulled into the tool ahead of new picks the moment a slot
  frees).
- **Movement**: every hand-off animates as a floating item flying between the two places —
  queue→tool slot, queue→grid, tool→grid, tool→tool (a chained recipe's mid-hop, e.g. Potato:
  Cutting Board → Fryer), grid→tool (reclaiming a parked raw), grid→serving row, queue→serving row and
  tool→serving row (a direct serve that skips the grid entirely because a customer is already
  waiting — see [GDD.md](GDD.md) §2.2.1), and backpack→serving row (Save Me, below). The animation is
  the gate: cooking starts when the ingredient *arrives* in the slot, matching runs when an item
  *arrives* on the grid, and a dish fills when the piece *arrives* in its serving container.
- **Completion feedback**: when a dish is filled, its assembled container flies from the Serving
  row to the customer and fires a burst from their card. Only then may the customer row refresh,
  so a departing customer and a promoted preview never visually overlap. Customers currently in
  a serve slot are highlighted; the three previews are narrow, dimmed/dashed cards.
- **Bottom — Ingredient queues**: same grid-of-lanes layout as the Design-mode queue window
  (including combined/linked-group tints and rope/rail overlay), sized to the map's configured
  **visible-row window** (`visibleRows`). Normally only each lane's front tile is a clickable
  "pick" button (disabled + reason tooltip when blocked, e.g. still-frozen); a frozen tile also
  shows a live bottom-right badge counting down the adjacent picks still needed to break it, and
  plays a small ice-colored particle burst the instant it thaws. Remaining ingredient totals are
  deliberately not displayed because they are hidden information. Items the currently-active
  customers need are highlighted. While the **Ingredient Pick** booster is armed (below), the
  window temporarily expands and *every* visible tile becomes clickable, not just the front row.
- **Difficulty estimation retries**: preview demand is a light, configurable composite-only hint,
  not active-order weight. A failed authored-scoring run retries with grid-safe, front-loaded,
  finish-first, chain-first, scarcity and serve-window presets; only after those are exhausted are
  randomized scoring sets used. The Scoring Scenario modal exposes **Retry count** from 0–10, and
  the first successful run wins; if all attempts fail, the closest run is reported as unsolved.
- **Boosters bar**: four booster buttons (icon, name, remaining-charge badge) rendered as a
  scrollable strip **below** the three main tiers, not inside them — so it never shrinks the
  page's fixed-height layout, it's just reachable by scrolling. Shift-up Row, Clean Table, and
  Auto Complete Dish fire immediately on click; Ingredient Pick instead arms/disarms pick mode
  (click again, or a queue tile, to resolve it). A charge is only spent on an actual effect. See
  [GDD.md](GDD.md) §2.6 for what each one does.
- **Config bar folds**: the level/speed/tool-full-policy controls stretch full width but stay
  visually small and collapse behind a **▾/▸ Config** toggle; the HUD (elapsed time, served count,
  picks, weather, keys) is live game state, not config, so it never folds away. A separate
  **▾/▸ Bot** toggle (collapsed by default) reveals a playtesting panel: pick Random or Greedy,
  set a trial count, and run headless batches of the level against a **fresh Simulation per
  trial** — entirely independent of the live game on screen — reporting a win/loss tally and
  flagging a zero-win result as a possible unsolvable/too-hard level. There is no lookahead-search
  bot; only Random and Greedy strategies.
- **Speed** is a single option group — ×1 / ×2 / ×3 / **Skip** — where picking one deselects the
  others. Skip runs with **no animation at all**: flights land the instant they are created and
  cooking is fast-forwarded. Pause and Restart sit alongside.
- **On a loss**, if a Save Me use remains (see below), the overlay offers **Save Me** or **Give
  Up** instead of going straight to the failure screen.
- **Save Me**: accepting sweeps the grid's cooked/raw ingredients into a **backpack** (grid cell
  showing a backpack icon + item-count badge), converting any raw through its own recipe first,
  with a one-off fly-in animation for each swept item (not a tracked sim "flight" — the state
  change already committed synchronously, this is purely cosmetic) — then resumes play with every
  active customer's patience reset. A populated backpack renders on the grid like any other
  occupied cell and is drained automatically as a serving source, checked **before** the grid.
- A win/lose overlay appears over the whole layout when the level resolves, with the reason and a
  Restart button — plus, on a win with another level after this one in the map's level list, a
  **Next Level** button that jumps straight there (same level-selection path the Level picker
  uses). The three sections stay rendered underneath so the final board state is still visible for
  review.

## Common design patterns worth reusing

- Optimistic local edits + explicit Save, with a history stack doubling as both undo/redo and
  the source of truth for the unsaved-state badge/counters.
- Snapshot the history index being saved (not just "the current one") before save call, so a designer switching level/map mid-save doesn't corrupt state.
- Passive data refreshes (recipe counts, grid string re-fetch) are decoupled from the
  in-progress edit buffer — they never clobber unsaved local changes.
