# MCP Level Lab REPL — full-feature implementation plan

## Outcome

Extend the existing stateful level-authoring MCP into a guided Level Lab REPL that translates an
abstract design goal into measurable requirements, builds reversible candidates with the existing
granular actions, evaluates them with stable evidence, and iterates until a selected candidate
satisfies the confirmed requirement set.

The existing graph discovery, stable draft object IDs, optimistic revisions, authorization ledger,
granular mutations, validation, instant playtest, checkpointing, and safe session-output boundary
remain the foundation. New tools orchestrate and explain those capabilities; they do not replace
working mutations or write canonical CSV/browser state.

## Product principles

1. **Refine before authoring.** For one interactive level, convert a vague brief into a complete
   requirement document and obtain confirmation before starting a mutable session. Permit an
   explicit skip. Batch generation records batch-wide assumptions instead of confirming each level.
2. **Registered metrics.** Constraints reference a discoverable catalog with typed units,
   operators, scopes, confidence requirements, and repair families. Do not execute user expressions.
3. **Proposal before mutation.** Generation, amount partitioning, mechanics, and repairs return
   inspectable proposals. Applying a proposal is one revisioned transaction.
4. **Evidence on every iteration.** Compare candidates with the same seed set and report actual
   value, target, normalized gap, confidence, and supporting cases.
5. **Granular actions remain first-class.** An agent can correct one dish piece, amount, queue
   position, effect, group, customer, or grid cell without regenerating the level.
6. **Amounts are atomic unpacked releases.** Under the production behavior baseline, a queue amount
   expands into separate one-use items from one queue pick. Planning must measure destination
   capacity, burst occupancy, and the timing consequences of compressing several units into one
   queue line.
7. **Separate failure domains.** Picking-order deadlock is queue-only. Grid pressure, timeouts,
   supply, and the preserved legacy tool/grid checker remain separate diagnoses.
8. **Bounded search.** Search declares candidate, run, time, and iteration limits and returns the
   closest candidate with unresolved evidence when the budget ends.

## Production behavior baseline

The real game uses the default pair documented in
`CHANGELOG-2026-09-15-BEHAVIOR-MODES.md`; the Level Lab must model only this pair:

- Raw packing: **Unpacked raw**.
- Tool processing: **Auto**.
- Raw ingredients that cannot enter a tool: **Park raw on grid**.

Do not expose behavior-mode selection as a requirement dimension, constraint, proposal parameter,
search mutation, batch curve, or MCP dropdown equivalent. Do not evaluate Packing raw or
Wait-order alternatives. Browser-saved non-default preferences are editor experiments and are not
valid production evidence.

Canonical simulation semantics for every MCP evaluation and finalization:

1. Picking a queue slot with amount `N` creates `N` separate physical items.
2. At most one expanded item may enter an immediately available tool slot; every remainder needs
   its own grid destination.
3. The pick is atomic: if all expanded items do not have destinations, none are dispatched.
4. `multipleUsage` ingredients also expand into `N` separate items with usage amount 1. They do not
   form a reusable object under the production baseline.
5. Tool processes start automatically when their inputs are ready; they do not wait for an active
   matching order.

Create one shared `PRODUCTION_BEHAVIOR` constant and a behavior-semantics version. MCP simulation,
estimation, candidate comparison, proposal scoring, replay evidence, and finalization must all use
that constant. Store the version on evaluations so results become stale when semantics change.
Existing `outOfSlotPolicy` input remains readable for compatibility, but production evaluation
normalizes raw overflow to park-on-grid and reports a warning when a draft requests another value.

## Existing surface and compatibility

Keep all current tool names and behavior compatible:

- Discovery: `read_authoring_context`, `inspect_orderable`, `get_valid_dish_pieces`,
  `trace_ingredient`, `list_customer_avatars`, `explain_effect`, `explain_customer_rules`.
- Brief/session: `interpret_level_brief`, `start_level_session`, `get_level_session`,
  `plan_authoring_strategy`, `set_authoring_strategy`, `amend_session_requirements`.
