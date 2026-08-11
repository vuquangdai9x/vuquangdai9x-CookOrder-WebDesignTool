import { describe, expect, it } from "vitest";
import { parseIngredientWeights, serializeIngredientWeights } from "./ingredientWeightEditor.ts";

describe("parseIngredientWeights", () => {
  it("parses id:weight pairs separated by ;", () => {
    const weights = parseIngredientWeights("3:100;7:40;12:5");
    expect(weights).toEqual(new Map([[3, 100], [7, 40], [12, 5]]));
  });

  it("returns an empty map for empty/blank input", () => {
    expect(parseIngredientWeights("")).toEqual(new Map());
    expect(parseIngredientWeights("   ")).toEqual(new Map());
  });

  it("clamps out-of-range weights into 0-100", () => {
    const weights = parseIngredientWeights("1:150;2:-20");
    expect(weights.get(1)).toBe(100);
    expect(weights.get(2)).toBe(0);
  });

  it("skips malformed entries instead of throwing", () => {
    const weights = parseIngredientWeights("3:100;garbage;7:40");
    expect(weights).toEqual(new Map([[3, 100], [7, 40]]));
  });
});

describe("serializeIngredientWeights", () => {
  it("writes only nonzero weights, sorted by id", () => {
    const weights = new Map([[7, 40], [3, 100], [12, 0]]);
    expect(serializeIngredientWeights(weights)).toBe("3:100;7:40");
  });

  it("round-trips through parseIngredientWeights", () => {
    const weights = new Map([[0, 100], [5, 50]]);
    expect(parseIngredientWeights(serializeIngredientWeights(weights))).toEqual(weights);
  });

  it("produces an empty string when every weight is 0", () => {
    expect(serializeIngredientWeights(new Map([[1, 0], [2, 0]]))).toBe("");
  });
});
