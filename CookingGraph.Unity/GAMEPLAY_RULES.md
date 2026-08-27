# CookOrder — Cooking Graph & Play-Mode Simulation Rules

**Audience:** an agent (or engineer) building the *gameplay scene* in the Unity project.
**Status:** complete specification of the graph data model and of the play-mode simulation as
implemented in the web level-design tool. Everything below is normative — the web tool is the
reference implementation and levels are authored and balanced against it, so a Unity runtime that
diverges will disagree with every level's designed win-rate.

**Where the rules come from** (web tool, `src/`):

| Area | Source of truth |
|---|---|
| Graph schema, vertex/edge fields, invariants | `data/config/nodegraph/schema.json`, `data/nodeGraphTypes.ts` |
| Graph validation | `data/nodeGraphValidate.ts` |
| Slot trees / assembly / tracing | `data/nodeGraphResolve.ts` |
| Data-id ↔ node resolution | `data/nodeIdTable.ts` |
| Level strings (queue/grid) | `core/parser.ts` |
| Level strings (customers/dishes) | `core/nodeParser.ts` |
| Order binding + gates | `core/nodeOrder.ts` |
| Precomputed runtime index | `core/nodeIndex.ts` |
| **The simulation** | `core/nodeSim.ts` |
| Effect / cell / customer-type behaviours | `core/effects.ts`, `core/registry.ts` |
| Play-mode presentation contract | `ui/nodeplay/index.ts` |
| Booster / global params | `data/config/general/boosters.json` |

What this package already ships (see `README.md`): the graph JSON importer, `CookingGraphAsset` +
typed node ScriptableObjects (including tool slot points, `preservationSlots` and the preservation
edges, with `CookingGraphPreservation` resolving what each buffer accepts), and a translator for
each of the three level strings (`IngredientQueueTranslator`, `GridLayoutTranslator`,
`CustomerOrderTranslator`). **It does not ship a runtime simulation** — sections 5–14 are what the
gameplay scene has to implement.

---

## 1. Concept summary

CookOrder is a queue-management cooking puzzle. The player's *only* input is **which queue column
to pick from, and when**.

```
pick queue front  →  (tool: prepare/cook, timed)  →  finished ingredient lands on the prep grid
                                                        ↓ (automatic)
              an active customer's dish slot wants it   →  it flies to the customer
                                                        ↓
                    all dishes done → customer pays, leaves, drops dirty object(s) on the grid
                                                        ↓
                                        cleaned by Sweeper pick / Staff customer / Clean Table booster
```

* **Win:** every customer of the level has been served (Staff customers count as served).
* **Lose:** one of exactly four reasons — `grid-overflow`, `dirty-overflow`, `out-of-ingredient`,
  `customer-timeout` (§12).
* **Save Me** can reverse a loss one or more times (§13.2). It is the only transition that moves
  status backwards.

Two data layers:

1. **The map graph** (`Graph-1-Burger.json`, …) — ingredients, tools, recipes, dish assembly,
   dirty objects. One per map, shared by all its levels.
2. **The level** (a row of `LevelData-*.csv`) — three strings describing the queues, the grid and
   the customer sequence, plus a handful of scalars. Every integer in those strings is a **data id**
   resolved through the graph's **id table** (§3).

---

## 2. The cooking graph

A map document (`NodeGraphMap`) has: `schemaVersion`, `map` header, `idTable`, `vertices`, `edges`,
and editor-only `layout` / `notes` (the runtime ignores the last two).

### 2.1 Map header

| Field | Meaning |
|---|---|
| `id` | Stable map id (`"burger"`). |
| `name` | Display name. |
| `gridWidth`, `gridHeight` | Prep-grid size. Fixed for every level of the map. |
| `dirtyStackHeight` | Fallback stack capacity for dirty objects that don't override it. |
| `visibleRows` | Queue rows shown in Play: 1 interactable front row + previews. Presentation only. |

### 2.2 Vertex kinds

**`ingredient`** — any concrete item that can sit in a queue, on the grid, or in a dish.

| Field | Default | Rule |
|---|---|---|
| `name` | — | Graph-unique key (unique across **all** kinds — INV-NAMESPACE). |
| `displayName` | — | Player/designer facing. |
| `pickupable` | false | Can come off the ingredient queue. A pickupable is a graph leaf. |
| `usageNum` | 1 | Dish slots one landed piece can fill before it is consumed. `>1` also **disables direct-serve** for it (§11.2). |
| `price`, `code` | 0, "" | Economy / Unity-facing string id. Not read by the sim. |
| `emoji`, `localImage`, `imageURL`, `fileId` | — | Artwork fallbacks (web tool only; in Unity assign a `Sprite`). |

*Derived, not authored:* an ingredient is **servable** iff it is an option of some slot reachable
from an orderable composite. Servable-ness decides whether a produced item lands on the grid or is
auto-forwarded to the next tool (§9.3).

**`tool`** — a cooking station.

| Field | Rule |
|---|---|
| `slotConfigs[]` | The tool's **slot points**. Each is `{name, slot}` where `slot` = number of parallel **lanes** at that point. A single-input tool has one point whose `slot` is the old `numSlots`. A multi-input tool has one point per ingredient (coffee machine: `ground-coffee-container`, `cup-slot`). A tool with no configured point is treated as having one point with one lane. |
| `preservationSlots` | Extra *waiting* positions (default 0), outside the recipe layout. The ingredient(s) they accept come from the tool's `preservation` edge. |
| `cookingTime` | Default seconds per item; a process edge may override it. |
| `upgradeCosts`, `runtimeToolId` | Reference data / legacy bridge. Not read by the sim. |

