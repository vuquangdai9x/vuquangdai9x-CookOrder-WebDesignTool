import type { GraphIndex } from "../core/nodeIndex.ts";
import type { DishNode } from "../core/nodeParser.ts";
import type { IdIndex } from "../data/nodeIdTable.ts";
import { addToSlot, membersOf, unmetSlotBase } from "../ui/nodedesign/nodeDishEdit.ts";
import { partitionAtomicUnits } from "./amountPlanner.ts";
import { analyzeQueueTexture, type QueueTextureMetrics, type QueueTextureSlot } from "./queueTexture.ts";
import type { DraftCustomer, ProposalAction, SessionDraft } from "./types.ts";

export type QueueAmountStyle = "single-unit" | "balanced" | "compact";
export type QueueLayoutArchetype = "staggered-braid" | "wave-echo" | "asymmetric-lanes";

export interface MissingPickupDemand {
  ingredient: string;
  dataId: number;
  howMany: number;
  missingUsableUnits: number;
}

export interface QueuePlanResult {
  actions: ProposalAction[];
  expectedSupplyDelta: Record<string, number>;
  warnings: string[];
  plannedLaneIds: string[];
  plannedSlotIds: string[];
  layoutArchetype: QueueLayoutArchetype;
  deterministicSeed: number;
  plannedTexture: QueueTextureMetrics;
}

export interface SkeletonPlanResult {
  actions: ProposalAction[];
  warnings: string[];
  plannedCustomerIds: string[];
  plannedDishIds: string[];
  selectedComposites: string[];
}

function pieceActions(
  ix: GraphIndex,
  ids: IdIndex,
  dishId: string,
  composite: number,
  compositeDataId: number,
  seed: number,
): { actions: ProposalAction[]; warning?: string } {
  const root: DishNode = { kind: "composite", id: compositeDataId, members: [] };
  const slots = ix.slotsOfComposite[composite] ?? [];
  const actions: ProposalAction[] = [];
  let progress = true;
  let pass = 0;
  while (progress && pass++ <= slots.length + 1) {
    progress = false;
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
      const slot = slots[slotIndex];
      const target = Math.max(0, slot.minQuantity);
      while (membersOf(ix, ids, root, composite, slotIndex).length < target && unmetSlotBase(ix, ids, root, composite, slotIndex) < 0) {
        if (!slot.options.length) break;
        const before = membersOf(ix, ids, root, composite, slotIndex).length;
        const option = slot.options[(seed + slotIndex + before) % slot.options.length];
        addToSlot(ix, ids, root, composite, slotIndex, option);
        const selectedCount = membersOf(ix, ids, root, composite, slotIndex).length;
        if (selectedCount <= before) break;
        actions.push({ tool: "add_dish_piece", arguments: { dishId, slotIndex, ingredient: ix.ingName[option] }, expectedResult: { dishId, selectedCount } });
        progress = true;
      }
    }
  }
  if (!actions.length) {
    const slotIndex = slots.findIndex((slot, index) => slot.options.length > 0 && unmetSlotBase(ix, ids, root, composite, index) < 0);
    if (slotIndex >= 0) {
      const option = slots[slotIndex].options[seed % slots[slotIndex].options.length];
      addToSlot(ix, ids, root, composite, slotIndex, option);
      const selectedCount = membersOf(ix, ids, root, composite, slotIndex).length;
      if (selectedCount > 0) actions.push({ tool: "add_dish_piece", arguments: { dishId, slotIndex, ingredient: ix.ingName[option] }, expectedResult: { dishId, selectedCount } });
    }
  }
  const unresolved = slots.filter((slot, slotIndex) => membersOf(ix, ids, root, composite, slotIndex).length < Math.max(0, slot.minQuantity));
  return { actions, ...(unresolved.length ? { warning: `${dishId} could not automatically satisfy ${unresolved.length} required graph slot(s). Inspect it before applying.` } : {}) };
}

