# CookOrder graph authoring reference

Read this reference before creating or substantially revising a graph.

## 1. Output contract

Create one canonical JSON document named `Graph-{index}-{Name}.json` in
`src/data/config/nodegraph/maps/`. The folder is scanned automatically; a level CSV is optional.

Include these provenance fields at the top level. Keys beginning with `_` survive import/export:

```json
{
  "_note": "Short description of the menu and gameplay abstraction.",
  "_foodOrderableMap": {
    "coffee": ["hot-coffee", "iced-coffee"],
    "donut": ["donut-with-topping"]
  },
  "_derivation": [
    {
      "food": "coffee",
      "source": "https://example.com/recipe",
      "decision": "Represent milk and ice as assembly choices; omit pantry-scale water."
    }
  ],
  "_imagePolicy": {
    "provider": "OpenMoji",
    "urlPattern": "https://openmoji.org/data/color/svg/{UPPERCASE-CODEPOINT}.svg",
    "license": "CC BY-SA 4.0",
    "attribution": "OpenMoji — https://openmoji.org/"
  },
  "_visualAudit": {
    "selectionSetsReviewed": ["pickup-table", "milk-choice"],
    "combinationPreviewsReviewed": ["iced-coffee:minimum", "iced-coffee:maximum"],
    "result": "pass"
  }
}
```

`_foodOrderableMap` is the exact contract between the user's food list and the graph:

- Normalize keys to lowercase singular/common menu names while preserving the user's meaning.
- Every requested food appears exactly once as a key.
- Every mapped name resolves to an `orderable: true` composite.
- Every orderable composite appears under exactly one requested food.
- Variants are allowed only when they are recognizable versions of that food. Prefer 1–2 variants; use 3 only when the menu strongly supports it.

Do not create an unrelated orderable merely to reach the pickup target.

### Initial-data worksheet

Before creating vertices, write this compact internal table. It prevents a plausible recipe from drifting away from the user's requested menu:

| Requested family | Exact orderables | Fixed base | Required choices | Optional choices | Processes/tools | Dirty result | Assumptions/source |
|---|---|---|---|---|---|---|---|

If the user supplies orderable composite names, treat them as identifiers and initial data. Preserve them exactly unless an identifier is invalid or the user asks for renaming. A broader food such as `coffee` may infer hot/cold variants; an exact list such as `hot-coffee-latte, donut-with-topping` may not acquire unrelated variants.

## 2. Translate recipes into graph semantics

Model the smallest set of player-visible actions that still reads as the real food.

| Real-world concept | Graph representation |
|---|---|
| Raw, packaged, or prepared item the player can take | `ingredient` with `pickupable: true` |
| Observable state after work | non-pickupable `ingredient` produced by one `process` edge |
| Station or appliance | `tool` |
| Choose one or several fillings/toppings/flavors | `group` plus `option` edges |
| A built item, including a reusable subassembly | `composite` |
| Customer-facing menu item | `composite` with `orderable: true` |
| Plate, cup, tray, wrapper left after serving | `dirty` plus `leavesDirty` |

Important abstractions:

- A process edge is stored `tool → output`; its `inputs[]` names what enters the tool and which slot point it uses.
- Each produced ingredient has at most one producer. Different ways to make the same state require distinct output names.
- Use `chainTools` only when the item never becomes a selectable/visible state between stations. Use two process edges and an intermediate ingredient when the intermediate can land, wait, or matter to play.
- Avoid multi-input processes when the extra ingredients are merely pantry detail. The current simulation reads only the first declared input even though the schema can describe multiple slot points. Until that runtime limitation changes, prefer an implicit serving vessel, a prepared pickup, or sequential single-input states. Keep `WARN-MULTI-INPUT` only when the user explicitly accepts the behavior gap and record the decision in `_derivation`.
- Share ingredients and tools across foods when that reduces duplicate mechanics and remains visually readable.
- Do not mark produced ingredients pickupable simply to satisfy reachability.

Runtime-safe simplifications are part of faithful authoring, not recipe errors. Examples: prepared dough or batter instead of modeling flour, water, yeast, and proofing; an implicit cup for brewed coffee; bottled sauces as pickups; and a visible coated state only when coating is a meaningful action.

