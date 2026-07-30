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
- Toggles queue: Freeze, HoldingKey    # from: Freeze, Link, HoldingKey
- Toggles recovery: sweeper, staff     # from: sweeper, staff
- Tension curve T(t): (0,1) (0.25,3) (0.6,8) (0.85,10) (1,3)
                                       # polyline points, t in [0,1], tension 0-10
- Notes: -                             # forced ingredients, story beats, anything special
```

## Step 1 — Load map constants (never assume; read the files)

- `src/data/config/<map>/map.json` → `gridWidth`×`gridHeight` (=`A_total` cells),
  `dirtyStackHeight` (=`N_stack`), `disabledRawIds`/`disabledCookedIds` (**exclude these ids
  from everything below**).
- `src/data/config/<map>/cooking-tools.json` → per tool: `numSlots`, `cookingTime`,
  `recipes[{in, out, amount}]`. Per raw id `i`: tool time `t_i` = its tool's `cookingTime`
  (pass-through ids with no recipe: `t_i = 0.5`), yield `y_i` = recipe `amount`,
  throughput `thr_tool = numSlots / cookingTime` items/s.
- `src/data/config/<map>/ingredients.json` + `cooked-ingredients.json` → id/name tables.
- Engine facts (fixed): queue preview = top + 2; sweeper queue id = `-1`;
  queue statuses Freeze=1 (param = **absolute total-picks threshold**, thaws when
  `picksMade >= param`), Link=2, HoldingKey=3 (param = colorId);
  cell statuses Blocked=`#1`, OrderLock=`#2:<ordersDone>`,
  IngredientSlot=`#3:<rawId>:<amount>`, ColorLock=`#4:<colorId>:<keyCount>`;
  key colors 1=Red 2=Yellow 3=Green 4=Blue 5=Purple (`general/key-colors.json`).

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
  the FIRST customer's first dish must be coverable by the first 3 visible items of the
  queues (no dead start).
- **Complication:** introduce OrderLock cells (`#2:k` with k = orders completed by then)
  and 3–4-component dishes; start timed customers if "Timed: some/most"
  (`waitTime ≈ 1.5 × dish component count × t̄`, `weatherEff=1` only when Weather≠Normal).
- **Climax:** duplicate orders that funnel through the **lowest-throughput tool**
  (smallest `thr_tool`) to congest it; if policy is park-on-grid, parked raws eat A_eff —
  keep `expected parked + dirty ≤ A_total − A_eff(t)`. Freeze a vital queue top:
  param = (cumulative picks expected at phase start) + 2. HoldingKey items must appear
  **before** the play needs their ColorLock cell open.
- **Resolution:** staff customer (`0;0;;<staffAmount>` with staffAmount = expected dirty
  stacks) and/or a sweeper (`-1`) surfacing near climax end (depth = picks-until-then);
  final 1–2 dishes short and satisfying.

## Step 5 — Conservation & deadlock checks (before compiling)

Reject/adjust the plan until ALL hold:
1. Supply: for every cooked id, `queue count × yield ≥ demand`, surplus ≤ max(2, 10%).
2. Keys: HoldingKey count per color == total ColorLock `keyCount` for that color.
3. Freeze thresholds < total picks available; not on the last copies of a needed id.
4. Peak simultaneous grid occupants (in-flight outputs + parked + dirty stacks) ≤
   `A_total − blocked − locked-at-that-time`, always ≥ 1 free.
5. Dirty capacity: `ceil(N_cust / N_stack)` stacks fit; sweepers+staffAmount cover
   whatever must be cleared before the last customers.
6. No disabled ids anywhere.

## Step 6 — Compile the three strings + level settings

- Queues (`%` between queues, `,` between items, top first):
  e.g. `0,2#1:5,1#3:1,-1%1,7,7%2,3,0` — Freeze `#1:5`, red key `#3:1`, sweeper `-1`.
- Grid (`,` between cells, row-major W×H):
  e.g. `,,#1,,,#2:2,,#4:1:1,,` — blank = normal.
- Customers (`|` between, arrival order):
  normal `waitTime;weatherEff;ids.dot.separated,dish2`, staff `0;0;;2`.
- Settings: Weather, Tag, Unlock, Serve slots, shuffleDistance (0 unless asked),
  outOfSlotPolicy.

## Step 7 — Validate & simulate (the feedback loop)

1. Write a TEMP test `src/__design_level.sim.test.ts` (never committed; delete after) that:
   - builds a `MapData` clone of the map with ONLY this level (strings from Step 6),
     runs `validateMap` → expect zero warnings;
   - runs `Simulation` (instantFlights default) with the greedy bot pattern used in
     `sim.test.ts` ("level 1_1 is winnable..."): pick whatever the active orders need,
     else tick 0.5 — record final `status`, `sim.time`, `loseReason`;
   - runs a second bot picking any legal queue round-robin (lower bound).
2. `npx vitest run src/__design_level.sim.test.ts`, then **delete the temp file**.
3. Accept if: greedy bot wins, `sim.time` within ±20% of T_target, round-robin bot's
   outcome matches the difficulty intent (should lose or barely win when P(Win) ≤ 0.8).
4. Otherwise iterate (max 3 rounds): duration off → scale Volume via Step 2; lost to
   grid/dirty overflow → raise A_eff or add recovery; too easy → add obstructions per the
   Climax rules. Re-run.

## Step 8 — Deliver the note

One markdown note (chat; also save to the scratchpad if long) containing: the filled
inputs, computed budgets (CLI_peak, C_total, N/D/I), curve point arrays, the phase-plan
table, the three strings + settings block ready to paste (Design mode sections accept
raw-string paste; strings are also shown in each section header), the checklist results
from Step 5, and the sim results from Step 7 (both bots, duration, iterations taken).
End with: "Not applied to the project — paste into the tool when ready."
