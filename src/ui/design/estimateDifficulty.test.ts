import { describe, expect, it } from "vitest";
import { MAP1_DATA } from "../../data/configLoader.ts";
import { toMapDef } from "../../data/mapLoader.ts";
import { EMPTY_GRID, level, testMap } from "../../core/testFixtures.ts";
import type { LevelConfig, MapDef } from "../../core/types.ts";
import { cidOf, tagAllNew } from "./changeTracking.ts";
import type { CustomerCost } from "./estimateDifficulty.ts";
import { difficultyColor, difficultyRatio, estimateDifficulty } from "./estimateDifficulty.ts";

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

  it("records one occupancy sample per pick, and reports the board's total cell count as capacity", () => {
    const result = run(
      testMap,
      level({
        queueString: "0,1%0,1",
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0.1|0;0;0;0.1",
      }),
    );

    expect(result.occupancyHistory).toHaveLength(result.totalPicks);
    expect(result.gridCapacity).toBe(testMap.gridWidth * testMap.gridHeight);
    for (const sample of result.occupancyHistory) {
      expect(sample.occupied).toBeGreaterThanOrEqual(0);
      expect(sample.occupied).toBeLessThanOrEqual(result.gridCapacity);
      expect(sample.dirty).toBeGreaterThanOrEqual(0);
      expect(sample.dirty).toBeLessThanOrEqual(sample.occupied); // dirty stacks are a subset of occupied cells
    }
  });

  it("occupancy climbs while a topping waits on the grid for its buried base, then the dirty dish takes its place", () => {
    // cooked 1 needs cooked 0 (its base) already in the dish. Lane 0 fronts
    // the topping with nothing else behind it; lane 1 buries the base two
    // rows deep behind two irrelevant filler raws (cooked 2, which nothing
    // orders). The topping can't direct-serve without its base, so it lands
    // and waits; the fillers land too (nobody wants cooked 2 — pure waste)
    // as the solver digs toward the base. Once the base surfaces it
    // direct-serves, and the landed topping is served right behind it —
    // occupied climbs to 3 (topping + 2 filler waste) and stays there (the
    // topping's cell becomes the dirty dish it leaves behind), but only the
    // final sample shows that dirty dish.
    const withBase: MapDef = {
      ...testMap,
      cookedIngredients: testMap.cookedIngredients.map((c) => (c.id === 1 ? { ...c, baseId: 0 } : c)),
    };
    const result = run(
      withBase,
      level({
        queueString: "1%2,2,0",
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0.1",
      }),
    );
    expect(result.solvable).toBe(true);
    // Every pick here scored something (never fell to the random fallback),
    // and the scores trace the algorithm's own logic: pick 1 takes the front
    // blocked topping (40, undecayed); picks 2-3 dig for the base one row
    // deeper each time, so its score keeps decaying (100 * 0.5^2 = 25, then
    // 100 * 0.5^1 = 50); pick 4 finally finds the base at the front (100, undecayed).
    expect(result.occupancyHistory.map(({ occupied, dirty, score, random }) => ({ occupied, dirty, score, random }))).toEqual([
      { occupied: 1, dirty: 0, score: 40, random: false },
      { occupied: 2, dirty: 0, score: 25, random: false },
      { occupied: 3, dirty: 0, score: 50, random: false },
      { occupied: 3, dirty: 1, score: 100, random: false },
    ]);
  });

  it("records which ingredient a pick consumed, and which customer it completed", () => {
    const result = run(
      testMap,
      level({
        queueString: "0",
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0",
      }),
    );
    expect(result.solvable).toBe(true);
    expect(result.occupancyHistory).toHaveLength(1);
    const sample = result.occupancyHistory[0];
    // Cooked 0 has no baseId and nothing else competes for it, so this is a
    // front-row, undecayed SCORE_BASE match, and — being the customer's only
    // item — direct-serves straight from the tool without ever landing on
    // the grid. Completing them in the same pick leaves testMap's generic
    // dirty dish behind (it defines no dirtyObjects of its own), so occupied
    // lands at 1, not 0.
    expect(sample.pickedNames).toEqual(["raw0"]);
    expect(sample.score).toBe(100);
    expect(sample.random).toBe(false);
    expect(sample.occupied).toBe(1);
    expect(sample.dirty).toBe(1);
    expect(sample.completesCustomers).toEqual([0]);
  });

  it("records an empty completesCustomers when a pick doesn't finish anyone's order", () => {
    const result = run(
      testMap,
      level({
        queueString: "0,0",
        gridString: EMPTY_GRID,
        // Two cooked-0's ordered — the first pick can't complete the customer alone.
        customerString: "0;0;0;0.0",
      }),
    );
    expect(result.occupancyHistory[0].completesCustomers).toEqual([]);
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

  it("marks a pick as random with score 0 when nothing in the queue scores against any order", () => {
    // The customer only ever wants cooked 0, but the queue is entirely
    // cooked 2 (which nothing orders) — every pick falls to the score-less
    // fallback, never to a scored dig or front-row match.
    const result = run(
      testMap,
      level({
        queueString: "2,2,2",
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0",
      }),
    );
    expect(result.occupancyHistory.length).toBeGreaterThan(0);
    for (const sample of result.occupancyHistory) {
      expect(sample.random).toBe(true);
      expect(sample.score).toBe(0);
    }
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

  it("serves two small orders concurrently, but only one when the pair is too big", () => {
    // Pair rule: 2 customers up at once only while their dishes total <= 5.
    const small = tagged(
      level({
        queueString: "0,0%1,1",
        gridString: EMPTY_GRID,
        // 2 dishes + 2 dishes = 4 <= 5, so both are serveable together.
        customerString: "0;0;0;0|0;0;0;1|0;0;0;0|0;0;0;1",
        serveableSlots: 1, // deliberately wrong — the solver must override it
      }),
    );
    const a = estimateDifficulty(testMap, small, { rng: seededRng(3) });
    expect(a.solvable).toBe(true);
    // Both of the first two customers get picks attributed while they're up.
    expect(a.perCustomer.filter((c) => c.picks > 0).length).toBeGreaterThan(1);

    const big = tagged(
      level({
        queueString: "0,0,0,0%1,1,1,1",
        gridString: EMPTY_GRID,
        // 4 dishes + 4 dishes = 8 > 5, so they must come up one at a time.
        customerString: "0;0;0;0,0,0,0|0;0;0;1,1,1,1",
        serveableSlots: 2,
      }),
    );
    const b = estimateDifficulty(testMap, big, { rng: seededRng(3) });
    expect(b.solvable).toBe(true);
    // Customer 0's order is fully picked before customer 1 gets anything.
    const orders = [...b.byCid.values()].sort((x, y) => x.order - y.order);
    const firstOfCustomer1 = orders.findIndex((s) => s.customerIndex === 1);
    const lastOfCustomer0 = orders.map((s) => s.customerIndex).lastIndexOf(0);
    expect(firstOfCustomer1).toBeGreaterThan(lastOfCustomer0);
  });

  it("prefers a deep base over a shallow blocked topping, via row decay", () => {
    // cooked 1 needs cooked 0. Lane 0 fronts the blocked topping (score 40);
    // lane 1 has the base one row down (100 * 0.5 = 50). 50 > 40, so the
    // solver digs lane 1 rather than taking the topping it can't serve.
    const withBase: MapDef = {
      ...testMap,
      cookedIngredients: testMap.cookedIngredients.map((c) =>
        c.id === 1 ? { ...c, baseId: 0 } : c,
      ),
    };
    const lvl = tagged(
      level({
        queueString: "1,1%2,0",
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0.1",
      }),
    );
    const digCid = cidOf(lvl.queues[1][0])!; // raw 2, the thing covering the base

    const result = estimateDifficulty(withBase, lvl, { rng: seededRng(3) });
    expect(result.byCid.get(digCid)?.order).toBe(1);
    expect(result.byCid.get(digCid)?.detour).toBe(true); // it was a dig, not a want
  });

  it("won't dig for a base it can't see, once that base is Hidden", () => {
    // Exactly the level above, with one character changed: the buried base at
    // lane 1 row 1 is now Hidden ("0#2"). The player would see a "?" there, so
    // the solver must too — the 100*0.5=50 lookahead score that previously beat
    // lane 0's blocked topping (40) disappears, and the solver takes the
    // topping instead of digging. Same map, same seed, opposite first pick.
    const withBase: MapDef = {
      ...testMap,
      cookedIngredients: testMap.cookedIngredients.map((c) =>
        c.id === 1 ? { ...c, baseId: 0 } : c,
      ),
    };
    const lvl = tagged(
      level({
        queueString: "1,1%2,0#2",
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0.1",
      }),
    );
    const digCid = cidOf(lvl.queues[1][0])!; // raw 2, covering the now-hidden base
    const toppingCid = cidOf(lvl.queues[0][0])!; // lane 0's front blocked topping

    const result = estimateDifficulty(withBase, lvl, { rng: seededRng(3) });
    expect(result.byCid.get(toppingCid)?.order).toBe(1);
    expect(result.byCid.get(digCid)?.order).not.toBe(1);
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

describe("difficultyColor", () => {
  it("is green at 0 and red at 1", () => {
    expect(difficultyColor(0)).toBe("hsl(120, 70%, 45%)");
    expect(difficultyColor(1)).toBe("hsl(0, 70%, 45%)");
  });

  it("clamps out-of-range ratios instead of producing an invalid hue", () => {
    expect(difficultyColor(-5)).toBe(difficultyColor(0));
    expect(difficultyColor(5)).toBe(difficultyColor(1));
  });

  it("moves monotonically from green to red as the ratio rises", () => {
    const hueOf = (c: string) => Number(c.match(/hsl\((-?\d+)/)![1]);
    expect(hueOf(difficultyColor(0.25))).toBeGreaterThan(hueOf(difficultyColor(0.75)));
  });
});

const cost = (gridOccupied: number): CustomerCost => ({
  index: 0, gridOccupied, gridWaste: 0, picks: 0, detours: 0,
});

describe("difficultyRatio", () => {
  it("scales against this level's worst customer, not a fixed board size", () => {
    // A customer occupying 3 cells is the WORST in an easy level (max 3) —
    // full red — but only middling in a harder level (max 10).
    expect(difficultyRatio(3, [cost(1), cost(3)])).toBe(1);
    expect(difficultyRatio(3, [cost(1), cost(3), cost(10)])).toBeCloseTo(0.3);
  });

  it("zero occupied is always zero, regardless of how hard the level is", () => {
    expect(difficultyRatio(0, [cost(0), cost(8)])).toBe(0);
  });

  it("returns 0 when every customer in the level occupies nothing, instead of dividing by zero", () => {
    expect(difficultyRatio(0, [cost(0), cost(0)])).toBe(0);
    expect(Number.isFinite(difficultyRatio(0, []))).toBe(true);
  });

  it("the worst customer in the level always reads exactly 1 (full red)", () => {
    const perCustomer = [cost(2), cost(7), cost(4)];
    expect(difficultyRatio(7, perCustomer)).toBe(1);
  });
});
