---
name: design-level
description: Turn an abstract CookOrder level brief into confirmed measurable requirements, then author, compare, validate, tune, and finalize levels through the level-authoring MCP. Use for single-level creation or revision, amount-aware queue design, balancing, batch generation, and playtesting; do not use for cooking-graph authoring.
---

# Design CookOrder Levels

Use the CookOrder level-authoring MCP as the source of truth. Never construct or edit canonical level strings directly. Treat authoring as a requirement-driven REPL: understand, propose, apply, measure, compare, repair, and finalize.

## Intake and confirmation gate

For a single interactive level, do not start a mutable authoring session until the designer has confirmed a refined requirement summary.

1. If the designer has not provided a brief, ask one open-ended question for their vague goals, constraints, desired feeling, examples, and anything that must or must not appear. Do not make them fill a form up front.
2. Identify the map and read its authoring context. Use `list_requirement_dimensions` and `refine_level_requirements` when available; otherwise use `read_authoring_context` and `interpret_level_brief` and perform the missing-dimension review conversationally.
3. Review every dimension below. Ask only about omissions or ambiguities that could materially change the design. Group related gaps into at most three concise questions per turn and offer explicit proposed defaults. A dimension may be marked “designer has no preference.”
4. Present one refined requirement summary containing resolved values, measurable acceptance thresholds, authorized mechanics, prohibited mechanics, assumptions, and iteration budget.
5. Ask for explicit confirmation before starting or mutating the level. Apply corrections to the summary and show it again when they materially change it.

Bypass this gate when the designer explicitly says to skip requirements/refinement/confirmation. Record reasonable assumptions and proceed. For batch generation, do not run a confirmation cycle per level: normalize one batch-wide specification, state inferred assumptions once, and proceed. Still ask for a missing map, batch size/range, destructive destination, or mechanic authorization when it cannot be safely inferred.

## Full prompt-dimension checklist

Use this checklist to find gaps; do not force the designer to answer irrelevant dimensions.

1. **Scope and identity** — map; create versus revise; source level/revision when revising; one level versus batch; level ID/name/tag/unlock; intended progression position.
2. **Player experience** — difficulty/profile; target emotion (relaxed, tense, puzzle-like, chaotic, mastery); intended player skill/familiarity; fairness tolerance; desired choice versus forced play; novelty versus familiarity.
3. **Duration and tempo** — target duration or move/pick count; early/mid/late pressure shape; breathing spaces; climax/recovery; acceptable variance.
4. **Customers and content** — customer count/range; ordinary/special roles; avatars when important; dish count; allowed/required/forbidden composites or ingredients; recipe complexity; variety/repetition limits; customer ordering/concurrency intent.
5. **Queue structure** — lane count; depth/length; lane balance; clustering/spread; shuffle/randomness; ingredient timing; forced-choice tolerance; provisional queue-first geometry.
6. **Amount mechanics** — whether amounts should be used; target queue-line compaction or amount-slot ratio; conservative/balanced/aggressive partitioning; preferred/max amounts; atomic destination capacity; grid-landing burst tolerance; effect/group timing; unused supply policy. Runtime behavior is fixed to Unpacked raw and is not a prompt dimension.
7. **Grid and serving capacity** — grid dimensions if configurable; usable/blocked capacity; serveable slots; target peak occupancy; dirty pressure; overflow tolerance. Raw overflow uses park-on-grid in production.
8. **Tools and production flow** — desired tool utilization; multi-input concurrency; chain depth; preservation behavior; work-in-flight target; ingredient processing focus or exclusions.
9. **Mechanics and effects** — queue Freeze/Hidden/HoldingKey; combined/linked groups; grid blocks, order locks, ingredient slots, color locks; dish effects; timers; staff, boss, shipper; count, strength, placement, introduction timing, and explicit authorization for each.
10. **Difficulty evidence** — target occupancy, detour/random-pick ratios, concurrency, stuck-picking rate, win rate, timeout rate, failure distribution, duration percentiles, solver strictness, and whether “closest attainable” is acceptable.
11. **Reproducibility and search** — fixed generator seed; evaluation seed set/run count; candidate count; wall-time/iteration budget; deterministic versus varied output; comparison policy.
12. **Delivery** — draft versus final artifact; alternatives; report depth; checkpoint naming; output location/format; whether canonical integration is separately requested; whether this is an Agent Design profile for cross-device GitHub Pages playtesting; profile display name/stable slug; append-only versus commit/push/deploy; deploy branch and desired Pages URL.

