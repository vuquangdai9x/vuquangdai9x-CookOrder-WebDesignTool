# Recipe Graph mode — implementation plan

## Context

CookOrder's recipe rules currently live scattered across five per-map JSON tables (`ingredients`, `cooked-ingredients`, `cooking-tools`, `dirty-objects`, `map`), joined only by integer ids and an implicit `baseId` convention. Nothing shows how an order decomposes into pickups, and nothing checks that it can.

This plan adds a **Recipe Graph mode** — a fourth tab beside Design / Play / Remote Data — where a designer creates elements, wires them into one flow graph, and continuously sees the property that matters:

> Every orderable item — once its SINGLE/MULTIPLE choice groups are made concrete — traces back to pickupable ingredients through **exactly one** node-combination or tool chain.

**Scope.** v1 authors, validates and exports this graph. It does **not** compile into the runtime `MapDef` the sim consumes — see §8.

---

## 1. Files

Two kinds of file, deliberately separate:

| File | Role |
|---|---|
| `src/data/config/nodegraph/schema.json` | **Drives the tool.** Vertex kinds, their editable fields, the legal wiring matrix, the invariant list. |
| `src/data/config/nodegraph/maps/Graph-{index}-{Name}.json` | **Map data.** One file per map, validated against the schema. The folder is scanned at startup to build the map list; level data sits beside it as `LevelData-{index}-{Name}.csv`, joined by index. Files that do not match the convention are skipped with a console warning. |

The split is the point: the editor hardcodes only the field-type primitives (`string`, `int`, `bool`, `enum`, `ref`, …). Everything else — which vertex kinds exist, what properties each has, which edges may connect what, which rules are errors vs. warnings — is read from `schema.json` at load. Adding a property or a whole node kind is a data edit, not a code change.

`schema.json` therefore defines:

- **`mapFields`** — the map header (`gridWidth`, `gridHeight`, `dirtyStackHeight`, `visibleRows`).
- **`vertexKinds[]`** — for each kind: `label`, `color`, and `fields[]` with type, default, min/max, `unique`, and a description that becomes the inspector's help text.
- **`edgeKinds[]`** — for each: `from[]`/`to[]` kind constraints, `style`, per-edge `fields[]`, and cardinality caps (`maxIncomingPerTarget`, `maxOutgoingPerSource`).
- **`invariants[]`** — `{id, severity, description}`, rendered as the issue list.

---

## 2. Graph model

Five vertex kinds, five edge kinds. The edge *kind* carries the semantics.

**Vertices**

| Kind | Colour | Carries |
|---|---|---|
| **ingredient** | green | `pickupable` (queue leaf), `servable` (may fill a dish slot), `usageNum`, `limitPerDish`, `numSlices`, `price`, `code`, artwork |
| **tool** | orange | `numSlots` (simultaneous capacity), `cookingTime`, `upgradeCosts`, artwork |
| **group** | blue | `groupType: SINGLE \| MULTIPLE`, `maxQuantity` |
| **composite** | gold | `orderable` (graph root) |
| **dirty** | grey | artwork; what a served customer leaves behind |

**Edges**

| Kind | From → To | Carries | Cardinality |
|---|---|---|---|
| `process` | tool → ingredient | `inputs[]`, `amount`, `duration?`, `chainTools[]?` | **≤1 incoming per target** |
| `base` | composite → ingredient\|group\|composite | — | exactly 1 outgoing |
| `topping` (dashed) | composite → ingredient\|group\|composite | — | ≤1 outgoing |
| `option` | group → ingredient\|group\|composite | `maxQuantity` | — |
| `leavesDirty` (dotted) | composite → dirty | — | ≤1 outgoing |

Three modelling decisions worth stating:

1. **A recipe is an edge, not a field on the tool.** One `process` edge per recipe row, so "wire an input to an output and pick a tool" is a single gesture, and the ≤1-incoming cap is enforced structurally.
2. **`inputs` is a list** even though every current recipe has arity 1 — multi-input recipes stay expressible, and the renderer must not assume otherwise.
3. **Two-tool routes have two distinct spellings, and picking the wrong one is a behaviour change.** `burger.json` contains one of each, deliberately:
   - **Potato** → `cutting-board` with `chainTools: ["fryer"]`, `amount: 2` — **one** edge, **no** intermediate vertex, because the item never lands on the grid between the two tools.
   - **Chicken** → `flour` → `*-flour-coated` → `fryer` → `*-fried` — **two** edges with a real intermediate vertex, because the coated piece is a distinct item state.

   Use `chainTools` only when nothing observable exists between the tools. The two patterns are not interchangeable, and the resolver reports them differently: potato traces at depth 1, chicken at depth 2.

