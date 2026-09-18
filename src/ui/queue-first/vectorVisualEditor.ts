import type { GraphIndex } from "../../core/nodeIndex.ts";
import type {
  CustomerGenerationVector,
  PickupPlanningVector,
  QueueGenerationVector,
} from "../../generation/queue-first/index.ts";
import { el } from "../dom.ts";
import { iconEl } from "../icon.ts";
import { makeScrubber } from "../scrubInput.ts";
import { KEY_COLORS } from "../../data/configLoader.ts";
import { createVerticalPercentSlider } from "../generator/verticalPercentSlider.ts";

type Changed = () => void;

interface NumberSpec {
  min?: number;
  max?: number;
  decimals?: number;
  optional?: boolean;
  fallback?: number;
  hint?: string;
}

const FIELD_HINTS: Record<string, string> = {
  Seed: "Deterministic random seed. Reusing it with the same graph and settings reproduces the same result.",
  Lanes: "Number of queue lanes. CookOrder supports between 1 and 5 lanes.",
  "Pickup units": "Total ingredient units placed across every queue lane, including bag amounts.",
  "Queue slots": "Optional target number of visible queue slots before bag amounts are counted.",
  "Lane depth": "Optional target for the deepest queue lane.",
  "Max identical run": "Longest allowed uninterrupted run of the same ingredient in one lane.",
  "Max lane mirroring": "Maximum tolerated similarity between neighboring lanes, from 0 to 1.",
  "Transition entropy": "Desired ingredient-transition variety, from 0 to 1.",
  "Lane imbalance": "Desired lane-length imbalance, from 0 to 1.",
  "Force move": "Design pressure from 0 to 1. At 0 every available choice must retain a winning route; at 1 only one verified route is required.",
  "Freeze min picks": "Minimum adjacent picks required to thaw a frozen queue slot.",
  "Freeze max picks": "Maximum adjacent picks required to thaw a frozen queue slot.",
  "Target wave": "Preferred number of released ingredient units per pickup wave.",
  "Beam width": "Number of candidate pickup/customer states retained per search step.",
  "Expanded states": "Hard cap on states explored by the bounded search.",
  "Wall time (ms)": "Maximum search time before the best partial result is returned.",
};

export interface VectorVisualEditorOptions {
  includeShared?: boolean;
  foldoutState?: Map<string, boolean>;
  statePrefix?: string;
}

const section = (
  title: string,
  children: Node[],
  hint = `${title} settings`,
  options: VectorVisualEditorOptions = {},
): HTMLElement => {
  const details = el("details", { class: "qf-visual-section qf-config-foldout" }, [
    el("summary", { title: hint }, [title]),
    el("div", { class: "qf-config-foldout-body" }, children),
  ]);
  const key = `${options.statePrefix ?? ""}${title}`;
  details.open = options.foldoutState?.get(key) ?? false;
  details.addEventListener("toggle", () => options.foldoutState?.set(key, details.open));
  return details;
};

