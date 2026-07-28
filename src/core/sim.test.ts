import { beforeEach, describe, expect, it } from "vitest";
import { MAP1_DATA } from "../data/initialData.ts";
import { toMapDef } from "../data/mapLoader.ts";
import { parseCustomers, parseGrid, parseQueues, SWEEPER_ID } from "./parser.ts";
import { Simulation } from "./sim.ts";
import type { LevelConfig, MapDef } from "./types.ts";

const map1 = toMapDef(MAP1_DATA);

/** Instant-cook test map so sims resolve without waiting on timers. */
const testMap: MapDef = {
  id: 99,
  name: "test",
  dirtyDishName: "plate",
  rawIngredients: [0, 1, 2].map((id) => ({
    id,
    name: `raw${id}`,
    icon: "",
    code: `raw${id}`,
    price: 1,
    prepareTime: 0,
    cookTime: 1,
  })),
  cookedIngredients: [0, 1, 2].map((id) => ({ id, name: `cooked${id}`, icon: "" })),
  cookMappings: [0, 1, 2].map((id) => ({ rawId: id, cookedIds: [id] })),
  levels: [],
};

function level(overrides: Partial<LevelConfig> & { queueString: string; gridString: string; customerString: string }): LevelConfig {
  return {
    id: 1,
    name: "test",
    weather: "Normal",
    levelTag: "",
    featureUnlock: "",
    shuffleDistance: 0,
    gridWidth: 5,
    gridHeight: 2,
    serveableSlots: 2,
    dirtyStackHeight: 5,
    queues: parseQueues(overrides.queueString),
    grid: parseGrid(overrides.gridString),
    customers: parseCustomers(overrides.customerString),
    ...overrides,
  };
}

const EMPTY_GRID = ",,,,,,,,,";

describe("simulation core loop", () => {
  it("serves a customer and wins", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0,1", gridString: EMPTY_GRID, customerString: "0;0;0.1" }),
    );
    expect(sim.active).toHaveLength(1);
    sim.pick(0);
    sim.pick(0);
    sim.runToEnd();
    expect(sim.status).toBe("won");
    expect(sim.servedCount).toBe(1);
  });

  it("places cooked output in the first free cell in scan order", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;1" }),
    );
    sim.pick(0);
    sim.tick(2);
    expect(sim.grid[0]).toEqual({ kind: "cooked", cookedId: 0 });
    expect(sim.grid[1]).toEqual({ kind: "empty" });
  });

  it("skips blocked cells when placing", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: "#1,,,,,,,,,", customerString: "0;0;1" }),
    );
    sim.pick(0);
    sim.tick(2);
    expect(sim.grid[0]).toEqual({ kind: "empty" });
    expect(sim.grid[1]).toEqual({ kind: "cooked", cookedId: 0 });
  });

  it("loses when a cooked ingredient has nowhere to go", () => {
    // 2-cell grid (rest blocked), 3 unwanted ingredients queued.
    const sim = new Simulation(
      testMap,
      level({
        queueString: "2,2,2",
        gridString: ",,#1,#1,#1,#1,#1,#1,#1,#1",
        customerString: "0;0;0",
      }),
    );
    sim.pick(0);
    sim.pick(0);
    sim.pick(0);
    sim.runToEnd();
    expect(sim.status).toBe("lost");
    expect(sim.loseReason).toBe("grid-overflow");
  });

  it("loses when queues run dry with orders outstanding", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;0.1" }),
    );
    sim.pick(0);
    sim.runToEnd();
    expect(sim.status).toBe("lost");
    expect(sim.loseReason).toBe("out-of-ingredient");
  });

  it("loses when a customer's patience runs out", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0,0", gridString: EMPTY_GRID, customerString: "5;0;0.1" }),
    );
    sim.runToEnd();
    expect(sim.status).toBe("lost");
    expect(sim.loseReason).toBe("customer-timeout");
  });

  it("halves patience for weather-affected customers on bad-weather levels", () => {
    const rainy = new Simulation(
      testMap,
      level({
        queueString: "0",
        gridString: EMPTY_GRID,
        customerString: "60;1;0",
        weather: "Rainy",
      }),
    );
    expect(rainy.active[0].timeLeft).toBe(30);
    const normal = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "60;1;0" }),
    );
    expect(normal.active[0].timeLeft).toBe(60);
  });
});

