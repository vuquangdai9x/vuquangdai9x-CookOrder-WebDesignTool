---
name: design-level
description: Auto-design a balanced CookOrder level from designer targets (winrate, duration, emotion curve). First emits a fill-in request form; when the designer sends it back filled, computes budgets from the map's config JSONs, plans the level phase by phase, compiles the three canonical level strings, validates and headless-simulates them, and delivers a level-design note. Produces a note only — never writes into the project's level data. Use when asked to design, generate, or balance a level.
---

# CookOrder Level Designer

Implements the improved version of `docs/LevelDesignProcess.md` (4-layer framework), with:
corrected engine ids/semantics, all real design levers, conservation/deadlock checks,
piecewise-linear curves (point arrays, linearly interpolated — not Bezier), and a closing
simulator feedback loop. **Output is a design note; do not modify `src/data/config/**` or
any draft.**

## Step 0 — Emit the request form

If the invocation didn't come with a filled form, reply with ONLY this form (plus one line
telling the designer to fill and send it back). Values shown are the defaults used for any
field they delete or leave blank:

```
## Level Design Request
- Map: map1-burger                     # folder under src/data/config/
- Level name: 1_16
- Target winrate P(Win): 0.75          # 0..1
- Target duration T_target: 120        # seconds
- Player capacity C_player: 4.5        # 3.5 novice / 4.5 intermediate / 5.5 expert
- Serve slots: 2                       # 1-2 concurrent serveable customers
- Queues N_queues: 3                   # 3-5
- Weather: Normal                      # Normal | Rainy | Sunny | Freeze
- Timed customers: some                # none | some | most  (waitTime + weatherEff usage)
- Out-of-slot policy: block-pick       # block-pick | park-on-grid
- Toggles grid: Blocked, OrderLock     # from: Blocked, OrderLock, IngredientSlot, ColorLock
- Toggles queue: Freeze, HoldingKey    # from: Freeze, HoldingKey (Link is retired, see Step 1)
- Toggles grouping: none               # none | combined | linked | both
- Toggles recovery: sweeper, staff     # from: sweeper, staff
- Tension curve T(t): (0,1) (0.25,3) (0.6,8) (0.85,10) (1,3)
                                       # polyline points, t in [0,1], tension 0-10
- Notes: -                             # forced ingredients, story beats, anything special
```

## Step 1 — Load map constants (never assume; read the files)

- `src/data/config/<map>/map.json` → `gridWidth`×`gridHeight` (=`A_total` cells),
  `dirtyStackHeight` (=`N_stack`), `visibleRows` (=`V_prev`, total visible queue rows —
  1 interactable front row + `visibleRows − 1` preview; default 3 if absent),
  `disabledRawIds`/`disabledCookedIds` (**exclude these ids from everything below**).
- `src/data/config/<map>/cooking-tools.json` → per tool: `numSlots`, `cookingTime`,
  `recipes[{in, out, amount}]`. Per raw id `i`: tool time `t_i` = its tool's `cookingTime`
  (pass-through ids with no recipe: `t_i = 0.5`), yield `y_i` = recipe `amount`,
  throughput `thr_tool = numSlots / cookingTime` items/s.
- `src/data/config/<map>/ingredients.json` + `cooked-ingredients.json` → id/name tables.
- `src/data/config/<map>/dirty-objects.json` (optional — Map 1 has one) → per row,
  `source` names a cooked ingredient; a served dish containing it spawns THAT dirty type
  instead of the generic sentinel. **A customer with N dishes whose cooked ids map to N
  distinct sources leaves N separate dirty items, one per type-matched dish** — this feeds
  the dirty-capacity check in Step 5, so read this file before computing it.
- Engine facts (fixed):
  - Sweeper queue id = `-1`.
  - Queue statuses: **Freeze=1** — param0 is a **thaw count of ADJACENT picks**, not a
    global total. It decrements by 1 every time the player picks a slot 4-connected to the
    frozen one (same column, one row off; or an adjacent column, same row) — picks
    elsewhere never count. **HoldingKey=3** (param = colorId) — picking it grants one key
    of that color. Effect id **2 ("Link") is retired** — it's a harmless no-op kept only so
    old data parses; it does **not** create a rope/pairing. Real slot grouping is a
    separate mechanism — see "Combined/linked slots" below.
  - Cell statuses: Blocked=`#1`, OrderLock=`#2:<ordersDone>`,
    IngredientSlot=`#3:<rawId>:<amount>`, ColorLock=`#4:<colorId>:<keyCount>`.
  - Key colors 1=Red 2=Yellow 3=Green 4=Blue 5=Purple (`general/key-colors.json`).
  - **Combined/linked slots** (queue-level grouping, independent of item effects): a
    `QueueGroup` over the dense queue grid (column = queue index, row = depth, 0 = front),
    appended to the queue string as `$<combinedSections>$<linkedSections>` — full grammar
    in [GDD.md](../../../docs/GDD.md) §7.1/§2.1.1. **Combined** = a rigid 4-connected block
    that moves/picks as one unit (blocks everything behind it in every column it touches
    until it can rise). **Linked** = a chain with exactly one cell per column across an
    unbroken run of adjacent columns; each member moves independently, and the whole chain
    is only pickable once every member has reached its own column's front row. Neither is
    a per-item effect — both are optional design levers, off by default (empty `$` sections
    / no `$` at all).

