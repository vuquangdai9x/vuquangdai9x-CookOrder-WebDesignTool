import type { GraphIndex } from "../core/nodeIndex.ts";
import type { DraftQueueSlot, ProposalAction, SessionDraft } from "./types.ts";

export type AmountPlanStyle = "conservative" | "balanced" | "aggressive";

export interface AmountSlotAnalysis {
  slotId: string;
  laneId: string;
  queue: number;
  line: number;
  ingredient: string;
  amount: number;
  expandedItems: number;
  theoreticalDirectToTool: number;
  conservativeGridDestinations: number;
  bestCaseGridDestinations: number;
  stackRange: { min: number; max: number };
  withinStackRange: boolean;
  capacitySafeOnEmptyGrid: boolean;
  multipleUsage: boolean;
  groupIds: string[];
  hasEffects: boolean;
}

function slotAmount(slot: DraftQueueSlot): number {
  return Math.max(1, Math.floor(slot.amount ?? 1));
}

export function analyzeAmounts(ix: GraphIndex, draft: SessionDraft): { summary: Record<string, number>; slots: AmountSlotAnalysis[]; warnings: string[] } {
  const groupIds = new Map<string, string[]>();
  for (const group of draft.groups) for (const slotId of group.slotIds) groupIds.set(slotId, [...(groupIds.get(slotId) ?? []), group.id]);
  const usableGridCells = draft.grid.filter((cell) => !cell.effects.some((effect) => effect.effectId === 1)).length;
  const slots = draft.lanes.flatMap((lane, laneIndex) => lane.slots.map((slot, lineIndex): AmountSlotAnalysis => {
    const dense = ix.ingByName.get(slot.ingredient) ?? -1;
    const stackRange = ix.stackRange[dense] ?? { min: 1, max: 1 };
    const amount = slotAmount(slot);
    const canEnterTool = dense >= 0 && Boolean(ix.recipeForInput[dense]);
    const bestCaseGridDestinations = Math.max(0, amount - (canEnterTool ? 1 : 0));
    return {
      slotId: slot.id,
      laneId: lane.id,
      queue: laneIndex + 1,
      line: lineIndex + 1,
      ingredient: slot.ingredient,
      amount,
      expandedItems: amount,
      theoreticalDirectToTool: canEnterTool ? 1 : 0,
      conservativeGridDestinations: amount,
      bestCaseGridDestinations,
      stackRange,
      withinStackRange: amount === 1 || (amount >= stackRange.min && amount <= stackRange.max),
      capacitySafeOnEmptyGrid: bestCaseGridDestinations <= usableGridCells,
      multipleUsage: dense >= 0 && Boolean(ix.multipleUsage[dense]),
      groupIds: groupIds.get(slot.id) ?? [],
      hasEffects: slot.effects.length > 0,
    };
  }));
  const totalUnits = slots.reduce((sum, slot) => sum + slot.amount, 0);
  const amountSlots = slots.filter((slot) => slot.amount > 1);
  const warnings: string[] = [];
  for (const slot of slots) {
    if (!slot.withinStackRange) warnings.push(`${slot.slotId} amount ${slot.amount} is outside stack range ${slot.stackRange.min}-${slot.stackRange.max}.`);
    if (!slot.capacitySafeOnEmptyGrid) warnings.push(`${slot.slotId} cannot dispatch even against an otherwise empty ${usableGridCells}-cell usable grid in its best direct-to-tool case.`);
  }
  return {
    summary: {
      authoredSlots: slots.length,
      expandedItems: totalUnits,
      amountSlots: amountSlots.length,
      compactedLines: Math.max(0, totalUnits - slots.length),
      compactedUnitRatio: totalUnits ? amountSlots.reduce((sum, slot) => sum + slot.amount, 0) / totalUnits : 0,
      maxAmount: Math.max(1, ...slots.map((slot) => slot.amount)),
      maxBestCaseGridBurst: Math.max(0, ...slots.map((slot) => slot.bestCaseGridDestinations)),
      usableGridCells,
    },
    slots,
    warnings,
  };
}

function targetFor(style: AmountPlanStyle, range: { min: number; max: number }, usableGridCells: number): number {
  const capacityLimit = Math.max(1, usableGridCells + 1);
  const legalMax = Math.max(1, Math.min(range.max, capacityLimit));
  if (style === "conservative") return Math.max(2, Math.min(legalMax, range.min));
  if (style === "balanced") return Math.max(2, Math.min(legalMax, Math.floor((Math.max(1, range.min) + legalMax) / 2)));
  return Math.max(2, legalMax);
}