### Tool budget and reduction

Use 4–5 distinct tool vertices as a soft efficiency target. It is neither a minimum nor a maximum: a compact graph may use fewer, and a varied menu may use more than five without needing an exception.

User-specified counts take priority. Interpret “use 7 tools” as exact, “at least 6” as a minimum, and “no more than 8” as a maximum. Do not simplify below an explicit exact/minimum count or add filler above an explicit exact/maximum count merely to satisfy the 4–5 preference.

Before keeping a tool, ask whether it gives the player a distinct action, timing/capacity decision, or visible state transition. Reduce the graph when the answer is no:

- reuse one functional station for several recipe edges, such as one fryer, oven, cutting board, griddle, or beverage machine;
- make dough, batter, glaze, sauce, cold brew, or concentrate a prepared pickup when its preparation adds no useful play;
- remove pass-through stations that merely rename an ingredient;
- use `chainTools` when several real stations matter but the intermediate state never lands or waits;
- avoid dish-specific duplicates such as `burger-fryer` and `donut-fryer` when one shared `fryer` has the same interaction.

Do not merge tools when separate timing, capacity, preservation, recipe identity, or interaction improves the intended gameplay. More than five tools is valid; reduce only stations and process steps that are genuinely redundant.

### Pickup budget

Default range is 15–35 pickupable ingredients, with about 25 preferred. Count only vertices with `pickupable: true`, not intermediates.

Reach the target by adding recipe-grounded variety:

- proteins, bread/base shapes, cups/containers;
- sauces, glazes, creams, syrups, cheese, ice;
- fruits, vegetables, garnishes, sprinkles;
- recognizable flavor or temperature variants.

Every pickup must be reachable from at least one orderable. If a compact menu cannot support 15 meaningful pickups, explain the exception instead of adding nonsense.

Budget per family before sharing. A useful starting point for three families is 8–12 pickups for the main dish, 4–7 for each side/drink, plus a small shared pantry set. Recount the union after sharing and inspect `pickupCoverage` in the verifier report.

### Assembly depth

Count composite/group nodes along an assembly path from an orderable to a concrete ingredient. Aim for a maximum of 2–3. Process/tool depth is separate and may also be 1–3 when the recipe genuinely needs it.

Typical patterns:

```text
ingredient → orderable composite                         depth 1
ingredient → choice group → orderable composite          depth 2
ingredient → helper composite → orderable composite      depth 2
ingredient → group → helper composite → orderable        depth 3
```

Flatten a helper composite or group when it adds no reusable identity, choice, or base gate.

One composite may have only one base edge and one topping edge. To represent a fixed bun plus a required patty choice plus optional extras, use:

```text
patty ingredient → required patty group ┐
optional extras → bounded extras group  ├→ fillings helper → burger orderable
bun ingredient ─────────────────────────┘
```

This reaches depth 3. Do not attach two topping edges to the burger; the schema rejects that shape.

Bound groups deliberately:

- required single choice: `minQuantity: 1`, `maxQuantity: 1`;
- optional single choice: `minQuantity: 0`, `maxQuantity: 1`;
- bounded toppings: choose a gameplay cap and set every `option.maxQuantity` to `1` unless duplicates are intentional;
- use `maxQuantity: -1` only for a knowingly unbounded build-your-own menu and document the variant explosion.

## 3. Sample routing

Use the samples as vocabulary, not as validated templates. See [menu-patterns.md](menu-patterns.md) for tested replacements and a concise legacy-sample audit.

### Burger-family menus

Start from `Graph-1-Burger.json` when the foods include burgers, sandwiches, soda, fries, wings, nuggets, or other fried sides. Reuse these patterns:

- sliced bun as a fixed base;
- cooked/sliced items gathered into a toppings group;
- cup processed by a drink machine, with ice added in assembly;
- coated intermediate before frying when coating is a real state;
- a single-choice fried base group plus an optional sauces/garnish group.

### Coffee-family menus

Start from `Graph-2-Coffee.json` when the foods include coffee, tea, donuts, cupcakes, pastries, cream, fruit, or glaze. Reuse these patterns:

