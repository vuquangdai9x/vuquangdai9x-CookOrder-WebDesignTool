# Building a reusable node-graph editor

This note records the engineering decisions and lessons from the current CookOrder Recipe Graph editor. It is intended for an agent building another graph editor for a different domain while retaining the current tool's authoring quality, safety, and interaction features.

The main lesson is that a useful graph editor is not primarily an edge-drawing widget. The hard part is keeping the domain document, visual layout, references, undo history, validation, persistence, and downstream data consistent through every incomplete gesture and destructive edit.

## What should be preserved

A new graph editor should retain this feature baseline unless its domain clearly makes a feature irrelevant:

- A schema-driven node palette, inspector, connection matrix, defaults, limits, colors, labels, and invariant catalog.
- Absolutely positioned HTML node cards with an SVG edge layer, so cards can contain normal controls, images, focus behavior, and context menus.
- Pan and pointer-centered zoom; zoom limits; canvas-to-screen coordinate conversion.
- Single selection, Shift multi-selection, marquee selection, select all, deselect all, and group dragging.
- Typed ports plus row-level ports for nodes that contain several independently connectable operations.
- Wire preview, forgiving node/port drop targets, immediate connection guards, and context-menu edge removal.
- Create, duplicate, rename, delete, and bulk delete with reference-safe cascading.
- Whole-document undo/redo with one history entry per completed user gesture.
- A schema-generated inspector plus purpose-built editors for structured fields.
- Live validation with errors and warnings, issue navigation, and a domain-specific derived/trace panel.
- Deterministic automatic layout that understands semantic flow and actual card heights.
- Free-floating notes, including image previews when a note contains a usable image URL.
- Derived, read-only graph furniture for useful projections of the data.
- Stable persistence, dirty-state protection, map/document switching, and explicit save behavior.
- Safe JSON import/export and whole-graph PNG export.
- Tests for every pure graph operation, parser repair, validation rule, resolver, layout, migration, and naming rule.

The current editor also coordinates graph IDs with level CSV data and exposes customer CSV import/export. Those are domain integrations, not generic graph features. Reproduce the pattern—make cross-document consequences explicit and migratable—rather than copying CookOrder's exact ID spaces.

## Current architecture

The implementation deliberately separates domain logic from browser interaction.

| Area | Current files | Reusable responsibility |
|---|---|---|
| Document types | `src/data/nodeGraphTypes.ts` | Pure TypeScript types for schema and saved document; imports nothing. |
| Runtime schema | `src/data/config/nodegraph/schema.json`, `src/data/nodeGraphSchema.ts` | Node/edge definitions, field metadata, legal connections, cardinality, validation identities and severities. |
| Parsing | `src/data/nodeGraphJson.ts` | Defensive JSON parsing, normalization, repair messages, and rejection of unusable input. |
| Resolution | `src/data/nodeGraphResolve.ts` | Domain lookups, reachability, backward traces, variants, and depth. |
| Validation | `src/data/nodeGraphValidate.ts` | Total, DOM-free invariant checks that work on half-authored graphs. |
| Safe mutations | `src/data/nodeGraphEdit.ts`, `src/data/nodeIdTable.ts`, `src/data/nodeIdMigration.ts` | Reorders, reference mapping, positional IDs, and dependent-data migration. |
| Persistence | `src/data/nodeProject.ts` | Bundled documents, per-document browser drafts, draft versioning, map creation and switching. |
| View/controller | `src/ui/nodegraph/index.ts` | Rendering, gestures, selection, history commits, inspector, menus, import/export. |
| Layout | `src/ui/nodegraph/autoLayout.ts` | Pure deterministic layered layout with crossing reduction and domain lanes. |
| PNG export | `src/ui/nodegraph/exportPng.ts` | Whole-content bounds, safe image loading, and manual DOM/SVG-to-canvas rendering. |
| Notes/icons | `src/ui/nodegraph/noteImage.ts`, `src/ui/nodegraph/iconAdapter.ts` | Small adapters that keep presentation concerns out of graph logic. |
| Styling | Recipe Graph section of `src/style.css` | Canvas stacking, cards, ports, edges, selection, inspector, dialogs, and pointer-event rules. |

For another purpose, keep this dependency direction:

