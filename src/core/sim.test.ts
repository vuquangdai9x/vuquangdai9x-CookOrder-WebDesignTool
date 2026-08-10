import { beforeEach, describe, expect, it } from "vitest";
import { MAP1_DATA } from "../data/configLoader.ts";
import { toMapDef } from "../data/mapLoader.ts";
import { SWEEPER_ID } from "./parser.ts";
import { DIRTY_DISH_ID, Simulation } from "./sim.ts";
import type { MapDef } from "./types.ts";
import { EMPTY_GRID, level, testMap } from "./testFixtures.ts";

const map1 = toMapDef(MAP1_DATA);

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

describe("base ingredient requirement", () => {
  // cooked1 needs cooked0 already in the dish first (see CookedIngredientDef.baseId).
  const baseMap: MapDef = {
    ...testMap,
    cookedIngredients: testMap.cookedIngredients.map((c) =>
      c.id === 1 ? { ...c, baseId: 0 } : c,
    ),
  };

  it("withholds the dependent ingredient until its base is already in the dish, then serves it", () => {
    // instantFlights: false so flights stay pending until we complete them by
    // hand — that's what lets this test observe the mid-way blocked state.
    const sim = new Simulation(
      baseMap,
      level({ queueString: "1,0", gridString: EMPTY_GRID, customerString: "0;0;1.0" }),
      { instantFlights: false },
    );
    sim.pick(0); // cooked1 (topping) into the tool
    sim.pick(0); // cooked0 (base) into the tool
    for (const f of [...sim.flights]) sim.completeFlight(f.id); // both land in their tool slots
    sim.tick(2); // finishes cooking

    // cooked0 has no base requirement, so it flies straight to the customer,
    // skipping the grid; cooked1 is withheld (its base isn't in the dish
    // yet) and lands on the grid instead.
    expect(sim.flights).toHaveLength(2);
    const direct = sim.flights.find((f) => f.kind === "tool-to-customer");
    expect(direct).toMatchObject({ itemId: 0 });
    const toGrid = sim.flights.find((f) => f.kind === "tool-to-grid");
    expect(toGrid).toMatchObject({ itemId: 1 });

    sim.completeFlight(toGrid!.id); // cooked1 lands on the grid, still withheld
    const dish = sim.active[0].dishes[0];
    expect(dish.filled).toHaveLength(0);

    sim.completeFlight(direct!.id); // base served — settle() now finds cooked1 servable too
    expect(sim.flights).toHaveLength(1);
    expect(sim.flights[0]).toMatchObject({ kind: "grid-to-customer", itemId: 1 });

    sim.completeFlight(sim.flights[0].id);
    expect(sim.status).toBe("won");
  });
});

describe("multi-option base ingredient requirement", () => {
  // cooked0 needs EITHER cooked1 or cooked2 already in the dish (an array
  // baseId — e.g. a shared sauce that can top several different bases).
  const multiBaseMap: MapDef = {
    ...testMap,
    cookedIngredients: testMap.cookedIngredients.map((c) =>
      c.id === 0 ? { ...c, baseId: [1, 2] } : c,
    ),
  };

  it("serves once any one of several listed base options is already in the dish", () => {
    const sim = new Simulation(
      multiBaseMap,
      level({ queueString: "2,0", gridString: EMPTY_GRID, customerString: "0;0;0.2" }),
    );
    sim.pick(0); // cooked2 — satisfies the base requirement (it's option 2 of [1, 2])
    sim.pick(0); // cooked0 — needs a base, now met
    sim.tick(1); // cooked0 finishes cooking
    sim.tick(0); // let autoServe react
    expect(sim.status).toBe("won");
  });
});

