import { describe, expect, it } from "vitest";
import { parseCustomers, parseGrid, parseQueues } from "../core/parser.ts";
import type { LevelConfig, MapDef } from "../core/types.ts";
import { toPlayableLevelConfig } from "./playLevel.ts";

const baseMap: MapDef = {
  id: 1,
  name: "test",
  dirtyDishName: "plate",
  gridWidth: 5,
  gridHeight: 2,
  dirtyStackHeight: 5,
  disabledRawIds: [],
  disabledCookedIds: [],
  rawIngredients: [],
  cookedIngredients: [],
  dirtyObjects: [],
  customerAvatars: [],
  tools: [],
  levels: [],
};

function level(): LevelConfig {
  return {
    id: 1,
    name: "test",
    weather: "Normal",
    levelTag: "",
    featureUnlock: "",
    shuffleDistance: 0,
    serveableSlots: 2,
    queues: parseQueues("0,1,0%1,0"),
    grid: parseGrid(",,,,,,,,,"),
    customers: parseCustomers("0;0;0.1,1"),
  };
}

describe("toPlayableLevelConfig", () => {
  it("passes the level through unchanged when nothing is disabled", () => {
    const map = baseMap;
    const lvl = level();
    expect(toPlayableLevelConfig(map, lvl)).toBe(lvl);
  });

  it("strips a disabled raw ingredient out of every queue", () => {
    const map: MapDef = { ...baseMap, disabledRawIds: [0] };
    const result = toPlayableLevelConfig(map, level());
    expect(result.queues).toEqual([[{ kind: "ingredient", id: 1, effects: [] }], [{ kind: "ingredient", id: 1, effects: [] }]]);
  });

  it("strips a disabled cooked id out of every dish, leaving other ids intact", () => {
    const map: MapDef = { ...baseMap, disabledCookedIds: [0] };
    const result = toPlayableLevelConfig(map, level());
    expect(result.customers[0].dishes[0].cookedIds).toEqual([1]);
    expect(result.customers[0].dishes[1].cookedIds).toEqual([1]);
  });

  it("leaves an ingredient's queue effects/sweeper items alone", () => {
    const map: MapDef = { ...baseMap, disabledRawIds: [1] };
    const withSweeper: LevelConfig = {
      ...level(),
      queues: parseQueues("0,1,-1"),
    };
    const result = toPlayableLevelConfig(map, withSweeper);
    expect(result.queues[0]).toEqual([
      { kind: "ingredient", id: 0, effects: [] },
      { kind: "sweeper", id: -1, effects: [] },
    ]);
  });
});
