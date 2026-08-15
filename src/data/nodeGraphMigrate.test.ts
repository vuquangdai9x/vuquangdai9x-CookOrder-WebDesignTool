import { describe, expect, it } from "vitest";
import { parseCustomers, parseQueues } from "../core/parser.ts";
import { parseNodeCustomers } from "../core/nodeParser.ts";
import burgerJson from "./config/nodegraph/burger.json";
import { MAP1_DATA } from "./configLoader.ts";
import { buildIdIndex } from "./nodeIdTable.ts";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";
import {
  buildMigration,
  buildRecogniser,
  migrateGridCells,
  migrateMap,
  recogniseDish,
} from "./nodeGraphMigrate.ts";

const doc = burgerJson as unknown as NodeGraphMap;
const ids = buildIdIndex(doc.idTable);
const migrated = migrateMap(MAP1_DATA, doc);

describe("buildMigration — legacy id -> node name -> new data id", () => {
  const migration = buildMigration(doc);

  it("keeps raw and cooked as separate input spaces", () => {
    // Legacy raw 0 is `bun`; legacy cooked 0 is `bun-sliced`. Merging them
    // would silently turn every queued bun into a sliced one.
    expect(ids.byId.ingredient.get(migration.raw.get(0)!)).toBe("bun");
    expect(ids.byId.ingredient.get(migration.cooked.get(0)!)).toBe("bun-sliced");
    expect(migration.raw.get(0)).not.toBe(migration.cooked.get(0));
  });

  it("converges a dual-role ingredient on ONE new id", () => {
    // ice is legacy raw 8 AND cooked 8 — pickupable and servable. In the new
    // single ingredient space that stops being a special case.
    for (const [rawId, cookedId] of [
      [8, 8], // ice
      [14, 14], // chili-bowl
      [16, 16], // cheese-sauce
    ]) {
      expect(migration.raw.get(rawId)).toBe(migration.cooked.get(cookedId));
    }
  });

  it("maps tools and dirty objects too", () => {
    expect(ids.byId.tool.get(migration.tool.get(0)!)).toBe("griddle");
    expect(ids.byId.tool.get(migration.tool.get(3)!)).toBe("fryer");
    expect(ids.byId.dirty.get(migration.dirty.get(2)!)).toBe("dirty-chick-box");
  });
});

describe("the Phase 2 gate", () => {
  it("maps every id actually used by any authored level", () => {
    expect(migrated.report.unmappedInUse).toEqual([]);
  });

  it("migrates every level", () => {
    expect(migrated.levels).toHaveLength(MAP1_DATA.levels.length);
  });

  it("reports exactly the four coated intermediates as new vertices", () => {
    expect(migrated.report.newVertices.sort()).toEqual([
      "chicken-breast-flour-coated",
      "chicken-nugget-flour-coated",
      "chicken-thigh-flour-coated",
      "chicken-wing-flour-coated",
    ]);
  });

  it("every migrated customer string re-parses under the new grammar", () => {
    for (const level of migrated.levels) {
      expect(() => parseNodeCustomers(level.customerString), level.name).not.toThrow();
    }
  });

  it("every migrated queue string still parses, with item counts preserved", () => {
    migrated.levels.forEach((level, i) => {
      const before = parseQueues(MAP1_DATA.levels[i].queueString);
      const after = parseQueues(level.queueString);
      expect(after.map((lane) => lane.length), level.name).toEqual(before.map((lane) => lane.length));
    });
  });

  it("leaves queue strings byte-identical, since raw ids seeded the table 1:1", () => {
    migrated.levels.forEach((level, i) => {
      expect(level.queueString, level.name).toBe(MAP1_DATA.levels[i].queueString);
    });
  });

  it("leaves grid strings byte-identical, since no level uses an ingredient-slot cell", () => {
    // Grid cell effects are global with ONE exception — the ingredient-slot
    // cell's raw id, which migrateGridCells() remaps. Map 1 authors none today,
    // so the strings come through unchanged; the test below pins the remap
    // itself so that stays true by construction rather than by luck.
    migrated.levels.forEach((level, i) => {
      expect(level.gridString).toBe(MAP1_DATA.levels[i].gridString);
    });
  });

  it("remaps the ingredient-slot cell's raw id, which is NOT a global id", () => {
    const migration = buildMigration(doc);
    const { cells } = migrateGridCells(
      [{ effects: [{ effectId: 3, params: [1, 2] }] }, { effects: [{ effectId: 1, params: [] }] }],
      migration,
    );
    // Legacy raw 1 is `patty`; its new data id is whatever the table minted.
    expect(cells[0].effects[0].params).toEqual([migration.raw.get(1), 2]);
    expect(ids.byId.ingredient.get(cells[0].effects[0].params[0])).toBe("patty");
    // A blocked cell carries no ingredient id and is left exactly as it was.
    expect(cells[1].effects[0].params).toEqual([]);
  });
});

