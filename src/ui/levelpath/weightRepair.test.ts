import { describe, expect, it } from "vitest";
import burgerJson from "../../data/config/nodegraph/maps/Graph-1-Burger.json";
import { buildIndex } from "../../core/nodeIndex.ts";
import { buildIdIndex } from "../../data/nodeIdTable.ts";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import { parseWeightSet, serializeIngredientWeights } from "../design/ingredientWeightEditor.ts";
import {
  applyWeightRepair,
  ingredientDistribution,
  repairIngredientWeights,
  weightsFromDistribution,
} from "./weightRepair.ts";

const doc = burgerJson as unknown as NodeGraphMap;
const ix = buildIndex(doc);
const ids = buildIdIndex(doc.idTable);

/** A dish of the first orderable's first base option — enough to give a level a real order. */
function sampleDish(): { dish: string; ingredientId: number } {
  const orderable = ix.orderables[0];
  const compositeId = ids.byNode.composite.get(ix.compositeName[orderable])!;
  const baseSlot = (ix.slotsOfComposite[orderable] ?? []).find((s) => s.isBase)!;
  const ingredientId = ids.byNode.ingredient.get(ix.ingName[baseSlot.options[0]])!;
  return { dish: `{c${compositeId}:${ingredientId}}`, ingredientId };
}

const { dish, ingredientId } = sampleDish();

function level(overrides: Partial<LevelData> = {}): LevelData {
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
    customerString: `0;0;0;${dish},${dish}|0;0;0;${dish}`,
    ...overrides,
  };
}

describe("ingredientDistribution", () => {
  it("counts every ordered slot, keyed by data id", () => {
    expect(ingredientDistribution(level(), ix, ids).get(ingredientId)).toBe(3);
  });

  it("describes nothing for a level with no customers", () => {
    expect(ingredientDistribution(level({ customerString: "" }), ix, ids).size).toBe(0);
  });

  it("survives a customer string it cannot parse", () => {
    expect(ingredientDistribution(level({ customerString: "not-a-dish" }), ix, ids).size).toBe(0);
  });
});

describe("weightsFromDistribution", () => {
  it("puts the most-ordered ingredient at 100 and keeps the rest in proportion", () => {
    const weights = weightsFromDistribution(new Map([[1, 8], [2, 4], [3, 2]]));
    expect(weights.get(1)).toBe(100);
    expect(weights.get(2)).toBe(50);
    expect(weights.get(3)).toBe(25);
  });

  it("never returns 0 for an ingredient the level actually orders", () => {
    // 0 IS the disabled state being repaired; returning it would re-create the bug.
    const weights = weightsFromDistribution(new Map([[1, 500], [2, 1]]));
    expect(weights.get(2)).toBeGreaterThan(0);
  });
});

describe("repairIngredientWeights", () => {
  it("leaves a consistent record alone", () => {
    // Every ordered ingredient is enabled — the numbers not matching the
    // realized counts is normal, since the weights are an INPUT, not a report.
    const consistent = level({ ingredientWeights: serializeIngredientWeights(new Map([[ingredientId, 30]])) });
    expect(repairIngredientWeights(consistent, ix, ids)).toBeNull();
  });

  it("repairs a record that disables an ingredient the customers order", () => {
    const stale = level({ ingredientWeights: serializeIngredientWeights(new Map([[ingredientId + 500, 80]])) });
    const repair = repairIngredientWeights(stale, ix, ids);

    expect(repair).not.toBeNull();
    expect(repair!.contradicted).toContain(ingredientId);
    expect(repair!.wasEmpty).toBe(false);
    expect(repair!.weights.get(ingredientId)).toBe(100);
    // A weight for an ingredient this level does not order is a real authoring
    // choice about the map, and this level's customers are no evidence against it.
    expect(repair!.weights.get(ingredientId + 500)).toBe(80);
  });

  it("fills in a record that is missing entirely", () => {
    const repair = repairIngredientWeights(level(), ix, ids);
    expect(repair?.wasEmpty).toBe(true);
    expect(repair?.weights.get(ingredientId)).toBe(100);
  });

  it("has nothing to say about a level with no customers", () => {
    expect(repairIngredientWeights(level({ customerString: "" }), ix, ids)).toBeNull();
  });

  it("carries the dish-type weights through untouched", () => {
    // The repair reads the CUSTOMER string, which says nothing about dish-type
    // weights — dropping them here is how a repair silently became a delete.
    const target = level({ ingredientWeights: "c0:80;c2:30" });
    const repair = repairIngredientWeights(target, ix, ids)!;
    expect(repair.composites.get(0)).toBe(80);

    applyWeightRepair(target, repair);
    const after = parseWeightSet(target.ingredientWeights ?? "");
    expect([...after.composites]).toEqual([[0, 80], [2, 30]]);
    expect(after.ingredients.get(ingredientId)).toBe(100);
  });

  it("writes the repair back and reports what it did", () => {
    const target = level();
    const repair = repairIngredientWeights(target, ix, ids)!;
    const note = applyWeightRepair(target, repair);

    expect(target.ingredientWeights).toContain(`${ingredientId}:100`);
    expect(note).toMatch(/filled in from the customer string/);
    // Repaired once, it is now consistent and must not be touched again.
    expect(repairIngredientWeights(target, ix, ids)).toBeNull();
  });
});
