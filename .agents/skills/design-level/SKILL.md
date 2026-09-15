---
name: design-level
description: Author, balance, validate, or revise a CookOrder level through the level-authoring MCP. Use for level creation, manual queue/customer/dish/grid editing, difficulty tuning, validation, and instant playtesting. Read the selected map graph first and build with granular actions; do not use bulk generation by default.
---

# Design CookOrder Levels

Use the CookOrder level-authoring MCP as the source of truth. Never construct or edit canonical level strings directly.

## Required workflow

1. Call `read_authoring_context` for the selected map. Study the full processing graph, dish slot trees, effect/status definitions, queue behavior, grid capacity, customer catalog, and customer presentation rules. Retain the returned `context_token`.
2. Call `interpret_level_brief`. Preserve the original brief and its measurable constraint ledger. If it returns `needs_profile_extension`, pause and ask the designer to approve or define the proposed profile; do not guess.
3. Start a session with the current token, then call `plan_authoring_strategy`. Choose the route that best fits the dominant constraints and record it with `set_authoring_strategy`. Read [authoring-strategies.md](references/authoring-strategies.md).
4. Build manually with granular customer, dish, piece, queue, group, and grid actions. The sequence is adaptive; it is not inherently customer-first or queue-first.
5. Before adding a dish piece, call `get_valid_dish_pieces`. After changing customers, dishes, yields, bag amounts, or queue contents, call `get_supply_demand` and reconcile exact piece `have`/`need`.
6. Validate after meaningful mutations. Use `validate_draft` while shaping structure and `validate_level` for full reachability/deadlock checks. Estimate difficulty and run `playtest_instant` after each complete tuning pass. Read [validation-and-repair.md](references/validation-and-repair.md).
7. Re-plan when evidence shows the current route is fighting the brief. Record every strategy switch and its evidence.
8. Call `finalize_level` only when serialization, supply, validation, solver victory, full service, and zero timeouts all pass. A threshold miss may be labeled `closest`; an unwinnable draft is never valid.

## Non-negotiable rules

- An ordinary level begins with no effects, statuses, groups, timers, staff, bosses, shippers, or other special mechanics.
- Difficulty language alone never authorizes an obstacle. Use ordinary dish complexity, customer flow, queue order, lane distribution, serving properties, and density first.
- Add a special mechanic only when the brief explicitly authorizes it or after the designer approves a proposal and `amend_session_requirements` records that approval. Read [obstacle-authorization.md](references/obstacle-authorization.md).
- Keep queue-first ingredients marked provisional until matching demand exists. Clear every provisional marker before finalization.
- Read each pickupable's `multipleUsage` flag. For an ordinary ingredient, queue-slot `amount` is physical pieces in a bag that drains one piece at a time. For `multipleUsage: true`, the amount is the reusable serve count of one landed ingredient instead. Both forms occupy one queue slot and one grid cell.
- Read each pickupable's `stackRange` from `read_authoring_context`. Keep authored bags inside that range when practical; use plain one-piece slots for an unavoidable remainder below `stackMin`.
- Use `set_queue_slot_amount`, `split_queue_slot`, and `merge_queue_slots` for the same bag edits available in the queue slot menu. Splitting leaves effects/grouping on the original slot; merging keeps the first named slot and breaks groups that referenced removed slots.
- Re-run full validation and playtesting after bag changes. A bag reduces queue-slot count but increases grid pressure because it must park as one cell while draining.
- Do not treat a solver win with any customer timeout as valid.
- Do not use `generate_level` or any bulk generator unless the designer explicitly asks for it, or approves it after a demonstrated manual impasse.
- Pass the latest `expected_revision` to every mutation. On conflict, reload the session; do not overwrite concurrent work.
- Never overwrite committed CSVs or browser drafts. Checkpoints and finalized artifacts belong only under the session output directory.
- Stop after twenty complete validate/estimate/playtest cycles. Report the remaining blocker and evidence instead of looping.

## Interaction style

Explain the selected route, important graph constraints, and each evidence-led re-plan in designer language. Ask for obstacle approval only when the current authorized mechanics cannot meet the brief. Report exact missing ingredients, quantities, structural deviations, timeout evidence, and the smallest useful repair.
