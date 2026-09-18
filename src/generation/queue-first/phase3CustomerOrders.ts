import type { GraphIndex } from "../../core/nodeIndex.ts";
import type { NodeCustomerConfig } from "../../core/nodeParser.ts";
import { serializeDish } from "../../core/nodeParser.ts";
import type { IdIndex } from "../../data/nodeIdTable.ts";
import { nodePickupSequence } from "../../ui/nodedesign/nodeQueueGenerate.ts";
import { artifactHash } from "./artifactHash.ts";
import type {
  AuthoringContextArtifact,
  CustomerGenerationFailure,
  CustomerGenerationVectorArtifact,
  CustomerOrderArtifact,
  PhaseReadinessIssue,
  PickupPlanArtifact,
  QueueArtifact,
} from "./contracts.ts";
import { allocateCustomerOrders, scheduleCustomerTemplates } from "./customerScheduler.ts";
import type { DishTemplate } from "./dishTemplateCatalog.ts";
import { enumerateDishTemplates } from "./dishTemplateCatalog.ts";
import { solveExactCover } from "./exactCover.ts";
import { getPhaseReadiness } from "./phaseReadiness.ts";

export interface CustomerGenerationEnvironment {
  ix: GraphIndex;
  ids: IdIndex;
}

export type GenerateCustomersResult =
  | { started: false; readinessIssues: PhaseReadinessIssue[] }
  | { started: true; ok: true; artifact: CustomerOrderArtifact }
  | { started: true; ok: false; failure: CustomerGenerationFailure; draft: CustomerOrderArtifact };

function supplyOf(queue: QueueArtifact): Record<string, number> {
  const supply: Record<string, number> = {};
  for (const lane of queue.lanes) for (const slot of lane.slots) {
    const key = String(slot.ingredient);
    supply[key] = (supply[key] ?? 0) + slot.amount;
  }
  return supply;
}

function demandOf(
  customers: readonly NodeCustomerConfig[],
  env: CustomerGenerationEnvironment,
): Record<string, number> {
  const demand: Record<string, number> = {};
  for (const ingredient of nodePickupSequence(env.ix, env.ids, [...customers])) {
    const key = String(ingredient);
    demand[key] = (demand[key] ?? 0) + 1;
  }
  return demand;
}

function difference(
  minuend: Readonly<Record<string, number>>,
  subtrahend: Readonly<Record<string, number>>,
): { remaining: Record<string, number>; missing: Record<string, number> } {
  const remaining: Record<string, number> = {};
  const missing: Record<string, number> = {};
  for (const key of new Set([...Object.keys(minuend), ...Object.keys(subtrahend)])) {
    const value = (minuend[key] ?? 0) - (subtrahend[key] ?? 0);
    if (value > 0) remaining[key] = value;
    if (value < 0) missing[key] = -value;
  }
  return { remaining, missing };
}

export function refreshCustomerOrderArtifact(artifact: CustomerOrderArtifact): CustomerOrderArtifact {
  const contentHash = artifactHash({
    queueHash: artifact.queueHash,
    pickupPlanHash: artifact.pickupPlanHash,
    vectorHash: artifact.vectorHash,
    mode: artifact.mode,
    completion: artifact.completion,
    customers: artifact.customers,
    allocation: artifact.allocation,
    lockedCustomerIndexes: artifact.lockedCustomerIndexes,
  });
  return { ...artifact, id: `customer-orders-${contentHash.slice(0, 12)}`, contentHash };
}

