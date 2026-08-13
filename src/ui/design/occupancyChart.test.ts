import { describe, expect, it } from "vitest";
import type { OccupancySample } from "./estimateDifficulty.ts";
import { pickLineColor, pickTint, scaleOccupancy } from "./occupancyChart.ts";

// Only scaleOccupancy, pickTint, and pickLineColor are unit-tested —
// occupancyChartEl builds real DOM/SVG nodes via document.createElement*,
// and this repo has no jsdom (see curveEditor.ts's own pure/DOM split for
// the established precedent). occupancyChartEl is verified in the browser.

const s = (
  occupied: number,
  dirty: number,
  score = 0,
  random = false,
  pickedNames: string[] = [],
  completesCustomers: number[] = [],
): OccupancySample => ({ occupied, dirty, score, random, pickedNames, completesCustomers });

describe("scaleOccupancy", () => {
  it("maps 0 to the plot's bottom edge and capacity to its top edge", () => {
    const plot = scaleOccupancy([s(0, 0), s(10, 0)], 10, 100, 50);
    expect(plot.occupiedY[0]).toBe(50); // 0 occupied -> plot bottom (y grows downward in SVG)
    expect(plot.occupiedY[1]).toBe(0); // at capacity -> plot top
  });

  it("spaces x evenly across the plot width by pick index", () => {
    const plot = scaleOccupancy([s(0, 0), s(0, 0), s(0, 0)], 10, 100, 50);
    expect(plot.x).toEqual([0, 50, 100]);
  });

  it("puts a single sample at the horizontal center", () => {
    const plot = scaleOccupancy([s(5, 0)], 10, 100, 50);
    expect(plot.x).toEqual([50]);
  });

  it("clamps a value above capacity to the plot's top edge instead of drawing off-chart", () => {
    const plot = scaleOccupancy([s(999, 0)], 10, 100, 50);
    expect(plot.occupiedY[0]).toBe(0);
  });

  it("scales the dirty line independently of the occupied line", () => {
    const plot = scaleOccupancy([s(8, 2)], 10, 100, 50);
    expect(plot.occupiedY[0]).toBeCloseTo(10, 5); // 8/10 up from bottom -> 20% down from top
    expect(plot.dirtyY[0]).toBeCloseTo(40, 5); // 2/10 up from bottom -> 80% down from top
    expect(plot.dirtyY[0]).toBeGreaterThan(plot.occupiedY[0]); // dirty <= occupied always, so its line sits lower
  });

  it("never divides by zero when capacity is 0", () => {
    expect(() => scaleOccupancy([s(0, 0)], 0, 100, 50)).not.toThrow();
    const plot = scaleOccupancy([s(0, 0)], 0, 100, 50);
    expect(Number.isFinite(plot.occupiedY[0])).toBe(true);
  });

  it("returns empty arrays for empty history", () => {
    const plot = scaleOccupancy([], 10, 100, 50);
    expect(plot.x).toEqual([]);
    expect(plot.occupiedY).toEqual([]);
    expect(plot.dirtyY).toEqual([]);
  });
});

describe("pickTint", () => {
  const RANDOM: [number, number, number] = [224, 90, 90];
  const YELLOW: [number, number, number] = [255, 224, 102];

  it("is always fully tinted red for a random pick, regardless of score", () => {
    expect(pickTint(s(0, 0, 999, true))).toEqual({ color: RANDOM, alpha: 1 });
    expect(pickTint(s(0, 0, 0, true))).toEqual({ color: RANDOM, alpha: 1 });
  });

  it("a score of exactly SCORE_BASE (100) reads as fully clear — the 2 best scenarios", () => {
    expect(pickTint(s(0, 0, 100, false))).toEqual({ color: YELLOW, alpha: 0 });
  });

  it("a score above SCORE_BASE (e.g. an urgent sweeper) is clamped clear too, not overshooting negative", () => {
    expect(pickTint(s(0, 0, 120, false))).toEqual({ color: YELLOW, alpha: 0 });
  });

  it("a score of 0 (the weakest possible) is fully yellow-tinted", () => {
    expect(pickTint(s(0, 0, 0, false))).toEqual({ color: YELLOW, alpha: 1 });
  });

  it("interpolates alpha linearly between the two", () => {
    expect(pickTint(s(0, 0, 50, false)).alpha).toBeCloseTo(0.5, 5);
    expect(pickTint(s(0, 0, 40, false)).alpha).toBeCloseTo(0.6, 5);
  });
});

describe("pickLineColor", () => {
  const DEFAULT: [number, number, number] = [240, 164, 65];
  const YELLOW: [number, number, number] = [255, 224, 102];
  const RANDOM: [number, number, number] = [224, 90, 90];

  it("is the plain default/accent color at SCORE_BASE — no tint mixed in", () => {
    expect(pickLineColor(s(0, 0, 100, false))).toEqual(DEFAULT);
  });

  it("is pure yellow at score 0", () => {
    expect(pickLineColor(s(0, 0, 0, false))).toEqual(YELLOW);
  });

  it("is pure red for a random pick", () => {
    expect(pickLineColor(s(0, 0, 0, true))).toEqual(RANDOM);
  });

  it("sits halfway between default and yellow at score 50", () => {
    const [r, g, b] = pickLineColor(s(0, 0, 50, false));
    expect(r).toBeCloseTo((DEFAULT[0] + YELLOW[0]) / 2, 5);
    expect(g).toBeCloseTo((DEFAULT[1] + YELLOW[1]) / 2, 5);
    expect(b).toBeCloseTo((DEFAULT[2] + YELLOW[2]) / 2, 5);
  });
});
