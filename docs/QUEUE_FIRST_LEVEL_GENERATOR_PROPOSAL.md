# Unified Level Generator Proposal

## Status

Implemented as a unified Level Generator workspace with two persistent strategies.

Implementation status: Milestones 1–5 and the Google Sheets integration gate are implemented under
`src/generation/queue-first/`, `src/data/generatorPersistence/`, and `src/ui/queue-first/`. The
implementation includes artifact/vector contracts, readiness and stale gates, deterministic queue
generation, manual and bounded automatic pickup planning, bounded graph-valid dish enumeration,
exact-cover customer generation, manual customer/dish allocation, provenance, final structural
commit validation, compressed sheet persistence/recovery, conflict detection, and the visual
workspace in current Design mode. The former Auto Generate and Queue First entry points are now one
Level Generator button. Customer-first uses Setup → Review; queue-first uses Queue → Pickup →
Customers → Review. Both drafts survive strategy switching, while seed, stable-name ingredient
weights, amount ranges, and normalized obstacle coverage share one source of truth. Difficulty
estimation and playtesting remain the existing
post-commit quality buttons. `project-to-orderable` and `strict-orderable` continue to require an
injected orderability adapter and fail explicitly when one is unavailable.

The current implementation stores a `gw2_` `GeneratorWorkspaceEnvelopeV2` in the existing
customer-generator sheet cell. It contains the shared profile, active strategy, and the complete
customer-first draft; queue/pickup/customer phase payloads remain in their existing cells. Legacy
`cg1_` and uncompressed fields migrate in memory and are not rewritten until an explicit sheet save.

## Unified workspace interaction model

The workspace has a persistent strategy switch and a common three-column shell:

```text
Level Generator   [Customers → Queue | Queue → Pickup → Customers]   [draft] [sheet] [Close] [⋯]

[step rail]       [Visual | JSON configuration and preview]          [validation / provenance]

                                                        [one contextual primary action]
```

- Customer-first exposes **Setup → Review** and one **Generate Preview** action before commit.
- Queue-first exposes **Queue → Pickup → Customers → Review**. Each phase requires a confirmed
  vector and a valid, current prerequisite artifact.
- Drafts autosave locally after edits. Sheet save/recover, partial phase export/apply, and repair
  actions live in contextual menus.
- Shared controls render once and synchronize Visual/JSON editing. Invalid JSON blocks the mode
  change and reports an inline issue.
- Queue-first fields that are not consumed are retained in recovered JSON but are not presented as
  working visual controls. Dish availability is an enable/disable control until numeric weighting
  is implemented.
- The visible primary action is exactly one of **Generate Preview**, **Confirm Settings**,
  **Run / Continue**, **Review**, or **Commit to Level**, according to current state.

Shared obstacle authoring uses coverage, not absolute counts. Grid categories use total grid cells
and share a 50% cap; queue categories use total slots and retain explicit size 2–5 group targets;
customer categories use ordering customers and cap bosses at one. The UI shows percentage and
projected count. Both strategies materialize compatible legacy `obstacleData` counts only when a
preview or final level has real denominators.

The current generator starts with customer orders, expands those orders into raw ingredient demand,
and then builds a queue that supplies the demand. This proposal introduces an independent,
queue-first workflow:

```text
Authoring-context artifact + user-confirmed queue vector
    -> Phase 1: queue artifact

Queue artifact + user-confirmed pickup-planning vector
    -> Phase 2: baseline pickup-plan artifact

Queue artifact + complete pickup-plan artifact + user-confirmed customer vector
    -> Phase 3: customer-order artifact
    -> existing validation, estimation, and playtesting
```

Each phase can be run, saved, edited, validated, and rerun separately. A later phase never silently
changes an earlier artifact. No phase may start from defaults or partial UI state: the user must
review and confirm that phase's vector, and every required input artifact must exist, be valid, and
be current.

## Motivation

Demand-first generation is a strong fit when customer pacing and recipe composition define the
level. It is less direct when the intended experience starts from queue geometry, such as:

- a specific distribution of ingredients across lanes;
- deliberate ingredient clustering or alternation;
- separate rates for two-, three-, four-, and five-slot combined groups;
- separate rates for two-, three-, four-, and five-slot linked groups;
- a planned amount of Freeze, Hidden, or HoldingKey effects;
- a designer-authored route through multiple legal front-lane choices;
- customer orders derived from, and guaranteed to consume, an existing queue.

The proposed generator treats the queue and its legal pickup route as the primary design objects.
Customer orders become a constrained inverse-recipe problem instead of the source of queue demand.

## Goals

1. Generate a reproducible queue from a measurable input vector.
2. Support independent configuration for combined and linked groups of sizes two through five.
3. Support queue effects without bypassing their structural safety rules.
4. Let a designer manually author a baseline pickup route or generate one automatically.
5. Generate graph-valid customer orders that exactly consume the queue supply.
6. Preserve stable identities and provenance across every phase.
7. Detect stale downstream artifacts after an upstream edit.
8. Reuse existing queue, recipe, validation, estimation, and serialization code.
9. Give every phase an explicit user-authored vector and a machine-checkable start gate.
10. Provide visual editors for queue parameters, pickup paths, and customer allocation along the
    selected pickup path.
11. Persist and recover both generator workflows through the existing per-level Google Sheet row.
12. Keep playable level strings separate from generator provenance so recovering a workspace never
    silently replaces the current level.

## Non-goals

- Replacing the current demand-first generator.
- Making the baseline pickup plan mandatory at runtime.
- Silently repairing the queue while generating customer orders.
- Inferring unauthorized grid obstacles, customer roles, timers, or dish effects.
- Writing canonical level strings during intermediate generation.
- Treating a valid supply/demand total as proof that a level is playable.
- Background or automatic Google Sheet writes without an explicit designer action.
- Using generator artifacts as a replacement for the canonical customer, grid, or queue columns.

## Core design principles

### Immutable phase artifacts

Every phase returns a versioned artifact. Artifacts contain stable IDs, their generating inputs,
diagnostics, and a hash of the upstream artifact. Editing a queue invalidates its pickup plan and
customer plan, but does not automatically regenerate either one.

### Explicit vector confirmation and start gates

Each phase owns a separate input vector. Suggested values may be populated from references or a
previous run, but suggestions are not executable input. The user must explicitly save and confirm
the vector before the phase can start. Confirmation creates an immutable vector artifact; changing
any field creates a new draft revision and disables Run until it is confirmed again.

A phase starts only when both conditions are true:

1. its confirmed vector artifact exists and matches the current graph/context; and
2. every prerequisite artifact exists, is valid, is not stale, and has the expected content hash.

The UI and service return structured readiness failures rather than silently creating missing
artifacts, inheriting an earlier phase's settings, or choosing defaults.

### Physical units and authored slots remain distinct

Ingredient weights describe physical pickup units. Queue group rates describe authored queue cells.
An amount slot occupies one queue cell but atomically releases multiple independent one-use items.
This distinction prevents amount selection from distorting the requested ingredient distribution.

### Exactness before preference

Hard constraints are evaluated before soft generation preferences:

1. valid queue and group geometry;
2. complete legal pickup route;
3. graph-valid dishes;
4. exact raw supply and demand after process yields;
5. playability and timeout safety;
6. target texture, variety, and pacing.

