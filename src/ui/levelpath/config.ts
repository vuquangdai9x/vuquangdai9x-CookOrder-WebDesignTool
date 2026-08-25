// Level Path's view settings: what the config bar holds, and how it survives a
// reload.
//
// These are VIEW state, not level data, so they live in localStorage under
// their own key rather than in the node draft — a designer's preferred column
// widths must not travel with a map, and clearing a map's draft must not reset
// how they like to look at it.

import { button, el } from "../dom.ts";
import { makeScrubber } from "../scrubInput.ts";
import { STAT_VISUALIZE_OPTIONS, wrapHue } from "./metricColor.ts";
import type { ColumnGradient, StatVisualize } from "./metricColor.ts";
import { DEFAULT_BOUNDS, normalizeBounds } from "./generateLevel.ts";
import type { GenerateBounds } from "./generateLevel.ts";

const STORAGE_KEY = "cookorder-levelpath-view";

export interface LevelPathConfig {
  showInfo: boolean;
  showGenerator: boolean;
  showStatistic: boolean;
  visualizeWeather: boolean;
  statVisualize: StatVisualize;
  /** Multiplies every column's base width. */
  widthScale: number;
  textIntensity: number;
  fillIntensity: number;
  /** Per-column base width overrides, keyed by column id. */
  widths: Record<string, number>;
  /** Per-column colour ramps, keyed by column id. Absent = the auto-assigned one. */
  gradients: Record<string, ColumnGradient>;
  /**
   * Where the auto-assigned hues start, rolled once on first run.
   *
   * Persisted so a designer's colour coding survives a reload — a table whose
   * columns changed colour overnight would be worse than one that never
   * coloured them, because the memory of "the green one" is the whole point.
   */
  baseHue: number;
  /** How big a freshly generated level may be — see generateLevel.ts. */
  bounds: GenerateBounds;
  /** Map ids whose foldout is open. */
  openMaps: string[];
}

export function defaultConfig(): LevelPathConfig {
  return {
    showInfo: true,
    showGenerator: true,
    showStatistic: true,
    visualizeWeather: true,
    statVisualize: "both",
    widthScale: 1,
    textIntensity: 1,
    fillIntensity: 1,
    widths: {},
    gradients: {},
    baseHue: Math.floor(Math.random() * 360),
    bounds: { ...DEFAULT_BOUNDS },
    openMaps: [],
  };
}

/**
 * Reads the stored config, filling anything missing from the defaults.
 *
 * Field-by-field rather than a blanket `{...defaults, ...stored}` because a
 * stored value of the wrong TYPE is the failure that actually happens (a
 * hand-edited key, or a field whose shape changed between builds), and spreading
 * would let a string through into a number field and break layout on load.
 */
export function loadConfig(): LevelPathConfig {
  const config = defaultConfig();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return config;
    const stored = JSON.parse(raw) as Partial<LevelPathConfig>;
    const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
    const num = (value: unknown, fallback: number, min: number, max: number) =>
      typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

    config.showInfo = bool(stored.showInfo, config.showInfo);
    config.showGenerator = bool(stored.showGenerator, config.showGenerator);
    config.showStatistic = bool(stored.showStatistic, config.showStatistic);
    config.visualizeWeather = bool(stored.visualizeWeather, config.visualizeWeather);
    if (STAT_VISUALIZE_OPTIONS.some((o) => o.id === stored.statVisualize)) {
      config.statVisualize = stored.statVisualize as StatVisualize;
    }
    config.widthScale = num(stored.widthScale, 1, MIN_WIDTH_SCALE, MAX_WIDTH_SCALE);
    config.textIntensity = num(stored.textIntensity, 1, 0, MAX_INTENSITY);
    config.fillIntensity = num(stored.fillIntensity, 1, 0, MAX_INTENSITY);
    if (stored.widths && typeof stored.widths === "object") {
      for (const [id, width] of Object.entries(stored.widths)) {
        if (typeof width === "number" && Number.isFinite(width)) {
          config.widths[id] = Math.max(MIN_COLUMN_WIDTH, width);
        }
      }
    }
    if (stored.gradients && typeof stored.gradients === "object") {
      for (const [id, gradient] of Object.entries(stored.gradients)) {
        if (
          gradient &&
          typeof gradient === "object" &&
          typeof gradient.fromHue === "number" &&
          typeof gradient.toHue === "number" &&
          Number.isFinite(gradient.fromHue) &&
          Number.isFinite(gradient.toHue)
        ) {
          config.gradients[id] = { fromHue: wrapHue(gradient.fromHue), toHue: wrapHue(gradient.toHue) };
        }
      }
    }
    if (typeof stored.baseHue === "number" && Number.isFinite(stored.baseHue)) {
      config.baseHue = wrapHue(stored.baseHue);
    }
    if (stored.bounds && typeof stored.bounds === "object") {
      for (const key of [
        "minCustomers",
        "maxCustomers",
        "minTotalDishes",
        "maxTotalDishes",
        "minComplexityMaxY",
        "maxComplexityMaxY",
      ] as const) {
        const value = stored.bounds[key];
        if (typeof value === "number" && Number.isFinite(value)) config.bounds[key] = value;
      }
      // Stored bounds can be self-contradictory if they were mid-edit at the
      // last write; the generator must never see that.
      config.bounds = normalizeBounds(config.bounds);
    }
    if (Array.isArray(stored.openMaps)) {
      config.openMaps = stored.openMaps.filter((id): id is string => typeof id === "string");
    }
  } catch (err) {
    console.warn("Level Path view settings could not be read — using defaults", err);
  }
  return config;
}

export function saveConfig(config: LevelPathConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (err) {
    console.warn("Could not persist the Level Path view settings", err);
  }
}

