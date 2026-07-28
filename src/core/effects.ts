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
export const EFFECT_LINK = 2;
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

/** Freeze: item cannot be picked until `thawCount` other ingredients are picked. */
registerQueueEffect(EFFECT_FREEZE, {
  canPick(effect, ctx) {
    const thawAt = effect.params[0] ?? 0;
    return ctx.picksMade >= thawAt
      ? { ok: true }
      : { ok: false, reason: `Frozen until ${thawAt} picks (now ${ctx.picksMade})` };
  },
});

/** Link: paired with another item. Pairing rules are map-specific; no-op for now. */
registerQueueEffect(EFFECT_LINK, {});

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
