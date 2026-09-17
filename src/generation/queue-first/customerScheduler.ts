import type { NodeCustomerConfig } from "../../core/nodeParser.ts";
import type { GraphIndex } from "../../core/nodeIndex.ts";
import type { IdIndex } from "../../data/nodeIdTable.ts";
import { nodePickupSequence } from "../../ui/nodedesign/nodeQueueGenerate.ts";
import type {
  CustomerAllocation,
  CustomerGenerationVector,
  PickupPlanArtifact,
  QueueArtifact,
} from "./contracts.ts";
import type { DishTemplate } from "./dishTemplateCatalog.ts";

export interface ScheduledCustomers {
  customers: NodeCustomerConfig[];
  allocation: CustomerAllocation[];
  peakEarlyInventory: number;
  maximumPickupToDemandDistance: number;
}

interface UnitToken { ingredient: string; step: number; slotId: string }

function unitTokens(queue: QueueArtifact, pickup: PickupPlanArtifact): UnitToken[] {
  const slots = new Map(queue.lanes.flatMap((lane) => lane.slots.map((slot) => [slot.id, slot] as const)));
  const result: UnitToken[] = [];
  for (const step of pickup.steps) {
    for (const slotId of step.slotIds) {
      const slot = slots.get(slotId);
      if (!slot) continue;
      for (let n = 0; n < slot.amount; n++) {
        result.push({ ingredient: String(slot.ingredient), step: step.index, slotId });
      }
    }
  }
  return result;
}

function desiredCustomerCount(dishCount: number, vector: CustomerGenerationVector): number {
  const needed = Math.ceil(dishCount / Math.max(1, vector.maxDishesPerCustomer));
  return Math.max(vector.minCustomers, Math.min(vector.maxCustomers, needed));
}

export function scheduleCustomerTemplates(
  templates: readonly DishTemplate[],
  queue: QueueArtifact,
  pickup: PickupPlanArtifact,
  vector: CustomerGenerationVector,
  prefix: readonly NodeCustomerConfig[] = [],
): ScheduledCustomers {
  const tokens = unitTokens(queue, pickup);
  const available = new Map<string, UnitToken[]>();
  for (const token of tokens) {
    const list = available.get(token.ingredient);
    if (list) list.push(token);
    else available.set(token.ingredient, [token]);
  }
  const templateAvailability = (template: DishTemplate): number => {
    let latest = 0;
    for (const [ingredient, amount] of Object.entries(template.rawSignature)) {
      const list = available.get(ingredient) ?? [];
      latest = Math.max(latest, list[Math.max(0, amount - 1)]?.step ?? Number.MAX_SAFE_INTEGER);
    }
    return latest;
  };
  const ordered = [...templates].sort((a, b) => templateAvailability(a) - templateAvailability(b) || a.id.localeCompare(b.id));
  const customerCount = desiredCustomerCount(prefix.reduce((sum, customer) => sum + customer.dishes.length, 0) + ordered.length, vector);
  const customers: NodeCustomerConfig[] = prefix.map((customer) => structuredClone(customer));
  const suffixCustomers = Math.ceil(ordered.length / Math.max(1, vector.maxDishesPerCustomer));
  const targetCount = Math.max(customerCount, prefix.length + suffixCustomers);
  while (customers.length < targetCount) customers.push({ typeId: 0, waitTime: 0, weatherEff: 0, dishes: [] });
  for (const template of ordered) {
    const target = customers.slice(prefix.length)
      .find((customer) => customer.dishes.length < vector.maxDishesPerCustomer) ?? customers.at(-1)!;
    target.dishes.push(structuredClone(template.dish));
  }

  const allocation: CustomerAllocation[] = [];
  let maximumDistance = 0;
  let runningPicked = 0;
  let runningConsumed = 0;
  let peakInventory = 0;
  let templateAt = 0;
  for (let customerIndex = prefix.length; customerIndex < customers.length; customerIndex++) {
    for (let dishIndex = 0; dishIndex < customers[customerIndex].dishes.length; dishIndex++) {
      const template = ordered[templateAt++];
      if (!template) continue;
      const allocations: UnitToken[] = [];
      for (const [ingredient, amount] of Object.entries(template.rawSignature)) {
        const list = available.get(ingredient) ?? [];
        for (let count = 0; count < amount; count++) {
          const token = list.shift();
          if (token) allocations.push(token);
        }
      }
      const demandStep = allocations.reduce((latest, token) => Math.max(latest, token.step), 0);
      for (const token of allocations) {
        maximumDistance = Math.max(maximumDistance, demandStep - token.step);
        allocation.push({
          queueSlotId: token.slotId,
          pickupStep: token.step,
          customerIndex,
          dishIndex,
          orderedIngredient: template.orderedIngredients.join(","),
          rawIngredient: token.ingredient,
        });
      }
      runningPicked = Math.max(runningPicked, demandStep + 1);
      runningConsumed += allocations.length;
      peakInventory = Math.max(peakInventory, runningPicked - runningConsumed);
    }
  }
  return { customers, allocation, peakEarlyInventory: peakInventory, maximumPickupToDemandDistance: maximumDistance };
}

