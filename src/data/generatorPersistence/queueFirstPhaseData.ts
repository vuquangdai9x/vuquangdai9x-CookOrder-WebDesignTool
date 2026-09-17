import type { LevelData } from "../mapLoader.ts";
import { artifactHash } from "../../generation/queue-first/artifactHash.ts";
import { markArtifactStale } from "../../generation/queue-first/vectorArtifacts.ts";
import type {
  CustomerPhaseSheetData,
  LevelProjectionHashes,
  PickupPhaseSheetData,
  QueuePhaseSheetData,
} from "./contracts.ts";
import { decodeGeneratorPayload, encodeGeneratorPayload, withPayloadHash } from "./codec.ts";

export function levelProjectionHashes(level: Pick<LevelData, "customerString" | "gridString" | "queueString">): LevelProjectionHashes {
  return {
    customerString: artifactHash(level.customerString),
    gridString: artifactHash(level.gridString),
    queueString: artifactHash(level.queueString),
  };
}

export function projectionMatches(a: LevelProjectionHashes, b: LevelProjectionHashes): boolean {
  return a.customerString === b.customerString && a.gridString === b.gridString && a.queueString === b.queueString;
}

export function createQueuePhaseData(input: Omit<QueuePhaseSheetData, "schemaVersion" | "kind" | "contentHash">): QueuePhaseSheetData {
  return withPayloadHash({ schemaVersion: 1 as const, kind: "queue-first/queue-phase" as const, ...input });
}

export function createPickupPhaseData(input: Omit<PickupPhaseSheetData, "schemaVersion" | "kind" | "contentHash">): PickupPhaseSheetData {
  return withPayloadHash({ schemaVersion: 1 as const, kind: "queue-first/pickup-phase" as const, ...input });
}

export function createCustomerPhaseData(input: Omit<CustomerPhaseSheetData, "schemaVersion" | "kind" | "contentHash">): CustomerPhaseSheetData {
  return withPayloadHash({ schemaVersion: 1 as const, kind: "queue-first/customer-phase" as const, ...input });
}

export const encodeQueuePhaseData = (data: QueuePhaseSheetData): string => encodeGeneratorPayload(data);
export const encodePickupPhaseData = (data: PickupPhaseSheetData): string => encodeGeneratorPayload(data);
export const encodeCustomerPhaseData = (data: CustomerPhaseSheetData): string => encodeGeneratorPayload(data);

function validateVector(value: unknown, kind: string): void {
  const vector = value as { kind?: unknown; contentHash?: unknown; contextHash?: unknown };
  if (!vector || vector.kind !== kind || typeof vector.contentHash !== "string" || typeof vector.contextHash !== "string") {
    throw new Error(`Invalid ${kind} artifact.`);
  }
}

export function decodeQueuePhaseData(source: string): QueuePhaseSheetData {
  const value = decodeGeneratorPayload<QueuePhaseSheetData>(source, "queue-first/queue-phase");
  validateVector(value.vector, "queue-vector");
  if (!value.context || value.context.kind !== "authoring-context") throw new Error("Invalid authoring context artifact.");
  if (value.artifact && (value.artifact.kind !== "queue" || value.artifact.vectorHash !== value.vector.contentHash)) {
    throw new Error("Queue artifact does not match the stored queue vector.");
  }
  return value;
}

export function decodePickupPhaseData(source: string): PickupPhaseSheetData {
  const value = decodeGeneratorPayload<PickupPhaseSheetData>(source, "queue-first/pickup-phase");
  validateVector(value.vector, "pickup-vector");
  if (value.artifact && (value.artifact.kind !== "pickup-plan" || value.artifact.queueHash !== value.queueHash || value.artifact.vectorHash !== value.vector.contentHash)) {
    throw new Error("Pickup artifact does not match its stored prerequisites.");
  }
  return value;
}

export function decodeCustomerPhaseData(source: string): CustomerPhaseSheetData {
  const value = decodeGeneratorPayload<CustomerPhaseSheetData>(source, "queue-first/customer-phase");
  validateVector(value.vector, "customer-vector");
  if (value.artifact && (value.artifact.kind !== "customer-orders" || value.artifact.queueHash !== value.queueHash
    || value.artifact.pickupPlanHash !== value.pickupPlanHash || value.artifact.vectorHash !== value.vector.contentHash)) {
    throw new Error("Customer artifact does not match its stored prerequisites.");
  }
  return value;
}

/** Preserve recovered work for inspection while preventing mismatched data from becoming current. */
export function stalePhaseForLevel<T extends QueuePhaseSheetData | PickupPhaseSheetData | CustomerPhaseSheetData>(
  phase: T,
  level: LevelData,
): T {
  if (projectionMatches(phase.levelProjectionHashes, levelProjectionHashes(level))) return phase;
  return withPayloadHash({
    ...phase,
    vector: markArtifactStale(phase.vector),
    artifact: phase.artifact ? markArtifactStale(phase.artifact) : undefined,
  }) as T;
}