Solid edges read as production flow; dashed `topping` edges read as assembly choice. Two graphs, one canvas.

---

## 3. Resolver

`src/data/nodeGraphResolve.ts` — pure, no DOM, the analytical core.

```ts
/** Backward chain for one produced ingredient; terminates at a pickupable. */
export interface ChainStep {
  node: string;
  tool?: string;        // absent at a pickupable leaf
  amount?: number;
  duration?: number;
  chainTools?: string[];
  inputs: ChainStep[];
}

export interface OrderableTrace {
  orderable: string;
  /** Distinct pickupables required across every concrete variant. */
  leaves: string[];
  /** One backward chain per distinct produced ingredient on the path. */
  chains: ChainStep[];
  /** null when a MULTIPLE group on the path is uncapped — see below. */
  variantCount: number | null;
  /** Longest tool chain depth; a coarse difficulty proxy. */
  maxDepth: number;
  /** Leaves that never bottom out at a pickupable (INV-TRACEABLE failures). */
  unreachable: string[];
}

export function traceOrderable(map: NodeGraphMap, orderable: string): OrderableTrace;
export function traceAll(map: NodeGraphMap): OrderableTrace[];
```

`resolve(ref)` dispatches on what `ref` names:

- **pickupable ingredient** → terminate, it is a leaf
- **produced ingredient** → recurse into its producing edge's `inputs` (the ≤1-producer cap means no branching, so the walk is deterministic)
- **composite** → `resolve(base) ∪ resolve(topping)`
- **SINGLE group** → union over options; multiplies `variantCount` by the option count
- **MULTIPLE group** → union over options; sets `variantCount` to `null` if the group or any option is uncapped

### The unbounded-variant problem

`burger-toppings` is `MULTIPLE` with `maxQuantity: -1` and every option uncapped, so the number of concrete burgers is **infinite**. Any design that enumerates concrete variants hangs on real data. The resolution:

> **Reachability is decided on the finite option *set*; variant *count* is reported separately and may be `null` (unbounded).**

Whether an ingredient is obtainable does not depend on how many copies a dish takes. So the tracer walks the set of *distinct* reachable vertices — always finite, bounded by the vertex count — while the counter multiplies out only where every group is capped.

Memoize by name and carry a visiting-set, so a cyclic graph reports `INV-ACYCLIC` instead of blowing the stack. The resolver runs live while the designer is mid-edit, so it must stay total on invalid input.

---

## 4. Validator

`src/data/nodeGraphValidate.ts` — pure, unit-tested. Returns `{errors, warnings}`, each issue carrying `{invariantId, message, vertexKind?, vertexName?, edge?}` so the canvas can highlight the offender. It reads the rule list from `schema.json` rather than hardcoding it.

Sibling to `src/data/validate.ts` (which checks *level* data and returns a flat `LevelWarning[]`), not an extension of it — this one needs severity and vertex targeting.

**Errors** — `INV-REF`, `INV-UNIQUE-PRODUCER`, `INV-ACYCLIC`, `INV-NAMESPACE`, `INV-TRACEABLE`, `INV-BASE-REQUIRED`, `INV-GROUP-NONEMPTY`, `INV-SERVABLE`.

**Warnings** — `WARN-ORPHAN-OUTPUT`, `WARN-UNUSED-PICKUP`, `WARN-UNREACHED-COMPOSITE`, `WARN-UNBOUNDED`, `WARN-EMPTY-TOOL`, `WARN-DEGENERATE-CHOICE`.

Full text of each is in `schema.json`'s `invariants[]`; that file is the single source of truth.

Two subtleties the implementation must get right, both easy to get wrong:

