import type {
  AuthoringContextArtifact,
  CustomerGenerationVectorArtifact,
  CustomerOrderArtifact,
  PickupPlanArtifact,
  PickupPlanningVectorArtifact,
  QueueArtifact,
  QueueGenerationVectorArtifact,
} from "../../generation/queue-first/contracts.ts";
import type { GeneratorWorkspaceEnvelopeV2 } from "./workspaceData.ts";

export interface CustomerGeneratorSheetData {
  schemaVersion: 1;
  kind: "customer-first-generator";
  customerDishesSequence?: string;
  complexityCurve?: string;
  shuffleCurve?: string;
  obstacleData?: string;
  bagFill?: "min" | "random" | "max";
  contentHash: string;
}

export interface LevelProjectionHashes {
  customerString: string;
  gridString: string;
  queueString: string;
}

export interface QueuePhaseSheetData {
  schemaVersion: 1;
  kind: "queue-first/queue-phase";
  context: AuthoringContextArtifact;
  vector: QueueGenerationVectorArtifact;
  artifact?: QueueArtifact;
  levelProjectionHashes: LevelProjectionHashes;
  contentHash: string;
}

export interface PickupPhaseSheetData {
  schemaVersion: 1;
  kind: "queue-first/pickup-phase";
  vector: PickupPlanningVectorArtifact;
  artifact?: PickupPlanArtifact;
  queueHash: string;
  levelProjectionHashes: LevelProjectionHashes;
  contentHash: string;
}

export interface CustomerPhaseSheetData {
  schemaVersion: 1;
  kind: "queue-first/customer-phase";
  vector: CustomerGenerationVectorArtifact;
  artifact?: CustomerOrderArtifact;
  queueHash: string;
  pickupPlanHash: string;
  levelProjectionHashes: LevelProjectionHashes;
  contentHash: string;
}

export type PhaseSheetData = QueuePhaseSheetData | PickupPhaseSheetData | CustomerPhaseSheetData;
export type GeneratorPayloadKey = "customerGeneratorData" | "queuePhaseData" | "pickupPhaseData" | "customerPhaseData";

export interface GeneratorSheetValues {
  ingredientWeights: string;
  customerGeneratorData: string;
  queuePhaseData: string;
  pickupPhaseData: string;
  randomSeed: string;
  customerPhaseData: string;
  author: string;
}

export interface GeneratorSheetSnapshot {
  mapId: string;
  levelId: number;
  rowNumber: number | null;
  values: GeneratorSheetValues;
}

export type GeneratorSheetUpdate = Partial<GeneratorSheetValues>;

export interface RecoveredGeneratorData {
  workspace?: GeneratorWorkspaceEnvelopeV2;
  customer?: CustomerGeneratorSheetData;
  queue?: QueuePhaseSheetData;
  pickup?: PickupPhaseSheetData;
  customers?: CustomerPhaseSheetData;
  warnings: string[];
}
