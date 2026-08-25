// The generator's weight editor: dish types on top, ingredients below.
//
// The two are stacked in the order the generator actually reads them — pick a
// DISH TYPE from the composite weights, then fill it from the ingredient
// weights — because that order is the thing most easily got wrong. A designer
// who has turned the burger down to zero and then wonders why their carefully
// weighted patty never appears is reading the grid bottom-up; putting the dish
// types first, and greying every ingredient they have shut off, makes the
// dependency visible instead of something to be deduced.

import { button, el } from "../dom.ts";
import { iconEl } from "../icon.ts";
import {
  createIngredientWeightGrid,
  DEFAULT_INGREDIENT_WEIGHT,
} from "../design/ingredientWeightEditor.ts";
import type { WeightSet } from "../design/ingredientWeightEditor.ts";
import type { GraphIndex } from "../../core/nodeIndex.ts";
import type { Id } from "../../core/types.ts";
import type { IdIndex } from "../../data/nodeIdTable.ts";
import type { ProjectedMap } from "../../data/nodeGraphToMapDef.ts";

export interface DishWeightEditor {
  element: HTMLElement;
  /** Live weights — mutated in place as the designer drags. */
  weights: WeightSet;
}

/** One orderable composite, with everything the editor needs to draw it. */
export interface CompositeRow {
  dataId: Id;
  name: string;
  emoji: string;
  /** Ingredient DATA ids this composite can hold, at any depth. */
  ingredients: Set<Id>;
}

/**
 * The orderable composites of a graph, each with the ingredients it can hold.
 *
 * Read through `slotsOfComposite` rather than by walking the dish tree, so a
 * nested group's options count as belonging to the composite that owns the
 * group — which is what "this dish type can contain that ingredient" means to
 * a player.
 */
export function orderableRows(ix: GraphIndex, ids: IdIndex): CompositeRow[] {
  const rows: CompositeRow[] = [];
  for (const composite of ix.orderables) {
    const name = ix.compositeName[composite];
    const dataId = ids.byNode.composite.get(name);
    if (dataId === undefined) continue;

    const ingredients = new Set<Id>();
    for (const slot of ix.slotsOfComposite[composite] ?? []) {
      for (const option of slot.options) {
        const ingredientId = ids.byNode.ingredient.get(ix.ingName[option]);
        if (ingredientId !== undefined) ingredients.add(ingredientId);
      }
    }
    const vertex = ix.doc.vertices.composite[composite];
    rows.push({
      dataId,
      name: vertex?.displayName || name,
      // The plate is the fallback, not the intent — a map whose composites have
      // no emoji yet still reads, it just reads uniformly.
      emoji: vertex?.emoji || "🍽",
      ingredients,
    });
  }
  return rows;
}

/**
 * Ingredients no enabled dish type can hold.
 *
 * An ingredient is unreachable when EVERY composite that could contain it is
 * weighted zero — its own weight then cannot matter, because the generator
 * never gets as far as asking. An ingredient belonging to no orderable at all
 * is not marked: that is a graph question, not a weighting one, and the graph
 * validator already reports it.
 */
export function unreachableIngredients(
  rows: CompositeRow[],
  compositeWeights: Map<Id, number>,
): Set<Id> {
  const reachable = new Set<Id>();
  const owned = new Set<Id>();
  for (const row of rows) {
    const enabled = (compositeWeights.get(row.dataId) ?? 0) > 0;
    for (const ingredient of row.ingredients) {
      owned.add(ingredient);
      if (enabled) reachable.add(ingredient);
    }
  }
  const out = new Set<Id>();
  for (const ingredient of owned) {
    if (!reachable.has(ingredient)) out.add(ingredient);
  }
  return out;
}

export interface DishWeightEditorDeps {
  projected: ProjectedMap;
  ix: GraphIndex;
  ids: IdIndex;
  initial: WeightSet;
  onChange?(weights: WeightSet): void;
}

export function createDishWeightEditor(deps: DishWeightEditorDeps): DishWeightEditor {
  const rows = orderableRows(deps.ix, deps.ids);
  const weights: WeightSet = {
    ingredients: new Map(deps.initial.ingredients),
    // A record written before composites existed has none. Treating that as
    // "every dish type is off" would silently break every old level, so an
    // empty composite half means "all enabled".
    composites:
      deps.initial.composites.size > 0
        ? new Map(deps.initial.composites)
        : new Map(rows.map((row) => [row.dataId, DEFAULT_INGREDIENT_WEIGHT])),
  };

  const grid = createIngredientWeightGrid(
    deps.projected.map,
    weights.ingredients,
    (next) => {
      weights.ingredients = next;
      deps.onChange?.(weights);
    },
    unreachableIngredients(rows, weights.composites),
  );

  const refreshReach = (): void => {
    grid.setUnreachable(unreachableIngredients(rows, weights.composites));
    deps.onChange?.(weights);
  };

  const bars = rows.map((row) => {
    const value = weights.composites.get(row.dataId) ?? 0;
    const fill = el("div", { class: "weight-fill" });
    const label = el("div", { class: "weight-value" }, [String(value)]);
    const track = el("div", { class: "weight-track" }, [fill]);
    // Glyph plus name: the glyph is what makes a row findable in a line of
    // identical-looking bars, the name is what makes it unambiguous.
    const column = el("div", { class: `weight-col dish-col${value === 0 ? " zero" : ""}` }, [
      label,
      track,
      el("div", { class: "weight-icon" }, [
        iconEl({ name: row.name, emoji: row.emoji }, { size: 44, className: "icon-dish" }),
      ]),
      el("div", { class: "dish-name" }, [row.name]),
    ]);
    column.title = `${row.name} — how often a customer orders this dish type`;
    fill.style.height = `${value}%`;

    const set = (raw: number): void => {
      const clamped = Math.max(0, Math.min(100, Math.round(raw)));
      weights.composites.set(row.dataId, clamped);
      fill.style.height = `${clamped}%`;
      label.textContent = String(clamped);
      column.classList.toggle("zero", clamped === 0);
      refreshReach();
    };

    const applyFromPointer = (clientY: number): void => {
      const rect = track.getBoundingClientRect();
      set((1 - (clientY - rect.top) / rect.height) * 100);
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

    return { column, set };
  });

  const element = el("div", { class: "dish-weight-editor" }, [
    el("h3", {}, ["Dish Types"]),
    el("p", { class: "muted" }, [
      "A customer's dish type is drawn from these first; the ingredient weights below only decide what " +
        "goes inside whichever type was picked. An ingredient no enabled dish type can hold is greyed out.",
    ]),
    el("div", { class: "ingredient-toggle-actions" }, [
      button("Enable All", () => bars.forEach((bar) => bar.set(DEFAULT_INGREDIENT_WEIGHT)), { class: "small-btn" }),
      button("Disable All", () => bars.forEach((bar) => bar.set(0)), { class: "small-btn" }),
    ]),
    el("div", { class: "weight-grid dish-grid" }, bars.map((bar) => bar.column)),
    el("h3", {}, ["Ingredient Weights"]),
    el("div", { class: "ingredient-toggle-actions" }, [
      button("Enable All", () => grid.setAll(DEFAULT_INGREDIENT_WEIGHT), { class: "small-btn" }),
      button("Disable All", () => grid.setAll(0), { class: "small-btn" }),
    ]),
    grid.element,
  ]);

  return { element, weights };
}