- All current granular customer, dish, queue, amount, group, effect, and grid mutations.
- Evidence/output: `get_supply_demand`, `validate_draft`, `validate_level`,
  `estimate_difficulty`, `playtest_instant`, `checkpoint_level`, `restore_revision`, `undo`, and
  `finalize_level`.

Compatibility wrappers may advertise `supersededBy` in guidance, but must not silently change
their response contract in the first release.

## Requirement model

Add these core types to `src/mcp/types.ts`:

```ts
type RequirementPriority = "hard" | "target" | "preference";
type ConstraintOperator = "=" | "!=" | "<" | "<=" | ">" | ">=" | "between" | "in";

interface MetricConstraint {
  id: string;
  dimension: string;
  metric: string;
  operator: ConstraintOperator;
  value: number | string | boolean | [number, number] | string[];
  priority: RequirementPriority;
  weight: number;
  source: string;
  scope?: Record<string, string | number | boolean>;
  minimumRuns?: number;
  confidence?: number;
}

interface RefinedLevelRequirements {
  schemaVersion: 1;
  mapId: string;
  mode: "create" | "revise" | "batch";
  originalBrief: string;
  assumptions: string[];
  dimensions: Record<string, unknown>;
  constraints: MetricConstraint[];
  authorizedMechanics: MechanicAuthorization[];
  unresolved: RequirementGap[];
  confirmationStatus: "draft" | "confirmed" | "skipped" | "batch-inferred";
  confirmationNote?: string;
  contextToken: string;
  requirementToken: string;
}
```

The requirement token hashes the graph context token plus normalized dimensions and constraints.
`start_level_session` rejects stale or unconfirmed tokens except `skipped` and `batch-inferred`.

### Metric catalog

Create `src/mcp/constraintCatalog.ts`. A metric definition includes ID, dimension, type, unit,
allowed operators/range, statistical flag, description, default priority, evaluator, and likely
repair families.

Register these initial metric families:

- Fundamental: serialization/structural errors, exact supply, full service, timeout count, solver
  victory, provisional slot count.
- Experience: profile score, win rate, duration p50/p90, fail reasons, random-pick ratio, detour
  ratio, and forced-choice ratio.
- Queue: lane count/depth/balance, ingredient spread/clustering, linked/combined counts, effects,
  picking-order stuck rate, and reason distribution.
- Amount: compacted-unit ratio, amount-slot ratio, average/max amount, expanded item count,
  destination demand per pick, direct-to-tool count, grid-landing burst, atomic destination-block
  rate, unused supply, early large amounts, and amount-attributed occupancy.
- Grid/capacity: dimensions, usable cells, peak/p95 occupancy, dirty peak, overflow, serve slots.
- Customers/content: counts/roles, dish count, distinct composites, piece complexity, concurrency,
  admission width.
- Pacing: early/mid/late pressure, first feature position, work in flight, tool utilization, refill
  spacing, difficulty slope.
- Mechanics: authorized effect/group/special-customer counts, positions, key/lock balance.

### Requirement tools

Add:

1. `list_requirement_dimensions(map_id)` — checklist, legal values, map capabilities, defaults.
2. `list_constraint_metrics(dimension?)` — discover registered metric contracts.
3. `refine_level_requirements(map_id, brief, answers?, mode?, batch_spec?)` — normalized dimensions,
   constraints, assumptions, unresolved dimensions, and at most three grouped questions. Read-only.
4. `confirm_level_requirements(requirement_token, edits?, confirmation_note)` — persist the exact
   user-confirmed requirements and issue a confirmed token; it does not alter a level.
5. `get_refined_requirements(requirement_token)` — reload the user-visible summary.
6. `set_level_constraints(session_id, expected_revision, add?, update?, remove?)` — amend measurable
   requirements. Mechanics still require `amend_session_requirements` and explicit approval.

Make `interpret_level_brief` a compatibility wrapper around refinement pass one. Extend
`start_level_session` with `requirement_token`, retaining `brief` for legacy clients.

## Candidate and session architecture

Upgrade `SessionRecord` to schema version 2:

