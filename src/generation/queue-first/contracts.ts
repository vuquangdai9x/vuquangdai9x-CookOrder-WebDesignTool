import type { EffectInstance, QueueCellRef } from "../../core/types.ts";
import type { NodeCustomerConfig, NodeDish } from "../../core/nodeParser.ts";

export type ArtifactStatus = "draft" | "valid" | "invalid" | "stale";

export interface GeneratorArtifact<TKind extends string> {
  schemaVersion: 1;
  kind: TKind;
  id: string;
  createdAt: string;
  seed: number;
  graphHash: string;
  upstreamHashes: string[];
  contentHash: string;
  status: ArtifactStatus;
  warnings: string[];
}

export interface PhaseVectorArtifact<TKind extends string, TVector>
  extends GeneratorArtifact<TKind> {
  values: TVector;
  contextHash: string;
  confirmedAt?: string;
  confirmedBy?: string;
}

export type QueueMechanic = "freeze" | "hidden" | "holdingKey";

export interface AuthoringContextArtifact extends GeneratorArtifact<"authoring-context"> {
  mapId: string;
  referenceProfileId: string;
  authorizedMechanics: QueueMechanic[];
  constraints: Record<string, unknown>;
}

export interface GroupSizeCoverage {
  2: number;
  3: number;
  4: number;
  5: number;
}

export interface QueueGenerationVector {
  seed: number;
  /** Hash of the stable-name shared profile resolved into this phase input. */
  sharedProfileHash?: string;
  laneCount: number;
  targetPickupUnits: number;
  targetQueueSlots?: number;
  targetLaneDepth?: number;
  /** Dense graph ingredient id -> relative weight. */
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
  /** Required when holdingKey coverage is non-zero. Values are grid lock colour ids. */
  holdingKeyColors?: number[];
  combinedCoverageBySize: GroupSizeCoverage;
  linkedCoverageBySize: GroupSizeCoverage;
  feasibilityMode: "free" | "project-to-orderable" | "strict-orderable" | "runtime-feasible";
  /** 0 requires every available choice to remain winnable; 1 requires one verified route. */
  forceMove?: number;
}

export type QueueGenerationVectorArtifact = PhaseVectorArtifact<
  "queue-vector",
  QueueGenerationVector
>;

export interface QueueArtifactSlot {
  id: string;
  ingredient: number;
  amount: number;
  effects: EffectInstance[];
  provenance: "generated" | "manual" | "repair";
}

export interface QueueArtifactGroup {
  id: string;
  kind: "combined" | "linked";
  slotIds: string[];
}

export interface QueueTextureMetrics {
  maximumIdenticalRun: number;
  crossLaneMirroring: number;
  transitionEntropy: number;
  laneImbalance: number;
}

export interface GroupCoverageDiagnostic {
  size: 2 | 3 | 4 | 5;
  targetCoverage: number;
  targetGroups: number;
  placedGroups: number;
  actualCoverage: number;
}

export interface QueueGenerationDiagnostics {
  pickupUnits: number;
  queueSlots: number;
  laneDepths: number[];
  ingredientUnits: Record<string, number>;
  amountHistogram: Record<string, number>;
  texture: QueueTextureMetrics;
  textureMisses: string[];
  combinedCoverage: GroupCoverageDiagnostic[];
  linkedCoverage: GroupCoverageDiagnostic[];
  effectTargets: Record<QueueMechanic, number>;
  effectPlacements: Record<QueueMechanic, number>;
  structuralVerdict: "safe" | "risky" | "deadlock" | "unknown";
  structuralMessage: string;
  orderability?: {
    mode: "project-to-orderable" | "strict-orderable";
    exactDecompositionExists: boolean;
    projectedUnitDelta: Record<string, number>;
  };
  feasibility?: QueueFeasibilityWitness;
}

export interface QueueFeasibilityWitness {
  gridCapacity: number;
  forceMove: number;
  requiredWinningChoiceRatio: number;
  exploredStates: number;
  minimumBranching: number;
  maximumBranching: number;
  averageBranching: number;
  capacitySafe: boolean;
  witnessSteps: PickupPlanStep[];
}

