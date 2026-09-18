import type { GraphIndex } from "../../core/nodeIndex.ts";
import type { IdIndex } from "../../data/nodeIdTable.ts";
import type { ProjectedMap } from "../../data/nodeGraphToMapDef.ts";
import {
  clampCoverage,
  type CoverageBySize,
  type ObstacleCoverageBasis,
  type SharedGenerationProfileV2,
} from "../../generation/sharedGenerationProfile.ts";
import type { WeightSet } from "../design/ingredientWeightEditor.ts";
import { button, el } from "../dom.ts";
import { createDishWeightEditor } from "../levelpath/dishWeightEditor.ts";
import { makeScrubber } from "../scrubInput.ts";
import { createVerticalPercentSlider } from "./verticalPercentSlider.ts";

export interface SharedProfileEditorOptions {
  profile: SharedGenerationProfileV2;
  ix: GraphIndex;
  ids: IdIndex;
  projected: ProjectedMap;
  basis: ObstacleCoverageBasis;
  impactText: string;
  foldoutState?: Map<string, boolean>;
  statePrefix?: string;
  mode?: "visual" | "json";
  showModeToggle?: boolean;
  onChange(profile: SharedGenerationProfileV2): void;
}

const sizes = [2, 3, 4, 5] as const;

function projectedCount(coverage: number, basis: number, groupSize = 1): number {
  if (basis <= 0) return 0;
  return Math.round((clampCoverage(coverage) * basis) / groupSize);
}

function coverageSlider(
  label: string,
  icon: string,
  value: number,
  basis: number,
  assign: (value: number) => void,
  changed: () => void,
  groupSize = 1,
): HTMLElement {
  const percent = Math.round(clampCoverage(value) * 100);
  return createVerticalPercentSlider({
    label,
    icon,
    value: percent,
    formatValue: (nextPercent) => `${nextPercent}% ≈ ${projectedCount(nextPercent / 100, basis, groupSize)}`,
    onInput: (nextPercent) => {
    const next = clampCoverage(nextPercent / 100);
    assign(next);
    changed();
    },
  });
}

function coverageGrid(
  profile: SharedGenerationProfileV2,
  basis: ObstacleCoverageBasis,
  changed: () => void,
): HTMLElement {
  const warning = el("p", { class: "qf-coverage-warning" });
  const refreshWarning = (): void => {
    const queue = profile.obstacles.queue.hidden + profile.obstacles.queue.frozen
      + Object.values(profile.obstacles.queue.combinedBySize).reduce((sum, value) => sum + value, 0)
      + Object.values(profile.obstacles.queue.linkedBySize).reduce((sum, value) => sum + value, 0);
    const customer = Object.values(profile.obstacles.customer).reduce((sum, value) => sum + value, 0);
    const issues = [
      ...(queue > 1 ? [`Queue total ${Math.round(queue * 100)}% exceeds 100%.`] : []),
      ...(customer > 1 ? [`Customer special total ${Math.round(customer * 100)}% exceeds 100%.`] : []),
    ];
    warning.textContent = issues.join(" ");
    warning.hidden = issues.length === 0;
  };
  const notify = (): void => { refreshWarning(); changed(); };
  const group = (
    title: string,
    values: CoverageBySize,
    assign: (size: 2 | 3 | 4 | 5, value: number) => void,
  ): HTMLElement => el("div", {}, [
    el("h5", {}, [title]),
    el("div", { class: "qf-coverage-grid" }, sizes.map((size) =>
      coverageSlider(`${size} slots`, title.startsWith("Combined") ? "🧩" : "🔗", values[size], basis.queueSlots, (value) => assign(size, value), notify, size),
    )),
  ]);
  refreshWarning();
  return el("div", { class: "shared-obstacle-editor" }, [
    el("h5", {}, [`Queue · ${basis.queueSlots || "no preview"} slots`]),
    el("div", { class: "qf-coverage-grid" }, [
      coverageSlider("Hidden", "🙈", profile.obstacles.queue.hidden, basis.queueSlots, (v) => { profile.obstacles.queue.hidden = v; }, notify),
      coverageSlider("Frozen", "❄️", profile.obstacles.queue.frozen, basis.queueSlots, (v) => { profile.obstacles.queue.frozen = v; }, notify),
    ]),
    el("div", { class: "qf-coverage-groups" }, [
      group("Combined groups", profile.obstacles.queue.combinedBySize, (size, value) => { profile.obstacles.queue.combinedBySize[size] = value; }),
      group("Linked groups", profile.obstacles.queue.linkedBySize, (size, value) => { profile.obstacles.queue.linkedBySize[size] = value; }),
    ]),
    el("h5", {}, [`Customers · ${basis.orderingCustomers || "no preview"} ordering`]),
    el("div", { class: "qf-coverage-grid" }, [
      coverageSlider("Timed", "⏱️", profile.obstacles.customer.timed, basis.orderingCustomers, (v) => { profile.obstacles.customer.timed = v; }, notify),
      coverageSlider("Shipper", "🚚", profile.obstacles.customer.shipper, basis.orderingCustomers, (v) => { profile.obstacles.customer.shipper = v; }, notify),
      coverageSlider("Boss", "👑", profile.obstacles.customer.boss, basis.orderingCustomers, (v) => { profile.obstacles.customer.boss = v; }, notify),
    ]),
    warning,
  ]);
}

