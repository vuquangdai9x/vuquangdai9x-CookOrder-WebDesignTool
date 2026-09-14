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

export interface SessionRecord {
  schemaVersion: 1;
  id: string;
  mapId: string;
  contextToken: string;
  originalBrief: string;
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
  history: Array<{ revision: number; draft: SessionDraft; label: string; at: string }>;
  validationHistory: Array<{ revision: number; kind: string; result: unknown; at: string }>;
  playtestHistory: Array<{ revision: number; result: unknown; at: string }>;
}

export interface MutationResult {
  sessionId: string;
  revision: number;
  changedObjects: unknown[];
  constraintProgress: ConstraintProgress;
  supplyDemandChanges: unknown;
  findings: ValidationFinding[];
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