### No implicit upstream mutation

If Phase 3 cannot consume the queue exactly, it returns an infeasibility report and optional repair
proposals. Applying a repair is a separate, explicit operation that invalidates the old pickup plan.

## Shared artifact envelope

```ts
interface GeneratorArtifact<TKind extends string> {
  schemaVersion: 1;
  kind: TKind;
  id: string;
  createdAt: string;
  seed: number;
  graphHash: string;
  upstreamHashes: string[];
  contentHash: string;
  status: "draft" | "valid" | "invalid" | "stale";
  warnings: string[];
}

interface PhaseVectorArtifact<TKind extends string, TVector>
  extends GeneratorArtifact<TKind> {
  values: TVector;
  confirmedAt?: string;
  confirmedBy?: string;
  contextHash: string;
}

interface AuthoringContextArtifact extends GeneratorArtifact<"authoring-context"> {
  mapId: string;
  graphHash: string;
  referenceProfileId: string;
  authorizedMechanics: string[];
  constraints: Record<string, unknown>;
}
```

The content hash covers generation-relevant fields rather than timestamps or display-only labels.
This makes stale detection deterministic. Vector artifacts are user-owned inputs, not generator
outputs; phase outputs store the exact vector hash and prerequisite artifact hashes they consumed.

## Phase readiness contract

| Phase | Required user-confirmed vector | Required artifact inputs | Run is blocked when |
| --- | --- | --- | --- |
| Phase 1: Queue | `QueueGenerationVectorArtifact` | current `AuthoringContextArtifact` | vector is draft/missing, context is missing/stale, or graph hashes differ |
| Phase 2: Pickup | `PickupPlanningVectorArtifact` | valid current `QueueArtifact` | vector or queue is missing, queue is invalid/stale, or hashes differ |
| Phase 3: Customers | `CustomerGenerationVectorArtifact` | valid current `QueueArtifact` and complete valid `PickupPlanArtifact` | any input is missing/stale, the plan is partial, or its queue hash differs |

`get_phase_readiness(phase)` returns every failed prerequisite with a repair action. `start_phase`
must reject the request if any prerequisite fails, even when the core generator could infer a usable
default.

## Phase 1: Generate the ingredient queue

### Input vector

```ts
interface QueueGenerationVector {
  seed: number;

  laneCount: number;
  targetPickupUnits: number;
  targetQueueSlots?: number;
  targetLaneDepth?: number;

  ingredientWeights: Record<string, number>;
  amountMode: "conservative" | "balanced" | "aggressive";
  amountRanges?: Record<string, { min: number; max: number }>;

  texture: {
    maximumIdenticalRun?: number;
    maximumCrossLaneMirroring?: number;
    targetTransitionEntropy?: number;
    targetLaneImbalance?: number;
  };

  obstacleCoverage: {
    freeze: number;
    hidden: number;
    holdingKey: number;
  };

  freezeStrength?: {
    minAdjacentPicks: number;
    maxAdjacentPicks: number;
  };

  combinedCoverageBySize: GroupSizeCoverage;
  linkedCoverageBySize: GroupSizeCoverage;

  feasibilityMode: "free" | "project-to-orderable" | "strict-orderable" | "runtime-feasible";

  // 0 requires every available choice to retain a winning continuation.
  // 1 requires one verified route and prefers lower branching.
  forceMove?: number;
}

interface GroupSizeCoverage {
  2: number;
  3: number;
  4: number;
  5: number;
}

type QueueGenerationVectorArtifact = PhaseVectorArtifact<
  "queue-vector",
  QueueGenerationVector
>;
```

At least one queue-size target is required. `targetPickupUnits` is recommended because it remains
meaningful when amount compaction changes the number of authored slots. When both unit and slot
targets are present, unit count is hard and slot count is a bounded optimization target.

Phase 1 requires a confirmed `QueueGenerationVectorArtifact` and a current
`AuthoringContextArtifact`. It cannot start from a raw form value, an unconfirmed suggestion, or a
graph hash alone.

### Rate semantics

Every group-size rate is the target fraction of all authored queue cells that should belong to that
kind and size. For a queue with `S` cells, a size-`N` target rate `R` produces approximately:

```text
targetGroupCount(N) = round(S * R / N)
```

For example, `combinedCoverageBySize[3] = 0.12` targets about four size-three combined groups in a
100-cell queue. This definition is measurable, independent for each size, and less sensitive to
placement order than an anchor probability.

The sum of all combined and linked coverage targets must not exceed one. The generator reports
actual coverage and the reason for any placement shortfall.

### Feasibility modes

#### `free`

The ingredient vector is sampled without considering whether it can become customer orders. This is
useful for experiments and manual workflows, but Phase 3 may have no exact solution.

#### `project-to-orderable` — recommended

The generator projects the requested weighted counts to the nearest supply vector that has at least
one graph-valid order decomposition. It may make small count adjustments and reports every delta.
It does not commit customer identities, customer boundaries, or arrival order.

#### `strict-orderable`

The requested counts are hard. Generation fails if the exact vector has no order decomposition.

#### `runtime-feasible`

Queue generation runs the same structural state transitions used by the Pickup simulator and emits a
complete, replayable pickup witness with the Queue artifact. Grid capacity is a hard authoring
constraint: every atomic pickup (a single slot or an entire combined/linked group) must release no
more items than the currently available grid cells. A 12-item atomic pickup on a grid with 10
available cells invalidates the candidate; it is not a scoring penalty.

`forceMove` maps from open to forced play. At `0`, every legal choice at every explored state must
retain a winning continuation. At `1`, at least one winning continuation is required and lower
branching is preferred so the result tends toward one feasible route. Intermediate values require
`ceil(legalChoices * (1 - forceMove))` winning continuations, with a minimum of one. Search is
deterministic, memoized by structural state, and bounded by state and wall-time budgets.

Queue generation evaluates a small deterministic set of layout/group/effect candidates. After the
hard checks pass, candidate selection uses force-move as a branching objective: values near `0`
prefer higher average legal branching, while values near `1` prefer lower branching along the
verified route. This is an optimization target, not permission to accept an invalid candidate.

When this mode succeeds, its witness is immediately materialized as the Phase 2 Pickup timeline.
The designer can scrub or edit that timeline normally; continuing manually from an earlier point
still truncates the forward path through the existing undoable edit flow.

### Algorithm

1. Validate the graph, dimensions, rates, amount ranges, and authorized mechanic set.
2. Convert ingredient weights into exact physical-unit quotas with largest-remainder allocation.
3. Apply the selected recipe-feasibility policy. For `runtime-feasible`, snapshot the current grid's
   available-cell capacity into the authoring context.
4. Partition each ingredient quota into authored slots:
   - use amount `1` for legal remainders;
   - otherwise prefer the graph `stackRange` or explicit override;
   - never create supply merely to reach a preferred minimum;
   - score atomic release pressure as amounts increase.
5. Lay out slots with seeded balanced interleaving rather than ingredient sorting.
6. Optimize lane balance, identical runs, cross-lane mirroring, transition entropy, and local
   dominance.
7. Place combined groups before queue effects:
   - every group has two through five members;
   - members form a four-connected shape;
   - no cell appears in more than one group;
   - shapes are rejected when their movement geometry is invalid.
