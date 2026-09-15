import { describe, expect, it } from "vitest";
import { partitionAtomicUnits } from "./amountPlanner.ts";

describe("partitionAtomicUnits", () => {
  it("uses legal compact chunks when a stack range has a minimum above one", () => {
    expect(partitionAtomicUnits(7, 5, 3)).toEqual([4, 3]);
    expect(partitionAtomicUnits(6, 5, 4)).toEqual([5, 1]);
    expect(partitionAtomicUnits(2, 5, 3)).toEqual([1, 1]);
  });

  it("preserves exact supply for every partition", () => {
    for (let total = 1; total <= 30; total++) {
      const parts = partitionAtomicUnits(total, 5, 3);
      expect(parts.reduce((sum, part) => sum + part, 0)).toBe(total);
      expect(parts.every((part) => part === 1 || (part >= 3 && part <= 5))).toBe(true);
    }
  });
});