- grind then brew, with distinct hot/cold states; keep cups implicit while the simulation's multi-input limitation remains;
- helper composites for milk/ice/cream layers;
- baked or fried pastry bases;
- single-choice glaze/cream groups and bounded fruit/topping groups;
- nested composites only where the subassembly is reused.

For a mixed menu, keep a horizontal lane per requested food family and put truly shared tools/ingredients between the lanes they serve.

## 4. Required fields and IDs

The schema is authoritative. At minimum:

- Ingredient: `name`, `displayName`; add `pickupable`, `emoji`, `imageURL`, `usageNum`, `price`, and `code` when meaningful.
- Tool: `name`, `displayName`, `slotConfigs`, `cookingTime`; add `emoji`, capacity/upgrades/artwork as appropriate.
- Group: `name`, `displayName`, `minQuantity`, `maxQuantity`. The UI supplies the `🧩` icon.
- Composite: `name`, `displayName`, `orderable`, `emoji`; use `toppingRequired` only if an order without that slot must be illegal.
- Dirty: `name`, `displayName`, `emoji`; optionally `maxStack` and artwork.

Give every orderable exactly one `leavesDirty` edge by default. Reusing one dirty type across several orderables is fine. If a wrapped or hand-held item intentionally leaves nothing, list its name in `COOKING_GRAPH_ALLOW_CLEAN_SERVE` during verification and document the exception.

`usageNum` means how many authored dish slots one landed piece can fill before it is consumed. It is not process yield, serving quantity, stack size, or a group maximum. Default it to `1`; use a larger value only when one physical piece is intentionally shared across multiple slots.

### Node naming convention

`name` is a stable data identifier; `displayName` is presentation text. Names are globally unique across all vertex kinds.

- Use lowercase ASCII kebab-case: `coffee-bean`, not `Coffee Bean`, `coffee_bean`, or `coffeeBean`.
- Prefer singular concrete nouns for pickups: `tomato`, `burger-bun`, `vanilla-glaze`.
- Name processed ingredients as `{identity}-{state}` and keep the state last: `tomato-sliced`, `beef-patty-cooked`, `donut-fried`, `coffee-ground`. Use consistent state words across the map.
- Name tools by reusable function or station: `cutting-board`, `fryer`, `griddle`, `coffee-machine`. Avoid dish-specific names when the tool can be shared.
- Name groups by food/domain plus choice role: `burger-patty-choice`, `burger-extras`, `pastry-toppings`, `milk-choice`. Do not use `group-1` or `options` alone.
- Name helper composites for the subassembly they represent: `burger-fillings`, `iced-milk-layer`. Name orderable composites exactly after the valid supplied identifier or normalized customer-facing dish.
- Prefix dirty objects with their state and vessel: `dirty-plate`, `dirty-cold-cup`, `dirty-tray`.
- Do not encode array IDs, canvas coordinates, revisions, or creation order in names. Digits are acceptable only when they are part of the real identity, such as `donut-8-shape`.
- Add a semantic qualifier before the state when two nodes would otherwise collide: `beef-patty-cooked` and `veggie-patty-cooked`.
- Make `displayName` readable and correctly capitalized; it may contain spaces, punctuation, or native-language text without changing the stable `name`.

For an established graph with level data, treat renaming like an ID migration: update every reference and preserve `idTable` positions unless the user explicitly accepts renumbering. The verifier rejects non-kebab and generic counter names by default; list reviewed legacy exceptions in `COOKING_GRAPH_ALLOW_NONSTANDARD_NAMES`.

`idTable` arrays are positional: the array index is the runtime data ID. For a new graph, use a stable, deterministic order and include:

- every pickupable ingredient and every concrete ingredient that can fill an order slot in `idTable.ingredient`;
- every orderable composite in `idTable.composite`;
- every referenced group/tool/dirty node in its matching space.

Intermediate ingredient states that are neither pickupable nor directly servable need no ingredient ID. Once level data exists, never reorder or delete ID rows without explicitly accepting the renumbering consequence.

All six edge arrays must exist: `process`, `preservation`, `base`, `topping`, `option`, and `leavesDirty`.