/** Rebuilds unit-level provenance for an already-authored customer sequence. */
export function allocateCustomerOrders(
  customers: readonly NodeCustomerConfig[],
  queue: QueueArtifact,
  pickup: PickupPlanArtifact,
  ix: GraphIndex,
  ids: IdIndex,
): ScheduledCustomers & { missingSupply: Record<string, number>; unconsumedSupply: Record<string, number> } {
  const allTokens = unitTokens(queue, pickup);
  const available = new Map<string, UnitToken[]>();
  for (const token of allTokens) {
    const list = available.get(token.ingredient);
    if (list) list.push(token);
    else available.set(token.ingredient, [token]);
  }
  const allocation: CustomerAllocation[] = [];
  const missingSupply: Record<string, number> = {};
  let peakEarlyInventory = 0;
  let maximumPickupToDemandDistance = 0;
  let consumed = 0;
  for (let customerIndex = 0; customerIndex < customers.length; customerIndex++) {
    for (let dishIndex = 0; dishIndex < customers[customerIndex].dishes.length; dishIndex++) {
      const dish = customers[customerIndex].dishes[dishIndex];
      const sequence = nodePickupSequence(ix, ids, [{ typeId: 0, waitTime: 0, weatherEff: 0, dishes: [dish] }]);
      const selected: UnitToken[] = [];
      for (const raw of sequence) {
        const key = String(raw);
        const token = available.get(key)?.shift();
        if (token) selected.push(token);
        else missingSupply[key] = (missingSupply[key] ?? 0) + 1;
      }
      const demandStep = selected.reduce((latest, token) => Math.max(latest, token.step), 0);
      for (const token of selected) {
        maximumPickupToDemandDistance = Math.max(maximumPickupToDemandDistance, demandStep - token.step);
        allocation.push({
          queueSlotId: token.slotId,
          pickupStep: token.step,
          customerIndex,
          dishIndex,
          orderedIngredient: "dish",
          rawIngredient: token.ingredient,
        });
      }
      consumed += selected.length;
      const picked = allTokens.filter((token) => token.step <= demandStep).length;
      peakEarlyInventory = Math.max(peakEarlyInventory, picked - consumed);
    }
  }
  const unconsumedSupply = Object.fromEntries([...available.entries()]
    .map(([ingredient, tokens]) => [ingredient, tokens.length] as const)
    .filter(([, count]) => count > 0));
  return {
    customers: structuredClone([...customers]),
    allocation,
    peakEarlyInventory,
    maximumPickupToDemandDistance,
    missingSupply,
    unconsumedSupply,
  };
}
