import type { EffectInstance, GridCellConfig, QueueGroupKind } from "../core/types.ts";
import type { DishNode } from "../core/nodeParser.ts";

export type AuthoringStrategy =
  | "demand-first"
  | "queue-layout-first"
  | "board-mechanic-first"
  | "difficulty-first-hybrid";

export type MechanicAuthorization =
  | "queue:freeze"
  | "queue:hidden"
  | "queue:holding-key"
  | "grid:blocked"
  | "grid:order-lock"
  | "grid:ingredient-slot"
  | "grid:color-lock"
  | "group:combined"
  | "group:linked"
  | "customer:timer"
  | "customer:staff"
  | "customer:boss"
  | "customer:shipper"
  | "dish:effect";

export interface NormalizedConstraint {
  id: string;
  source: string;
  kind: "count" | "range" | "ratio" | "restriction" | "mechanic" | "difficulty" | "qualitative";
  target?: number;
  min?: number;
  max?: number;
  unit?: string;
  status: "pending" | "met" | "missed" | "unresolved";
  actual?: number | string;
}

export interface DifficultyProfile {
  id: string;
  label: string;
  thresholds: Record<string, { min?: number; max?: number }>;
}

export interface BriefInterpretation {
  brief: string;
  constraints: NormalizedConstraint[];
  authorizedMechanics: MechanicAuthorization[];
  difficultyProfile?: DifficultyProfile;
  needsProfileExtension?: {
    phrase: string;
    nearestProfiles: string[];
    proposedProfile: DifficultyProfile;
  };
  unresolvedQualitativeRequirements: string[];
}

export interface DraftDish {
  id: string;
  composite: string;
  root: DishNode;
  effects: EffectInstance[];
}

export interface DraftCustomer {
  id: string;
  typeId: number;
  waitTime: number;
  weatherEff: number;
  dishes: DraftDish[];
  staffAmount?: number;
  customerIndex?: number;
}

export interface DraftQueueSlot {
  id: string;
  ingredientId: number;
  ingredient: string;
  effects: EffectInstance[];
  provisional: boolean;
  /** Units released atomically by one pick; absent or 1 = one unit. Serialized as `<id>:<amount>`. */
  amount?: number;
}

export interface DraftQueueLane {
  id: string;
  slots: DraftQueueSlot[];
}

export interface DraftQueueGroup {
  id: string;
  kind: QueueGroupKind;
  slotIds: string[];
}

export interface DraftGridCell extends GridCellConfig {
  id: string;
  x: number;
  y: number;
}

export interface LevelProperties {
  id: number;
  name: string;
  weather: string;
  levelTag: string;
  featureUnlock: string;
  shuffleDistance: number;
  serveableSlots: number;
  outOfSlotPolicy?: "block-pick" | "park-on-grid";
  boosterCharges?: number[];
}

export interface SessionDraft {
  level: LevelProperties;
  customers: DraftCustomer[];
  lanes: DraftQueueLane[];
  groups: DraftQueueGroup[];
  grid: DraftGridCell[];
}

export interface StrategyChange {
  revision: number;
  strategy: AuthoringStrategy;
  rationale: string;
  evidence: string[];
  at: string;
}

export interface ValidationFinding {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  objectIds?: string[];
  repair?: string;
}

export interface ConstraintProgress {
  constraints: NormalizedConstraint[];
  met: number;
  total: number;
  unresolved: number;
}

export type RequirementPriority = "hard" | "target" | "preference";
export type ConstraintOperator = "=" | "!=" | "<" | "<=" | ">" | ">=" | "between" | "in";
export type ConstraintValue = number | string | boolean | [number, number] | string[] | Record<string, number>;

export interface MetricConstraint {
  id: string;
  dimension: string;
  metric: string;
  operator: ConstraintOperator;
  value: ConstraintValue;
  priority: RequirementPriority;
  weight: number;
  source: string;
  scope?: Record<string, string | number | boolean>;
  minimumRuns?: number;
  confidence?: number;
}

export interface RequirementGap {
  id: string;
  dimension: string;
  message: string;
  question: string;
  answerKeys: string[];
}