8. Place linked groups on remaining cells:
   - adjacency is not required;
   - depth spread is penalized to avoid chains that synchronize only very late;
   - no cell appears in more than one group.
9. Place queue effects:
   - Hidden is informational and may be placed by texture rules;
   - Freeze placement accounts for four-connected adjacent thaw sources;
   - HoldingKey may be authored, but full key/lock balance remains pending until a grid plan exists.
10. Run the existing queue-only Freeze/linked structural audit.
11. Return diagnostics instead of silently relaxing unmet targets.

### Output

```ts
interface QueueArtifact extends GeneratorArtifact<"queue"> {
  contextHash: string;
  vectorHash: string;
  lanes: Array<{
    id: string;
    slots: QueueArtifactSlot[];
  }>;
  groups: QueueArtifactGroup[];
  feasibilityCertificate?: {
    mode: "project-to-orderable" | "strict-orderable";
    exactDecompositionExists: boolean;
    projectedUnitDelta: Record<string, number>;
  };
  diagnostics: QueueGenerationDiagnostics;
}

interface QueueArtifactSlot {
  id: string;
  ingredient: string;
  amount: number;
  effects: EffectInstance[];
  provenance: "generated" | "manual" | "repair";
}

interface QueueArtifactGroup {
  id: string;
  kind: "combined" | "linked";
  slotIds: string[];
}
```

### Phase 1 validation gate

Phase 1 is valid only when:

- every ingredient resolves to a pickupable graph node;
- unit and slot totals are internally consistent;
- amounts are positive and within configured policy;
- group members exist, do not overlap, and satisfy their geometry;
- generated mechanic use is explicitly authorized;
- Freeze and linked structure has at least one complete structural solution;
- texture and coverage misses are quantified.

An orderability certificate is required only in `project-to-orderable` and `strict-orderable` modes.
The gate also rejects an output whose `contextHash` or `vectorHash` is not the exact hash supplied to
the phase start request.

## Phase 2: Assign the baseline pickup sequence

The baseline sequence is a design intent and analysis artifact. Runtime players remain free to make
any legal choice.

### Input vector and prerequisite artifact

```ts
interface PickupPlanningVector {
  seed: number;
  mode: "manual" | "auto" | "manual-with-auto-suffix";
  completionPolicy: "require-manual-complete" | "allow-auto-suffix";
  targetWaveSize?: number;
  preferLaneBalance: number;
  preferIngredientWaveAlignment: number;
  penalizeAmountBurst: number;
  search: {
    beamWidth: number;
    maximumExpandedStates: number;
    wallTimeMs: number;
  };

  holdingKeyColors?: number[];
}

type PickupPlanningVectorArtifact = PhaseVectorArtifact<
  "pickup-vector",
  PickupPlanningVector
>;
```

Phase 2 requires a confirmed `PickupPlanningVectorArtifact` and a valid current `QueueArtifact`.
Manual mode still requires a vector: it records path policy, completion policy, scoring hints, and
the seed used for legal-choice ordering and any auto-completed suffix. The phase creates a draft
pickup-plan artifact before the first manual action; it must not open an editable path session when
the queue artifact is missing or stale.

### Atomic pickup actions

The plan records actions rather than individual cells:

- a normal slot produces one action;
- an amount slot produces one action and releases `amount` independent units;
- a combined group produces one action containing all group members;
- a linked group produces one action only when every member is at the front;
- a frozen member blocks its containing action until its own thaw requirement is satisfied.

This distinction is necessary because numbering every tile independently would misrepresent grouped
and amount pickups.

### Manual assignment

The editor exposes only currently legal next actions. Selecting any member of a grouped action adds
the entire action. The editor should show:

- legal choices;
- blocked choices and reasons;
- ingredient units released by the selected action;
- queue state after each step;
- Undo, Redo, Clear Remaining, and Auto-complete Remaining.

A manual plan may be saved with `status: "partial"`. Phase 3 requires a complete plan unless the
designer explicitly requests automatic completion of the suffix.

### Automatic assignment

Use bounded beam search over structural queue states. The state includes remaining slots, group
geometry, front positions, and per-slot Freeze progress. It does not include customer or grid state.

Suggested score:

```text
score =
    unlocked slot gain
  + lane balance reward
  + linked-group synchronization progress
  + ingredient target-wave alignment
  + future legal-action count
  - premature amount burst cost
  - single-source Freeze risk
  - projected blockage risk
```

Search limits must be explicit: beam width, maximum expanded states, wall time, and tie-break seed.
A failed bounded search is reported as inconclusive unless the complete queue-only checker proves a
deadlock.

### Output

```ts
interface PickupPlanArtifact extends GeneratorArtifact<"pickup-plan"> {
  queueHash: string;
  vectorHash: string;
  mode: "manual" | "auto" | "manual-with-auto-suffix";
  completion: "partial" | "complete";
  steps: PickupPlanStep[];
  diagnostics: {
    actionCount: number;
    groupedActionCount: number;
    amountBurstHistogram: Record<number, number>;
    maximumLegalBranching: number;
    expandedStates: number;
    deadlockFree: boolean | "inconclusive";
  };
}

interface PickupPlanStep {
  index: number;
  actionId: string;
  slotIds: string[];
  releasedUnits: Record<string, number>;
  legalAlternatives: string[];
  reason?: string;
  stateHashAfter: string;
}
```

### Phase 2 validation gate

A complete plan is valid only when:

- its `queueHash` matches the current queue artifact;
- every step was legal in the state produced by its preceding step;
- every queue slot is consumed exactly once;
- grouped members are consumed atomically;
- amount totals equal Phase 1 supply;
- the plan ends with an empty queue;
- the queue-only structural checker finds no deadlock on the route.

The vector hash must match the confirmed pickup vector used to start the phase. A partial manual
plan is a saveable draft artifact, but it is not a valid prerequisite for Phase 3.

## Phase 3: Generate customer orders

Phase 3 is an inverse-recipe and scheduling problem. It must find legal dishes whose raw pickup
demand exactly equals the existing queue supply, then arrange those dishes into customer waves that
fit the baseline pickup plan.

### Input vector and prerequisite artifacts

```ts
interface CustomerGenerationVector {
  seed: number;
  mode: "manual" | "auto" | "manual-with-auto-suffix";
  minCustomers: number;
  maxCustomers: number;
  minDishesPerCustomer: number;
  maxDishesPerCustomer: number;
  maxDishSlots: number;
  serveableSlots: number;

  complexityCurve?: CurveState;
  dishTypeWeights?: Record<string, number>;
  preferredIngredientVariety?: number;
  maximumRepeatedDishRun?: number;

  earlyInventoryWeight: number;
  pickupToDemandDistanceWeight: number;
  varietyWeight: number;

  search: {
    beamWidth: number;
    maximumCandidates: number;
    maximumExpandedStates: number;
    wallTimeMs: number;
  };
}

type CustomerGenerationVectorArtifact = PhaseVectorArtifact<
  "customer-vector",
  CustomerGenerationVector
>;
```

