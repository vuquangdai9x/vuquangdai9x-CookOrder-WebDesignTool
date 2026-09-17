// Ingredient weight grid — one draggable vertical bar (0-100) per cooked
// ingredient, icon at the bottom. Replaces the old on/off toggle grid in the
// Customer Auto Generate dialog, and backs the standalone "Ingredient
// Weights" editor under the Customer section header. A weight of 0 means the
// ingredient is disabled (same meaning the old toggle's "off" had).
//
// Kept free of contextMenu.ts (no top-level DOM side effects at import time)
// so parseIngredientWeights/serializeIngredientWeights stay unit-testable
// under Vitest's default node environment, same convention as curveEditor.ts.

import type { Id, MapDef } from "../../core/types.ts";
import { button, el } from "../dom.ts";
import { cookedIconEl } from "../icon.ts";

/** Weight assigned to a newly-enabled ingredient (Enable All, or a fresh default set). */
export const DEFAULT_INGREDIENT_WEIGHT = 100;

/**
 * The two halves of a generator's weight record.
 *
 * COMPOSITES are the dish types a customer may order; INGREDIENTS are what goes
 * inside whichever type was picked. They are separate because the choice is
 * made in that order — pick the dish, then fill it — and a single flat list
 * cannot express "burgers are common but this rare sauce is fine when one
 * shows up".
 */
export interface WeightSet {
  ingredients: Map<Id, number>;
  composites: Map<Id, number>;
  /** Optional per-ingredient queue amount override. Missing = use the graph's stackRange. */
  amountRanges: Map<Id, IngredientAmountRange>;
}

export interface IngredientAmountRange {
  min: number;
  max: number;
}

export const emptyWeightSet = (): WeightSet => ({
  ingredients: new Map(),
  composites: new Map(),
  amountRanges: new Map(),
});

/**
 * `"c0:100;c1:40;3:100;7:40"` — a `c` prefix marks a COMPOSITE id, everything
 * else is an ingredient id.
 *
 * The prefix keeps the format backward compatible: every string written before
 * composites existed parses to the same ingredient map it always did, and its
 * empty composite half means "no preference", which is exactly what those
 * levels meant.
 */
export function parseWeightSet(s: string): WeightSet {
  const set = emptyWeightSet();
  if (!s || !s.trim()) return set;
  for (const part of s.split(";")) {
    if (!part) continue;
    const [rawKey, weightStr, minStr, maxStr] = part.split(":");
    const key = rawKey?.trim() ?? "";
    const composite = key.startsWith("c") || key.startsWith("C");
    const idText = composite ? key.slice(1) : key;
    // An empty id is junk, not id 0 — `Number("")` is 0, so without this a
    // truncated entry like "c:" would silently overwrite the real composite 0.
    if (idText.trim() === "") continue;
    const id = Number(idText);
    const weight = Number(weightStr);
    if (!Number.isFinite(id) || !Number.isFinite(weight)) continue;
    const clamped = Math.max(0, Math.min(100, weight));
    (composite ? set.composites : set.ingredients).set(id, clamped);
    if (!composite && minStr !== undefined && maxStr !== undefined) {
      const rawMin = Number(minStr);
      const rawMax = Number(maxStr);
      if (Number.isFinite(rawMin) && Number.isFinite(rawMax)) {
        const min = Math.max(0, Math.min(10, Math.round(rawMin)));
        const max = Math.max(min, Math.min(10, Math.round(rawMax)));
        set.amountRanges.set(id, { min, max });
      }
    }
  }
  return set;
}

/** Composites first, then ingredients — a stable order so the string diffs cleanly. */
export function serializeWeightSet(set: WeightSet): string {
  const composites = [...set.composites.entries()]
    .filter(([, w]) => w > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([id, w]) => `c${id}:${Math.round(w)}`);
  const ingredients = [...set.ingredients.entries()]
    .filter(([, w]) => w > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([id, w]) => {
      const range = set.amountRanges.get(id);
      if (!range) return `${id}:${Math.round(w)}`;
      const min = Math.max(0, Math.min(10, Math.round(range.min)));
      const max = Math.max(min, Math.min(10, Math.round(range.max)));
      return `${id}:${Math.round(w)}:${min}:${max}`;
    });
  return [...composites, ...ingredients].join(";");
}