export interface RefinedLevelRequirements {
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

export interface CandidateRevision {
  revision: number;
  draft: SessionDraft;
  requirements?: RefinedLevelRequirements;
  label: string;
  at: string;
}

export interface CandidateRecord {
  id: string;
  name: string;
  parentId?: string;
  basedOnRevision?: number;
  revision: number;
  draft: SessionDraft;
  history: CandidateRevision[];
  idCounters: Record<"customer" | "dish" | "lane" | "slot" | "group", number>;
  validationHistory: Array<{ revision: number; kind: string; result: unknown; at: string }>;
  playtestHistory: Array<{ revision: number; result: unknown; at: string }>;
  cycleCount: number;
  latestEvaluationId?: string;
  status: "active" | "kept" | "rejected" | "finalized";
}

export interface EvaluationSeedSet {
  id: string;
  name: string;
  seeds: number[];
  createdAt: string;
}

export interface EvaluatedConstraint {
  constraintId: string;
  metric: string;
  actual?: ConstraintValue;
  target: ConstraintValue;
  pass: boolean;
  normalizedGap: number;
  priority: RequirementPriority;
  weight: number;
  confidence?: number;
}

export interface EvaluationRecord {
  id: string;
  sessionId: string;
  candidateId: string;
  revision: number;
  contextToken: string;
  behaviorSemanticsVersion: string;
  seedSetId: string;
  seeds: number[];
  runs: number;
  profile: "fast-shape" | "tuning" | "final" | "custom";
  createdAt: string;
  metrics: Record<string, ConstraintValue>;
  confidenceIntervals: Record<string, [number, number]>;
  constraints: EvaluatedConstraint[];
  hardFailures: ValidationFinding[];
  failReasons: Record<string, number>;
  weightedGap: number;
  passed: boolean;
  artifactPath?: string;
}

export interface DeadlockReportRecord {
  id: string;
  candidateId: string;
  revision: number;
  fullCheck: boolean;
  createdAt: string;
  verdict: "safe" | "risky" | "deadlock" | "unknown";
  stuckRate: number;
  storedCaseCount: number;
  artifactPath: string;
}

export type ProposalAction = {
  tool: "merge_queue_slots";
  arguments: { slotIds: string[] };
  expectedResult: { keptSlotId: string; amount: number; removedSlotIds: string[] };
} | {
  tool: "split_queue_slot";
  arguments: { slotId: string; keepAmount: number };
  expectedResult: { keptSlotId: string; keptAmount: number; remainderSlotId: string; remainderAmount: number };
} | {
  tool: "add_queue_lane";
  arguments: { position?: number };
  expectedResult: { laneId: string };
} | {
  tool: "add_queue_ingredient";
  arguments: { laneId: string; position: number; ingredient: string; count: number; amount: number; provisional: boolean };
  expectedResult: { slotIds: string[]; expandedUnits: number };
} | {
  tool: "add_customer";
  arguments: { typeId: number; waitTime: number; weatherEff: number; position?: number; customerIndex?: number };
  expectedResult: { customerId: string };
} | {
  tool: "add_dish";
  arguments: { customerId: string; composite: string };
  expectedResult: { dishId: string };
} | {
  tool: "add_dish_piece";
  arguments: { dishId: string; slotIndex: number; ingredient: string };
  expectedResult: { dishId: string; selectedCount: number };
} | {
  tool: "set_queue_slot_effect";
  arguments: { slotId: string; effect: EffectInstance };
  expectedResult: { slotId: string };
} | {
  tool: "set_grid_cell_effect";
  arguments: { x: number; y: number; effect: EffectInstance };
  expectedResult: { cellId: string };
};

export interface ProposalRecord {
  id: string;
  kind: "amount-plan" | "repair" | "skeleton" | "customer-plan" | "dish-plan" | "queue-plan" | "grid-plan" | "effect-plan";
  name: string;
  candidateId: string;
  baseRevision: number;
  deterministicSeed: number;
  actions: ProposalAction[];
  expectedSupplyDelta: Record<string, number>;
  expectedMetricDirections: Record<string, "increase" | "decrease" | "unchanged">;
  authorizationRequirements: MechanicAuthorization[];
  warnings: string[];
  status: "pending" | "applied" | "discarded";
  createdAt: string;
  appliedRevision?: number;
  discardedAt?: string;
  artifactPath?: string;
}

export interface SnapshotScore {
  metrics: Record<string, ConstraintValue>;
  constraints: EvaluatedConstraint[];
  hardFailures: ValidationFinding[];
  weightedGap: number;
  passed: boolean;
}

export interface MutationExperimentRecord {
  id: string;
  name: string;
  candidateId: string;
  baseRevision: number;
  proposalId?: string;
  actions: ProposalAction[];
  seeds: number[];
  before: SnapshotScore;
  after: SnapshotScore;
  status: "evaluated" | "applied" | "discarded";
  createdAt: string;
  appliedRevision?: number;
  artifactPath?: string;
}

export interface SearchObservationRecord {
  id: string;
  candidateId: string;
  revision: number;
  hypothesis: string;
  beforeEvidence?: string;
  afterEvidence?: string;
  disposition: "kept" | "reverted" | "rejected" | "informational";
  notes?: string;
  createdAt: string;
}

export interface LevelBatchSpec {
  levelCount: number;
  customerRange?: [number, number];
  dishesPerCustomer?: number;
  laneRange?: [number, number];
  amountUtilizationCurve?: Array<"single-unit" | "balanced" | "compact">;
  queueArchetypeCurve?: Array<"staggered-braid" | "wave-echo" | "asymmetric-lanes">;
  difficultyCurve?: string[];
  validationProfile?: "fast-shape" | "tuning" | "final";
  runsPerLevel?: number;
  outputPrefix?: string;
  authorizedMechanics?: MechanicAuthorization[];
}

export interface LevelBatchMember {
  index: number;
  seed: number;
  customerCount: number;
  dishesPerCustomer: number;
  laneCount: number;
  amountStyle: "single-unit" | "balanced" | "compact";
  layoutArchetype: "staggered-braid" | "wave-echo" | "asymmetric-lanes";
  difficulty: string;
  sessionId: string;
  status: "planned" | "running" | "valid" | "invalid" | "error";
  evaluationId?: string;
  finalized?: boolean;
  artifactRefs?: string[];
  error?: string;
}

export interface LevelBatchRecord {
  id: string;
  mapId: string;
  contextToken: string;
  seed: number;
  spec: LevelBatchSpec;
  status: "created" | "planned" | "running" | "complete" | "finalized" | "cancelled";
  members: LevelBatchMember[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  schemaVersion: 1 | 2;
  id: string;
  mapId: string;
  contextToken: string;
  originalBrief: string;
  /** Present for sessions started through the guided requirement pipeline. */
  requirements?: RefinedLevelRequirements;
  interpretation: BriefInterpretation;
  authorizedMechanics: MechanicAuthorization[];
  strategy?: AuthoringStrategy;
  strategyHistory: StrategyChange[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  cycleCount: number;
  idCounters: Record<"customer" | "dish" | "lane" | "slot" | "group", number>;
  draft: SessionDraft;
  history: Array<{ revision: number; draft: SessionDraft; requirements?: RefinedLevelRequirements; label: string; at: string }>;
  validationHistory: Array<{ revision: number; kind: string; result: unknown; at: string }>;
  playtestHistory: Array<{ revision: number; result: unknown; at: string }>;
  activeCandidateId?: string;
  candidates?: Record<string, CandidateRecord>;
  evaluations?: Record<string, EvaluationRecord>;
  seedSets?: Record<string, EvaluationSeedSet>;
  deadlockReports?: Record<string, DeadlockReportRecord>;
  proposals?: Record<string, ProposalRecord>;
  experiments?: Record<string, MutationExperimentRecord>;
  searchObservations?: SearchObservationRecord[];
  /** Current revision proven valid by finalize_level and eligible for Agent Design publishing. */
  finalization?: {
    candidateId: string;
    revision: number;
    label: "valid" | "closest";
    at: string;
    evaluationId?: string;
  };
}

export interface MutationResult {
  sessionId: string;
  candidateId?: string;
  revision: number;
  requirementToken?: string;
  changedObjects: unknown[];
  constraintProgress: ConstraintProgress;
  supplyDemandChanges: unknown;
  findings: ValidationFinding[];
  invalidatedEvidence?: string[];
  largestGaps?: Array<{ constraintId: string; metric: string; normalizedGap: number }>;
  nextActions?: Array<{ tool: string; arguments: Record<string, unknown>; rationale: string; mutation: boolean }>;
}

export interface CustomerCatalogEntry {
  index: number;
  id: string;
  name: string;
  desc: string;
  type: string;
  baseMap: string;
  mapIndex: number;
  fileId: string;
  icon: string;
}
