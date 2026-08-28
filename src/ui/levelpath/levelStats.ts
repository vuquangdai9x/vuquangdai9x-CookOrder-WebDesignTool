// Everything the Level Path table's statistic columns show, computed from a
// level's three canonical strings and the graph they speak.
//
// Pure and DOM-free on purpose: the table renders hundreds of these at once
// and the tab computes every map's set up front (behind a loading overlay), so
// this has to be cheap, synchronous and unit-testable. Nothing here estimates
// or simulates — those live in validateLevel.ts and cost seconds, not
// microseconds.
//
// Statuses are counted by DEFINITION ID rather than by name: the ids are what
// the level strings carry, and cell-statuses.json / ingredient-statuses.json
// are what turn them back into a label and an emoji for the header.

import { parseGrid, parseQueueGroups, parseQueues } from "../../core/parser.ts";
import { dishIngredientIds, parseNodeCustomers } from "../../core/nodeParser.ts";
import type { NodeCustomerConfig } from "../../core/nodeParser.ts";
import { resolveOrder } from "../../core/nodeOrder.ts";
import type { GraphIndex } from "../../core/nodeIndex.ts";
import type { IdIndex } from "../../data/nodeIdTable.ts";
import type { LevelData } from "../../data/mapLoader.ts";

/** Ingredient-status ids (config/general/ingredient-statuses.json) the stats name explicitly. */
export const STATUS_FREEZE = 1;
export const STATUS_HIDDEN = 2;
export const STATUS_HOLDING_KEY = 3;
/** Cell-status id (config/general/cell-statuses.json) for a colour lock — the other half of Lock & Key. */
export const CELL_COLOR_LOCK = 4;

export interface LevelStats {
  numCustomers: number;
  /** Customers with a patience timer (waitTime > 0) — the ones that can time out. */
  numTimedCustomers: number;
  numDishes: number;
  /** Ingredient slots ordered across every dish — what the player actually assembles. */
  numIngredients: number;
  /** Sum of the ordered ingredients' `price`. */
  totalCoin: number;
  /** Sum of every concrete ingredient written directly in the ordered dish combinations. */
  totalPrice: number;
  /** Distinct ingredient ids appearing anywhere in the queue. */
  itemTypes: number;
  /** Queue lanes, and total tiles across them. */
  numLanes: number;
  numQueueItems: number;
  /** Ingredient-status id -> how many queue tiles carry it. */
  slotStatus: Map<number, number>;
  /** Cell-status id -> how many grid cells carry it. */
  cellStatus: Map<number, number>;
  /** Queue tiles belonging to a "linked" group, and to a "combined" one. */
  linkedSlots: number;
  combinedSlots: number;
  /** Key-carrying queue tiles plus colour-locked grid cells — one number for the whole mechanic. */
  lockAndKey: number;
  /** Anything that failed to parse; the row shows these instead of pretending the numbers are real. */
  parseErrors: string[];
}

const emptyStats = (): LevelStats => ({
  numCustomers: 0,
  numTimedCustomers: 0,
  numDishes: 0,
  numIngredients: 0,
  totalCoin: 0,
  totalPrice: 0,
  itemTypes: 0,
  numLanes: 0,
  numQueueItems: 0,
  slotStatus: new Map(),
  cellStatus: new Map(),
  linkedSlots: 0,
  combinedSlots: 0,
  lockAndKey: 0,
  parseErrors: [],
});

const bump = (counter: Map<number, number>, key: number, by = 1): void => {
  counter.set(key, (counter.get(key) ?? 0) + by);
};

/**
 * Customer-side numbers.
 *
 * Dishes are resolved through the graph rather than counted as raw bracket
 * members, because a dish's ingredient count is a property of the resolved
 * ORDER: nested groups, shared options and multi-use items all mean the
 * bracket tree and the slot list disagree, and the slot list is what a player
 * assembles.
 */
function addCustomerStats(
  stats: LevelStats,
  customers: NodeCustomerConfig[],
  ix: GraphIndex,
  ids: IdIndex,
): void {
  stats.numCustomers = customers.length;
  for (const customer of customers) {
    if (customer.waitTime > 0) stats.numTimedCustomers++;
    stats.numDishes += customer.dishes.length;
    for (const dish of customer.dishes) {
      for (const ingredientId of dishIngredientIds(dish)) {
        const name = ids.byId.ingredient.get(ingredientId);
        const ingredientIndex = name === undefined ? undefined : ix.ingByName.get(name);
        stats.totalPrice += ingredientIndex === undefined ? 0 : (ix.doc.vertices.ingredient[ingredientIndex]?.price ?? 0);
      }
      const { order } = resolveOrder(ix, dish, ids);
      stats.numIngredients += order.slots.length;
      for (const slot of order.slots) {
        stats.totalCoin += ix.doc.vertices.ingredient[slot.ing]?.price ?? 0;
      }
    }
  }
}

export function computeLevelStats(level: LevelData, ix: GraphIndex, ids: IdIndex): LevelStats {
  const stats = emptyStats();

  // Each string is parsed under its own guard. One malformed grid must not
  // blank the customer numbers too — a designer fixing a broken level needs
  // every number the level CAN still report.
  try {
    addCustomerStats(stats, parseNodeCustomers(level.customerString), ix, ids);
  } catch (err) {
    stats.parseErrors.push(`Customer string: ${(err as Error).message}`);
  }

  try {
    const lanes = parseQueues(level.queueString);
    const types = new Set<number>();
    stats.numLanes = lanes.length;
    for (const lane of lanes) {
      for (const item of lane) {
        stats.numQueueItems++;
        if (item.kind === "ingredient") types.add(item.id);
        for (const effect of item.effects) {
          bump(stats.slotStatus, effect.effectId);
          if (effect.effectId === STATUS_HOLDING_KEY) stats.lockAndKey++;
        }
      }
    }
    stats.itemTypes = types.size;

    for (const group of parseQueueGroups(level.queueString)) {
      if (group.kind === "linked") stats.linkedSlots += group.cells.length;
      else stats.combinedSlots += group.cells.length;
    }
  } catch (err) {
    stats.parseErrors.push(`Queue string: ${(err as Error).message}`);
  }

  try {
    for (const cell of parseGrid(level.gridString)) {
      for (const effect of cell.effects) {
        bump(stats.cellStatus, effect.effectId);
        if (effect.effectId === CELL_COLOR_LOCK) stats.lockAndKey++;
      }
    }
  } catch (err) {
    stats.parseErrors.push(`Grid string: ${(err as Error).message}`);
  }

  return stats;
}