**`group`** — a reusable choice set (referenced as a composite's base or topping, or nested as
another group's option).

| Field | Default | Rule |
|---|---|---|
| `minQuantity` | 0 | Minimum total picks across all options. |
| `maxQuantity` | -1 | Total picks allowed across all options; `-1` = unlimited, `1` = "exactly one". There is deliberately no SINGLE/MULTIPLE kind. |

**`composite`** — a base plus an optional topping; the assembled thing a customer receives. A
composite may be another composite's base, so assemblies nest.

| Field | Default | Rule |
|---|---|---|
| `orderable` | false | A customer may order it — a graph root. |
| `toppingRequired` | false | The topping slot must be filled (a bare base is otherwise a legal order). |
| `emoji` | — | Identifies the dish type in lists (a composite has no artwork of its own; players see the stack of its parts). |

**`dirty`** — what a served customer leaves on the grid.

| Field | Rule |
|---|---|
| `maxStack` | Max objects of this type in one grid-cell stack; blank = map `dirtyStackHeight`. |
| `runtimeDirtyId` | Legacy bridge. |

### 2.3 Edge kinds

| Kind | From → To | Cardinality | Meaning |
|---|---|---|---|
| `process` | tool → ingredient | **≤1 incoming per target** | One recipe row. Fields: `inputs[] {ingredient, slot}`, `amount` (pieces per run, default 1), `auto` (default **true**), `duration` (overrides tool `cookingTime`), `chainTools[]`. |
| `preservation` | tool → ingredient \| group | ≤1 outgoing per tool | Which ingredient (or every concrete option of a group) enters this tool's preservation buffer before its process slots. |
| `base` | composite → ingredient \| group \| composite | exactly 1 per composite | What the assembly is built on. Must be in the dish before any topping. |
| `topping` | composite → ingredient \| group \| composite | ≤1 per composite | What may go on the base. Optional. |
| `option` | group → ingredient \| group \| composite | many | One choice in a group. Field `maxQuantity` = cap on **this** option (default -1 = unlimited), independent of the group total. |
| `leavesDirty` | composite → dirty | ≤1 per composite | The dirty object a served customer leaves for this dish. Omit → the map's generic dirty dish. |

`process.inputs[].slot` is an **index into the source tool's `slotConfigs`**, i.e. which slot point
that ingredient enters.

**Two spellings of a multi-tool route — they are NOT interchangeable:**

* **`chainTools`** — one process edge listing further tools to hop through after `from`.
  **No intermediate vertex exists**, nothing touches the grid mid-route, and the whole route
  produces one output. (Burger map's potato: cutting board → fryer → 2 fries.)
* **Two process edges through a real intermediate ingredient** — used when the intermediate *is*
  an item state a designer wants to see and wire (chicken → `*-flour-coated` → fried). The
  intermediate is a genuine output that simply must not stop at the grid; the runtime forwards it
  (§9.3).

Both spellings produce exactly **one** grid landing. Getting this wrong is the most error-prone
part of a port.

### 2.4 Invariants

Errors (a map violating one is not playable):

| Id | Rule |
|---|---|
| INV-REF | Every edge endpoint / ref names a vertex declared in the same map, of an allowed kind. |
| INV-NAMESPACE | Vertex names are unique across **all** kinds. |
| INV-UNIQUE-PRODUCER | At most one process edge targets any ingredient. An ingredient with no producer must be `pickupable`. This is what makes a backward trace deterministic. |
| INV-ACYCLIC | No cycles in process/base/topping/option edges. |
| INV-TRACEABLE | Every leaf reachable from an orderable bottoms out at a pickupable ingredient. |
| INV-BASE-REQUIRED | Every composite has exactly one `base` edge. |
| INV-TOPPING-REQUIRED | A composite marked `toppingRequired` actually has a topping edge. |
| INV-GROUP-NONEMPTY | Every group has ≥1 option edge. |
| INV-GROUP-QUANTITY | `minQuantity ≥ 0` and ≤ a finite `maxQuantity`. |
| INV-DIRTY-STACK | `maxStack`, if present, is a positive integer. |
| INV-ORDER-REBUILDABLE | One ingredient must not be offered by **two slots of the same composite** (it would resolve into the wrong slot and carry a gate that never opens). Sharing across *different* orderables is fine — a bracket dish names its composite, so lookup is scoped to it. |
| INV-DISH-SINGLE-ORDERABLE | Every member of a dish belongs to the composite its outermost bracket names. |
| INV-INPUT-SLOT-RANGE | Every process input's `slot` indexes a real `slotConfigs` entry. |
| INV-INPUT-SLOT-STABLE | One ingredient always enters a given tool at the same point, across every recipe of that tool (dispatch routes by ingredient, so disagreement makes the destination undecidable). |
| INV-IDTABLE-UNIQUE / INV-IDTABLE-RESOLVES | Within a space, no two rows name the same node; every entry names an existing vertex of that space's kind. |
| INV-NO-RETIRED-IN-USE | No level string references a removed id. |

Warnings (playable but suspicious): WARN-ORPHAN-OUTPUT, WARN-UNUSED-DEAD-NODE, WARN-UNUSED-PICKUP,
WARN-UNREACHED-COMPOSITE, WARN-UNBOUNDED (uncapped group ⇒ infinite variants), WARN-EMPTY-TOOL,
WARN-DEGENERATE-CHOICE, WARN-UNTABLED-NODE, WARN-MULTI-INPUT, WARN-UNEVEN-LANES (a multi-input
recipe whose points have different lane counts — only the shared lanes can ever pair up).

---

## 3. The id table

Level strings **never** name a vertex. Every integer in a queue, grid or customer string is a
**data id** resolved through `idTable` → node name → vertex.

* Five spaces: `ingredient`, `composite`, `group`, `tool`, `dirty`.
* **The id is the row's position.** `idTable.ingredient[13]` is what queue digit `13` picks up;
  `idTable.composite[0]` is what a dish's `{c0:` names. There is no stored `id` field.
* Renaming a node touches only the table's string → committed levels are unaffected.
* Deleting/reordering a space renumbers it; the web editor migrates every level string in the same
  confirmed undo entry. Unity should treat the table as read-only data arriving with the graph.
* An id that does not resolve becomes a **reported issue**, never an exception. Malformed data must
  not crash play mode: an unresolvable queue item gets ingredient index `-1` and refuses to be
  picked with `Unknown ingredient id N`.

Unity mirror: `CookingGraphAsset.idTable` (`CookingIdTables`), lists parallel to the five spaces.

---

## 4. Level data

One level = one CSV row / one `LevelData`:

| Field | Used by the sim | Meaning |
|---|---|---|
| `id`, `name` | no | Identity. |
| `weather` | **yes** | Any value other than `"Normal"` halves the patience of customers with `weatherEff == 1`. |
| `levelTag`, `featureUnlock` | no | Metadata. |
| `serveableSlots` | **yes** | How many customers can be active (serveable) at once. |
| `shuffleDistance` | no | Generator input. |
| `queueString` | **yes** | §4.1 |
| `gridString` | **yes** | §4.2 |
| `customerString` | **yes** | §4.3 |
| `outOfSlotPolicy` | **yes** | `"block-pick"` (default) or `"park-on-grid"` (§8.3). |
| `boosterCharges` | **yes** (UI) | Starting charges per booster; default `[3,3,3,3]` (boosters 4–5 always 0). |
| `ingredientWeights`, `customerDishesSequence`, `complexityCurve`, `shuffleCurve`, `designNote`, `randomSeed`, `obstacleData` | no | Design-time records of how the level was generated. |

### 4.1 Queue string

```
0,1,0%0,0,1%1,7,1,7,7$0-0,1-0;0-2,0-3$1-1,2-1
```

* `%` separates **columns** (queues); `,` separates items within a column, **front-first**
  (row 0 = the pickable front).
* Each item is `<dataId>` plus optional effects: `1#4:5` = item id 1 carrying effect 4 with param 5.
  Effect grammar is global: `#id` attaches an effect, each `:param` appends a param (`#4:1:1`).
* **Negative ids are non-ingredient objects.** `SWEEPER_ID = -1` (the Sweeper).
* Optional trailer `$<combined>$<linked>` describes queue **groups** (§8.2): groups separated by
  `;`, member cells by `,`, each cell `<x>-<y>` (x = column, y = row, both non-negative so `-` is
  an unambiguous separator). Combined section first, then linked; **both sections are omitted
  entirely when there are no groups**, so a group-less string round-trips byte-for-byte.
* Columns may have different lengths; the runtime grid is rectangular, padded with holes (`null`)
  at the back.

### 4.2 Grid string

```
,,#4:1:1,,,,,#3#2:1,,
```

* `,` separates cells in **scan order**: left→right, top→bottom, exactly `gridWidth * gridHeight`
  entries. Cell index `i` ⇒ `x = i % gridWidth`, `y = i / gridWidth`.
* An empty entry is a blank cell; otherwise the entry is an effect list (cell type + params, §14.2).
* In Unity: `GridLayoutTranslator.Parse(gridString, graph)` — the graph overload enforces the cell
  count, fills in `width`/`height` so `CellAt(x, y)` works, and resolves Ingredient-slot cells.

### 4.3 Customer string

```
customers := customer ( "|" customer )*
customer  := typeId ";" waitTime ";" weatherEff ";" dishes [ ";" staffAmount [ ";" customerIndex ] ]
dishes    := dish ( "," dish )*
dish      := node [ "#" effectId [ ":" param ]* ]
node      := "{" kind id ":" members "}"      // kind: c = composite, g = group
members   := member ( "." member )*
member    := ingredientId | node
```

| Field | Meaning |
|---|---|
| `typeId` | Customer type: `0` = Customer (orders dishes), `1` = Staff (§11.3). |
| `waitTime` | Patience in seconds; `0` = no limit. |
| `weatherEff` | `1` = affected by weather (patience halved when `weather != "Normal"`). |
| `dishes` | `,`-separated dishes; empty for Staff. |
| `staffAmount` (5th, optional) | For Staff: how many dirty stacks they clear (absent = 1). |
| `customerIndex` (6th, optional) | Avatar/identity row pin; blank = random. Writing it with no staffAmount leaves field 5 blank: `0;0;0;{c0:17};;12`. |

Examples:

```
{c0:17.{g0:18.18.19}}    burger: sliced-bun base, 2 patties + 1 tomato from the toppings group
{c1:24.8}                soda: soda-cup base + ice (two fixed slots, no group)
{c2:{g1:26}.{g2:14}}     fried basket: one base option, one sauce option
{c3:13}                  plain fries (bare base)
{c0:17.{g0:18}}#4        a dish carrying dish-effect 4
```

* **Quantity is repetition** (`18.18` = two patties).
* The `c`/`g` prefix disambiguates nesting: composite ids and group ids live in separate spaces and
  may both be `0`.
* A dish's outermost bracket must be a **composite**.

Round-trip contract for all three formats: `serialize(parse(s)) === s` for canonical strings.
Unity already implements this in `IngredientQueueTranslator` / `CustomerOrderTranslator`.

---

## 5. Precomputed index (build once per map)

The sim never scans the graph in its hot loop. Build these once (`core/nodeIndex.ts`):

* **Interning** — dense integer indices for ingredient / tool / group / composite / dirty, plus
  name→index maps. Everything below is keyed by those.
* `producerOf[ing]` — the single process producing it (null = pickupable leaf).
* `stepsForInput[ing]` — every process that may consume it, **in graph order** (order matters:
  routing takes the first eligible one).
* `stepsOfTool[tool]` — every recipe a tool owns, deduped. Required to answer "what is this lane
  making?" on a multi-input tool.
* `toolSlots[tool]` — the **slot layout**: `points[] {name, lanes}`, `flat[] {point, lane}`
  (point-major: every lane of point 0, then of point 1, …), and `laneCount` = the widest point.
* `preservationSlots[tool]`, `preservationIngredients[tool]`, `preservationToolsForInput[ing]` —
  resolved from the preservation edge (a wired group expands to all its concrete ingredient
  options, recursively). In Unity these come straight off `ToolNodeAsset.preservationSlots` and
  `CookingGraphPreservation.BuildLookup(graph)` — do not re-derive the group expansion.
* `terminalOutput[ing]` / `terminalYield[ing]` / `chainDepth[ing]` — follow `recipeForInput` until
  the output is **servable** or nothing consumes it; yield is the product of `amount` along the
  way. This is what a pickup *actually becomes* (raw chicken breast → fried breast, not the coated
  intermediate). Must be **total on cyclic data** (visiting guard).
* `reachableOutputs[ing]` — forward-reachable bitset including itself; used for "is this pick
  wanted" and for the manual-process gate.
* `slotsOfComposite[composite]` — the **slot tree** (§6).
* `slotOf[ing]` / `placesOf[ing]` — where an ingredient may sit.
* `dirtyOf[composite]` — dirty index or -1.
* `usageNum[ing]`, `servable[ing]`, `pickupable[ing]`.

`ProcessStep` (the runtime form of a process edge) carries: `tool`, `inputs[] {ing, point}`, `out`,
`amount`, `auto` (missing in JSON ⇒ true), `duration` (`edge.duration ?? tool.cookingTime`, resolved
here so the sim never re-derives it), `chainTools[]` (dense tool indices).

---

## 6. Assembly: slot trees

`slotsOf(composite)` flattens a composite into a **flat list of slots**, however deeply composites
nest. Each `Slot`:

| Field | Meaning |
|---|---|
| `kind` | `fixed` (one concrete ingredient) or `group` (a choice set). |
| `group`, `groupPath` | Owning group and the bracket path from outermost. |
| `options[]`, `optionMax[]` | Ingredients that may fill it, and each one's per-dish cap (-1 = unlimited). |
| `maxQuantity`, `minQuantity` | Group caps (fixed slot: 1 / 0). |
| `isBase` | True when reached **entirely** through `base` edges — this is what every other slot gates on. |
| `baseOf[]`, `requiresBaseOf[]` | Composite bases this slot satisfies / that must be selected before it. |

Walk rules:

* ingredient → one `fixed` slot;
* group → recurse into non-ingredient options (keeping the bracket path); its ingredient options
  collect into one `group` slot;
* composite → walk its base with `isBase` preserved and `baseOf + this`, then walk its topping with
  `isBase = false`, `baseOf` **reset** (a topping never satisfies the parent's base) and
  `requiresBaseOf + this`;
* a `visiting` set makes the walk total on cyclic data.

Variant counting (design metric only): a fixed slot contributes 1 if base, 2 if topping
(present/absent); a group contributes the number of multisets of size `minQuantity..maxQuantity`
over its options; an uncapped group ⇒ unbounded.

---

## 7. Binding an order (dish → runtime)

`resolveOrder(dish)` reads the bracket tree directly — it is a read, not a recogniser:

* the outermost `{cN:}` names the **orderable**;
* each nested `{gN:}` must be a group this composite actually offers, nested at the right depth;
* a bare id is an ingredient, mapped to the slot of this composite that offers it.

Result — `ResolvedOrder { orderable, slots[], dirty }`, where each `ResolvedSlot` is:

* `ing` — dense ingredient index,
* `slot` — which slot of the composite's slot tree it fills,
* **`gate`** — the base slot index that must be filled first, or `-1` when this *is* the base.

`NodeDishState` then holds `filled[]` **per resolved slot** (two patties = two independent slots),
`baseIndices` = every slot sitting in the composite's base slot with `gate == -1`, and:

* `gateOpen(i)` = `slots[i].gate == -1 || some baseIndex is filled`;
* `complete` = every slot filled;
* `remaining` = the ingredient of every unfilled slot.

A dish that orders a topping without its base can never complete — the gate never opens. That is
reported as a data issue, and stalling loudly is deliberate.

Order issues (collected, never thrown): `unknown-composite/group/ingredient`, `foreign-member`,
`wrong-group`, `misnested-group`, `misnested-member`, `over-limit`, `below-group-minimum`,
`above-group-maximum`, `missing-composite-base`, `missing-topping`.

---

## 8. Runtime state

```
status         : playing | won | lost        loseReason: one of the four reasons of §12
time           : seconds elapsed
queueGrid[x][y]: column x, row y (0 = front). Rectangular; null = hole. Each cell:
                 { item (the authored QueueItem, never mutated),
                   ing (dense index, -1 = sweeper / unresolved),
                   group (index into level.queueGroups, or -1) }
tools[]        : { index, numSlots = processSlotCount + preservationSlotCount,
                   slots[] { item | null }, layout }
                 slot item: { uid, ing, elapsed, duration, chain?, completed? }
grid[]         : per cell — empty | cooked{ing, usesLeft?} | raw{ing} |
                 dirty{dirtyId, count} | backpack{items[]}
pending[] / active[] : customers; servedCount
flights[]      : items in transit (§8.1)
dirtyOrder[]   : grid cell indices of dirty stacks, oldest first
reservedCells / reservedSlots : claims held by in-flight or planned items
ctx            : { picksMade, picksByIngredient{dataId→n}, ordersCompleted, keysByColor{colorId→n} }
freezeRemaining: Map<QueueItem, remaining thaw count>
partialYield   : Auto-Complete's per-ingredient tally of a partially consumed queue pickup
```

### 8.1 Flights — every hand-off is animated

**Nothing teleports.** Every transfer creates a *flight*; the next logic step runs only when
`completeFlight(id)` lands it. This is what lets the view animate transfers while headless and
animated runs stay identical.

Flight kinds: `queue-to-tool`, `queue-to-grid`, `tool-to-grid`, `grid-to-tool`, `backpack-to-tool`,
`tool-to-tool`, `grid-to-customer`, `tool-to-customer`, `queue-to-customer`, `customer-to-grid`
(dirty dish), `dirty-to-staff`, `backpack-to-customer`.

A flight carries: `ing` (-1 for a dirty dish), `fromCell`/`toCell`, `fromTool`/`toTool`,
`toCustomer {index, dish, slot}`, `fromCustomer`, `raw`, `dirtyId`, `chain`, `step`.

**A serve flight names the exact `(customer, dish, slot)`** — so double-booking a slot is impossible
by construction rather than by arithmetic.

`instantFlights` option: `true` (the default; headless/validation) lands flights immediately; the
play view sets it **false** and lands each flight when its animation arrives.

On landing:

* `*-to-tool`: release the slot reservation and install the item — `duration` is the **destination
  tool's `cookingTime`** for a chain hop, otherwise `step.duration ?? tool.cookingTime`; a
  `grid-to-tool` / `backpack-to-tool` also clears its source cell / backpack entry.
* `queue-to-grid`: the cell becomes `raw` (parked) or `cooked` with
  `usesLeft = usageNum > 1 ? usageNum : —`.
* `tool-to-grid`: the cell becomes `cooked`.
* `customer-to-grid`: decrement that cell's pending-dirty tally, then place/increment the stack.
* `dirty-to-staff`: clear the cell, remove it from `dirtyOrder`, decrement the staff's outstanding
  count; at 0 the staff customer completes.
* `*-to-customer`: fill that dish slot (grid/backpack sources consume their cell first).

After **any** landing, if still playing: `settle()` then `checkEnd()`.

### 8.2 Queue groups

Authored as geometry over the queue grid, stored separately from the contents.

* **Combined** — a 4-connected block of cells (any shape, may span columns and rows) that moves and
  is picked **as one rigid unit**. If any of its cells can't rise, none of it does — and the plain
  cells behind it, in every column it occupies, are blocked too, so a stuck block leaves a visible
  hole. Picking it from any of its front-row columns dispatches every member at once.
* **Linked** — a chain of cells, one per column, over a contiguous run of adjacent columns.
  **Linking never restricts movement**: each member rises independently at its own pace. The chain
  is pickable only once **every** member has reached row 0; then all of them fly together in one
  pick. Draw a rope between column-adjacent members so the player sees how far apart they are.

(The authoring tool enforces the one-per-column/contiguous shape for linked chains; the data model
does not, so a hand-written string can describe an odd chain. The movement rules above still apply.)

### 8.3 Out-of-slot policy

Per level: `block-pick` (default) — a pick whose tool is full is refused; or `park-on-grid` — the
raw ingredient lands on the grid and waits, and is moved into the tool the moment a slot frees.
A **multi-cell pick (combined block or linked chain) may always park**, regardless of policy —
parking the overflow is inherent to those mechanics.

---

## 9. The tick loop

```
tick(dt):
    if status != playing: return
    if instantFlights: completeAllFlights()
    time += dt
    advanceTools(dt)
    settle()
    if instantFlights: completeAllFlights()
    advanceCustomers(dt)
    checkEnd()
```

### 9.1 `settle()` — the fixpoint

Repeat (guard: 100 iterations) until neither `servedCount` nor `flights.length` changed:

1. `advanceTools(0)` — retry completed-but-blocked lanes at zero elapsed time, so a held
   intermediate moves the instant space opens.
2. `fillSlots()` — seat pending customers while `active.length < serveableSlots`.
3. `autoServe()` — launch every legal grid/backpack → customer match.
4. `reclaimPreservedItems()` — move buffered ingredients into recipe slots.
5. `reclaimProcessableBackpackItems()`.
6. `reclaimProcessableGridItems()` — move parked raws and non-servable intermediates into a tool as
   soon as one frees (a raw wired to a preservation buffer goes there first).

Bail out immediately if the status stops being `playing`.

### 9.2 Queue gravity (`advanceQueues`)

Every **movement instance** (a lone cell, or a whole *combined* group — a linked group is **not** a
movement instance) rises toward row 0 until nothing can move.

* An instance can move up iff no member is at row 0 and every member's cell above is empty or is
  being vacated by that same instance.
* Multi-cell instances are enumerated once, from their anchor (lowest `y`, then lowest `x`).
* Run to stability (at most `height + 1` passes). Postcondition: nothing can move up.
* Called at construction (to settle authored misalignment before turn 1), after every pick, and by
  the Shift-up booster.

### 9.3 `advanceTools(dt)` — cooking runs per **lane**, not per slot

For each tool, for each lane `0..laneCount-1`:

1. Gather the filled flat slots of that lane. Skip if empty. `lead` = the first one.
2. Resolve the lane's recipe with `stepForLane` — match **all items present** against
   `stepsOfTool`, preferring a fully satisfied recipe over one that merely fits (ground coffee alone
   fits both the hot and the cool drink; the cup or teacup beside it decides). Returns null for a
   chain hop (the destination owns no recipe for what it received) and for a lane already holding a
   completed output.
3. **Waiting for a partner:** if the step isn't `laneReady` (every point it names holding its
   ingredient *in this lane*), **nothing ages** — an ingredient parked in a machine does not
   silently burn while its partner is still in the queue.
4. Otherwise add `dt` to every filled slot of the lane; the lane's age is the **minimum** elapsed
   across them. Continue while `age < lead.duration`.
5. On completion, in this order:
   * **`chainTools` hop** — if the item carries a chain with tools remaining: find a free slot at
     the next tool (**point 0**, since that tool owns no recipe for this item). If there is none,
     wait and retry next tick — the item never spills onto the grid mid-chain. Otherwise launch
     `tool-to-tool` carrying `chain.remaining.slice(1)`, and empty the lane.
   * Compute `out` / `amount` from `completed ?? chain ?? step`, defaulting to the lead item and 1.
   * **Intermediate forwarding** — `forwardStepFor(out)`: forward **iff `out` is non-servable and
     something consumes it**. A servable output always lands, even when a further recipe exists —
     it is a real item a customer may want.
     - If `amount == 1` and the next tool is full: the recipe is done but cannot advance. A tool
       **with preservation slots** keeps the concrete output visible in the producer (ground coffee
       held in the grinder): free the partner points, set `lead.ing = out`,
       `elapsed = duration`, `completed = {out, amount}`, and retry only when downstream state
       changes. Tools without preservation slots simply keep waiting in their existing
       representation.
     - Otherwise forward one piece via `tool-to-tool` (**no chain** — the destination owns a real
       recipe for it) and **park the surplus pieces on the grid** via `tool-to-grid`. (Potato → 2
       slices: one enters the fryer, the other visibly waits.) No free cell ⇒ `grid-overflow` loss.
   * **Normal output** — emit `amount` units, each independently: if `findServeTarget(out)` finds a
     waiting slot, fly `tool-to-customer` (skipping the grid); otherwise reserve a cell and fly
     `tool-to-grid`. No free cell ⇒ `grid-overflow` loss.
   * Empty the lane.

`nextCompletionIn()` (used by fast-forward / skip) returns the seconds until the next **ready** lane
finishes; partially filled multi-input lanes, and lanes holding an output they cannot discharge, are
resting points rather than pending completions.

### 9.4 Slot selection

`freeSlotFor(tool, ing, point)`:

* `point` = where this ingredient belongs (from the step); a chain hop forces point 0.
* Consider every lane's flat slot at that point that is neither occupied nor reserved.
* **Reject a lane committed to an incompatible recipe:** ask "does *some* recipe of this tool accept
  everything already in the lane **plus** the incoming item?" (Resolving the lane's recipe first and
  then testing against it is wrong — coffee alone fits both drinks, so an arbitrary choice would
  reject the teacup that decides it.)
* **Prefer partially filled compatible lanes, most-filled first**, then the lowest flat index.
  Putting the coffee in lane 0 and the cup in lane 1 deadlocks a machine that *looks* full.

`pointFor(tool, ing)` = the point named by any recipe of that tool taking `ing`
(INV-INPUT-SLOT-STABLE guarantees that is unambiguous), else 0.

### 9.5 Preservation buffers

Flat slot indices `[processSlotCount, slots.length)` are preservation positions.

* A pickup of an ingredient wired to a tool's preservation edge **always goes to that buffer first**
  (first tool in graph order with a free position). No free position ⇒ the pick is refused with
  `<Tool> preservation slots are full`.
* `reclaimPreservedItems()` moves a buffered item into a process slot as soon as a recipe of that
  tool is permitted to start and a compatible slot is free (a `tool-to-tool` flight within the tool).
* Preservation positions never cook and are excluded from `cookingCount`.

### 9.6 The `auto` gate (manual processes)

`processMayStart(step)` = `step.auto || reachesAny(step.out, demand)`, where `demand` is the bitset
of every ingredient some **active** dish still needs. So a manual recipe only starts while a seated
customer needs its output or something downstream of it.

`routingStep(ing)` = the first step of `stepsForInput[ing]` that may start.

---

## 10. Picking

### 10.1 Evaluate

`canPick(x)` and `pick(x)` share one path, so the check can never be weaker than the placement.

1. Status must be `playing`.
2. Resolve the **pick instance**: a front-row pick takes column `x` row 0 and expands to its group;
   a *linked* group whose members are not all at row 0 is **not pickable**
   (`Linked items are not all at the front`). An empty column or a hole ⇒ `Queue empty`.
   The Ingredient Pick booster picks the instance at an arbitrary `(x, y)`, bypassing the row-0 gate.
3. **Any member's effect can block the whole instance.** Freeze is checked first and specially (it
   needs the per-item remaining count); other queue effects go through their registered `canPick`.