function visualEditor(options: SharedProfileEditorOptions, profile: SharedGenerationProfileV2, changed: () => void): HTMLElement {
  const foldout = (title: string, children: Node[], hint: string): HTMLElement => {
    const details = el("details", {
      class: "qf-visual-section qf-config-foldout",
    }, [el("summary", { title: hint }, [title]), el("div", { class: "qf-config-foldout-body" }, children)]);
    const key = `${options.statePrefix ?? "shared:"}${title}`;
    details.open = options.foldoutState?.get(key) ?? false;
    details.addEventListener("toggle", () => options.foldoutState?.set(key, details.open));
    return details;
  };
  const seed = el("input", {
    type: "number",
    min: "0",
    step: "1",
    placeholder: "auto",
    value: profile.seed === undefined ? "" : String(profile.seed),
    title: "Type or drag horizontally. Blank lets the generator choose.",
  }) as HTMLInputElement;
  const seedEnabled = el("input", { type: "checkbox", title: "Enable a fixed random seed", "aria-label": "Enable a fixed random seed" }) as HTMLInputElement;
  seedEnabled.checked = profile.seed !== undefined;
  seed.disabled = !seedEnabled.checked;
  makeScrubber(seed, { min: 0, decimals: 0, allowEmpty: true }, (value) => {
    profile.seed = value;
    changed();
  }, (value) => {
    if (value === null) delete profile.seed;
    else profile.seed = value;
    changed();
  });
  const seedField = el("label", {
    class: `field qf-number-field${seedEnabled.checked ? "" : " disabled"}`,
    title: "Use a fixed seed for deterministic replay; disable it to let the generator choose.",
  }, [
    el("span", {}, ["Random seed"]),
    el("span", { class: "qf-number-control" }, [
      el("span", { class: "qf-optional-toggle" }, [seedEnabled]),
      seed,
    ]),
  ]);
  seedEnabled.addEventListener("change", () => {
    seed.disabled = !seedEnabled.checked;
    seedField.classList.toggle("disabled", !seedEnabled.checked);
    if (seedEnabled.checked) profile.seed = Math.max(0, Math.trunc(Number(seed.value) || 0));
    else delete profile.seed;
    changed();
  });

  const dataToName = new Map<number, string>();
  for (const cooked of options.projected.map.cookedIngredients) {
    const dense = options.projected.denseOf.get(cooked.id);
    if (dense !== undefined) dataToName.set(cooked.id, options.ix.ingName[dense]);
  }
  const weights = new Map<number, number>();
  const ranges = new Map<number, { min: number; max: number }>();
  for (const [dataId, name] of dataToName) {
    weights.set(dataId, profile.ingredientWeightsByName[name] ?? 0);
    const range = profile.amountRangesByName[name];
    if (range) ranges.set(dataId, { ...range });
  }
  const composites = new Map<number, number>();
  for (const [name, value] of Object.entries(profile.dishTypeWeightsByName ?? {})) {
    const dataId = options.ids.byNode.composite.get(name);
    if (dataId !== undefined) composites.set(dataId, value);
  }
  const initial: WeightSet = { ingredients: weights, amountRanges: ranges, composites };
  const dishWeights = createDishWeightEditor({
    projected: options.projected,
    ix: options.ix,
    ids: options.ids,
    initial,
    showIngredients: true,
    onChange: (next) => {
      for (const [dataId, value] of next.ingredients) {
        const name = dataToName.get(dataId);
        if (name) profile.ingredientWeightsByName[name] = value;
      }
      profile.amountRangesByName = {};
      for (const [dataId, range] of next.amountRanges) {
        const name = dataToName.get(dataId);
        if (name) profile.amountRangesByName[name] = { ...range };
      }
      profile.dishTypeWeightsByName = {};
      for (const [dataId, value] of next.composites) {
        const name = options.ids.byId.composite.get(dataId);
        if (name) profile.dishTypeWeightsByName[name] = value;
      }
      changed();
    },
  });

  return el("div", { class: "shared-profile-visual" }, [
    el("div", { class: "shared-profile-badge" }, ["Shared between strategies"]),
    el("p", { class: "muted qf-editor-help" }, [options.impactText]),
    foldout("Reproducibility", [
      seedField,
    ], "Control deterministic replay with an optional random seed."),
    foldout("Dish types, ingredients, and queue amounts", [
      dishWeights.element,
    ], "Shared dish-type guidance, ingredient likelihood, and per-slot amount ranges used by both strategies. A zero-weight dish automatically disables ingredients that no enabled dish can use."),
    foldout("Obstacle coverage", [
      coverageGrid(profile, options.basis, changed),
    ], "Queue and customer coverage percentages are converted to counts. Grid obstacles are preserved from the current level."),
  ]);
}

