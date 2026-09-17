import type { LevelData } from "../mapLoader.ts";
import type { GeneratorSheetValues, RecoveredGeneratorData } from "./contracts.ts";
import { applyCustomerGeneratorData, customerGeneratorDataFromLevel, decodeCustomerGeneratorData } from "./customerGeneratorData.ts";
import { encodeGeneratorPayload, withPayloadHash } from "./codec.ts";
import { decodeGeneratorWorkspaceData } from "./workspaceData.ts";
import {
  decodeCustomerPhaseData,
  decodePickupPhaseData,
  decodeQueuePhaseData,
  stalePhaseForLevel,
} from "./queueFirstPhaseData.ts";

/** Interprets E/F/G/I as new envelopes when prefixed, otherwise as the legacy four raw values. */
export function recoverGeneratorSheetValues(level: LevelData, values: GeneratorSheetValues): RecoveredGeneratorData {
  const warnings: string[] = [];
  let customer;
  const workspace = values.customerGeneratorData.startsWith("gw2_")
    ? decodeGeneratorWorkspaceData(values.customerGeneratorData)
    : undefined;
  if (workspace) {
    warnings.push(...workspace.migrationWarnings);
  } else if (values.customerGeneratorData.startsWith("cg1_")) {
    customer = decodeCustomerGeneratorData(values.customerGeneratorData);
  } else {
    customer = customerGeneratorDataFromLevel({
      ...level,
      customerDishesSequence: values.customerGeneratorData || undefined,
      complexityCurve: values.queuePhaseData || undefined,
      shuffleCurve: values.pickupPhaseData || undefined,
      obstacleData: values.customerPhaseData || undefined,
    });
    warnings.push("Loaded a legacy E/F/G/I row. It will migrate only when explicitly saved.");
  }
  const queue = values.queuePhaseData.startsWith("qfq1_")
    ? stalePhaseForLevel(decodeQueuePhaseData(values.queuePhaseData), level) : undefined;
  let pickup = values.pickupPhaseData.startsWith("qfp1_")
    ? stalePhaseForLevel(decodePickupPhaseData(values.pickupPhaseData), level) : undefined;
  let customers = values.customerPhaseData.startsWith("qfc1_")
    ? stalePhaseForLevel(decodeCustomerPhaseData(values.customerPhaseData), level) : undefined;
  if (pickup && queue?.artifact && pickup.queueHash !== queue.artifact.contentHash) {
    pickup.vector.status = "stale";
    if (pickup.artifact) pickup.artifact.status = "stale";
    pickup = withPayloadHash(pickup);
    warnings.push("Recovered Pickup data references a different Queue artifact.");
  }
  if (customers && (customers.queueHash !== queue?.artifact?.contentHash || customers.pickupPlanHash !== pickup?.artifact?.contentHash)) {
    customers.vector.status = "stale";
    if (customers.artifact) customers.artifact.status = "stale";
    customers = withPayloadHash(customers);
    warnings.push("Recovered Customer data references different upstream artifacts.");
  }
  return { workspace, customer, queue, pickup, customers, warnings };
}

export function applyRecoveredGeneratorData(
  level: LevelData,
  recovered: RecoveredGeneratorData,
): void {
  if (recovered.workspace) level.customerGeneratorData = encodeGeneratorPayload(recovered.workspace);
  else if (recovered.customer) applyCustomerGeneratorData(level, recovered.customer);
  if (recovered.queue) level.queuePhaseData = encodeGeneratorPayload(recovered.queue);
  else delete level.queuePhaseData;
  if (recovered.pickup) level.pickupPhaseData = encodeGeneratorPayload(recovered.pickup);
  else delete level.pickupPhaseData;
  if (recovered.customers) level.customerPhaseData = encodeGeneratorPayload(recovered.customers);
  else delete level.customerPhaseData;
}