## 5. Emoji and low-search artwork

Every ingredient, tool, composite, and dirty node gets an `emoji`. Reuse the same emoji only for related states that the player never has to distinguish in the same gameplay context. Selectable siblings need different fallbacks or distinct higher-priority artwork; a display name is not a gameplay visual cue. Groups use the editor's built-in `🧩`.

### Gameplay visual readability

Audit artwork by what the player sees at gameplay scale, not by whether two source files have different names.

#### Selectable ingredients

- Treat the pickup table, every group's sibling options, and any processed states that can coexist as visual comparison sets.
- Every member of a comparison set must differ through at least one immediately visible cue: silhouette/shape, dominant color, or surface texture/pattern. Prefer two cues when practical so color is not the only distinction.
- Raw, cut, coated, cooked, and fried states must visibly communicate their state change when more than one can be present together.
- Do not rely on labels, tiny garnish details, or barely different shades. If two nodes use the same emoji or image asset, they are visually identical unless a higher-priority `localImage`, `imageURL`, or `fileId` makes them clearly different.
- Keep a consistent camera angle, scale, and art style across one menu, but not at the cost of distinct silhouettes.

#### Visible combinations

- Ingredient artwork used in an assembly should have a transparent background and a tight silhouette. Reject opaque rectangles, full-plate photographs, or full-canvas layers that conceal everything below them.
- Choose complementary shapes: broad bases may sit behind, while toppings, sauces, creams, fruit, and garnish need exposed edges, holes, offsets, or texture that remain recognizable when stacked.
- No selected component may be completely covered in the minimum, typical, or maximum allowed combination. If occlusion occurs, select a different asset, use a more layer-friendly ingredient state, or reduce/restructure the combination; do not pretend the hidden choice is readable.
- A composite's `emoji` is a list/menu identifier only. Gameplay should show its ingredient layers. Do not use one final-dish image as a substitute for the assembled components, because it hides which options the player selected.
- Preview at least one bare/minimum build, one normal build, and every maximum-layer orderable. Cycle through mutually exclusive choices such as patty, milk, glaze, or fruit variants.

Record the reviewed comparison sets and combination previews in `_visualAudit`. This is a manual visual QA result; the structural verifier cannot infer silhouette, color, texture, transparency, or occlusion from a URL string.

Preferred remote artwork is OpenMoji because the URL is derived from the emoji code point rather than discovered through image search:

```text
https://openmoji.org/data/color/svg/1F354.svg   # 🍔
https://openmoji.org/data/color/svg/2615.svg    # ☕
```

Procedure:

1. Choose the emoji first.
2. Convert its Unicode code points to uppercase hexadecimal joined with `-`; omit text-presentation `FE0F` when the shorter URL is the confirmed asset.
3. Construct the OpenMoji URL and confirm it resolves with a direct open/HEAD request. This is a URL check, not a web image search.
4. Put the confirmed URL in `imageURL` for the node. If it does not resolve, omit `imageURL`; never invent a URL.
5. Record OpenMoji attribution and CC BY-SA 4.0 in `_imagePolicy` or a text note.

The app loads artwork in this order: `localImage` → `imageURL` → Drive `fileId` → `emoji`. Do not invent `localImage` paths or Drive IDs.

Graph notes can preview an image only when the complete note text is one HTTP(S) URL. Use a confirmed direct image URL as an image note near a major orderable when it helps the designer; use separate text notes for recipe rationale and attribution. Avoid one image note per node—the node artwork already covers that.

## 6. Clean left-to-right layout

The graph editor's Auto layout implements the rules below: dependency-depth columns, `_foodOrderableMap` family lanes, barycentric crossing reduction, deterministic local swaps, connected-node alignment, and rendered-card-height spacing. Run it first, then inspect dense shared-tool areas and manually adjust only when the remaining crossings need domain judgment.