describe("settling within a step", () => {
  it("serves a customer who enters a freed slot in the same step as their food", () => {
    // One serve slot. The last two picks cook together: customer 1 completes,
    // customer 2 moves in and their item is already waiting on the grid.
    const sim = new Simulation(
      testMap,
      level({
        queueString: "0,1",
        gridString: EMPTY_GRID,
        customerString: "0;0;0|0;0;1",
        serveableSlots: 1,
      }),
    );
    sim.pick(0);
    sim.pick(0);
    sim.fastForward();
    expect(sim.servedCount).toBe(2);
    expect(sim.status).toBe("won");
  });
});

describe("fastForward (skip button)", () => {
  it("resolves in-flight cooking and stops, instead of burning the whole clock", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0,1", gridString: EMPTY_GRID, customerString: "0;0;0.1" }),
    );
    sim.pick(0);
    const advanced = sim.fastForward();
    expect(advanced).toBeLessThanOrEqual(2); // one cookTime, not the 600s bound
    expect(sim.pipeline).toHaveLength(0);
    expect(sim.status).toBe("playing"); // waiting for the next pick
    // The bun went straight into the waiting customer's dish.
    expect(sim.active[0].dishes[0].filled).toEqual([0]);
    expect(sim.active[0].dishes[0].remaining).toEqual([1]);
  });

  it("does not time a customer out during a step that serves them", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "1;0;0" }),
    );
    sim.pick(0); // cookTime 1s, patience 1s — the food lands exactly in time
    sim.fastForward();
    expect(sim.status).toBe("won");
  });
});

describe("serve slots and dirty dishes", () => {
  it("holds later customers until a slot frees up", () => {
    const sim = new Simulation(
      testMap,
      level({
        queueString: "0,0,0",
        gridString: EMPTY_GRID,
        customerString: "0;0;0|0;0;0|0;0;0",
        serveableSlots: 2,
      }),
    );
    expect(sim.active).toHaveLength(2);
    expect(sim.pending).toHaveLength(1);
    sim.pick(0);
    sim.tick(2);
    expect(sim.servedCount).toBe(1);
    expect(sim.active).toHaveLength(2); // third customer moved in
  });

  it("stacks dirty dishes up to dirtyStackHeight then opens a new stack", () => {
    const sim = new Simulation(
      testMap,
      level({
        queueString: "0,0,0",
        gridString: EMPTY_GRID,
        customerString: "0;0;0|0;0;0|0;0;0",
        dirtyStackHeight: 2,
        serveableSlots: 1,
      }),
    );
    for (let i = 0; i < 3; i++) {
      sim.pick(0);
      sim.tick(2);
    }
    expect(sim.status).toBe("won");
    const dirty = sim.grid.filter((c) => c.kind === "dirty");
    expect(dirty).toHaveLength(2);
    expect(dirty.map((c) => (c as { count: number }).count).sort()).toEqual([1, 2]);
  });

  it("clears the oldest dirty stack when a sweeper is picked", () => {
    const sim = new Simulation(
      testMap,
      level({
        queueString: `0,${SWEEPER_ID}`,
        gridString: EMPTY_GRID,
        customerString: "0;0;0|0;0;0",
        dirtyStackHeight: 1,
        serveableSlots: 1,
      }),
    );
    sim.pick(0);
    sim.tick(2);
    expect(sim.grid.filter((c) => c.kind === "dirty")).toHaveLength(1);
    sim.pick(0); // sweeper
    expect(sim.grid.filter((c) => c.kind === "dirty")).toHaveLength(0);
  });

  it("treats a dish-less customer as staff clearing dirty stacks", () => {
    const sim = new Simulation(
      testMap,
      level({
        queueString: "0",
        gridString: EMPTY_GRID,
        customerString: "0;0;0|0;0;",
        dirtyStackHeight: 1,
        serveableSlots: 1,
      }),
    );
    sim.pick(0);
    sim.tick(2);
    expect(sim.status).toBe("won");
    expect(sim.grid.filter((c) => c.kind === "dirty")).toHaveLength(0);
  });
});

