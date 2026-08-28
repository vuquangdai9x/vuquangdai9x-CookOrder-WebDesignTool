import { describe, expect, it } from "vitest";
import burgerJson from "../../data/config/nodegraph/maps/Graph-1-Burger.json";
import { buildIndex } from "../../core/nodeIndex.ts";
import { buildIdIndex } from "../../data/nodeIdTable.ts";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import {
  CELL_COLOR_LOCK,
  computeLevelStats,
  STATUS_FREEZE,
  STATUS_HOLDING_KEY,
} from "./levelStats.ts";

const doc = burgerJson as unknown as NodeGraphMap;
const ix = buildIndex(doc);
const ids = buildIdIndex(doc.idTable);

/** A level carrying only the strings a test cares about; everything else is inert. */
function level(overrides: Partial<LevelData>): LevelData {
  return {
    id: 1,
    name: "test",
    weather: "Normal",
    levelTag: "",
    featureUnlock: "",
    serveableSlots: 2,
    shuffleDistance: 0,
    queueString: "%%",
    gridString: "",
    customerString: "",
    ...overrides,
  };
}

describe("computeLevelStats", () => {
  it("reports zeroes for an empty level without inventing parse errors", () => {
    const stats = computeLevelStats(level({}), ix, ids);
    expect(stats.numCustomers).toBe(0);
    expect(stats.numDishes).toBe(0);
    expect(stats.numQueueItems).toBe(0);
    expect(stats.parseErrors).toEqual([]);
    // "%%" is three explicit empty lanes, not zero lanes.
    expect(stats.numLanes).toBe(3);
  });

  it("counts queue tiles, distinct item types and lanes", () => {
    const stats = computeLevelStats(level({ queueString: "0,1,0%2,2%1" }), ix, ids);
    expect(stats.numLanes).toBe(3);
    expect(stats.numQueueItems).toBe(6);
    expect(stats.itemTypes).toBe(3);
  });

  it("counts each slot status separately, and folds keys into Lock & Key", () => {
    // Two frozen tiles and one key-carrying tile.
    const stats = computeLevelStats(level({ queueString: `0#${STATUS_FREEZE}:2,1#${STATUS_FREEZE}:1%2#${STATUS_HOLDING_KEY}:0` }), ix, ids);
    expect(stats.slotStatus.get(STATUS_FREEZE)).toBe(2);
    expect(stats.slotStatus.get(STATUS_HOLDING_KEY)).toBe(1);
    expect(stats.lockAndKey).toBe(1);
  });

  it("counts colour-locked cells into Lock & Key alongside the keys", () => {
    const stats = computeLevelStats(
      level({
        queueString: `0#${STATUS_HOLDING_KEY}:0`,
        gridString: `#${CELL_COLOR_LOCK}:0:1,,#${CELL_COLOR_LOCK}:1:1`,
      }),
      ix,
      ids,
    );
    expect(stats.cellStatus.get(CELL_COLOR_LOCK)).toBe(2);
    expect(stats.lockAndKey).toBe(3);
  });

  it("counts linked and combined group members apart", () => {
    const stats = computeLevelStats(
      level({ queueString: "0,1%0,1$0-0,1-0$0-1,1-1" }),
      ix,
      ids,
    );
    expect(stats.combinedSlots).toBe(2);
    expect(stats.linkedSlots).toBe(2);
  });

  it("keeps the numbers it can still report when one string is malformed", () => {
    const stats = computeLevelStats(level({ queueString: "0,zz%1" }), ix, ids);
    expect(stats.parseErrors.length).toBe(1);
    expect(stats.parseErrors[0]).toMatch(/Queue string/);
    // The grid and customer strings were fine, so their numbers still stand.
    expect(stats.numCustomers).toBe(0);
  });

  it("counts customers, their dishes, ordered ingredients and timers", () => {
    // One timed customer with one dish, one untimed with two.
    const orderable = ix.compositeName[ix.orderables[0]];
    const compositeId = ids.byNode.composite.get(orderable);
    expect(compositeId).toBeDefined();

    const slots = ix.slotsOfComposite[ix.orderables[0]] ?? [];
    const baseSlot = slots.find((s) => s.isBase);
    expect(baseSlot).toBeDefined();
    const ingredientId = ids.byNode.ingredient.get(ix.ingName[baseSlot!.options[0]]);
    expect(ingredientId).toBeDefined();

    const dish = `{c${compositeId}:${ingredientId}}`;
    const stats = computeLevelStats(
      level({ customerString: `0;30;0;${dish}|0;0;0;${dish},${dish}` }),
      ix,
      ids,
    );
    expect(stats.parseErrors).toEqual([]);
    expect(stats.numCustomers).toBe(2);
    expect(stats.numTimedCustomers).toBe(1);
    expect(stats.numDishes).toBe(3);
    expect(stats.numIngredients).toBe(3);
  });

  it("prices every concrete ingredient written in composite combinations", () => {
    const pricedDoc = structuredClone(doc);
    const orderable = buildIndex(pricedDoc).orderables[0];
    const pricedIx = buildIndex(pricedDoc);
    const pricedIds = buildIdIndex(pricedDoc.idTable);
    const compositeId = pricedIds.byNode.composite.get(pricedIx.compositeName[orderable])!;
    const slots = pricedIx.slotsOfComposite[orderable];
    const base = slots.find((slot) => slot.isBase)!.options[0];
    const topping = slots.find((slot) => !slot.isBase)!.options[0];
    const baseName = pricedIx.ingName[base];
    const toppingName = pricedIx.ingName[topping];
    pricedDoc.vertices.ingredient.find((candidate) => candidate.name === baseName)!.price = 7;
    pricedDoc.vertices.ingredient.find((candidate) => candidate.name === toppingName)!.price = 3;
    const rebuiltIx = buildIndex(pricedDoc);
    const baseId = pricedIds.byNode.ingredient.get(baseName)!;
    const toppingId = pricedIds.byNode.ingredient.get(toppingName)!;
    const groupId = pricedIds.byNode.group.get(
      rebuiltIx.groupName[slots.find((slot) => !slot.isBase)!.group],
    )!;

    const stats = computeLevelStats(
      level({ customerString: `0;0;0;{c${compositeId}:${baseId}.{g${groupId}:${toppingId}.${toppingId}}}` }),
      rebuiltIx,
      pricedIds,
    );
    expect(stats.totalPrice).toBe(13);
  });
});