Mechanic authorization and delivery destination are never silently inferred. Difficulty adjectives alone do not authorize effects, groups, locks, timers, or special customers.

## Refined requirement summary

Before confirmation, show a compact summary like:

```text
Scope: Map 2, create one level, challenging progression slot.
Experience: tense but fair; some choice; 3–4 minutes.
Content: 8–10 ordinary customers; coffee recipes; moderate variety.
Queue/amounts: 5 lanes; balanced partitioning; 40–60% compacted units; amount bursts fit destinations.
Grid/flow: default grid; peak occupancy 70–88%; raw overflow parks on grid.
Mechanics: linked groups authorized (1–2); all other special mechanics prohibited.
Acceptance: exact supply; full service; zero timeouts; picking deadlock <=3%; win rate >=90%.
Search: up to 3 candidates, 20 tuning cycles, common evaluation seeds; closest allowed: no.
Delivery: one finalized session artifact plus concise evidence summary.
Assumptions: [explicit list].
```

Ask: “Does this refined requirement match what you want me to build?” Do not interpret silence as confirmation.

## REPL pipeline

After confirmation or a permitted bypass:

1. Read fresh graph context and retain `context_token`.
2. Confirm/persist the refined requirement token when supported, then start the session. Otherwise start from the exact confirmed brief and retain the summary in the work log.
3. Call `get_authoring_status` when available. Plan and record an adaptive strategy; read [authoring-strategies.md](references/authoring-strategies.md).
4. Create a small ordinary customer/dish skeleton. Prefer `propose_level_skeleton`; inspect its customer, graph-valid dish, exact-supply queue, stable IDs, warnings, and amount partition before applying it transactionally. Use `propose_customer_plan` or `propose_dish_plan` when only one subsystem should change.
5. Once dish demand exists, reconcile exact pickup supply. Prefer `propose_queue_plan` when available; inspect its stable lane/slot IDs, exact supply delta, amount partition, and warnings before one atomic apply. Read each pickupable’s `multipleUsage` and `stackRange`, then use amount planning/analysis and repair proposals when available.
6. Evaluate against the constraint ledger with a reusable seed set. Diagnose the largest hard or weighted target gap rather than tuning arbitrary fields.
7. Form one repair hypothesis. Use `evaluate_mutation_batch` without changing the active candidate, compare alternatives with `rank_mutation_candidates` on identical seeds, then use `apply_mutation_batch` only for the best supported experiment. Use bounded `run_search_step`/`run_candidate_search` only with explicit iteration, run, experiment, and wall-time limits.
8. Checkpoint meaningful improvements. Branch candidates when two plausible directions should be compared. Record evidence when changing strategy.
9. Repeat until constraints pass or the confirmed budget ends. Read [validation-and-repair.md](references/validation-and-repair.md).
10. Run final validation/evaluation and finalize only a fundamentally valid candidate.
11. When the confirmed delivery is an Agent Design profile, publish through the repository command described below; do not manually build its manifest or copy canonical strings.

Read [repl-pipeline.md](references/repl-pipeline.md) for tool routing, compatibility fallbacks, candidate comparison, evaluation cadence, and batch operation.

## Authoring invariants

