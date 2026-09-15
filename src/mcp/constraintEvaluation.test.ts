import { describe, expect, it } from "vitest";
import { evaluateConstraint, percentile, proportionInterval } from "./constraintEvaluation.ts";

describe("constraint evaluation", () => {
  it("scores numeric ranges and equality with normalized gaps", () => {
    const base = { id: "duration", dimension: "experience", metric: "experience.durationP50", priority: "target" as const, weight: 3, source: "test" };
    expect(evaluateConstraint({ ...base, operator: "between", value: [60, 90] }, 75).pass).toBe(true);
    expect(evaluateConstraint({ ...base, operator: "<=", value: 90 }, 99).normalizedGap).toBeCloseTo(0.1);
    expect(evaluateConstraint({ ...base, operator: "=", value: 3 }, 4).pass).toBe(false);
  });

  it("provides bounded statistical summaries", () => {
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
    const interval = proportionInterval(8, 10);
    expect(interval[0]).toBeGreaterThanOrEqual(0);
    expect(interval[1]).toBeLessThanOrEqual(1);
  });
});