function numberField(
  label: string,
  value: number | undefined,
  assign: (value: number | undefined) => void,
  changed: Changed,
  spec: NumberSpec = {},
): HTMLElement {
  const decimals = spec.decimals ?? 0;
  const fallback = spec.fallback ?? spec.min ?? 0;
  const input = el("input", {
    type: "number",
    min: String(spec.min ?? 0),
    ...(spec.max === undefined ? {} : { max: String(spec.max) }),
    step: String(10 ** -decimals),
    value: String(value ?? fallback),
    title: spec.hint ?? FIELD_HINTS[label] ?? `${label}. Type a value or drag left/right. Shift = faster, Alt = finer.`,
  }) as HTMLInputElement;

  const paintRatio = (): void => {
    if (spec.max === undefined) {
      input.style.removeProperty("--field-ratio");
      input.classList.remove("bounded-fill");
      return;
    }
    const min = spec.min ?? 0;
    const current = Math.max(min, Math.min(spec.max, Number(input.value) || min));
    const ratio = spec.max === min ? 1 : (current - min) / (spec.max - min);
    input.style.setProperty("--field-ratio", `${Math.round(ratio * 100)}%`);
    input.classList.add("bounded-fill");
  };

  const apply = (next: number): void => {
    const factor = 10 ** decimals;
    const rounded = Math.round(next * factor) / factor;
    const normalized = Math.max(spec.min ?? 0, spec.max === undefined ? rounded : Math.min(spec.max, rounded));
    input.value = decimals === 0 ? String(Math.round(normalized)) : String(normalized);
    assign(normalized);
    paintRatio();
    changed();
  };
  if (spec.max === undefined) {
    makeScrubber(input, { min: spec.min ?? 0, decimals }, apply, (next) => {
      if (next !== null) apply(next);
    });
  } else {
    let pointerDown = false;
    let moved = false;
    let startX = 0;
    const applyPoint = (clientX: number): void => {
      const rect = input.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      apply((spec.min ?? 0) + ratio * (spec.max! - (spec.min ?? 0)));
    };
    input.classList.add("point-scrub-input");
    input.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      pointerDown = true;
      moved = false;
      startX = event.clientX;
    });
    input.addEventListener("pointermove", (event) => {
      if (!pointerDown) return;
      if (!moved && Math.abs(event.clientX - startX) < 3) return;
      if (!moved) {
        moved = true;
        input.setPointerCapture(event.pointerId);
        input.classList.add("scrubbing");
        input.blur();
      }
      event.preventDefault();
      applyPoint(event.clientX);
    });
    const stop = (event: PointerEvent): void => {
      if (!pointerDown) return;
      pointerDown = false;
      input.classList.remove("scrubbing");
      if (input.hasPointerCapture(event.pointerId)) input.releasePointerCapture(event.pointerId);
    };
    input.addEventListener("pointerup", stop);
    input.addEventListener("pointercancel", stop);
    input.addEventListener("change", () => apply(Number(input.value) || fallback));
  }

  const controls: Node[] = [input];
  let optionalToggle: HTMLInputElement | undefined;
  if (spec.optional) {
    const enabled = el("input", { type: "checkbox", "aria-label": `Enable ${label}` }) as HTMLInputElement;
    optionalToggle = enabled;
    enabled.checked = value !== undefined;
    input.disabled = !enabled.checked;
    enabled.addEventListener("change", () => {
      input.disabled = !enabled.checked;
      wrapper.classList.toggle("disabled", !enabled.checked);
      assign(enabled.checked ? Number(input.value) : undefined);
      changed();
    });
    controls.unshift(el("span", { class: "qf-optional-toggle", title: `Enable ${label}` }, [enabled]));
  }
  const wrapper = el("label", {
    class: `field qf-number-field${optionalToggle && !optionalToggle.checked ? " disabled" : ""}`,
    title: spec.hint ?? FIELD_HINTS[label] ?? `${label} configuration`,
  }, [el("span", {}, [label]), el("span", { class: "qf-number-control" }, controls)]);
  paintRatio();
  return wrapper;
}

function selectField(
  label: string,
  value: string,
  choices: readonly string[],
  assign: (value: string) => void,
  changed: Changed,
): HTMLElement {
  const select = el("select") as HTMLSelectElement;
  for (const choice of choices) {
    const option = el("option", { value: choice }, [choice]);
    option.selected = choice === value;
    select.append(option);
  }
  select.addEventListener("change", () => {
    assign(select.value);
    changed();
  });
  return el("label", { class: "field qf-number-field", title: FIELD_HINTS[label] ?? `${label} configuration` }, [el("span", {}, [label]), select]);
}

