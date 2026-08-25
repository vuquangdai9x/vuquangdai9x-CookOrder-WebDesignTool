import { describe, expect, it } from "vitest";
import burgerJson from "../../data/config/nodegraph/maps/Graph-1-Burger.json";
import { buildIndex } from "../../core/nodeIndex.ts";
import { buildIdIndex } from "../../data/nodeIdTable.ts";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import {
  emptyWeightSet,
  parseWeightSet,
  serializeWeightSet,
} from "../design/ingredientWeightEditor.ts";
import { orderableRows, unreachableIngredients } from "./dishWeightEditor.ts";

const doc = burgerJson as unknown as NodeGraphMap;
const ix = buildIndex(doc);
const ids = buildIdIndex(doc.idTable);

describe("the weight-set grammar", () => {
  it("round-trips both halves", () => {
    const set = {
      ingredients: new Map([[3, 100], [7, 40]]),
      composites: new Map([[0, 80], [1, 20]]),
    };
    expect(parseWeightSet(serializeWeightSet(set))).toEqual(set);
  });

  it("reads a record written before dish types existed as ingredients only", () => {
    // Backward compatibility is the whole reason for the `c` prefix: an old
    // string must keep meaning exactly what it meant.
    const parsed = parseWeightSet("3:100;7:40");
    expect([...parsed.ingredients]).toEqual([[3, 100], [7, 40]]);
    expect(parsed.composites.size).toBe(0);
  });

  it("writes composites first, so the string diffs cleanly", () => {
    expect(
      serializeWeightSet({ ingredients: new Map([[9, 50]]), composites: new Map([[1, 30]]) }),
    ).toBe("c1:30;9:50");
  });

  it("drops zeroes from both halves", () => {
    expect(
      serializeWeightSet({ ingredients: new Map([[1, 0]]), composites: new Map([[2, 0]]) }),
    ).toBe("");
    expect(serializeWeightSet(emptyWeightSet())).toBe("");
  });

  it("clamps to 0..100 and skips junk", () => {
    const parsed = parseWeightSet("c0:900;1:-40;nonsense;c:5;2:70");
    expect(parsed.composites.get(0)).toBe(100);
    expect(parsed.ingredients.get(1)).toBe(0);
    expect(parsed.ingredients.get(2)).toBe(70);
  });
});

describe("orderableRows", () => {
  it("lists every orderable with the ingredients it can hold", () => {
    const rows = orderableRows(ix, ids);
    expect(rows.length).toBe(ix.orderables.length);
    expect(rows.every((row) => row.ingredients.size > 0)).toBe(true);
  });
});

describe("unreachableIngredients", () => {
  const rows = orderableRows(ix, ids);

  it("marks nothing while every dish type is enabled", () => {
    const all = new Map(rows.map((row) => [row.dataId, 100]));
    expect(unreachableIngredients(rows, all).size).toBe(0);
  });

  it("marks everything once every dish type is off", () => {
    const none = new Map(rows.map((row) => [row.dataId, 0]));
    const owned = new Set(rows.flatMap((row) => [...row.ingredients]));
    expect(unreachableIngredients(rows, none)).toEqual(owned);
  });

  it("spares an ingredient another enabled dish type can still hold", () => {
    // Only the first dish type is off; anything it shares with the others is
    // still perfectly reachable, and greying it would be a lie.
    const weights = new Map(rows.map((row, at) => [row.dataId, at === 0 ? 0 : 100]));
    const unreachable = unreachableIngredients(rows, weights);
    const shared = [...rows[0].ingredients].filter((id) =>
      rows.slice(1).some((row) => row.ingredients.has(id)),
    );
    for (const id of shared) expect(unreachable.has(id)).toBe(false);
  });

  it("marks the ingredients only the disabled dish type could hold", () => {
    const weights = new Map(rows.map((row, at) => [row.dataId, at === 0 ? 0 : 100]));
    const unreachable = unreachableIngredients(rows, weights);
    const exclusive = [...rows[0].ingredients].filter(
      (id) => !rows.slice(1).some((row) => row.ingredients.has(id)),
    );
    for (const id of exclusive) expect(unreachable.has(id)).toBe(true);
  });

  it("says nothing about an ingredient no orderable holds", () => {
    // That is a graph question the validator already reports, not a weighting one.
    const all = new Map(rows.map((row) => [row.dataId, 100]));
    expect(unreachableIngredients(rows, all).has(99999)).toBe(false);
  });
});