Phase 3 requires a confirmed `CustomerGenerationVectorArtifact`, the current valid
`QueueArtifact`, and a complete valid `PickupPlanArtifact` whose `queueHash` matches that queue.
Manual mode creates an initially empty customer artifact and lets the user allocate legal dishes and
customers against the pickup path. Auto mode solves the whole phase. Manual-with-auto-suffix locks
the user's existing allocations and solves only the remaining exact supply. None of these modes may
start if a prerequisite artifact is absent.

Special customers, timers, dish effects, and grid effects are excluded unless separately authorized.
The ordinary generator should establish a playable baseline before those mechanics are introduced.

### Algorithm

1. Expand every pickup action into timestamped raw-unit supply events while retaining slot and action
   provenance.
2. Enumerate bounded graph-valid dish templates:
   - valid orderable composite;
   - required base and topping structure;
   - group minimum and maximum quantities;
   - per-ingredient limits;
   - maximum dish slots;
   - multi-input process paths and production yields.
3. Calculate each template's raw pickup signature using the same graph semantics as the existing
   demand expansion.
4. Solve an exact-cover problem that selects a multiset of templates whose combined pickup signature
   equals Phase 1 supply.
5. Schedule selected dishes against the pickup steps:
   - prefer a dish whose inputs arrive near one another;
   - minimize units picked before an active customer can consume them;
   - prefer bases before their gated toppings;
   - avoid opening more concurrent production paths than the grid and tools can absorb.
6. Pack the scheduled dishes into customers according to customer-count, dish-count, and complexity
   targets.
7. Order customers to preserve the schedule and configured serveable-slot concurrency.
8. Expand the generated customers back to pickup demand and compare it with the queue.
9. Run graph validation, fundamental level validation, difficulty estimation, and playtesting.

The exact-cover objective is lexicographic:

1. zero supply mismatch;
2. zero invalid dish structures;
3. zero unassigned queue units;
4. zero missing queue units;
5. minimum peak early inventory;
6. minimum pickup-to-consuming-customer distance;
7. closest customer-count and complexity targets;
8. best dish and ingredient variety.

Soft preferences must never trade away exact supply.

### Manual customer allocation along the pickup path

Manual mode uses the complete pickup plan as a time axis rather than exposing an unconstrained
customer form. The user places customer waves and dishes against pickup steps while the tool keeps
an exact unit ledger.

1. The pickup cursor exposes units released at the selected step and all unallocated units released
   earlier.
2. The dish palette shows only graph-valid dishes. Dishes that cannot be completed from the remaining
   queue supply stay visible but disabled with the missing raw inputs explained.
3. Adding a dish reserves exact raw units and draws provenance links back to their pickup actions.
4. A customer can be positioned only where its dishes can be scheduled under the configured
   serveable-slot and production-capacity constraints.
5. Moving a customer or dish replays allocations from the earliest affected pickup step. Invalid
   downstream allocations are marked as conflicts; they are never silently reassigned.
6. The user may save a partial customer artifact, undo/redo allocations, or ask the solver to
   complete the unallocated suffix without changing locked manual customers.
7. Completion requires zero unallocated units, zero missing units, and no customer whose required
   supply arrives outside its permitted wave.

This makes "following the pickup path" concrete: customer design is synchronized to the chosen
route, and every dish visibly owns the queue units that make it possible.

### Output

```ts
interface CustomerOrderArtifact extends GeneratorArtifact<"customer-orders"> {
  queueHash: string;
  pickupPlanHash: string;
  vectorHash: string;
  customers: NodeCustomerConfig[];
  allocation: Array<{
    queueSlotId: string;
    pickupStep: number;
    customerIndex: number;
    dishIndex: number;
    orderedIngredient: string;
    rawIngredient: string;
  }>;
  diagnostics: {
    exactSupply: boolean;
    peakEarlyInventory: number;
    maximumPickupToDemandDistance: number;
    dishTypeCounts: Record<string, number>;
    searchExhausted: boolean;
  };
}
```

### Infeasibility result

Phase 3 must not mutate the queue when no exact solution exists:

```ts
interface CustomerGenerationFailure {
  kind: "no-exact-order-decomposition" | "search-budget-exhausted";
  queueHash: string;
  pickupPlanHash: string;
  unconsumedSupply: Record<string, number>;
  missingSupply: Record<string, number>;
  blockingRecipeRules: string[];
  nearestCandidate?: {
    supplyDistance: number;
    customerCount: number;
    dishes: NodeDish[];
  };
  suggestedQueueMutations: QueueMutationProposal[];
}
```

Repair proposals may add, remove, replace, split, merge, or move slots. Applying one creates a new
queue artifact and invalidates the old pickup and customer artifacts.

### Phase 3 validation gate

Customer generation is valid only when:

- queue and pickup-plan hashes match;
- the pickup plan is complete;
- every dish resolves without graph issues;
- raw pickup supply equals demand after process yields;
- every queue unit has customer/dish provenance;
- no generated customer requires absent supply;
- fundamental validation passes;
- full service is possible;
- no accepted evaluation contains a customer timeout.

The vector, queue, and pickup-plan hashes must exactly match the confirmed start inputs. A partial
manual allocation remains a draft and cannot cross the final validation boundary.

Difficulty targets remain a separate quality gate. An exact and solvable level may still be rejected
for excessive grid pressure, random picks, early inventory, or poor queue texture.

## Independent execution behavior

### Running Phase 1 alone

Requires a confirmed queue vector artifact and current authoring-context artifact. It produces a
queue artifact and queue diagnostics, but does not create placeholder pickup or customer artifacts.
Slots may remain provisional until Phase 3 succeeds.

### Running Phase 2 alone

Requires a confirmed pickup vector artifact and accepts any compatible valid queue artifact,
including one imported from a manually authored queue. It never requires the queue to have been
generated by Phase 1, but it never accepts an unversioned in-memory queue.

### Running Phase 3 alone

Requires a confirmed customer vector artifact, a valid queue artifact, and a complete compatible
pickup-plan artifact. It never requires either upstream artifact to have been generated
automatically.

### Editing between phases

- Changing ingredient, amount, lane position, effect, or group membership changes the queue hash.
- A queue hash change marks the pickup and customer artifacts stale.
- Editing only the pickup sequence changes the pickup-plan hash and marks only the customer artifact
  stale.
- Editing generated customers does not modify either upstream artifact; validation simply reports the
  resulting supply mismatch.
- Editing a confirmed phase vector creates a new draft vector revision. Run remains disabled until
  the revision is explicitly confirmed.
- A context or graph change marks all three vector artifacts and all generated artifacts stale.

## Integration with the current generator and Google Sheets

### Existing flow to preserve

The current customer-first generator already stores its inputs on `LevelData` and maps them to the
`MapLevelProgress` Google Sheet row:

| Current column | Current field | Treatment in the integrated format |
| --- | --- | --- |
| D | `ingredientWeights` | Keep as a legacy/runtime mirror of the shared profile. |
| E | `customerDishesSequence` | Store the compressed unified workspace envelope. |
| F | `complexityCurve` | Move into compressed customer-generator data. |
| G | `shuffleCurve` | Move into compressed customer-generator data. |
| H | `randomSeed` | Keep unchanged as a numeric, inspectable cell. |
| I | `obstacleData` | Move into compressed customer-generator data. |
| P/Q/R and S/T/U | canonical customers/grid/queue and compressed exports | Keep unchanged as the playable level source of truth. |