```text
types (no imports)
  ↑
schema adapter ─ parser ─ resolver ─ validator ─ mutation helpers
  ↑                                      ↑
  └──────────── view/controller ─────────┘
                       ↑
                CSS + DOM adapters
```

`src/data/` must not import from `src/ui/`. Pure graph behavior should be testable without a DOM, browser storage, or rendered pixels.

## The document model

Keep semantic graph data and editor furniture in one versioned document, but in separate properties:

```ts
interface GraphDocument {
  schemaVersion: number;
  metadata: Record<string, unknown>;
  vertices: Record<VertexKind, Vertex[]>;
  edges: Record<EdgeKind, Edge[]>;
  layout?: Record<string, { x: number; y: number }>;
  notes?: Array<{ id: string; x: number; y: number; text: string }>;
}
```

This gives layout and explanatory notes the same portability, reviewability, import/export, and undo behavior as the graph, while keeping them easy for runtime consumers to ignore. Use collision-proof layout keys such as `kind:name`; reserve another prefix such as `table:` for derived canvas furniture.

Use one shared namespace for node references if edges store names. Enforce uniqueness across every node kind, not merely within each array. Otherwise an endpoint cannot be resolved without also storing its kind.

Do not store the same fact in two writable places. The current editor once had editable mapping-table membership as well as `pickupable`/`orderable` flags. They could disagree. The tables are now read-only projections of the flags, and numbering has a separate explicit editor.

If downstream formats use numeric IDs, choose one canonical representation. CookOrder uses array position as the ID rather than storing both a row position and an `id` property. This removes one possible disagreement, but makes deletion and reordering true renumber operations that require warnings and downstream migration.

## Schema-driven does not mean zero custom UI

The schema currently supplies:

- node kinds, labels, colors, descriptions, and fields;
- edge kinds, labels, styles, allowed source/target kinds, fields, and cardinality caps;
- field types, defaults, ranges, enum values, and allowed reference kinds;
- invariant IDs, descriptions, and error/warning severity.

The generic inspector handles scalar strings, integers, numbers, booleans, enums, and simple lists. Structured domain concepts still get explicit widgets. In CookOrder these include tool slot configurations, process inputs, recipe ordering, per-option quantity limits, and process-input slot selection.

This is the useful boundary:

- Put domain vocabulary and simple field metadata in data.
- Put reusable primitive widgets in generic code.
- Build a dedicated editor when a value has internal identity, ordering, dependent references, or a mutation that must repair other data.

Trying to encode every interaction in JSON produces a second, poorly designed UI framework. Hardcoding every field produces repetitive forms and makes schema evolution expensive.

Add a schema-versus-TypeScript drift test. A schema-driven editor can still silently lose data if its saved interfaces, parser, or structured widgets lag behind the schema.

## Rendering strategy

The current editor uses a CSS-transformed HTML canvas containing absolute-positioned node cards and notes, with one SVG overlay for edges.

This proved simpler than a bitmap `<canvas>` because HTML nodes provide:

- existing artwork components and normal image behavior;
- accessible text and form controls;
- natural focus, keyboard, tooltip, and context-menu handling;
- straightforward node-specific rows and buttons;
- CSS-based states for node kind, primary selection, multi-selection, warnings, and badges.

SVG paths remain ideal for wires. They are scalable, stylable by edge kind, selectable as individual elements, and easy to redraw while nodes move.

Important implementation details:

1. The node layer and edge layer must share the same coordinate space and the same pan/zoom transform.
2. Convert pointer coordinates back into canvas coordinates by dividing by the current scale.
3. Compute node and port geometry from one row model. The current constants (`NODE_W`, header height, row height) drive card sizing, port positions, auto-layout height, marquee intersection, and export bounds.
4. Keep headers and artwork frames fixed-size. Variable artwork dimensions otherwise invalidate calculated port positions.
5. Size the logical canvas from all nodes and derived furniture so SVG paths and scrolling are not clipped.
6. Let the SVG container ignore pointer events while enabling them on actual edge paths. Otherwise an empty SVG layer steals empty-canvas marquee and menu gestures.

The controller performs a full graph/side-panel render after completed mutations. During a node drag it updates only moving DOM positions and redraws the SVG edges. Rebuilding every node on every `pointermove` is visibly wasteful and can break the active pointer gesture.

