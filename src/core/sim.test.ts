import { beforeEach, describe, expect, it } from "vitest";
import { MAP1_DATA } from "../data/configLoader.ts";
import { toMapDef } from "../data/mapLoader.ts";
import { parseCustomers, parseGrid, parseQueues, SWEEPER_ID } from "./parser.ts";
import { Simulation } from "./sim.ts";
import type { LevelConfig, MapDef } from "./types.ts";

const map1 = toMapDef(MAP1_DATA);

/**
 * Small test map: one tool with plenty of slots and a 1s cook time, so sims
 * resolve quickly. Ingredient 2 has no recipe, so it goes straight to the grid.
 */
const testMap: MapDef = {
  id: 99,
  name: "test",
  dirtyDishName: "plate",
  rawIngredients: [0, 1, 2, 3].map((id) => ({
    id,
    name: `raw${id}`,
    icon: "",
    code: `raw${id}`,
    price: 1,
    numSlices: id === 3 ? 2 : 1,
  })),
  cookedIngredients: [0, 1, 2, 3].map((id) => ({ id, name: `cooked${id}`, icon: "" })),
  tools: [
    {
      id: 0,
      name: "Test Tool",
      numSlots: 8,
      cookingTime: 1,
      recipes: [
        { in: 0, out: 0, amount: 1 },
        { in: 1, out: 1, amount: 1 },
        // Ingredient 3 splits into two pieces, like a chopping board.
        { in: 3, out: 3, amount: 2 },
      ],
    },
  ],
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

  it("loses when a tool's output has nowhere to go", () => {
    // One usable cell, but ingredient 3 chops into two pieces: the first lands,
    // the second has nowhere to go.
    const sim = new Simulation(
      testMap,
      level({
        queueString: "3",
        gridString: ",#1,#1,#1,#1,#1,#1,#1,#1,#1",
        customerString: "0;0;0",
      }),
    );
    sim.pick(0);
    sim.runToEnd();
    expect(sim.status).toBe("lost");
    expect(sim.loseReason).toBe("grid-overflow");
  });

  it("refuses a pick that has nowhere to land at all", () => {
    // Ingredient 2 needs no tool, so it goes straight to the grid — and the
    // grid is full, so the pick is blocked rather than losing the level.
    const sim = new Simulation(
      testMap,
      level({
        queueString: "2",
        gridString: "#1,#1,#1,#1,#1,#1,#1,#1,#1,#1",
        customerString: "0;0;0",
      }),
    );
    const check = sim.canPick(0);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/no free grid cell/i);
    expect(sim.pick(0)).toBe(false);
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

describe("cooking tools", () => {
  /** One-slot tool so the "tool is full" paths are easy to reach. */
  const oneSlotMap: MapDef = {
    ...testMap,
    tools: [{ id: 0, name: "Single", numSlots: 1, cookingTime: 2, recipes: [{ in: 0, out: 0, amount: 1 }] }],
  };

  it("puts a picked ingredient into a free slot of its tool", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0,1", gridString: EMPTY_GRID, customerString: "0;0;0.1" }),
    );
    sim.pick(0);
    expect(sim.tools[0].slots[0].item?.rawId).toBe(0);
    expect(sim.cookingCount).toBe(1);
  });

  it("yields several pieces from one raw unit", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "3", gridString: EMPTY_GRID, customerString: "0;0;3.3" }),
    );
    sim.pick(0);
    sim.tick(2);
    // One chop produced both pieces the order needs.
    expect(sim.status).toBe("won");
  });

  it("sends an ingredient with no tool straight to the grid", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "2", gridString: EMPTY_GRID, customerString: "0;0;2" }),
    );
    sim.pick(0);
    expect(sim.cookingCount).toBe(0); // never entered a tool
    sim.tick(0.1);
    expect(sim.status).toBe("won");
  });

  it("blocks the pick when the tool is full under the block-pick policy", () => {
    const sim = new Simulation(
      oneSlotMap,
      level({ queueString: "0,0", gridString: EMPTY_GRID, customerString: "0;0;0.0" }),
      { outOfSlotPolicy: "block-pick" },
    );
    expect(sim.pick(0)).toBe(true);
    const check = sim.canPick(0);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/full/i);
    expect(sim.pick(0)).toBe(false);
  });

  it("parks the raw on the grid and reclaims it when a slot frees", () => {
    const sim = new Simulation(
      oneSlotMap,
      level({ queueString: "0,0", gridString: EMPTY_GRID, customerString: "0;0;0.0" }),
      { outOfSlotPolicy: "park-on-grid" },
    );
    sim.pick(0); // occupies the only slot
    expect(sim.pick(0)).toBe(true); // allowed: it parks instead of blocking
    expect(sim.grid.some((c) => c.kind === "raw" && c.rawId === 0)).toBe(true);

    sim.runToEnd();
    // The parked raw was pulled into the slot once the first item finished.
    expect(sim.grid.some((c) => c.kind === "raw")).toBe(false);
    expect(sim.status).toBe("won");
  });

  it("prioritises a parked raw over leaving the slot idle", () => {
    const sim = new Simulation(
      oneSlotMap,
      level({ queueString: "0,0", gridString: EMPTY_GRID, customerString: "0;0;0.0" }),
      { outOfSlotPolicy: "park-on-grid" },
    );
    sim.pick(0);
    sim.pick(0);
    sim.tick(2.1); // first item finishes and vacates the slot
    expect(sim.tools[0].slots[0].item?.rawId).toBe(0); // reclaimed immediately
  });
});