function ingredientEditor(values: QueueGenerationVector, ix: GraphIndex, changed: Changed): HTMLElement {
  const grid = el("div", { class: "weight-grid qf-ingredient-grid" });
  for (let id = 0; id < ix.pickupable.length; id++) {
    if (ix.pickupable[id] !== 1) continue;
    const ingredient = ix.doc.vertices.ingredient[id];
    let weight = Math.max(0, Math.min(100, Math.round(values.ingredientWeights[String(id)] ?? 0)));
    const fill = el("div", { class: "weight-fill" });
    fill.style.height = `${weight}%`;
    const weightLabel = el("div", { class: "weight-value" }, [String(weight)]);
    const track = el("div", {
      class: "weight-track",
      role: "slider",
      tabindex: "0",
      title: "Ingredient weight (0–100). Drag vertically.",
    }, [fill]);

    const graphRange = ix.stackRange[id] ?? { min: 1, max: 1 };
    const configured = values.amountRanges?.[String(id)];
    let min = Math.max(1, Math.min(10, Math.round(configured?.min ?? graphRange.min)));
    let max = Math.max(min, Math.min(10, Math.round(configured?.max ?? graphRange.max)));
    const amountEnabled = el("input", { type: "checkbox", "aria-label": `Enable amount override for ${ingredient?.displayName || ingredient?.name || id}` }) as HTMLInputElement;
    amountEnabled.checked = configured !== undefined;
    const amountLabel = el("div", { class: "amount-range-value" }, [`${min}-${max}`]);
    const minInput = el("input", {
      class: "amount-range-input min",
      type: "range",
      min: "1",
      max: "10",
      step: "1",
      value: String(min),
      title: "Minimum amount per queue slot",
    }) as HTMLInputElement;
    const maxInput = el("input", {
      class: "amount-range-input max",
      type: "range",
      min: "1",
      max: "10",
      step: "1",
      value: String(max),
      title: "Maximum amount per queue slot",
    }) as HTMLInputElement;

    const syncAmount = (): void => {
      minInput.disabled = !amountEnabled.checked;
      maxInput.disabled = !amountEnabled.checked;
      amountLabel.classList.toggle("disabled", !amountEnabled.checked);
      amountLabel.textContent = `${min}-${max}`;
      if (amountEnabled.checked) {
        values.amountRanges ??= {};
        values.amountRanges[String(id)] = { min, max };
      } else if (values.amountRanges) {
        delete values.amountRanges[String(id)];
        if (Object.keys(values.amountRanges).length === 0) delete values.amountRanges;
      }
      changed();
    };
    minInput.addEventListener("input", () => {
      min = Number(minInput.value);
      if (min > max) {
        max = min;
        maxInput.value = String(max);
      }
      syncAmount();
    });
    maxInput.addEventListener("input", () => {
      max = Number(maxInput.value);
      if (max < min) {
        min = max;
        minInput.value = String(min);
      }
      syncAmount();
    });
    amountEnabled.addEventListener("change", syncAmount);
    minInput.disabled = !amountEnabled.checked;
    maxInput.disabled = !amountEnabled.checked;
    amountLabel.classList.toggle("disabled", !amountEnabled.checked);

    const column = el("div", {
      class: `weight-col with-amount${weight === 0 ? " zero" : ""}`,
      title: ingredient?.displayName || ingredient?.name || ix.ingName[id] || `Ingredient ${id}`,
    }, [
      weightLabel,
      track,
      el("div", { class: "amount-range-control" }, [
        amountLabel,
        el("div", { class: "amount-range-sliders" }, [minInput, maxInput]),
        el("label", { class: "amount-range-toggle", title: "Override the graph stack range" }, [amountEnabled]),
      ]),
      el("div", { class: "weight-icon qf-ingredient-icon", "aria-hidden": "true" }, [iconEl(ingredient ? {
        name: ingredient.displayName || ingredient.name,
        emoji: ingredient.emoji || "◉",
        localImage: ingredient.localImage,
        imageURL: ingredient.imageURL,
        fileId: ingredient.fileId,
      } : undefined, { size: 36, className: "icon-ingredient" })]),
      el("div", { class: "qf-slider-name" }, [ingredient?.displayName || ingredient?.name || ix.ingName[id] || String(id)]),
    ]);

    const setWeight = (raw: number): void => {
      weight = Math.max(0, Math.min(100, Math.round(raw)));
      values.ingredientWeights[String(id)] = weight;
      fill.style.height = `${weight}%`;
      weightLabel.textContent = String(weight);
      column.classList.toggle("zero", weight === 0);
      track.setAttribute("aria-valuenow", String(weight));
      changed();
    };
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(weight));
    const applyPointer = (clientY: number): void => {
      const rect = track.getBoundingClientRect();
      setWeight((1 - (clientY - rect.top) / Math.max(1, rect.height)) * 100);
    };
    track.addEventListener("pointerdown", (event) => {
      track.setPointerCapture(event.pointerId);
      applyPointer(event.clientY);
    });
    track.addEventListener("pointermove", (event) => {
      if (track.hasPointerCapture(event.pointerId)) applyPointer(event.clientY);
    });
    track.addEventListener("pointerup", (event) => {
      if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    });
    track.addEventListener("keydown", (event) => {
      if (event.key === "ArrowUp" || event.key === "ArrowRight") setWeight(weight + (event.shiftKey ? 10 : 1));
      else if (event.key === "ArrowDown" || event.key === "ArrowLeft") setWeight(weight - (event.shiftKey ? 10 : 1));
      else return;
      event.preventDefault();
    });
    grid.append(column);
  }
  return grid;
}