## Interaction model

The current mouse mapping is deliberate:

| Gesture | Behavior |
|---|---|
| Wheel | Zoom about the pointer, clamped to `0.25–2.5`. |
| Left-drag node | Move it; if selected with others, move the full selection. |
| Shift-click node | Toggle it in the selection. |
| Left-drag empty canvas | Marquee-select intersecting nodes; Shift makes it additive. |
| Left-click empty canvas | Clear selection unless Shift is held. |
| Right-drag anywhere | Pan, including when the pointer starts over a node. |
| Right-click without dragging | Open the custom menu for the node, note, edge, or canvas. |
| Ctrl/Cmd+A | Select all, except while editing a form control. |
| Ctrl/Cmd+D | Deselect all. |
| Ctrl/Cmd+Z, Ctrl/Cmd+Y, Ctrl/Cmd+Shift+Z | Undo/redo, except while editing text. |
| Double-click note | Edit the note. |

Use a small movement threshold to distinguish right-click from right-drag. Capture right-button `pointerdown` at the viewport, before node handlers, so panning has no dead zones. Suppress the native context menu across the viewport because it conflicts with right-drag.

Selection has two related states:

- a set of selected nodes for highlighting, bulk actions, and group drag;
- one primary selection for the inspector.

After undo, redo, delete, or import, prune both states against the new document. Never render an inspector for a node that no longer exists.

## Ports, rows, and wiring

Simple nodes can use one input and one output port. Nodes with several operations require row-level ports. A CookOrder tool may contain several process recipes; without a port on each recipe row, a dropped input cannot say which recipe it belongs to. A composite similarly exposes separate `base` and `topping` rows.

Represent a port as semantic data, not just a DOM element:

```ts
interface PortRef {
  kind: VertexKind;
  name: string;
  side: "in" | "out";
  row?: RowIdentity;
}
```

Keep row identity stable enough for the duration of a gesture and serialize it into `data-*` attributes for drop reconstruction. Use the same row list to render rows and calculate their port Y positions.

Wiring starts only from an output port. On release, accept either a precise input-port drop or a drop on the target node when an unambiguous node-level connection exists. Derived tables are non-writable and refuse drops.

Apply cheap, local rules before mutating:

- source and target kind compatibility from the schema;
- no exact duplicate edge;
- incoming/outgoing cardinality caps;
- domain rules such as one producer per output;
- row-specific expectations, such as recipe inputs consuming only ingredients;
- no self-connection when the same semantic row is involved.

Rejected wires should show a concise reason and create no history entry. Full validation still runs after accepted changes because global rules such as cycles and reachability are easier and safer to express in the validator.

Stored edge direction does not have to equal visual flow. CookOrder stores assembly ownership as `composite -> member`, but draws `member -> composite` because that is how the recipe reads. Centralize this translation in edge rendering and layout edge extraction. Do not let each caller invent its own direction, or layout, selection highlighting, export, and user expectations will diverge.

## Mutation safety

Every edit should pass through a small set of document-level mutation rules.

### Rename

A rename must update, in the same operation:

- the vertex name;
- every edge `from` and `to`;
- nested reference fields such as process inputs and chained tools;
- ID/index tables or other name lookups;
- the layout key;
- the primary and multi-selection keys.

Reject empty or duplicate names before cloning or committing.

### Delete

Deleting a node cascades to touching edges and nested references. Bulk delete must be one operation, one confirmation, and one undo entry—not a loop around single-node deletion. Remove associated layout and external-identity entries at the same time.

Before deletion, calculate downstream consequences. In CookOrder, removing one positional ID shifts every later ID, so the warning includes every potentially affected level, not only levels directly referencing the deleted node. When precise analysis is hard, a conservative over-warning is safer than silent data corruption.

### Ordered child data

Treat semantically ordered rows as data edits. Recipe order affects which recipe claims capacity first, so drag-reordering recipes is undoable and tested. When deleting an indexed child such as a tool slot point, repair every stored index after the removed position and explicitly decide what references to the removed item fall back to.

### Derived identity

If an edit makes a node addressable by downstream data, mint its identity in the same history entry. Assembly wiring can make previously internal ingredients addressable, so CookOrder recalculates derived ingredient IDs after wiring.

## Undo, dirty state, and commits

