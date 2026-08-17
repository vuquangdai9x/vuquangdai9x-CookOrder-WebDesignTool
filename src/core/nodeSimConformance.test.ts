// Conformance: NodeSimulation reproducing sim.test.ts, case by case.
//
// Every test here names the legacy test it mirrors. The fixtures are the SAME
// `testMap`/`level()` from testFixtures.ts, lifted through `legacyToGraph`, so
// a divergence means the graph runtime really behaves differently — not that
// the two were set up differently.
//
// `sim.test.ts` is never edited. If a case here fails, the port is wrong.

import { describe, expect, it } from "vitest";
import { cookedName, dirtyName, legacyLevelToNode, legacyToGraph, pickupName } from "./legacyToGraph.ts";
import { buildIndex } from "./nodeIndex.ts";
import type { GraphIndex } from "./nodeIndex.ts";
import { DIRTY_DISH_ID, NodeSimulation } from "./nodeSim.ts";
import type { NodeSimOptions } from "./nodeSim.ts";
import { SWEEPER_ID } from "./parser.ts";
import { EMPTY_GRID, level, testMap } from "./testFixtures.ts";
import type { LevelConfig, MapDef } from "./types.ts";

interface Strings {
  queueString: string;
  gridString?: string;
  customerString: string;
  serveableSlots?: number;
  weather?: string;
}

interface Bound {
  sim: NodeSimulation;
  ix: GraphIndex;
  /** Dense ingredient index for a legacy COOKED id. */
  ck: (id: number) => number;
  /** Dense ingredient index for a legacy RAW id. */
  rw: (id: number) => number;
  /** Dense dirty index for a legacy dirty-object id. */
  dt: (id: number) => number;
}

/** Builds the legacy level, lifts the map into a graph, and binds a sim to it. */
function bind(o: Strings, map: MapDef = testMap, options: NodeSimOptions = {}): Bound {
  const legacy: LevelConfig = level({ gridString: EMPTY_GRID, ...o });
  const doc = legacyToGraph(map, [legacy]);
  const ix = buildIndex(doc);
  const projected = legacyLevelToNode(doc, legacy);
  if (projected.unplaced.length > 0) {
    throw new Error(`fixture dish could not be placed: ${JSON.stringify(projected.unplaced)}`);
  }
  const find = (name: string) => {
    const i = doc.vertices.ingredient.findIndex((v) => v.name === name);
    if (i === -1) throw new Error(`no ingredient "${name}" in the projected graph`);
    return i;
  };
  return {
    sim: new NodeSimulation(ix, projected.level, options),
    ix,
    ck: (id) => find(cookedName(id)),
    rw: (id) => find(pickupName(map, id)),
    dt: (id) => doc.vertices.dirty.findIndex((v) => v.name === dirtyName(id)),
  };
}

// ---------------------------------------------------------------- core loop

describe("simulation core loop", () => {
  it("serves a customer and wins", () => {
    const { sim } = bind({ queueString: "0,1", customerString: "0;0;0.1" });
    expect(sim.active).toHaveLength(1);
    sim.pick(0);
    sim.pick(0);
    sim.runToEnd();
    expect(sim.status).toBe("won");
    expect(sim.servedCount).toBe(1);
  });

  it("places cooked output in the first free cell in scan order", () => {
    const { sim, ck } = bind({ queueString: "0", customerString: "0;0;1" });
    sim.pick(0);
    sim.tick(2);
    expect(sim.grid[0]).toEqual({ kind: "cooked", ing: ck(0) });
    expect(sim.grid[1]).toEqual({ kind: "empty" });
  });

  it("skips blocked cells when placing", () => {
    const { sim, ck } = bind({
      queueString: "0",
      gridString: "#1,,,,,,,,,",
      customerString: "0;0;1",
    });
    sim.pick(0);
    sim.tick(2);
    expect(sim.grid[0]).toEqual({ kind: "empty" });
    expect(sim.grid[1]).toEqual({ kind: "cooked", ing: ck(0) });
  });

  it("loses when a tool's output has nowhere to go", () => {
    const { sim } = bind({
      queueString: "3",
      gridString: ",#1,#1,#1,#1,#1,#1,#1,#1,#1",
      customerString: "0;0;0",
    });
    sim.pick(0);
    sim.runToEnd();
    expect(sim.status).toBe("lost");
    expect(sim.loseReason).toBe("grid-overflow");
  });

  it("refuses a pick that has nowhere to land at all", () => {
    const { sim } = bind({
      queueString: "2",
      gridString: "#1,#1,#1,#1,#1,#1,#1,#1,#1,#1",
      customerString: "0;0;0",
    });
    const check = sim.canPick(0);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/no free grid cell/i);
    expect(sim.pick(0)).toBe(false);
  });

  it("loses when queues run dry with orders outstanding", () => {
    const { sim } = bind({ queueString: "0", customerString: "0;0;0.1" });
    sim.pick(0);
    sim.runToEnd();
    expect(sim.status).toBe("lost");
    expect(sim.loseReason).toBe("out-of-ingredient");
  });

  it("loses when a customer's patience runs out", () => {
    const { sim } = bind({ queueString: "0,0", customerString: "5;0;0.1" });
    sim.runToEnd();
    expect(sim.status).toBe("lost");
    expect(sim.loseReason).toBe("customer-timeout");
  });

  it("halves patience for weather-affected customers on bad-weather levels", () => {
    const rainy = bind({ queueString: "0", customerString: "60;1;0", weather: "Rainy" });
    expect(rainy.sim.active[0].timeLeft).toBe(30);
    const normal = bind({ queueString: "0", customerString: "60;1;0" });
    expect(normal.sim.active[0].timeLeft).toBe(60);
  });
});

