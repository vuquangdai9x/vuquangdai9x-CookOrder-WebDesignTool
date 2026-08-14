// Built-in effect / cell-type / customer-type behaviors, matching the sheet's
// definition tables (docs/SHEET_STRUCTURE.md). Import this module once at
// startup to populate the registries.

import {
  registerCellEffect,
  registerCustomerType,
  registerQueueEffect,
} from "./registry.ts";

// Ingredient status ids (ConfigTables "Ingredient statuses")
export const EFFECT_NONE = 0;
export const EFFECT_FREEZE = 1;
export const EFFECT_HIDDEN = 2;
export const EFFECT_HOLDING_KEY = 3;

// Grid cell status ids (ConfigTables "Grid cell statuses")
export const CELL_NORMAL = 0;
export const CELL_BLOCKED = 1;
export const CELL_ORDER_LOCK = 2;
export const CELL_INGREDIENT_SLOT = 3;
export const CELL_COLOR_LOCK = 4;

// Customer type ids
export const CUSTOMER_NORMAL = 0;
export const CUSTOMER_STAFF = 1;

// ---------- queue item effects ----------

registerQueueEffect(EFFECT_NONE, {});

/**
 * Freeze: params[0] is the thaw count — how many picks of an ADJACENT slot
 * (4-connected in the queue grid) are needed before the item can be picked.
 * Not registered here: this needs per-item remaining-count state and the
 * picked cell's coordinates, neither of which the generic
 * canPick(effect, ctx) signature carries (ctx is just a flat shared-counters
 * snapshot, with no way to identify which QueueItem an EffectInstance
 * belongs to). See Simulation.freezeCount()/decrementAdjacentFreezes() in
 * sim.ts, which special-case EFFECT_FREEZE directly instead.
 */
registerQueueEffect(EFFECT_FREEZE, {});

/**
 * Hidden: the slot renders as "?" until it reaches the front row (or, inside a
 * combined block, until that block fronts). Purely informational — it never
 * blocks a pick, so the registered handler is genuinely empty rather than
 * merely unimplemented.
 *
 * The reveal test can't live here for the same reason Freeze's can't (above):
 * it depends on the item's queue COORDINATES, and canPick(effect, ctx) only
 * receives a flat shared-counters snapshot with no way to locate the
 * EffectInstance's owning cell. See Simulation.isHidden() in sim.ts.
 *
 * (Id 2 was previously a retired "Link" status — unrelated to the real
 * combined/linked queue GROUPS, which live in LevelConfig.queueGroups.)
 */
registerQueueEffect(EFFECT_HIDDEN, {});

/** HoldingKey: picking the item grants one key of `colorId`, opening ColorLock cells. */
registerQueueEffect(EFFECT_HOLDING_KEY, {
  onPick(effect, ctx) {
    const colorId = effect.params[0] ?? 0;
    ctx.keysByColor[colorId] = (ctx.keysByColor[colorId] ?? 0) + 1;
  },
});

// ---------- grid cell effects ----------

registerCellEffect(CELL_NORMAL, { isUsable: () => true });

/** Blocked: unusable for the whole level. */
registerCellEffect(CELL_BLOCKED, {
  isUsable: () => false,
  progressLabel: () => "blocked",
});

/** OrderLock: opens once `orderCount` customers have been served. */
registerCellEffect(CELL_ORDER_LOCK, {
  isUsable: (effect, ctx) => ctx.ordersCompleted >= (effect.params[0] ?? 0),
  progressLabel: (effect, ctx) =>
    `${ctx.ordersCompleted}/${effect.params[0] ?? 0} orders`,
});

/**
 * Ingredient-slot: keyed to one specific ingredient. Opens once `amount` of
 * ingredient `ingredientId` have been picked. Params: [ingredientId, amount].
 */
registerCellEffect(CELL_INGREDIENT_SLOT, {
  isUsable: (effect, ctx) => {
    const [ingredientId = 0, amount = 1] = effect.params;
    return (ctx.picksByIngredient[ingredientId] ?? 0) >= amount;
  },
  progressLabel: (effect, ctx) => {
    const [ingredientId = 0, amount = 1] = effect.params;
    return `${ctx.picksByIngredient[ingredientId] ?? 0}/${amount}`;
  },
});

/** ColorLock: opens once `keyCount` keys of `colorId` have been collected. */
registerCellEffect(CELL_COLOR_LOCK, {
  isUsable: (effect, ctx) => {
    const [colorId = 0, keyCount = 1] = effect.params;
    return (ctx.keysByColor[colorId] ?? 0) >= keyCount;
  },
  progressLabel: (effect, ctx) => {
    const [colorId = 0, keyCount = 1] = effect.params;
    return `${ctx.keysByColor[colorId] ?? 0}/${keyCount} keys`;
  },
});

// ---------- customer types ----------

registerCustomerType(CUSTOMER_NORMAL, {});

/** Staff: clears X oldest dirty stacks on arrival, orders nothing, leaves at once. */
registerCustomerType(CUSTOMER_STAFF, {
  onArrive(params, api) {
    api.clearDirtyStacks(params[0] ?? 1);
    return true;
  },
});
