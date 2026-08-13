// Line chart for Estimate Difficulty's per-pick occupancy history — pure
// DOM/SVG construction, no state of its own, so customerSection.ts can call
// it fresh on every render. See estimateDifficulty.ts's OccupancySample.

import { customerColor } from "./customerColors.ts";
import { SCORE_BASE } from "./estimateDifficulty.ts";
import type { OccupancySample } from "./estimateDifficulty.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** An SVG `<title>` child, for a native hover tooltip on the element it's appended to. */
function titleFor(text: string): SVGTitleElement {
  const title = document.createElementNS(SVG_NS, "title") as SVGTitleElement;
  title.textContent = text;
  return title;
}

const WIDTH = 520;
const HEIGHT = 160;
const PAD = { top: 8, right: 10, bottom: 20, left: 26 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

// Random-fallback picks (see estimateDifficulty.ts step 4) always read as
// this red — reuses --bad's hex so it matches the app's existing warning
// language. Scored picks tint YELLOW_COLOR in over BASE_COLOR (--accent) by
// however far the pick fell short of SCORE_BASE (see pickTint below) — the
// two best-case scores (a dish's base ingredient, or a topping whose base is
// already down) land exactly at SCORE_BASE, so they read as pure BASE_COLOR:
// no tint at all, not merely "the least yellow of the bunch".
const RANDOM_COLOR: [number, number, number] = [224, 90, 90]; // --bad
const BASE_COLOR: [number, number, number] = [240, 164, 65]; // --accent
const YELLOW_COLOR: [number, number, number] = [255, 224, 102];
// Plain gray — the dirty series carries no scoring semantics of its own.
const DIRTY_COLOR = "var(--muted)";

function lerp(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function toCss([r, g, b]: [number, number, number], alpha = 1): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

export interface PickTint {
  /** The hue being tinted in — YELLOW_COLOR for a scored pick, RANDOM_COLOR for a random one. */
  color: [number, number, number];
  /** 0 = clear (no tint at all — this pick was as good as it gets), 1 = full tint. */
  alpha: number;
}

/**
 * How strongly to tint one pick: a random-fallback pick is always fully
 * tinted red. A scored pick is normalized against the FIXED ceiling
 * SCORE_BASE (not this run's own best) — a pick scoring at or above it reads
 * as `alpha: 0`, i.e. genuinely clear, and anything short of it fades toward
 * yellow in direct proportion to the shortfall. Using the absolute ceiling
 * rather than a per-run max is what makes the two best-case scores clear on
 * every level, not just on levels where the solver happened to reach 100.
 */
export function pickTint(sample: OccupancySample): PickTint {
  if (sample.random) return { color: RANDOM_COLOR, alpha: 1 };
  const ratio = Math.min(1, Math.max(0, sample.score / SCORE_BASE));
  return { color: YELLOW_COLOR, alpha: 1 - ratio };
}

/** The solid color a line segment or point renders in: BASE_COLOR tinted per pickTint(). */
export function pickLineColor(sample: OccupancySample): [number, number, number] {
  const tint = pickTint(sample);
  return lerp(BASE_COLOR, tint.color, tint.alpha);
}

/** Max opacity a pick's background band reaches at full tint — 0 tint renders fully transparent. */
const BAND_MAX_ALPHA = 0.3;

export interface OccupancyPlot {
  x: number[];
  occupiedY: number[];
  dirtyY: number[];
}

/**
 * The chart's coordinate math, pulled out from the DOM assembly below so it
 * can be unit tested directly — this repo has no jsdom, so nothing that
 * calls `document.createElement*` is unit-testable (see curveEditor.ts's own
 * pure/DOM split for the established precedent). x is evenly spaced across
 * `plotWidth` by pick index; y is `value` scaled into `[0, plotHeight]`
 * against `capacity`, inverted (SVG y grows downward) and clamped so a
 * value at or above capacity never draws past the plot's top edge.
 */
export function scaleOccupancy(
  history: OccupancySample[],
  capacity: number,
  plotWidth: number,
  plotHeight: number,
): OccupancyPlot {
  const n = history.length;
  const maxY = Math.max(1, capacity);
  const xAt = (i: number) => (n <= 1 ? plotWidth / 2 : (i / (n - 1)) * plotWidth);
  const yAt = (v: number) => plotHeight - (Math.min(Math.max(v, 0), maxY) / maxY) * plotHeight;
  return {
    x: history.map((_, i) => xAt(i)),
    occupiedY: history.map((s) => yAt(s.occupied)),
    dirtyY: history.map((s) => yAt(s.dirty)),
  };
}

/** Hover text for one pick's point marker. */
function pointTooltip(index: number, sample: OccupancySample): string {
  const names = sample.pickedNames.length ? sample.pickedNames.join(", ") : "—";
  const scoreLabel = sample.random ? "random (nothing scored)" : String(sample.score);
  return (
    `Pick ${index + 1}: ${names}\n` +
    `Score: ${scoreLabel}\n` +
    `Grid occupied: ${sample.occupied} (dirty ${sample.dirty})`
  );
}

/**
 * Builds the occupied-vs-dirty line chart plus its legend. `history[i]` is
 * the board state after pick #(i+1) — the x-axis is pickup order, the y-axis
 * is grid cells, capped at `capacity` (the board's total cell count, drawn as
 * a dashed reference line — touching it is what a grid/dirty-overflow loss
 * looks like). Each pick's background band, step point, and the occupied
 * line's incoming segment are all colored by pickTint()/pickLineColor(), so a
 * designer can see at a glance which picks the solver was confident in
 * (clear/no tint), which were a weak "took what it could get" choice
 * (yellow), and which had nothing to go on at all (red, random). A vertical
 * line — in that customer's own color, with a "#N" label — marks any pick
 * that finished a customer's order.
 */
export function occupancyChartEl(history: OccupancySample[], capacity: number): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "occupancy-chart";

  const legend = document.createElement("div");
  legend.className = "occupancy-legend";
  wrap.append(legend);
  legend.append(
    legendItem("scored", "Scored pick (clear → yellow = weaker)"),
    legendItem("random", "Random pick"),
    legendItem("dirty", "Dirty stacks"),
    legendItem("capacity", "Grid capacity"),
    legendItem("served", "Customer served (that customer's color)"),
  );

  if (history.length === 0) {
    const empty = document.createElement("div");
    empty.className = "occupancy-empty";
    empty.textContent = "No picks recorded.";
    wrap.append(empty);
    return wrap;
  }

  const n = history.length;
  const maxY = Math.max(1, capacity);
  const plot = scaleOccupancy(history, capacity, PLOT_W, PLOT_H);
  const toAbs = (v: number) => PAD.top + v; // plot-local y -> svg-local y

  const svg = svgEl("svg", {
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    class: "occupancy-chart-svg",
    role: "img",
    "aria-label": "Grid cells occupied after each pickup",
  });

  // Per-pick background bands, drawn first so everything else sits on top —
  // one band per history entry, spanning the midpoints to its neighbors.
  // A pick with no tint (pickTint().alpha === 0) renders fully transparent,
  // so a run of confident picks shows no band at all, not a faint wash.
  for (let i = 0; i < n; i++) {
    const left = i === 0 ? 0 : (plot.x[i - 1] + plot.x[i]) / 2;
    const right = i === n - 1 ? PLOT_W : (plot.x[i] + plot.x[i + 1]) / 2;
    const tint = pickTint(history[i]);
    const color = toCss(tint.color, tint.alpha * BAND_MAX_ALPHA);
    svg.append(
      svgEl("rect", {
        x: String(PAD.left + left), y: String(PAD.top),
        width: String(Math.max(0, right - left)), height: String(PLOT_H),
        fill: color, class: "occupancy-pick-band",
      }),
    );
  }

  // A single-value scaler for the gridlines/capacity line, reusing the same
  // formula scaleOccupancy applies per-sample.
  const yForValue = (value: number) => PAD.top + PLOT_H - (Math.min(Math.max(value, 0), maxY) / maxY) * PLOT_H;

  // Y-axis gridlines + labels: 0, half capacity, full capacity.
  for (const frac of [0, 0.5, 1]) {
    const value = Math.round(maxY * frac);
    const y = yForValue(value);
    svg.append(
      svgEl("line", {
        x1: String(PAD.left), x2: String(PAD.left + PLOT_W), y1: String(y), y2: String(y),
        class: "occupancy-gridline",
      }),
    );
    const label = svgEl("text", { x: String(PAD.left - 4), y: String(y + 3), class: "occupancy-axis-label" });
    label.textContent = String(value);
    svg.append(label);
  }

  // Capacity reference line — dashed, distinct from the plain gridlines above.
  const capY = yForValue(capacity);
  svg.append(
    svgEl("line", {
      x1: String(PAD.left), x2: String(PAD.left + PLOT_W), y1: String(capY), y2: String(capY),
      class: "occupancy-capacity-line",
    }),
  );

  const xLabel = svgEl("text", {
    x: String(PAD.left + PLOT_W), y: String(HEIGHT - 4), class: "occupancy-axis-label occupancy-axis-label-x",
  });
  xLabel.textContent = `pick ${n}`;
  svg.append(xLabel);
  const xLabelStart = svgEl("text", {
    x: String(PAD.left), y: String(HEIGHT - 4), class: "occupancy-axis-label occupancy-axis-label-x-start",
  });
  xLabelStart.textContent = "pick 1";
  svg.append(xLabelStart);

  // Customer-completion markers: a full-height vertical line at any pick
  // that finished a customer's order, in that customer's own color — drawn
  // before the data series so the line/points stay legible on top of it.
  for (let i = 0; i < n; i++) {
    const completed = history[i].completesCustomers;
    if (completed.length === 0) continue;
    const x = PAD.left + plot.x[i];
    for (const customerIndex of completed) {
      const color = customerColor(customerIndex);
      const line = svgEl("line", {
        x1: String(x), x2: String(x), y1: String(PAD.top), y2: String(PAD.top + PLOT_H),
        class: "occupancy-complete-line", stroke: color,
      });
      line.append(titleFor(`Customer #${customerIndex + 1} served at pick ${i + 1}`));
      svg.append(line);
    }
  }

  // Dirty line stays one plain gray — it's a secondary reference series, not
  // the thing being scored per-pick.
  const dirtyPoints = plot.x.map((x, i) => `${PAD.left + x},${toAbs(plot.dirtyY[i])}`).join(" ");
  svg.append(
    svgEl("polyline", {
      points: dirtyPoints, fill: "none", class: "occupancy-line occupancy-line-dirty", stroke: DIRTY_COLOR,
    }),
  );

  // Occupied line: one segment per consecutive pair, each colored by the
  // color of the pick it arrives at, plus a step-point marker at every pick.
  for (let i = 1; i < n; i++) {
    const color = toCss(pickLineColor(history[i]), 0.9);
    svg.append(
      svgEl("line", {
        x1: String(PAD.left + plot.x[i - 1]), y1: String(toAbs(plot.occupiedY[i - 1])),
        x2: String(PAD.left + plot.x[i]), y2: String(toAbs(plot.occupiedY[i])),
        class: "occupancy-line occupancy-line-occupied", stroke: color,
      }),
    );
  }
  for (let i = 0; i < n; i++) {
    const color = toCss(pickLineColor(history[i]), 1);
    const point = svgEl("circle", {
      cx: String(PAD.left + plot.x[i]), cy: String(toAbs(plot.occupiedY[i])), r: "2.3",
      class: "occupancy-point", fill: color,
    });
    point.append(titleFor(pointTooltip(i, history[i])));
    svg.append(point);
  }

  // Completion labels last, on top of everything, so they're never hidden
  // under the data line or a neighboring band.
  for (let i = 0; i < n; i++) {
    const completed = history[i].completesCustomers;
    if (completed.length === 0) continue;
    const x = PAD.left + plot.x[i];
    completed.forEach((customerIndex, k) => {
      const label = svgEl("text", {
        x: String(x + 2), y: String(PAD.top + 8 + k * 9),
        class: "occupancy-complete-label", fill: customerColor(customerIndex),
      });
      label.textContent = `#${customerIndex + 1}`;
      svg.append(label);
    });
  }

  wrap.append(svg);
  return wrap;
}

function legendItem(kind: string, label: string): HTMLElement {
  const item = document.createElement("span");
  item.className = "occupancy-legend-item";
  const swatch = document.createElement("span");
  swatch.className = `occupancy-legend-swatch occupancy-legend-swatch-${kind}`;
  item.append(swatch, document.createTextNode(label));
  return item;
}