Use one `History<GraphDocument>` for the complete document. Vertices, edges, external IDs, layout, and notes are mutually dependent; separate histories can restore one without the others.

The central rule is one history entry per completed user intention:

- node or multi-node drag commits on `pointerup`, not every move;
- note drag commits on `pointerup`;
- text fields commit on blur, not each keystroke;
- checkboxes and selects commit on change;
- staged dialogs commit once on Apply;
- bulk deletion commits once;
- rejected connections and no-op drags commit nothing.

Clone before mutation and snapshot again when pushing to history. `structuredClone` is adequate for the JSON-shaped document. Route all completed mutations through one `commit(action, added, removed)` function that updates project state, renders the graph and inspector, reruns validation, and refreshes dirty status.

The saved history index is the dirty-state source of truth. When switching documents, replace the history rather than extending it; undo must never cross from one graph into another.

One caveat: graph undo that changes external IDs must also migrate dependent documents in the reverse direction. The current editor detects ID-table reorder states during undo/redo and remaps level data accordingly. History boundaries must include all semantically affected state, even when part of that state lives outside the graph object.

## Validation and derived analysis

The validator runs after every mutation, including while recipes are incomplete. Therefore every rule must be total on malformed and half-wired input: report issues, never throw.

Return structured issues:

```ts
interface GraphIssue {
  invariantId: string;
  severity: "error" | "warning";
  message: string;
  vertexKind?: VertexKind;
  vertexName?: string;
  edge?: { kind: string; from: string; to: string };
}
```

Structured targets let the issue panel navigate to a node and later support direct edge highlighting. Keep invariant IDs and severities in the schema, while implementation functions perform the actual checks.

Separate local authoring guards from global validation:

- Guards prevent obviously invalid gestures and explain them immediately.
- Validation audits the full document, including imported or manually edited files.

Build a pure resolver/lookup layer once and share it among validation, auto-layout, derived tables, trace views, ID decisions, and downstream compilation. This avoids subtly different definitions of reachability in each feature.

For potentially unbounded domains, traverse the finite set of reachable nodes and calculate multiplicity separately. Never enumerate every concrete variant merely to answer reachability; uncapped combinations can be infinite.

## Automatic layout

A generic force-directed layout is not ideal for a directed authoring graph. The current pure layout function uses semantic flow:

1. Convert stored edges to their displayed flow direction.
2. Assign X columns by longest dependency depth so valid edges point right.
3. Apply domain constraints, such as pickup sources in the first column and results after their producers.
4. Infer lanes/families from orderable roots.
5. Order nodes within columns using barycentric sweeps and deterministic local swaps to reduce crossings and wire span.
6. Align connected nodes across neighboring columns.
7. Pack vertical centers using actual rendered card heights, node gaps, and larger family gaps.
8. Round coordinates and keep all tie-breaking deterministic.

The function is DOM-free; the view provides a `nodeHeight(kind, name)` callback based on the same row model used for rendering. Auto-layout is used only on first open when no saved layout exists and when the user explicitly requests it. It must not erase manual work on every render.

Test determinism, left-to-right flow, non-overlap for tall cards, family grouping, and crossing count. Also keep layout total on cyclic or invalid data: validation reports the problem, but the editor still has to draw it.

## Persistence and import/export

Bundled graph files are discovered at build time. Browser drafts use one storage key per graph plus a separate active-document key. A single shared draft key would silently overwrite one graph when another is saved.

Version the draft shape independently of the graph schema. On load:

- parse inside `try/catch`;
- perform a shallow shape check before trusting arrays and tables;
- apply explicitly supported backward-compatible defaults;
- discard a draft that cannot be safely interpreted instead of mixing half-old graph data with dependent data;
- retain human-readable provenance for the UI.

JSON import is a destructive replacement, so parse and normalize first, reject a zero-node file, summarize repairs, and ask for confirmation before changing the open document. Preserve layout when provided; run auto-layout only when absent. Keep unknown extension keys when possible so export does not destroy metadata owned by another tool.

Export the semantic document as readable, indented JSON. The browser cannot write back into the repository automatically; the normal flow is download, review, then commit.

For PNG export, avoid serializing the DOM into SVG `foreignObject`: browser compatibility and cross-origin images make it fragile. The current exporter:

