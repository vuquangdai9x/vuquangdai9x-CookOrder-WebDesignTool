import { queueItemAmount } from "../../core/parser.ts";
import type { Id, QueueItem, QueueGroupKind } from "../../core/types.ts";
import { cidOf } from "./changeTracking.ts";

export type QueueCompactCapping = "random" | "max" | "all";
export type QueueCompactScope = "nearby" | "all-in-lane";
export type QueueCompactEffects = "keep" | "break";

export interface QueueCompactOptions {
  capping: QueueCompactCapping;
  scope: QueueCompactScope;
  effects: QueueCompactEffects;
}

export interface CompactWorkingGroup {
  kind: QueueGroupKind;
  cids: string[];
}

export interface CompactQueueDraft {
  queues: QueueItem[][];
  groups: CompactWorkingGroup[];
}

export interface QueueCompactDeps {
  stackRange?(id: Id): { min: number; max: number } | undefined;
  random?: () => number;
}

export interface QueueCompactResult {
  before: number;
  after: number;
  removed: number;
  mergedBags: number;
}

function setAmount(item: QueueItem, amount: number): void {
  const value = Math.max(1, Math.floor(amount) || 1);
  if (value > 1 && item.kind === "ingredient") item.amount = value;
  else delete item.amount;
}

function randomInt(min: number, max: number, random: () => number): number {
  const unit = Math.min(0.9999999999999999, Math.max(0, random()));
  return min + Math.floor(unit * (max - min + 1));
}

function bagLimit(id: Id, options: QueueCompactOptions, deps: QueueCompactDeps): number {
  if (options.capping === "all") return Number.POSITIVE_INFINITY;
  const configured = deps.stackRange?.(id) ?? { min: 1, max: 1 };
  const min = Math.max(1, Math.floor(configured.min) || 1);
  const max = Math.max(min, Math.floor(configured.max) || 1);
  return options.capping === "max" ? max : randomInt(min, max, deps.random ?? Math.random);
}

/** Partitions slots into exact batches the existing Merge action could select. */
function mergePartitions(items: QueueItem[], options: QueueCompactOptions, deps: QueueCompactDeps): QueueItem[][] {
  if (items.length < 2) return items.map((item) => [item]);
  if (options.capping === "all") return [items];

  const partitions: QueueItem[][] = [];
  let current: QueueItem[] = [];
  let amount = 0;
  let limit = bagLimit(items[0].id, options, deps);
  for (const item of items) {
    const nextAmount = queueItemAmount(item);
    if (current.length > 0 && amount + nextAmount > limit) {
      partitions.push(current);
      current = [];
      amount = 0;
      limit = bagLimit(item.id, options, deps);
    }
    current.push(item);
    amount += nextAmount;
    if (amount >= limit) {
      partitions.push(current);
      current = [];
      amount = 0;
      limit = bagLimit(item.id, options, deps);
    }
  }
  if (current.length) partitions.push(current);
  return partitions;
}

function compactCandidate(
  items: QueueItem[],
  options: QueueCompactOptions,
  deps: QueueCompactDeps,
  removed: Set<QueueItem>,
): number {
  let mergedBags = 0;
  for (const partition of mergePartitions(items, options, deps)) {
    if (partition.length < 2) continue;
    const [first, ...rest] = partition;
    setAmount(first, partition.reduce((sum, item) => sum + queueItemAmount(item), 0));
    if (options.effects === "break") first.effects = [];
    rest.forEach((item) => removed.add(item));
    mergedBags++;
  }
  return mergedBags;
}

function candidatesInLane(lane: QueueItem[], options: QueueCompactOptions): QueueItem[][] {
  const canMerge = (item: QueueItem): boolean =>
    item.kind === "ingredient" && (options.effects === "break" || item.effects.length === 0);

  if (options.scope === "all-in-lane") {
    const byIngredient = new Map<Id, QueueItem[]>();
    for (const item of lane) {
      if (!canMerge(item)) continue;
      const group = byIngredient.get(item.id) ?? [];
      group.push(item);
      byIngredient.set(item.id, group);
    }
    return [...byIngredient.values()];
  }

  const runs: QueueItem[][] = [];
  let run: QueueItem[] = [];
  for (const item of lane) {
    if (!canMerge(item) || (run.length > 0 && run[0].id !== item.id)) {
      if (run.length) runs.push(run);
      run = [];
    }
    if (canMerge(item)) run.push(item);
  }
  if (run.length) runs.push(run);
  return runs;
}

/** Applies queue compaction in place and returns history-counter metadata. */
export function compactQueueDraft(
  draft: CompactQueueDraft,
  options: QueueCompactOptions,
  deps: QueueCompactDeps = {},
): QueueCompactResult {
  const before = draft.queues.reduce((sum, lane) => sum + lane.length, 0);
  const removedItems = new Set<QueueItem>();
  let mergedBags = 0;
  for (const lane of draft.queues) {
    for (const candidate of candidatesInLane(lane, options)) {
      mergedBags += compactCandidate(candidate, options, deps, removedItems);
    }
  }

  const removedCids = new Set<string>();
  for (const item of removedItems) {
    const cid = cidOf(item);
    if (cid) removedCids.add(cid);
  }
  for (const lane of draft.queues) {
    for (let i = lane.length - 1; i >= 0; i--) {
      if (removedItems.has(lane[i])) lane.splice(i, 1);
    }
  }

  const liveCids = new Set<string>();
  for (const lane of draft.queues) {
    for (const item of lane) {
      const cid = cidOf(item);
      if (cid) liveCids.add(cid);
    }
  }
  draft.groups = draft.groups
    .filter((group) => !group.cids.some((cid) => removedCids.has(cid)))
    .map((group) => ({ ...group, cids: group.cids.filter((cid) => liveCids.has(cid)) }))
    .filter((group) => group.cids.length >= 2);

  const after = before - removedItems.size;
  return { before, after, removed: removedItems.size, mergedBags };
}