// ------------------------------------------------------------------- gating

describe("base ingredient requirement", () => {
  // cooked1 needs cooked0 first — legacy expresses that with baseId; the graph
  // turns it into a topping edge, and the projection recovers it.
  const baseMap: MapDef = {
    ...testMap,
    cookedIngredients: testMap.cookedIngredients.map((c) => (c.id === 1 ? { ...c, baseId: 0 } : c)),
  };

  it("withholds the dependent ingredient until its base is in the dish, then serves it", () => {
    const { sim, ck } = bind(
      { queueString: "1,0", customerString: "0;0;1.0" },
      baseMap,
      { instantFlights: false },
    );
    sim.pick(0); // the topping into the tool
    sim.pick(0); // the base into the tool
    for (const f of [...sim.flights]) sim.completeFlight(f.id);
    sim.tick(2);

    // The base has no gate, so it flies straight to the customer; the topping
    // is withheld and lands on the grid instead.
    expect(sim.flights).toHaveLength(2);
    const direct = sim.flights.find((f) => f.kind === "tool-to-customer")!;
    expect(direct.ing).toBe(ck(0));
    const toGrid = sim.flights.find((f) => f.kind === "tool-to-grid")!;
    expect(toGrid.ing).toBe(ck(1));

    sim.completeFlight(toGrid.id);
    const dish = sim.active[0].dishes[0];
    expect(dish.filled.filter(Boolean)).toHaveLength(0);

    sim.completeFlight(direct.id); // base served — settle() now finds the topping servable
    expect(sim.flights).toHaveLength(1);
    expect(sim.flights[0].kind).toBe("grid-to-customer");
    expect(sim.flights[0].ing).toBe(ck(1));

    sim.completeFlight(sim.flights[0].id);
    expect(sim.status).toBe("won");
  });
});

describe("multi-option base ingredient requirement", () => {
  // cooked0 needs EITHER cooked1 or cooked2 — legacy's `baseId: Id[]`. The
  // adapter folds all three into one composite whose base slot holds 1 and 2.
  const multiBaseMap: MapDef = {
    ...testMap,
    cookedIngredients: testMap.cookedIngredients.map((c) => (c.id === 0 ? { ...c, baseId: [1, 2] } : c)),
  };

  it("serves once any one of several listed base options is already in the dish", () => {
    const { sim } = bind({ queueString: "2,0", customerString: "0;0;0.2" }, multiBaseMap);
    sim.pick(0); // cooked2 — satisfies the base requirement
    sim.pick(0); // cooked0 — needs a base, now met
    sim.tick(1);
    sim.tick(0);
    expect(sim.status).toBe("won");
  });
});

// -------------------------------------------------------------------- tools

describe("chained tool recipes", () => {
  const chainMap: MapDef = {
    ...testMap,
    tools: [
      { id: 0, name: "A", numSlots: 1, cookingTime: 1, recipes: [{ in: 2, out: 2, amount: 1, chainTools: [1] }] },
      { id: 1, name: "B", numSlots: 1, cookingTime: 1, recipes: [] },
    ],
  };

  it("hops through each tool in the chain before producing output", () => {
    const { sim, rw } = bind({ queueString: "2", customerString: "0;0;2" }, chainMap, {
      instantFlights: false,
    });
    sim.pick(0);
    sim.completeFlight(sim.flights[0].id); // lands in tool A's slot

    sim.tick(1); // A finishes -> hops to tool B, not the grid
    expect(sim.flights).toHaveLength(1);
    expect(sim.flights[0].kind).toBe("tool-to-tool");
    expect(sim.tools[0].slots[0].item).toBeNull();
    expect(sim.grid.every((c) => c.kind === "empty")).toBe(true);

    sim.completeFlight(sim.flights[0].id);
    expect(sim.tools[1].slots[0].item?.ing).toBe(rw(2));

    sim.tick(1); // B finishes -> the waiting customer takes it directly
    expect(sim.flights).toHaveLength(1);
    expect(sim.flights[0].kind).toBe("tool-to-customer");
    sim.completeFlight(sim.flights[0].id);
    expect(sim.status).toBe("won");
  });

  it("waits at the first tool when the next has no free slot, then hops once one frees", () => {
    const busyChainMap: MapDef = {
      ...chainMap,
      tools: [chainMap.tools[0], { ...chainMap.tools[1], cookingTime: 100 }],
    };
    const { sim, rw } = bind({ queueString: "2", customerString: "0;0;2" }, busyChainMap, {
      instantFlights: false,
    });
    sim.tools[1].slots[0].item = { uid: 999, ing: rw(1), elapsed: 0, duration: 100 }; // occupy B

    sim.pick(0);
    sim.completeFlight(sim.flights[0].id);
    sim.tick(1); // A finishes, but B is full -> stays put at A

    expect(sim.flights).toHaveLength(0);
    expect(sim.tools[0].slots[0].item?.ing).toBe(rw(2));

    sim.tools[1].slots[0].item = null;
    sim.tick(0);
    expect(sim.flights).toHaveLength(1);
    expect(sim.flights[0].kind).toBe("tool-to-tool");
  });
});

