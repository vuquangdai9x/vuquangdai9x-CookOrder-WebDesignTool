// What survives of the legacy migration, and why the rest went.
//
// This module used to migrate Map 1 onto the AUTHORED burger graph. That only
// worked while every ingredient in `burger.json` carried `runtimeRawId` /
// `runtimeCookedId` — legacy ids stored in the shipped map format purely so
// this code could read them back out. Those fields are gone, and with them the
// ability to migrate onto a hand-authored map: an authored map has no legacy
// counterpart to migrate FROM, and its levels now come from the committed CSV.
//
// What remains is real and still used: `legacyLevelToNode` (the conformance and
// parity harness) projects a legacy `LevelConfig` onto an ADAPTER-produced
// graph, and that needs exactly the pieces tested below — the id mapping, the
// flat-list-to-bracket-tree recogniser, and the grid-cell remap.
//
// The mapping is now passed IN rather than read off the vertices, so the tests
// run against `legacyToGraph(MAP1_DATA)`, which has a legacy counterpart by
// construction.

import { describe, expect, it } from "vitest";
import { parseCustomers, parseQueues } from "../core/parser.ts";
import { parseNodeCustomers } from "../core/nodeParser.ts";
import { MAP1_DATA } from "./configLoader.ts";
import { cookedName, legacyNamesOf, legacyToGraph, pickupName, rawName } from "../core/legacyToGraph.ts";
import { toMapDef } from "./mapLoader.ts";
import { buildIdIndex } from "./nodeIdTable.ts";
import {
  buildMigration,
  buildRecogniser,
  migrateGridCells,
  migrateMap,
  recogniseDish,
} from "./nodeGraphMigrate.ts";
import { buildLookup, slotIndex } from "./nodeGraphResolve.ts";

const map1 = toMapDef(MAP1_DATA);
const doc = legacyToGraph(map1);
const names = legacyNamesOf(doc);
const ids = buildIdIndex(doc.idTable);
const migrated = migrateMap(MAP1_DATA, doc, names);

describe("legacyNamesOf — recovering the mapping from the graph itself", () => {
  /**
   * The property that replaced the stored fields. The adapter's naming scheme
   * IS the mapping, so it can be read back with nothing kept in the data.
   */
  it("recovers every legacy id the adapter emitted", () => {
    for (const raw of map1.rawIngredients) {
      expect(names.raw.get(raw.id), `raw ${raw.id}`).toBe(pickupName(map1, raw.id));
    }
    for (const cooked of map1.cookedIngredients) {
      expect(names.cooked.get(cooked.id), `cooked ${cooked.id}`).toBe(cookedName(cooked.id));
    }
  });

  it("returns nothing for an authored graph, which has no legacy counterpart", () => {
    const authored = legacyNamesOf({
      ...doc,
      vertices: { ...doc.vertices, ingredient: [{ name: "bun", displayName: "Bun", pickupable: true }] },
    });
    expect(authored.raw.size).toBe(0);
    expect(authored.cooked.size).toBe(0);
  });
});

describe("buildMigration — legacy id -> node name -> new data id", () => {
  const migration = buildMigration(doc, names);

  it("keeps raw and cooked as separate input spaces", () => {
    // Legacy raw 0 and cooked 0 are DIFFERENT things — a bun and a sliced bun.
    // Merging the two spaces would silently turn every queued bun into a
    // sliced one, which is why they are migrated through separate maps.
    expect(ids.byId.ingredient.get(migration.raw.get(0)!)).toBe(rawName(0));
    expect(ids.byId.ingredient.get(migration.cooked.get(0)!)).toBe(cookedName(0));
    expect(migration.raw.get(0)).not.toBe(migration.cooked.get(0));
  });

  it("converges a dual-role ingredient on ONE new id", () => {
    // A raw with no recipe IS its cooked form. Both legacy spaces then point at
    // one new id — exactly the merge the single ingredient space exists for.
    const merged = map1.rawIngredients.filter((r) => pickupName(map1, r.id) === cookedName(r.id));
    expect(merged.length, "no dual-role ingredient in Map 1 to test").toBeGreaterThan(0);
    for (const raw of merged) {
      expect(migration.raw.get(raw.id), `raw ${raw.id}`).toBe(migration.cooked.get(raw.id));
    }
  });

  it("maps tools and dirty objects too", () => {
    for (const tool of map1.tools) {
      expect(ids.byId.tool.get(migration.tool.get(tool.id)!), `tool ${tool.id}`).toBeDefined();
    }
    expect(migration.dirty.size).toBe(map1.dirtyObjects?.length ?? 0);
  });
});