```ts
interface CandidateRecord {
  id: string;
  name: string;
  parentId?: string;
  basedOnRevision?: number;
  revision: number;
  draft: SessionDraft;
  history: CandidateRevision[];
  latestEvaluationId?: string;
  status: "active" | "kept" | "rejected" | "finalized";
}

interface SessionRecordV2 {
  requirements: RefinedLevelRequirements;
  activeCandidateId: string;
  candidates: Record<string, CandidateRecord>;
  proposals: Record<string, ProposalRecord>;
  evaluations: Record<string, EvaluationRecord>;
  seedSets: Record<string, EvaluationSeedSet>;
  searchObservations: SearchObservation[];
}
```

On load, upgrade a v1 session into `candidate-main` without rewriting its action log. Save v2
atomically. Revisions are per candidate; an additional session event sequence orders audit entries.

Add `list_level_candidates`, `create_level_candidate`, `select_level_candidate`,
`rename_level_candidate`, `reject_level_candidate`, `compare_level_candidates`,
`checkpoint_candidate`, and `restore_candidate_revision`. Existing checkpoint/restore/undo tools
target the active candidate.

## Guided REPL status

Add `get_authoring_status(session_id)` as the orientation tool. Return:

- Phase: requirements, strategy, skeleton, supply, mechanics, tuning, final-verification, complete.
- Active candidate/revision and confirmed constraints.
- Hard blockers and largest normalized target gaps.
- Evidence invalidated by later mutations.
- Up to five typed `nextActions` with tool name, argument template, rationale, expected metric
  direction, authorization requirement, and mutation/read-only flag.
- Iteration/search budget use.

Extend mutation responses with `invalidatedEvidence`, `largestGaps`, and `nextActions`. Guidance is
advisory and never auto-applied.

## Proposal system

Create `src/mcp/proposalService.ts`. A proposal stores base candidate/revision, deterministic seed,
actions, expected supply delta, expected metric direction, authorization requirements, warnings,
and expiry reason.

Generic tools:

- `get_proposal`
- `apply_proposal` — validate and apply all actions as one revision.
- `discard_proposal`

Proposal producers:

- `propose_customer_plan`
- `propose_dish_plan`
- `propose_queue_plan`
- `propose_amount_plan`
- `propose_grid_plan`
- `propose_effect_plan`
- `propose_repair_mutations`

No producer grants mechanic authorization. Return an otherwise useful blocked proposal with the
exact approval requirement.

## Amount-aware planning

Create `src/mcp/amountPlanner.ts` using graph demand, process yields, stack ranges, queue/group/effect
geometry, current grid capacity, and the fixed production behavior:

1. Expand customer demand into provenance-tagged raw pickup units.
2. Divide demand into configurable customer waves.
3. Generate integer partitions per ingredient using `1` and `stackMin..stackMax`. The partition
   compresses authored queue lines; it does not create a runtime bag.
4. For every candidate amount `N`, calculate its atomic destination requirement at the expected
   pick point: at most one item may enter a tool, while all remaining items need distinct grid
   cells.
5. Reject or heavily penalize partitions that cannot dispatch atomically in exact simulation.
6. Penalize an amount that releases demand much earlier than its consumer wave, creates a large
   grid-landing burst, removes too many thaw opportunities by collapsing queue lines, or changes
   linked/combined pickup timing in a way that violates constraints.
7. Treat `multipleUsage` as graph metadata only for the production runtime: amount `N` still becomes
   `N` independent usage-1 items. Do not award reusable-object occupancy savings.
8. Preserve exact supply after process yield and expose unavoidable overproduction.
9. Score queue-line compression, atomic pick success, burst occupancy, early release distance,
   amount-attributed peak occupancy, effect/group timing, unused supply, and target utilization.
10. Return conservative, balanced, and aggressive amount partitions as authoring choices only;
    they all execute with Unpacked raw + Auto semantics.