4. `planDispatch` (§10.2) decides every member's destination; failure fails the whole pick and rolls
   back all reservations.

### 10.2 `planDispatch` — per member, in order

1. Sweeper (`kind == "sweeper"`) → plan `sweeper`.
2. Unresolved id (`ing < 0`) → refuse `Unknown ingredient id N`.
3. `pickPolicy == "wanted-only"` (opt-in; **default is `"any"`**) → refuse if nothing the item can
   become is currently demanded.
4. Ingredient wired to a preservation buffer → reserve a preservation position, else refuse.
5. Otherwise `eligible` = the steps of `stepsForInput[ing]` whose `processMayStart` is true.
   * **No steps at all** → the item needs no tool; reserve a grid cell (refuse `No free grid cell`).
   * Route into the first eligible step that has a free compatible slot → reserve it.
   * No route, and `eligible` is empty (only manual recipes, none currently wanted) → **park the raw
     on the grid even under block-pick**: this is an intentional wait, not a "tool full" error.
   * No route with eligible steps present → park only if the policy is `park-on-grid` **or** the pick
     is multi-cell; otherwise refuse `<Tool> is full` (or `... is full and the grid has no space`).

### 10.3 Apply

1. **Thaw first**, while the picked cells' neighbours are still at their pre-pick coordinates: for
   each picked cell, decrement the freeze counter of the cells at `(x-1, y)` and `(x+1, y)`.
   **Sideways only** — a frozen slot rides its own lane forward as the items ahead of it are taken,
   so counting same-lane picks would thaw every frozen slot for free just by emptying its queue.
   *(This narrows `docs/GDD.md`'s "4-connected" wording; the code is the contract.)*
2. Clear the picked cells, then run gravity — before dispatching, so nothing re-entrant can observe
   a half-picked instance or the same cell twice.
3. Run each member's `onPick` effect handler.
4. Dispatch each member:
   * sweeper → `clearDirtyStacks(1)` (the oldest stack, whole, instantly);
   * otherwise `picksMade++`, `picksByIngredient[dataId]++`, then
     - tool → `queue-to-tool`;
     - grid non-raw → **direct-serve if someone is already waiting** (`queue-to-customer`), else
       `queue-to-grid`;
     - raw → `queue-to-grid` with `raw = true`.
5. With `instantFlights`, `settle()` **then** land the flights — an all-sweeper pick launches no
   flights, and the stack it just cleared still has to trigger reclaim/serve.

### 10.4 Hidden slots

`isHidden(x, y)` is **geometric**, not a `canPick` test (reveal must be monotonic — an already
revealed slot must not flip back to `?` when the board fills up): the cell carries the Hidden
effect, `y != 0`, and — for a member of a combined block — no member of that block is at row 0.

---

## 11. Serving

### 11.1 `autoServe()`

For every active customer, every dish, every unfilled slot, in that order (first-come-first-served —
the earlier customer slot fills first):

* skip if a serve flight already claims this exact `(customer, dish, slot)`;
* skip if `gateOpen(slot)` is false (the dish's base is not in yet);
* **check the Save Me backpack before the grid** — a backpack cell holding the ingredient launches
  `backpack-to-customer`;
* otherwise the first unreserved `cooked` cell holding it launches `grid-to-customer`.

Reserve the source cell when launching.

### 11.2 Direct serve (skip the grid)

Before a freshly finished tool output — or a no-tool-needed queue pick — lands on the grid,
`findServeTarget(ing)` looks for an active customer's unfilled, gate-open, unclaimed slot that wants
it. If one exists, the item flies **straight to that customer** (`tool-to-customer` /
`queue-to-customer`) and never touches the grid.

**A multi-use ingredient (`usageNum > 1`) never direct-serves** — it must land, or the rest of its
uses would be thrown away on a single serve.

### 11.3 Completion, multi-use, and staff

* Filling the last slot of the last dish completes the customer: remove from `active`, mark
  `justCompleted` (celebration), `servedCount++`, `ctx.ordersCompleted++`, emit `served`, then drop
  the dirty object(s) (§11.4).
* A `cooked` cell with `usesLeft > 1` decrements instead of clearing when served.
* **Staff** (`typeId == 1`) occupies a serve slot on arrival and immediately clears up to
  `staffAmount` (default 1) **oldest** dirty stacks — one `dirty-to-staff` flight per stack, and even
  a part-full stack counts — then leaves. They order nothing, stay visible in `active` while their
  stacks fly in, and **count toward `servedCount`** (and toward the level's customer total).

### 11.4 Dirty objects

* A served customer leaves **one dirty object per dish**, read off that dish's composite's
  `leavesDirty` edge; a dish whose composite has no such edge leaves nothing. A map that defines
  **no** dirty vertices at all keeps the legacy behaviour: exactly one generic dirty dish per served
  customer (`DIRTY_DISH_ID = -99`).
* Stack capacity = `dirty.maxStack ?? map.dirtyStackHeight`, at least 1. **Stacks never mix types.**
* Target choice: the **oldest** stack (scan `dirtyOrder` in order) that is of the same type, has
  `count + pending < height`, and is not currently being cleared by staff. A cell claimed by an
  in-flight dirty dish counts as a stack already — including another dish from the *same* customer,
  which is exactly what should stack together.
* Otherwise reserve the first free cell (scan order) and append it to `dirtyOrder`. **No free cell ⇒
  `dirty-overflow` loss.**
* Headless (`instantFlights`) places the dish immediately, so the next customer is only seated once
  the table is genuinely cleared — a staff member must not sweep a plate mid-air.
* `clearDirtyStacks(n)` removes the `n` oldest stacks (whole stacks); `n < 0` clears all of them.

### 11.5 Free-cell rule

`findFreeCell()` = the **first** cell index that is `empty`, not reserved, and **usable** (every cell
effect's `isUsable(ctx)` is true). Scan order is the grid string's order. Locked cells are
re-evaluated live against `ctx`, so a lock can open mid-level.

---

## 12. Win / lose

`checkEnd()` runs after each tick and after every landed flight:

* **Win** — `servedCount >= level.customers.length` ⇒ `won`.
* **`out-of-ingredient`** — all of: queues empty; `cookingCount == 0`; no flights; no `raw` cell on
  the grid; the backpack empty; and at least one customer still active. A level may bind a handler to
  this event (e.g. spawn ingredients); the **default handler loses**.
* **`grid-overflow`** — a finished cooked ingredient (or a process intermediate) had no free cell.
* **`dirty-overflow`** — a dirty dish had no free cell.
* **`customer-timeout`** — an active customer's patience reached 0 (`advanceCustomers` ticks every
  active customer with a finite timer and loses on the first expiry).

Patience: `waitTime <= 0` ⇒ infinite; `weatherEff == 1` and `level.weather != "Normal"` ⇒
`waitTime / 2`.

Events emitted for UI/telemetry: `pick`, `cooked`, `served`, `customer-arrived`, `customer-timeout`,
`dirty-added`, `dirty-cleared`, `won`, `lost`, `saved` (the log is capped at 200 entries).

---

## 13. Boosters and Save Me

Game-wide, not per map. Charges per level come from `boosterCharges` (default `[3,3,3,3]`);
**a charge is spent only when the booster actually changed something.** Global params live in
`boosters.json → params`: `numRowPick = 7`, `numCleanStack = -1`, `saveMeCount = -1` (unlimited),
plus the backpack's icon spec.

| # | Name | Behaviour |
|---|---|---|
| 0 | **Shift-up Row** | For every column, take its front movement instance (combined blocks counted once), remove them all, run gravity, then append each removed cell to the **back of its own column** (growing every column so the grid stays rectangular). No-op ⇒ no charge. |
| 1 | **Ingredient Pick** | Arms a mode that widens the visible window to `numRowPick` rows and makes **every** visible slot pickable (`pickAt(x, y)`), including a combined block or a not-yet-fronted linked chain. A charge is spent only on a successful pick; arming and cancelling is free. Hidden slots are **not** revealed by it — spending it on a `?` is a gamble. |
| 2 | **Clean Table** | `clearDirtyStacks(numCleanStack)`; `-1` = all. |
| 3 | **Auto Complete Dish** | §13.1. |
| 4 | **Refill Customer Time** | Defined (name/icon/economy) but **not wired into the sim**; always 0 charges, button always disabled. |
| 5 | **More Grid Slot** | Same — defined, always 0 charges, no sim behaviour. |

Each booster row also carries economy fields (`code`, `lvUnlock`, `free`, `price`, `maxAds`) and
`boosters.json` has a `saveMeVariants` array; both are reference data the sim does not read.

### 13.1 Auto Complete Dish

The left-most active customer, their first incomplete dish. For every unfilled slot, find a source in
strict priority **backpack → grid → queue**:

* backpack: a cell whose items contain the ingredient;
* grid: an unreserved `cooked` cell of that ingredient;
* queue: any cell whose `terminalOutput` equals the wanted ingredient — i.e. what it *would become*,
  following the whole chain, so a raw chicken breast counts toward a fried one rather than a coated
  one — taken at its **terminal yield**.

**All-or-nothing:** if any slot can't be covered from any source, nothing is taken. On commit, gates
are irrelevant — the dish completes atomically. A multi-yield queue pickup is only *partially*
consumed: it stays visible in the queue and a running "parts already taken" tally is kept until
enough parts accumulate to match its yield, and only then is the tile removed. Then run gravity,
complete the customer if that was their last dish, `settle()`, `checkEnd()`.

### 13.2 Save Me

Offered on **any** loss while uses remain (`saveMeCount`; `-1` = unlimited). Accepting:

1. Sweep every `cooked` and `raw` cell into a **backpack** cell (a multi-use item contributes
   `usesLeft` separate entries). Items keep their processing state — a raw in the backpack can fly
   back to a tool later, under the same `auto` gate as a grid item. Dirty stacks are untouched. The
   backpack goes into an existing backpack cell, else the first free cell, else the first cell that
   was just cleared.
2. Reset every active customer's patience to full, so a `customer-timeout` can't instantly re-fire.
3. `status = playing`, `loseReason = null`, `saveMeUsed++`, emit `saved`.

Declining shows the normal failure overlay. Once collapsed, the backpack is a first-class ingredient
source: it is checked **before** the grid on every serve, and it is drained item by item (the cell
clears only when its last item leaves).

---

## 14. Effects, cell types, customer types

All three are **designer data + code-registered behaviour**. Unknown ids must resolve to a permissive
no-op (an unknown *cell* effect leaves the cell **usable**) — designer data must never crash the sim.

Shared context available to handlers: `picksMade`, `picksByIngredient[dataId]`, `ordersCompleted`,
`keysByColor[colorId]`.

### 14.1 Queue-item effects

| Id | Name | Behaviour |
|---|---|---|
| 0 | None | — |
| 1 | **Freeze** | `param0` = thaw count. Cannot be picked until that many picks have happened in an **adjacent column at the same row** (left/right only). Per-item remaining count, decremented on every adjacent pick. Special-cased in the sim (it needs per-item state plus the picked coordinates), not a generic registry handler. |
| 2 | **Hidden** | Renders as `?` until it reaches row 0 (or, inside a combined block, until that block fronts). Never blocks a pick. |
| 3 | **HoldingKey** | Picking it grants one key of colour `param0`, which opens matching ColorLock cells. |

### 14.2 Grid-cell effects (cell types)

| Id | Name | Usable when |
|---|---|---|
| 0 | Normal | always |
| 1 | **Blocked** | never (label `blocked`) |
| 2 | **OrderLock** | `ordersCompleted >= param0` (label `n/param0 orders`) |
| 3 | **Ingredient-slot** | `picksByIngredient[param0] >= param1` (label `n/param1`) |
| 4 | **ColorLock** | `keysByColor[param0] >= param1` (label `n/param1 keys`) |

### 14.3 Customer types

| Id | Name | Behaviour |
|---|---|---|
| 0 | Customer | Orders dishes. |
| 1 | **Staff** | Clears `staffAmount` oldest dirty stacks on arrival, orders nothing, leaves at once (§11.3). |

Dish effects exist in the format (`{c0:…}#4`) and travel with the dish; no built-in dish-effect
behaviour is wired today.

---

## 15. Presentation contract (what the scene must show)

From the reference play view (`ui/nodeplay/index.ts`) — match these or levels will read differently:

* **Tick**: 100 ms of simulated time per step, multiplied by the speed factor. Speeds
  **×1 / ×2 / ×3 / Skip**, factors `1 / 2 / 3 / 30`. Skip resolves everything with no readable
  animation.
* **Flights are animated** (`instantFlights = false`); base flight duration ≈ 420 ms divided by the
  speed factor. The model does not change until the animation lands — that is what makes movement
  readable rather than a teleport.
* **Queue column** shows `visibleRows` rows: row 0 interactable, the rest preview-only; anything
  deeper is not shown. Hidden slots render `?`. Frozen slots show their remaining thaw count. Linked
  chains draw a rope between column-adjacent members; a combined block renders as one tile.
* **Tools** show their slot points and lanes (and preservation buffers separately); a tool that no
  queue item in this level can ever reach is greyed out — informational only.
* **Grid** shows cooked items (with a remaining-uses badge when `usesLeft > 1`), parked raws, dirty
  stacks with their count, locked cells with their progress label, and the backpack.
* **Customers**: `serveableSlots` active cards, each dish drawn as its slots with per-slot filled
  state (filled chips first, then still-wanted chips — slot structure is a design concern, the
  player only reads "what's left"). Patience shown only when finite.
* **Customer draw order**: gameplay reads right-to-left — customer #1 (the active customer nearest
  serving) sits at the far-right end of the row, with the rest of `active` filling leftward in
  index order. The next `CUSTOMER_PREVIEW_COUNT` (3) pending customers render further left, in the
  same order they will arrive, so the row reads as one continuous right-to-left timeline.
* **Customer preview cards**: the next 3 pending customers (not the whole queue) are shown, each
  narrower than an active card. A preview reveals only the **orderable composite identity** of each
  dish the customer will order (one icon per dish, or the customer-type icon if they have no
  dishes yet) — never the resolved ingredient slots, quantities, groups, or toppings underneath.
  Nothing about a preview is simulated early: it is drawn straight from `pending[i].dishes[].
  order.orderable`, the same order data the customer will use once seated.
* **Serving row**: a visual-only staging area between the customer row and the grid, one container
  per active (non-staff) dish, capped at `MAX_SERVING_SLOTS` (5). A container shows the dish's
  composite icon plus the ingredient icons filled so far, exactly mirroring `dish.filled`; slots
  beyond the cap collapse into a `+N more active dish(es)` badge on the last visible container.
  Ingredient flights bound for a customer land on that dish's serving container instead of the
  customer card directly. Once the dish's last slot fills (`dish.complete`), a single "plate"
  (the dish's composite icon) flies from the serving row to the customer card, then the customer
  is released to `completeFlight`'s normal rules. **This changes nothing about simulation
  capacity, timing, or completion** — `dish.filled`, `dish.complete`, and serve/win/lose logic are
  computed exactly as before; the serving row and plate flight are purely cosmetic staging on top
  of the same flight target. A relevant Unity port need only stage the same visual hand-off; it
  must not add a real queue, buffer, or delay to serving.
* **Boosters bar** with per-booster charges; ids 4–5 render disabled.
* On a loss, offer **Save Me** first while uses remain; declining shows the failure overlay.
* A win offers **Next Level** when one exists.
* Cosmetic actions (e.g. rearranging grid items) must not affect the sim outcome.

---

## 16. Determinism and edge cases

* **Determinism.** Given the same level data and the same sequence of picks (and booster uses), the
  sim is fully deterministic — there is no RNG anywhere in the loop. Preserve iteration orders: grid
  cells in index order, `dirtyOrder` oldest-first, `stepsForInput` / `stepsOfTool` in graph order,
  customers in arrival order, dish slots in resolved order, lanes in index order. Any set/dictionary
  iteration that leaks non-determinism will change outcomes.
* **Totality on bad data.** Unresolvable ids, cyclic graphs, foreign dish members — all become
  collected `issues`, never exceptions. Play mode must survive data a designer is mid-edit on.
* **Reservations** (`reservedCells`, `reservedSlots`) exist so a planned or in-flight destination
  can't be double-claimed. Every launch path that reserves must release on landing — a leaked
  reservation permanently shrinks the usable grid.
* **Guards**: `settle()` 100 iterations, `completeAllFlights()` 500 — cycles must terminate.
* **Deadlocks are real, and are a *level* fault rather than a runtime one.** A multi-input tool can
  be jammed by filling every lane of one point (all cups, no ground coffee), after which no pick ever
  routes there again; under `block-pick` the queue stops dead. The web tool ships a headless deadlock
  check for exactly this; the Unity runtime only needs to behave the same way, not to rescue the
  player.
* **`unsatisfiableSlots()`** is available as a non-hot-loop query: slots that no remaining source
  could ever fill. It is an **upper bound on reachability** — it ignores tool contention, grid space
  and the clock, so it proves unsatisfiability but never satisfiability.
* **Old-model drift.** `docs/GDD.md` in the web repo describes the pre-graph model (raw/cooked id
  pairs, `baseId` lists, per-tool `numSlots`). Where it disagrees with this document, **this document
  wins**: gates come from slot trees, tools have slot points and lanes, and dirty objects come from
  `leavesDirty` edges.

---

## 17. Worked example — the Burger map

`map`: `gridWidth 5`, `gridHeight 2`, `dirtyStackHeight 5`, `visibleRows 3`.

Id table (positions are the ids): ingredients `0 bun, 1 patty, 2 tomato, 3 lettuce, 4 onion,
5 cheese, 6 egg, 7 cup, 8 ice, … 13 potato, 14 chili-bowl, … 17 bun-sliced, 18 patty-cooked,
19 tomato-sliced, 20 lettuce-sliced, … 24 soda-cup`; composites `0 burger, 1 soda, 2 fried-basket`;
groups `0 burger-toppings, 1 fried-basket-bases, 2 fried-basket-sauces`; tools `0 griddle,
1 coca-machine, 2 cutting-board, 3 fryer, 4 flour`.

Assembly: `burger` base → `bun-sliced`, topping → group `burger-toppings`
(`patty-cooked` / `tomato-sliced` / `lettuce-sliced` / `onion-sliced` / `cheese-sliced`, each capped
at 1); `soda` base → `soda-cup`, topping → `ice` (fixed); `fried-basket` base → group
`fried-basket-bases`, topping → group `fried-basket-sauces`. `burger` leaves `dirty-plate`.

Level 1_1: `serveableSlots 2`, queues `1,0,0,1%1,0,0,1%0,1,1,0` (patty/bun columns), an all-blank
5×2 grid, customers `0;0;0;{c0:17.{g0:18}}| …` — four customers, each ordering a sliced-bun base with
one cooked patty on top.

Reading the first dish: `{c0:` = composite id 0 (`burger`) → slot tree = [base `bun-sliced`, group
slot `burger-toppings`]. Member `17` = `bun-sliced` → the base slot, `gate = -1`. Member `18` inside
`{g0:` = `patty-cooked` → the toppings slot, `gate` = the base slot index. So the patty cannot be
served until the bun is in the dish, whichever order they finish cooking in.

The Coffee map exercises the harder paths: `coffee-machine` has two slot points
(`ground-coffee-container`, `cup-slot`) with two recipes sharing the first input
(`coffee-grinded + cup → coffee-cup-cool`, `coffee-grinded + teacup → coffee-teacup-hot`), and
`coffee-grinder` has `preservationSlots: 1` wired to `coffee-bean`.

---

## 18. Implementation checklist for the gameplay scene

**Data in** — load a `CookingGraphAsset` (graph + id table) and one level row (three strings +
scalars). Parse all three with the package's translators: `IngredientQueueTranslator`,
`GridLayoutTranslator` and `CustomerOrderTranslator`, using the `CookingGraphAsset` overloads so
unresolved ids fail loudly.

**Build** — the precomputed index of §5 (dense interning, steps, slot layouts, terminal output/yield,
reachability bitsets, slot trees, `dirtyOf`, `usageNum`/`servable`/`pickupable`). Preservation is
already resolved for you: `ToolNodeAsset.preservationSlots` plus `CookingGraphPreservation`.

**Simulate** — a pure C# class with no `MonoBehaviour`, no coroutines and no `Time.deltaTime` inside:
`Tick(float dt)`, `Pick(int column)`, `PickAt(int x, int y)`, `CompleteFlight(int id)`, plus the
booster entry points `ForceShiftUp()`, `ClearDirtyStacks(int)`, `AutoCompleteDish()`,
`SaveMe(int maxUses)`. Keep it headless-testable — the web tool's headless mode
(`instantFlights = true`, `runToEnd`, `fastForward`) is how levels get validated, and Unity should be
able to do the same for regression tests.

**Present** — a view layer that reads sim state, animates flights, and calls `CompleteFlight` on
arrival (§8.1, §15). Scene objects needed: queue columns (with group ropes/blocks, hidden `?`, freeze
counters), tool stations rendering slot **points × lanes** plus preservation buffers, prep-grid cells
(cooked / raw / dirty stack + count / backpack / lock progress), customer cards with per-slot dish
chips and patience, the booster bar, speed controls, and the win/lose/Save-Me overlays.

**Verify** — a Unity run and a web-tool run of the same level with the same pick sequence must
produce the same status, the same `servedCount` and the same lose reason. When they don't, the cause
is almost always one of: the forwarding rule (§9.3), lane preference (§9.4), gate resolution (§7),
dirty-stack targeting (§11.4), or an iteration order (§16).