- **`WARN-ORPHAN-OUTPUT` must test membership in the set of *all visited vertices*, not the set of leaves.** `patty-cooked` is never a leaf — it is an intermediate reached *through* the `burger-toppings` group — so a leaf-membership test reports every intermediate as an orphan. (This exact bug appeared while validating the burger data by hand.)
- **`INV-NAMESPACE` spans all kinds.** `base`/`topping`/`option` edges resolve into one shared namespace: `soda`'s base is the ingredient `soda-cup`, while `fried-chicken`'s base is the group `fried-chicken-bases`. A group and an ingredient sharing a name would make a reference ambiguous.

---

## 5. Mode

`src/ui/nodegraph/` — follows `RemoteDataView`'s contract: the constructor mounts via `root.replaceChildren(...)`, no lifecycle methods, module-scope state for anything that must survive main.ts's full-DOM rebuild on mode switch.

| File | Responsibility |
|---|---|
| `index.ts` | `NodeGraphView` — map switcher, canvas host, inspector, issue list, export bar |
| `graphCanvas.ts` | Pan/zoom via a CSS `transform` on a node layer; vertices are absolutely-positioned DOM (so `ui/icon.ts` artwork renders inside them); edges are one SVG overlay beneath. Borrows `curveEditor.ts`'s pointer-drag pattern and `queueGroupVisuals.ts`'s `appendLine`/bezier helpers. |
| `nodeCard.ts` | One card per vertex kind, ports and colour driven by `schema.json` |
| `inspector.ts` | Property panel for the selected vertex/edge, **generated from the schema's `fields[]`** — no per-kind hand-written forms |
| `tracePanel.ts` | Per-orderable: variant count, leaf list, indented chains, unreachable leaves in red |
| `autoLayout.ts` | Layered placement (pickupable → tool tiers → produced → group → composite) for first open and a "Re-layout" button |

**Wiring guards** run on drag-release, before the edge is created: enforce the schema's `from`/`to` matrix, reject a second `process` edge into an ingredient (`INV-UNIQUE-PRODUCER` at authoring time, not just at validation time), reject cycles. Full validation re-runs after every mutation and repaints the issue list.

**main.ts** gains `"nodegraph"` in the `Mode` union (currently `"design" | "play" | "remote"`), a fourth tab in `nav.mode-tabs`, and a branch in the mount `try` block. The existing `switchMode` dirty-guard covers leaving with unsaved edits.

**Export** downloads the per-map JSON. `downloadFile` already exists in `src/data/sheetSource.ts` but is module-private — export it there and reuse rather than duplicating the Blob/anchor dance. The browser cannot write into `src/`, so export-then-commit is the loop.

**CSS**: one `/* ---------- Recipe Graph ---------- */` banner appended to `src/style.css`, matching house convention. Respect the documented z-index ladder (`.overlay` 30, `header` 35, `.overlay-panel` 40, `.preload-overlay` 60).

---

## 6. Types

`src/data/nodeGraphTypes.ts` — TypeScript mirrors of the schema, so map data is typed at the call site even though the *editor* is schema-driven:

```ts
export interface NodeGraphMap {
  schemaVersion: number;
  map: { id: string; name: string; gridWidth: number; gridHeight: number;
         dirtyStackHeight: number; visibleRows: number };
  vertices: {
    ingredient: IngredientVertex[]; tool: ToolVertex[]; group: GroupVertex[];
    composite: CompositeVertex[]; dirty: DirtyVertex[];
  };
  edges: {
    process: ProcessEdge[]; base: SimpleEdge[]; topping: SimpleEdge[];
    option: OptionEdge[]; leavesDirty: SimpleEdge[];
  };
  layout: Record<string, { x: number; y: number }>;
}
```

Keep this module a **pure leaf** — types only, no config imports — so `configLoader → nodeGraphTypes` cannot reintroduce an import cycle. `src/data/` must never import from `src/ui/` (the constraint that forced `recipeDemand.ts` out of `ui/design/`).

A schema-vs-types drift test asserts every field name in `schema.json` appears in the corresponding interface, so the two cannot silently diverge.

---

## 7. Build order

Each phase leaves the repo green (`npx tsc --noEmit` + `npx vitest run`).

