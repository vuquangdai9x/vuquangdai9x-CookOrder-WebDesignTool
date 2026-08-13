import { describe, expect, it } from "vitest";
import { testMap } from "../core/testFixtures.ts";
import type { CustomerConfig, MapDef, QueueItem } from "../core/types.ts";
import { demandByRaw, rawYieldAmounts, supplyByRaw } from "./recipeDemand.ts";

/** cooked id 2 has no tool recipe in testMap (raw 2 passes straight through). */
const withUsageNum = (usageNum: number): MapDef => ({
  ...testMap,
  cookedIngredients: testMap.cookedIngredients.map((c) => (c.id === 2 ? { ...c, usageNum } : c)),
});

function customer(cookedIds: number[]): CustomerConfig {
  return { typeId: 0, waitTime: 0, weatherEff: 0, dishes: [{ cookedIds, effects: [] }] };
}

const ingredient = (id: number): QueueItem => ({ kind: "ingredient", id, effects: [] });

describe("demandByRaw", () => {
  it("need is a straight occurrence count, unconverted — usageNum only ever affects the 'have' side", () => {
    const demand = demandByRaw(testMap, [customer([2]), customer([2])]);
    expect(demand.get(2)).toEqual({ need: 2, amount: 1, usageNum: 1 });
  });

  it("carries a usageNum-2 ingredient's usageNum through untouched, not folded into need", () => {
    const map = withUsageNum(2);
    // 4 order occurrences — need stays 4; a caller multiplies supply by
    // usageNum on the "have" side to get the 4-vs-available-uses comparison.
    const demand = demandByRaw(map, [customer([2]), customer([2]), customer([2]), customer([2])]);
    expect(demand.get(2)).toEqual({ need: 4, amount: 1, usageNum: 2 });
  });

  it("a usageNum-3 ingredient carries usageNum 3 alongside its raw occurrence count", () => {
    const map = withUsageNum(3);
    const demand = demandByRaw(map, [
      customer([2]), customer([2]), customer([2]), customer([2]), customer([2]),
    ]);
    expect(demand.get(2)).toEqual({ need: 5, amount: 1, usageNum: 3 });
  });

  it("still applies the tool's per-pickup yield alongside usageNum, for a different raw id", () => {
    // cooked id 3 comes from raw 3 via a recipe yielding 2 pieces per pickup,
    // and carries no usageNum override — amount should stay 2, need stays a straight count.
    const demand = demandByRaw(testMap, [customer([3]), customer([3]), customer([3])]);
    expect(demand.get(3)).toEqual({ need: 3, amount: 2, usageNum: 1 });
  });

  it("sums demand across multiple dishes and customers sharing a raw id", () => {
    const demand = demandByRaw(testMap, [
      { typeId: 0, waitTime: 0, weatherEff: 0, dishes: [{ cookedIds: [2, 2], effects: [] }] },
      customer([2]),
    ]);
    expect(demand.get(2)).toEqual({ need: 3, amount: 1, usageNum: 1 });
  });
});

describe("demandByRaw + supplyByRaw combined — the have-vs-need comparison callers actually do", () => {
  const haveVsNeed = (map: MapDef, customers: CustomerConfig[], queues: QueueItem[][], rawId: number) => {
    const info = demandByRaw(map, customers).get(rawId)!;
    const supply = supplyByRaw(queues).get(rawId) ?? 0;
    return { have: supply * info.amount * info.usageNum, need: info.need };
  };

  it("2 orders against a usageNum-2 ingredient with 1 bottle queued reads 2 have / 2 need (balanced)", () => {
    const map = withUsageNum(2);
    const { have, need } = haveVsNeed(
      map,
      [customer([2]), customer([2])],
      [[ingredient(2)]],
      2,
    );
    expect({ have, need }).toEqual({ have: 2, need: 2 });
  });

  it("3 orders against a usageNum-2 ingredient with 2 bottles queued reads 4 have / 3 need (1 use leftover)", () => {
    const map = withUsageNum(2);
    const { have, need } = haveVsNeed(
      map,
      [customer([2]), customer([2]), customer([2])],
      [[ingredient(2), ingredient(2)]],
      2,
    );
    expect(have).toBeGreaterThan(need);
    expect({ have, need }).toEqual({ have: 4, need: 3 });
  });

  it("3 orders against a usageNum-2 ingredient with only 1 bottle queued reads 2 have / 3 need (short)", () => {
    const map = withUsageNum(2);
    const { have, need } = haveVsNeed(
      map,
      [customer([2]), customer([2]), customer([2])],
      [[ingredient(2)]],
      2,
    );
    expect(have).toBeLessThan(need);
    expect({ have, need }).toEqual({ have: 2, need: 3 });
  });
});

describe("supplyByRaw", () => {
  it("counts raw pickups per id across every lane, ignoring non-ingredient items", () => {
    const queues: QueueItem[][] = [
      [ingredient(1), ingredient(1), { kind: "sweeper", id: -1, effects: [] }],
      [ingredient(1), ingredient(2)],
    ];
    const supply = supplyByRaw(queues);
    expect(supply.get(1)).toBe(3);
    expect(supply.get(2)).toBe(1);
    expect(supply.has(-1)).toBe(false);
  });

  it("returns an empty map for empty queues", () => {
    expect(supplyByRaw([]).size).toBe(0);
    expect(supplyByRaw([[], []]).size).toBe(0);
  });
});

describe("rawYieldAmounts", () => {
  it("reports each recipe's raw-id yield, and omits raw ids with no recipe", () => {
    const amounts = rawYieldAmounts(testMap);
    expect(amounts.get(0)).toBe(1);
    expect(amounts.get(1)).toBe(1);
    expect(amounts.get(3)).toBe(2);
    expect(amounts.has(2)).toBe(false); // raw 2 has no tool recipe in testMap
  });
});
