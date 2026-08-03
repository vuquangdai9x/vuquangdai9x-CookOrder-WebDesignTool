// Regression tests for the bug where ingredients could not be picked in Play
// mode: the view rebuilt its DOM on every animation frame, so the tile that
// received mousedown was destroyed before mouseup and the click never fired.
// The view now rebuilds only when this key changes, so the key must stay
// stable while nothing but time advances.

import { describe, expect, it } from "vitest";
import { parseCustomers, parseGrid, parseQueues } from "../../core/parser.ts";
import { Simulation } from "../../core/sim.ts";
import type { LevelConfig, MapDef } from "../../core/types.ts";
import { MAP1_DATA } from "../../data/configLoader.ts";
import { toMapDef } from "../../data/mapLoader.ts";
import { playStructureKey } from "./structureKey.ts";

const testMap: MapDef = {
  id: 99,
  name: "test",
  dirtyDishName: "plate",
  gridWidth: 5,
  gridHeight: 2,
  dirtyStackHeight: 5,
  disabledRawIds: [],
  disabledCookedIds: [],
  rawIngredients: [0, 1].map((id) => ({
    id,
    name: `raw${id}`,
    icon: "",
    code: `raw${id}`,
    price: 1,
    numSlices: 1,
  })),
  cookedIngredients: [0, 1].map((id) => ({ id, name: `cooked${id}`, icon: "" })),
  dirtyObjects: [],
  customerAvatars: [],
  tools: [
    {
      id: 0,
      name: "Test Tool",
      numSlots: 4,
      cookingTime: 6,
      recipes: [
        { in: 0, out: 0, amount: 1 },
        { in: 1, out: 1, amount: 1 },
      ],
    },
  ],
  levels: [],
};

function level(over: {
  queueString: string;
  gridString: string;
  customerString: string;
}): LevelConfig {
  return {
    id: 1,
    name: "test",
    weather: "Normal",
    levelTag: "",
    featureUnlock: "",
    shuffleDistance: 0,
    serveableSlots: 2,
    queues: parseQueues(over.queueString),
    grid: parseGrid(over.gridString),
    customers: parseCustomers(over.customerString),
  };
}

const EMPTY_GRID = ",,,,,,,,,";

describe("play view structure key", () => {
  it("stays stable while only time advances, so tiles survive between frames", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0,1%1,0", gridString: EMPTY_GRID, customerString: "0;0;0.1" }),
    );
    const atRest = playStructureKey(sim);
    // Simulate a second of animation frames with nothing else happening.
    for (let i = 0; i < 60; i++) sim.tick(1 / 60);
    expect(playStructureKey(sim)).toBe(atRest);
  });

  it("stays stable while an item is cooking and its progress bar fills", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0,1%1,0", gridString: EMPTY_GRID, customerString: "0;0;0.1" }),
    );
    sim.pick(0);
    sim.completeAllFlights(); // the ingredient reaches the slot and starts cooking
    const cooking = playStructureKey(sim);
    sim.tick(0.5); // bar advances, still in the same slot
    expect(playStructureKey(sim)).toBe(cooking);
    expect(sim.tools[0].slots[0].item?.elapsed).toBeGreaterThan(0);
  });

  it("stays stable while a patience timer counts down", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0,1", gridString: EMPTY_GRID, customerString: "60;0;0.1" }),
    );
    const before = playStructureKey(sim);
    sim.tick(5);
    expect(sim.active[0].timeLeft).toBeLessThan(60);
    expect(playStructureKey(sim)).toBe(before);
  });

  it("changes when a pick removes a tile from a queue", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0,1%1,0", gridString: EMPTY_GRID, customerString: "0;0;0.1" }),
    );
    const before = playStructureKey(sim);
    sim.pick(0);
    expect(playStructureKey(sim)).not.toBe(before);
  });

  it("changes when cooking finishes and moves an item onto the grid", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;1" }),
    );
    sim.pick(0);
    sim.completeAllFlights();
    const cooking = playStructureKey(sim);
    sim.tick(10);
    sim.completeAllFlights(); // the output lands on the grid
    expect(playStructureKey(sim)).not.toBe(cooking);
  });

  it("changes when an ingredient arrives in a tool slot", () => {
    // instantFlights off so the in-flight state is observable, exactly as the
    // play view runs it.
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;1" }),
      { instantFlights: false },
    );
    sim.pick(0);
    const inFlight = playStructureKey(sim);
    expect(sim.tools[0].slots[0].item).toBeNull(); // still travelling
    sim.completeAllFlights(); // it lands in the slot, which occupies it
    expect(sim.tools[0].slots[0].item).not.toBeNull();
    expect(playStructureKey(sim)).not.toBe(inFlight);
  });

  it("is stable on a real Map 1 level across a long idle stretch", () => {
    const map1 = toMapDef(MAP1_DATA);
    const sim = new Simulation(map1, map1.levels[0]);
    const before = playStructureKey(sim);
    for (let i = 0; i < 300; i++) sim.tick(1 / 60); // 5 seconds of frames
    expect(playStructureKey(sim)).toBe(before);
  });
});