describe("the migration gate", () => {
  it("maps every id actually used by any authored level", () => {
    expect(migrated.report.unmappedInUse).toEqual([]);
  });

  it("migrates every level", () => {
    expect(migrated.levels).toHaveLength(MAP1_DATA.levels.length);
  });

  it("reports no new vertices — the adapter graph mirrors legacy exactly", () => {
    // Contrast with an authored graph, which may add intermediates legacy never
    // had. Built from the legacy map, every vertex has a counterpart.
    expect(migrated.report.newVertices).toEqual([]);
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

  it("preserves customer count and per-customer fields", () => {
    migrated.levels.forEach((level, i) => {
      const before = parseCustomers(MAP1_DATA.levels[i].customerString);
      const after = parseNodeCustomers(level.customerString);
      expect(after).toHaveLength(before.length);
      after.forEach((customer, c) => {
        expect(customer.typeId, `${level.name} c${c}`).toBe(before[c].typeId);
        expect(customer.waitTime, `${level.name} c${c}`).toBe(before[c].waitTime);
        expect(customer.staffAmount ?? 0, `${level.name} c${c}`).toBe(before[c].staffAmount ?? 0);
      });
    });
  });

  /**
   * A latent defect worth keeping pinned: cell effect 3 carries a RAW
   * INGREDIENT ID inside the grid string. It is not a global id, so it has to
   * be remapped like any other — and it is the one grid value that does.
   */
  it("remaps the ingredient-slot cell's raw id, which is NOT a global id", () => {
    const migration = buildMigration(doc, names);
    const { cells } = migrateGridCells(
      [{ effects: [{ effectId: 3, params: [1, 2] }] }, { effects: [{ effectId: 1, params: [] }] }],
      migration,
    );
    expect(cells[0].effects[0].params).toEqual([migration.raw.get(1), 2]);
    // Every other effect passes through untouched.
    expect(cells[1].effects[0].params).toEqual([]);
  });
});

describe("recogniseDish — the flat list to bracket tree recogniser", () => {
  const rec = buildRecogniser(doc);
  const lk = buildLookup(doc);
  const { slotOf } = slotIndex(lk);
  const place = new Map<number, { composite: string; slot: number }>();
  for (const [ingredient, at] of slotOf) {
    const id = ids.byNode.ingredient.get(ingredient);
    if (id !== undefined) place.set(id, { composite: at.orderable, slot: at.slot });
  }

  /** The ids of one orderable's base and a topping, whatever they are in this map. */
  const anyOrderable = () => {
    for (const [id, at] of place) {
      const sibling = [...place].find(([other, o]) => other !== id && o.composite === at.composite);
      if (sibling) return { a: id, b: sibling[0], composite: at.composite };
    }
    return null;
  };

  it("refuses a dish spanning two orderables rather than guessing", () => {
    const composites = new Set([...place.values()].map((p) => p.composite));
    expect(composites.size, "need two orderables to test the refusal").toBeGreaterThan(1);
    const [first, second] = [...composites];
    const a = [...place].find(([, p]) => p.composite === first)![0];
    const b = [...place].find(([, p]) => p.composite === second)![0];
    expect("error" in recogniseDish(rec, [a, b])).toBe(true);
  });

  it("refuses an ingredient with no slot", () => {
    const unknown = Math.max(...place.keys()) + 1000;
    expect("error" in recogniseDish(rec, [unknown])).toBe(true);
  });

  it("places every member of a single-orderable dish", () => {
    const pair = anyOrderable();
    expect(pair, "need one orderable with two members").not.toBeNull();
    const result = recogniseDish(rec, [pair!.a, pair!.b]);
    expect("error" in result ? result.error : "").toBe("");
  });

  it("preserves quantity as repetition", () => {
    const pair = anyOrderable()!;
    const result = recogniseDish(rec, [pair.a, pair.b, pair.b]);
    expect("error" in result ? result.error : "").toBe("");
    if ("dish" in result) {
      // Three members in, three members out — repetition is how quantity is
      // written, so a duplicate must survive rather than being deduplicated.
      const count = (node: { members: unknown[] }): number =>
        node.members.reduce<number>(
          (n, m) => n + (typeof m === "object" && m !== null && "members" in m ? count(m as never) : 1),
          0,
        );
      expect(count(result.dish.root)).toBe(3);
    }
  });
});