describe("chained tool recipes", () => {
  // Ingredient 2 needs tool A, then tool B, before producing its output —
  // like potato going through the Cutting Board then the Fryer.
  const chainMap: MapDef = {
    ...testMap,
    tools: [
      { id: 0, name: "A", numSlots: 1, cookingTime: 1, recipes: [{ in: 2, out: 2, amount: 1, chainTools: [1] }] },
      { id: 1, name: "B", numSlots: 1, cookingTime: 1, recipes: [] },
    ],
  };

  it("hops through each tool in the chain before producing output", () => {
    const sim = new Simulation(
      chainMap,
      // A waiting customer keeps the level from auto-winning with nothing to
      // do — they want cooked2, so once the chain finishes it serves them
      // directly (see "skip-the-grid" below) instead of landing on the grid.
      level({ queueString: "2", gridString: EMPTY_GRID, customerString: "0;0;2" }),
      { instantFlights: false },
    );
    sim.pick(0);
    sim.completeFlight(sim.flights[0].id); // lands in tool A's slot

    sim.tick(1); // A finishes -> hops to tool B, not the grid
    expect(sim.flights).toHaveLength(1);
    expect(sim.flights[0].kind).toBe("tool-to-tool");
    expect(sim.tools[0].slots[0].item).toBeNull(); // tool A freed
    expect(sim.grid.every((c) => c.kind === "empty")).toBe(true);

    sim.completeFlight(sim.flights[0].id); // lands in tool B's slot
    expect(sim.tools[1].slots[0].item?.rawId).toBe(2);

    sim.tick(1); // B finishes -> the waiting customer takes the final output directly
    expect(sim.flights).toHaveLength(1);
    expect(sim.flights[0].kind).toBe("tool-to-customer");
    sim.completeFlight(sim.flights[0].id);
    expect(sim.status).toBe("won");
  });

  it("waits at the first tool if the next tool in the chain has no free slot, then hops once one frees", () => {
    // Tool B's cookingTime is bumped way up here only so the fake occupant
    // planted directly into its slot below doesn't itself "finish cooking"
    // on the same tick() call that finishes tool A.
    const busyChainMap: MapDef = {
      ...chainMap,
      tools: [chainMap.tools[0], { ...chainMap.tools[1], cookingTime: 100 }],
    };
    const sim = new Simulation(
      busyChainMap,
      level({ queueString: "2", gridString: EMPTY_GRID, customerString: "0;0;2" }),
      { instantFlights: false },
    );
    sim.tools[1].slots[0].item = { uid: 999, rawId: 1, elapsed: 0 }; // occupy tool B

    sim.pick(0);
    sim.completeFlight(sim.flights[0].id); // lands in tool A's slot
    sim.tick(1); // A finishes, but B is full -> stays put at A

    expect(sim.flights).toHaveLength(0);
    expect(sim.tools[0].slots[0].item?.rawId).toBe(2);

    sim.tools[1].slots[0].item = null; // B frees up
    sim.tick(0); // retried this tick
    expect(sim.flights).toHaveLength(1);
    expect(sim.flights[0].kind).toBe("tool-to-tool");
  });
});

