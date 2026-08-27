---
name: recipe-to-cooking-graph
description: Turn a user-supplied food list or real-world menu into a validated CookOrder recipe-graph JSON with recipe-grounded ingredients, tools, groups, composites, emoji artwork, provenance, and a clean left-to-right layout. Use when asked to create, generate, author, or revise a cooking graph from dishes; do not use for level balancing or customer/queue generation.
---

# Recipe to Cooking Graph

Create an editable CookOrder graph from the requested foods. The deliverable is a graph JSON, not level data.

## Before authoring

Read [references/graph-authoring.md](references/graph-authoring.md) completely. It contains the project schema conventions, menu-to-orderable rules, recipe abstraction policy, artwork strategy, layout procedure, and verification command.

When the request resembles a burger/fast-food or coffee/cafe menu, also read [references/menu-patterns.md](references/menu-patterns.md). It records tested patterns and known traps in the legacy samples.

Then inspect:

- `src/data/config/nodegraph/schema.json` as the authoritative schema.
- `src/data/config/nodegraph/maps/Graph-1-Burger.json` for savory fast-food vocabulary.
- `src/data/config/nodegraph/maps/Graph-2-Coffee.json` for cafe and bakery vocabulary.
- `src/data/nodeGraphTypes.ts`, `src/data/nodeGraphValidate.ts`, and `src/ui/nodegraph/autoLayout.ts` when a field or invariant is uncertain.

The samples are historical input, not gold fixtures. Reuse their recognizable concepts, but do not copy their validation warnings, missing artwork, unbounded choices, dead nodes, multi-input simulation hazards, or deep nesting. Do not rely on stale prose when it disagrees with the schema or runtime files.

## Defaults

Unless the user overrides them:

- Use 15–35 pickupable ingredients; target about 25 with meaningful recipe variants rather than filler.
- Treat 4–5 tools as a soft efficiency target, not a limit. More than 5 is acceptable when the menu benefits from distinct stations. If the user specifies an exact, minimum, or maximum tool count, their instruction overrides this preference; do not reduce or add tools merely to return to 4–5.
- Create exactly one requested-food family per input item. A family may expose a small number of genuine variants, such as hot and cold coffee, but no unrelated orderables.
- Keep composite/group assembly nesting at 2–3 levels where practical and never add depth without a gameplay reason.
- Assign an emoji to every artwork-capable node. Groups render with the editor's built-in `🧩` because the current schema has no group emoji field.
- Make every ingredient the player must choose between visually recognizable at a glance through silhouette, dominant color, or texture—not only its label. Ingredients in the same pickup table or option set must not be visually interchangeable.
- Keep assembled dishes visibly compositional: every selected ingredient remains at least partly visible in representative combinations. Do not replace the stack with, or hide it beneath, one opaque final-dish image.
- Flow left to right: pickupables → preparation tools → intermediate states → cooking tools → ready ingredients → groups/helper composites → orderables → dirty objects.
- Always set `map.gridWidth: 5` and `map.gridHeight: 2` unless the user explicitly specifies another map-grid size. Menu complexity alone is not a reason to change the grid dimensions. Use dirty stack `5` and `visibleRows: 3` unless the menu or user says otherwise.

## Authoring workflow

1. Normalize the food list and write a short menu plan. Ask only when a name is truly ambiguous enough to change the dish family.
2. Make an internal menu contract before writing JSON: requested family, exact orderable names, fixed base, required/optional choice slots, player-visible processes, dirty result, and assumptions. Honor an exact orderable list as initial data; do not silently rename, merge, or add orderables.
3. Verify each unfamiliar or culturally specific food against a reputable recipe source. For familiar foods, use at least one source per menu family when browsing is available. Summarize; never copy recipe text.
4. Map real cooking into player-visible states. Pantry details that create no useful action may be represented as prepared pickups such as batter, dough, glaze, or sauce. Prefer a single-input process unless every input is a meaningful player-controlled pairing supported by the current simulation.
5. Name every node with the conventions in the reference before wiring it. Preserve exact valid orderable identifiers supplied by the user; use stable semantic names for every other node, never generated counters.
6. Apportion the pickup budget across requested families, then design shared tools and ingredients. Every pickup must trace to at least one orderable; variety is not permission to add filler. Remove genuinely redundant stations, but preserve the user's requested tool count and keep additional tools when they create useful gameplay.
7. Assemble groups and composites. One composite has at most one base and one topping edge; when both a required choice and optional extras are needed, use one shallow helper composite and count the resulting depth before continuing.
8. Write a new `Graph-{index}-{Name}.json` under `src/data/config/nodegraph/maps/`, using the next unused positive index unless the user provides a target. Never overwrite an existing graph without explicit instruction. For a temporary skill test, keep the draft in memory or a disposable test file and do not mutate canonical maps.
9. Add `_foodOrderableMap`, `_derivation`, `_imagePolicy`, `_visualAudit`, complete `idTable` spaces, semantic vertices/edges, notes, and a deliberate layout. Give every orderable one `leavesDirty` edge unless the user intentionally exempts it.
10. Preview visuals at gameplay scale. Compare every pickup and sibling option set without labels, then preview minimum, typical, and maximum-layer combinations. Replace ambiguous or fully occluding artwork before delivery.
11. Run the verifier from the reference. Fix schema errors, unreachable nodes, naming violations, violations of any explicit tool-count constraint, must-fix warnings, missing dirty results/IDs/layout/emoji, food-family mapping errors, leftward edges, and excessive normalized crossings. Optional warnings must be explicitly accepted, not ignored.
12. Run the focused graph tests and `npm run typecheck`. Report the file, food-to-orderable mapping, pickup and tool counts, maximum assembly depth, error/warning counts, visual-audit result, dirty coverage, and layout crossing estimate.

Use `imageURL` only after confirming the direct URL resolves. Emoji remains the required fallback, so a failed remote image never makes the graph unreadable.
