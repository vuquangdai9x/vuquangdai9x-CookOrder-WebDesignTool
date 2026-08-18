// Customer auto-generation on the node graph.
//
// The legacy generator picks cooked ids by weight and hopes the result forms a
// legal dish. It cannot be reused here, because a node dish is a bracket tree
// and an arbitrary bag of ingredients does not become one. So this generator
// works the other way round, and that inversion is the whole design:
//
//   pick an ORDERABLE first, then walk its slot tree and fill each slot.
//
// Every dish is therefore well-formed BY CONSTRUCTION rather than by
// post-filtering — INV-DISH-SINGLE-ORDERABLE cannot be violated, slot caps
// cannot be exceeded, and `toppingRequired` is honoured because the walk
// simply does not skip a required slot.
//
// Weights, the dish-count sequence and the complexity curve keep exactly the
// meanings they have in the legacy dialog, so a designer's mental model
// carries over.

import type { CurveState } from "../design/curveEditor.ts";
import { evaluateCurve } from "../design/curveEditor.ts";
import { autoDishCount, DEFAULT_MAX_DISH_SLOTS } from "../design/autoGenerate.ts";
import type { GraphIndex, IndexedSlot } from "../../core/nodeIndex.ts";
import type { DishMember, DishNode, NodeCustomerConfig, NodeDish } from "../../core/nodeParser.ts";
import type { IdIndex } from "../../data/nodeIdTable.ts";

export interface NodeGenerateOptions {
  /** One entry per customer, in order. -1 = Staff, 0 = Auto (from the curve), >0 = explicit dish count. */
  dishCounts: number[];
  /** Dense ingredient index -> selection weight (0-100). 0/absent = excluded. */
  weights: Map<number, number>;
  curve: CurveState;
  maxDishSlots?: number;
  /** Injectable for deterministic tests; defaults to Math.random. */
  random?: () => number;
  /** Receives deduplicated warnings when a requested dish cannot satisfy its graph constraints. */
  onWarning?: (message: string) => void;
}

/** One weighted draw, consumed as a position along the cumulative weight sum. */
function weightedPick(options: number[], weightOf: (o: number) => number, rand: () => number): number | null {
  const pool = options.map((o) => ({ o, w: Math.max(0, weightOf(o)) })).filter((x) => x.w > 0);
  const total = pool.reduce((sum, x) => sum + x.w, 0);
  if (total <= 0) return null;
  let r = rand() * total;
  for (const x of pool) {
    r -= x.w;
    if (r <= 0) return x.o;
  }
  return pool[pool.length - 1].o;
}

/** Members a slot may hold: a fixed slot one, a group its cap (-1 = unlimited). */
function capacityOf(slot: IndexedSlot, maxDishSlots: number): number {
  if (slot.kind === "fixed") return 1;
  return slot.maxQuantity < 0 ? maxDishSlots : Math.max(1, slot.maxQuantity);
}

/**
 * Fills one orderable's slot tree.
 *
 * `budget` is how many ingredient slots this dish should aim for, from the
 * complexity curve. The base is always filled (a dish without one is
 * unservable), the topping is filled when the composite requires it, and the
 * remaining budget is spent across the optional slots.
 */
