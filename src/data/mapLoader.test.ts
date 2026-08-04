import { describe, expect, it } from "vitest";
import { serializeCustomers, serializeGrid, serializeQueues } from "../core/parser.ts";
import { MAP1_DATA } from "./configLoader.ts";
import { toMapDef } from "./mapLoader.ts";

describe("bundled Map 1 (burger) snapshot", () => {
  it("has 15 levels of real sheet data", () => {
    expect(MAP1_DATA.levels).toHaveLength(15);
    expect(MAP1_DATA.rawIngredients).toHaveLength(9);
  });

  it("every level parses and round-trips through the canonical parsers", () => {
    const map = toMapDef(MAP1_DATA);
    for (const [i, level] of map.levels.entries()) {
      const data = MAP1_DATA.levels[i];
      expect(serializeQueues(level.queues, level.queueGroups)).toBe(data.queueString);
      expect(serializeGrid(level.grid)).toBe(data.gridString);
      expect(serializeCustomers(level.customers)).toBe(data.customerString);
      expect(level.grid).toHaveLength(map.gridWidth * map.gridHeight);
    }
  });

  it("level 11 carries the ColorLock cells and key-holder queue items", () => {
    const map = toMapDef(MAP1_DATA);
    const l11 = map.levels[10];
    const colorLocks = l11.grid.filter((c) => c.effects.some((e) => e.effectId === 4));
    expect(colorLocks).toHaveLength(2);
    expect(colorLocks[0].effects[0].params).toEqual([1, 1]); // red, 1 key
    const keyHolders = l11.queues
      .flat()
      .filter((q) => q.effects.some((e) => e.effectId === 3));
    expect(keyHolders.length).toBeGreaterThan(0);
  });

  it("all dish ingredient ids reference defined cooked ingredients", () => {
    const map = toMapDef(MAP1_DATA);
    const known = new Set(map.cookedIngredients.map((c) => c.id));
    for (const level of map.levels) {
      for (const customer of level.customers) {
        for (const dish of customer.dishes) {
          for (const id of dish.cookedIds) expect(known.has(id)).toBe(true);
        }
      }
    }
  });
});
