import { describe, expect, it } from "vitest";
import { serializeCustomers, serializeGrid, serializeQueues } from "../core/parser.ts";
import { MAP1_DATA } from "./configLoader.ts";
import { toMapDef } from "./mapLoader.ts";

describe("bundled Map 1 (burger) snapshot", () => {
  it("has 25 levels (1-6 real sheet data, 7-25 design-level-skill generated)", () => {
    expect(MAP1_DATA.levels).toHaveLength(25);
    expect(MAP1_DATA.rawIngredients).toHaveLength(16); // 0-8 burger ids + 9-15 merged in from map2
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