Add `analyze_amount_utilization` with per-slot provenance, expanded destination counts, blocked-pick
evidence, and repair targets. Existing set/split/merge amount tools remain the manual correction
path. Common repairs are splitting a blocked burst, moving a large amount later, moving it to a lane
whose pick occurs with more grid capacity, or reducing concurrent releases without changing total
supply.

## Generation primitives

Generation stays decomposed and inspectable:

- Customer proposal: roles, avatars, dishes, admission/concurrency plan.
- Dish proposal: graph-valid pieces, bases, raw-demand consequences.
- Queue proposal: lanes and stable slots from demand provenance, optionally using an amount plan.
- Grid proposal: capacity/effect skeleton within authorization.
- Effect proposal: placement after the ordinary level is playable.

Add `propose_level_skeleton` to compose customer/dish/queue planning while still returning the
action list before application. Add bounded `run_search_step` and `run_candidate_search` with
explicit candidate, evaluation, run, iteration, and wall-time limits. Do not add an unbounded
`generate_until_satisfied` tool.

## Evaluation and evidence

Add `evaluate_level(session_id, candidate_id?, constraint_ids?, seed_set_id?, runs?, profile?)`.
It composes current validation/estimate/playtest logic and new statistical analyzers and persists:

- Candidate revision, graph context, seed set, and run count.
- Metric values and confidence intervals.
- Constraint pass/miss, normalized distance, priority, and weighted score.
- Hard failures and failure/reason distributions.
- Evidence/case IDs and amount, pacing, supply, occupancy, queue-order summaries.
- Recommended mutation families, never auto-applied actions.

Profiles are `fast-shape`, `tuning`, `final`, and custom. Final uses a configured high-run batch.
Profiles vary cost and statistical confidence, never runtime behavior. Do not accept packing or
process-mode overrides on this API. Cache identity includes the behavior-semantics version, not a
mode selection, and replay is bound to the production baseline recorded by its evaluation.

Add:

- `simulate_level_batch`
- `validate_picking_deadlocks` — queue order only, never grid state.
- `get_deadlock_cases` — 10 distinct stuck-position hashes normally, 50 for full checks, including
  pick sequences and stopped queue snapshots.
- `analyze_queue_pacing`
- `analyze_amount_utilization`
- `diagnose_constraint_gaps`
- `get_evaluation`
- `create_evaluation_seed_set` and `list_evaluation_seed_sets`

`simulate_level_batch` always constructs simulations with Unpacked raw, Auto processing, and raw
park-on-grid. Amount-related grid blocking is capacity/atomic-dispatch evidence, not queue-only
picking deadlock.

Keep focused `validate_level`, `estimate_difficulty`, and `playtest_instant` calls. Expose the
preserved legacy tool/grid check under a distinct diagnostic name/field; never merge its rate into
`pickingDeadlock.stuckRate`.

## Mutation experiments and search memory

Represent proposed actions with the existing granular tool schemas. Add:

- `evaluate_mutation_batch` — clone in memory, apply transactionally, evaluate, discard temporary.
- `rank_mutation_candidates` — compare bounded batches using identical evidence.
- `apply_mutation_batch` — apply the selected batch as one revision.
- `record_search_observation` — store hypothesis, before/after evidence, and disposition.
- `suggest_level_mutations` — use metric repair families, object provenance, and prior observations.

Reject an entire batch on stale revision, invalid stable ID, authorization miss, or any failed
action. Never partially apply.

## Batch generation

Add:

- `start_level_batch(map_id, context_token, batch_spec, seed?)`
- `plan_level_batch(batch_id)`
- `run_level_batch_step(batch_id, max_levels?, budget_ms?)`
- `get_level_batch_status(batch_id)`
- `finalize_level_batch(batch_id)`

The batch specification covers level count, difficulty/complexity curve, mechanic introduction
cadence, repetition limits, amount-utilization curve, validation profile, and output naming. It has
no behavior-mode dimension; every member uses the production baseline. The
skill states inferred assumptions once and does not pause for per-level confirmation. Missing map,
level count, destructive destination, or mechanic authorization remains a blocker.

## Service/module layout

Keep `server.ts` registration-only and split the growing service:

