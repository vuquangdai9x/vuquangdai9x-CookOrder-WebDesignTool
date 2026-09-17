# Queue-First Level Generator Proposal

## Status

Proposed alternative to the existing demand-first level generator.

The current generator starts with customer orders, expands those orders into raw ingredient demand,
and then builds a queue that supplies the demand. This proposal introduces an independent,
queue-first workflow:

```text
Generation vector
    -> Phase 1: queue artifact
    -> Phase 2: baseline pickup plan
    -> Phase 3: customer-order artifact
    -> existing validation, estimation, and playtesting
```

Each phase can be run, saved, edited, validated, and rerun separately. A later phase never silently
changes an earlier artifact.

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

## Non-goals

- Replacing the current demand-first generator.
- Making the baseline pickup plan mandatory at runtime.
- Silently repairing the queue while generating customer orders.
- Inferring unauthorized grid obstacles, customer roles, timers, or dish effects.
- Writing canonical level strings during intermediate generation.
- Treating a valid supply/demand total as proof that a level is playable.

## Core design principles

### Immutable phase artifacts

Every phase returns a versioned artifact. Artifacts contain stable IDs, their generating inputs,
diagnostics, and a hash of the upstream artifact. Editing a queue invalidates its pickup plan and
customer plan, but does not automatically regenerate either one.

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
  upstreamHash?: string;
  contentHash: string;
  status: "draft" | "valid" | "invalid" | "stale";
  warnings: string[];
}
```

The content hash covers generation-relevant fields rather than timestamps or display-only labels.
This makes stale detection deterministic.

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

  feasibilityMode: "free" | "project-to-orderable" | "strict-orderable";
}

interface GroupSizeCoverage {
  2: number;
  3: number;
  4: number;
  5: number;
}
```

At least one queue-size target is required. `targetPickupUnits` is recommended because it remains
meaningful when amount compaction changes the number of authored slots. When both unit and slot
targets are present, unit count is hard and slot count is a bounded optimization target.

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

### Algorithm

1. Validate the graph, dimensions, rates, amount ranges, and authorized mechanic set.
2. Convert ingredient weights into exact physical-unit quotas with largest-remainder allocation.
3. Apply the selected recipe-feasibility policy.
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
  input: QueueGenerationVector;
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

## Phase 2: Assign the baseline pickup sequence

The baseline sequence is a design intent and analysis artifact. Runtime players remain free to make
any legal choice.

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

## Phase 3: Generate customer orders

Phase 3 is an inverse-recipe and scheduling problem. It must find legal dishes whose raw pickup
demand exactly equals the existing queue supply, then arrange those dishes into customer waves that
fit the baseline pickup plan.

### Input

```ts
interface CustomerGenerationOptions {
  seed: number;
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
```

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

### Output

```ts
interface CustomerOrderArtifact extends GeneratorArtifact<"customer-orders"> {
  queueHash: string;
  pickupPlanHash: string;
  options: CustomerGenerationOptions;
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

Difficulty targets remain a separate quality gate. An exact and solvable level may still be rejected
for excessive grid pressure, random picks, early inventory, or poor queue texture.

## Independent execution behavior

### Running Phase 1 alone

Produces a queue artifact and queue diagnostics. It does not create placeholder customers. Slots may
remain provisional until Phase 3 succeeds.

### Running Phase 2 alone

Accepts any compatible existing queue, including a manually authored one. It never requires the queue
to have been generated by Phase 1.

### Running Phase 3 alone

Accepts any queue plus a complete compatible pickup plan. It never requires either artifact to have
been generated automatically.

### Editing between phases

- Changing ingredient, amount, lane position, effect, or group membership changes the queue hash.
- A queue hash change marks the pickup and customer artifacts stale.
- Editing only the pickup sequence changes the pickup-plan hash and marks only the customer artifact
  stale.
- Editing generated customers does not modify either upstream artifact; validation simply reports the
  resulting supply mismatch.

## Proposed repository structure

```text
src/generation/queue-first/
  contracts.ts
  artifactHash.ts
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

src/ui/queue-first/
  queueVectorEditor.ts
  pickupPlanEditor.ts
  customerGenerationDialog.ts
  queueFirstWorkspace.ts
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
generate_queue_from_vector
validate_queue_artifact