describe("flight gating", () => {
  it("holds a transfer until the host completes it", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;0" }),
      { instantFlights: false },
    );
    sim.pick(0);
    // The ingredient has left the queue but has not reached the tool yet.
    expect(sim.flights).toHaveLength(1);
    expect(sim.flights[0].kind).toBe("queue-to-tool");
    expect(sim.tools[0].slots[0].item).toBeNull();

    sim.tick(5); // no cooking can happen — nothing is in the slot
    expect(sim.tools[0].slots[0].item).toBeNull();

    sim.completeFlight(sim.flights[0].id);
    expect(sim.tools[0].slots[0].item?.rawId).toBe(0);
  });

  it("flies a finished item to the grid, then on to the customer", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;0" }),
      { instantFlights: false },
    );
    sim.pick(0);
    sim.completeAllFlights(); // lands in the tool slot
    sim.tick(1.1); // cooking finishes and launches the trip to the grid

    const toGrid = sim.flights.find((f) => f.kind === "tool-to-grid");
    expect(toGrid).toBeDefined();
    sim.completeFlight(toGrid!.id);
    expect(sim.grid.some((c) => c.kind === "cooked")).toBe(true);

    // Landing on the grid is what triggers the match against the order.
    const toCustomer = sim.flights.find((f) => f.kind === "grid-to-customer");
    expect(toCustomer).toBeDefined();
    sim.completeFlight(toCustomer!.id);
    expect(sim.status).toBe("won");
  });

  it("flies the dirty dish from the customer to the grid", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;0" }),
      { instantFlights: false },
    );
    // Step through one flight at a time so the dirty dish can be caught in the
    // air (completeAllFlights would drain that too).
    sim.pick(0);
    sim.completeFlight(sim.flights[0].id); // into the tool slot
    sim.tick(1.1); // cooking finishes
    sim.completeFlight(sim.flights[0].id); // output lands on the grid
    const toCustomer = sim.flights.find((f) => f.kind === "grid-to-customer")!;
    sim.completeFlight(toCustomer.id); // fills the dish and serves the customer

    // Serving the last dish sends a dirty dish back, starting at that customer.
    const dirty = sim.flights.find((f) => f.kind === "customer-to-grid");
    expect(dirty).toBeDefined();
    expect(dirty!.fromCustomer).toBe(0);
    expect(sim.grid.some((c) => c.kind === "dirty")).toBe(false); // still travelling

    sim.completeFlight(dirty!.id);
    expect(sim.grid.some((c) => c.kind === "dirty")).toBe(true);
  });

  it("stacks simultaneous dirty dishes without exceeding the stack height", () => {
    // Two customers served together, stack height 1 → two separate stacks.
    const sim = new Simulation(
      testMap,
      level({
        queueString: "2,2",
        gridString: EMPTY_GRID,
        customerString: "0;0;2|0;0;2",
        serveableSlots: 2,
        dirtyStackHeight: 1,
      }),
      { instantFlights: false },
    );
    sim.pick(0);
    sim.pick(0);
    sim.completeAllFlights();
    const stacks = sim.grid.filter((c) => c.kind === "dirty");
    expect(stacks).toHaveLength(2);
    expect(stacks.every((s) => s.kind === "dirty" && s.count === 1)).toBe(true);
  });

  it("completeAllFlights resolves a whole chain at once (skip mode)", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;0" }),
      { instantFlights: false },
    );
    sim.pick(0);
    sim.completeAllFlights();
    sim.tick(1.1);
    sim.completeAllFlights();
    expect(sim.flights).toHaveLength(0);
    expect(sim.status).toBe("won");
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
    expect(advanced).toBeLessThanOrEqual(2); // one cook time, not the 600s bound
    expect(sim.cookingCount).toBe(0);
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
    // Which raw ingredient yields each cooked id, via the map's tools.
    const cookedToRaw = new Map<number, number>();
    for (const tool of map1.tools) {
      for (const recipe of tool.recipes) cookedToRaw.set(recipe.out, recipe.in);
    }
    for (let step = 0; step < 600 && sim.status === "playing"; step++) {
      sim.completeAllFlights();
      const needed = sim.neededCookedIds();
      const wantedRaw = new Set([...needed].map((c) => cookedToRaw.get(c) ?? c));
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
