import type { LevelBatchMember, LevelBatchRecord } from "./types.ts";

function mixSeed(seed: number, index: number): number {
  let value = (seed + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  value ^= value >>> 16; value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13; value = Math.imul(value, 0xc2b2ae35) >>> 0;
  return (value ^ (value >>> 16)) >>> 0 || 1;
}

function curveValue(range: [number, number] | undefined, index: number, total: number, fallback: number): number {
  if (!range) return fallback;
  if (total <= 1) return Math.max(1, Math.floor(range[0]));
  return Math.max(1, Math.round(range[0] + (range[1] - range[0]) * index / (total - 1)));
}

export function planBatchMembers(batch: LevelBatchRecord): LevelBatchMember[] {
  const count = Math.max(1, Math.min(100, Math.floor(batch.spec.levelCount)));
  const amountCurve = batch.spec.amountUtilizationCurve?.length ? batch.spec.amountUtilizationCurve : ["balanced" as const];
  const difficultyCurve = batch.spec.difficultyCurve?.length ? batch.spec.difficultyCurve : ["standard"];
  return Array.from({ length: count }, (_, index) => ({
    index,
    seed: mixSeed(batch.seed, index),
    customerCount: curveValue(batch.spec.customerRange, index, count, 2),
    dishesPerCustomer: Math.max(1, Math.min(5, Math.floor(batch.spec.dishesPerCustomer ?? 1))),
    laneCount: Math.max(1, Math.min(8, curveValue(batch.spec.laneRange, index, count, 2))),
    amountStyle: amountCurve[index % amountCurve.length],
    difficulty: difficultyCurve[Math.min(difficultyCurve.length - 1, Math.floor(index * difficultyCurve.length / count))],
    sessionId: `${batch.id}-l${String(index + 1).padStart(3, "0")}`.slice(0, 64),
    status: "planned",
  }));
}

export function batchProgress(batch: LevelBatchRecord): Record<string, number> {
  const counts = { planned: 0, running: 0, valid: 0, invalid: 0, error: 0 };
  batch.members.forEach((member) => { counts[member.status]++; });
  return { total: batch.members.length, ...counts, processed: counts.valid + counts.invalid + counts.error };
}