export function planCustomerDishSkeleton(
  ix: GraphIndex,
  ids: IdIndex,
  draft: SessionDraft,
  input: {
    customerCount: number;
    dishesPerCustomer: number;
    composites?: string[];
    startingCustomerCounter: number;
    startingDishCounter: number;
    deterministicSeed: number;
  },
): SkeletonPlanResult {
  const actions: ProposalAction[] = [];
  const warnings: string[] = [];
  const plannedCustomerIds = draft.customers.map((customer) => customer.id);
  const virtualCustomers: Array<Pick<DraftCustomer, "id"> & { dishCount: number }> = draft.customers.map((customer) => ({ id: customer.id, dishCount: customer.dishes.length }));
  let customerCounter = input.startingCustomerCounter;
  let dishCounter = input.startingDishCounter;
  const customerCount = Math.max(1, Math.min(100, Math.floor(input.customerCount)));
  const dishesPerCustomer = Math.max(1, Math.min(5, Math.floor(input.dishesPerCustomer)));
  while (virtualCustomers.length < customerCount) {
    const customerId = `customer-${++customerCounter}`;
    const position = virtualCustomers.length;
    actions.push({ tool: "add_customer", arguments: { typeId: 0, waitTime: 0, weatherEff: 0, position }, expectedResult: { customerId } });
    virtualCustomers.push({ id: customerId, dishCount: 0 });
    plannedCustomerIds.push(customerId);
  }
  if (virtualCustomers.length > customerCount) warnings.push(`The candidate already has ${virtualCustomers.length} customers, above the requested ${customerCount}; no customer was removed.`);
  const requestedComposites = (input.composites ?? []).map((name) => ix.compositeByName.get(name)).filter((value): value is number => value !== undefined && ix.orderables.includes(value));
  const composites = requestedComposites.length ? requestedComposites : ix.orderables;
  if (!composites.length) return { actions, warnings: [...warnings, "The map has no orderable composite for dish generation."], plannedCustomerIds, plannedDishIds: [], selectedComposites: [] };
  const plannedDishIds: string[] = [];
  const selectedComposites: string[] = [];
  for (let customerIndex = 0; customerIndex < Math.min(customerCount, virtualCustomers.length); customerIndex++) {
    const customer = virtualCustomers[customerIndex];
    while (customer.dishCount < dishesPerCustomer) {
      const dishId = `dish-${++dishCounter}`;
      const composite = composites[(input.deterministicSeed + customerIndex + customer.dishCount) % composites.length];
      const compositeName = ix.compositeName[composite];
      const compositeDataId = ids.byNode.composite.get(compositeName);
      if (compositeDataId === undefined) { warnings.push(`Skipped unknown composite id for ${compositeName}.`); break; }
      actions.push({ tool: "add_dish", arguments: { customerId: customer.id, composite: compositeName }, expectedResult: { dishId } });
      const pieces = pieceActions(ix, ids, dishId, composite, compositeDataId, input.deterministicSeed + plannedDishIds.length);
      actions.push(...pieces.actions);
      if (pieces.warning) warnings.push(pieces.warning);
      customer.dishCount++;
      plannedDishIds.push(dishId);
      selectedComposites.push(compositeName);
    }
  }
  return { actions, warnings, plannedCustomerIds, plannedDishIds, selectedComposites };
}

function amountMaximum(style: QueueAmountStyle, stackRange: { min: number; max: number }, atomicCapacity: number): number {
  if (style === "single-unit") return 1;
  const legalMaximum = Math.max(1, Math.min(stackRange.max, atomicCapacity));
  if (style === "compact") return legalMaximum;
  return Math.max(1, Math.min(legalMaximum, Math.floor((Math.max(1, stackRange.min) + legalMaximum) / 2)));
}

interface PlannedChunk extends QueueTextureSlot {
  ingredientName: string;
}

function seededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function preferredLaneOrder(step: number, laneCount: number, archetype: QueueLayoutArchetype, seed: number): number[] {
  const lanes = Array.from({ length: laneCount }, (_, index) => index);
  if (archetype === "wave-echo" && Math.floor(step / laneCount) % 2 === 1) lanes.reverse();
  if (archetype === "asymmetric-lanes") {
    lanes.sort((left, right) => ((left * 1103515245 + seed) >>> 0) - ((right * 1103515245 + seed) >>> 0));
  }
  const rotation = archetype === "staggered-braid" ? Math.floor(step / laneCount) % laneCount : 0;
  return [...lanes.slice(rotation), ...lanes.slice(0, rotation)];
}

function arrangeChunks(
  existing: QueueTextureSlot[][],
  chunks: PlannedChunk[],
  archetype: QueueLayoutArchetype,
  seed: number,
): { lanes: QueueTextureSlot[][]; placements: Array<{ laneIndex: number; chunk: PlannedChunk }> } {
  const lanes = existing.map((lane) => [...lane]);
  const remaining = [...chunks];
  const placements: Array<{ laneIndex: number; chunk: PlannedChunk }> = [];
  const transitions = new Map<string, number>();
  lanes.forEach((lane) => lane.slice(1).forEach((slot, index) => {
    const key = `${lane[index].ingredient}>${slot.ingredient}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
  }));
  const random = seededRandom(seed);
  let step = 0;
  while (remaining.length) {
    const minimumDepth = Math.min(...lanes.map((lane) => lane.length));
    const allowedImbalance = archetype === "asymmetric-lanes" ? 1 : 0;
    const eligible = new Set(lanes
      .map((lane, index) => ({ lane, index }))
      .filter(({ lane }) => lane.length <= minimumDepth + allowedImbalance)
      .map(({ index }) => index));
    const laneIndex = preferredLaneOrder(step, lanes.length, archetype, seed).find((index) => eligible.has(index)) ?? 0;
    const lane = lanes[laneIndex];
    const depth = lane.length;
    const previous = lane.at(-1)?.ingredient;
    let bestIndex = 0;
    let bestScore = Infinity;
    for (let index = 0; index < remaining.length; index++) {
      const chunk = remaining[index];
      const sameAdjacent = previous === chunk.ingredient ? 1 : 0;
      const sameDepth = lanes.reduce((count, other, otherIndex) =>
        count + (otherIndex !== laneIndex && other[depth]?.ingredient === chunk.ingredient ? 1 : 0), 0);
      const transitionRepeats = previous ? transitions.get(`${previous}>${chunk.ingredient}`) ?? 0 : 0;
      const echo = archetype === "wave-echo" && lane[depth - 2]?.ingredient === chunk.ingredient ? -4 : 0;
      const score = sameAdjacent * 100 + sameDepth * 70 + transitionRepeats * 6 + echo + random();
      if (score < bestScore) { bestScore = score; bestIndex = index; }
    }
    const [chunk] = remaining.splice(bestIndex, 1);
    if (previous) transitions.set(`${previous}>${chunk.ingredient}`, (transitions.get(`${previous}>${chunk.ingredient}`) ?? 0) + 1);
    lane.push({ ingredient: chunk.ingredient, amount: chunk.amount });
    placements.push({ laneIndex, chunk });
    step++;
  }
  return { lanes, placements };
}

export function planQueueSupply(
  ix: GraphIndex,
  draft: SessionDraft,
  missing: MissingPickupDemand[],
  input: {
    laneCount: number;
    amountStyle: QueueAmountStyle;
    startingLaneCounter: number;
    startingSlotCounter: number;
    deterministicSeed?: number;
    layoutArchetype?: QueueLayoutArchetype;
  },
): QueuePlanResult {
  const actions: ProposalAction[] = [];
  const warnings: string[] = [];
  const expectedSupplyDelta: Record<string, number> = {};
  const plannedLaneIds = draft.lanes.map((lane) => lane.id);
  const plannedSlotIds: string[] = [];
  let laneCounter = input.startingLaneCounter;
  let slotCounter = input.startingSlotCounter;
  const requestedLanes = Math.max(1, Math.min(8, Math.floor(input.laneCount)));
  while (plannedLaneIds.length < requestedLanes) {
    const laneId = `lane-${++laneCounter}`;
    actions.push({ tool: "add_queue_lane", arguments: { position: plannedLaneIds.length }, expectedResult: { laneId } });
    plannedLaneIds.push(laneId);
  }
  const usableGridCells = draft.grid.filter((cell) => !cell.effects.some((effect) => effect.effectId === 1)).length;
  const deterministicSeed = Math.max(0, Math.floor(input.deterministicSeed ?? 0x51a71)) >>> 0;
  const layoutArchetype = input.layoutArchetype ?? "staggered-braid";
  const chunks: PlannedChunk[] = [];
  for (const demand of missing.filter((item) => item.howMany > 0)) {
    const dense = ix.ingByName.get(demand.ingredient);
    if (dense === undefined || !ix.pickupable[dense]) {
      warnings.push(`${demand.ingredient} was skipped because it is not a pickupable graph ingredient.`);
      continue;
    }
    const stackRange = ix.stackRange[dense] ?? { min: 1, max: 1 };
    const canEnterTool = Boolean(ix.recipeForInput[dense]);
    const atomicCapacity = Math.max(1, usableGridCells + (canEnterTool ? 1 : 0));
    const maximum = amountMaximum(input.amountStyle, stackRange, atomicCapacity);
    const parts = input.amountStyle === "single-unit"
      ? Array.from({ length: demand.howMany }, () => 1)
      : partitionAtomicUnits(demand.howMany, maximum, stackRange.min);
    expectedSupplyDelta[demand.ingredient] = demand.howMany;
    parts.forEach((part) => chunks.push({ ingredient: String(demand.dataId), ingredientName: demand.ingredient, amount: part }));
  }
  const existing: QueueTextureSlot[][] = plannedLaneIds.map((laneId) => {
    const lane = draft.lanes.find((candidate) => candidate.id === laneId);
    return lane?.slots.map((slot) => ({ ingredient: String(slot.ingredientId), amount: Math.max(1, slot.amount ?? 1) })) ?? [];
  });
  const arranged = arrangeChunks(existing, chunks, layoutArchetype, deterministicSeed);
  const laneDepths = plannedLaneIds.map((laneId) => draft.lanes.find((lane) => lane.id === laneId)?.slots.length ?? 0);
  for (const placement of arranged.placements) {
      const laneId = plannedLaneIds[placement.laneIndex];
      const { chunk } = placement;
      const slotId = `slot-${++slotCounter}`;
      const position = laneDepths[placement.laneIndex]++;
      actions.push({
        tool: "add_queue_ingredient",
        arguments: { laneId, position, ingredient: chunk.ingredientName, count: 1, amount: chunk.amount, provisional: false },
        expectedResult: { slotIds: [slotId], expandedUnits: chunk.amount },
      });
      plannedSlotIds.push(slotId);
  }
  if (!missing.some((item) => item.howMany > 0)) warnings.push("The candidate already has exact pickup supply; no queue ingredients were proposed.");
  if (input.amountStyle !== "single-unit") warnings.push("Amount slots are bounded by stack range and empty-grid atomic capacity; evaluate exact pick-time capacity after applying.");
  warnings.push(`Queue layout uses the seeded ${layoutArchetype} arranger; compare texture and simulation evidence before applying.`);
  return {
    actions,
    expectedSupplyDelta,
    warnings,
    plannedLaneIds,
    plannedSlotIds,
    layoutArchetype,
    deterministicSeed,
    plannedTexture: analyzeQueueTexture(arranged.lanes),
  };
}
