// "Auto-calculate assigned ingredient" — a Design-mode-only visual aid (see
// queueSection.ts's toolbar toggle). Nothing here is persisted: it's a pure
// function recomputed on every render from the current customer/queue drafts,
// used only to color queue tiles so a designer can see at a glance which
// queued raw item is headed for which customer.
//
// Simplification: this treats every queue item as producing exactly one
// usable cooked piece for exactly one dish slot — it does not model a tool
// recipe's `amount` (pieces per raw pickup) or a cooked ingredient's
// `usageNum` (times one placed instance can be re-served). Modeling those
// precisely would require simulating shared/leftover supply across
// customers; this is a rough-match visual aid, not a game simulation.

import { CUSTOMER_STAFF } from "../../core/effects.ts";
import { resolveCookedId } from "../../core/types.ts";
import type { CustomerConfig, MapDef, QueueItem } from "../../core/types.ts";
import { cidOf } from "./changeTracking.ts";

/** Cycled by customer index — consecutive indices always land on different colors. */
export const PALETTE: readonly string[] = [
  "#e05a5a",
  "#f0a441",
  "#e0d34a",
  "#6bbf59",
  "#4ad0b0",
  "#5aa7e0",
  "#8f7ae0",
  "#e05ac0",
];

export function customerColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

/**
 * Assigns queue items to customers in "who gets served next" order: walk the
 * queue grid breadth-first (front row across every lane first, i.e. the
 * top-most/soonest-picked items), building a front-first supply pool per
 * cooked id. Then, for each customer in arrival order, claim the front-most
 * still-available matching item for each cooked ingredient their dishes call
 * for — claimed items are removed from the pool (dequeued) so a later
 * customer can never be assigned the same tile. Staff customers order
 * nothing and are skipped (they still occupy a color-index slot, so their
 * neighbors' colors don't shift because of them).
 *
 * Returns cid -> color for every queue item that got matched; unmatched
 * items (nothing in this customer's remaining demand, or the queue simply
 * doesn't have enough of that ingredient) are absent from the map.
 */
export function computeIngredientAssignment(
  map: MapDef,
  customers: CustomerConfig[],
  queues: QueueItem[][],
): Map<string, string> {
  const maxRows = queues.reduce((h, lane) => Math.max(h, lane.length), 0);

  // Front-first (row-major) supply pool, keyed by the cooked id this raw
  // item resolves to — a FIFO queue of item cids per cooked id.
  const pool = new Map<number, string[]>();
  for (let y = 0; y < maxRows; y++) {
    for (const lane of queues) {
      const item = lane[y];
      if (!item || item.kind !== "ingredient") continue;
      const cid = cidOf(item);
      if (!cid) continue;
      const cookedId = resolveCookedId(map.tools, map.rawIngredients, item.id);
      const bucket = pool.get(cookedId);
      if (bucket) bucket.push(cid);
      else pool.set(cookedId, [cid]);
    }
  }

  const colorByCid = new Map<string, string>();
  customers.forEach((customer, index) => {
    if (customer.typeId === CUSTOMER_STAFF) return;
    const color = customerColor(index);
    for (const dish of customer.dishes) {
      for (const cookedId of dish.cookedIds) {
        const bucket = pool.get(cookedId);
        const cid = bucket?.shift();
        if (cid) colorByCid.set(cid, color);
      }
    }
  });
  return colorByCid;
}
