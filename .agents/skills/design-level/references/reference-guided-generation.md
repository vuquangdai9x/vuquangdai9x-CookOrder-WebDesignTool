# Reference-guided queue generation

Use this reference whenever creating a level or batch from committed project data.

## Learn before authoring

Call `analyze_reference_levels` after selecting the map and before refining requirements. Pass the
target level when progression position is known. The result is a statistical style envelope, not a
queue template. Record its profile id, source file/hash, cohort level ids, weak-evidence warnings,
and recommended targets.

Do not copy a reference queue. Match its design language while keeping
`queue.nearestReferenceSimilarity` below the recommended ceiling. If the map has fewer than three
comparable levels, tell the designer and use a separately reviewed cross-map cohort or explicit
targets; never silently invent a reference baseline.

If the designer requests a shape far outside the cohort—especially zero amount use when comparable
levels normally use amounts—show the deviation in the refined summary and confirm it. Never infer
`single-unit`; it is an explicit tutorial or designer override.

## Build structurally different candidates

After customer/dish demand exists, prefer `propose_queue_variants` over accepting the first exact-
supply queue. Its normal six-candidate set combines three archetypes with two layout seeds:

- `staggered-braid`: alternates pressure across lanes and penalizes aligned ingredient bands.
- `wave-echo`: repeats a motif after a gap, not as adjacent duplicate runs.
- `asymmetric-lanes`: gives lanes distinct rhythms while bounding depth imbalance.

Keep amount style `balanced` unless confirmed requirements choose another style. Evaluate every
non-empty proposal with `evaluate_mutation_batch` using the same simulation seed set. Rank hard
validity first, then weighted requirement gap. Apply only the best revision-matched experiment.

The planner preserves exact pickup supply and stack/capacity-bounded amount partitioning. Its
texture score does not replace simulation: atomic release safety, picking-order deadlock, tool/grid
diagnostics, timeout, and full service remain independent evidence.

## Texture review

After applying a queue proposal, call `analyze_queue_texture` or
`compare_level_to_references`. Inspect:

- `amountSlotRatio` and `compactedUnitRatio`;
- `adjacentDuplicateRatio` and `maxIdenticalRun`;
- `crossLaneCloneRatio`;
- `transitionEntropy`;
- `repeatedNgramRatio`;
- `localIngredientDominance`;
- `referenceStyleDistance` and `nearestReferenceSimilarity`.

Treat a metric outside the recommended envelope as a repair target, not permission to damage a
hard gameplay constraint. Generate another archetype/seed before manually moving many slots. A
quality exception must be explicit in confirmed requirements; finalization blocks severe unconfirmed
outliers.

## Batch originality

Rotate queue archetypes across members; do not use one structural grammar for a whole batch. After
all members are individually playable, call `compare_batch_novelty`. Regenerate the more expensive
member of any pair above the reported similarity ceiling, then evaluate and finalize that member
again. Cross-level novelty never hides an invalid individual level.
