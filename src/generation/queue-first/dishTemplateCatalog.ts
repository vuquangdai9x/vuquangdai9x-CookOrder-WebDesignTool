import type { GraphIndex } from "../../core/nodeIndex.ts";
import type { NodeCustomerConfig, NodeDish } from "../../core/nodeParser.ts";
import { serializeDish } from "../../core/nodeParser.ts";
import { resolveOrder } from "../../core/nodeOrder.ts";
import type { IdIndex } from "../../data/nodeIdTable.ts";
import { buildDish } from "../../ui/nodedesign/nodeGenerate.ts";
import { nodePickupSequence } from "../../ui/nodedesign/nodeQueueGenerate.ts";
import { deriveSeed, seededRandom } from "./artifactHash.ts";

export interface DishTemplate {
  id: string;
  dish: NodeDish;
  orderable: number;
  orderedIngredients: number[];
  rawSignature: Record<string, number>;
  complexity: number;
  /** Relative shared dish-type preference. Zero types never enter the catalog. */
  dishTypeWeight: number;
}

export interface DishTemplateCatalogOptions {
  seed: number;
  maxDishSlots: number;
  maximumCandidates: number;
  dishTypeWeights?: Record<string, number>;
}

function signature(sequence: readonly number[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const ingredient of sequence) result[String(ingredient)] = (result[String(ingredient)] ?? 0) + 1;
  return result;
}

/** Enumerates a deterministic bounded set of graph-valid dishes for inverse generation. */
export function enumerateDishTemplates(
  ix: GraphIndex,
  ids: IdIndex,
  options: DishTemplateCatalogOptions,
): DishTemplate[] {
  const unique = new Map<string, DishTemplate>();
  const max = Math.max(1, Math.trunc(options.maximumCandidates));
  const maxSlots = Math.max(1, Math.trunc(options.maxDishSlots));
  const perShapeSamples = 6;
  const hasDishTypeWeights = Object.keys(options.dishTypeWeights ?? {}).length > 0;

  const weightedOrderables = ix.orderables.map((orderable, index) => {
    const name = ix.compositeName[orderable] ?? String(orderable);
    return {
      orderable,
      index,
      weight: hasDishTypeWeights ? options.dishTypeWeights?.[name] ?? 0 : 100,
    };
  }).filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);

  for (const { orderable, weight } of weightedOrderables) {
    for (let budget = 1; budget <= maxSlots; budget++) {
      for (let sample = 0; sample < perShapeSamples; sample++) {
        const random = seededRandom(deriveSeed(options.seed, `template:${orderable}:${budget}:${sample}`));
        const dish = buildDish(ix, ids, orderable, budget, () => 1, random, maxSlots);
        if (!dish) continue;
        const resolved = resolveOrder(ix, dish, ids);
        if (resolved.issues.length > 0 || resolved.order.slots.length === 0) continue;
        const serialized = serializeDish(dish);
        if (unique.has(serialized)) continue;
        const customer: NodeCustomerConfig = { typeId: 0, waitTime: 0, weatherEff: 0, dishes: [dish] };
        const rawSequence = nodePickupSequence(ix, ids, [customer]);
        if (rawSequence.length === 0) continue;
        unique.set(serialized, {
          id: serialized,
          dish,
          orderable,
          orderedIngredients: resolved.order.slots.map((slot) => slot.ing),
          rawSignature: signature(rawSequence),
          complexity: resolved.order.slots.length,
          dishTypeWeight: weight,
        });
        if (unique.size >= max) return [...unique.values()];
      }
    }
  }
  return [...unique.values()];
}
