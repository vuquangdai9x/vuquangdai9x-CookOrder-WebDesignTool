import { describe, expect, it } from "vitest";
import { applyGraphLookupRows, graphLookupRows, parseGraphLookupRows } from "./graphLookupData.ts";
import burgerJson from "./config/nodegraph/maps/Graph-1-Burger.json";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";

const fixture = (): NodeGraphMap => structuredClone(burgerJson as unknown as NodeGraphMap);

describe("GraphLookupData", () => {
  it("parses the three-row sheet schema and ignores invalid tuples", () => {
    const rows = parseGraphLookupRows([
      ["Graph Lookup Data"],
      ["", "", "", "Ingredient", "tool", "dirty"],
      ["Map", "Category", "Index Data", "Price", "Speed Mul", "Max Stack"],
      ["1", "ingredient", "0", "12", "", ""],
      ["x", "ingredient", "0", "99", "", ""],
    ]);
    expect(rows).toEqual([{ map: 1, category: "ingredient", indexData: 0, price: "12", speedMul: "", maxStack: "" }]);
  });

  it("supports configured start rows and column positions", () => {
    const rows = parseGraphLookupRows(
      [["title"], ["2", "tool", "1.25", "4"]],
      2,
      { map: 0, category: 1, indexData: 3, price: 5, speedMul: 2, maxStack: 6 },
    );
    expect(rows).toEqual([{ map: 2, category: "tool", indexData: 4, price: "", speedMul: "1.25", maxStack: "" }]);
  });

  it("serializes values by positional id rather than vertex array order", () => {
    const doc = fixture();
    const first = doc.idTable.ingredient[0];
    const vertex = doc.vertices.ingredient.find((candidate) => candidate.name === first)!;
    vertex.price = 7;
    expect(graphLookupRows([{ index: 3, doc }]).find((row) => row[1] === "ingredient" && row[2] === "0"))
      .toEqual(["3", "ingredient", "0", "7", "", ""]);
  });

  it("updates only matching category metrics and deletes blank optional values", () => {
    const doc = fixture();
    const ingredient = doc.vertices.ingredient.find((candidate) => candidate.name === doc.idTable.ingredient[0])!;
    ingredient.price = 4;
    const result = applyGraphLookupRows([{ index: 1, doc }], [
      { map: 1, category: "ingredient", indexData: 0, price: "", speedMul: "99", maxStack: "99" },
      { map: 1, category: "tool", indexData: 0, price: "", speedMul: "1.5", maxStack: "" },
    ]);
    expect(ingredient.price).toBeUndefined();
    expect((doc.vertices.tool[0] as typeof doc.vertices.tool[0] & { speedMul?: number }).speedMul).toBe(1.5);
    expect(result).toEqual({ matched: 2, changed: 2, invalid: 0 });
  });
});