create_pickup_plan
append_manual_pickup_step
auto_complete_pickup_plan
validate_pickup_plan

generate_customers_from_queue
explain_customer_generation_failure
propose_queue_repairs_for_orders
validate_queue_first_level
```

Every mutating call should require the expected artifact hash or revision. Proposal and explanation
calls remain read-only.

## UI proposal

Add a separate **Queue-First Generator** workspace rather than overloading the current Auto Generate
dialog.

### Queue tab

- vector editor;
- ingredient weights and unit targets;
- amount policy;
- obstacle coverage;
- combined coverage matrix for sizes two through five;
- linked coverage matrix for sizes two through five;
- generated-versus-target diagnostics;
- Generate, Regenerate Same Seed, New Seed, and Validate actions.

### Pickup Plan tab

- current queue state;
- legal next-action highlights;
- ordered action timeline;
- manual and automatic modes;
- blocked-reason inspector;
- structural deadlock result.

### Customers tab

- customer constraints;
- generated customer timeline;
- queue-slot-to-dish provenance inspector;
- exact-cover diagnostics;
- supply/demand result;
- Estimate and Playtest actions.

Each tab shows whether its upstream input is current or stale.

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

### Phase 1

- deterministic output for the same seed and vector;
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

- manual illegal steps are rejected;
- normal, amount, combined, and linked actions are represented atomically;
- automatic plans consume every slot exactly once;
- Freeze progress matches runtime adjacency rules;
- complete plans replay deterministically;
- bounded-search exhaustion is distinguished from a proven deadlock;
- upstream queue edits mark plans stale.

### Phase 3

- generated dishes resolve without issues;
- multi-input recipes include every required raw input;
- process yields are accounted for exactly;
- total generated demand round-trips to queue supply;
- no queue unit is assigned twice;
- customer packing respects min/max constraints;
- an infeasible queue returns a diagnostic without mutation;
- search-budget exhaustion returns the closest measured candidate but not a valid artifact;
- upstream plan edits mark customer artifacts stale.

### Integration

- final artifacts serialize through the existing canonical serializers;
- current demand-first generation remains byte-for-byte unchanged;
- existing validation, estimator, replay, and play mode accept the generated level;
- representative combined, linked, Freeze, Hidden, and amount cases play to completion;
- accepted evaluation runs have exact supply, full service, and zero timeouts.

## Acceptance criteria for the first implementation

1. All three phases are callable independently through pure TypeScript APIs.
2. Phase 1 supports ingredient weights, lane count, unit count, amount policy, queue effects, and
   separate size-two-through-five coverage for combined and linked groups.
3. Phase 2 supports both manual planning and bounded automatic planning.
4. Phase 3 generates ordinary customers and graph-valid dishes from the exact queue supply.
5. No phase silently changes an upstream artifact.
6. Artifact hashes reliably detect stale downstream work.
7. Exact supply/demand and structural queue validation are hard gates.
8. The current generator and canonical level format remain compatible.
9. Tests cover deterministic generation, group geometry, Freeze behavior, process yields, exact cover,
   and stale artifact handling.

## Delivery sequence

### Milestone 1: contracts and replayable pickup state

Implement artifact contracts, stable IDs, hashes, queue-to-action normalization, and the Phase 2
manual validator. This establishes the semantics shared by every later solver.

### Milestone 2: queue vector generation

Implement quotas, amount partitioning, lane layout, group placement, effects, structural validation,
and Phase 1 diagnostics.

### Milestone 3: automatic pickup planning

Add bounded beam search, route diagnostics, manual-with-auto-suffix, and deterministic replay.

### Milestone 4: inverse customer generation

Implement the bounded dish-template catalog, exact-cover solver, customer scheduler, provenance, and
infeasibility explanations.

### Milestone 5: UI and full evaluation

Add the three-tab workspace, final commit boundary, estimator integration, playtesting, and comparison
against reference queue texture.

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

1. **Queue generation** controls supply, amounts, texture, obstacles, and group geometry.
2. **Pickup planning** records a legal baseline route through the authored queue.
3. **Customer generation** solves the inverse recipe problem and exactly consumes that supply.

Use hard exactness and graph-validity gates, expose repair proposals instead of hidden mutations, and
defer canonical serialization until the complete level passes validation.