describe("multi-use cooked ingredients", () => {
  // cooked0 can be served twice before it's used up (e.g. a shared sauce).
  const multiUseMap: MapDef = {
    ...testMap,
    cookedIngredients: testMap.cookedIngredients.map((c) =>
      c.id === 0 ? { ...c, usageNum: 2 } : c,
    ),
  };

  it("decrements usesLeft on serve instead of clearing, then clears once exhausted", () => {
    const sim = new Simulation(
      multiUseMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;0|0;0;0" }),
      { instantFlights: false },
    );
    sim.pick(0);
    sim.completeFlight(sim.flights[0].id); // into the tool
    sim.tick(1); // cooking finishes; usageNum > 1 blocks the direct-serve shortcut

    const toGrid = sim.flights.find((f) => f.kind === "tool-to-grid")!;
    sim.completeFlight(toGrid.id);
    expect(sim.grid).toContainEqual({ kind: "cooked", cookedId: 0, usesLeft: 2 });

    sim.tick(0); // autoServe finds it for customer A
    sim.completeFlight(sim.flights.find((f) => f.kind === "grid-to-customer")!.id);
    expect(sim.active).toHaveLength(1); // A served and left
    expect(sim.grid).toContainEqual({ kind: "cooked", cookedId: 0, usesLeft: 1 });

    sim.tick(0); // autoServe finds it again for customer B
    sim.completeFlight(sim.flights.find((f) => f.kind === "grid-to-customer")!.id);
    expect(sim.grid.every((c) => c.kind === "empty")).toBe(true);
    expect(sim.status).toBe("won");
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

  it("doesn't leak grid-cell reservations across repeated park+reclaim cycles", () => {
    // Regression: reclaimParkedRaws() reserves the parked raw's cell when it
    // launches the grid-to-tool flight, but completeFlight() never released
    // it — each reclaim permanently shrank findFreeCell()'s usable count,
    // even though the grid looked empty, eventually losing on a phantom
    // "no free cell" once enough reclaims had happened.
    //
    // Steady state: exactly one raw parked at a time (a 2-cell grid has
    // headroom to spare for that), repeated over many cycles — a genuine
    // pile-up (e.g. picking faster than the tool drains) would also lose,
    // so each cycle only picks once it's actually safe to.
    const tinyGridMap: MapDef = { ...oneSlotMap, gridWidth: 2, gridHeight: 1 };
    const cycles = 6;
    const totalPicks = 2 + cycles;
    const sim = new Simulation(
      tinyGridMap,
      level({
        queueString: Array(totalPicks).fill(0).join(","),
        gridString: ",",
        customerString: "0;0;0;" + Array(totalPicks).fill(0).join("."),
      }),
      { outOfSlotPolicy: "park-on-grid" },
    );
    sim.pick(0); // into the free tool
    sim.pick(0); // parks — establishes the steady state
    for (let i = 0; i < cycles; i++) {
      sim.tick(2.1); // finishes cooking, reclaims the parked raw
      if (sim.canPick(0).ok) sim.pick(0); // parks the next raw again
    }
    sim.runToEnd();
    expect(sim.status).toBe("won");
    expect(sim.loseReason).toBeNull();
    // Everything has settled — any lingering reservation would be a leak.
    expect(sim["reservedCells"].size).toBe(0);
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

  it("flies a finished item directly to the customer when they're already waiting, skipping the grid", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;0" }),
      { instantFlights: false },
    );
    sim.pick(0);
    sim.completeAllFlights(); // lands in the tool slot
    sim.tick(1.1); // cooking finishes; the waiting customer means it skips the grid

    expect(sim.flights).toHaveLength(1);
    expect(sim.flights[0].kind).toBe("tool-to-customer");
    expect(sim.grid.every((c) => c.kind === "empty")).toBe(true);

    sim.completeFlight(sim.flights[0].id);
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
    sim.tick(1.1); // cooking finishes; flies straight to the waiting customer
    const toCustomer = sim.flights.find((f) => f.kind === "tool-to-customer")!;
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
      { ...testMap, dirtyStackHeight: 1 },
      level({
        queueString: "2,2",
        gridString: EMPTY_GRID,
        customerString: "0;0;2|0;0;2",
        serveableSlots: 2,
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

  it("a live for-of over sim.flights skips one when completeFlight splices mid-loop", () => {
    // Regression for the Play-mode bug "switch to skip, back to x1, next fly
    // doesn't play": PlayView's dispatchFlights() used to iterate the live
    // sim.flights array while calling completeFlight() (which splices it)
    // inside the loop — this test proves that pattern really does skip an
    // element, and that snapshotting the array first (the fix) does not.
    const sim = new Simulation(
      testMap,
      // Ingredient 3 splits into 2 pieces, so both finish in the same tick —
      // two simultaneous flights, with a customer that wants neither (id 0),
      // so nothing cascades into extra flights via auto-serve.
      level({ queueString: "3", gridString: EMPTY_GRID, customerString: "0;0;0" }),
      { instantFlights: false },
    );
    sim.pick(0);
    sim.completeAllFlights(); // lands in the tool slot
    sim.tick(1.1); // cooking finishes: launches 2 simultaneous tool-to-grid flights
    expect(sim.flights).toHaveLength(2);
    expect(sim.flights.every((f) => f.kind === "tool-to-grid")).toBe(true);

    const visitedLive: number[] = [];
    for (const f of sim.flights) {
      // BUG PATTERN: live array, mutated by completeFlight below.
      visitedLive.push(f.id);
      sim.completeFlight(f.id);
    }
    expect(visitedLive).toHaveLength(1); // the other was skipped by the iterator
    expect(sim.flights).toHaveLength(1); // ...and is still sitting there unresolved

    // THE FIX: snapshot first, so both get visited and resolved.
    for (const f of [...sim.flights]) sim.completeFlight(f.id);
    expect(sim.flights).toHaveLength(0);
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
      { ...testMap, dirtyStackHeight: 2 },
      level({
        queueString: "0,0,0",
        gridString: EMPTY_GRID,
        customerString: "0;0;0|0;0;0|0;0;0",
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
    // testMap defines no dirty objects — every stack falls back to the
    // legacy generic sentinel rather than any real MapDef.dirtyObjects id.
    expect(dirty.every((c) => (c as { dirtyId: number }).dirtyId === DIRTY_DISH_ID)).toBe(true);
  });

  it("spawns the matching dirty-object type per dish, keeping types in separate stacks", () => {
    const dirtyMap: MapDef = {
      ...testMap,
      dirtyObjects: [
        { id: 10, name: "Plate", icon: "", sourceCookedId: 0 },
        { id: 11, name: "Cup", icon: "", sourceCookedId: 1 },
      ],
    };
    const sim = new Simulation(
      dirtyMap,
      level({
        queueString: "0,1",
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0|0;0;0;1",
        serveableSlots: 2,
      }),
    );
    sim.pick(0); // raw0 -> cooked0, satisfies customer0's dish (source of Plate)
    sim.pick(0); // raw1 -> cooked1, satisfies customer1's dish (source of Cup)
    sim.tick(2);
    expect(sim.status).toBe("won");
    const dirty = sim.grid.filter((c) => c.kind === "dirty") as { dirtyId: number; count: number }[];
    expect(dirty).toHaveLength(2);
    expect(dirty.map((c) => c.dirtyId).sort()).toEqual([10, 11]);
    expect(dirty.every((c) => c.count === 1)).toBe(true);
  });

  it("clears the oldest dirty stack when a sweeper is picked", () => {
    const sim = new Simulation(
      { ...testMap, dirtyStackHeight: 1 },
      level({
        queueString: `0,${SWEEPER_ID}`,
        gridString: EMPTY_GRID,
        customerString: "0;0;0|0;0;0",
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
      { ...testMap, dirtyStackHeight: 1 },
      level({
        queueString: "0",
        gridString: EMPTY_GRID,
        customerString: "0;0;0|0;0;",
        serveableSlots: 1,
      }),
    );
    sim.pick(0);
    sim.tick(2);
    expect(sim.status).toBe("won");
    expect(sim.grid.filter((c) => c.kind === "dirty")).toHaveLength(0);
  });

  it("flight-gates staff clearing: N flights for N stacks, celebration fires only once all land", () => {
    // One serve slot forces strict turn-taking through A, B, C, then staff.
    // A customer's *own* slot frees the instant their dish is filled — before
    // their dirty dish has actually landed — so whoever is seated next in
    // that same reactive step (the following pending customer) can never see
    // that departing customer's dirty dish yet. That means a staff seated
    // immediately after C leaves would only ever see A's and B's dishes
    // (landed earlier, while B and then C were being served) — never C's own
    // (still in flight). Stepping through flight-by-flight instead of via
    // completeAllFlights lets the test land A's and B's dirty dishes before
    // advancing C, so the staff is seated with exactly those two already on
    // the grid — precisely the "N stacks already there" case this proves.
    const sim = new Simulation(
      { ...testMap, dirtyStackHeight: 1 },
      level({
        queueString: "2,2,2",
        gridString: EMPTY_GRID,
        customerString: "0;0;2|0;0;2|0;0;2|0;0;;2",
        serveableSlots: 1,
      }),
      { instantFlights: false },
    );
    const complete = (kind: string) => {
      const f = sim.flights.find((fl) => fl.kind === kind);
      if (!f) throw new Error(`no pending flight of kind ${kind}`);
      sim.completeFlight(f.id);
    };

    sim.pick(0); // A is already seated and waiting, so this one serves directly
    sim.pick(0);
    sim.pick(0); // B's and C's items aren't wanted by anyone active yet — land on the grid

    complete("queue-to-customer"); // A's dish fills directly -> A leaves, A's dirty dish launches
    complete("customer-to-grid"); // A's dirty dish lands: 1 stack. B now seated.

    complete("queue-to-grid"); // B's item lands -> matched to B
    complete("grid-to-customer"); // B's dish fills -> B leaves, B's dirty dish launches
    complete("customer-to-grid"); // B's dirty dish lands: 2 stacks. C now seated.
    expect(sim.grid.filter((c) => c.kind === "dirty")).toHaveLength(2);

    complete("queue-to-grid"); // C's item lands -> matched to C
    complete("grid-to-customer"); // C's dish fills -> C leaves, staff seated NOW,
    // seeing exactly A's + B's stacks (C's own dirty dish is a separate,
    // still-pending "customer-to-grid" flight at this point).

    const staffFlights = sim.flights.filter((f) => f.kind === "dirty-to-staff");
    expect(staffFlights).toHaveLength(2);
    const staffIndex = staffFlights[0].toCustomer!.index;
    expect(sim.active.some((c) => c.index === staffIndex && c.isStaff)).toBe(true);

    // Landing the first of the two stacks alone must not finish the staff.
    sim.completeFlight(staffFlights[0].id);
    expect(sim.active.some((c) => c.index === staffIndex)).toBe(true);
    expect(sim.events.some((e) => e.type === "served" && e.customerIndex === staffIndex)).toBe(
      false,
    );

    // The second (last) stack landing is what completes them.
    sim.completeFlight(staffFlights[1].id);
    expect(sim.active.some((c) => c.index === staffIndex)).toBe(false);
    expect(sim.events.some((e) => e.type === "served" && e.customerIndex === staffIndex)).toBe(
      true,
    );
  });

  it("a staff with nothing to clear finishes immediately with no flight", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;;5" }),
      { instantFlights: false },
    );
    expect(sim.flights.filter((f) => f.kind === "dirty-to-staff")).toHaveLength(0);
    expect(sim.active).toHaveLength(0);
    expect(sim.servedCount).toBe(1);
  });
});

describe("effects", () => {
  it("blocks picking a frozen item until enough ADJACENT picks happen", () => {
    // Column 0 is frozen (thaw count 2); column 1 (adjacent) holds two items,
    // so picking its front twice provides two adjacent picks in a row.
    const sim = new Simulation(
      testMap,
      level({ queueString: "0#1:2%0,1", gridString: EMPTY_GRID, customerString: "0;0;0" }),
    );
    expect(sim.canPick(0).ok).toBe(false);
    expect(sim.canPick(0).reason).toMatch(/frozen/i);
    sim.pick(1); // adjacent column, first thaw pick
    expect(sim.canPick(0).ok).toBe(false);
    sim.pick(1); // adjacent column, second thaw pick (the next item shifted to front)
    expect(sim.canPick(0).ok).toBe(true);
  });

  it("a pick in a NON-adjacent column doesn't thaw a frozen item", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0#1:1%0%0", gridString: EMPTY_GRID, customerString: "0;0;0" }),
    );
    sim.pick(2); // column 2 is two columns away from the frozen column 0
    expect(sim.canPick(0).ok).toBe(false);
    sim.pick(1); // column 1 IS adjacent
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
      let queueIndex = -1;
      for (let i = 0; i < sim.columnCount; i++) {
        const front = sim.frontCell(i);
        if (front && wantedRaw.has(front.item.id) && sim.canPick(i).ok) {
          queueIndex = i;
          break;
        }
      }
      if (queueIndex >= 0) sim.pick(queueIndex);
      else sim.tick(0.5);
    }
    expect(sim.status).toBe("won");
    expect(sim.servedCount).toBe(7);
  });
});

describe("tool-less raw ingredient with a cookedId override", () => {
  // Raw id 2 in testMap has no tool recipe (goes straight to grid). Give it
  // a cookedId override pointing at a DIFFERENT cooked id, mirroring map1's
  // chili_bowl/cheese_sauce (renumbered on the cooked side, but the raw id
  // stayed put) — see RawIngredientDef.cookedId / Simulation.noToolCookedId.
  const overriddenMap: MapDef = {
    ...testMap,
    rawIngredients: testMap.rawIngredients.map((r) => (r.id === 2 ? { ...r, cookedId: 3 } : r)),
  };

  it("lands on the grid as the overridden cooked id, not the raw id", () => {
    const sim = new Simulation(
      overriddenMap,
      level({ queueString: "2", gridString: EMPTY_GRID, customerString: "0;0;0" }),
    );
    sim.pick(0);
    sim.completeAllFlights();
    expect(sim.grid.some((c) => c.kind === "cooked" && c.cookedId === 3)).toBe(true);
    expect(sim.grid.some((c) => c.kind === "cooked" && c.cookedId === 2)).toBe(false);
  });

  it("serves straight from the queue (direct-serve shortcut) as the overridden cooked id", () => {
    const sim = new Simulation(
      overriddenMap,
      level({ queueString: "2", gridString: EMPTY_GRID, customerString: "0;0;0;3" }),
    );
    sim.pick(0);
    sim.completeAllFlights();
    expect(sim.status).toBe("won");
  });
});

describe("queue groups", () => {
  it("has no groups when the level defines none (regression)", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0,1%1", gridString: EMPTY_GRID, customerString: "0;0;0.1" }),
    );
    expect(sim.columnCount).toBe(2);
    expect(sim.queueHeight).toBe(2);
    expect(sim.frontCell(0)?.group).toBe(-1);
    expect(sim.frontCell(1)?.group).toBe(-1);
    expect(sim.remainingIn(0)).toBe(2);
    expect(sim.remainingIn(1)).toBe(1);
  });

  it("a stuck combined block leaves a hole and blocks the cells behind it", () => {
    // lane0 = lane1 = [0,0,0]; a combined block sits at the middle row of
    // both columns. Picking lane0's front plain item can't free the block
    // (lane1's front is still occupied), so it stalls — leaving a hole at
    // (0,0) and keeping the item behind the block (at row 2) stuck too.
    const sim = new Simulation(
      testMap,
      level({
        queueString: "0,0,0%0,0,0$0-1,1-1$",
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0.0.0.0.0.0",
      }),
    );
    sim.pick(0);
    expect(sim.frontCell(0)).toBeNull(); // the hole
    expect(sim.queueGrid[0][1]?.group).toBe(0); // the block didn't move
    expect(sim.queueGrid[0][2]).not.toBeNull(); // stuck behind it
    expect(sim.canPick(0).ok).toBe(false);

    sim.pick(1); // frees the block's other front cell
    expect(sim.frontCell(0)?.group).toBe(0);
    expect(sim.frontCell(1)?.group).toBe(0); // the block rose into both front columns
    expect(sim.queueGrid[0][1]).not.toBeNull(); // the items behind followed it up
    expect(sim.queueGrid[1][1]).not.toBeNull();
  });

  it("a combined block is pickable from either front column and dispatches every item", () => {
    const sim = new Simulation(
      testMap,
      level({
        queueString: "0,0%0,0$0-0,1-0$",
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0.0.0.0",
      }),
      { instantFlights: false },
    );
    expect(sim.pick(1)).toBe(true); // any front column of the block works
    expect(sim.flights).toHaveLength(2);
    expect(sim.effectContext.picksMade).toBe(2);
  });

  it("a linked chain is unpickable until every member reaches the front row", () => {
    const sim = new Simulation(
      testMap,
      level({
        queueString: "0,0%0,0$$0-1,1-0",
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0.0.0.0",
      }),
    );
    expect(sim.canPick(1).ok).toBe(false);
    expect(sim.canPick(1).reason).toMatch(/not all at the front/i);
    expect(sim.canPick(0).ok).toBe(true); // the plain item fronting lane 0

    sim.pick(0); // clears the way for the linked member behind it to rise
    expect(sim.frontCell(0)?.group).toBe(0);
    expect(sim.canPick(0).ok).toBe(true);
    expect(sim.canPick(1).ok).toBe(true); // every member is at the front now

    expect(sim.pick(0)).toBe(true); // picks the whole chain, both columns
    expect(sim.frontCell(0)).toBeNull(); // lane 0 had nothing behind the chain
    // Lane 1's own plain item (behind its chain member) is unrelated to the
    // chain and rose to the front on its own — the pick didn't touch it.
    expect(sim.remainingIn(1)).toBe(1);
    expect(sim.frontCell(1)?.group).toBe(-1);
  });

  it("linking doesn't restrict movement — a member rises independently of its partner", () => {
    const sim = new Simulation(
      testMap,
      level({
        queueString: "0,0%0,0$$0-1,1-0",
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0.0.0.0",
      }),
    );
    sim.pick(0);
    // The (0,1) member rose to (0,0) on its own, even though its linked
    // partner at (1,0) never moved (it was already at the front).
    expect(sim.queueGrid[0][0]?.group).toBe(0);
    expect(sim.queueGrid[1][0]?.group).toBe(0);
  });

  it("group overflow always parks on the grid, even under block-pick", () => {
    const oneSlotMap: MapDef = {
      ...testMap,
      tools: [{ id: 0, name: "Single", numSlots: 1, cookingTime: 2, recipes: [{ in: 0, out: 0, amount: 1 }] }],
    };
    const sim = new Simulation(
      oneSlotMap,
      level({
        queueString: "0%0$0-0,1-0$",
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0.0",
      }),
      { outOfSlotPolicy: "block-pick" },
    );
    // A single item would be refused ("Single is full"), but a 2-item group
    // may always spill its overflow onto the grid — that's the mechanic.
    expect(sim.canPick(0).ok).toBe(true);
    sim.pick(0);
    expect(sim.tools[0].slots[0].item?.rawId).toBe(0);
    expect(sim.grid.some((c) => c.kind === "raw" && c.rawId === 0)).toBe(true);

    sim.runToEnd();
    expect(sim.grid.some((c) => c.kind === "raw")).toBe(false); // reclaimed
    expect(sim.status).toBe("won");
  });

  it("refuses a group pick when the grid can't hold the overflow, and rolls back cleanly", () => {
    const oneSlotMap: MapDef = {
      ...testMap,
      tools: [{ id: 0, name: "Single", numSlots: 1, cookingTime: 2, recipes: [{ in: 0, out: 0, amount: 1 }] }],
    };
    // Only cell 0 is usable; the rest are locked. Pre-picks fill the one
    // tool slot and the one usable grid cell, so the 2-item group that
    // follows has nowhere at all to go — not even one of its two items.
    const sim = new Simulation(
      oneSlotMap,
      level({
        queueString: "0%2%0%0$2-0,3-0$",
        gridString: ",#1,#1,#1,#1,#1,#1,#1,#1,#1",
        customerString: "0;0;0;0",
      }),
      { outOfSlotPolicy: "block-pick" },
    );
    sim.pick(0); // fills the only tool slot
    sim.pick(1); // ingredient 2 has no recipe — fills the only usable grid cell

    const check = sim.canPick(2);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/no space/i);
    expect(sim.pick(2)).toBe(false);
    expect(sim.queueGrid[2][0]).not.toBeNull(); // nothing left the queue
    // This is the direct regression test for the "toCell: -1" corruption
    // class: canPick() and pick() share one code path, so a refusal can
    // never leave a half-made reservation behind.
    expect(sim["reservedCells"].size).toBe(0);
    expect(sim["reservedSlots"].size).toBe(0);
  });

  it("an L-shaped combined pick can touch a frozen neighbor from two sides at once, thawing it by two in one click", () => {
    // Combined block: (0,0)-(1,0)-(1,1), an "L". The frozen item behind it at
    // (0,1) is 4-connected to BOTH (0,0) and (1,1) — two separate block
    // members — so picking the whole block in one click decrements its
    // thaw-2 count by two, clearing it immediately.
    const sim = new Simulation(
      testMap,
      level({
        queueString: "0,1#1:2%0,0$0-0,1-0,1-1$",
        gridString: EMPTY_GRID,
        customerString: "0;0;0",
      }),
    );
    expect(sim.canPick(0).ok).toBe(true); // sanity: the block fronts lane 0
    sim.pick(0); // one click, three items, two of them adjacent to the frozen cell
    expect(sim.frontCell(0)?.item.id).toBe(1); // the previously-frozen item rose to the front
    expect(sim.canPick(0).ok).toBe(true); // and is now unfrozen (thawed by 2 in one click)
  });

  it("a sweeper inside a group still triggers settle() and isn't counted in picksMade", () => {
    const sim = new Simulation(
      testMap,
      level({
        queueString: `0%${SWEEPER_ID}$0-0,1-0$`,
        gridString: EMPTY_GRID,
        customerString: "0;0;0;0",
      }),
    );
    // Seed a dirty stack directly — equivalent to what a served customer
    // leaves behind — so the sweeper in the group under test has something
    // to clear.
    sim.grid[0] = { kind: "dirty", dirtyId: DIRTY_DISH_ID, count: 1 };
    (sim as unknown as { dirtyOrder: number[] }).dirtyOrder.push(0);

    sim.pick(0); // the ingredient + the sweeper, one click
    expect(sim.grid.some((c) => c.kind === "dirty")).toBe(false); // cleared synchronously
    expect(sim.effectContext.picksMade).toBe(1); // the sweeper doesn't count
  });
});

describe("boosters", () => {
  it("clearDirtyStacks(-1) clears every dirty stack, not just one", () => {
    const sim = new Simulation(
      { ...testMap, dirtyStackHeight: 1 },
      level({
        queueString: "0,0",
        gridString: EMPTY_GRID,
        customerString: "0;0;0|0;0;0",
        serveableSlots: 1,
      }),
    );
    sim.pick(0);
    sim.tick(2);
    sim.pick(0);
    sim.tick(2);
    expect(sim.grid.filter((c) => c.kind === "dirty")).toHaveLength(2); // two separate 1-high stacks
    expect(sim.clearDirtyStacks(-1)).toBe(2);
    expect(sim.grid.filter((c) => c.kind === "dirty")).toHaveLength(0);
  });

  it("forceShiftUp rotates a plain column: the front item cycles to the back", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0,1,2", gridString: EMPTY_GRID, customerString: "0;0;0" }),
    );
    expect(sim.forceShiftUp()).toBe(true);
    expect(sim.queueGrid[0][0]?.item.id).toBe(1);
    expect(sim.queueGrid[0][1]?.item.id).toBe(2);
    expect(sim.queueGrid[0][2]?.item.id).toBe(0);
  });

  it("forceShiftUp moves a combined block as one unit, keeping its group tag, into the back of each column", () => {
    const sim = new Simulation(
      testMap,
      level({
        queueString: "0,2,2%0,2,2$0-0,1-0$",
        gridString: EMPTY_GRID,
        customerString: "0;0;0",
      }),
    );
    expect(sim.forceShiftUp()).toBe(true);
    // The block (id0, row 0 of both columns) vacated; each column's plain
    // id2's rose to fill the front, and the block refilled the back of its
    // own columns — never mixing into the other column's hole.
    expect(sim.queueGrid[0][0]?.item.id).toBe(2);
    expect(sim.queueGrid[0][0]?.group).toBe(-1);
    expect(sim.queueGrid[1][0]?.item.id).toBe(2);
    expect(sim.queueGrid[0][2]?.item.id).toBe(0);
    expect(sim.queueGrid[1][2]?.item.id).toBe(0);
    expect(sim.queueGrid[0][2]?.group).not.toBe(-1);
    expect(sim.queueGrid[0][2]?.group).toBe(sim.queueGrid[1][2]?.group);
    expect(sim.groupKinds[sim.queueGrid[0][2]!.group]).toBe("combined");
  });

  it("pickAt picks a non-front-row plain cell, leaving the front untouched", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0,1,2", gridString: EMPTY_GRID, customerString: "0;0;0" }),
    );
    expect(sim.pickAt(0, 1)).toBe(true);
    expect(sim.queueGrid[0][0]?.item.id).toBe(0); // front untouched
    expect(sim.queueGrid[0][1]?.item.id).toBe(2); // the row behind slid up into the hole
    expect(sim.remainingIn(0)).toBe(2);
  });

  it("pickAt picks a whole combined block from a non-front row", () => {
    const sim = new Simulation(
      testMap,
      level({
        queueString: "2,0,2%2,0,2$0-1,1-1$",
        gridString: EMPTY_GRID,
        customerString: "0;0;0",
      }),
    );
    expect(sim.pickAt(0, 1)).toBe(true); // targeting one member takes the whole group
    expect(sim.remainingIn(0)).toBe(2);
    expect(sim.remainingIn(1)).toBe(2);
    expect(sim.queueGrid[0][0]?.item.id).toBe(2); // the front plain item is untouched
    expect(sim.queueGrid[0][1]?.item.id).toBe(2); // row 2 slid up to fill the hole
    expect(sim.queueGrid[0][1]?.group).toBe(-1);
    expect(sim.effectContext.picksMade).toBe(2); // both block members were dispatched
  });

  it("autoCompleteDish satisfies from the backpack, then the grid, then the queue, in that priority order", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;0.0.0" }),
    );
    sim.grid[0] = { kind: "backpack", items: [0] };
    sim.grid[1] = { kind: "cooked", cookedId: 0 };
    expect(sim.autoCompleteDish()).toBe(true);
    // Completing the customer also spawns their dirty dish into the first
    // free grid cell in scan order, so cell 0 doesn't stay literally empty —
    // what matters is that nothing "cooked" or "backpack" is left on the grid.
    expect(sim.grid.some((c) => c.kind === "backpack")).toBe(false); // drained, then cleared
    expect(sim.grid.some((c) => c.kind === "cooked")).toBe(false); // grid cell taken second
    expect(sim.queueGrid[0][0]).toBeNull(); // queue's raw taken last
    expect(sim.status).toBe("won"); // the sole customer's sole dish just completed
  });

  it("autoCompleteDish takes nothing when any remaining id can't be covered from any source (all-or-nothing)", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;0.1" }), // needs cooked0 AND cooked1
    );
    sim.grid[0] = { kind: "cooked", cookedId: 0 }; // only cooked0 is available anywhere
    expect(sim.autoCompleteDish()).toBe(false);
    expect(sim.grid[0]).toEqual({ kind: "cooked", cookedId: 0 }); // left untouched
    expect(sim.queueGrid[0][0]?.item.id).toBe(0); // queue's raw0 untouched too
  });

  it("a queue raw with amount > 1 stays put until autoCompleteDish's tally reaches its yield", () => {
    // One raw3 (recipe amount 2) in the queue; two separate customers each
    // need one unit of cooked3 — the first completion only spends a "part"
    // of the raw, the second finally removes it.
    const sim = new Simulation(
      testMap,
      level({
        queueString: "3",
        gridString: EMPTY_GRID,
        customerString: "0;0;3|0;0;3",
        serveableSlots: 1,
      }),
    );
    expect(sim.autoCompleteDish()).toBe(true);
    expect(sim.queueGrid[0][0]).not.toBeNull(); // raw3 still has one part left
    expect(sim.autoCompleteDish()).toBe(true);
    expect(sim.queueGrid[0][0]).toBeNull(); // fully spent now
    expect(sim.status).toBe("won");
  });

  it("saveMe converts grid raws to cooked ingredients in the backpack and resets active customers' patience", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "10;0;0" }),
    );
    for (const c of sim.active) c.timeLeft = 0.001;
    sim.tick(1);
    expect(sim.status).toBe("lost");
    expect(sim.loseReason).toBe("customer-timeout");

    // Seeded *after* the loss, not before: tick()'s settle() would otherwise
    // reclaim a grid-parked raw into a free tool slot before saveMe() ever
    // gets to see it, since the sim is only frozen once status !== "playing".
    sim.grid[0] = { kind: "raw", rawId: 3 }; // recipe: in 3 -> out 3, amount 2
    sim.grid[1] = { kind: "cooked", cookedId: 1 };

    expect(sim.saveMe(1)).toBe(true);
    expect(sim.status).toBe("playing");
    expect(sim.loseReason).toBeNull();
    expect(sim.saveMeUsed).toBe(1);
    expect(sim.active[0].timeLeft).toBe(10); // patience reset

    const backpack = sim.grid.find((c) => c.kind === "backpack") as
      | { kind: "backpack"; items: number[] }
      | undefined;
    expect(backpack).toBeDefined();
    // raw3 (amount 2) converts to two cooked3's; the plain cooked1 carries over as-is.
    expect([...backpack!.items].sort()).toEqual([1, 3, 3]);
    // Both swept cells are cleared; the backpack itself lands in the first
    // free cell going forward (which can be one of the very cells it just
    // emptied), so only one of the two is left as plain "empty".
    expect(sim.grid.filter((c) => c.kind === "raw" || c.kind === "cooked")).toHaveLength(0);
    expect(sim.grid.filter((c) => c.kind === "backpack")).toHaveLength(1);
  });

  it("refuses saveMe when the sim isn't lost, and once maxUses is exhausted", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;0.1" }),
    );
    expect(sim.saveMe(1)).toBe(false); // not lost yet

    for (const c of sim.active) c.timeLeft = 0.001;
    sim.tick(1);
    expect(sim.status).toBe("lost");
    expect(sim.saveMe(0)).toBe(false); // maxUses already spent (0 allowed uses)

    expect(sim.saveMe(1)).toBe(true);
    expect(sim.status).toBe("playing");

    for (const c of sim.active) c.timeLeft = 0.001;
    sim.tick(1);
    expect(sim.status).toBe("lost");
    expect(sim.saveMe(1)).toBe(false); // saveMeUsed(1) already meets maxUses(1)
  });

  it("saveMe(-1) is unlimited — never refuses on exhaustion, no matter how many times it's used", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;0.1" }),
    );
    for (let i = 0; i < 5; i++) {
      for (const c of sim.active) c.timeLeft = 0.001;
      sim.tick(1);
      expect(sim.status).toBe("lost");
      expect(sim.saveMe(-1)).toBe(true);
      expect(sim.status).toBe("playing");
    }
    expect(sim.saveMeUsed).toBe(5); // still tracked, just never checked against a cap
  });

  it("autoServe prefers a backpack item over an identical item still on the grid", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;0" }),
      { instantFlights: false },
    );
    sim.grid[0] = { kind: "backpack", items: [0] };
    sim.grid[1] = { kind: "cooked", cookedId: 0 };
    sim.tick(0);
    expect(sim.flights).toHaveLength(1);
    expect(sim.flights[0].kind).toBe("backpack-to-customer");
    expect(sim.flights[0].fromCell).toBe(0);
    expect(sim.grid[1]).toEqual({ kind: "cooked", cookedId: 0 }); // the grid item is untouched
  });

  it("a backpack-to-customer flight drains one item without clearing the cell while items remain", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;0.0" }),
      { instantFlights: false },
    );
    sim.grid[0] = { kind: "backpack", items: [0, 0] };
    sim.tick(0);
    expect(sim.flights).toHaveLength(1);
    expect(sim.flights[0].kind).toBe("backpack-to-customer");

    sim.completeFlight(sim.flights[0].id);
    expect(sim.grid[0]).toEqual({ kind: "backpack", items: [0] }); // one left, cell stays
    expect(sim.flights).toHaveLength(1); // settle() inside completeFlight launched the second

    sim.completeFlight(sim.flights[0].id);
    expect(sim.grid[0]).toEqual({ kind: "empty" }); // fully drained now
    expect(sim.status).toBe("won");
  });
});