function buildDish(
  ix: GraphIndex,
  ids: IdIndex,
  orderable: number,
  budget: number,
  weights: Map<number, number>,
  rand: () => number,
  maxDishSlots: number,
): NodeDish | null {
  const compositeId = ids.byNode.composite.get(ix.compositeName[orderable]);
  if (compositeId === undefined) return null;
  const slots = ix.slotsOfComposite[orderable] ?? [];
  if (slots.length === 0) return null;

  const root: DishNode = { kind: "composite", id: compositeId, members: [] };
  const containers = new Map<string, DishNode>();
  const groupHeld = new Map<number, number>();
  const weightOf = (ing: number) => weights.get(ing) ?? 0;
  const pathKey = (path: number[], length = path.length): string => path.slice(0, length).join("/");
  const groupCapacity = (group: number): number => {
    const maximum = ix.doc.vertices.group[group]?.maxQuantity ?? -1;
    return maximum < 0 ? maxDishSlots : Math.max(0, maximum);
  };

  const put = (slotIndex: number, ing: number): boolean => {
    const slot = slots[slotIndex];
    const dataId = ids.byNode.ingredient.get(ix.ingName[ing]);
    if (dataId === undefined) return false;
    let container = root;
    for (let depth = 0; depth < slot.groupPath.length; depth++) {
      const key = pathKey(slot.groupPath, depth + 1);
      let child = containers.get(key);
      if (!child) {
        if (depth > 0) {
          const parentGroup = slot.groupPath[depth - 1];
          if ((groupHeld.get(parentGroup) ?? 0) >= groupCapacity(parentGroup)) return false;
        }
        const group = slot.groupPath[depth];
        const groupId = ids.byNode.group.get(ix.groupName[group]);
        if (groupId === undefined) return false;
        child = { kind: "group", id: groupId, members: [] };
        container.members.push(child);
        containers.set(key, child);
        if (depth > 0) {
          const parentGroup = slot.groupPath[depth - 1];
          groupHeld.set(parentGroup, (groupHeld.get(parentGroup) ?? 0) + 1);
        }
      }
      container = child;
    }
    const leafGroup = slot.groupPath[slot.groupPath.length - 1];
    if (leafGroup !== undefined) {
      if ((groupHeld.get(leafGroup) ?? 0) >= groupCapacity(leafGroup)) return false;
      groupHeld.set(leafGroup, (groupHeld.get(leafGroup) ?? 0) + 1);
    }
    container.members.push({ kind: "ingredient", id: dataId } as DishMember);
    return true;
  };

  const held = slots.map(() => 0);
  const tryFill = (slotIndex: number): boolean => {
    const slot = slots[slotIndex];
    if (held[slotIndex] >= capacityOf(slot, maxDishSlots)) return false;
    // Per-dish limits are a property of the ingredient, so an option already at
    // its limit is simply not a candidate any more.
    const eligible = slot.options.filter((option, at) => {
      const limit = slot.optionMax[at] ?? -1;
      if (limit <= 0) return true;
      return countOf(root, containers, slot, option, ix, ids) < limit;
    });
    const pick = weightedPick(eligible, weightOf, rand);
    if (pick === null) return false;
    if (!put(slotIndex, pick)) return false;
    held[slotIndex]++;
    return true;
  };

  const baseSlot = slots.findIndex((s) => s.isBase);
  if (baseSlot !== -1 && slots[baseSlot].kind === "fixed" && !tryFill(baseSlot)) return null;

  // Group minima are hard constraints, not complexity suggestions. Fill them
  // before spending the curve budget so a target of 1 cannot under-fill a
  // group whose graph requires 2 items.
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
    const slot = slots[slotIndex];
    if (slot.kind !== "group") continue;
    const required = Math.max(slot.minQuantity, slot.isBase ? 1 : 0);
    while (held[slotIndex] < required) if (!tryFill(slotIndex)) return null;
  }

  const requiresTopping = Boolean(ix.doc.vertices.composite[orderable]?.toppingRequired);
  const optional = slots.map((_, i) => i).filter((i) => i !== baseSlot);
  if (requiresTopping) {
    // Fill at least one non-base slot, or the dish would open already invalid.
    for (const slotIndex of optional) if (tryFill(slotIndex)) break;
  }

  let remaining = Math.max(0, budget - held.reduce((n, h) => n + h, 0));
  let guard = remaining * 4 + 8;
  while (remaining > 0 && optional.length > 0 && guard-- > 0) {
    const slotIndex = optional[Math.floor(rand() * optional.length) % optional.length];
    if (tryFill(slotIndex)) remaining--;
    else if (optional.every((i) => held[i] >= capacityOf(slots[i], maxDishSlots))) break;
  }

  return { root, effects: [] };
}

/** How many copies of `option` a slot currently holds in the dish being built. */
function countOf(
  root: DishNode,
  containers: Map<string, DishNode>,
  slot: IndexedSlot,
  option: number,
  ix: GraphIndex,
  ids: IdIndex,
): number {
  const container = containers.get(slot.groupPath.join("/")) ?? root;
  const dataId = ids.byNode.ingredient.get(ix.ingName[option]);
  return container.members.filter((m) => m.kind === "ingredient" && m.id === dataId).length;
}

export function generateNodeCustomers(
  ix: GraphIndex,
  ids: IdIndex,
  opts: NodeGenerateOptions,
): NodeCustomerConfig[] {
  const rand = opts.random ?? Math.random;
  const maxDishSlots = opts.maxDishSlots ?? DEFAULT_MAX_DISH_SLOTS;
  const counts = opts.dishCounts.length ? opts.dishCounts : [1];
  const out: NodeCustomerConfig[] = [];
  const warnings = new Set<string>();
  const warn = (message: string): void => {
    if (warnings.add(message)) opts.onWarning?.(message);
  };

  // Only orderables with at least one weighted option anywhere are candidates —
  // otherwise a run with a narrow weight set would emit dishes made of nothing.
  const candidates = ix.orderables.filter((composite) =>
    (ix.slotsOfComposite[composite] ?? []).some((slot) =>
      slot.options.some((option) => (opts.weights.get(option) ?? 0) > 0),
    ),
  );

  counts.forEach((count, index) => {
    if (count === -1) {
      out.push({ typeId: 1, waitTime: 0, weatherEff: 0, dishes: [], staffAmount: 1 });
      return;
    }
    // The curve's y at this customer's position is the complexity target, in
    // ingredient slots — exactly what it means in the legacy generator.
    const realX =
      opts.curve.range.minX +
      (counts.length === 1 ? 0 : index / (counts.length - 1)) * (opts.curve.range.maxX - opts.curve.range.minX);
    const target = Math.max(1, Math.round(evaluateCurve(opts.curve, realX)));
    const dishCount = count > 0 ? count : autoDishCount(target, maxDishSlots);
    const perDish = Math.max(1, Math.round(target / Math.max(1, dishCount)));

    const dishes: NodeDish[] = [];
    for (let d = 0; d < dishCount; d++) {
      const orderable = candidates[Math.floor(rand() * candidates.length) % Math.max(1, candidates.length)];
      if (orderable === undefined) continue;
      const dish = buildDish(ix, ids, orderable, perDish, opts.weights, rand, maxDishSlots);
      if (dish) dishes.push(dish);
      else warn(`Could not generate ${ix.compositeName[orderable]}: enabled ingredients cannot satisfy its base and group minimum quantities.`);
    }
    out.push({ typeId: 0, waitTime: 0, weatherEff: 0, dishes });
  });

  return out;
}
