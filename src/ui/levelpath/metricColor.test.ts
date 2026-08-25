import { describe, expect, it } from "vitest";
import {
  defaultGradient,
  isMonochromatic,
  metricFillColor,
  metricRange,
  metricTextColor,
  normalizeMetric,
  wrapHue,
} from "./metricColor.ts";
import type { ColumnGradient } from "./metricColor.ts";

const mono = (hue: number): ColumnGradient => ({ fromHue: hue, toHue: hue });
const hueOf = (css: string) => Number(/hsla?\(([\d.]+),/.exec(css)![1]);
const satOf = (css: string) => Number(/hsla?\([^,]+, ([\d.]+)%/.exec(css)![1]);
const lightOf = (css: string) => Number(/hsla?\([^,]+, [\d.]+%, ([\d.]+)%/.exec(css)![1]);

describe("metricRange", () => {
  it("spans the observed values", () => {
    expect(metricRange([3, 9, 5])).toEqual({ min: 3, max: 9 });
  });

  it("ignores non-finite readings rather than poisoning the whole range", () => {
    expect(metricRange([2, NaN, 8, Infinity])).toEqual({ min: 2, max: 8 });
  });

  it("collapses to zero when there is nothing to measure", () => {
    expect(metricRange([])).toEqual({ min: 0, max: 0 });
  });
});

describe("normalizeMetric", () => {
  const range = { min: 10, max: 20 };

  it("maps the ends to 0 and 1", () => {
    expect(normalizeMetric(10, range)).toBe(0);
    expect(normalizeMetric(20, range)).toBe(1);
    expect(normalizeMetric(15, range)).toBeCloseTo(0.5);
  });

  it("clamps values outside the range", () => {
    expect(normalizeMetric(-5, range)).toBe(0);
    expect(normalizeMetric(99, range)).toBe(1);
  });

  it("reads a flat metric as 0, not as a middling value", () => {
    // Every level identical carries no signal; mid-ramp would give it colour it
    // has not earned.
    expect(normalizeMetric(7, { min: 7, max: 7 })).toBe(0);
  });
});

describe("defaultGradient", () => {
  it("starts every column monochromatic", () => {
    for (let i = 0; i < 10; i++) expect(isMonochromatic(defaultGradient(i, 30))).toBe(true);
  });

  it("keeps neighbouring columns far apart on the wheel", () => {
    const hues = Array.from({ length: 20 }, (_, i) => defaultGradient(i, 200).fromHue);
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const raw = Math.abs(hues[i] - hues[j]);
        const apart = Math.min(raw, 360 - raw);
        // Twenty independently-random hues would collide; the golden-angle walk
        // is what makes each column its own readable channel.
        expect(apart).toBeGreaterThan(10);
      }
    }
  });

  it("is stable for a given column index and base hue", () => {
    expect(defaultGradient(4, 77)).toEqual(defaultGradient(4, 77));
  });
});

describe("colour ramps", () => {
  it("goes fully neutral at intensity 0 — no hue and no lightness ramp", () => {
    const low = metricTextColor(0, 0, mono(120));
    const high = metricTextColor(1, 0, mono(120));
    expect(satOf(low)).toBe(0);
    expect(satOf(high)).toBe(0);
    // Turning a column down must silence it completely, not leave it whispering
    // through a brightness difference.
    expect(lightOf(low)).toBe(lightOf(high));
  });

  it("runs a monochromatic column from dim to bright at one hue", () => {
    const gradient = mono(210);
    const low = metricTextColor(0, 1, gradient);
    const high = metricTextColor(1, 1, gradient);
    expect(hueOf(low)).toBeCloseTo(210);
    expect(hueOf(high)).toBeCloseTo(210);
    expect(satOf(high)).toBeGreaterThan(satOf(low));
    expect(lightOf(high)).toBeGreaterThan(lightOf(low));
  });

  it("walks a two-hue ramp the short way round the wheel", () => {
    // 350 -> 10 crosses zero; the midpoint is 0, not 180.
    const mid = hueOf(metricTextColor(0.5, 1, { fromHue: 350, toHue: 10 }));
    expect(Math.min(mid, 360 - mid)).toBeLessThan(1);
  });

  it("keeps every channel inside its legal range at extreme intensities", () => {
    for (const t of [0, 0.5, 1]) {
      for (const intensity of [0, 1, 2, 10]) {
        const text = metricTextColor(t, intensity, mono(45));
        expect(satOf(text)).toBeLessThanOrEqual(100);
        expect(lightOf(text)).toBeGreaterThanOrEqual(0);
        expect(lightOf(text)).toBeLessThanOrEqual(100);

        const fill = metricFillColor(t, intensity, mono(45));
        expect(satOf(fill)).toBeLessThanOrEqual(100);
        expect(lightOf(fill)).toBeLessThanOrEqual(100);
        expect(Number(/,\s*([\d.]+)\)$/.exec(fill)![1])).toBeLessThanOrEqual(1);
      }
    }
  });

  it("inverts the lightness ramp for a light background", () => {
    const gradient = mono(210);
    const darkHigh = lightOf(metricTextColor(1, 1, gradient, "dark"));
    const darkLow = lightOf(metricTextColor(0, 1, gradient, "dark"));
    const lightHigh = lightOf(metricTextColor(1, 1, gradient, "light"));
    const lightLow = lightOf(metricTextColor(0, 1, gradient, "light"));

    // On a dark panel "more" is brighter; on a white one it has to be darker,
    // or the high end of every column vanishes into the page.
    expect(darkHigh).toBeGreaterThan(darkLow);
    expect(lightHigh).toBeLessThan(lightLow);
    // The hue is the column's identity and must survive the theme switch.
    expect(hueOf(metricTextColor(1, 1, gradient, "light"))).toBeCloseTo(210);
  });

  it("keeps a light-theme fill above the text it sits behind", () => {
    const fill = lightOf(metricFillColor(1, 1, mono(210), "light"));
    const text = lightOf(metricTextColor(1, 1, mono(210), "light"));
    expect(fill).toBeGreaterThan(text + 20);
  });

  it("normalizes hues onto the wheel", () => {
    expect(wrapHue(-30)).toBe(330);
    expect(wrapHue(400)).toBe(40);
    expect(hueOf(metricTextColor(1, 1, mono(-30)))).toBeCloseTo(330);
  });
});