export function planAmountCompression(ix: GraphIndex, draft: SessionDraft, style: AmountPlanStyle): { actions: ProposalAction[]; warnings: string[]; expectedCompactedLines: number; expectedMaxAmount: number } {
  const analysis = analyzeAmounts(ix, draft);
  const usableGridCells = analysis.summary.usableGridCells;
  const grouped = new Set(draft.groups.flatMap((group) => group.slotIds));
  const actions: ProposalAction[] = [];
  const warnings: string[] = [];
  let expectedMaxAmount = analysis.summary.maxAmount;
  for (const lane of draft.lanes) {
    let at = 0;
    while (at < lane.slots.length) {
      const first = lane.slots[at];
      if (first.effects.length || grouped.has(first.id)) { at++; continue; }
      const dense = ix.ingByName.get(first.ingredient) ?? -1;
      const range = ix.stackRange[dense] ?? { min: 1, max: 1 };
      const target = targetFor(style, range, usableGridCells);
      const run: DraftQueueSlot[] = [];
      let cursor = at;
      while (cursor < lane.slots.length) {
        const slot = lane.slots[cursor];
        if (slot.ingredientId !== first.ingredientId || slot.effects.length || grouped.has(slot.id)) break;
        run.push(slot); cursor++;
      }
      let chunk: DraftQueueSlot[] = [];
      let amount = 0;
      const flush = (): void => {
        if (chunk.length > 1 && amount >= Math.max(2, range.min) && amount <= range.max && amount <= usableGridCells + 1) {
          actions.push({ tool: "merge_queue_slots", arguments: { slotIds: chunk.map((slot) => slot.id) }, expectedResult: { keptSlotId: chunk[0].id, amount, removedSlotIds: chunk.slice(1).map((slot) => slot.id) } });
          expectedMaxAmount = Math.max(expectedMaxAmount, amount);
        }
        chunk = []; amount = 0;
      };
      for (const slot of run) {
        const next = slotAmount(slot);
        if (next > target || amount + next > target) flush();
        chunk.push(slot); amount += next;
      }
      flush();
      at = Math.max(cursor, at + 1);
    }
  }
  if (!actions.length) warnings.push("No consecutive, ungrouped, effect-free same-ingredient slots can be safely compressed for this style.");
  if (draft.groups.length) warnings.push("Grouped slots were left unchanged because merging would alter linked/combined timing.");
  if (draft.lanes.some((lane) => lane.slots.some((slot) => slot.effects.length))) warnings.push("Slots with effects were left unchanged because merging would collapse effect timing.");
  return {
    actions,
    warnings,
    expectedCompactedLines: actions.reduce((sum, action) => sum + (action.tool === "merge_queue_slots" ? action.expectedResult.removedSlotIds.length : 0), 0),
    expectedMaxAmount,
  };
}

export function partitionAtomicUnits(total: number, maximum: number, minimum: number): number[] {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeMaximum = Math.max(1, Math.floor(maximum));
  const safeMinimum = Math.max(1, Math.min(safeMaximum, Math.floor(minimum)));
  if (safeTotal === 0) return [];
  if (safeTotal <= safeMaximum) {
    if (safeTotal === 1 || safeTotal >= safeMinimum) return [safeTotal];
    return Array.from({ length: safeTotal }, () => 1);
  }
  const compactPartCount = Math.ceil(safeTotal / safeMaximum);
  if (safeTotal >= compactPartCount * safeMinimum) {
    const compact: number[] = [];
    let compactRemaining = safeTotal;
    for (let index = 0; index < compactPartCount; index++) {
      const slotsAfter = compactPartCount - index - 1;
      const part = Math.min(safeMaximum, compactRemaining - slotsAfter * safeMinimum);
      compact.push(part);
      compactRemaining -= part;
    }
    return compact;
  }
  const parts: number[] = [];
  let remaining = safeTotal;
  while (remaining > safeMaximum) { parts.push(safeMaximum); remaining -= safeMaximum; }
  if (remaining === 0) return parts;
  if (remaining === 1 || remaining >= safeMinimum) { parts.push(remaining); return parts; }
  while (remaining > 0) { parts.push(1); remaining--; }
  return parts;
}

export function planAmountRepairs(ix: GraphIndex, draft: SessionDraft, startingSlotCounter: number): { actions: ProposalAction[]; warnings: string[]; repairedSlotIds: string[] } {
  const analysis = analyzeAmounts(ix, draft);
  const byId = new Map(analysis.slots.map((slot) => [slot.slotId, slot]));
  const actions: ProposalAction[] = [];
  const warnings: string[] = [];
  const repairedSlotIds: string[] = [];
  let nextSlotCounter = startingSlotCounter;
  for (const lane of draft.lanes) for (const slot of lane.slots) {
    const info = byId.get(slot.id);
    if (!info || info.amount <= 1 || (info.withinStackRange && info.capacitySafeOnEmptyGrid)) continue;
    if (info.groupIds.length || info.hasEffects) {
      warnings.push(`${slot.id} needs splitting but was skipped because its group/effect timing requires an explicit designer choice.`);
      continue;
    }
    const capacityMaximum = Math.max(1, analysis.summary.usableGridCells + info.theoreticalDirectToTool);
    const maximum = Math.max(1, Math.min(info.stackRange.max, capacityMaximum));
    const parts = partitionAtomicUnits(info.amount, maximum, Math.max(1, info.stackRange.min));
    if (parts.length <= 1) continue;
    repairedSlotIds.push(slot.id);
    let currentSlotId = slot.id;
    let remaining = info.amount;
    for (let index = 0; index < parts.length - 1; index++) {
      const keepAmount = parts[index];
      remaining -= keepAmount;
      const remainderSlotId = `slot-${++nextSlotCounter}`;
      actions.push({
        tool: "split_queue_slot",
        arguments: { slotId: currentSlotId, keepAmount },
        expectedResult: { keptSlotId: currentSlotId, keptAmount: keepAmount, remainderSlotId, remainderAmount: remaining },
      });
      currentSlotId = remainderSlotId;
    }
  }
  if (!actions.length && !warnings.length) warnings.push("No amount slot currently needs an empty-grid capacity or stack-range repair.");
  return { actions, warnings, repairedSlotIds };
}
