import { describe, expect, it } from "vitest";
import type { GraphIndex } from "../core/nodeIndex.ts";
import type { SessionDraft } from "./types.ts";
import { planQueueSupply } from "./generationService.ts";

const ix = {
  ingByName: new Map([["A", 0], ["B", 1], ["C", 2], ["D", 3]]),
  pickupable: [true, true, true, true],
  stackRange: [{ min: 1, max: 3 }, { min: 1, max: 3 }, { min: 1, max: 3 }, { min: 1, max: 3 }],
  recipeForInput: [undefined, undefined, undefined, undefined],
} as unknown as GraphIndex;

const draft: SessionDraft = {
  level: { id: 10, name: "Test", weather: "Normal", levelTag: "Normal", featureUnlock: "", shuffleDistance: 0, serveableSlots: 2 },
  customers: [],
  lanes: [],
  groups: [],
  grid: Array.from({ length: 10 }, (_, index) => ({ id: `cell-${index}`, x: index % 5, y: Math.floor(index / 5), effects: [] })),
};

const missing = [
  { ingredient: "A", dataId: 0, howMany: 6, missingUsableUnits: 6 },
  { ingredient: "B", dataId: 1, howMany: 6, missingUsableUnits: 6 },
  { ingredient: "C", dataId: 2, howMany: 6, missingUsableUnits: 6 },
  { ingredient: "D", dataId: 3, howMany: 6, missingUsableUnits: 6 },
];

describe("reference-guided queue planning", () => {
  it("uses amounts and avoids sorted ingredient bands", () => {
    const plan = planQueueSupply(ix, draft, missing, {
      laneCount: 3,
      amountStyle: "balanced",
      startingLaneCounter: 0,
      startingSlotCounter: 0,
      deterministicSeed: 42,
      layoutArchetype: "staggered-braid",
    });
    expect(plan.actions.filter((action) => action.tool === "add_queue_ingredient").some((action) => action.arguments.amount > 1)).toBe(true);
    expect(plan.plannedTexture.adjacentDuplicateRatio).toBeLessThan(0.25);
    expect(plan.plannedTexture.crossLaneCloneRatio).toBeLessThan(0.5);
    expect(plan.plannedTexture.compactedUnitRatio).toBeGreaterThan(0);
    expect(Object.values(plan.expectedSupplyDelta).reduce((sum, value) => sum + value, 0)).toBe(24);
  });

  it("is reproducible while different archetypes produce different placements", () => {
    const options = { laneCount: 3, amountStyle: "single-unit" as const, startingLaneCounter: 0, startingSlotCounter: 0, deterministicSeed: 9 };
    const first = planQueueSupply(ix, draft, missing, { ...options, layoutArchetype: "staggered-braid" });
    const again = planQueueSupply(ix, draft, missing, { ...options, layoutArchetype: "staggered-braid" });
    const asymmetric = planQueueSupply(ix, draft, missing, { ...options, layoutArchetype: "asymmetric-lanes" });
    expect(first.actions).toEqual(again.actions);
    expect(first.actions).not.toEqual(asymmetric.actions);
  });
});
