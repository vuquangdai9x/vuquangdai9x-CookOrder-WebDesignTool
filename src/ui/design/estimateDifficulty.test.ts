import { describe, expect, it } from "vitest";
import type { CustomerCost } from "./estimateDifficulty.ts";
import { difficultyColor, difficultyRatio } from "./estimateDifficulty.ts";

describe("difficultyColor", () => {
  it("is green at 0 and red at 1", () => {
    expect(difficultyColor(0)).toBe("hsl(120, 70%, 45%)");
    expect(difficultyColor(1)).toBe("hsl(0, 70%, 45%)");
  });

  it("clamps out-of-range ratios instead of producing an invalid hue", () => {
    expect(difficultyColor(-5)).toBe(difficultyColor(0));
    expect(difficultyColor(5)).toBe(difficultyColor(1));
  });

  it("moves monotonically from green to red as the ratio rises", () => {
    const hueOf = (c: string) => Number(c.match(/hsl\((-?\d+)/)![1]);
    expect(hueOf(difficultyColor(0.25))).toBeGreaterThan(hueOf(difficultyColor(0.75)));
  });
});

const cost = (gridOccupied: number): CustomerCost => ({
  index: 0, gridOccupied, gridWaste: 0, picks: 0, detours: 0,
});

describe("difficultyRatio", () => {
  it("scales against this level's worst customer, not a fixed board size", () => {
    // A customer occupying 3 cells is the WORST in an easy level (max 3) —
    // full red — but only middling in a harder level (max 10).
    expect(difficultyRatio(3, [cost(1), cost(3)])).toBe(1);
    expect(difficultyRatio(3, [cost(1), cost(3), cost(10)])).toBeCloseTo(0.3);
  });

  it("zero occupied is always zero, regardless of how hard the level is", () => {
    expect(difficultyRatio(0, [cost(0), cost(8)])).toBe(0);
  });

  it("returns 0 when every customer in the level occupies nothing, instead of dividing by zero", () => {
    expect(difficultyRatio(0, [cost(0), cost(0)])).toBe(0);
    expect(Number.isFinite(difficultyRatio(0, []))).toBe(true);
  });

  it("the worst customer in the level always reads exactly 1 (full red)", () => {
    const perCustomer = [cost(2), cost(7), cost(4)];
    expect(difficultyRatio(7, perCustomer)).toBe(1);
  });
});