function coverageSlider(label: string, icon: string, value: number, assign: (value: number) => void, changed: Changed): HTMLElement {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
  return createVerticalPercentSlider({ label, icon, value: percent, onInput: (next) => {
    assign(next / 100);
    changed();
  } });
}

function coverageEditor(values: QueueGenerationVector, changed: Changed): HTMLElement {
  const warnings = el("p", { class: "qf-coverage-warning" });
  const updateWarning = (): void => {
    const obstacleTotal = Object.values(values.obstacleCoverage).reduce((sum, value) => sum + value, 0);
    const groupTotal = Object.values(values.combinedCoverageBySize).reduce((sum, value) => sum + value, 0)
      + Object.values(values.linkedCoverageBySize).reduce((sum, value) => sum + value, 0);
    const messages: string[] = [];
    if (obstacleTotal > 1) messages.push(`Obstacle total ${Math.round(obstacleTotal * 100)}% exceeds 100%.`);
    if (groupTotal > 1) messages.push(`Special-slot group total ${Math.round(groupTotal * 100)}% exceeds 100%.`);
    warnings.textContent = messages.join(" ");
    warnings.hidden = messages.length === 0;
  };
  const notify = (): void => {
    updateWarning();
    changed();
  };
  const obstacles = el("div", { class: "qf-coverage-grid" }, [
    coverageSlider("Freeze", "❄️", values.obstacleCoverage.freeze, (v) => { values.obstacleCoverage.freeze = v; }, notify),
    coverageSlider("Hidden", "🙈", values.obstacleCoverage.hidden, (v) => { values.obstacleCoverage.hidden = v; }, notify),
    coverageSlider("Holding key", "🔑", values.obstacleCoverage.holdingKey, (v) => { values.obstacleCoverage.holdingKey = v; }, notify),
  ]);
  const groups = el("div", { class: "qf-coverage-groups" }, [
    el("div", {}, [
      el("h5", {}, ["Combined"]),
      el("div", { class: "qf-coverage-grid" }, ([2, 3, 4, 5] as const).map((size) =>
        coverageSlider(`${size} slots`, "🧩", values.combinedCoverageBySize[size], (v) => { values.combinedCoverageBySize[size] = v; }, notify),
      )),
    ]),
    el("div", {}, [
      el("h5", {}, ["Linked"]),
      el("div", { class: "qf-coverage-grid" }, ([2, 3, 4, 5] as const).map((size) =>
        coverageSlider(`${size} slots`, "🔗", values.linkedCoverageBySize[size], (v) => { values.linkedCoverageBySize[size] = v; }, notify),
      )),
    ]),
  ]);
  updateWarning();
  return el("div", {}, [el("h5", {}, ["Obstacles"]), obstacles, groups, warnings]);
}