describe("re-bracketing legacy flat dishes", () => {
  it("turns a flat burger into a bracket tree", () => {
    // Level 1's first customer orders cooked [0,1] = sliced bun + cooked patty.
    expect(migrated.levels[0].customerString.startsWith("0;0;0;{c0:100.{g0:101}}")).toBe(true);
  });

  it("preserves quantity as repetition", () => {
    // ...;0.1.1.1 = bun + 3 patties.
    expect(migrated.levels[0].customerString).toContain("{c0:100.{g0:101.101.101}}");
  });

  it("preserves customer count and per-customer fields", () => {
    migrated.levels.forEach((level, i) => {
      const before = parseCustomers(MAP1_DATA.levels[i].customerString);
      const after = parseNodeCustomers(level.customerString);
      expect(after, level.name).toHaveLength(before.length);
      after.forEach((c, ci) => {
        expect([c.typeId, c.waitTime, c.weatherEff]).toEqual([
          before[ci].typeId,
          before[ci].waitTime,
          before[ci].weatherEff,
        ]);
      });
    });
  });

  it("keeps a staff customer's empty dish list and staffAmount", () => {
    const staffLevel = migrated.levels.find((l) => l.customerString.includes(";1;"));
    if (!staffLevel) return;
    expect(() => parseNodeCustomers(staffLevel.customerString)).not.toThrow();
  });
});

describe("recogniseDish", () => {
  const rec = buildRecogniser(doc);
  const id = (node: string): number => {
    const i = ids.byNode.ingredient.get(node);
    if (i === undefined) throw new Error(`no id for ${node}`);
    return i;
  };

  it("places the base first and groups the rest", () => {
    const result = recogniseDish(rec, [id("patty-cooked"), id("bun-sliced"), id("tomato-sliced")]);
    expect("dish" in result).toBe(true);
    if (!("dish" in result)) return;
    expect(result.dish.root.id).toBe(0); // burger
    expect(result.dish.root.members[0]).toEqual({ kind: "ingredient", id: id("bun-sliced") });
  });

  it("refuses a dish spanning two orderables rather than guessing", () => {
    const result = recogniseDish(rec, [id("bun-sliced"), id("soda-cup")]);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/must be one orderable/);
  });

  it("refuses an ingredient with no slot", () => {
    const result = recogniseDish(rec, [999]);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/no slot for ingredient/);
  });
});

/**
 * A pre-existing defect in the LEGACY level data, surfaced by the migration and
 * then fixed in the graph.
 *
 * Eight dishes are exactly [13, 16] — fried potato plus cheese sauce. In the
 * runtime, cheese sauce (cooked 16) declares `baseId: [9,10,11,12]`, the four
 * fried CHICKEN cuts; fried potato is 13 and is not among them. So
 * `baseRequirementMet` could never be satisfied and those dishes could never
 * complete — the legacy simulation serves 0 of 14 customers on level 1_17 and
 * stalls rather than losing.
 *
 * The graph fixes it by making `potato-fried` a fifth option of
 * fried-basket-bases, so the sauces apply to it like any other base. These
 * tests pin both halves: the defect really did exist in the runtime data, and
 * the graph really does resolve it.
 */
describe("legacy data defect, and its fix in the graph", () => {
  it("the legacy runtime genuinely could not satisfy those dishes", () => {
    const sauce = MAP1_DATA.cookedIngredients.find((c) => c.id === 16)!;
    const bases = Array.isArray(sauce.baseId) ? sauce.baseId : [sauce.baseId];
    expect(bases).toEqual([9, 10, 11, 12]);
    expect(bases).not.toContain(13); // fried potato — the dish could never complete
  });

  it("those dishes exist, in three levels", () => {
    const affected = new Set<number>();
    let count = 0;
    for (const level of MAP1_DATA.levels) {
      for (const customer of parseCustomers(level.customerString)) {
        for (const dish of customer.dishes) {
          if ([...dish.cookedIds].sort((a, b) => a - b).join(",") === "13,16") {
            affected.add(level.id);
            count++;
          }
        }
      }
    }
    expect(count).toBe(8);
    expect([...affected].sort((a, b) => a - b)).toEqual([17, 18, 20]);
  });

  it("every dish now places — nothing is left for hand-review", () => {
    expect(migrated.report.unplacedDishes).toEqual([]);
  });

  it("migrates them to a fried basket with a potato base and a cheese-sauce topping", () => {
    // burger.json ids: c2 = fried-basket, g1 = bases, g2 = sauces,
    // 112 = potato-fried, 16 = cheese-sauce.
    const level17 = migrated.levels.find((l) => l.id === 17)!;
    expect(level17.customerString).toContain("{c2:{g1:112}.{g2:16}}");
  });
});
