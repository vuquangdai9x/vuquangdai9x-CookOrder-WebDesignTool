// Turning a statistic into a colour.
//
// The Level Path table's job is to make a map's difficulty CURVE visible at a
// glance, which means a number has to read as "high for this metric" without
// the designer comparing it to the column above and below. So every statistic
// is normalized against its own range across the levels on screen, and the
// normalized position — never the raw value — drives the colour.
//
// Every column carries its OWN gradient. One shared ramp made two adjacent
// columns look like one reading: a red cell beside a red cell says "both high"
// only if you already know they are different metrics. A per-column hue means
// each column reads as its own channel, and "high" is a column's own bright
// end rather than a colour you have to decode.
//
// Two intensity knobs rather than one because the two channels fight: text
// colour has to stay legible on the panel, while a background fill has to stay
// quiet enough not to drown the text on top of it. A designer who wants a loud
// heat map and readable numbers needs to turn those independently.

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const pct = (v: number): number => Math.max(0, Math.min(100, v));
export const wrapHue = (h: number): number => ((h % 360) + 360) % 360;

/**
 * One column's ramp: the hue at the low end and at the high end.
 *
 * Equal hues is the MONOCHROMATIC default — one colour going from dim and
 * desaturated to bright and saturated. That is deliberately the starting point
 * rather than a rainbow: a monochromatic ramp has an unambiguous direction
 * (brighter = more), while a multi-hue ramp needs a legend before anyone can
 * say which end is which.
 */
export interface ColumnGradient {
  fromHue: number;
  toHue: number;
}

export const isMonochromatic = (gradient: ColumnGradient): boolean =>
  wrapHue(gradient.fromHue) === wrapHue(gradient.toHue);

/**
 * The golden angle, used to space the auto-assigned hues.
 *
 * Drawing each column's hue independently at random is what the eye reads as
 * "random", but it also collides: with twenty columns, two of them landing
 * within a few degrees of each other is likely, and those two columns then look
 * like the same channel. Stepping by the golden angle from a random base gives
 * hues that are arbitrary (nobody can predict which column is which colour) yet
 * maximally separated, which is the property that actually matters here.
 */
const GOLDEN_ANGLE = 137.508;

export function defaultGradient(index: number, baseHue: number): ColumnGradient {
  const hue = wrapHue(baseHue + index * GOLDEN_ANGLE);
  return { fromHue: hue, toHue: hue };
}

/** The observed span of one metric across every level on screen. */
export interface MetricRange {
  min: number;
  max: number;
}

export function metricRange(values: number[]): MetricRange {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return Number.isFinite(min) ? { min, max } : { min: 0, max: 0 };
}

/**
 * Where a value sits in its metric's range, 0..1.
 *
 * A flat metric (every level identical) returns 0 rather than 0.5: a column
 * where nothing varies carries no signal, and colouring it mid-ramp would give
 * it the visual weight of a middling reading it has not earned.
 */
export function normalizeMetric(value: number, range: MetricRange): number {
  if (!Number.isFinite(value)) return 0;
  const span = range.max - range.min;
  if (span <= 0) return 0;
  return clamp01((value - range.min) / span);
}

/** Hue at position `t`, walking the SHORT way round the wheel between the two ends. */
function hueAt(gradient: ColumnGradient, t: number): number {
  const from = wrapHue(gradient.fromHue);
  const to = wrapHue(gradient.toHue);
  let delta = to - from;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return wrapHue(from + delta * clamp01(t));
}

/**
 * Which way the ramp runs.
 *
 * On a dark panel "more" reads as BRIGHTER; on a white one the same colour is
 * nearly invisible and "more" has to read as DARKER. The hue and the saturation
 * ramp are identical either way — only the lightness axis flips — so a column a
 * designer has tuned keeps its identity across a theme switch.
 */
export type RampMode = "dark" | "light";

/**
 * Text colour for a normalized value.
 *
 * `intensity` 0 leaves it the table's ordinary grey — the honest
 * "visualisation off" state, with no lightness ramp either, so a column that is
 * turned down cannot still be whispering. Rising intensity opens up both the
 * saturation and the dim-to-vivid spread that carries the reading.
 */