function colorListField(values: QueueGenerationVector, changed: Changed): HTMLElement {
  const selected = new Set(values.holdingKeyColors ?? []);
  const buttons = KEY_COLORS.filter((color) => color.id !== 0).map((color) => {
    const control = el("button", {
      type: "button",
      class: `qf-color-toggle${selected.has(color.id) ? " active" : ""}`,
      title: `${selected.has(color.id) ? "Disable" : "Enable"} ${color.name} holding keys`,
      "aria-pressed": String(selected.has(color.id)),
    }, [el("span", { class: "qf-color-swatch", "aria-hidden": "true" }), color.name]) as HTMLButtonElement;
    (control.firstElementChild as HTMLElement).style.background = color.hex;
    control.addEventListener("click", () => {
      if (selected.has(color.id)) selected.delete(color.id);
      else selected.add(color.id);
      control.classList.toggle("active", selected.has(color.id));
      control.setAttribute("aria-pressed", String(selected.has(color.id)));
      if (selected.size) values.holdingKeyColors = [...selected].sort((a, b) => a - b);
      else delete values.holdingKeyColors;
      changed();
    });
    return control;
  });
  return el("div", { class: "field qf-number-field qf-color-field", title: "Colors eligible for paired grid locks and queue keys" }, [
    el("span", {}, ["Holding-key colours"]),
    el("div", { class: "qf-color-toggle-list" }, buttons),
  ]);
}

