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

/** "3:100;7:40" -> Map{3:100, 7:40}. Malformed entries are skipped rather than throwing — this is read-back design metadata. */
export function parseIngredientWeights(s: string): Map<Id, number> {
  const weights = new Map<Id, number>();
  if (!s || !s.trim()) return weights;
  for (const part of s.split(";")) {
    if (!part) continue;
    const [idStr, weightStr] = part.split(":");
    const id = Number(idStr);
    const weight = Number(weightStr);
    if (Number.isFinite(id) && Number.isFinite(weight)) {
      weights.set(id, Math.max(0, Math.min(100, weight)));
    }
  }
  return weights;
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
}

export function createIngredientWeightGrid(
  map: MapDef,
  initial: Map<Id, number>,
  onChange: (weights: Map<Id, number>) => void,
): IngredientWeightGrid {
  const weights = new Map(initial);
  const grid = el("div", { class: "weight-grid" });
  const cols: { id: Id; column: HTMLElement; fill: HTMLElement; label: HTMLElement; track: HTMLElement }[] = [];

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
    const column = el("div", { class: `weight-col${value === 0 ? " zero" : ""}` }, [
      label,
      track,
      el("div", { class: "weight-icon" }, [cookedIconEl(c.id, 64)]),
    ]);
    column.title = c.name;
    fill.style.height = `${value}%`;

    const col = { id: c.id, column, fill, label, track };
    cols.push(col);

    const applyFromPointer = (clientY: number) => {
      const rect = track.getBoundingClientRect();
      const ratio = 1 - (clientY - rect.top) / rect.height;
      setWeight(c.id, ratio * 100, col);
    };

    track.addEventListener("pointerdown", (e) => {
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
      for (const col of cols) setWeight(col.id, value, col);
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
