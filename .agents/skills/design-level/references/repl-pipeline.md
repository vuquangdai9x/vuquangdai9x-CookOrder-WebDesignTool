# Level Lab REPL operating guide

Use this reference after the designer confirms a single-level requirement, explicitly skips that
gate, or requests batch generation.

## Capability detection

Use the richest available MCP surface without pretending planned tools exist.

| Pipeline need | Preferred Level Lab tool | Current compatibility path |
|---|---|---|
| Requirement refinement | `refine_level_requirements` | `interpret_level_brief` plus conversation |
| Confirm requirements | `confirm_level_requirements` | Preserve the confirmed summary in the session brief |
| Orientation | `get_authoring_status` | `get_level_session`, validation results, own ledger |
| Candidate branch | `create_level_candidate` | `checkpoint_level` and `restore_revision` |
| Proposal lifecycle | `propose_*`, `apply_proposal` | Plan internally, then granular mutations |
| Amount planning | `propose_amount_plan`, `analyze_amount_utilization` | `get_supply_demand`, graph stack ranges, destination capacity, manual amount actions |
| Unified evaluation | `evaluate_level` | validate draft/level, estimate, instant playtest |
| Mutation experiment | `evaluate_mutation_batch` | checkpoint, mutate, evaluate, restore if worse |
| Candidate comparison | `compare_level_candidates` | Compare recorded checkpoint evidence |
| Bounded search | `run_search_step` | One explicit hypothesis and tuning cycle |

## Phase loop

### 1. Discover

Read the map context once per freshness token. Inspect only relevant composites, ingredients,
effects, avatars, and rules after the broad context. If the graph token changes, reload context
before further mutation.

### 2. Establish requirements

Use the confirmed requirement summary as the constraint ledger. Classify each item:

- `hard`: fundamental validity, explicit must/must-not statements, authorized mechanic scope.
- `target`: numeric range the search should satisfy.
- `preference`: direction or tie-breaker that may yield to harder constraints.

Never silently relax a hard requirement. Report and request an amendment when it is infeasible.

### 3. Select a route

Use `plan_authoring_strategy`, then record the chosen strategy and why. The route controls which
skeleton comes first, not which validations may be skipped.

### 4. Build a minimum viable candidate

Create enough customers, dishes, queues, and ordinary grid capacity to exercise the intended
experience. Keep special mechanics out until the ordinary candidate is structurally valid unless
the confirmed brief is explicitly mechanic-first.

When proposal tools exist, inspect stable object/action IDs, supply deltas, authorization, and
warnings before applying. A proposal based on a stale revision must be regenerated.

### 5. Reconcile supply and amounts

Keep provenance from demand to raw pickup. The production runtime is always Unpacked raw + Auto:
amount N is one queue line/pick that atomically releases N independent one-use items; at most one
may enter a tool and the rest each require a grid cell. `multipleUsage` does not create a reusable
object in this mode. For each amount slot record its consumer wave and expected destinations. Prefer:

- Amount partitions for repeated units needed near each other.
- Amount sizes that can dispatch atomically at their expected pick point.
- A later amount slot instead of releasing distant-wave demand too early.
- Amount 1 for remainders that cannot legally/practically use `stackMin`.

After any amount merge, split, move, or replacement, recheck exact supply and then simulate the
actual expansion, grid burst, and effect/group timing.

### 6. Evaluate

Use the same seed set for before/after comparisons. During shaping, use a fast profile. During
tuning, increase runs. Final verification uses the confirmed run count or the server's final
profile.

Keep these evidence domains separate:

- Structural/serialization and authorization.
- Exact supply and full service.
- Queue-only picking deadlock and distinct cases.
- Grid/dirty occupancy and overflow.
- Duration, timeouts, win rate, failure distribution.
- Amount utilization, atomic destination blocking, and release-burst occupancy.
- Difficulty/pacing targets.
- Preserved legacy tool/grid diagnostics.

### 7. Diagnose and mutate

Rank gaps: hard failure, then weighted target distance, then preference. Form one causal hypothesis,
such as “the early reusable amount remains resident too long.” Prefer a local mutation batch that
can falsify that hypothesis.

Useful mutation families:

- Supply: add/remove/replace a precise pickup; simplify or enrich a named dish slot.
- Amount: merge nearby units, split an atomically blocked burst, move a release later, reduce an
  early large amount without changing total supply.
- Pacing: move a slot/customer, redistribute lanes, change ordinary concurrency.
- Capacity: alter serving slots or authorized grid layout.
- Picking lock: move/unfreeze/unlink the exact Queue X, line Y slots from a retained case.
- Difficulty: tune ordinary order/queue/amount controls before proposing a new mechanic.

Evaluate experiments without changing the active candidate when supported. Otherwise checkpoint,
mutate, evaluate, and restore on regression. Do not stack unrelated speculative changes in one
experiment.

### 8. Keep, branch, or revert

Keep a mutation when hard status stays valid and the weighted result improves without an
unaccepted tradeoff. Branch when alternatives embody materially different design ideas. Revert
when the hypothesis fails. Record strategy switches and evidence so later iterations do not repeat
failed moves.

### 9. Finalize

Finalization requires current evidence for the exact candidate revision, serializable structure,
authorized mechanics, exact/allowed supply, no provisional slots, solver victory, full service,
zero timeouts, and every confirmed hard constraint. A closest candidate must be labeled as such and
must still be fundamentally playable.

## Batch mode

For batch generation:

1. Normalize one batch spec: map, level count/range, progression curve, feature cadence, content
   repetition, amount-use curve, seeds, evaluation profile, output naming, and authorized mechanics.
2. State inferred assumptions once; do not request per-level confirmation.
3. Derive deterministic level seeds from the batch seed and stable level identity.
4. Build/evaluate each level independently. Never allow one valid aggregate to hide an invalid
   member.
5. Track resumable status and stop at declared time/run/candidate budgets.
6. Check cross-level monotonicity, novelty, repetition, and mechanic introduction only after every
   member passes fundamental validation.
7. Finalize only passing levels; report failed/closest members separately.

## Efficient tool use

- Prefer summary responses; request full graph/evaluation/case data only when diagnosing it.
- Combine compatible reads, but serialize mutations because each consumes the latest revision.
- Use stable object IDs in every recommendation and mutation.
- Call orientation/status after a meaningful mutation batch, not after every single read.
- Do not repeat expensive evaluation when no relevant state or requirement changed.
