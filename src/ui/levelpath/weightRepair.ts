// Rebuilding a level's ingredient weights from what its customers actually
// order.
//
// `ingredientWeights` is a generator INPUT — the distribution a run was asked
// to aim for — so it never matches the realized customer list exactly, and it
// is not supposed to. That makes "the weights look wrong" a narrower claim than
// it first appears, and the narrowness is the whole point of this file: a
// repair that fired on every ordinary approximation gap would overwrite every
// designer's tuning with a description of the level they already have.
//
// So only ONE disagreement counts as broken: the recorded weights say an
// ingredient is disabled (weight 0, or absent) while the customer string orders
// it anyway. That combination cannot be the honest input of any run — the
// generator will not pick a zero-weight ingredient — so the record is stale,
// from an older id table or an older graph. Everything else is left alone.

import { parseNodeCustomers } from "../../core/nodeParser.ts";
import { resolveOrder } from "../../core/nodeOrder.ts";
import type { GraphIndex } from "../../core/nodeIndex.ts";
import type { Id } from "../../core/types.ts";
import type { IdIndex } from "../../data/nodeIdTable.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import {
  DEFAULT_INGREDIENT_WEIGHT,
  parseWeightSet,
  serializeWeightSet,
} from "../design/ingredientWeightEditor.ts";

/**
 * How many times each ingredient is ordered across a level's customers, keyed
 * by DATA id — the space the weight grid speaks.
 *
 * Read through `resolveOrder` rather than by walking the bracket tree, so a
 * dish's nested groups and shared options are counted the way the game counts
 * them.
 */
export function ingredientDistribution(
  level: LevelData,
  ix: GraphIndex,
  ids: IdIndex,
): Map<Id, number> {
  const counts = new Map<Id, number>();
  let customers;
  try {
    customers = parseNodeCustomers(level.customerString);
  } catch {
    // An unreadable customer string describes no distribution at all; an empty
    // map means "nothing to say", which every caller already handles.
    return counts;
  }

  for (const customer of customers) {
    for (const dish of customer.dishes) {
      for (const slot of resolveOrder(ix, dish, ids).order.slots) {
        const dataId = ids.byNode.ingredient.get(ix.ingName[slot.ing]);
        if (dataId === undefined) continue;
        counts.set(dataId, (counts.get(dataId) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * That distribution as weights: the most-ordered ingredient sits at 100 and the
 * rest keep their proportion to it.
 *
 * Scaling to the maximum rather than to the total is what keeps the numbers
 * meaningful in the grid a designer actually looks at — a level with thirty
 * ingredients would otherwise produce thirty single-digit bars that all read as
 * "off".
 */
export function weightsFromDistribution(counts: Map<Id, number>): Map<Id, number> {
  const weights = new Map<Id, number>();
  let peak = 0;
  for (const count of counts.values()) peak = Math.max(peak, count);
  if (peak <= 0) return weights;
  for (const [dataId, count] of counts) {
    // A floor of 1: an ingredient the level genuinely orders must never come
    // back as 0, which is the very "disabled but used" state being repaired.
    weights.set(dataId, Math.max(1, Math.round((count / peak) * DEFAULT_INGREDIENT_WEIGHT)));
  }
  return weights;
}

export interface WeightRepair {
  weights: Map<Id, number>;
  /** The dish-type half, preserved as recorded — the repair has no opinion on it. */
  composites: Map<Id, number>;
  /** Ingredients the customers order that the record had switched off. */
  contradicted: Id[];
  /** True when there were no weights recorded at all. */
  wasEmpty: boolean;
}

/**
 * Whether a level's recorded weights contradict its customers, and what they
 * should be instead. Returns null when the record is consistent — which is the
 * answer for nearly every level, and the reason this is safe to run on load.
 */
export function repairIngredientWeights(
  level: LevelData,
  ix: GraphIndex,
  ids: IdIndex,
): WeightRepair | null {
  const counts = ingredientDistribution(level, ix, ids);
  if (counts.size === 0) return null; // no customers to learn from

  const stored = parseWeightSet(level.ingredientWeights ?? "");
  const recorded = stored.ingredients;
  const wasEmpty = recorded.size === 0;
  const contradicted = [...counts.keys()].filter((dataId) => (recorded.get(dataId) ?? 0) <= 0);
  if (!wasEmpty && contradicted.length === 0) return null;

  const rebuilt = weightsFromDistribution(counts);
  // Weights for ingredients this level does not order are kept as recorded:
  // they are a real authoring choice ("this map's generator may use tomato"),
  // and this level's customers are no evidence against them.
  for (const [dataId, weight] of recorded) {
    if (!rebuilt.has(dataId) && weight > 0) rebuilt.set(dataId, weight);
  }
  return {
    weights: rebuilt,
    // The DISH TYPE weights are carried through untouched. They are a separate
    // authoring decision, the customer string says nothing that contradicts
    // them, and dropping them here is how a repair silently became a delete.
    composites: stored.composites,
    contradicted: contradicted.sort((a, b) => a - b),
    wasEmpty,
  };
}

/** Applies a repair to the level, returning the one-line note for its Status cell. */
export function applyWeightRepair(level: LevelData, repair: WeightRepair): string {
  level.ingredientWeights = serializeWeightSet({
    ingredients: repair.weights,
    composites: repair.composites,
  });
  return repair.wasEmpty
    ? "Ingredient weights filled in from the customer string."
    : `Ingredient weights rebuilt from the customer string — ${repair.contradicted.length} ordered ingredient(s) were recorded as disabled.`;
}