describe("multi-use cooked ingredients", () => {
  const multiUseMap: MapDef = {
    ...testMap,
    cookedIngredients: testMap.cookedIngredients.map((c) => (c.id === 0 ? { ...c, usageNum: 2 } : c)),
  };

  it("decrements usesLeft on serve instead of clearing, then clears once exhausted", () => {
    const { sim, ck } = bind({ queueString: "0", customerString: "0;0;0|0;0;0" }, multiUseMap, {
      instantFlights: false,
    });
    sim.pick(0);
    sim.completeFlight(sim.flights[0].id);
    sim.tick(1); // usageNum > 1 blocks the direct-serve shortcut

    sim.completeFlight(sim.flights.find((f) => f.kind === "tool-to-grid")!.id);
    expect(sim.grid).toContainEqual({ kind: "cooked", ing: ck(0), usesLeft: 2 });

    sim.tick(0);
    sim.completeFlight(sim.flights.find((f) => f.kind === "grid-to-customer")!.id);
    expect(sim.active).toHaveLength(1);
    expect(sim.grid).toContainEqual({ kind: "cooked", ing: ck(0), usesLeft: 1 });

    sim.tick(0);
    sim.completeFlight(sim.flights.find((f) => f.kind === "grid-to-customer")!.id);
    expect(sim.grid.every((c) => c.kind !== "cooked")).toBe(true);
    expect(sim.status).toBe("won");
  });
});

describe("cooking tools", () => {
  const oneSlotMap: MapDef = {
    ...testMap,
    tools: [{ id: 0, name: "Single", numSlots: 1, cookingTime: 2, recipes: [{ in: 0, out: 0, amount: 1 }] }],
  };

  it("puts a picked ingredient into a free slot of its tool", () => {
    const { sim, rw } = bind({ queueString: "0,1", customerString: "0;0;0.1" });
    sim.pick(0);
    expect(sim.tools[0].slots[0].item?.ing).toBe(rw(0));
    expect(sim.cookingCount).toBe(1);
  });

  it("yields several pieces from one raw unit", () => {
    const { sim } = bind({ queueString: "3", customerString: "0;0;3.3" });
    sim.pick(0);
    sim.tick(2);
    expect(sim.status).toBe("won");
  });

  it("sends an ingredient with no tool straight to the grid", () => {
    const { sim } = bind({ queueString: "2", customerString: "0;0;2" });
    sim.pick(0);
    expect(sim.cookingCount).toBe(0);
    sim.tick(0.1);
    expect(sim.status).toBe("won");
  });

  it("blocks the pick when the tool is full under the block-pick policy", () => {
    const { sim } = bind({ queueString: "0,0", customerString: "0;0;0.0" }, oneSlotMap, {
      outOfSlotPolicy: "block-pick",
    });
    expect(sim.pick(0)).toBe(true);
    const check = sim.canPick(0);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/full/i);
    expect(sim.pick(0)).toBe(false);
  });

  it("parks the raw on the grid and reclaims it when a slot frees", () => {
    const { sim, rw } = bind({ queueString: "0,0", customerString: "0;0;0.0" }, oneSlotMap, {
      outOfSlotPolicy: "park-on-grid",
    });
    sim.pick(0);
    expect(sim.pick(0)).toBe(true);
    expect(sim.grid.some((c) => c.kind === "raw" && c.ing === rw(0))).toBe(true);

    sim.runToEnd();
    expect(sim.grid.some((c) => c.kind === "raw")).toBe(false);
    expect(sim.status).toBe("won");
  });

  it("prioritises a parked raw over leaving the slot idle", () => {
    const { sim, rw } = bind({ queueString: "0,0", customerString: "0;0;0.0" }, oneSlotMap, {
      outOfSlotPolicy: "park-on-grid",
    });
    sim.pick(0);
    sim.pick(0);
    sim.tick(2.1);
    expect(sim.tools[0].slots[0].item?.ing).toBe(rw(0));
  });

  it("doesn't leak grid-cell reservations across repeated park+reclaim cycles", () => {
    const tinyGridMap: MapDef = { ...oneSlotMap, gridWidth: 2, gridHeight: 1 };
    const cycles = 6;
    const totalPicks = 2 + cycles;
    const { sim } = bind(
      {
        queueString: Array(totalPicks).fill(0).join(","),
        gridString: ",",
        customerString: "0;0;0;" + Array(totalPicks).fill(0).join("."),
      },
      tinyGridMap,
      { outOfSlotPolicy: "park-on-grid" },
    );
    sim.pick(0);
    sim.pick(0);
    for (let i = 0; i < cycles; i++) {
      sim.tick(2.1);
      if (sim.canPick(0).ok) sim.pick(0);
    }
    sim.runToEnd();
    expect(sim.status).toBe("won");
    expect(sim.loseReason).toBeNull();
    expect(sim["reservedCells"].size).toBe(0);
  });
});

// ------------------------------------------------------------------ flights

