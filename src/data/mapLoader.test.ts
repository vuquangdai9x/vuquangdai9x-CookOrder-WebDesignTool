import { describe, expect, it } from "vitest";
import { serializeCustomers, serializeGrid, serializeQueues } from "../core/parser.ts";
import { ALL_MAPS, MAP1_DATA, MAP2_DATA } from "./configLoader.ts";
import { toMapDef } from "./mapLoader.ts";

describe("bundled Map 1 (burger) snapshot", () => {
  it("has 20 levels (data-ready rows in the level-data-snapshot.csv — levels 21-25 have no Customers/Grid/Queues authored yet)", () => {
    expect(MAP1_DATA.levels).toHaveLength(20);
    expect(MAP1_DATA.rawIngredients).toHaveLength(17); // 0-8 burger ids + 9-16 merged in from map2 (chick_breast_raw added 2026-08)
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

  it("carries the new GDD-sync fields (upgradeCosts, levelEconomy)", () => {
    const griddle = MAP1_DATA.tools.find((t) => t.name === "Griddle")!;
    expect(griddle.upgradeCosts).toEqual([0, 2, 2]);
    expect(MAP1_DATA.levelEconomy).toHaveLength(4);
    expect(MAP1_DATA.levelEconomy?.[0]).toEqual({ level: 1, cost: 100, rewardHardCurrency: 50, coinBoost: 100 });
  });

  it("raw ingredient ids 9-16 mirror their cooked ids 1:1 (chicken_breast_raw inserted at 9, corrected 2026-08)", () => {
    // No RawIngredientDef.cookedId overrides needed anymore — every raw id
    // in this range now equals its own cooked id, including the two
    // tool-less items (chili_bowl, cheese_sauce).
    const byCode: Record<string, number> = {
      chicken_breast_raw: 9,
      chicken_wing_raw: 10,
      chicken_thigh_raw: 11,
      chicken_nugget_raw: 12,
      potato: 13,
      chili_bowl: 14,
      chive: 15,
      cheese_sauce: 16,
    };
    for (const [code, id] of Object.entries(byCode)) {
      const raw = MAP1_DATA.rawIngredients.find((r) => r.code === code);
      expect(raw?.id, `raw ingredient "${code}"`).toBe(id);
      expect(raw?.cookedId, `raw ingredient "${code}" should have no cookedId override`).toBeUndefined();
    }
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