- Call `get_valid_dish_pieces` before adding an unfamiliar dish piece. Respect slot capacity and base prerequisites.
- Re-run supply/demand after customer, dish, yield, amount, or queue changes. Keep supply exact unless the confirmed requirement permits quantified excess.
- Keep queue-first ingredients provisional until matching demand exists; clear every provisional marker before finalization.
- Production behavior is fixed to Unpacked raw + Auto with park-on-grid. Picking amount N atomically expands N independent one-use items; at most one may enter an immediately available tool and every remainder needs its own grid cell. `multipleUsage` amount also expands into usage-1 items and does not create a reusable object.
- Keep generated amounts within `stackRange` when practical. Use amount 1 for an unavoidable remainder. Use `set_queue_slot_amount`, `split_queue_slot`, and `merge_queue_slots` for manual correction.
- An amount reduces authored queue lines but creates one atomic release burst. Re-evaluate available destinations, grid-landing burst, effect/group timing, occupancy, exact usage, and playability after amount edits.
- Measure picking-order deadlock with the queue-only checker. Do not count grid state in that rate. Keep grid pressure and the legacy tool/grid diagnostic separate.
- Start ordinary. Add a special mechanic only when confirmed requirements authorize it or after explicit approval recorded by `amend_session_requirements`. Read [obstacle-authorization.md](references/obstacle-authorization.md).
- Do not treat a solver win with any customer timeout as valid.
- Pass the latest `expected_revision` to each mutation. On conflict, reload; never overwrite concurrent state.
- Never overwrite committed CSVs or browser drafts. Session artifacts stay under the MCP output directory unless separately authorized.
- Agent Design publishing is the one explicit exception to the output-directory rule: only when the confirmed delivery requests it, use the repository publisher to update `public/agent-levels/index.json` and that profile's own file. The publish command commits only those files.
- Never stage or push `outputs/mcp-level-sessions/`; it is ignored local working state. A generated level's deploy payload is only `public/agent-levels/index.json` plus its `public/agent-levels/profiles/<profile-id>.json` file.
- Stop at the confirmed search budget. If none was provided, stop after twenty complete validate/evaluate/playtest cycles and report the closest candidate with evidence.

## Agent Design delivery

Use this path when the designer asks to play generated levels from GitHub Pages or names the Agent Design tab.

1. During intake, establish one human-readable profile name for the local agent-design session. Reuse a stable `--profile-id` if the display name changes. One profile may contain multiple finalized MCP level sessions and may span bundled maps.
2. Preserve the exact refined requirement as the reprompt instruction. The publisher derives it from confirmed session requirements by default; use `--instruction-file` only when a separately reviewed prompt is the intended source.
3. After each level finalizes, append it with `npm run agent-level:append -- --session <session-id> --profile "<profile name>" [--profile-id <slug>]`. A current revision that is not finalized is re-finalized and must pass before any public file is written.
4. For a single level, or the last level in a batch/profile, use `npm run agent-level:publish -- --session <session-id> --profile "<profile name>" [--profile-id <slug>]` when commit and push were explicitly requested. This command updates the profile/index, commits only those two paths, verifies the checked-out branch, and pushes `master` to the repository's `github.com` remote. Do not use it when the designer asked only for local files. Override `--remote` or `--branch` only after verifying a changed deployment configuration.
5. Check the current branch against `.github/workflows/deploy.yml`. If it is not a deployment branch, explain that the push will not reach Pages until merged; do not merge or push another branch without authority.
6. When deployment was requested, monitor the Pages workflow to a terminal result when GitHub CLI or another authorized repository interface is available. Report the deployed URL only after success; otherwise report the pushed commit and the outstanding deployment check.

For multiple levels, append the earlier sessions without committing, then publish the last session so one profile commit contains the whole set. Republishing the same MCP session revision replaces that entry; publishing a new revision preserves the prior entry as another playtest case. See [Agent Design publishing pipeline](../../../docs/AGENT_DESIGN_PIPELINE.md).

## Tool compatibility

Prefer guided Level Lab tools when exposed: requirement refinement, authoring status, proposals, candidates, seed sets, unified evaluation, amount analysis, mutation experiments, and batch tools. If one is unavailable, retain the workflow with current tools:

- Refine with `interpret_level_brief` plus conversation.
- Use revision history as candidate/checkpoint storage.
- Use granular mutations instead of proposal application.
- Compose `validate_draft`, `validate_level`, `estimate_difficulty`, and `playtest_instant` as one evaluation cycle.
- Compare checkpoint evidence manually and restore the selected revision.

Do not claim an unavailable tool ran. Missing orchestration is not permission to edit canonical strings or bypass authorization.

## Final report

Report the finalized/closest candidate, confirmed requirements, hard-pass status, target misses, amount utilization, picking-order deadlock rate, win/timeout evidence, seed/run counts, important tradeoffs, and artifact/checkpoint references. For Agent Design delivery, also report the profile name, published level entry, generated files, commit, push/deployment status, and Pages playtest URL when verified. Distinguish measured facts from assumptions. If closest rather than compliant, name the smallest remaining gap and proposed next action.