describe("flight gating", () => {
  it("holds a transfer until the host completes it", () => {
    const { sim, rw } = bind({ queueString: "0", customerString: "0;0;0" }, testMap, {
      instantFlights: false,
    });
    sim.pick(0);
    expect(sim.flights).toHaveLength(1);
    expect(sim.flights[0].kind).toBe("queue-to-tool");
    expect(sim.tools[0].slots[0].item).toBeNull();

    sim.tick(5); // nothing is in the slot, so nothing can cook
    expect(sim.tools[0].slots[0].item).toBeNull();

    sim.completeFlight(sim.flights[0].id);
    expect(sim.tools[0].slots[0].item?.ing).toBe(rw(0));
  });

  it("flies a finished item directly to a waiting customer, skipping the grid", () => {
    const { sim } = bind({ queueString: "0", customerString: "0;0;0" }, testMap, {
      instantFlights: false,
    });
    sim.pick(0);
    sim.completeAllFlights();
    sim.tick(1.1);

    expect(sim.flights).toHaveLength(1);
    expect(sim.flights[0].kind).toBe("tool-to-customer");
    expect(sim.grid.every((c) => c.kind === "empty")).toBe(true);

    sim.completeFlight(sim.flights[0].id);
    expect(sim.status).toBe("won");
  });

  it("flies the dirty dish from the customer to the grid", () => {
    const { sim } = bind({ queueString: "0", customerString: "0;0;0" }, testMap, {
      instantFlights: false,
    });
    sim.pick(0);
    sim.completeFlight(sim.flights[0].id);
    sim.tick(1.1);
    sim.completeFlight(sim.flights.find((f) => f.kind === "tool-to-customer")!.id);

    const dirty = sim.flights.find((f) => f.kind === "customer-to-grid");
    expect(dirty).toBeDefined();
    expect(dirty!.fromCustomer).toBe(0);
    expect(sim.grid.some((c) => c.kind === "dirty")).toBe(false); // still travelling

    sim.completeFlight(dirty!.id);
    expect(sim.grid.some((c) => c.kind === "dirty")).toBe(true);
  });

  it("stacks simultaneous dirty dishes without exceeding the stack height", () => {
    const { sim } = bind(
      { queueString: "2,2", customerString: "0;0;2|0;0;2", serveableSlots: 2 },
      { ...testMap, dirtyStackHeight: 1 },
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
    const { sim } = bind({ queueString: "0", customerString: "0;0;0" }, testMap, {
      instantFlights: false,
    });
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
    const { sim } = bind({
      queueString: "0,1",
      customerString: "0;0;0|0;0;1",
      serveableSlots: 1,
    });
    sim.pick(0);
    sim.pick(0);
    sim.fastForward();
    expect(sim.servedCount).toBe(2);
    expect(sim.status).toBe("won");
  });
});

describe("fastForward (skip button)", () => {
  it("resolves in-flight cooking and stops, instead of burning the whole clock", () => {
    const { sim, ck } = bind({ queueString: "0,1", customerString: "0;0;0.1" });
    sim.pick(0);
    const advanced = sim.fastForward();
    expect(advanced).toBeLessThanOrEqual(2);
    expect(sim.cookingCount).toBe(0);
    expect(sim.status).toBe("playing");
    expect(sim.active[0].dishes[0].filled.filter(Boolean)).toHaveLength(1);
    expect(sim.active[0].dishes[0].remaining).toEqual([ck(1)]);
  });

  it("does not time a customer out during a step that serves them", () => {
    const { sim } = bind({ queueString: "0", customerString: "1;0;0" });
    sim.pick(0);
    sim.fastForward();
    expect(sim.status).toBe("won");
  });
});

// ----------------------------------------------------- slots, dirty, staff

describe("serve slots and dirty dishes", () => {
  it("holds later customers until a slot frees up", () => {
    const { sim } = bind({
      queueString: "0,0,0",
      customerString: "0;0;0|0;0;0|0;0;0",
      serveableSlots: 2,
    });
    expect(sim.active).toHaveLength(2);
    expect(sim.pending).toHaveLength(1);
    sim.pick(0);
    sim.tick(2);
    expect(sim.servedCount).toBe(1);
    expect(sim.active).toHaveLength(2);
  });

  it("stacks dirty dishes up to dirtyStackHeight then opens a new stack", () => {
    const { sim } = bind(
      { queueString: "0,0,0", customerString: "0;0;0|0;0;0|0;0;0", serveableSlots: 1 },
      { ...testMap, dirtyStackHeight: 2 },
    );
    for (let i = 0; i < 3; i++) {
      sim.pick(0);
      sim.tick(2);
    }
    expect(sim.status).toBe("won");
    const dirty = sim.grid.filter((c) => c.kind === "dirty");
    expect(dirty).toHaveLength(2);
    expect(dirty.map((c) => (c as { count: number }).count).sort()).toEqual([1, 2]);
    // testMap defines no dirty objects, so every stack falls back to the
    // generic sentinel — the same rule legacy applies.
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
    const { sim, dt } = bind(
      { queueString: "0,1", customerString: "0;0;0;0|0;0;0;1", serveableSlots: 2 },
      dirtyMap,
    );
    sim.pick(0);
    sim.pick(0);
    sim.tick(2);
    expect(sim.status).toBe("won");
    const dirty = sim.grid.filter((c) => c.kind === "dirty") as { dirtyId: number; count: number }[];
    expect(dirty).toHaveLength(2);
    expect(dirty.map((c) => c.dirtyId).sort()).toEqual([dt(10), dt(11)].sort());
    expect(dirty.every((c) => c.count === 1)).toBe(true);
  });

  it("clears the oldest dirty stack when a sweeper is picked", () => {
    const { sim } = bind(
      {
        queueString: `0,${SWEEPER_ID}`,
        customerString: "0;0;0|0;0;0",
        serveableSlots: 1,
      },
      { ...testMap, dirtyStackHeight: 1 },
    );
    sim.pick(0);
    sim.tick(2);
    expect(sim.grid.filter((c) => c.kind === "dirty")).toHaveLength(1);
    sim.pick(0); // sweeper
    expect(sim.grid.filter((c) => c.kind === "dirty")).toHaveLength(0);
  });

  it("treats a dish-less customer as staff clearing dirty stacks", () => {
    const { sim } = bind(
      { queueString: "0", customerString: "0;0;0|0;0;", serveableSlots: 1 },
      { ...testMap, dirtyStackHeight: 1 },
    );
    sim.pick(0);
    sim.tick(2);
    expect(sim.status).toBe("won");
    expect(sim.grid.filter((c) => c.kind === "dirty")).toHaveLength(0);
  });

  it("flight-gates staff clearing: N flights for N stacks, celebration only once all land", () => {
    const { sim } = bind(
      {
        queueString: "2,2,2",
        customerString: "0;0;2|0;0;2|0;0;2|0;0;;2",
        serveableSlots: 1,
      },
      { ...testMap, dirtyStackHeight: 1 },
      { instantFlights: false },
    );
    const complete = (kind: string) => {
      const f = sim.flights.find((fl) => fl.kind === kind);
      if (!f) throw new Error(`no pending flight of kind ${kind}`);
      sim.completeFlight(f.id);
    };

    sim.pick(0);
    sim.pick(0);
    sim.pick(0);

    complete("queue-to-customer");
    complete("customer-to-grid");

    complete("queue-to-grid");
    complete("grid-to-customer");
    complete("customer-to-grid");
    expect(sim.grid.filter((c) => c.kind === "dirty")).toHaveLength(2);

    complete("queue-to-grid");
    complete("grid-to-customer");

    const staffFlights = sim.flights.filter((f) => f.kind === "dirty-to-staff");
    expect(staffFlights).toHaveLength(2);
    const staffIndex = staffFlights[0].toCustomer!.index;
    expect(sim.active.some((c) => c.index === staffIndex && c.isStaff)).toBe(true);

    sim.completeFlight(staffFlights[0].id);
    expect(sim.active.some((c) => c.index === staffIndex)).toBe(true);
    expect(sim.events.some((e) => e.type === "served" && e.customerIndex === staffIndex)).toBe(false);

    sim.completeFlight(staffFlights[1].id);
    expect(sim.active.some((c) => c.index === staffIndex)).toBe(false);
    expect(sim.events.some((e) => e.type === "served" && e.customerIndex === staffIndex)).toBe(true);
  });

  it("a staff with nothing to clear finishes immediately with no flight", () => {
    const { sim } = bind({ queueString: "0", customerString: "0;0;;5" }, testMap, {
      instantFlights: false,
    });
    expect(sim.flights.filter((f) => f.kind === "dirty-to-staff")).toHaveLength(0);
    expect(sim.active).toHaveLength(0);
    expect(sim.servedCount).toBe(1);
  });
});

// ------------------------------------------------------------------ effects

describe("effects", () => {
  it("blocks picking a frozen item until enough ADJACENT picks happen", () => {
    const { sim } = bind({ queueString: "0#1:2%0,1", customerString: "0;0;0" });
    expect(sim.canPick(0).ok).toBe(false);
    expect(sim.canPick(0).reason).toMatch(/frozen/i);
    sim.pick(1);
    expect(sim.canPick(0).ok).toBe(false);
    sim.pick(1);
    expect(sim.canPick(0).ok).toBe(true);
  });

  it("a pick in a NON-adjacent column doesn't thaw a frozen item", () => {
    const { sim } = bind({ queueString: "0#1:1%0%0", customerString: "0;0;0" });
    sim.pick(2);
    expect(sim.canPick(0).ok).toBe(false);
    sim.pick(1);
    expect(sim.canPick(0).ok).toBe(true);
  });

  it("opens a ColorLock cell once matching keys are collected", () => {
    const { sim } = bind({
      queueString: "0#3:1,0",
      gridString: "#4:1:1,,,,,,,,,",
      customerString: "0;0;0",
    });
    expect(sim.isCellUsable(0)).toBe(false);
    expect(sim.cellLockLabel(0)).toBe("0/1 keys");
    sim.pick(0);
    expect(sim.isCellUsable(0)).toBe(true);
    expect(sim.cellLockLabel(0)).toBeNull();
  });

  it("opens an ingredient-slot cell only for its own ingredient", () => {
    // The cell's param is a RAW INGREDIENT id, so the projection has to remap
    // it alongside the queue — see migrateGridCells(). If it didn't, this cell
    // would be counting some other ingredient entirely.
    const { sim } = bind({
      queueString: "0,0%1,1",
      gridString: "#3:1:2,,,,,,,,,",
      customerString: "0;0;0",
    });
    expect(sim.isCellUsable(0)).toBe(false);
    sim.pick(0); // wrong ingredient — no progress
    sim.pick(0);
    expect(sim.cellLockLabel(0)).toBe("0/2");
    sim.pick(1);
    expect(sim.cellLockLabel(0)).toBe("1/2");
    sim.pick(1);
    expect(sim.isCellUsable(0)).toBe(true);
  });

  it("opens an OrderLock cell after enough customers are served", () => {
    const { sim } = bind({
      queueString: "0,0",
      gridString: ",#2:1,,,,,,,,",
      customerString: "0;0;0|0;0;0",
      serveableSlots: 1,
    });
    expect(sim.isCellUsable(1)).toBe(false);
    sim.pick(0);
    sim.tick(2);
    expect(sim.isCellUsable(1)).toBe(true);
  });
});

// ------------------------------------------------------------- queue groups

describe("queue groups", () => {
  it("has no groups when the level defines none", () => {
    const { sim } = bind({ queueString: "0,1%1", customerString: "0;0;0.1" });
    expect(sim.columnCount).toBe(2);
    expect(sim.queueHeight).toBe(2);
    expect(sim.frontCell(0)?.group).toBe(-1);
    expect(sim.frontCell(1)?.group).toBe(-1);
    expect(sim.remainingIn(0)).toBe(2);
    expect(sim.remainingIn(1)).toBe(1);
  });

  it("a stuck combined block leaves a hole and blocks the cells behind it", () => {
    const { sim } = bind({
      queueString: "0,0,0%0,0,0$0-1,1-1$",
      customerString: "0;0;0;0.0.0.0.0.0",
    });
    sim.pick(0);
    expect(sim.frontCell(0)).toBeNull();
    expect(sim.queueGrid[0][1]?.group).toBe(0);
    expect(sim.queueGrid[0][2]).not.toBeNull();
    expect(sim.canPick(0).ok).toBe(false);

    sim.pick(1);
    expect(sim.frontCell(0)?.group).toBe(0);
    expect(sim.frontCell(1)?.group).toBe(0);
    expect(sim.queueGrid[0][1]).not.toBeNull();
    expect(sim.queueGrid[1][1]).not.toBeNull();
  });

  it("a combined block is pickable from either front column and dispatches every item", () => {
    const { sim } = bind(
      { queueString: "0,0%0,0$0-0,1-0$", customerString: "0;0;0;0.0.0.0" },
      testMap,
      { instantFlights: false },
    );
    expect(sim.pick(1)).toBe(true);
    expect(sim.flights).toHaveLength(2);
    expect(sim.effectContext.picksMade).toBe(2);
  });

  it("a linked chain is unpickable until every member reaches the front row", () => {
    const { sim } = bind({
      queueString: "0,0%0,0$$0-1,1-0",
      customerString: "0;0;0;0.0.0.0",
    });
    expect(sim.canPick(1).ok).toBe(false);
    expect(sim.canPick(1).reason).toMatch(/not all at the front/i);
    expect(sim.canPick(0).ok).toBe(true);

    sim.pick(0);
    expect(sim.frontCell(0)?.group).toBe(0);
    expect(sim.canPick(1).ok).toBe(true);

    expect(sim.pick(0)).toBe(true);
    expect(sim.frontCell(0)).toBeNull();
    expect(sim.remainingIn(1)).toBe(1);
    expect(sim.frontCell(1)?.group).toBe(-1);
  });

  it("linking doesn't restrict movement — a member rises independently", () => {
    const { sim } = bind({
      queueString: "0,0%0,0$$0-1,1-0",
      customerString: "0;0;0;0.0.0.0",
    });
    sim.pick(0);
    expect(sim.queueGrid[0][0]?.group).toBe(0);
    expect(sim.queueGrid[1][0]?.group).toBe(0);
  });

  it("group overflow always parks on the grid, even under block-pick", () => {
    const oneSlotMap: MapDef = {
      ...testMap,
      tools: [{ id: 0, name: "Single", numSlots: 1, cookingTime: 2, recipes: [{ in: 0, out: 0, amount: 1 }] }],
    };
    const { sim, rw } = bind(
      { queueString: "0%0$0-0,1-0$", customerString: "0;0;0;0.0" },
      oneSlotMap,
      { outOfSlotPolicy: "block-pick" },
    );
    expect(sim.canPick(0).ok).toBe(true);
    sim.pick(0);
    expect(sim.tools[0].slots[0].item?.ing).toBe(rw(0));
    expect(sim.grid.some((c) => c.kind === "raw" && c.ing === rw(0))).toBe(true);

    sim.runToEnd();
    expect(sim.grid.some((c) => c.kind === "raw")).toBe(false);
    expect(sim.status).toBe("won");
  });

  it("refuses a group pick when the grid can't hold the overflow, and rolls back cleanly", () => {
    const oneSlotMap: MapDef = {
      ...testMap,
      tools: [{ id: 0, name: "Single", numSlots: 1, cookingTime: 2, recipes: [{ in: 0, out: 0, amount: 1 }] }],
    };
    const { sim } = bind(
      {
        queueString: "0%2%0%0$2-0,3-0$",
        gridString: ",#1,#1,#1,#1,#1,#1,#1,#1,#1",
        customerString: "0;0;0;0",
      },
      oneSlotMap,
      { outOfSlotPolicy: "block-pick" },
    );
    sim.pick(0);
    sim.pick(1);

    const check = sim.canPick(2);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/no space/i);
    expect(sim.pick(2)).toBe(false);
    expect(sim.queueGrid[2][0]).not.toBeNull();
    // The direct regression test for the "toCell: -1" corruption class:
    // canPick() and pick() share one path, so a refusal can never leave a
    // half-made reservation behind.
    expect(sim["reservedCells"].size).toBe(0);
    expect(sim["reservedSlots"].size).toBe(0);
  });

  it("an L-shaped combined pick thaws a frozen neighbor from two sides at once", () => {
    // The block is (0,0)-(1,0)-(1,1); the frozen item at (0,1) is 4-connected
    // to two of its members, so one click decrements the thaw-2 count twice.
    const { sim, rw } = bind({
      queueString: "0,1#1:2%0,0$0-0,1-0,1-1$",
      customerString: "0;0;0",
    });
    expect(sim.canPick(0).ok).toBe(true);
    sim.pick(0);
    expect(sim.frontCell(0)?.ing).toBe(rw(1)); // the frozen item rose to the front
    expect(sim.freezeCount(sim.frontCell(0)!.item)).toBe(0);
    expect(sim.canPick(0).ok).toBe(true);
  });

  it("a sweeper inside a group still triggers settle() and isn't counted in picksMade", () => {
    const { sim } = bind({
      queueString: `0%${SWEEPER_ID}$0-0,1-0$`,
      customerString: "0;0;0;0",
    });
    sim.grid[0] = { kind: "dirty", dirtyId: DIRTY_DISH_ID, count: 1 };
    (sim as unknown as { dirtyOrder: number[] }).dirtyOrder.push(0);

    sim.pick(0);
    expect(sim.grid.some((c) => c.kind === "dirty")).toBe(false);
    expect(sim.effectContext.picksMade).toBe(1);
  });
});