export const MIN_COLUMN_WIDTH = 40;
export const MIN_WIDTH_SCALE = 0.4;
export const MAX_WIDTH_SCALE = 3;
export const MAX_INTENSITY = 2;

export interface ConfigPanelDeps {
  config: LevelPathConfig;
  /** A toggle or dropdown changed — the table has to be rebuilt. */
  onStructuralChange(): void;
  /**
   * A scrubber moved. Fires on every drag frame, so it may only do work that
   * is cheap enough to run at pointer rate — see the view's `applyScales`.
   */
  onScaleChange(): void;
  /** The drag ended (or a value was typed): persist. */
  onCommit(): void;
}

/** One labelled scrub field. */
function scaleField(
  label: string,
  title: string,
  value: number,
  spec: { min: number; max: number; decimals: number },
  onChange: (value: number) => void,
  onCommit: () => void,
): HTMLElement {
  const input = el("input", {
    type: "number",
    step: String(10 ** -spec.decimals),
    value: String(value),
  }) as HTMLInputElement;
  makeScrubber(input, spec, onChange, () => onCommit());
  return el("label", { class: "field small lp-scale-field", title }, [label, input]);
}

function toggle(
  label: string,
  title: string,
  on: boolean,
  onToggle: (next: boolean) => void,
): HTMLElement {
  return button(label, () => onToggle(!on), {
    class: `small-btn${on ? " active" : ""}`,
    title,
  });
}

/** The whole config bar. Rebuilt wholesale whenever the view re-renders — it is a dozen elements. */
export function createConfigPanel(deps: ConfigPanelDeps): HTMLElement {
  const { config } = deps;

  const setToggle = (apply: () => void) => {
    apply();
    deps.onCommit();
    deps.onStructuralChange();
  };

  const visualizeSelect = el("select", {}) as HTMLSelectElement;
  for (const option of STAT_VISUALIZE_OPTIONS) {
    const node = el("option", { value: option.id }, [option.label]) as HTMLOptionElement;
    node.selected = option.id === config.statVisualize;
    visualizeSelect.append(node);
  }
  visualizeSelect.addEventListener("change", () => {
    config.statVisualize = visualizeSelect.value as StatVisualize;
    deps.onCommit();
    deps.onScaleChange();
  });

  return el("div", { class: "lp-config" }, [
    el("div", { class: "toggle-group" }, [
      toggle("Show info", "Show or collapse the info columns", config.showInfo, (next) =>
        setToggle(() => (config.showInfo = next)),
      ),
      toggle(
        "Show generator data",
        "Show or collapse the generator curve and value columns",
        config.showGenerator,
        (next) => setToggle(() => (config.showGenerator = next)),
      ),
      toggle("Show statistic", "Show or collapse the statistic columns", config.showStatistic, (next) =>
        setToggle(() => (config.showStatistic = next)),
      ),
      toggle("Visualize weather", "Tint each row by its weather", config.visualizeWeather, (next) =>
        setToggle(() => (config.visualizeWeather = next)),
      ),
    ]),
    el("label", { class: "field small" }, ["Statistic Visualize", visualizeSelect]),
    scaleField(
      "Column width",
      "Multiplies every column's width. Drag left/right to scrub.",
      config.widthScale,
      { min: MIN_WIDTH_SCALE, max: MAX_WIDTH_SCALE, decimals: 2 },
      (value) => {
        config.widthScale = value;
        deps.onScaleChange();
      },
      deps.onCommit,
    ),
    scaleField(
      "Text colour",
      "Lightness and saturation of the colour that visualizes a statistic's text",
      config.textIntensity,
      { min: 0, max: MAX_INTENSITY, decimals: 2 },
      (value) => {
        config.textIntensity = value;
        deps.onScaleChange();
      },
      deps.onCommit,
    ),
    scaleField(
      "Fill colour",
      "Lightness and saturation of the background fill that visualizes a statistic",
      config.fillIntensity,
      { min: 0, max: MAX_INTENSITY, decimals: 2 },
      (value) => {
        config.fillIntensity = value;
        deps.onScaleChange();
      },
      deps.onCommit,
    ),
    // Generator size lives here rather than in the Auto Generate dialog: it is
    // the answer to "how long is a level in this game", which is a project-wide
    // decision a designer sets once and then generates a hundred levels under —
    // not something to re-answer in every dialog.
    el("div", { class: "lp-bounds" }, [
      el("span", { class: "lp-bounds-label" }, ["Generated size"]),
      boundField("Customers min", config.bounds, "minCustomers", deps),
      boundField("max", config.bounds, "maxCustomers", deps),
      boundField("Dishes min", config.bounds, "minTotalDishes", deps),
      boundField("max", config.bounds, "maxTotalDishes", deps),
      boundField("Complexity min", config.bounds, "minComplexityMaxY", deps),
      boundField("max", config.bounds, "maxComplexityMaxY", deps),
    ]),
    // The ramps are edited on the columns themselves, where the effect is
    // visible while dragging — but nothing about a header says "right-click
    // me", so the discoverability has to come from here.
    el("span", { class: "lp-config-hint" }, [
      "Right-click a statistic column header to set its colour scale.",
    ]),
  ]);
}

/** One bound of the generated-size box. Only applies to the NEXT generate, so nothing repaints. */
function boundField(
  label: string,
  bounds: GenerateBounds,
  key: keyof GenerateBounds,
  deps: ConfigPanelDeps,
): HTMLElement {
  const input = el("input", {
    type: "number",
    min: "1",
    step: "1",
    value: String(bounds[key]),
  }) as HTMLInputElement;
  makeScrubber(input, { min: 1, decimals: 0 }, (value) => (bounds[key] = value), () => deps.onCommit());
  return el("label", { class: "field small lp-bound-field" }, [label, input]);
}