export function createCustomerOrderDraft(
  context: AuthoringContextArtifact,
  vector: CustomerGenerationVectorArtifact,
  queue: QueueArtifact,
  pickupPlan: PickupPlanArtifact,
  createdAt?: string,
): { started: false; readinessIssues: PhaseReadinessIssue[] } | { started: true; artifact: CustomerOrderArtifact } {
  const readiness = getPhaseReadiness({ phase: "customers", context, vector, queue, pickupPlan });
  if (!readiness.ready) return { started: false, readinessIssues: readiness.issues };
  return {
    started: true,
    artifact: refreshCustomerOrderArtifact({
      schemaVersion: 1,
      kind: "customer-orders",
      id: "",
      createdAt: createdAt ?? vector.confirmedAt ?? vector.createdAt,
      seed: vector.values.seed,
      graphHash: context.graphHash,
      upstreamHashes: [queue.contentHash, pickupPlan.contentHash, vector.contentHash],
      contentHash: "",
      status: "draft",
      warnings: [],
      queueHash: queue.contentHash,
      pickupPlanHash: pickupPlan.contentHash,
      vectorHash: vector.contentHash,
      mode: vector.values.mode,
      completion: "partial",
      customers: [],
      allocation: [],
      lockedCustomerIndexes: [],
      diagnostics: {
        exactSupply: false,
        peakEarlyInventory: 0,
        maximumPickupToDemandDistance: 0,
        dishTypeCounts: {},
        searchExhausted: false,
        expandedStates: 0,
        unconsumedSupply: supplyOf(queue),
        missingSupply: {},
      },
    }),
  };
}

function dishCounts(templates: readonly DishTemplate[], ix: GraphIndex): Record<string, number> {
  const result: Record<string, number> = {};
  for (const template of templates) {
    const name = ix.compositeName[template.orderable] ?? String(template.orderable);
    result[name] = (result[name] ?? 0) + 1;
  }
  return result;
}