- calculates bounds from every node and note rather than the visible viewport;
- waits for fonts;
- caps output side length and total pixel count;
- loads images through `fetch` with a timeout and converts them to `ImageBitmap`;
- omits images that cannot be fetched safely instead of tainting the canvas;
- manually draws the background, grid, SVG paths, cards, text, and safe images.

This costs more code but reliably exports the whole graph and still succeeds when optional remote artwork fails.

## Notes and derived furniture

Free-floating notes are valuable because the reason for a graph shape belongs beside the shape. Store note positions and text in the document; support add, move, edit, delete, undo, and context menus. Treat an empty edited note as deletion. If URL parsing produces an image preview, remove only the failed preview on image error—not the note.

Derived furniture should be rendered outside normal vertex loops. The current Pickupable and Orderable tables are permanent, read-only projections with movable layout entries and automatically drawn lookup wires. Constructing them rather than guarding every delete/edit path makes their immutability structural.

Use derived views for facts users need to audit but should not edit independently: indexes, roots, sources, generated groups, compilation outputs, or runtime mappings.

## Performance practices that mattered

- Keep resolver, validator, parser, migration, and layout pure and cache shared lookup structures within one validation/render pass.
- During dragging, update only the affected element positions and edge paths.
- Do not read layout geometry from the DOM during every move; use the shared card/row geometry model.
- Rebuild controls after a completed mutation, which avoids complex local synchronization and stale form state.
- Use stable keys and deterministic ordering so rerenders, exports, tests, and diffs agree.
- Bound image fetch time and PNG dimensions.
- Avoid pushing no-op history entries; they make undo feel unreliable and mark clean documents dirty.

## Failure modes and lessons

These are the easiest regressions to introduce when adapting the editor:

1. **Duplicated truth.** Two writable representations of membership or identity eventually disagree. Keep one canonical field and derive every view.
2. **Per-panel undo.** Restoring a vertex without its edges or ID table creates impossible states. Snapshot the whole semantic transaction.
3. **History per pointer move or keystroke.** Undo becomes tedious and memory grows unnecessarily. Commit completed gestures.
4. **Visual direction confused with storage direction.** The graph reads backward or auto-layout contradicts the renderer. Define one displayed-flow adapter and reuse it.
5. **One port per complex node.** A connection cannot identify which internal operation or slot it targets. Model row-level ports.
6. **DOM-measured port geometry.** Image loads and paint timing move endpoints or cause jitter. Share deterministic geometry between rows, ports, layout, selection, and export.
7. **Validation that assumes a valid graph.** Live editing produces empty endpoints and partial rows. All analysis must terminate and return issues.
8. **Enumerating combinations.** Unbounded choice groups can hang the editor. Traverse unique nodes and report cardinality separately.
9. **Rename updates only the card.** Edges, nested refs, layout, selection, and external mappings become stale. Rename is a graph-wide transaction.
10. **Delete reports only direct users.** Positional IDs and other indices can affect every later row. Analyze transitive consequences.
11. **Reordering treated as cosmetic.** Some row order changes runtime priority. Put it in data, history, and tests.
12. **Auto-layout on every render.** Manual layout becomes impossible. Generate only when missing or explicitly requested.
13. **SVG overlay captures empty space.** Marquee and canvas menus stop working. Limit hit-testing to drawn edges.
14. **Full rerender while dragging.** The active element disappears and the gesture stutters or terminates. Patch positions live, commit once.
15. **Unsafe image export.** One cross-origin image taints the canvas and prevents download. Fetch defensively and omit failures.
16. **Document switching shares history or drafts.** Undo crosses documents or saving one overwrites another. Scope both by document identity.
17. **Generic schema widgets stretched too far.** Indexed and ordered structures need domain-aware repair logic and dedicated UI.
18. **Tests exercise only finished graphs.** Most editor bugs occur in partial, malformed, renamed, reordered, or imported states.

## Recommended build sequence for a new graph domain

Keep each phase independently testable and the repository green.

