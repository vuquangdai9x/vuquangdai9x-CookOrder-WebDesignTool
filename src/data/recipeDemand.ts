// Piece-level demand/supply math for cooked-ingredient orders vs. queued raw
// ingredients. Shared by two independent consumers that both need to answer
// "does the queue supply enough of this ingredient": validate.ts's
// cross-level "Not enough X" warning (data layer, driven by saved LevelData
// strings) and ui/design/queueSection.ts's live Recipe Pieces foldout (UI
// layer, driven by the current unsaved draft). They used to each carry their
// own copy of this math, which is how a usageNum fix landed in one and not
// the other — see git history. One implementation now, used by both.
//
// Pure — no DOM — so it's unit-testable directly. This also has to live in
// data/, not ui/design/, precisely because validate.ts (data layer) needs it:
// ui/design/queueSection.ts pulls in contextMenu.ts, which touches `document`
// at module load time, so anything validate.ts imported from ui/ would break
// under this repo's non-jsdom vitest environment — and importing UI code from
// the data layer would be backwards regardless.

import type { CookingToolDef, CookedIngredientDef, CustomerConfig, Id, QueueItem } from "../core/types.ts";

export interface RawDemand {
  /** Total order occurrences requiring this raw id's cooked output — compare directly against a caller's "how many uses are available" figure (see supplyByRaw + this.amount * this.usageNum). */
  need: number;
  /** Physical pieces one raw pickup of this id yields (a tool recipe's `amount`; 1 with no tool). */
  amount: number;
  /** How many order occurrences a single landed piece can satisfy before it's consumed (CookedIngredientDef.usageNum; 1 for the normal single-use case). */
  usageNum: number;
}

/** The only map fields this module needs — accepts both MapDef and MapData (see mapLoader.ts), which differ only in their `levels` field's shape. */
type ToolsAndCooked = { tools: CookingToolDef[]; cookedIngredients: CookedIngredientDef[] };

/**
 * Demand implied by the customer orders, keyed by raw id — `need` is a
 * straight count of order occurrences (how many times this ingredient gets
 * served), not converted to a physical pickup/bottle count. A caller compares
 * it against *available uses*: `supply(rawId) * amount * usageNum` (see
 * supplyByRaw) — not against raw pickup count alone, and not against pickup
 * count × amount alone either.
 *
 * The reason `need` stays in usage units: a cooked ingredient with
 * `usageNum > 1` (e.g. map1's Chili Bowl and Cheese Sauce — see
 * cooked-ingredients.json) can serve that many dish demands from a single
 * landed piece before it's consumed (see Simulation.consumeCookedCell).
 * Converting demand down to a piece count first (`ceil(occurrences /
 * usageNum)`) would hide the actual usage picture — 4 orders against a
 * usageNum-3 ingredient need 2 physical pieces, but those 2 pieces cover 6
 * uses against only 4 needed, i.e. 2 uses' worth of capacity going unused.
 * Comparing in usage units the whole way through (need=4, have=6) surfaces
 * that directly instead of rounding it away.
 */
export function demandByRaw(map: ToolsAndCooked, customers: CustomerConfig[]): Map<Id, RawDemand> {
  const cookedToRaw = new Map<Id, { rawId: Id; amount: number }>();
  for (const tool of map.tools) {
    for (const recipe of tool.recipes) {
      cookedToRaw.set(recipe.out, { rawId: recipe.in, amount: recipe.amount });
    }
  }
  const usageNumOf = new Map<Id, number>();
  for (const cooked of map.cookedIngredients) {
    if (cooked.usageNum && cooked.usageNum > 1) usageNumOf.set(cooked.id, cooked.usageNum);
  }
  const occurrences = new Map<Id, number>();
  for (const customer of customers) {
    for (const dish of customer.dishes) {
      for (const cookedId of dish.cookedIds) {
        occurrences.set(cookedId, (occurrences.get(cookedId) ?? 0) + 1);
      }
    }
  }
  const demand = new Map<Id, RawDemand>();
  for (const [cookedId, count] of occurrences) {
    const via = cookedToRaw.get(cookedId);
    // No tool: the ingredient passes through as itself, one piece per pickup.
    const rawId = via?.rawId ?? cookedId;
    const amount = via?.amount ?? 1;
    const usageNum = usageNumOf.get(cookedId) ?? 1;
    const existing = demand.get(rawId);
    if (existing) existing.need += count;
    else demand.set(rawId, { need: count, amount, usageNum });
  }
  return demand;
}

/** Raw pickups actually present in a queue, counted per raw id — not yet multiplied by yield (see rawYieldAmounts/RawDemand.amount for that). */
export function supplyByRaw(queues: QueueItem[][]): Map<Id, number> {
  const supply = new Map<Id, number>();
  for (const lane of queues) {
    for (const item of lane) {
      if (item.kind !== "ingredient") continue;
      supply.set(item.id, (supply.get(item.id) ?? 0) + 1);
    }
  }
  return supply;
}

/** Pieces one pickup of a raw id yields, for every raw id with a recipe — used to price out "have" pieces even for a raw id the current orders don't demand at all. */
export function rawYieldAmounts(map: Pick<ToolsAndCooked, "tools">): Map<Id, number> {
  const amounts = new Map<Id, number>();
  for (const tool of map.tools) {
    for (const recipe of tool.recipes) amounts.set(recipe.in, recipe.amount);
  }
  return amounts;
}