export function generateCustomersFromQueue(
  context: AuthoringContextArtifact,
  vector: CustomerGenerationVectorArtifact,
  queue: QueueArtifact,
  pickupPlan: PickupPlanArtifact,
  env: CustomerGenerationEnvironment,
  existing?: CustomerOrderArtifact,
  createdAt?: string,
): GenerateCustomersResult {
  const created = createCustomerOrderDraft(context, vector, queue, pickupPlan, createdAt);
  if (!created.started) return created;
  const locked = existing && vector.values.mode === "manual-with-auto-suffix"
    ? existing.customers.filter((_, index) => existing.lockedCustomerIndexes.includes(index))
    : [];
  const supply = supplyOf(queue);
  const lockedDemand = demandOf(locked, env);
  const afterLocked = difference(supply, lockedDemand);
  if (Object.keys(afterLocked.missing).length > 0) {
    const draft = refreshCustomerOrderArtifact({
      ...created.artifact,
      customers: structuredClone(locked),
      lockedCustomerIndexes: locked.map((_, index) => index),
      diagnostics: { ...created.artifact.diagnostics, unconsumedSupply: afterLocked.remaining, missingSupply: afterLocked.missing },
    });
    return {
      started: true,
      ok: false,
      draft,
      failure: {
        kind: "no-exact-order-decomposition",
        queueHash: queue.contentHash,
        pickupPlanHash: pickupPlan.contentHash,
        unconsumedSupply: afterLocked.remaining,
        missingSupply: afterLocked.missing,
        blockingRecipeRules: ["Locked manual customers require more raw supply than the queue contains."],
        suggestedQueueMutations: Object.entries(afterLocked.missing).map(([ingredient, amount]) => ({
          kind: "add", ingredient: Number(ingredient), amount, reason: "Supply the locked customer allocation.",
        })),
      },
    };
  }

  const catalog = enumerateDishTemplates(env.ix, env.ids, {
    seed: vector.values.seed,
    maxDishSlots: vector.values.maxDishSlots,
    maximumCandidates: vector.values.search.maximumCandidates,
    dishTypeWeights: vector.values.dishTypeWeights,
  });
  const lockedDishCount = locked.reduce((sum, customer) => sum + customer.dishes.length, 0);
  const maximumItems = Math.max(0, vector.values.maxCustomers * vector.values.maxDishesPerCustomer - lockedDishCount);
  const solved = solveExactCover(afterLocked.remaining, catalog, {
    maximumExpandedStates: vector.values.search.maximumExpandedStates,
    wallTimeMs: vector.values.search.wallTimeMs,
    maximumItems,
  });
  if (!solved.exact) {
    const draft = refreshCustomerOrderArtifact({
      ...created.artifact,
      customers: structuredClone(locked),
      lockedCustomerIndexes: locked.map((_, index) => index),
      warnings: [solved.exhausted ? "Customer search budget exhausted." : "No exact dish decomposition exists."],
      diagnostics: {
        ...created.artifact.diagnostics,
        searchExhausted: solved.exhausted,
        expandedStates: solved.expandedStates,
        unconsumedSupply: solved.remaining,
      },
    });
    return {
      started: true,
      ok: false,
      draft,
      failure: {
        kind: solved.exhausted ? "search-budget-exhausted" : "no-exact-order-decomposition",
        queueHash: queue.contentHash,
        pickupPlanHash: pickupPlan.contentHash,
        unconsumedSupply: solved.remaining,
        missingSupply: {},
        blockingRecipeRules: catalog.length === 0
          ? ["The graph produced no valid dish templates within the configured limits."]
          : ["No multiset of the bounded graph-valid templates exactly consumes the remaining supply."],
        nearestCandidate: solved.templates.length > 0 ? {
          supplyDistance: Object.values(solved.remaining).reduce((sum, amount) => sum + amount, 0),
          customerCount: locked.length,
          dishes: solved.templates.map((template) => template.dish),
        } : undefined,
        suggestedQueueMutations: Object.entries(solved.remaining).map(([ingredient, amount]) => ({
          kind: "remove", ingredient: Number(ingredient), amount, reason: "Remove unmatched queue supply or author a compatible recipe." ,
        })),
      },
    };
  }

  const scheduled = scheduleCustomerTemplates(solved.templates, queue, pickupPlan, vector.values, locked);
  const provenance = allocateCustomerOrders(scheduled.customers, queue, pickupPlan, env.ix, env.ids);
  const demand = demandOf(scheduled.customers, env);
  const finalDifference = difference(supply, demand);
  const exactSupply = Object.keys(finalDifference.remaining).length === 0 && Object.keys(finalDifference.missing).length === 0;
  const minDishes = scheduled.customers.every((customer) => customer.dishes.length >= vector.values.minDishesPerCustomer);
  const validCount = scheduled.customers.length >= vector.values.minCustomers && scheduled.customers.length <= vector.values.maxCustomers;
  const complete = exactSupply && minDishes && validCount;
  const artifact = refreshCustomerOrderArtifact({
    ...created.artifact,
    status: complete ? "valid" : "invalid",
    completion: complete ? "complete" : "partial",
    warnings: complete ? [] : ["Exact supply was found, but customer packing does not satisfy the configured customer/dish bounds."],
    customers: scheduled.customers,
    allocation: provenance.allocation,
    lockedCustomerIndexes: locked.map((_, index) => index),
    diagnostics: {
      exactSupply,
      peakEarlyInventory: provenance.peakEarlyInventory,
      maximumPickupToDemandDistance: provenance.maximumPickupToDemandDistance,
      dishTypeCounts: dishCounts(solved.templates, env.ix),
      searchExhausted: false,
      expandedStates: solved.expandedStates,
      unconsumedSupply: finalDifference.remaining,
      missingSupply: finalDifference.missing,
    },
  });
  return { started: true, ok: true, artifact };
}