export function metricTextColor(
  t: number,
  intensity: number,
  gradient: ColumnGradient,
  mode: RampMode = "dark",
): string {
  const position = clamp01(t);
  const strength = Math.max(0, intensity);
  const saturation = pct(72 * (0.25 + 0.75 * position) * strength);
  const spread = Math.min(1, strength);
  // The two ends are tuned so even the LOW end clears legibility against its
  // own background — a faint value is still a value someone has to read, and a
  // ramp that fades its bottom into the page is one that has lost half its rows.
  const lightness =
    mode === "light"
      ? pct(28 + 28 * (1 - position) * spread)
      : pct(74 - 24 * (1 - position) * spread);
  return `hsl(${hueAt(gradient, position).toFixed(1)}, ${saturation.toFixed(1)}%, ${lightness.toFixed(1)}%)`;
}

/**
 * Background fill for a normalized value. Alpha carries most of the intensity
 * so the fill fades to nothing at 0 instead of banding into a flat dark block,
 * and the lightness stays low enough that the text on top survives.
 *
 * The default (intensity 1) deliberately stops well short of opaque: in "Both"
 * mode the text is tinted the SAME hue, and a fill strong enough to be pretty
 * on its own is a fill the numbers disappear into. Turning the scrubber up is
 * one drag; noticing that a column has quietly become unreadable is not.
 */
export function metricFillColor(
  t: number,
  intensity: number,
  gradient: ColumnGradient,
  mode: RampMode = "dark",
): string {
  const position = clamp01(t);
  const strength = Math.max(0, intensity);
  const saturation = pct(62 * (0.3 + 0.7 * position) * strength);
  // A light theme's fill has to stay well ABOVE the text it sits behind, the
  // mirror of the dark theme's staying well below it.
  const lightness = mode === "light" ? pct(88 - 16 * position) : pct(18 + 16 * position);
  const alpha = clamp01((0.06 + 0.3 * strength) * (0.35 + 0.65 * position));
  return `hsla(${hueAt(gradient, position).toFixed(1)}, ${saturation.toFixed(1)}%, ${lightness.toFixed(1)}%, ${alpha.toFixed(3)})`;
}

// ---------- hue <-> hex, for the editor's colour pickers ----------
// `<input type="color">` speaks hex; the ramp model stores only a hue, because
// saturation and lightness are what the ramp itself spends to show low versus
// high (see metricTextColor). These two convert at that boundary and nowhere
// else.

/** A fully saturated, mid-lightness sample of a hue — what the picker opens on. */
export function hexOfHue(hue: number): string {
  const h = wrapHue(hue) / 60;
  const c = 1;
  const x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] =
    h < 1 ? [c, x, 0]
    : h < 2 ? [x, c, 0]
    : h < 3 ? [0, c, x]
    : h < 4 ? [0, x, c]
    : h < 5 ? [x, 0, c]
    : [c, 0, x];
  // Mixed halfway to white so the swatch reads as a colour rather than a
  // fluorescent primary — the hue is identical either way.
  const channel = (v: number) =>
    Math.round((v * 0.5 + 0.5 * 0.5 + 0.25) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * The hue of a picked colour, or null when it has none.
 *
 * A grey has no hue to move to, so a pick of one is ignored rather than
 * silently snapping the column to red (hue 0), which is what the naive
 * conversion does.
 */
export function hueOfHex(hex: string): number | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta < 1e-6) return null;
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return wrapHue(hue * 60);
}

/** A left-to-right preview of the whole ramp, for the gradient editor's swatch. */
export function gradientPreviewCss(
  gradient: ColumnGradient,
  intensity = 1,
  mode: RampMode = "dark",
): string {
  const stops = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => `${metricTextColor(t, intensity, gradient, mode)} ${(t * 100).toFixed(0)}%`)
    .join(", ");
  return `linear-gradient(90deg, ${stops})`;
}

/** What the config bar's "Statistic Visualize" dropdown selects. */
export type StatVisualize = "none" | "text" | "fill" | "both";

export const STAT_VISUALIZE_OPTIONS: { id: StatVisualize; label: string }[] = [
  { id: "none", label: "None" },
  { id: "text", label: "Text" },
  { id: "fill", label: "Fill" },
  { id: "both", label: "Both" },
];

/** Applies the selected visualisation to one cell. Called for every statistic cell, so it stays allocation-light. */
export function paintMetricCell(
  cell: HTMLElement,
  t: number,
  mode: StatVisualize,
  textIntensity: number,
  fillIntensity: number,
  gradient: ColumnGradient,
  ramp: RampMode = "dark",
): void {
  cell.style.color =
    mode === "text" || mode === "both" ? metricTextColor(t, textIntensity, gradient, ramp) : "";
  cell.style.background =
    mode === "fill" || mode === "both" ? metricFillColor(t, fillIntensity, gradient, ramp) : "";
}