`ingredientWeights`, `randomSeed`, and materialized `obstacleData` remain populated for runtime and
Level Path compatibility. The authored source of truth is the shared profile in `gw2_`, including
stable-name dish-type weights. A zero-weight dish disables ingredient controls that no remaining
enabled dish can consume; positive dish weights guide queue-first exact-cover search without making
lower-weight dishes illegal. Queue vector
artifacts snapshot the resolved shared values and `sharedProfileHash`, so replay is deterministic
and shared-profile edits make older phase artifacts visibly stale.

### Proposed on-sheet column reuse

The first implementation should reuse the now-free generator columns rather than require a sheet
schema expansion:

| Column | New remote field | Stored content |
| --- | --- | --- |
| D | `ingredientWeights` | Existing customer-first ingredient/composite/amount weight grammar. |
| E | `customerGeneratorData` | One compressed unified generator workspace envelope (`gw2_`). |
| F | `queuePhaseData` | Authoring context, confirmed queue vector, and optional queue artifact. |
| G | `pickupPhaseData` | Confirmed pickup vector and optional partial/complete pickup-plan artifact. |
| H | `randomSeed` | Existing customer-first seed. |
| I | `customerPhaseData` | Confirmed customer vector and optional partial/complete customer-order artifact. |

The remote column JSON remains configurable, so deployments that cannot reuse E/F/G/I may map these
logical fields elsewhere without code changes.

### Unified generator workspace envelope

```ts
interface GeneratorWorkspaceEnvelopeV2 {
  schemaVersion: 2;
  kind: "generator-workspace";
  activeStrategy: "customer-first" | "queue-first";
  shared: SharedGenerationProfileV2;
  customerFirst: CustomerFirstWorkspaceDraftV2;
  queueFirstRefs: {
    queueArtifactHash?: string;
    pickupArtifactHash?: string;
    customerArtifactHash?: string;
  };
  migrationWarnings: string[];
  contentHash: string;
}
```

Specialized customer-first values retain their established mini-grammars. Shared ingredients are
keyed by stable graph names rather than dense/data IDs. Generated customers, grid, and queue remain
in canonical level columns and are never silently applied during recovery.

### Queue-first phase envelopes

Each phase owns one compressed cell so a designer can save or recover that phase without rewriting
unrelated work:

```ts
interface QueuePhaseSheetData {
  schemaVersion: 1;
  kind: "queue-first/queue-phase";
  context: AuthoringContextArtifact;
  vector: QueueGenerationVectorArtifact;
  artifact?: QueueArtifact;
  levelProjectionHashes: LevelProjectionHashes;
  contentHash: string;
}

interface PickupPhaseSheetData {
  schemaVersion: 1;
  kind: "queue-first/pickup-phase";
  vector: PickupPlanningVectorArtifact;
  artifact?: PickupPlanArtifact;
  queueHash: string;
  levelProjectionHashes: LevelProjectionHashes;
  contentHash: string;
}

interface CustomerPhaseSheetData {
  schemaVersion: 1;
  kind: "queue-first/customer-phase";
  vector: CustomerGenerationVectorArtifact;
  artifact?: CustomerOrderArtifact;
  queueHash: string;
  pickupPlanHash: string;
  levelProjectionHashes: LevelProjectionHashes;
  contentHash: string;
}

interface LevelProjectionHashes {
  customerString: string;
  gridString: string;
  queueString: string;
}
```

`levelProjectionHashes` records which live level strings were present when the phase was saved. It
does not make those strings part of the artifact. On recovery the UI can distinguish:

- **matches level** — the recovered workspace still describes the open level;
- **workspace newer** — the saved artifact was never applied to the canonical level; and
- **level changed** — the canonical level was edited after the workspace was saved.

A mismatch keeps the recovered data inspectable and marks it stale. It never applies the artifact to
the level automatically.

### Encoding and cell safety

All four payload cells use canonical sorted-key JSON, raw DEFLATE, and unpadded Base64url. Distinct
prefixes make the format self-identifying and make legacy rows unambiguous:

```text
gw2_<payload>   unified generator workspace
cg1_<payload>   legacy customer-first generator configuration
qfq1_<payload>  queue phase
qfp1_<payload>  pickup phase
qfc1_<payload>  customer phase
```

Every decoded envelope must pass these gates before it enters local state:

1. supported prefix and schema version;
2. valid DEFLATE, UTF-8, and JSON;
3. a matching `kind`;
4. matching canonical `contentHash`;
5. valid vector/artifact contracts; and
6. compatible graph, context, and upstream hashes.

Google Sheets limits one cell to 50,000 characters. Writes should fail preflight at 45,000 encoded
characters with a visible size report rather than risk truncation. Tests must cover a realistic large
queue and pickup plan. If a real artifact exceeds the safety limit, it remains saved locally and the
UI reports that the phase needs a future chunked/external storage path; it must not silently drop
steps, allocations, diagnostics, or provenance.

### Legacy migration

Old and new rows can coexist during rollout:

1. If E starts with `gw2_`, decode the unified workspace envelope.
2. If E starts with `cg1_`, migrate the customer-first envelope in memory.
3. Otherwise treat E/F/G/I as the legacy dish-sequence, complexity-curve, shuffle-curve, and obstacle
   cells and construct an in-memory v1 envelope.
4. D and H are read exactly as today in all cases and become shared-profile compatibility inputs.
5. Do not rewrite the row merely because it was read. Migration occurs only when the designer clicks
   **Save Generator Data to Sheet**.
6. The migration write places the workspace envelope in E and phase envelopes, when present, in F/G/I.
   Missing phases write empty cells rather than placeholder artifacts.
7. Keep legacy `LevelData` accessors during one compatibility period. Generator code reads through a
   shared accessor that prefers `customerGeneratorData` and falls back to the legacy properties.
8. CSV import/export appends the four new encoded fields so local backups retain the same recovery
   information. Existing CSV columns remain readable.

### Integration service boundary

Design mode should not call Google APIs directly or duplicate Remote Data's account and permission
logic. Extract a shared `LevelSheetGateway` from the current Remote Data path:

```ts
interface LevelSheetGateway {
  loadGeneratorData(mapId: string, levelId: number, fresh?: boolean): Promise<GeneratorSheetSnapshot>;
  saveGeneratorData(
    mapId: string,
    levelId: number,
    expected: GeneratorSheetSnapshot,
    update: GeneratorSheetUpdate,
  ): Promise<GeneratorSheetSnapshot>;
}
```

The gateway reuses `fetchLevelProgressRows`, author/account permission checks, configured tab/column
overrides, and `batchUpdateCells`. A save performs these steps:

1. save every open section draft into the local `LevelData`/queue-first workspace snapshot;
2. encode and size-check the requested payloads;
3. refetch the target row instead of trusting a stale Remote Data cache;
4. compare the refetched cells with the snapshot the designer loaded;
5. stop on a conflict and show the sheet/local values; and
6. write D/E/F/G/H/I plus `author` in one `values:batchUpdate` request after explicit confirmation.

Google Sheets does not provide a transactional compare-and-swap for these cells, so the refetch is a
best-effort conflict guard. No row is created implicitly: if Map/Level has no destination row, Design
mode shows **No sheet row** and links to Remote Data.