export function createQueueVectorVisualEditor(
  values: QueueGenerationVector,
  ix: GraphIndex,
  changed: Changed,
  options: VectorVisualEditorOptions = {},
): HTMLElement {
  const includeShared = options.includeShared !== false;
  const basics = el("div", { class: "qf-field-grid" }, [
    ...(includeShared ? [numberField("Seed", values.seed, (v) => { values.seed = v ?? 0; }, changed, { min: 0 })] : []),
    numberField("Lanes", values.laneCount, (v) => { values.laneCount = v ?? 1; }, changed, { min: 1, max: 5 }),
    numberField("Pickup units", values.targetPickupUnits, (v) => { values.targetPickupUnits = v ?? 1; }, changed, { min: 1, max: 500 }),
    numberField("Queue slots", values.targetQueueSlots, (v) => { values.targetQueueSlots = v; }, changed, { min: 1, max: 500, optional: true, fallback: 20 }),
    numberField("Lane depth", values.targetLaneDepth, (v) => { values.targetLaneDepth = v; }, changed, { min: 1, max: 100, optional: true, fallback: 5 }),
    selectField("Amount mode", values.amountMode, ["conservative", "balanced", "aggressive"], (v) => { values.amountMode = v as QueueGenerationVector["amountMode"]; }, changed),
    selectField("Feasibility", values.feasibilityMode, ["free", "project-to-orderable", "strict-orderable", "runtime-feasible"], (v) => { values.feasibilityMode = v as QueueGenerationVector["feasibilityMode"]; }, changed),
    numberField("Force move", values.forceMove ?? 0.5, (v) => { values.forceMove = v ?? 0.5; }, changed, { min: 0, max: 1, decimals: 2 }),
  ]);
  const texture = el("div", { class: "qf-field-grid" }, [
    numberField("Max identical run", values.texture.maximumIdenticalRun, (v) => { values.texture.maximumIdenticalRun = v; }, changed, { min: 1, max: 50, optional: true, fallback: 3 }),
    numberField("Max lane mirroring", values.texture.maximumCrossLaneMirroring, (v) => { values.texture.maximumCrossLaneMirroring = v; }, changed, { min: 0, max: 1, decimals: 2, optional: true, fallback: 0.5 }),
    numberField("Transition entropy", values.texture.targetTransitionEntropy, (v) => { values.texture.targetTransitionEntropy = v; }, changed, { min: 0, max: 1, decimals: 2, optional: true, fallback: 0.3 }),
    numberField("Lane imbalance", values.texture.targetLaneImbalance, (v) => { values.texture.targetLaneImbalance = v; }, changed, { min: 0, max: 1, decimals: 2, optional: true, fallback: 0.3 }),
  ]);
  const freeze = el("div", { class: "qf-field-grid" }, [
    numberField("Freeze min picks", values.freezeStrength?.minAdjacentPicks, (v) => {
      if (v === undefined) delete values.freezeStrength;
      else values.freezeStrength = { minAdjacentPicks: v, maxAdjacentPicks: Math.max(v, values.freezeStrength?.maxAdjacentPicks ?? v) };
    }, changed, { min: 1, max: 20, optional: true, fallback: 1 }),
    numberField("Freeze max picks", values.freezeStrength?.maxAdjacentPicks, (v) => {
      if (v === undefined) delete values.freezeStrength;
      else values.freezeStrength = { minAdjacentPicks: Math.min(v, values.freezeStrength?.minAdjacentPicks ?? v), maxAdjacentPicks: v };
    }, changed, { min: 1, max: 20, optional: true, fallback: 3 }),
    colorListField(values, changed),
  ]);
  return el("div", { class: "qf-visual-editor" }, [
    section("Queue targets", [basics], undefined, options),
    ...(includeShared ? [section("Ingredient weights and amount ranges", [
      el("p", { class: "muted qf-editor-help" }, ["Drag weight bars vertically. Enable Amt to override the graph's minimum/maximum amount."]),
      ingredientEditor(values, ix, changed),
    ], undefined, options), section("Obstacles and special-slot groups", [coverageEditor(values, changed)], undefined, options)] : []),
    section("Texture targets", [texture], undefined, options),
    section("Obstacle details", [freeze], undefined, options),
  ]);
}

export function createPickupVectorVisualEditor(
  values: PickupPlanningVector,
  changed: Changed,
  options: VectorVisualEditorOptions = {},
): HTMLElement {
  return el("div", { class: "qf-visual-editor" }, [
    section("Pickup behavior", [el("div", { class: "qf-field-grid" }, [
      numberField("Seed", values.seed, (v) => { values.seed = v ?? 0; }, changed, { min: 0 }),
      numberField("Target wave", values.targetWaveSize, (v) => { values.targetWaveSize = v; }, changed, { min: 1, max: 50, optional: true, fallback: 3 }),
    ]), el("p", { class: "muted qf-editor-help" }, ["Manual versus automatic continuation is chosen at runtime from the Pickup canvas, not fixed in configuration."])], undefined, options),
    section("Scoring", [el("div", { class: "qf-field-grid" }, [
      numberField("Lane balance", values.preferLaneBalance, (v) => { values.preferLaneBalance = v ?? 0; }, changed, { min: 0, decimals: 2 }),
      numberField("Wave alignment", values.preferIngredientWaveAlignment, (v) => { values.preferIngredientWaveAlignment = v ?? 0; }, changed, { min: 0, decimals: 2 }),
      numberField("Amount burst penalty", values.penalizeAmountBurst, (v) => { values.penalizeAmountBurst = v ?? 0; }, changed, { min: 0, decimals: 2 }),
    ])], undefined, options),
    section("Search budget", [el("div", { class: "qf-field-grid" }, [
      numberField("Beam width", values.search.beamWidth, (v) => { values.search.beamWidth = v ?? 1; }, changed, { min: 1, max: 512 }),
      numberField("Expanded states", values.search.maximumExpandedStates, (v) => { values.search.maximumExpandedStates = v ?? 1; }, changed, { min: 1, max: 1_000_000 }),
      numberField("Wall time (ms)", values.search.wallTimeMs, (v) => { values.search.wallTimeMs = v ?? 1; }, changed, { min: 1, max: 60_000 }),
    ])], undefined, options),
  ]);
}