```text
src/mcp/
  server.ts
  service.ts                 facade and compatibility methods
  types.ts
  repository.ts
  sessionStore.ts
  serializers.ts
  brief.ts                   compatibility wrapper
  requirementRefinement.ts
  constraintCatalog.ts
  constraintEvaluation.ts
  candidateService.ts
  proposalService.ts
  amountPlanner.ts
  productionBehavior.ts
  generationService.ts
  evaluationService.ts
  mutationExperiment.ts
  searchService.ts
  batchService.ts
```

Pure planners/evaluators receive resources and typed drafts; only stores write files. The facade
resolves session/candidate/revision, delegates, atomically saves, and appends one audit event.

## Persistence

Extend each session directory:

```text
session.json
actions.ndjson
requirements.json
candidates/<candidate-id>/versions/
proposals/<proposal-id>.json
evaluations/<evaluation-id>.json
seed-sets/<seed-set-id>.json
search-observations.ndjson
```

Large traces and deadlock snapshots live in evaluation files, not `session.json`. Records contain
relative artifact paths. Apply size caps and retain representative cases by structural hash.

## Response standard

All new tools use:

```ts
interface ToolEnvelope<T> {
  ok: boolean;
  sessionId?: string;
  candidateId?: string;
  revision?: number;
  data: T;
  findings: ValidationFinding[];
  invalidatedEvidence: string[];
  nextActions: NextAction[];
  artifactRefs: ArtifactRef[];
}
```

Default to concise summaries with `detail: "summary" | "full"`. Errors have stable codes and the
smallest recovery action. Never return full graph/session/evaluation history unless requested.

## Implementation phases

### Phase 0 — characterize and extract

- Golden-test all current tools and session-v1 fixtures.
- Extract draft/runtime serializers without changing behavior.
- Capture baselines for validation, estimate, playtest, amounts, and finalization.
- Characterize Unpacked raw + Auto dispatch, atomic blocking, park-on-grid, cache identity, and
  replay binding. Preserve alternative-mode code/tests outside the MCP plan, but do not make those
  modes Level Lab options.

Exit: current MCP tests and golden responses pass unchanged.

### Phase 1 — requirements and guidance

- Implement metric/dimension catalogs and refinement/confirmation.
- Add requirement tokens, session-v2 migration, `get_authoring_status`, and response guidance.
- Preserve legacy brief-based session start.

Exit: vague briefs yield grouped questions; confirmed summaries round-trip; unconfirmed
interactive requirements cannot mutate; skip and batch paths are covered.

### Phase 2 — candidates, seeds, unified evaluation

- Add candidate tools, seed sets, evaluation records, constraint scoring, comparison, evidence
  invalidation, queue-only deadlock evidence, and separate legacy diagnostics.

Exit: candidates compare on identical seeds and restore independently.

### Phase 3 — proposals and amount planning

- Add proposal lifecycle, demand provenance, amount analysis/partitioning, and skeleton proposals.

Exit: an amount-heavy brief yields explainable queue-compression alternatives preserving exact
supply; every proposed amount passes atomic destination checks under Unpacked raw, with atomic
apply/revert.

### Phase 4 — experiments and guided repair

- Add transactional mutation experiments, ranking, gap diagnosis, and search memory.
- Drive `get_authoring_status` from gaps and previous outcomes.

Exit: evaluate three repairs without mutating active state, apply the winner, show before/after.

### Phase 5 — bounded search and batches

- Add candidate search, batch sessions, derived seeds, resumable progress, cancellation, and batch
  finalization.

Exit: deterministic interrupted batches resume and export only individually valid levels.

### Phase 6 — rollout

- Roll out the revised `design-level` skill alongside Phase 1 and progressively enable later tools.
- Document compatibility wrappers; do not remove them in this project cycle.

## Verification

Unit coverage:

- Dimension completeness, aliases, ambiguity, confirmation/skip/batch paths, token freshness.
- Metric typing/operators, distance, weighting, confidence.
- Ordinary and `multipleUsage` amount partitions under Unpacked raw, yields, remainders, wave gaps,
  per-pick destination counts, and atomic dispatch rejection.
