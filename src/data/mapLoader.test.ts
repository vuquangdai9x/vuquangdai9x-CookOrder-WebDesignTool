import { describe, expect, it } from "vitest";
import { serializeCustomers, serializeGrid, serializeQueues } from "../core/parser.ts";
import { ALL_MAPS, MAP1_DATA, MAP2_DATA } from "./configLoader.ts";
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

  it("carries the new GDD-sync fields (upgradeCosts, levelEconomy, tool-less cookedId overrides)", () => {
    const griddle = MAP1_DATA.tools.find((t) => t.name === "Griddle")!;
    expect(griddle.upgradeCosts).toEqual([0, 2, 2]);
    expect(MAP1_DATA.levelEconomy).toHaveLength(5);
    expect(MAP1_DATA.levelEconomy?.[0]).toEqual({ level: 1, cost: 0, rewardHardCurrency: 50, coinBoost: 100 });
    // chili_bowl/cheese_sauce were renumbered on the cooked side but kept
    // their raw id — this override is what keeps a tool-less pick correct.
    const chiliBowlRaw = MAP1_DATA.rawIngredients.find((r) => r.code === "chili_bowl")!;
    expect(chiliBowlRaw.cookedId).toBe(14);
    const cheeseSauceRaw = MAP1_DATA.rawIngredients.find((r) => r.code === "cheese_sauce")!;
    expect(cheeseSauceRaw.cookedId).toBe(16);
  });

  it("dirty_chick_box resolves its multi-source names to real cooked ids", () => {
    const map = toMapDef(MAP1_DATA);
    const box = map.dirtyObjects.find((d) => d.name === "Dirty Chick Box")!;
    expect(Array.isArray(box.sourceCookedId)).toBe(true);
    for (const id of box.sourceCookedId as number[]) expect(id).toBeGreaterThanOrEqual(0);
  });
});

describe("bundled Map 2 (donut) snapshot", () => {
  it("has full definitions but no levels yet", () => {
    expect(MAP2_DATA.id).toBe(2);
    expect(MAP2_DATA.name).toBe("donut");
    expect(MAP2_DATA.rawIngredients).toHaveLength(20);
    expect(MAP2_DATA.cookedIngredients).toHaveLength(20);
    expect(MAP2_DATA.tools).toHaveLength(5);
    expect(MAP2_DATA.dirtyObjects).toHaveLength(3);
    expect(MAP2_DATA.levels).toHaveLength(0);
  });

  it("every dirty-object source name resolves to a real cooked id", () => {
    for (const d of MAP2_DATA.dirtyObjects) {
      const ids = Array.isArray(d.sourceCookedId) ? d.sourceCookedId : [d.sourceCookedId];
      for (const id of ids) expect(id).toBeGreaterThanOrEqual(0);
    }
  });

  it("is excluded from ALL_MAPS until it has level data", () => {
    expect(ALL_MAPS.map((m) => m.id)).toEqual([1]);
  });
});
