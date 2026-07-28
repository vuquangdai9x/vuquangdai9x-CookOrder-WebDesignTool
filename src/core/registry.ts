// Behavior registries. Definitions (id/name/icon/params) are designer data;
// the behavior for each id is registered here in code. Unknown ids resolve to
// a permissive no-op handler so designer data can never crash the sim.
// See docs/GDD.md §5.

import type { EffectInstance, Id } from "./types.ts";

/** Read-only view of the sim state that handlers are allowed to query. */
export interface EffectContext {
  /** Ingredients picked from queues so far this level. */
  picksMade: number;
  /** Picks so far per raw ingredient id (drives ingredient-slot cells). */
  picksByIngredient: Record<number, number>;
  /** Customers fully served so far. */
  ordersCompleted: number;
  /** Keys collected per colorId (index = colorId). */
  keysByColor: Record<number, number>;
}

/** Behavior of an effect attached to a queue item. */
export interface QueueEffectHandler {
  /** False blocks picking the item. `reason` explains why, for the UI. */
  canPick?(effect: EffectInstance, ctx: EffectContext): { ok: boolean; reason?: string };
  /** Called when the item carrying this effect is picked. */
  onPick?(effect: EffectInstance, ctx: EffectContext): void;
}

/** Behavior of a cell type / effect attached to a grid cell. */
export interface CellEffectHandler {
  /** False means the cell cannot hold items right now. */
  isUsable(effect: EffectInstance, ctx: EffectContext): boolean;
  /** Progress text for the UI, e.g. "2/3 orders". */
  progressLabel?(effect: EffectInstance, ctx: EffectContext): string;
}

/** Behavior of a special customer type. */
export interface CustomerTypeHandler {
  /** Runs when the customer reaches a serve slot; return true if they leave immediately. */
  onArrive?(params: number[], api: { clearDirtyStacks(count: number): void }): boolean;
}

const queueEffects = new Map<Id, QueueEffectHandler>();
const cellEffects = new Map<Id, CellEffectHandler>();
const customerTypes = new Map<Id, CustomerTypeHandler>();

const warned = new Set<string>();

function warnOnce(kind: string, id: Id): void {
  const key = `${kind}:${id}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`No ${kind} handler registered for id ${id}; treating as no-op.`);
}

export function registerQueueEffect(id: Id, handler: QueueEffectHandler): void {
  queueEffects.set(id, handler);
}

export function registerCellEffect(id: Id, handler: CellEffectHandler): void {
  cellEffects.set(id, handler);
}

export function registerCustomerType(id: Id, handler: CustomerTypeHandler): void {
  customerTypes.set(id, handler);
}

export function getQueueEffect(id: Id): QueueEffectHandler {
  const h = queueEffects.get(id);
  if (h) return h;
  warnOnce("queue effect", id);
  return {};
}

/** Unknown cell effects leave the cell usable rather than silently blocking it. */
export function getCellEffect(id: Id): CellEffectHandler {
  const h = cellEffects.get(id);
  if (h) return h;
  warnOnce("cell effect", id);
  return { isUsable: () => true };
}

export function getCustomerType(id: Id): CustomerTypeHandler {
  const h = customerTypes.get(id);
  if (h) return h;
  warnOnce("customer type", id);
  return {};
}

export function hasCellEffect(id: Id): boolean {
  return cellEffects.has(id);
}
