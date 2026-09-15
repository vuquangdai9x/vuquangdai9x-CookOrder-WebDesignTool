import type { GraphIndex } from "../core/nodeIndex.ts";
import type { DishNode } from "../core/nodeParser.ts";
import type { IdIndex } from "../data/nodeIdTable.ts";
import { addToSlot, membersOf, unmetSlotBase } from "../ui/nodedesign/nodeDishEdit.ts";
import { partitionAtomicUnits } from "./amountPlanner.ts";
import type { DraftCustomer, ProposalAction, SessionDraft } from "./types.ts";

export type QueueAmountStyle = "single-unit" | "balanced" | "compact";

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

export function planQueueSupply(
  ix: GraphIndex,
  draft: SessionDraft,
  missing: MissingPickupDemand[],
  input: { laneCount: number; amountStyle: QueueAmountStyle; startingLaneCounter: number; startingSlotCounter: number },
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
  const laneDepths = new Map(draft.lanes.map((lane) => [lane.id, lane.slots.length]));
  plannedLaneIds.forEach((laneId) => { if (!laneDepths.has(laneId)) laneDepths.set(laneId, 0); });
  let laneCursor = 0;
  for (const demand of missing.filter((item) => item.howMany > 0).sort((a, b) => a.dataId - b.dataId)) {
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
    for (const amount of parts) {
      const laneId = plannedLaneIds[laneCursor % plannedLaneIds.length];
      laneCursor++;
      const slotId = `slot-${++slotCounter}`;
      const position = laneDepths.get(laneId) ?? 0;
      laneDepths.set(laneId, position + 1);
      actions.push({
        tool: "add_queue_ingredient",
        arguments: { laneId, position, ingredient: demand.ingredient, count: 1, amount, provisional: false },
        expectedResult: { slotIds: [slotId], expandedUnits: amount },
      });
      plannedSlotIds.push(slotId);
    }
  }
  if (!missing.some((item) => item.howMany > 0)) warnings.push("The candidate already has exact pickup supply; no queue ingredients were proposed.");
  if (input.amountStyle !== "single-unit") warnings.push("Amount slots are bounded by stack range and empty-grid atomic capacity; evaluate exact pick-time capacity after applying.");
  return { actions, expectedSupplyDelta, warnings, plannedLaneIds, plannedSlotIds };
}
