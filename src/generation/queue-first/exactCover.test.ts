import { describe, expect, it } from "vitest";
import type { DishTemplate } from "./dishTemplateCatalog.ts";
import { solveExactCover } from "./exactCover.ts";

const template = (id: string, rawSignature: Record<string, number>, dishTypeWeight = 100): DishTemplate => ({
  id,
  dish: { root: { kind: "composite", id: 0, members: [{ kind: "ingredient", id: 0 }] }, effects: [] },
  orderable: 0,
  orderedIngredients: [0],
  rawSignature,
  complexity: Object.values(rawSignature).reduce((sum, value) => sum + value, 0),
  dishTypeWeight,
});

describe("exact queue-to-dish cover", () => {
  it("finds a multiset that consumes every raw unit exactly", () => {
    const result = solveExactCover(
      { 0: 2, 1: 1 },
      [template("mixed", { 0: 1, 1: 1 }), template("plain", { 0: 1 })],
      { maximumExpandedStates: 100, maximumItems: 4, wallTimeMs: 1_000 },
    );
    expect(result.exact).toBe(true);
    expect(result.templates.map((entry) => entry.id).sort()).toEqual(["mixed", "plain"]);
    expect(result.remaining).toEqual({});
  });

  it("reports the nearest remainder without inventing missing supply", () => {
    const result = solveExactCover(
      { 0: 1, 2: 1 },
      [template("zero", { 0: 1 })],
      { maximumExpandedStates: 100, maximumItems: 4, wallTimeMs: 1_000 },
    );
    expect(result.exact).toBe(false);
    expect(result.remaining).toEqual({ 2: 1 });
  });

  it("uses dish-type weight as a soft preference between valid exact covers", () => {
    const result = solveExactCover(
      { 0: 1 },
      [template("low", { 0: 1 }, 10), template("high", { 0: 1 }, 90)],
      { maximumExpandedStates: 100, maximumItems: 2, wallTimeMs: 1_000 },
    );
    expect(result.exact).toBe(true);
    expect(result.templates[0].id).toBe("high");
  });
});