Recovery performs the inverse operation. It decodes into a temporary snapshot, validates every
envelope, shows a summary of what will change, and only then replaces local generator metadata. It
does not modify `customerString`, `gridString`, or `queueString`; applying a recovered artifact to the
level is a separate explicit action inside the relevant generator workspace.

### Current Design-mode button layout

Keep the existing level bar but group its actions by purpose:

```text
[✨ Level Generator]
[📊 Estimate Difficulty] [✓ Check Solvable] [Statistic]
[☁ Generator Data: Local ▾]
[+ Level] [🗑 Level]
```

`✨ Level Generator` opens the unified workspace and restores its last active strategy.
`☁ Generator Data` is a compact status/menu button with these states:

- **Local** — sheet data has not been loaded;
- **Synced** — all four encoded fields plus D/H match the last fresh sheet snapshot;
- **Changed** — local generator data differs from the loaded sheet snapshot;
- **Conflict** — the sheet changed since it was loaded;
- **Stale** — recovered queue-first hashes do not match current prerequisites or level strings;
- **No row** — the selected Map/Level has no writable destination row.

Its menu contains:

1. **Recover Generator Data from Sheet…** — fresh load, validation, preview, then explicit apply;
2. **Save Generator Data to Sheet…** — fresh conflict check, preview of D/E/F/G/H/I, then one batch;
3. **Save Current Queue-First Phase…** — write only the active phase cell plus author;
4. **Compare with Sheet** — read-only field/hash/size comparison; and
5. **Open Remote Data** — navigate to the full row-level diff tool.

The customer-first track uses one contextual primary action:

```text
[Undo] [Redo] [More ▾]                                      [Generate Preview]
[Undo] [Redo] [More ▾]                                       [Commit to Level]
```

Edits are debounced into the local draft. Remote persistence still requires the explicit
`☁ Generator Data` action.

The Queue-First workspace uses the existing phase-specific action row and adds sync through the same
gateway:

```text
[Undo] [Redo] [More ▾]                           [Confirm Settings / Run / Continue]
[Undo] [Redo] [More ▾]                                       [Commit to Level]
```

Recovering one phase never fabricates its missing prerequisites. For example, recovering Pickup data
without the referenced Queue artifact leaves Pickup visible but blocked and offers **Recover Queue
Phase** as the repair action.

### Persistence test plan

- unified shared/customer-first fields round-trip through `gw2_` without changing canonical values;
- legacy customer-first fields round-trip through `cg1_` migration without loss;
- D ingredient weights and H random seed remain independent and retain seed `0` correctly;
- legacy E/F/G/I rows import into the same in-memory configuration as before;
- migration writes only after an explicit action and produces the new prefixes;
- each phase cell round-trips partial and complete artifacts with identical content hashes;
- a graph/context/upstream mismatch restores as stale rather than being discarded or applied;
- corrupted, wrong-kind, unknown-version, and oversized cells fail without mutating local state;
- one save emits one batch request containing the intended cells and author;
- a fresh-sheet conflict blocks the write and preserves both sides for comparison;
- recovery never changes canonical customer/grid/queue strings;
- Remote Data per-field, per-level, and Apply All flows include the new logical fields;
- CSV export/import retains all four encoded strings; and
- current rows with no queue-first data continue to generate exactly as before.

## Proposed repository structure

```text
src/generation/queue-first/
  contracts.ts
  artifactHash.ts
  phaseReadiness.ts
  vectorArtifacts.ts
  phase1Queue.ts
  quotaAllocator.ts
  amountPartitioner.ts
  queueLayout.ts
  groupPlacement.ts
  effectPlacement.ts
  orderabilityProjection.ts
  phase2PickupPlan.ts
  pickupState.ts
  pickupSearch.ts
  phase3CustomerOrders.ts
  dishTemplateCatalog.ts
  exactCover.ts
  customerScheduler.ts
  validation.ts

src/data/generatorPersistence/
  contracts.ts
  codec.ts
  customerGeneratorData.ts
  queueFirstPhaseData.ts
  levelSheetGateway.ts
  migration.ts

src/ui/queue-first/
  authoringContextPanel.ts
  phaseReadinessPanel.ts
  vectorArtifactEditor.ts
  queueVectorEditor.ts
  pickupPlanEditor.ts
  pickupTimeline.ts
  customerVectorEditor.ts
  customerPathEditor.ts
  provenanceOverlay.ts
  queueFirstWorkspace.ts

src/ui/design/
  generatorDataMenu.ts
  generatorDataCompareDialog.ts
```

The core modules must remain DOM-free so they can be used by Design mode, Level Path, tests, and the
MCP service.

## Reuse and extraction plan

The implementation should reuse existing contracts and behavior rather than introduce a second level
format:

- `src/core/types.ts`: `QueueItem`, `QueueGroup`, effects, and level contracts.
- `src/core/nodeParser.ts`: node-native customer and dish structures.
- `src/core/nodeOrder.ts`: authoritative dish resolution and graph validation.
- `src/ui/nodedesign/nodeQueueGenerate.ts`: recipe-leaf expansion, demand accounting, stack-aware
  amount logic, and round-trip validation concepts.
- `src/ui/design/queueThawCheck.ts`: queue-only Freeze and linked structural auditing.
- `src/ui/design/nodeEstimateDifficulty.ts`: gameplay validation after customer generation.
- `src/core/parser.ts`: canonical serialization only at the final commit boundary.

The current random dish builder is demand-first and should not be called as Phase 3's solver. Shared
graph-valid dish-construction helpers that are currently private may be extracted into a pure module,
then used by both generators.

## Suggested service API

```text
create_phase_vector_draft
update_phase_vector_draft
confirm_phase_vector
get_phase_readiness

generate_queue_from_vector
validate_queue_artifact

create_pickup_plan
append_manual_pickup_step
auto_complete_pickup_plan
validate_pickup_plan

generate_customers_from_queue
append_manual_customer
append_manual_dish
move_customer_on_pickup_path
remove_manual_allocation
auto_complete_customer_suffix
explain_customer_generation_failure
propose_queue_repairs_for_orders
validate_queue_first_level
```

Every phase-start call requires the confirmed vector artifact hash plus every prerequisite artifact
hash. Every mutating call should require the expected artifact hash or revision. Proposal and
explanation calls remain read-only.

## UI proposal

Add a separate **Queue-First Generator** workspace rather than overloading the current Auto Generate
dialog. The workspace is a visual phase tool, not three independent forms.

### Workspace shell and phase navigation

```text
+--------------------------------------------------------------------------------+
| Map / graph context | reference profile | graph hash | Save workspace          |
+--------------------------------------------------------------------------------+
| 1 Queue [ready]  ->  2 Pickup [blocked]  ->  3 Customers [blocked]             |
+----------------------+--------------------------------------+------------------+
| Vector inspector     | Visual canvas                        | Artifact / issues|
| draft vs confirmed   | phase-specific editor                | hashes, status   |
| fields + validation  |                                      | diagnostics      |
+----------------------+--------------------------------------+------------------+
| Undo | Redo | Save Draft | Confirm Vector | Run / Continue | Validate          |
+--------------------------------------------------------------------------------+
```