describe("effects", () => {
  it("blocks picking a frozen item until enough other picks happen", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0#1:2%0%0", gridString: EMPTY_GRID, customerString: "0;0;0" }),
    );
    expect(sim.canPick(0).ok).toBe(false);
    sim.pick(1);
    expect(sim.canPick(0).ok).toBe(false);
    sim.pick(2);
    expect(sim.canPick(0).ok).toBe(true);
  });

  it("opens a ColorLock cell once matching keys are collected", () => {
    const sim = new Simulation(
      testMap,
      level({
        queueString: "0#3:1,0",
        gridString: "#4:1:1,,,,,,,,,",
        customerString: "0;0;0",
      }),
    );
    expect(sim.isCellUsable(0)).toBe(false);
    expect(sim.cellLockLabel(0)).toBe("0/1 keys");
    sim.pick(0);
    expect(sim.isCellUsable(0)).toBe(true);
    expect(sim.cellLockLabel(0)).toBeNull();
  });

  it("opens an ingredient-slot cell only for its own ingredient", () => {
    const sim = new Simulation(
      testMap,
      level({
        // Cell 0 is slotted to ingredient 1, amount 2.
        queueString: "0,0%1,1",
        gridString: "#3:1:2,,,,,,,,,",
        customerString: "0;0;0",
      }),
    );
    expect(sim.isCellUsable(0)).toBe(false);
    sim.pick(0); // ingredient 0 — wrong ingredient, no progress
    sim.pick(0);
    expect(sim.cellLockLabel(0)).toBe("0/2");
    sim.pick(1); // ingredient 1
    expect(sim.cellLockLabel(0)).toBe("1/2");
    sim.pick(1);
    expect(sim.isCellUsable(0)).toBe(true);
  });

  it("opens an OrderLock cell after enough customers are served", () => {
    const sim = new Simulation(
      testMap,
      level({
        queueString: "0,0",
        gridString: ",#2:1,,,,,,,,",
        customerString: "0;0;0|0;0;0",
        serveableSlots: 1,
      }),
    );
    expect(sim.isCellUsable(1)).toBe(false);
    sim.pick(0);
    sim.tick(2);
    expect(sim.isCellUsable(1)).toBe(true);
  });
});

describe("real Map 1 level data", () => {
  let sim: Simulation;
  beforeEach(() => {
    sim = new Simulation(map1, map1.levels[0]);
  });

  it("level 1_1 starts with serveable customers and a full queue set", () => {
    expect(sim.level.queues).toHaveLength(3);
    expect(sim.totalCustomers).toBe(7);
    expect(sim.active.length).toBe(sim.level.serveableSlots);
    expect(sim.status).toBe("playing");
  });

  it("level 1_1 is winnable by always picking what the current orders need", () => {
    const cookedToRaw = new Map(
      map1.cookMappings.flatMap((m) => m.cookedIds.map((c) => [c, m.rawId] as const)),
    );
    for (let step = 0; step < 400 && sim.status === "playing"; step++) {
      const needed = sim.neededCookedIds();
      const wantedRaw = new Set([...needed].map((c) => cookedToRaw.get(c)));
      const queueIndex = sim.queues.findIndex(
        (q, i) => q.length > 0 && wantedRaw.has(q[0].id) && sim.canPick(i).ok,
      );
      if (queueIndex >= 0) sim.pick(queueIndex);
      else sim.tick(0.5);
    }
    expect(sim.status).toBe("won");
    expect(sim.servedCount).toBe(7);
  });

  it("level 1_11 exposes ColorLock cells that start locked", () => {
    const l11 = new Simulation(map1, map1.levels[10]);
    const locked = l11.level.grid
      .map((_, i) => i)
      .filter((i) => !l11.isCellUsable(i));
    expect(locked.length).toBeGreaterThan(0);
    expect(l11.cellLockLabel(locked[0])).toMatch(/keys/);
  });
});