1. **Types + loader.** `nodeGraphTypes.ts`; load `schema.json` + `burger.json` through `configLoader.ts`. No UI.
2. **Resolver + validator.** `nodeGraphResolve.ts`, `nodeGraphValidate.ts` and their unit tests. Pure functions, no wiring — already useful, since this alone answers the traceability question from the command line.
3. **Read-only canvas.** `graphCanvas.ts` + `nodeCard.ts` + `autoLayout.ts`, rendering burger with pan/zoom and no editing. Confirms the hard visual cases: the chained potato edge, and a group referenced as a topping.
4. **Trace panel.** Per-orderable variant counts, chains, unreachable leaves — the headline requirement, visible before editing exists.
5. **Editing.** Schema-generated inspector, wiring guards, live re-validation, export.
6. **Second map.** Author a second map's JSON through the finished tool. Round-tripping a map the tool did not generate is the real acceptance test.

Phases 1–2 stand alone if 3–5 slip: they give a typed schema and a mechanical audit runnable in CI.

---

## 8. Out of scope for v1

**Compiling to the runtime `MapDef`.** The sim consumes a materially different model, and bridging is a project of its own:

| Runtime concept | Graph model | Gap |
|---|---|---|
| `ToolRecipe {in, out, amount, chainTools?}` | `process` edge `{inputs[], amount, chainTools?}` | Runtime inputs are single-valued. `chainTools` survives 1:1, but multi-input recipes have no runtime representation. |
| `CookedIngredientDef.baseId` | `base` / `topping` edges | Runtime `baseId` is a flat serve-time precondition on a cooked-id list. The graph nests composites arbitrarily deep; the runtime cannot express depth > 1. |
| Integer ids | Names | The `runtime*Id` fields on every vertex exist precisely to make this recoverable later. |
| `usageNum`, `limit`, `numSlices`, `price`, `code` | carried on the ingredient vertex | Compatible — already modelled. |
| `DirtyObjectDef.sourceCookedId` | `leavesDirty` edge | Compatible, and cleaner: keyed by composite rather than name-matched against a cooked ingredient's display name. |

Attempting the compiler alongside the editor is what sank an earlier iteration of this idea. Phase 1 ships a standalone authoring + validation tool; the compiler is revisited once the graph data is proven and the depth->1 question has an agreed answer.

Also out of scope: live sim/bot integration, level authoring, and Sheets round-tripping for graph data.

---

## 9. Verification

1. `npx tsc --noEmit` and `npx vitest run` — 292 tests currently pass; none should regress.
2. **Schema conformance.** Every vertex/edge in each map file validates against `schema.json`: field types, required fields, min/max, `unique` names, and the `from`/`to` kind matrix.
3. **Resolver tests against `burger.json`** (values below are the hand-verified expectations for the committed data):
   - all four orderables (`burger`, `soda`, `fried-chicken`, `fried-potato`) trace with **zero** unreachable leaves
   - leaf counts 7 / 2 / 7 / 1, and `maxDepth` 1 / 1 / **2** / 1 — `fried-chicken` is the only two-tool route with a real intermediate
   - `burger` and `fried-chicken` report `variantCount: null` (uncapped MULTIPLE groups); `fried-potato` reports a finite count
   - **The two spellings of a two-tool route both resolve correctly** (§2.3): `potato-fried`'s chain is exactly one step (`cutting-board`, `chainTools: ["fryer"]`, `amount: 2`) while `chicken-breast-fried`'s is two (`fryer` ← `chicken-breast-flour-coated` ← `flour` ← `chicken-breast`).
   - all 17 pickupables are reached by some orderable
4. **Validator tests.** One case per invariant, each built by mutating a copy of `burger.json`: duplicate producer, dangling ref, cycle, group/ingredient name collision, missing base. Plus the negative case — unmodified `burger.json` yields **no errors** and exactly two warnings, both `WARN-UNBOUNDED` (`burger-toppings`, `fried-chicken-sauces`). No empty tools, no orphan outputs, no unused pickupables.
5. **Orphan regression test.** Assert `patty-cooked` is *not* reported as an orphan — it is an intermediate reached through a group, and a leaf-membership test would wrongly flag it (§4).
6. **Browser.** Open the mode, confirm burger renders; confirm the trace panel shows four green orderables; deliberately wire a second tool into an existing output and confirm the guard rejects it at drag-release.
7. **Round-trip.** Export an unmodified map and diff against the input JSON — byte-identical.