export function createCustomerVectorVisualEditor(
  values: CustomerGenerationVector,
  changed: Changed,
  options: VectorVisualEditorOptions = {},
): HTMLElement {
  return el("div", { class: "qf-visual-editor" }, [
    section("Customer and dish limits", [el("div", { class: "qf-field-grid" }, [
      selectField("Mode", values.mode, ["manual", "auto", "manual-with-auto-suffix"], (v) => { values.mode = v as CustomerGenerationVector["mode"]; }, changed),
      numberField("Seed", values.seed, (v) => { values.seed = v ?? 0; }, changed, { min: 0 }),
      numberField("Min customers", values.minCustomers, (v) => { values.minCustomers = v ?? 1; }, changed, { min: 1, max: 100 }),
      numberField("Max customers", values.maxCustomers, (v) => { values.maxCustomers = v ?? 1; }, changed, { min: 1, max: 100 }),
      numberField("Min dishes / customer", values.minDishesPerCustomer, (v) => { values.minDishesPerCustomer = v ?? 1; }, changed, { min: 1, max: 10 }),
      numberField("Max dishes / customer", values.maxDishesPerCustomer, (v) => { values.maxDishesPerCustomer = v ?? 1; }, changed, { min: 1, max: 10 }),
      numberField("Max dish slots", values.maxDishSlots, (v) => { values.maxDishSlots = v ?? 1; }, changed, { min: 1, max: 10 }),
      numberField("Serveable slots", values.serveableSlots, (v) => { values.serveableSlots = v ?? 1; }, changed, { min: 1, max: 10 }),
    ])], undefined, options),
    section("Scoring", [el("div", { class: "qf-field-grid" }, [
      numberField("Early inventory", values.earlyInventoryWeight, (v) => { values.earlyInventoryWeight = v ?? 0; }, changed, { min: 0, decimals: 2 }),
      numberField("Pickup-demand distance", values.pickupToDemandDistanceWeight, (v) => { values.pickupToDemandDistanceWeight = v ?? 0; }, changed, { min: 0, decimals: 2 }),
      numberField("Variety", values.varietyWeight, (v) => { values.varietyWeight = v ?? 0; }, changed, { min: 0, decimals: 2 }),
    ])], undefined, options),
    section("Search budget", [el("div", { class: "qf-field-grid" }, [
      numberField("Beam width", values.search.beamWidth, (v) => { values.search.beamWidth = v ?? 1; }, changed, { min: 1, max: 512 }),
      numberField("Candidates", values.search.maximumCandidates, (v) => { values.search.maximumCandidates = v ?? 1; }, changed, { min: 1, max: 10_000 }),
      numberField("Expanded states", values.search.maximumExpandedStates, (v) => { values.search.maximumExpandedStates = v ?? 1; }, changed, { min: 1, max: 1_000_000 }),
      numberField("Wall time (ms)", values.search.wallTimeMs, (v) => { values.search.wallTimeMs = v ?? 1; }, changed, { min: 1, max: 60_000 }),
    ])], undefined, options),
    el("p", { class: "muted qf-editor-help" }, [
      "Recovered complexityCurve, preferredIngredientVariety, and maximumRepeatedDishRun fields are preserved in JSON but are not shown as active controls because the current inverse generator does not consume them. Shared dish-type weights are applied as soft search guidance; zero disables a type.",
    ]),
  ]);
}