- Picking deadlocks independent of grid state and structural case hashes.
- Candidate isolation, transaction rollback, evidence invalidation, session-v1 migration.

Contract coverage:

- Tool discovery/schemas/annotations, compatibility responses, stable error recovery.
- Stale tokens/revisions, unauthorized mechanics, expired proposals, atomic batch rejection.

End-to-end scenarios:

- Vague single-level brief requires clarification and confirmation.
- Explicit skip begins with recorded assumptions.
- Batch request bypasses per-level confirmation.
- Amount-heavy Map 1 and Map 2 candidates meet queue-compression targets without supply drift or
  assuming reusable-object behavior.
- Every MCP evaluation ignores persisted browser dropdown choices and records the production
  behavior-semantics version.
- An amount pick with insufficient destinations blocks atomically; splitting it can repair the
  candidate without changing supply.
- Linked/Freeze picking deadlocks remain separate from grid pressure.
- Candidate comparison shares seeds and selects the better constraint score.
- Finalization rejects timeout wins, hard misses, provisional supply, and stale evidence.

Performance targets:

- Warm context/status reads under 200 ms.
- Fast evaluation under 2 seconds for a typical level.
- Mutation/search calls respect declared wall-time budgets.
- Full deadlock/final simulation is cancellable between runs and writes bounded artifacts.

Commands:

```powershell
npm run mcp:typecheck
npm test -- --run src/mcp
npm test -- --run src/ui/design/queueThawCheck.test.ts
npm run build
```

Validate the revised skill with `skill-creator/scripts/quick_validate.py` when its Python dependency
is available, plus prompt walkthroughs for vague, skipped, and batch briefs.

## Definition of done

- An agent discovers missing brief dimensions, presents a complete refined requirement, and starts
  only after confirmation or an explicit bypass.
- The agent always knows phase, blockers, largest gaps, stale evidence, and useful next actions.
- Candidates and mutation experiments are reversible and compared with common seeds.
- Amount plans model queue compression followed by atomic expansion into independent items, explain
  merges/splits, and never claim one-cell bag or reusable-object savings.
- All generation, evaluation, comparison, replay evidence, and finalization use Unpacked raw + Auto
  with park-on-grid; dropdown alternatives are outside the production Level Lab contract.
- Picking deadlock, grid pressure, timeouts, supply, and legacy tool/grid diagnostics are separate.
- Batch runs are deterministic, resumable, bounded, and individually validated.
- Finalization emits only fully valid artifacts and never modifies canonical level data.

## Implementation status — 2026-09-15

All phases now have an implemented web/MCP path while the Unity side remains intentionally out of
scope:

- Phase 0 preserves legacy granular tools and the separate legacy tool/grid diagnostic through
  contract and regression coverage.
- Phase 1 implements the complete requirement-dimension checklist, grouped clarification,
  confirmation/skip/batch tokens, measurable constraints, and guided authoring status.
- Phase 2 implements isolated candidates, deterministic seed sets, persisted unified evaluation,
  comparison, evidence invalidation, and queue-only deadlock reports with bounded structural cases.
- Phase 3 implements proposal persistence and atomic apply/discard for customer, dish, composed
  skeleton, exact-supply queue, amount compression/repair, grid, and queue-effect plans. Special
  mechanics remain blocked until explicitly authorized.
- Phase 4 implements non-mutating mutation experiments, identical-seed ranking, atomic winner
  application, constraint-gap diagnosis, focused suggestions, and persisted search observations.
- Phase 5 implements bounded search steps/candidate search and deterministic, resumable,
  cancellable batch planning/execution with individually validated-only export.
- Phase 6 updates the `design-level` skill and MCP server guidance to use this pipeline while
  retaining compatibility fallbacks.

Current automated coverage verifies MCP discovery and end-to-end requirement, candidate,
proposal, amount, experiment, search, batch, authorization, deadlock, and persistence behavior.
Performance profiling and finer-grained cancellation inside a single simulator invocation remain
operational hardening rather than missing workflow phases.
