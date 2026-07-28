// Regression tests for the bug where ingredients could not be picked in Play
// mode: the view rebuilt its DOM on every animation frame, so the tile that
// received mousedown was destroyed before mouseup and the click never fired.
// The view now rebuilds only when this key changes, so the key must stay
// stable while nothing but time advances.

import { describe, expect, it } from "vitest";
import { parseCustomers, parseGrid, parseQueues } from "../../core/parser.ts";
import { Simulation } from "../../core/sim.ts";
import type { LevelConfig, MapDef } from "../../core/types.ts";
import { MAP1_DATA } from "../../data/initialData.ts";
import { toMapDef } from "../../data/mapLoader.ts";
import { playStructureKey } from "./structureKey.ts";

const testMap: MapDef = {
  id: 99,
  name: "test",
  dirtyDishName: "plate",
  rawIngredients: [0, 1].map((id) => ({
    id,
    name: `raw${id}`,
    icon: "",
    code: `raw${id}`,
    price: 1,
    prepareTime: 2,
    cookTime: 4,
  })),
  cookedIngredients: [0, 1].map((id) => ({ id, name: `cooked${id}`, icon: "" })),
  cookMappings: [0, 1].map((id) => ({ rawId: id, cookedIds: [id] })),
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
    gridWidth: 5,
    gridHeight: 2,
    serveableSlots: 2,
    dirtyStackHeight: 5,
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
    const cooking = playStructureKey(sim);
    sim.tick(0.5); // bar advances, still preparing
    expect(playStructureKey(sim)).toBe(cooking);
    expect(sim.pipeline[0].elapsed).toBeGreaterThan(0);
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
    const cooking = playStructureKey(sim);
    sim.tick(10); // prepare + cook complete
    expect(playStructureKey(sim)).not.toBe(cooking);
  });

  it("changes when a stage transition swaps the pipeline label", () => {
    const sim = new Simulation(
      testMap,
      level({ queueString: "0", gridString: EMPTY_GRID, customerString: "0;0;1" }),
    );
    sim.pick(0);
    const preparing = playStructureKey(sim);
    sim.tick(2.5); // prepareTime is 2s, so this crosses into "cook"
    expect(sim.pipeline[0].stage).toBe("cook");
    expect(playStructureKey(sim)).not.toBe(preparing);
  });

  it("is stable on a real Map 1 level across a long idle stretch", () => {
    const map1 = toMapDef(MAP1_DATA);
    const sim = new Simulation(map1, map1.levels[0]);
    const before = playStructureKey(sim);
    for (let i = 0; i < 300; i++) sim.tick(1 / 60); // 5 seconds of frames
    expect(playStructureKey(sim)).toBe(before);
  });
});
