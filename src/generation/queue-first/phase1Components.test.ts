import { describe, expect, it } from "vitest";

import type { GraphIndex } from "../../core/nodeIndex.ts";
import { partitionAmounts } from "./amountPartitioner.ts";
import type { GroupSizeCoverage, QueueGenerationVector } from "./contracts.ts";
import { placeQueueGroups } from "./groupPlacement.ts";
import { allocateLargestRemainder } from "./quotaAllocator.ts";
import type { LaidOutSlot } from "./queueLayout.ts";

const noCoverage = (): GroupSizeCoverage => ({ 2: 0, 3: 0, 4: 0, 5: 0 });

function vector(): QueueGenerationVector {
  return {
    seed: 1,
    laneCount: 2,
    targetPickupUnits: 7,
    targetQueueSlots: 2,
    ingredientWeights: { 0: 1 },
    amountMode: "balanced",
    texture: {},
    obstacleCoverage: { freeze: 0, hidden: 0, holdingKey: 0 },
    combinedCoverageBySize: noCoverage(),
    linkedCoverageBySize: noCoverage(),
    feasibilityMode: "free",
  };
}

const lanes = (width: number, depth: number): LaidOutSlot[][] =>
  Array.from({ length: width }, (_, x) => Array.from({ length: depth }, (_, y) => ({
    id: `slot-${x}-${y}`,
    ingredient: (x + y) % 3,
    amount: 1,
    effects: [],
  })));

describe("Phase 1 components", () => {
  it("uses largest remainders while preserving the exact requested total", () => {
    const result = allocateLargestRemainder({ 0: 1, 1: 1, 2: 1 }, 10);
    expect(result.quotas).toEqual({ 0: 4, 1: 3, 2: 3 });
    expect(Object.values(result.quotas).reduce((sum, amount) => sum + amount, 0)).toBe(10);
  });

  it("repairs a short amount tail without producing values below stackMin", () => {
    const index = { stackRange: [{ min: 3, max: 5 }] } as GraphIndex;
    const result = partitionAmounts({ 0: 7 }, vector(), index);
    expect(result.slots.map((slot) => slot.amount).sort()).toEqual([3, 4]);
    expect(result.slots.reduce((sum, slot) => sum + slot.amount, 0)).toBe(7);
  });

  it("supports independent combined group sizes two through five", () => {
    for (const size of [2, 3, 4, 5] as const) {
      const coverage = noCoverage();
      coverage[size] = size / 25;
      const result = placeQueueGroups(lanes(5, 5), coverage, noCoverage(), `combined-${size}`, () => 0, () => 0);
      expect(result.groups).toContainEqual(expect.objectContaining({ kind: "combined", slotIds: expect.any(Array) }));
      expect(result.groups[0].slotIds).toHaveLength(size);
      expect(result.combinedCoverage.find((entry) => entry.size === size)?.placedGroups).toBe(1);
    }
  });

  it("supports independent linked group sizes two through five", () => {
    for (const size of [2, 3, 4, 5] as const) {
      const coverage = noCoverage();
      coverage[size] = size / 25;
      const result = placeQueueGroups(lanes(5, 5), noCoverage(), coverage, `linked-${size}`, () => 0, () => 0);
      expect(result.groups).toContainEqual(expect.objectContaining({ kind: "linked", slotIds: expect.any(Array) }));
      expect(result.groups[0].slotIds).toHaveLength(size);
      expect(result.linkedCoverage.find((entry) => entry.size === size)?.placedGroups).toBe(1);
    }
  });

  it("allows linked members at different depths while keeping adjacent columns", () => {
    const coverage = noCoverage();
    coverage[3] = 3 / 9;
    const result = placeQueueGroups(lanes(3, 3), noCoverage(), coverage, "linked-cross-row", () => 0, () => 0);
    const group = result.groups.find((entry) => entry.kind === "linked");
    expect(group).toBeDefined();
    const coordinates = group!.slotIds.map((id) => id.split("-").slice(1).map(Number));
    expect(coordinates.map(([x]) => x)).toEqual([0, 1, 2]);
    expect(new Set(coordinates.map(([, y]) => y)).size).toBeGreaterThan(1);
  });
});