export interface QueueArtifact extends GeneratorArtifact<"queue"> {
  contextHash: string;
  vectorHash: string;
  lanes: Array<{ id: string; slots: QueueArtifactSlot[] }>;
  groups: QueueArtifactGroup[];
  diagnostics: QueueGenerationDiagnostics;
}

export interface PickupPlanningVector {
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
}

export type PickupPlanningVectorArtifact = PhaseVectorArtifact<
  "pickup-vector",
  PickupPlanningVector
>;

export interface PickupPlanStep {
  index: number;
  actionId: string;
  slotIds: string[];
  releasedUnits: Record<string, number>;
  legalAlternatives: string[];
  reason?: string;
  stateHashAfter: string;
}

export interface PickupPlanArtifact extends GeneratorArtifact<"pickup-plan"> {
  queueHash: string;
  vectorHash: string;
  mode: PickupPlanningVector["mode"];
  completion: "partial" | "complete";
  steps: PickupPlanStep[];
  diagnostics: {
    actionCount: number;
    groupedActionCount: number;
    amountBurstHistogram: Record<string, number>;
    maximumLegalBranching: number;
    expandedStates: number;
    deadlockFree: boolean | "inconclusive";
  };
}

export type CustomerGenerationVectorArtifact = PhaseVectorArtifact<
  "customer-vector",
  CustomerGenerationVector
>;

export interface CustomerGenerationVector {
  seed: number;
  /** Hash of the shared dish/ingredient profile resolved into this phase input. */
  sharedProfileHash?: string;
  mode: "manual" | "auto" | "manual-with-auto-suffix";
  minCustomers: number;
  maxCustomers: number;
  minDishesPerCustomer: number;
  maxDishesPerCustomer: number;
  maxDishSlots: number;
  serveableSlots: number;
  complexityCurve?: unknown;
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

export interface CustomerAllocation {
  queueSlotId: string;
  pickupStep: number;
  customerIndex: number;
  dishIndex: number;
  orderedIngredient: string;
  rawIngredient: string;
}

export interface CustomerOrderArtifact extends GeneratorArtifact<"customer-orders"> {
  queueHash: string;
  pickupPlanHash: string;
  vectorHash: string;
  mode: CustomerGenerationVector["mode"];
  completion: "partial" | "complete";
  customers: NodeCustomerConfig[];
  allocation: CustomerAllocation[];
  /** Customer indexes that automatic suffix completion may not rewrite. */
  lockedCustomerIndexes: number[];
  diagnostics: {
    exactSupply: boolean;
    peakEarlyInventory: number;
    maximumPickupToDemandDistance: number;
    dishTypeCounts: Record<string, number>;
    searchExhausted: boolean;
    expandedStates: number;
    unconsumedSupply: Record<string, number>;
    missingSupply: Record<string, number>;
  };
}

export interface CustomerGenerationFailure {
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

export interface QueueMutationProposal {
  kind: "add" | "remove" | "replace" | "split" | "merge" | "move";
  ingredient?: number;
  amount?: number;
  reason: string;
}

export type QueueFirstPhase = "queue" | "pickup" | "customers";

export interface PhaseReadinessIssue {
  code:
    | "missing-vector"
    | "unconfirmed-vector"
    | "stale-vector"
    | "context-mismatch"
    | "missing-artifact"
    | "invalid-artifact"
    | "stale-artifact"
    | "hash-mismatch"
    | "incomplete-artifact";
  input: "context" | "vector" | "queue" | "pickup-plan";
  message: string;
  action: string;
}

export interface PhaseReadiness {
  phase: QueueFirstPhase;
  ready: boolean;
  issues: PhaseReadinessIssue[];
}

export interface QueueRuntimeProjection {
  coordinatesBySlotId: Map<string, QueueCellRef>;
}

export interface OrderabilityResult {
  exactDecompositionExists: boolean;
  projectedQuotas?: Record<string, number>;
  reason?: string;
}

export interface OrderabilityAdapter {
  evaluate(
    quotas: Readonly<Record<string, number>>,
    mode: "project-to-orderable" | "strict-orderable",
  ): OrderabilityResult;
}