## Step 2 — Budgets (Layer 1)

- `CLI_peak = C_player − ln(P/(1−P)) / 1.5`  (P = target winrate).
- Mean component cost `t̄ = mean over planned raw picks of (t_i / y_i)` — start with the
  map-wide mean, refine after Step 4 picks actual ingredients.
- Component budget `C_total = T_target / t̄` (cooked components the level should consume).
- Choose integers `N_cust, D_avg, I_avg` with `N_cust×D_avg×I_avg ≈ C_total` (±10%);
  prefer more customers over bigger dishes for warm-up-heavy curves and the reverse for
  climax-heavy ones.

## Step 3 — Curves (piecewise-linear point arrays)

All curves are arrays of `(t, value)` pairs on normalized `t∈[0,1]`, linearly interpolated.
Derived from the designer's `T(t)`:

- `CLI(t) = 1 + (CLI_peak − 1) × T(t)/max(T)` — evaluate at T(t)'s own breakpoints to get
  CLI's point array.
- `A_eff(t) = clamp(A_total − round((A_total − 2) × T(t)/10), 2, A_total)` — min usable
  cells the plan must preserve at time t (blocked + locked + expected parked + expected
  dirty stacks all count against it).
- Phase boundaries = T(t) breakpoints, labeled in order: Warm-up, Complication, Climax,
  Resolution (merge/split if the designer supplied ≠5 points).
- CLI proxy (used for verification, computable from sim state at any moment):
  `0.6×(unfilled chips on active customers) + 0.8×(currently locked/blocked cells)
   + 1.0×(customers with a running waitTime) + 0.7×(queues whose top is obstructed)`.
  The plan should make the proxy's peak land in the Climax phase near CLI_peak.

## Step 4 — Phase plan (Layers 2+3, one table)

Fill a table with one row per phase: customer count in that phase, dish recipes (which
cooked ids, how many components), grid statuses placed, queue statuses placed, recovery
placements. Concrete rules:

- **Warm-up:** 1–2-component dishes from fast/pass-through ingredients; no obstructions;
  the FIRST customer's first dish must be coverable by the first `V_prev` visible items of
  the queues (no dead start — recall only the front row of each queue is actually pickable,
  the rest is preview).
- **Complication:** introduce OrderLock cells (`#2:k` with k = orders completed by then)
  and 3–4-component dishes; start timed customers if "Timed: some/most"
  (`waitTime ≈ 1.5 × dish component count × t̄`, `weatherEff=1` only when Weather≠Normal).
  This is also a natural place to introduce a **combined** block (if grouping is toggled
  on) — a 2–3-cell block the player must clear as a unit teaches the "these move together"
  rule before Climax relies on it.
