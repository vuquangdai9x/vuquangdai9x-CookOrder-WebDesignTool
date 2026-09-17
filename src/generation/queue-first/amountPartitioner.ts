import type { GraphIndex } from "../../core/nodeIndex.ts";
import type { QueueGenerationVector } from "./contracts.ts";

export interface AmountSlotDraft {
  ingredient: number;
  amount: number;
}

export interface AmountPartitionResult {
  slots: AmountSlotDraft[];
  histogram: Record<string, number>;
  warnings: string[];
}

function allowedAmounts(min: number, max: number, mode: QueueGenerationVector["amountMode"]): number[] {
  const values = [1, ...Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i)]
    .filter((value, at, all) => all.indexOf(value) === at && value <= max);
  if (mode === "conservative") return values.sort((a, b) => a - b);
  if (mode === "aggressive") return values.sort((a, b) => b - a);
  const midpoint = (min + max) / 2;
  return values.sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint) || b - a);
}

function exactPartition(
  total: number,
  slotCount: number,
  allowed: number[],
): number[] | null {
  if (slotCount < 1 || total < slotCount) return null;
  const previous: Int32Array[] = Array.from(
    { length: slotCount + 1 },
    () => new Int32Array(total + 1).fill(-1),
  );
  previous[0][0] = 0;
  for (let used = 0; used < slotCount; used++) {
    for (let sum = 0; sum <= total; sum++) {
      if (previous[used][sum] === -1) continue;
      for (const amount of allowed) {
        if (sum + amount > total || previous[used + 1][sum + amount] !== -1) continue;
        previous[used + 1][sum + amount] = amount;
      }
    }
  }
  if (previous[slotCount][total] === -1) return null;
  const result: number[] = [];
  let sum = total;
  for (let used = slotCount; used > 0; used--) {
    const amount = previous[used][sum];
    result.push(amount);
    sum -= amount;
  }
  return result.reverse();
}

function preferredSlotCount(
  units: number,
  max: number,
  mode: QueueGenerationVector["amountMode"],
): number {
  if (mode === "conservative") return units;
  if (mode === "aggressive") return Math.ceil(units / max);
  return Math.ceil(units / Math.max(1, Math.round((1 + max) / 2)));
}

function allocateRequestedSlotCounts(
  quotas: Readonly<Record<string, number>>,
  target: number,
  maxByIngredient: Readonly<Record<string, number>>,
): Record<string, number> {
  const ids = Object.keys(quotas).filter((id) => quotas[id] > 0).sort((a, b) => Number(a) - Number(b));
  const minimum = Object.fromEntries(ids.map((id) => [id, Math.ceil(quotas[id] / maxByIngredient[id])]));
  const minTotal = Object.values(minimum).reduce((sum, count) => sum + count, 0);
  const maxTotal = ids.reduce((sum, id) => sum + quotas[id], 0);
  const wanted = Math.max(minTotal, Math.min(maxTotal, Math.round(target)));
  const counts = { ...minimum };
  while (Object.values(counts).reduce((sum, count) => sum + count, 0) < wanted) {
    const next = ids
      .filter((id) => counts[id] < quotas[id])
      .sort((a, b) => {
        const gapA = wanted * quotas[a] / maxTotal - counts[a];
        const gapB = wanted * quotas[b] / maxTotal - counts[b];
        return gapB - gapA || Number(a) - Number(b);
      })[0];
    if (next === undefined) break;
    counts[next]++;
  }
  return counts;
}

export function partitionAmounts(
  quotas: Readonly<Record<string, number>>,
  vector: QueueGenerationVector,
  index: GraphIndex,
): AmountPartitionResult {
  const warnings: string[] = [];
  const ids = Object.keys(quotas).filter((id) => quotas[id] > 0).sort((a, b) => Number(a) - Number(b));
  const ranges = Object.fromEntries(ids.map((id) => {
    const ingredient = Number(id);
    const configured = vector.amountRanges?.[id];
    const graph = index.stackRange[ingredient] ?? { min: 1, max: 1 };
    const min = Math.max(1, Math.floor(configured?.min ?? graph.min));
    const max = Math.max(min, Math.floor(configured?.max ?? graph.max));
    return [id, { min, max }];
  }));
  const maxByIngredient = Object.fromEntries(ids.map((id) => [id, ranges[id].max]));
  const targetSlots = vector.targetQueueSlots
    ?? (vector.targetLaneDepth === undefined ? undefined : vector.targetLaneDepth * vector.laneCount);
  const requestedCounts = targetSlots === undefined
    ? Object.fromEntries(ids.map((id) => [
        id,
        preferredSlotCount(quotas[id], ranges[id].max, vector.amountMode),
      ]))
    : allocateRequestedSlotCounts(quotas, targetSlots, maxByIngredient);

  const slots: AmountSlotDraft[] = [];
  for (const id of ids) {
    const { min, max } = ranges[id];
    const allowed = allowedAmounts(min, max, vector.amountMode);
    const requested = requestedCounts[id];
    let partition = exactPartition(quotas[id], requested, allowed);
    if (!partition) {
      const candidates = Array.from({ length: quotas[id] }, (_, i) => i + 1)
        .sort((a, b) => Math.abs(a - requested) - Math.abs(b - requested) || a - b);
      for (const count of candidates) {
        partition = exactPartition(quotas[id], count, allowed);
        if (partition) {
          warnings.push(
            `Ingredient ${id} uses ${count} slots instead of requested ${requested}; no exact legal amount partition exists at the requested count.`,
          );
          break;
        }
      }
    }
    if (!partition) throw new Error(`Ingredient ${id} cannot be partitioned into legal amounts.`);
    for (const amount of partition) slots.push({ ingredient: Number(id), amount });
  }
  if (targetSlots !== undefined && slots.length !== targetSlots) {
    warnings.push(
      `Queue uses ${slots.length} authored slots; the requested slot target is ${targetSlots}.`,
    );
  }
  const histogram: Record<string, number> = {};
  for (const slot of slots) histogram[String(slot.amount)] = (histogram[String(slot.amount)] ?? 0) + 1;
  return { slots, histogram, warnings };
}