1. Define a versioned document model and decide canonical identity/reference rules.
2. Create the schema and a typed adapter; add schema/type drift tests.
3. Build a defensive parser/normalizer and round-trip tests.
4. Implement pure lookup, traversal, and domain resolution functions.
5. Implement a total validator with one focused test per invariant.
6. Implement reference-safe mutations and cross-document migrations as pure functions.
7. Render a read-only HTML/SVG canvas using deterministic card and port geometry.
8. Add semantic auto-layout and layout tests.
9. Add pan, zoom, selection, marquee, group drag, and context menus.
10. Add row-aware wiring with local guards, then live full validation.
11. Add the schema inspector and dedicated structured-field editors.
12. Add whole-document history and route every mutation through one commit boundary.
13. Add notes and useful read-only derived projections.
14. Add versioned per-document persistence and dirty switching guards.
15. Add safe import/export and whole-content PNG export.
16. Test the editor against a second graph not created by the implementation author; this exposes hardcoded assumptions.

Do not begin with a large monolithic UI. The pure parser, resolver, validator, layout, and mutation layers are valuable before editing exists and remain the cheapest places to prove correctness.

## Acceptance checklist

Before calling another graph editor feature-equivalent, verify all of the following:

### Authoring

- [ ] Every schema node kind can be created with valid defaults.
- [ ] Nodes can be selected, multi-selected, marquee-selected, moved together, duplicated, renamed, and deleted.
- [ ] Complex nodes expose stable row-level targets where needed.
- [ ] Legal edges can be wired; illegal, duplicate, and over-cardinality edges are rejected with feedback.
- [ ] Edges can be removed without deleting their nodes.
- [ ] The inspector renders all scalar schema fields and dedicated structured editors.
- [ ] Ordered child rows can be reordered safely.
- [ ] Notes can be created, moved, edited, deleted, and exported.

### Navigation and presentation

- [ ] Right-drag pans from empty space or over nodes; right-click still opens the correct menu.
- [ ] Zoom stays centered under the pointer and respects limits.
- [ ] Port geometry remains aligned after artwork loads, rows change, nodes move, and zoom changes.
- [ ] Selection and edge highlighting stay correct after rerenders.
- [ ] Auto-layout is deterministic, non-overlapping, respects visual flow, and preserves manual layout until requested.
- [ ] Derived read-only views update immediately when their source fields change.

### Safety

- [ ] One completed gesture equals one undo entry; no-op and rejected gestures equal zero.
- [ ] Undo/redo restores vertices, edges, structured refs, IDs, layout, notes, and dependent data together.
- [ ] Rename rewrites every reference and key.
- [ ] Delete cascades references and clearly reports downstream impact.
- [ ] Validation never throws on incomplete or malformed data.
- [ ] Destructive imports and document switches protect unsaved work.
- [ ] Drafts are versioned and isolated per document.

### Interchange and quality

- [ ] JSON import reports repairs and refuses unusable/empty replacements.
- [ ] JSON export preserves semantic data, layout, notes, and supported extension metadata.
- [ ] PNG export covers the whole graph, not only the viewport, and tolerates failed artwork.
- [ ] Parser, resolver, validator, mutations, migration, layout, and naming each have unit tests.
- [ ] Typecheck, unit tests, and production build pass.
- [ ] A second real graph round-trips successfully and reveals no first-example assumptions.

## How to adapt this editor instead of copying it blindly

Start by replacing the domain layer: node kinds, edge meanings, field definitions, invariants, resolver, semantic-flow conversion, and downstream identity/migration rules. Preserve the interaction shell and transaction principles.

Likely reusable with modest renaming:

- `History<T>` and keyboard binding from `src/ui/history.ts`;
- selection, marquee, pan, zoom, and group-drag patterns from `src/ui/nodegraph/index.ts`;
- HTML-card plus SVG-edge composition;
- schema primitive field rendering;
- layout interfaces and most crossing-reduction/packing logic;
- persistence versioning and per-document draft strategy;
- JSON replacement safeguards and PNG export limits.

Must be redesigned for each domain:

- what a row means and which ports it exposes;
- edge direction in storage versus displayed flow;
- connection guards and global invariants;
- reference rewriting inside structured fields;
- derived tables and trace/analysis panels;
- identity rules and migrations into dependent documents;
- layout depth constraints and lane/family inference;
- specialized inspector widgets.

The right reuse target is the editor's invariants and transaction boundaries, not its cooking terminology. If the new tool preserves those boundaries, it can look and behave like the current graph editor while expressing a completely different graph model.