The phase rail uses four states: `needs vector`, `blocked`, `ready`, and `complete/stale`. Hovering or
opening a blocked phase shows all missing prerequisites and a direct action such as **Create pickup
vector**, **Finish pickup path**, or **Regenerate from changed queue**. Tabs may be inspected while
blocked, but their canvas is read-only and Run is disabled.

The left inspector always separates three value states:

- **Suggested**: reference-derived values, not yet accepted;
- **Draft**: user edits that can still change;
- **Confirmed**: immutable values identified by the vector artifact hash.

Editing a confirmed value creates a new draft and visibly marks the current output artifact as based
on the previous vector. The user must choose **Confirm Vector** before **Run** becomes available.

Every phase vector inspector provides adjacent **Visual** and **JSON** modes backed by the same draft.
Visual changes immediately update the JSON representation; valid JSON changes are recovered into the
visual controls when switching back. Queue ingredient weights use the legacy draggable vertical bars,
with an opt-in dual vertical min/max amount range beside each ingredient. Obstacle coverage and
combined/linked special-slot coverage use percentage vertical sliders. Remaining integer fields use
the shared drag-to-adjust number behavior (horizontal drag, Shift for coarse adjustment, Alt for fine
adjustment) while remaining directly typeable. Open-ended structures such as complexity curves remain
available in JSON even when no purpose-built visual control exists yet.

### Phase 1 visual tool: queue vector and queue canvas

The vector inspector groups fields instead of presenting one long form:

- **Shape**: lane count, pickup units, queue slots/depth, seed;
- **Ingredients**: searchable ingredient table with weight, projected units, lock, and normalize;
- **Amounts**: policy, per-ingredient range, expected authored slots, atomic-burst warning;
- **Texture**: identical run, mirroring, entropy, lane imbalance, with reference-range markers;
- **Groups**: combined and linked 2-by-5 matrices showing target coverage, estimated group count, and
  actual coverage;
- **Effects**: Freeze, Hidden, HoldingKey coverage plus authorization and feasibility warnings;
- **Feasibility**: free, project-to-orderable, strict-orderable, or runtime-feasible, plus the
  bounded `forceMove` control.

The canvas renders lanes front-to-back with ingredient color/icon, amount badges, effect badges, and
group outlines. Selecting a vector row highlights affected cells. Selecting a cell reveals its
stable ID and provenance. A target-versus-actual strip updates only as a preview while editing; it
must be labeled **preview** until the vector is confirmed and a new artifact is generated.

Primary actions are **Confirm Vector**, **Generate**, **Regenerate Same Seed**, **New Seed**, and
**Validate**. Generate is unavailable without a current authoring-context artifact and confirmed
queue vector.

### Phase 2 visual tool: pickup-path editor

The center canvas reuses the queue lanes and applies action-level states:

- green outline: legal next action;
- amber outline: legal but high-risk amount burst or low-future-branching choice;
- gray: not currently at the front;
- red lock: blocked, with Freeze/group reason on selection;
- shared outline and action ID: cells picked atomically as one combined or linked action.

A horizontal timeline below the queue contains one card per pickup action. Clicking a legal queue
action appends its whole atomic action to the timeline, animates the resulting front positions, and
updates released-unit chips. Scrubbing the timeline reconstructs the queue at that step without
editing it. Dragging timeline cards is allowed only when replay proves the reordered path legal;
otherwise the card snaps back and the first invalid step is explained.

The left vector inspector contains mode, completion policy, seed, wave-size hint, scoring weights,
and bounded-search limits. The right panel shows legal alternatives, blocked reasons, released units,
branching factor, amount-burst histogram, and structural-check status. Manual actions are Undo, Redo,
Clear Remaining, and Auto-complete Remaining. **Complete Phase** is enabled only when the queue is
empty and replay validation passes.

### Phase 3 visual tool: customers following the pickup path

The customer editor keeps the Phase 2 pickup timeline as the primary horizontal axis:

```text
Pickup steps:   01 tomato | 02 cheese x2 | 03 dough | 04 linked basil...
Available units: tomato 1 | cheese 2 | dough 1 | basil 0
                 |---------- Customer 1 ----------|
Customer waves: [ pizza: dough + tomato + cheese ] [ salad: ... ]
Provenance:       step 03 -----^   step 01 ---^   step 02 -------^
Unallocated:    basil 2 | onion 1                         Missing: none
```

The left vector inspector contains manual/auto mode, customer and dish bounds, serveable slots,
complexity curve, variety/repetition targets, scheduling weights, seed, and search budget. Dish-type
weights live only in the shared profile and are snapshotted into the customer vector for deterministic
replay. The visual canvas provides:

- a synchronized pickup-step ruler with released and still-unallocated unit chips;
- draggable customer wave cards anchored to a pickup-step interval;
- dish slots inside each customer, with a graph-valid dish palette;
- provenance lines from every dish raw input to its supplying pickup action;
- live ledgers for unallocated supply, missing supply, early inventory, and active production paths;
- a conflict lane for allocations invalidated by a manual move.

Selecting a pickup step filters the dish palette to recipes compatible with remaining total supply
and highlights dishes whose inputs are now available. Selecting a dish highlights its source queue
slots and process path. Dragging a dish to a customer reserves exact units; removing it releases the
same unit identities. Dragging a customer earlier or later performs a deterministic replay and
either commits the move or reports the first violated constraint.

Manual mode supports **Add Customer**, **Add Dish**, **Lock Allocation**, **Undo**, **Redo**, and
**Auto-complete Remaining**. Auto-completion may only fill unallocated supply and unlocked customer
slots. It cannot rewrite locked manual work. The artifact may be saved while partial, but **Validate
Phase** and downstream Estimate/Playtest remain disabled until exact supply is green and all customer
constraints pass.

### Cross-phase UX behavior

- A persistent artifact panel shows vector hash, prerequisite hashes, artifact status, warnings, and
  the exact reason a phase is blocked.
- Changing an upstream artifact never navigates away or discards work. Downstream canvases remain
  viewable with a stale watermark and offer **Branch from new input** or **Keep stale snapshot**.
- Missing inputs are never synthesized by clicking Run. The button focuses the missing prerequisite
  and explains the required user action.
- Every manual operation is undoable within its artifact revision. Confirming a new vector or
  applying an upstream repair creates a revision boundary rather than merging histories.
- Keyboard navigation mirrors pointer actions: arrow keys move among lanes or timeline steps, Enter
  chooses a legal action, and blocked actions expose the same reason text for accessibility.
- Ingredient identity never relies on color alone; icon, name, and stable short ID are available in
  cells, chips, provenance links, and screen-reader labels.

## Determinism

- Every stochastic phase receives its own derived seed.
- Derived streams should be named rather than consumed from one shared stream, for example:

```text
queue.quota
queue.amounts
queue.layout
queue.combined-groups
queue.linked-groups
queue.effects
pickup.tie-break
orders.template-order
orders.customer-packing
```

- Adding a customer avatar or changing one placement stage must not perturb unrelated stages.
- Same graph hash, inputs, and seed must produce byte-equivalent artifacts.

## Testing strategy

### Shared readiness and vector behavior