function updateManualArtifact(
  artifact: CustomerOrderArtifact,
  customers: NodeCustomerConfig[],
  vector: CustomerGenerationVectorArtifact,
  queue: QueueArtifact,
  pickupPlan: PickupPlanArtifact,
  env: CustomerGenerationEnvironment,
): CustomerOrderArtifact {
  const provenance = allocateCustomerOrders(customers, queue, pickupPlan, env.ix, env.ids);
  const exactSupply = Object.keys(provenance.unconsumedSupply).length === 0 && Object.keys(provenance.missingSupply).length === 0;
  const bounds = customers.length >= vector.values.minCustomers && customers.length <= vector.values.maxCustomers
    && customers.every((customer) => customer.dishes.length >= vector.values.minDishesPerCustomer
      && customer.dishes.length <= vector.values.maxDishesPerCustomer);
  const complete = exactSupply && bounds;
  return refreshCustomerOrderArtifact({
    ...artifact,
    customers: provenance.customers,
    allocation: provenance.allocation,
    completion: complete ? "complete" : "partial",
    status: complete ? "valid" : "draft",
    diagnostics: {
      ...artifact.diagnostics,
      exactSupply,
      peakEarlyInventory: provenance.peakEarlyInventory,
      maximumPickupToDemandDistance: provenance.maximumPickupToDemandDistance,
      unconsumedSupply: provenance.unconsumedSupply,
      missingSupply: provenance.missingSupply,
    },
  });
}

export function appendManualCustomer(
  artifact: CustomerOrderArtifact,
  expectedRevision: string,
): { artifact: CustomerOrderArtifact; error?: string } {
  if (artifact.contentHash !== expectedRevision) return { artifact, error: "Customer artifact revision conflict." };
  const index = artifact.customers.length;
  const customers = [...artifact.customers, { typeId: 0, waitTime: 0, weatherEff: 0, dishes: [] }];
  return {
    artifact: refreshCustomerOrderArtifact({
      ...artifact,
      status: "draft",
      completion: "partial",
      customers,
      lockedCustomerIndexes: [...new Set([...artifact.lockedCustomerIndexes, index])].sort((a, b) => a - b),
    }),
  };
}

export function appendManualDish(
  artifact: CustomerOrderArtifact,
  expectedRevision: string,
  customerIndex: number,
  template: DishTemplate,
  vector: CustomerGenerationVectorArtifact,
  queue: QueueArtifact,
  pickupPlan: PickupPlanArtifact,
  env: CustomerGenerationEnvironment,
): { artifact: CustomerOrderArtifact; error?: string } {
  if (artifact.contentHash !== expectedRevision) return { artifact, error: "Customer artifact revision conflict." };
  if (!artifact.customers[customerIndex]) return { artifact, error: "Customer does not exist." };
  if (artifact.customers[customerIndex].dishes.length >= vector.values.maxDishesPerCustomer) {
    return { artifact, error: "Customer already has the maximum configured dishes." };
  }
  const customers = structuredClone(artifact.customers);
  customers[customerIndex].dishes.push(structuredClone(template.dish));
  const next = updateManualArtifact(artifact, customers, vector, queue, pickupPlan, env);
  if (Object.keys(next.diagnostics.missingSupply).length > 0) {
    return { artifact, error: `Dish ${template.id} requires raw supply that is no longer available.` };
  }
  next.lockedCustomerIndexes = [...new Set([...next.lockedCustomerIndexes, customerIndex])].sort((a, b) => a - b);
  return { artifact: refreshCustomerOrderArtifact(next) };
}

export function removeManualDish(
  artifact: CustomerOrderArtifact,
  expectedRevision: string,
  customerIndex: number,
  dishIndex: number,
  vector: CustomerGenerationVectorArtifact,
  queue: QueueArtifact,
  pickupPlan: PickupPlanArtifact,
  env: CustomerGenerationEnvironment,
): { artifact: CustomerOrderArtifact; error?: string } {
  if (artifact.contentHash !== expectedRevision) return { artifact, error: "Customer artifact revision conflict." };
  if (!artifact.customers[customerIndex]?.dishes[dishIndex]) return { artifact, error: "Dish does not exist." };
  const customers = structuredClone(artifact.customers);
  customers[customerIndex].dishes.splice(dishIndex, 1);
  return { artifact: updateManualArtifact(artifact, customers, vector, queue, pickupPlan, env) };
}

