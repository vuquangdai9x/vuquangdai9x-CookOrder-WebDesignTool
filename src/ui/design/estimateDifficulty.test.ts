import { describe, expect, it } from "vitest";
import type { CustomerCost } from "./estimateDifficulty.ts";
import { pickQuality, pickQualityColor, pickQualityLabel } from "./estimateDifficulty.ts";

const cost = (over: Partial<CustomerCost> = {}): CustomerCost => ({
  index: 0,
  gridOccupied: 0,
  gridWaste: 0,
  picks: 0,
  detours: 0,
  randomPicks: 0,
  bestPicks: 0,
  ...over,
});

describe("pickQuality", () => {
  it("is red as soon as one pick had to be random, however good the rest were", () => {
    expect(pickQuality(cost({ picks: 10, bestPicks: 9, randomPicks: 1 }))).toBe("random");
  });

  it("is green when every pick was the best available match", () => {
    expect(pickQuality(cost({ picks: 4, bestPicks: 4 }))).toBe("best");
  });

  it("is green for a customer the solver never had to pick for", () => {
    expect(pickQuality(cost())).toBe("best");
  });

  it("is yellow when some picks were detours or fetched ahead of their base", () => {
    expect(pickQuality(cost({ picks: 4, bestPicks: 3, detours: 1 }))).toBe("mixed");
    expect(pickQuality(cost({ picks: 4, bestPicks: 0 }))).toBe("mixed");
  });

  it("maps each state to a distinct red/yellow/green", () => {
    expect(pickQualityColor("random")).toBe("hsl(0, 70%, 45%)");
    expect(pickQualityColor("mixed")).toBe("hsl(45, 85%, 50%)");
    expect(pickQualityColor("best")).toBe("hsl(120, 70%, 45%)");
  });
});

describe("pickQualityLabel", () => {
  it("names the random picks that made a customer red", () => {
    expect(pickQualityLabel(cost({ picks: 6, bestPicks: 4, randomPicks: 2 }))).toContain("2 random pick(s)");
  });

  it("counts the shortfall for a yellow customer", () => {
    expect(pickQualityLabel(cost({ picks: 5, bestPicks: 2 }))).toContain("3 of 5 pick(s)");
  });

  it("says plainly when nothing had to be picked", () => {
    expect(pickQualityLabel(cost())).toBe("No pick was needed for this customer");
  });
});
