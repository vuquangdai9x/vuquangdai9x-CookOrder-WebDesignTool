import { describe, expect, it } from "vitest";
import { defaultCurve, evaluateCurve, parseCurve, serializeCurve } from "./curveEditor.ts";
import type { CurveState } from "./curveEditor.ts";

describe("evaluateCurve", () => {
  it("returns the flat default value across the whole domain", () => {
    const curve = defaultCurve(1, 6);
    expect(evaluateCurve(curve, 0)).toBeCloseTo(3.5, 5);
    expect(evaluateCurve(curve, 0.5)).toBeCloseTo(3.5, 5);
    expect(evaluateCurve(curve, 1)).toBeCloseTo(3.5, 5);
  });

  it("clamps to the endpoint value outside the domain", () => {
    const curve = defaultCurve(1, 6);
    expect(evaluateCurve(curve, -5)).toBeCloseTo(3.5, 5);
    expect(evaluateCurve(curve, 5)).toBeCloseTo(3.5, 5);
  });

  it("hits exact keyframe values at their own x", () => {
    const curve: CurveState = {
      range: { minX: 0, maxX: 1, minY: 0, maxY: 10 },
      keyframes: [
        { x: 0, y: 0, tangent: 0 },
        { x: 0.5, y: 1, tangent: 0 },
        { x: 1, y: 0.2, tangent: 0 },
      ],
    };
    expect(evaluateCurve(curve, 0)).toBeCloseTo(0, 4);
    expect(evaluateCurve(curve, 0.5)).toBeCloseTo(10, 4);
    expect(evaluateCurve(curve, 1)).toBeCloseTo(2, 4);
  });

  it("interpolates linearly when both tangents match the chord slope", () => {
    const curve: CurveState = {
      range: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
      keyframes: [
        { x: 0, y: 0, tangent: 1 },
        { x: 1, y: 1, tangent: 1 },
      ],
    };
    // A straight line (matching end tangents to the chord slope) should be
    // linear: y ≈ x at every sample.
    for (const x of [0, 0.25, 0.5, 0.75, 1]) {
      expect(evaluateCurve(curve, x)).toBeCloseTo(x, 2);
    }
  });

  it("maps real-units X through the configured range before evaluating", () => {
    const curve: CurveState = {
      range: { minX: 10, maxX: 20, minY: 0, maxY: 100 },
      keyframes: [
        { x: 0, y: 0, tangent: 0 },
        { x: 1, y: 1, tangent: 0 },
      ],
    };
    expect(evaluateCurve(curve, 10)).toBeCloseTo(0, 4);
    expect(evaluateCurve(curve, 20)).toBeCloseTo(100, 4);
  });
});

describe("serializeCurve / parseCurve", () => {
  it("round-trips a curve through the string form", () => {
    const curve = defaultCurve(1, 6);
    const fallback = defaultCurve(0, 0);
    expect(parseCurve(serializeCurve(curve), fallback)).toEqual(curve);
  });

  it("falls back on empty input", () => {
    const fallback = defaultCurve(2, 9);
    expect(parseCurve("", fallback)).toEqual(fallback);
  });

  it("falls back on malformed input instead of throwing", () => {
    const fallback = defaultCurve(2, 9);
    expect(parseCurve("not json", fallback)).toEqual(fallback);
    expect(parseCurve("{}", fallback)).toEqual(fallback);
  });
});
