import { describe, expect, it } from "vitest";
import { testMap } from "../core/testFixtures.ts";
import type { CustomerConfig, QueueItem } from "../core/types.ts";
import { demandByRaw, rawYieldAmounts, supplyByRaw } from "./recipeDemand.ts";

function customer(cookedIds: number[]): CustomerConfig {
  return { typeId: 0, waitTime: 0, weatherEff: 0, dishes: [{ cookedIds, effects: [] }] };
}

const ingredient = (id: number, amount = 1): QueueItem => ({
  kind: "ingredient",
  id,
  effects: [],
  ...(amount > 1 ? { amount } : {}),
});

describe("demandByRaw", () => {
  it("counts exact physical dish-piece occurrences", () => {
    const demand = demandByRaw(testMap, [customer([2]), customer([2])]);
    expect(demand.get(2)).toEqual({ need: 2, amount: 1 });
  });

  it("keeps the tool's per-pickup physical yield", () => {
    // cooked id 3 comes from raw 3 via a recipe yielding 2 pieces per pickup,
    // amount should stay 2 while need remains a straight physical-piece count.
    const demand = demandByRaw(testMap, [customer([3]), customer([3]), customer([3])]);
    expect(demand.get(3)).toEqual({ need: 3, amount: 2 });
  });

  it("sums demand across multiple dishes and customers sharing a raw id", () => {
    const demand = demandByRaw(testMap, [
      { typeId: 0, waitTime: 0, weatherEff: 0, dishes: [{ cookedIds: [2, 2], effects: [] }] },
      customer([2]),
    ]);
    expect(demand.get(2)).toEqual({ need: 3, amount: 1 });
  });
});

describe("demandByRaw + supplyByRaw combined — the have-vs-need comparison callers actually do", () => {
  const haveVsNeed = (customers: CustomerConfig[], queues: QueueItem[][], rawId: number) => {
    const info = demandByRaw(testMap, customers).get(rawId)!;
    const supply = supplyByRaw(queues).get(rawId) ?? 0;
    return { have: supply * info.amount, need: info.need };
  };

  it("a two-piece bag balances two physical dish pieces", () => {
    const { have, need } = haveVsNeed(
      [customer([2]), customer([2])],
      [[ingredient(2, 2)]],
      2,
    );
    expect({ have, need }).toEqual({ have: 2, need: 2 });
  });

  it("bag plus plain slot balances three physical dish pieces", () => {
    const { have, need } = haveVsNeed(
      [customer([2]), customer([2]), customer([2])],
      [[ingredient(2, 2), ingredient(2)]],
      2,
    );
    expect({ have, need }).toEqual({ have: 3, need: 3 });
  });

  it("a two-piece bag is short against three physical dish pieces", () => {
    const { have, need } = haveVsNeed(
      [customer([2]), customer([2]), customer([2])],
      [[ingredient(2, 2)]],
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

describe("supplyByRaw counts bag pieces", () => {
  it("a bag slot contributes its whole amount", () => {
    const queues = [[
      { kind: "ingredient" as const, id: 1, effects: [], amount: 3 },
      { kind: "ingredient" as const, id: 1, effects: [] },
      { kind: "sweeper" as const, id: -1, effects: [] },
    ]];
    expect(supplyByRaw(queues).get(1)).toBe(4);
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