// ----------------------------------------------------------------- boosters

describe("boosters", () => {
  it("clearDirtyStacks(-1) clears every dirty stack, not just one", () => {
    const { sim } = bind(
      { queueString: "0,0", customerString: "0;0;0|0;0;0", serveableSlots: 1 },
      { ...testMap, dirtyStackHeight: 1 },
    );
    sim.pick(0);
    sim.tick(2);
    sim.pick(0);
    sim.tick(2);
    expect(sim.grid.filter((c) => c.kind === "dirty")).toHaveLength(2);
    expect(sim.clearDirtyStacks(-1)).toBe(2);
    expect(sim.grid.filter((c) => c.kind === "dirty")).toHaveLength(0);
  });

  it("forceShiftUp rotates a plain column: the front item cycles to the back", () => {
    const { sim, rw } = bind({ queueString: "0,1,2", customerString: "0;0;0" });
    expect(sim.forceShiftUp()).toBe(true);
    expect(sim.queueGrid[0][0]?.ing).toBe(rw(1));
    expect(sim.queueGrid[0][1]?.ing).toBe(rw(2));
    expect(sim.queueGrid[0][2]?.ing).toBe(rw(0));
  });

  it("forceShiftUp moves a combined block as one unit into the back of each column", () => {
    const { sim, rw } = bind({
      queueString: "0,2,2%0,2,2$0-0,1-0$",
      customerString: "0;0;0",
    });
    expect(sim.forceShiftUp()).toBe(true);
    expect(sim.queueGrid[0][0]?.ing).toBe(rw(2));
    expect(sim.queueGrid[0][0]?.group).toBe(-1);
    expect(sim.queueGrid[1][0]?.ing).toBe(rw(2));
    expect(sim.queueGrid[0][2]?.ing).toBe(rw(0));
    expect(sim.queueGrid[1][2]?.ing).toBe(rw(0));
    expect(sim.queueGrid[0][2]?.group).not.toBe(-1);
    expect(sim.queueGrid[0][2]?.group).toBe(sim.queueGrid[1][2]?.group);
    expect(sim.groupKinds[sim.queueGrid[0][2]!.group]).toBe("combined");
  });

  it("pickAt picks a non-front-row plain cell, leaving the front untouched", () => {
    const { sim, rw } = bind({ queueString: "0,1,2", customerString: "0;0;0" });
    expect(sim.pickAt(0, 1)).toBe(true);
    expect(sim.queueGrid[0][0]?.ing).toBe(rw(0));
    expect(sim.queueGrid[0][1]?.ing).toBe(rw(2));
    expect(sim.remainingIn(0)).toBe(2);
  });

  it("pickAt picks a whole combined block from a non-front row", () => {
    const { sim, rw } = bind({
      queueString: "2,0,2%2,0,2$0-1,1-1$",
      customerString: "0;0;0",
    });
    expect(sim.pickAt(0, 1)).toBe(true);
    expect(sim.remainingIn(0)).toBe(2);
    expect(sim.remainingIn(1)).toBe(2);
    expect(sim.queueGrid[0][0]?.ing).toBe(rw(2));
    expect(sim.queueGrid[0][1]?.ing).toBe(rw(2));
    expect(sim.queueGrid[0][1]?.group).toBe(-1);
    expect(sim.effectContext.picksMade).toBe(2);
  });

  it("autoCompleteDish satisfies from the backpack, then the grid, then the queue", () => {
    const { sim, ck } = bind({ queueString: "0", customerString: "0;0;0.0.0" });
    sim.grid[0] = { kind: "backpack", items: [ck(0)] };
    sim.grid[1] = { kind: "cooked", ing: ck(0) };
    expect(sim.autoCompleteDish()).toBe(true);
    expect(sim.grid.some((c) => c.kind === "backpack")).toBe(false);
    expect(sim.grid.some((c) => c.kind === "cooked")).toBe(false);
    expect(sim.queueGrid[0][0]).toBeNull();
    expect(sim.status).toBe("won");
  });

  it("autoCompleteDish takes nothing when a slot can't be covered (all-or-nothing)", () => {
    const { sim, ck, rw } = bind({ queueString: "0", customerString: "0;0;0.1" });
    sim.grid[0] = { kind: "cooked", ing: ck(0) };
    expect(sim.autoCompleteDish()).toBe(false);
    expect(sim.grid[0]).toEqual({ kind: "cooked", ing: ck(0) });
    expect(sim.queueGrid[0][0]?.ing).toBe(rw(0));
  });

  it("a queue raw with amount > 1 stays put until autoCompleteDish's tally reaches its yield", () => {
    const { sim } = bind({
      queueString: "3",
      customerString: "0;0;3|0;0;3",
      serveableSlots: 1,
    });
    expect(sim.autoCompleteDish()).toBe(true);
    expect(sim.queueGrid[0][0]).not.toBeNull();
    expect(sim.autoCompleteDish()).toBe(true);
    expect(sim.queueGrid[0][0]).toBeNull();
    expect(sim.status).toBe("won");
  });

  it("saveMe converts grid raws to cooked items in the backpack and resets patience", () => {
    const { sim, ck, rw } = bind({ queueString: "0", customerString: "10;0;0" });
    for (const c of sim.active) c.timeLeft = 0.001;
    sim.tick(1);
    expect(sim.status).toBe("lost");
    expect(sim.loseReason).toBe("customer-timeout");

    // Seeded AFTER the loss: settle() would otherwise reclaim a parked raw into
    // a free tool slot before saveMe() ever saw it.
    sim.grid[0] = { kind: "raw", ing: rw(3) }; // recipe: in 3 -> out 3, amount 2
    sim.grid[1] = { kind: "cooked", ing: ck(1) };

    expect(sim.saveMe(1)).toBe(true);
    expect(sim.status).toBe("playing");
    expect(sim.loseReason).toBeNull();
    expect(sim.saveMeUsed).toBe(1);
    expect(sim.active[0].timeLeft).toBe(10);

    const backpack = sim.grid.find((c) => c.kind === "backpack") as
      | { kind: "backpack"; items: number[] }
      | undefined;
    expect(backpack).toBeDefined();
    expect([...backpack!.items].sort((a, b) => a - b)).toEqual([ck(1), ck(3), ck(3)].sort((a, b) => a - b));
    expect(sim.grid.filter((c) => c.kind === "raw" || c.kind === "cooked")).toHaveLength(0);
    expect(sim.grid.filter((c) => c.kind === "backpack")).toHaveLength(1);
  });

  it("refuses saveMe when the sim isn't lost, and once maxUses is exhausted", () => {
    const { sim } = bind({ queueString: "0", customerString: "0;0;0.1" });
    expect(sim.saveMe(1)).toBe(false);

    for (const c of sim.active) c.timeLeft = 0.001;
    sim.tick(1);
    expect(sim.status).toBe("lost");
    expect(sim.saveMe(0)).toBe(false);

    expect(sim.saveMe(1)).toBe(true);
    expect(sim.status).toBe("playing");

    for (const c of sim.active) c.timeLeft = 0.001;
    sim.tick(1);
    expect(sim.status).toBe("lost");
    expect(sim.saveMe(1)).toBe(false);
  });

  it("saveMe(-1) is unlimited", () => {
    const { sim } = bind({ queueString: "0", customerString: "0;0;0.1" });
    for (let i = 0; i < 5; i++) {
      for (const c of sim.active) c.timeLeft = 0.001;
      sim.tick(1);
      expect(sim.status).toBe("lost");
      expect(sim.saveMe(-1)).toBe(true);
      expect(sim.status).toBe("playing");
    }
    expect(sim.saveMeUsed).toBe(5);
  });

  it("autoServe prefers a backpack item over an identical item on the grid", () => {
    const { sim, ck } = bind({ queueString: "0", customerString: "0;0;0" }, testMap, {
      instantFlights: false,
    });
    sim.grid[0] = { kind: "backpack", items: [ck(0)] };
    sim.grid[1] = { kind: "cooked", ing: ck(0) };
    sim.tick(0);
    expect(sim.flights).toHaveLength(1);
    expect(sim.flights[0].kind).toBe("backpack-to-customer");
    expect(sim.flights[0].fromCell).toBe(0);
    expect(sim.grid[1]).toEqual({ kind: "cooked", ing: ck(0) });
  });

  it("a backpack-to-customer flight drains one item without clearing the cell", () => {
    const { sim, ck } = bind({ queueString: "0", customerString: "0;0;0.0" }, testMap, {
      instantFlights: false,
    });
    sim.grid[0] = { kind: "backpack", items: [ck(0), ck(0)] };
    sim.tick(0);
    expect(sim.flights).toHaveLength(1);
    expect(sim.flights[0].kind).toBe("backpack-to-customer");

    sim.completeFlight(sim.flights[0].id);
    expect(sim.grid[0]).toEqual({ kind: "backpack", items: [ck(0)] });
    expect(sim.flights).toHaveLength(1); // settle() launched the second

    sim.completeFlight(sim.flights[0].id);
    expect(sim.grid[0]).toEqual({ kind: "empty" });
    expect(sim.status).toBe("won");
  });
});

// -------------------------------------------------------------------- hidden

describe("isHidden", () => {
  const hidden = (queueData: string, combined = "", linked = "") =>
    bind({
      queueString: combined || linked ? `${queueData}$${combined}$${linked}` : queueData,
      customerString: "0;0;0;0.0.0.0.0.0",
    });

  it("is false for a slot carrying no Hidden status, wherever it sits", () => {
    const { sim } = hidden("0,1,2");
    expect(sim.isHidden(0, 0)).toBe(false);
    expect(sim.isHidden(0, 1)).toBe(false);
    expect(sim.isHidden(0, 2)).toBe(false);
  });

  it("hides a Hidden slot behind another item, and reveals it once it fronts", () => {
    const { sim, rw } = hidden("0,1#2");
    expect(sim.isHidden(0, 1)).toBe(true);

    sim.pick(0);
    expect(sim.queueGrid[0][0]?.ing).toBe(rw(1));
    expect(sim.isHidden(0, 0)).toBe(false);
  });
});