1. Assign semantic columns by dependency depth. No visible edge may point left.
2. Reserve a vertical lane for each requested food family, with 180–260 px between families.
3. Within a lane, align each pickup close to the tool row that consumes it; align tool recipe rows close to their outputs.
4. Place ready ingredients immediately left of the group or composite they feed. Place helper composites before their parent orderable.
5. Place shared nodes between the lanes they serve. If one shared node creates many crossings, move it to a small shared band rather than duplicating the semantic ingredient.
6. Use roughly 260–320 px horizontal column spacing and at least 90–110 px vertical node spacing. Increase spacing for tools with many recipe rows.
7. Put dirty objects directly right of their source orderables.
8. Keep notes outside the main wire corridors.
9. Run the verifier, inspect its straight-segment crossing estimate, and reorder rows. The ratio is crossings divided by eligible pairs of non-adjacent wires, not crossings divided by wire count; this stays meaningful on high-fan-out graphs. Target zero crossings and keep the normalized ratio at or below 5% unless the remaining intersections are an intentional shared-tool hub.

Layout keys are `kind:name`, for example `ingredient:tomato` or `composite:burger`.

## 7. Verification

From the repository root, run:

```powershell
$env:COOKING_GRAPH_FILE = 'src/data/config/nodegraph/maps/Graph-4-Example.json'
$env:COOKING_GRAPH_MIN_PICKUPS = '15'
$env:COOKING_GRAPH_MAX_PICKUPS = '35'
$env:COOKING_GRAPH_MAX_CROSSING_RATIO = '0.05'
npx vitest run .agents/skills/recipe-to-cooking-graph/scripts/verify-graph.test.ts
Remove-Item Env:COOKING_GRAPH_FILE,Env:COOKING_GRAPH_MIN_PICKUPS,Env:COOKING_GRAPH_MAX_PICKUPS,Env:COOKING_GRAPH_MAX_CROSSING_RATIO
```

Override the min/max environment variables when the user explicitly requests a different pickup budget. The verifier checks:

- lossless JSON parsing and authoritative graph validation;
- pickup count;
- node-name syntax and generic counter names;
- tool count against an explicit exact/minimum/maximum constraint when configured; otherwise it reports the count without failing;
- `_foodOrderableMap` coverage and uniqueness;
- exactly one dirty result per orderable by default;
- reachability and assembly depth ≤3 by default;
- emoji/rendered-icon coverage;
- a completed `_visualAudit` record naming reviewed selection sets and combination previews; the visual judgment itself remains manual;
- complete layout, no leftward wires, and normalized estimated crossings within the configured ratio;
- must-fix warnings for dead nodes, unused pickups, orphan outputs, empty tools, untabled nodes, unreached composites, and degenerate choices.

All warnings are printed. The structurally suspicious warnings above fail automatically; allow a reviewed exception with `COOKING_GRAPH_ALLOW_WARNINGS` as a comma-separated list of invariant IDs. `WARN-UNBOUNDED`, `WARN-MULTI-INPUT`, and `WARN-UNEVEN-LANES` remain review-required but non-blocking because they can represent deliberate design tradeoffs. Prefer removing `WARN-MULTI-INPUT` while the runtime reads only its first input.

For intentionally dishless orderables, set `COOKING_GRAPH_ALLOW_CLEAN_SERVE` to a comma-separated list of exact composite names. Do not use a broad global opt-out.

For a reviewed legacy identifier that cannot yet be migrated, set `COOKING_GRAPH_ALLOW_NONSTANDARD_NAMES` to a comma-separated list of exact node names.

Tool-count environment variables are optional and should reflect only an explicit user request:

- `COOKING_GRAPH_EXACT_TOOLS=7` for an exact count;
- `COOKING_GRAPH_MIN_TOOLS=6` for a minimum;
- `COOKING_GRAPH_MAX_TOOLS=8` for a maximum.

Exact count takes precedence when more than one is set. With none set, the verifier reports tool count but does not enforce the 4–5 preference.

Then run:

```powershell
npx vitest run src/data/nodeGraphValidate.test.ts src/data/nodeGraphResolve.test.ts src/ui/nodegraph/autoLayout.test.ts
npm run typecheck
```

The final handoff reports the graph path, food-family mapping, pickup and tool counts, maximum assembly depth, error/warning counts, and crossing estimate. Cite recipe sources when browsing was used and mention OpenMoji's attribution requirement when `imageURL` values were added.