- **Climax:** duplicate orders that funnel through the **lowest-throughput tool**
  (smallest `thr_tool`) to congest it; if policy is park-on-grid, parked raws eat A_eff —
  keep `expected parked + dirty ≤ A_total − A_eff(t)`. Freeze a vital queue top: pick a
  small `param0` (1–2) and place it so a column genuinely **adjacent** (x±1, same row —
  or the same column, next row once that row becomes front) is one the player will
  naturally pick during this phase (e.g. it's itself wanted by an active order); a Freeze
  with no realistically-adjacent traffic never thaws and is a soft-lock, not tension — the
  sim in Step 7 must actually clear it, don't just trust the arithmetic. If grouping is
  toggled on, a **linked** chain across 2–3 adjacent columns raises tension by making the
  player wait for every member to reach the front at once. HoldingKey items must appear
  **before** the play needs their ColorLock cell open.
- **Resolution:** staff customer (`0;0;;<staffAmount>` with staffAmount = expected dirty
  stacks) and/or a sweeper (`-1`) surfacing near climax end (depth = picks-until-then);
  final 1–2 dishes short and satisfying.

## Step 5 — Conservation & deadlock checks (before compiling)

Reject/adjust the plan until ALL hold:
1. Supply: for every cooked id, `queue count × yield ≥ demand`, surplus ≤ max(2, 10%).
2. Keys: HoldingKey count per color == total ColorLock `keyCount` for that color.
3. Freeze: a genuinely adjacent column (see Step 4) exists and is expected to be picked
   `param0` times before the level ends; not placed on the last copy of a needed id (a
   never-thawing frozen item that's also the only supply left is an unrecoverable
   deadlock).
4. Peak simultaneous grid occupants (in-flight outputs + parked + dirty stacks) ≤
   `A_total − blocked − locked-at-that-time`, always ≥ 1 free.
5. Dirty capacity: compute **dirty events**, not customer count — if the map has no
   `dirty-objects.json`, that's 1 event per non-staff customer (legacy generic dish); if it
   does, sum over customers of (distinct dirty-object types their filled dishes trigger,
   0 if a dish's cooked ids match no `source`). Same-type events from ANY customers stack
   together in one cell (up to `N_stack`), different types never share a stack, so capacity
   is `Σ_type ceil(events_type / N_stack)` cells across the run, not one pooled total.
   Sweepers + staffAmount must cover whatever must be cleared before the last customers.
6. Combined/linked (if grouping is toggled on): every group's cells stay within the queue
   grid's actual bounds; a linked chain has exactly one cell per column across an unbroken
   adjacent run (never two cells sharing a column, never a gap); a combined block's cells
   form one 4-connected shape. `validateMap` in Step 7 also flags a combined block that
   carries a Freeze effect on any of its own cells as an unrecoverable deadlock (a frozen
   rigid block can never rise to make room for what's behind it) — don't combine a frozen
   cell.
7. No disabled ids anywhere.

## Step 6 — Compile the three strings + level settings

- Queues (`%` between queues/columns, `,` between items within a column, front-first):
  e.g. `0,2#1:5,1#3:1,-1%1,7,7%2,3,0` — Freeze `#1:5`, red key `#3:1`, sweeper `-1`.
  - If grouping is toggled on, append `$<combinedSections>$<linkedSections>` to that same
    string (both sections use `;` between groups, `,` between a group's cells, each cell
    `<x>-<y>` with x=column, y=row/0=front — full grammar and worked examples in
    [GDD.md](../../../docs/GDD.md) §7.1). **Omit both `$` entirely when grouping is
    "none"** — a trailing empty `$$` is not the same as no `$` at all for round-tripping.
    e.g. a 2-cell combined block at (0,0)+(1,0) plus a 3-column linked chain at
    (0,1)-(1,2)-(2,1): `...$0-0,1-0$0-1,1-2,2-1`.
- Grid (`,` between cells, row-major W×H):
  e.g. `,,#1,,,#2:2,,#4:1:1,,` — blank = normal.
- Customers (`|` between, arrival order):
  normal `waitTime;weatherEff;ids.dot.separated,dish2`, staff `0;0;;2`.
- Settings: Weather, Tag, Unlock, Serve slots, shuffleDistance (0 unless asked),
  outOfSlotPolicy.

## Step 7 — Validate & simulate (the feedback loop)

1. Write a TEMP test `src/__design_level.sim.test.ts` (never committed; delete after) that:
   - builds a `MapData` clone of the map with ONLY this level (strings from Step 6), runs
     `validateMap` (from `src/data/validate.ts`) → expect zero warnings;
   - imports `runBotTrials` from `src/core/bot.ts` (the actual bot module backing Play
     mode's own auto-play panel — don't hand-roll bot logic, it already exists) and runs:
     - `runBotTrials(map, level, { type: "greedy" }, 1)` — **greedy is fully
       deterministic** (its tie-breaks have no randomness), so one trial is enough; it
       represents best-case optimal play. Record `status`, `trials[0].time`, `loseReason`.
     - `runBotTrials(map, level, { type: "random" }, 20)` — genuinely stochastic, so this
       gives a real win-rate distribution representing careless/weak play. Pass a seeded
       `rng` (e.g. a small LCG) in `opts` so re-running this check gives the same verdict
       each time. Record `wins / 20`.
2. `npx vitest run src/__design_level.sim.test.ts`, then **delete the temp file**.
3. Accept if: greedy wins, `trials[0].time` within ±20% of T_target, and the random bot's
   win rate matches the difficulty intent (should be low or zero when P(Win) ≤ 0.8 — random
   play is much weaker than the "intermediate player" P(Win) models, so it's a difficulty
   *proxy*, not a literal probability check against the target).
4. Otherwise iterate (max 3 rounds): duration off → scale Volume via Step 2; lost to
   grid/dirty overflow → raise A_eff or add recovery; a Freeze never thawed → widen its
   adjacency window (lower `param0` or reposition it, see Step 4/5); too easy → add
   obstructions per the Climax rules. Re-run.

## Step 8 — Deliver the note

One markdown note (chat; also save to the scratchpad if long) containing: the filled
inputs, computed budgets (CLI_peak, C_total, N/D/I), curve point arrays, the phase-plan
table, the three strings + settings block ready to paste (Design mode sections accept
raw-string paste; strings are also shown in each section header), the checklist results
from Step 5, and the sim results from Step 7 (both bots, duration, iterations taken).
End with: "Not applied to the project — paste into the tool when ready."
