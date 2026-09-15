// Piece-level demand/supply math for cooked-ingredient orders vs. queued raw
// ingredients. Shared by two independent consumers that both need to answer
// "does the queue supply enough of this ingredient": validate.ts's
// cross-level "Not enough X" warning (data layer, driven by saved LevelData
// strings) and ui/design/queueSection.ts's live Recipe Pieces foldout (UI
// layer, driven by the current unsaved draft). One implementation is used by
// both so process yields and physical bag pieces stay consistent.
//
// Pure — no DOM — so it's unit-testable directly. This also has to live in
// data/, not ui/design/, precisely because validate.ts (data layer) needs it:
// ui/design/queueSection.ts pulls in contextMenu.ts, which touches `document`
// at module load time, so anything validate.ts imported from ui/ would break
// under this repo's non-jsdom vitest environment — and importing UI code from
// the data layer would be backwards regardless.

import type { CookingToolDef, CustomerConfig, Id, QueueItem } from "../core/types.ts";

export interface RawDemand {
  /** Total physical dish-piece occurrences requiring this raw id's cooked output. */
  need: number;
  /** Physical pieces one raw pickup of this id yields (a tool recipe's `amount`; 1 with no tool). */
  amount: number;
}

/** The only map field this module needs. */
type ToolsOnly = { tools: CookingToolDef[] };

/**
 * Demand implied by customer orders, keyed by raw id. `need` is the exact
 * physical dish-piece count. A caller compares it with queue bag pieces times
 * the process output amount.
 */
export function demandByRaw(map: ToolsOnly, customers: CustomerConfig[]): Map<Id, RawDemand> {
  const cookedToRaw = new Map<Id, { rawId: Id; amount: number }>();
  for (const tool of map.tools) {
    for (const recipe of tool.recipes) {
      cookedToRaw.set(recipe.out, { rawId: recipe.in, amount: recipe.amount });
    }
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
    const existing = demand.get(rawId);
    if (existing) existing.need += count;
    else demand.set(rawId, { need: count, amount });
  }
  return demand;
}

/** Raw PIECES actually present in a queue, counted per raw id — a bag slot counts its whole amount — not yet multiplied by yield (see rawYieldAmounts/RawDemand.amount for that). */
export function supplyByRaw(queues: QueueItem[][]): Map<Id, number> {
  const supply = new Map<Id, number>();
  for (const lane of queues) {
    for (const item of lane) {
      if (item.kind !== "ingredient") continue;
      supply.set(item.id, (supply.get(item.id) ?? 0) + Math.max(1, item.amount ?? 1));
    }
  }
  return supply;
}

/** Pieces one pickup of a raw id yields, for every raw id with a recipe — used to price out "have" pieces even for a raw id the current orders don't demand at all. */
export function rawYieldAmounts(map: ToolsOnly): Map<Id, number> {
  const amounts = new Map<Id, number>();
  for (const tool of map.tools) {
    for (const recipe of tool.recipes) amounts.set(recipe.in, recipe.amount);
  }
  return amounts;
}
