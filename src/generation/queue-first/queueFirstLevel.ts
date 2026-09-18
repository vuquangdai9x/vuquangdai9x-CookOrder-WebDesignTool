import { serializeNodeCustomers } from "../../core/nodeParser.ts";
import { serializeQueues } from "../../core/parser.ts";
import type { CustomerGenerationEnvironment } from "./phase3CustomerOrders.ts";
import type {
  AuthoringContextArtifact,
  CustomerGenerationVectorArtifact,
  CustomerOrderArtifact,
  PickupPlanArtifact,
  PickupPlanningVectorArtifact,
  QueueArtifact,
  QueueGenerationVectorArtifact,
} from "./contracts.ts";
import { validateCustomerOrderArtifact } from "./phase3CustomerOrders.ts";
import { validateAutomaticPickupPlan } from "./pickupSearch.ts";
import { projectQueueArtifact, validateQueueArtifact } from "./validation.ts";

export interface QueueFirstLevelValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  canonical?: { customerString: string; queueString: string };
}

/** Final pure commit gate. Difficulty estimation/playtesting remain quality gates after this structural proof. */
export function validateQueueFirstLevel(input: {
  context: AuthoringContextArtifact;
  queueVector: QueueGenerationVectorArtifact;
  queue: QueueArtifact;
  pickupVector: PickupPlanningVectorArtifact;
  pickupPlan: PickupPlanArtifact;
  customerVector: CustomerGenerationVectorArtifact;
  customers: CustomerOrderArtifact;
  env: CustomerGenerationEnvironment;
}): QueueFirstLevelValidation {
  const queue = validateQueueArtifact(input.queue, input.queueVector, input.context, input.env.ix);
  const pickup = validateAutomaticPickupPlan(input.pickupPlan, input.queue, input.pickupVector);
  const customers = validateCustomerOrderArtifact(
    input.customers,
    input.customerVector,
    input.queue,
    input.pickupPlan,
    input.env,
  );
  const errors = [...queue.errors, ...pickup.errors, ...customers.errors];
  if (errors.length > 0) return { valid: false, errors, warnings: queue.warnings };
  const projected = projectQueueArtifact(input.queue);
  return {
    valid: true,
    errors: [],
    warnings: queue.warnings,
    canonical: {
      customerString: serializeNodeCustomers(input.customers.customers),
      queueString: serializeQueues(projected.queues, projected.groups),
    },
  };
}