export function moveCustomerOnPickupPath(
  artifact: CustomerOrderArtifact,
  expectedRevision: string,
  fromIndex: number,
  toIndex: number,
  vector: CustomerGenerationVectorArtifact,
  queue: QueueArtifact,
  pickupPlan: PickupPlanArtifact,
  env: CustomerGenerationEnvironment,
): { artifact: CustomerOrderArtifact; error?: string } {
  if (artifact.contentHash !== expectedRevision) return { artifact, error: "Customer artifact revision conflict." };
  if (!artifact.customers[fromIndex] || toIndex < 0 || toIndex >= artifact.customers.length) {
    return { artifact, error: "Customer move is outside the current path." };
  }
  const customers = structuredClone(artifact.customers);
  const [moved] = customers.splice(fromIndex, 1);
  customers.splice(toIndex, 0, moved);
  return { artifact: updateManualArtifact(artifact, customers, vector, queue, pickupPlan, env) };
}

export function lockManualCustomer(
  artifact: CustomerOrderArtifact,
  expectedRevision: string,
  customerIndex: number,
  locked: boolean,
): { artifact: CustomerOrderArtifact; error?: string } {
  if (artifact.contentHash !== expectedRevision) return { artifact, error: "Customer artifact revision conflict." };
  if (!artifact.customers[customerIndex]) return { artifact, error: "Customer does not exist." };
  const indexes = new Set(artifact.lockedCustomerIndexes);
  if (locked) indexes.add(customerIndex); else indexes.delete(customerIndex);
  return { artifact: refreshCustomerOrderArtifact({ ...artifact, lockedCustomerIndexes: [...indexes].sort((a, b) => a - b) }) };
}

export function explainCustomerGenerationFailure(failure: CustomerGenerationFailure): string[] {
  const lines = [failure.kind === "search-budget-exhausted"
    ? "The bounded search stopped before proving feasibility."
    : "No exact order decomposition was found."];
  if (Object.keys(failure.unconsumedSupply).length) lines.push(`Unconsumed supply: ${JSON.stringify(failure.unconsumedSupply)}`);
  if (Object.keys(failure.missingSupply).length) lines.push(`Missing supply: ${JSON.stringify(failure.missingSupply)}`);
  lines.push(...failure.blockingRecipeRules);
  return lines;
}

export function customerDishIdentity(customer: NodeCustomerConfig): string[] {
  return customer.dishes.map(serializeDish);
}

export function validateCustomerOrderArtifact(
  artifact: CustomerOrderArtifact,
  vector: CustomerGenerationVectorArtifact,
  queue: QueueArtifact,
  pickupPlan: PickupPlanArtifact,
  env: CustomerGenerationEnvironment,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (artifact.queueHash !== queue.contentHash) errors.push("Customer artifact queue hash does not match the current queue.");
  if (artifact.pickupPlanHash !== pickupPlan.contentHash) errors.push("Customer artifact pickup-plan hash does not match the current plan.");
  if (artifact.vectorHash !== vector.contentHash) errors.push("Customer artifact vector hash does not match the confirmed vector.");
  if (pickupPlan.completion !== "complete") errors.push("Pickup plan is incomplete.");
  const delta = difference(supplyOf(queue), demandOf(artifact.customers, env));
  if (Object.keys(delta.remaining).length > 0) errors.push("Customer demand leaves queue supply unallocated.");
  if (Object.keys(delta.missing).length > 0) errors.push("Customer demand requires supply absent from the queue.");
  if (artifact.customers.length < vector.values.minCustomers || artifact.customers.length > vector.values.maxCustomers) {
    errors.push("Customer count is outside the confirmed vector bounds.");
  }
  for (const customer of artifact.customers) {
    if (customer.dishes.length < vector.values.minDishesPerCustomer || customer.dishes.length > vector.values.maxDishesPerCustomer) {
      errors.push("A customer dish count is outside the confirmed vector bounds.");
      break;
    }
  }
  if (artifact.completion !== "complete") errors.push("Customer artifact is incomplete.");
  return { valid: errors.length === 0, errors };
}