export function createSharedProfileEditor(options: SharedProfileEditorOptions): HTMLElement {
  let profile = options.profile;
  const host = el("div", { class: "shared-profile-editor" });
  const visualHost = el("div");
  const json = el("textarea", { class: "qf-vector-json", rows: "24" }) as HTMLTextAreaElement;
  const error = el("p", { class: "inline-error" });
  let mode: "visual" | "json" = options.mode ?? "visual";

  const changed = (): void => {
    json.value = JSON.stringify(profile, null, 2);
    options.onChange(profile);
  };
  const renderVisual = (): void => {
    visualHost.replaceChildren(visualEditor(options, profile, changed));
  };
  const visualButton = button("Visual", () => setMode("visual"), { class: "selected" });
  const jsonButton = button("JSON", () => setMode("json"));
  const setMode = (next: "visual" | "json"): void => {
    if (mode === "json" && next === "visual") {
      try {
        profile = JSON.parse(json.value) as SharedGenerationProfileV2;
        error.textContent = "";
        json.classList.remove("invalid");
        options.onChange(profile);
        renderVisual();
      } catch (cause) {
        error.textContent = `Invalid shared-profile JSON: ${cause instanceof Error ? cause.message : String(cause)}`;
        json.classList.add("invalid");
        return;
      }
    }
    mode = next;
    visualHost.hidden = mode !== "visual";
    json.hidden = mode !== "json";
    error.hidden = mode !== "json" || !error.textContent;
    visualButton.classList.toggle("selected", mode === "visual");
    jsonButton.classList.toggle("selected", mode === "json");
    if (mode === "json") json.value = JSON.stringify(profile, null, 2);
  };
  json.addEventListener("input", () => {
    try {
      const next = JSON.parse(json.value) as SharedGenerationProfileV2;
      profile = next;
      options.onChange(profile);
      error.textContent = "";
      error.hidden = true;
      json.classList.remove("invalid");
    } catch (cause) {
      error.textContent = `Invalid shared-profile JSON: ${cause instanceof Error ? cause.message : String(cause)}`;
      error.hidden = false;
      json.classList.add("invalid");
    }
  });
  json.value = JSON.stringify(profile, null, 2);
  renderVisual();
  host.append(
    ...(options.showModeToggle === false ? [] : [el("div", { class: "qf-editor-tabs", role: "tablist", "aria-label": "Shared profile editor mode" }, [visualButton, jsonButton])]),
    visualHost,
    json,
    error,
  );
  setMode(mode);
  return host;
}
