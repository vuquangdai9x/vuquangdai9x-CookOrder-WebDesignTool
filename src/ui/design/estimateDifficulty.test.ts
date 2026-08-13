import { describe, expect, it } from "vitest";
import { MAP1_DATA } from "../../data/configLoader.ts";
import { toMapDef } from "../../data/mapLoader.ts";
import { EMPTY_GRID, level, testMap } from "../../core/testFixtures.ts";
import type { LevelConfig, MapDef } from "../../core/types.ts";
import { cidOf, tagAllNew } from "./changeTracking.ts";
import { estimateDifficulty } from "./estimateDifficulty.ts";

const map1 = toMapDef(MAP1_DATA);

/** Deterministic PRNG so the random-fallback branch never makes a test flaky. */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The solver keys results by `_cid`, which the real draft carries — tests must tag too. */
function tagged(lvl: LevelConfig): LevelConfig {
  for (const lane of lvl.queues) tagAllNew(lane);
  return lvl;
}

const run = (map: MapDef, lvl: LevelConfig) =>
  estimateDifficulty(map, tagged(lvl), { rng: seededRng(7) });

describe("estimateDifficulty", () => {
  it("solves a simple level and numbers picks from 1 with no gaps", () => {
    const result = run(
      testMap,
      level({
        queueString: "0,1%0,1",
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0.1|0;0;0;0.1",
      }),
    );

    expect(result.solvable).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.servedCount).toBe(2);

    const orders = [...result.byCid.values()].map((s) => s.order).sort((a, b) => a - b);
    expect(orders).toEqual([1, 2, 3, 4]);
    expect(result.totalPicks).toBe(4);
  });

  it("attributes each pick to the customer it was made for", () => {
    const result = run(
      testMap,
      level({
        queueString: "0%0",
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0|0;0;0;0",
        serveableSlots: 1,
      }),
    );

    expect(result.solvable).toBe(true);
    const indices = [...result.byCid.values()]
      .sort((a, b) => a.order - b.order)
      .map((s) => s.customerIndex);
    expect(indices).toEqual([0, 1]);
  });

  it("reaches for a base before the topping that depends on it", () => {
    // cooked 1 needs cooked 0 in the dish first. Lane 0 fronts the topping,
    // lane 1 fronts the base — the solver must take the base first or the
    // topping strands on the grid.
    const withBase: MapDef = {
      ...testMap,
      cookedIngredients: testMap.cookedIngredients.map((c) =>
        c.id === 1 ? { ...c, baseId: 0 } : c,
      ),
    };
    const lvl = tagged(
      level({
        queueString: "1%0",
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0.1",
      }),
    );
    const baseCid = cidOf(lvl.queues[1][0])!; // lane 1 fronts raw 0 -> cooked 0, the base
    const toppingCid = cidOf(lvl.queues[0][0])!; // lane 0 fronts raw 1 -> cooked 1, needs the base

    const result = estimateDifficulty(withBase, lvl, { rng: seededRng(7) });

    expect(result.solvable).toBe(true);
    expect(result.byCid.get(baseCid)?.order).toBe(1);
    expect(result.byCid.get(baseCid)?.detour).toBe(false);
    expect(result.byCid.get(toppingCid)!.order).toBeGreaterThan(
      result.byCid.get(baseCid)!.order,
    );
  });

  it("gives every member of a combined group the same pickup number", () => {
    const lvl = level({
      queueString: "0,1%0,1",
      gridString: EMPTY_GRID,
      customerString: "0;0;0;0.0.1.1",
    });
    // One combined block spanning both lanes' front row: a single pick.
    lvl.queueGroups = [{ kind: "combined", cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }];

    const result = run(testMap, lvl);
    const ones = [...result.byCid.values()].filter((s) => s.order === 1);
    expect(ones).toHaveLength(2);
    expect(new Set(ones.map((s) => s.customerIndex)).size).toBe(1);
  });

  it("flags digging picks as detours and counts them as grid waste", () => {
    // The customer only wants cooked 0, but both lanes front an unwanted
    // ingredient with the wanted one buried behind it.
    const result = run(
      testMap,
      level({
        queueString: "1,0%1,0",
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0",
      }),
    );

    const detours = [...result.byCid.values()].filter((s) => s.detour);
    expect(detours.length).toBeGreaterThan(0);
    expect(result.perCustomer[0].detours).toBeGreaterThan(0);
    expect(result.perCustomer[0].gridWaste).toBeGreaterThan(0);
  });

  it("reports a level unsolvable, with a reason, when the grid overflows", () => {
    // 20 unwanted items and a 10-cell grid: the waste has nowhere to go.
    const result = run(
      testMap,
      level({
        queueString: `${Array(20).fill(1).join(",")}%0`,
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0.0.0.0.0.0.0.0.0.0.0.0",
      }),
    );

    expect(result.solvable).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("never stamps two different tiles with the same order unless they were one pick", () => {
    const result = run(
      testMap,
      level({
        queueString: "0,1,3%1,0,3%3,0,1",
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0.1|0;0;0;3.3|0;0;0;0.1.3",
      }),
    );

    const byOrder = new Map<number, number>();
    for (const slot of result.byCid.values()) {
      byOrder.set(slot.order, (byOrder.get(slot.order) ?? 0) + 1);
    }
    // No groups in this level, so every order value belongs to exactly one tile.
    for (const count of byOrder.values()) expect(count).toBe(1);
  });

  it("is deterministic by default, so re-running an unchanged level repeats the verdict", () => {
    // No rng passed — exercises the built-in seeded PRNG, not Math.random.
    const build = () =>
      tagged(
        level({
          queueString: "1,0,1%0,1,0%1,1,0",
          gridString: EMPTY_GRID,
          customerString: "0;0;0;0.1|0;0;0;1.0|0;0;0;0",
        }),
      );

    const a = estimateDifficulty(testMap, build());
    const b = estimateDifficulty(testMap, build());

    expect(b.solvable).toBe(a.solvable);
    expect(b.totalPicks).toBe(a.totalPicks);
    expect(b.servedCount).toBe(a.servedCount);
    expect(b.perCustomer).toEqual(a.perCustomer);
    // Same pick order, tile for tile (cids differ per build, so compare shapes).
    const shape = (r: typeof a) =>
      [...r.byCid.values()].map((s) => `${s.order}:${s.customerIndex}:${s.detour}`).sort();
    expect(shape(b)).toEqual(shape(a));
  });

  it("runs against real Map 1 level data without throwing", () => {
    const result = run(map1, structuredClone(map1.levels[0]));
    expect(result.totalPicks).toBeGreaterThan(0);
    expect(result.totalCustomers).toBe(map1.levels[0].customers.length);
    expect(result.perCustomer.length).toBeGreaterThan(0);
    for (const c of result.perCustomer) {
      expect(c.gridOccupied).toBeGreaterThanOrEqual(0);
      expect(c.gridWaste).toBeGreaterThanOrEqual(0);
    }
  });
});