/** "3:100;7:40" -> Map{3:100, 7:40}. Malformed entries are skipped rather than throwing — this is read-back design metadata. */
export function parseIngredientWeights(s: string): Map<Id, number> {
  return parseWeightSet(s).ingredients;
}

/** Only nonzero weights are written — a weight of 0 (disabled) carries no information worth keeping. */
export function serializeIngredientWeights(weights: Map<Id, number>): string {
  return [...weights.entries()]
    .filter(([, w]) => w > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([id, w]) => `${id}:${Math.round(w)}`)
    .join(";");
}

export interface IngredientWeightGrid {
  element: HTMLElement;
  setAll(value: number): void;
  /**
   * Re-marks which ingredients are unreachable. Called when a composite's
   * weight changes, since that is what decides reachability.
   */
  setUnreachable(ids: Set<Id>): void;
}

export interface IngredientAmountControls {
  ranges: Map<Id, IngredientAmountRange>;
  defaultRange(id: Id): IngredientAmountRange;
  onChange(ranges: Map<Id, IngredientAmountRange>): void;
}

export function createIngredientWeightGrid(
  map: MapDef,
  initial: Map<Id, number>,
  onChange: (weights: Map<Id, number>) => void,
  unreachable: Set<Id> = new Set(),
  amountControls?: IngredientAmountControls,
): IngredientWeightGrid {
  const weights = new Map(initial);
  let unreachableIds = new Set(unreachable);
  const grid = el("div", { class: "weight-grid" });
  const cols: { id: Id; column: HTMLElement; fill: HTMLElement; label: HTMLElement; track: HTMLElement; refreshAvailability(): void }[] = [];

  function setWeight(id: Id, raw: number, col: (typeof cols)[number]): void {
    const clamped = Math.max(0, Math.min(100, Math.round(raw)));
    weights.set(id, clamped);
    col.fill.style.height = `${clamped}%`;
    col.label.textContent = String(clamped);
    col.column.classList.toggle("zero", clamped === 0);
    onChange(weights);
  }

  for (const c of map.cookedIngredients) {
    const value = weights.get(c.id) ?? 0;
    const fill = el("div", { class: "weight-fill" });
    const label = el("div", { class: "weight-value" }, [String(value)]);
    const track = el("div", { class: "weight-track" }, [fill]);
    const controls: (Node | string)[] = [
      label,
      track,
    ];
    let refreshAmountAvailability = (): void => {};

    if (amountControls) {
      const clampAmount = (raw: number): number => Math.max(0, Math.min(10, Math.round(raw)));
      const configured = amountControls.ranges.get(c.id);
      const fallback = amountControls.defaultRange(c.id);
      let min = clampAmount(configured?.min ?? fallback.min);
      let max = Math.max(min, clampAmount(configured?.max ?? fallback.max));
      const enabled = el("input", { type: "checkbox", "aria-label": `Enable amount override for ${c.name}` }) as HTMLInputElement;
      enabled.checked = configured !== undefined;
      enabled.title = "Override this ingredient's graph stack range";
      const rangeLabel = el("div", { class: "amount-range-value" }, [`${min}-${max}`]);
      const minInput = el("input", {
        class: "amount-range-input min",
        type: "range",
        min: "0",
        max: "10",
        step: "1",
        value: String(min),
        title: "Minimum queue-slot amount",
      }) as HTMLInputElement;
      const maxInput = el("input", {
        class: "amount-range-input max",
        type: "range",
        min: "0",
        max: "10",
        step: "1",
        value: String(max),
        title: "Maximum queue-slot amount",
      }) as HTMLInputElement;

      const updateRangeAvailability = (): void => {
        const unavailable = unreachableIds.has(c.id);
        enabled.disabled = unavailable;
        minInput.disabled = unavailable || !enabled.checked;
        maxInput.disabled = unavailable || !enabled.checked;
        rangeLabel.classList.toggle("disabled", !enabled.checked);
      };
      const syncRange = (): void => {
        updateRangeAvailability();
        rangeLabel.textContent = `${min}-${max}`;
        if (enabled.checked) amountControls.ranges.set(c.id, { min, max });
        else amountControls.ranges.delete(c.id);
        amountControls.onChange(amountControls.ranges);
      };
      minInput.addEventListener("input", () => {
        min = clampAmount(Number(minInput.value));
        if (min > max) {
          max = min;
          maxInput.value = String(max);
        }
        syncRange();
      });
      maxInput.addEventListener("input", () => {
        max = clampAmount(Number(maxInput.value));
        if (max < min) {
          min = max;
          minInput.value = String(min);
        }
        syncRange();
      });
      enabled.addEventListener("change", syncRange);
      refreshAmountAvailability = updateRangeAvailability;
      minInput.disabled = unreachableIds.has(c.id) || !enabled.checked;
      maxInput.disabled = unreachableIds.has(c.id) || !enabled.checked;
      enabled.disabled = unreachableIds.has(c.id);
      rangeLabel.classList.toggle("disabled", !enabled.checked);

      controls.push(
        el("div", { class: "amount-range-control" }, [
          rangeLabel,
          el("div", { class: "amount-range-sliders" }, [minInput, maxInput]),
          el("label", { class: "amount-range-toggle", title: "Use an amount range override" }, [
            enabled,
          ]),
        ]),
      );
    }

    controls.push(el("div", { class: "weight-icon" }, [cookedIconEl(c.id, 64)]));
    const column = el("div", {
      class: `weight-col${value === 0 ? " zero" : ""}${amountControls ? " with-amount" : ""}`,
    }, controls);
    column.title = c.name;
    fill.style.height = `${value}%`;

    const refreshAvailability = (): void => {
      const unavailable = unreachableIds.has(c.id);
      column.classList.toggle("unreachable", unavailable);
      track.setAttribute("aria-disabled", String(unavailable));
      refreshAmountAvailability();
    };
    const col = { id: c.id, column, fill, label, track, refreshAvailability };
    cols.push(col);
    // An ingredient whose every dish type is switched off can never be picked,
    // whatever its own weight says. Showing it greyed rather than hiding it is
    // deliberate: the weight is still there and still means something the
    // moment a composite is turned back on, and hiding rows would make the
    // grid's shape jump every time a dish type is toggled.
    refreshAvailability();

    const applyFromPointer = (clientY: number) => {
      const rect = track.getBoundingClientRect();
      const ratio = 1 - (clientY - rect.top) / rect.height;
      setWeight(c.id, ratio * 100, col);
    };

    track.addEventListener("pointerdown", (e) => {
      if (unreachableIds.has(c.id)) return;
      track.setPointerCapture(e.pointerId);
      applyFromPointer(e.clientY);
      const onMove = (ev: PointerEvent) => applyFromPointer(ev.clientY);
      const onUp = () => {
        track.releasePointerCapture(e.pointerId);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });

    grid.append(column);
  }

  return {
    element: grid,
    setAll(value) {
      for (const col of cols) if (!unreachableIds.has(col.id)) setWeight(col.id, value, col);
    },
    setUnreachable(ids) {
      unreachableIds = new Set(ids);
      for (const col of cols) col.refreshAvailability();
    },
  };
}

/** Standalone "edit just the weights" popup — the weight grid, Enable/Disable All, an Apply/Cancel footer. */
export function openIngredientWeightsDialog(
  map: MapDef,
  initial: Map<Id, number>,
  onApply: (weights: Map<Id, number>) => void,
): void {
  const close = () => overlay.remove();
  let weights = new Map(initial);
  const grid = createIngredientWeightGrid(map, initial, (next) => (weights = next));

  const panel = el("div", { class: "auto-generate-panel" }, [
    el("div", { class: "ingredient-toggle-actions" }, [
      button("Enable All", () => grid.setAll(DEFAULT_INGREDIENT_WEIGHT), { class: "small-btn" }),
      button("Disable All", () => grid.setAll(0), { class: "small-btn" }),
    ]),
    grid.element,
    el("div", { class: "auto-generate-actions" }, [
      button("Cancel", close),
      button("Apply", () => { onApply(weights); close(); }, { class: "primary" }),
    ]),
  ]);

  const overlay = el("div", { class: "overlay-panel" }, [
    el("div", { class: "definitions-head" }, [
      el("h2", {}, ["Ingredient Weights"]),
      button("✕ Close", close, { class: "primary" }),
    ]),
    panel,
  ]);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.body.append(overlay);
}