- each phase is blocked when its vector artifact is missing, draft, stale, or context-incompatible;
- each phase is blocked when any required artifact input is missing, invalid, stale, or hash-mismatched;
- suggested values never satisfy the confirmed-vector gate;
- editing a confirmed vector creates a draft revision and does not mutate the previous output;
- start requests record the exact vector and prerequisite artifact hashes;
- readiness errors identify every missing prerequisite and the appropriate user action.

### Phase 1

- deterministic output for the same seed and vector;
- missing or stale authoring-context artifacts block generation;
- exact physical-unit total;
- ingredient ratios within documented integer tolerance;
- amount partitions preserve supply;
- lane and depth targets respected;
- no overlapping groups;
- combined groups are four-connected;
- linked and combined size-specific coverage is measured correctly;
- Freeze placements retain a structurally valid thaw route;
- projection mode produces an orderability certificate;
- strict mode rejects an infeasible vector.

### Phase 2

- a confirmed pickup-planning vector and valid queue artifact are required before a draft opens;
- manual illegal steps are rejected;
- normal, amount, combined, and linked actions are represented atomically;
- automatic plans consume every slot exactly once;
- Freeze progress matches runtime adjacency rules;
- complete plans replay deterministically;
- bounded-search exhaustion is distinguished from a proven deadlock;
- upstream queue edits mark plans stale.

### Phase 3

- a confirmed customer vector, valid queue, and complete compatible pickup plan are required;
- generated dishes resolve without issues;
- multi-input recipes include every required raw input;
- process yields are accounted for exactly;
- total generated demand round-trips to queue supply;
- no queue unit is assigned twice;
- manual dishes reserve stable unit identities from visible pickup steps;
- moving a manual customer replays from the earliest affected step and exposes conflicts;
- manual-with-auto-suffix preserves locked customer and dish allocations;
- partial manual artifacts save as drafts but cannot validate or enter playtest;
- customer packing respects min/max constraints;
- an infeasible queue returns a diagnostic without mutation;
- search-budget exhaustion returns the closest measured candidate but not a valid artifact;
- upstream plan edits mark customer artifacts stale.

### Integration

- workspace Run buttons follow the service readiness result and never synthesize missing inputs;
- stale downstream canvases remain inspectable but cannot be mutated as current artifacts;
- queue cells, pickup actions, dishes, and customers retain inspectable provenance across all views;
- final artifacts serialize through the existing canonical serializers;
- current demand-first generation remains byte-for-byte unchanged;
- existing validation, estimator, replay, and play mode accept the generated level;
- representative combined, linked, Freeze, Hidden, and amount cases play to completion;
- accepted evaluation runs have exact supply, full service, and zero timeouts.

## Acceptance criteria for the first implementation

1. All three phases are callable independently through pure TypeScript APIs.
2. Every phase requires its own user-confirmed vector artifact and all phase-specific prerequisite
   artifacts; missing, invalid, stale, or hash-mismatched inputs block phase start.
3. Phase 1 supports ingredient weights, lane count, unit count, amount policy, queue effects, and
   separate size-two-through-five coverage for combined and linked groups.
4. Phase 2 supports both manual planning and bounded automatic planning through the visual pickup
   path editor.
5. Phase 3 supports automatic generation and manual customer/dish allocation synchronized to the
   pickup path, including locked manual work plus automatic suffix completion.
6. The workspace exposes vector state, readiness, hashes, provenance, blocked reasons, and stale
   state without hiding or auto-creating prerequisites.
7. No phase silently changes an upstream artifact.
8. Artifact hashes reliably detect stale downstream work.
9. Exact supply/demand and structural queue validation are hard gates.
10. The current generator and canonical level format remain compatible.
11. Tests cover readiness gates, deterministic generation, group geometry, Freeze behavior, manual
    path/customer editing, process yields, exact cover, provenance, and stale artifact handling.
12. Customer-first generator settings round-trip through one versioned compressed cell while
    ingredient weights and random seed remain independently readable and writable.
13. Every queue-first phase vector and optional artifact round-trips through its own versioned cell;
    recovery preserves blocked, partial, complete, and stale states.
14. Design mode saves through the shared sheet gateway with a fresh-row conflict check and one batch
    write, and can preview and recover data without changing canonical level strings.
15. Legacy E/F/G/I rows remain readable and migrate only after an explicit save.

## Delivery sequence

### Milestone 1: contracts and replayable pickup state

Implement authoring-context and vector-artifact contracts, confirmation and readiness gates, stable
IDs, hashes, queue-to-action normalization, and the Phase 2 manual validator. This establishes the
semantics shared by every later solver.

### Milestone 2: queue vector generation

Implement quotas, amount partitioning, lane layout, group placement, effects, structural validation,
and Phase 1 diagnostics.

### Integration gate: generator persistence and recovery

Before Milestone 3, implement the versioned `cg1_`, `qfq1_`, `qfp1_`, and `qfc1_` codecs; legacy-row
migration; the shared `LevelSheetGateway`; remote column mappings; and the Design-mode Generator Data
menu. Add **Save Setup** to the customer-first dialog and phase-specific save/recover actions to the
Queue-First workspace. This gate is complete when customer-first setup and each available phase
vector/artifact can be saved, compared, and recovered with size, permission, hash, and conflict
checks, without mutating the canonical customer/grid/queue strings.

### Milestone 3: automatic pickup planning

Add bounded beam search, route diagnostics, manual-with-auto-suffix, and deterministic replay.

### Milestone 4: inverse customer generation

Implement the bounded dish-template catalog, exact-cover solver, customer scheduler, provenance, and
infeasibility explanations. Add manual customer/dish allocation and locked-manual auto-completion.

### Milestone 5: UI and full evaluation

Add the phase-rail workspace, vector inspectors, queue canvas, pickup timeline, customer path editor,
provenance overlay, final commit boundary, estimator integration, playtesting, and comparison against
reference queue texture.

## Main risk and mitigation

The principal risk is Phase 3 infeasibility: an arbitrary raw ingredient vector may not correspond to
any legal set of dishes. The recommended mitigation is `project-to-orderable` Phase 1 generation plus
an explicit feasibility certificate. Free generation remains available for designers who prefer
manual repair, while strict generation supports exact experiments.

The second risk is confusing a planned pickup route with runtime enforcement. The artifact therefore
stores a baseline route for order scheduling and analysis only. Final validation must still evaluate
alternative player choices, queue-only deadlocks, grid pressure, and actual gameplay outcomes.

## Decision summary

Add the queue-first generator alongside the existing demand-first generator. Keep three separately
executable phases connected by versioned immutable artifacts:

1. **Queue generation** consumes a confirmed queue vector plus authoring context and controls supply,
   amounts, texture, obstacles, and group geometry.
2. **Pickup planning** consumes a confirmed pickup vector plus queue artifact and records a legal
   baseline route through the authored queue.
3. **Customer generation** consumes a confirmed customer vector plus queue and complete pickup-plan
   artifacts, then automatically or manually builds customers that exactly consume that supply.

Use hard exactness and graph-validity gates, expose repair proposals instead of hidden mutations, and
defer canonical serialization until the complete level passes validation. Provide a visual workspace
that makes vector confirmation, missing prerequisites, pickup legality, customer timing, and unit
provenance directly inspectable.
