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
import { resolveOrder } from "../../core/nodeOrder.ts";
import type { DishMember, DishNode, NodeCustomerConfig, NodeDish } from "../../core/nodeParser.ts";
import type { IdIndex } from "../../data/nodeIdTable.ts";
import {
  addToSlot as addToSlotTree,
  membersOf,
  slotCapacity,
  slotIsUnlocked,
} from "./nodeDishEdit.ts";

/**
 * What a customer IS, beyond how many dishes they order.
 *
 * Shippers and bosses are big orders with a pinned avatar. They are generated
 * BEFORE the normal customers because they are the largest claims on the
 * ingredient budget: the adaptive weight tracker hands whatever is scarcest to
 * whoever asks first, so building the big orders last would assemble them from
 * everyone else's leftovers.
 */
export type CustomerRole = "normal" | "shipper" | "boss";

export interface NodeGenerateOptions {
  /** One entry per customer, in order. -1 = Staff, 0 = Auto (from the curve), >0 = explicit dish count. */
  dishCounts: number[];
  /**
   * Role per customer, parallel to `dishCounts`. Absent means every customer is
   * normal, which is what the plain Auto Generate dialog asks for.
   */
  roles?: CustomerRole[];
  /** Dense ingredient index -> selection weight (0-100). 0/absent = excluded. */
  weights: Map<number, number>;
  /**
   * Dense COMPOSITE index -> how often a customer orders that dish type
   * (0-100). 0 excludes the type entirely.
   *
   * Absent means "no preference", and the dish type is then scored by the
   * average weight of the ingredients it can hold — the behaviour from before
   * dish types were weightable, kept so a level recorded without them
   * regenerates the way it always did.
   */
  compositeWeights?: Map<number, number>;
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
  weightOf: (ing: number) => number,
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
    const unlocked = slot.requiresBaseOf.every((requiredComposite) =>
      slots.some(
        (candidate, candidateIndex) =>
          candidate.baseOf.includes(requiredComposite) && held[candidateIndex] > 0,
      ),
    );
    if (!unlocked) return false;
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

/**
 * Keep each ingredient close to its configured share, instead of applying the
 * same static lottery independently to every dish. An ingredient already
 * ahead of its target share gets only a tiny floor weight; one behind its
 * share gets the current deficit as its draw weight.
 */
function adaptiveWeightTracker(initial: Map<number, number>): {
  weightOf(ing: number): number;
  record(ingredients: number[]): void;
} {
  const used = new Map<number, number>();
  const totalWeight = [...initial.values()].reduce((sum, weight) => sum + Math.max(0, weight), 0);
  let totalUsed = 0;
  return {
    weightOf(ing: number): number {
      const weight = Math.max(0, initial.get(ing) ?? 0);
      if (weight <= 0 || totalWeight <= 0) return 0;
      const desiredAfterNextPick = ((totalUsed + 1) * weight) / totalWeight;
      const deficit = desiredAfterNextPick - (used.get(ing) ?? 0);
      return Math.max(weight / totalWeight / 1000, deficit);
    },
    record(ingredients: number[]): void {
      for (const ing of ingredients) {
        used.set(ing, (used.get(ing) ?? 0) + 1);
        totalUsed++;
      }
    },
  };
}

/** Pickup capacities needed by one occurrence of an ordered ingredient. */
function productionCovers(ix: GraphIndex, ordered: number): number[] {
  const out: number[] = [];
  const usage = Math.max(1, ix.usageNum[ordered] ?? 1);
  const walk = (ing: number, amount: number, seen: Set<number>): void => {
    if (seen.has(ing)) return;
    const step = ix.producerOf[ing];
    if (!step || ix.pickupable[ing]) {
      out.push(Math.max(1, amount) * usage);
      return;
    }
    const next = new Set(seen).add(ing);
    for (const input of step.inputs) walk(input.ing, amount * Math.max(1, step.amount), next);
  };
  walk(ordered, 1, new Set());
  return out.length > 0 ? out : [usage];
}

function alignmentAddition(ix: GraphIndex, ing: number, count: number): number {
  const covers = productionCovers(ix, ing).filter((amount) => amount > 1);
  if (covers.length === 0 || covers.every((amount) => count % amount === 0)) return 0;
  for (let add = 1; add <= 1024; add++) {
    if (covers.every((amount) => (count + add) % amount === 0)) return add;
  }
  return -1;
}

function ingredientCounts(ix: GraphIndex, ids: IdIndex, customers: NodeCustomerConfig[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const customer of customers) {
    for (const dish of customer.dishes) {
      for (const slot of resolveOrder(ix, dish, ids).order.slots) {
        counts.set(slot.ing, (counts.get(slot.ing) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/** Add exactly one occurrence without replacing another member or invalidating the dish. */
function tryAddToDish(
  ix: GraphIndex,
  ids: IdIndex,
  dish: NodeDish,
  ing: number,
  maxDishSlots: number,
): boolean {
  const before = resolveOrder(ix, dish, ids);
  if (before.issues.length > 0 || before.order.slots.length >= maxDishSlots) return false;
  const beforeTargetCount = before.order.slots.filter((slot) => slot.ing === ing).length;
  for (const place of ix.placesOf[ing] ?? []) {
    if (place.orderable !== before.order.orderable) continue;
    const slot = ix.slotsOfComposite[place.orderable]?.[place.slot];
    if (!slot || !slotIsUnlocked(ix, ids, dish.root, place.orderable, place.slot)) continue;
    const held = membersOf(ix, ids, dish.root, place.orderable, place.slot);
    const capacity = Math.min(slotCapacity(slot), maxDishSlots);
    if (held.length >= capacity) continue;
    const optionAt = slot.options.indexOf(ing);
    const optionLimit = optionAt < 0 ? -1 : (slot.optionMax[optionAt] ?? -1);
    if (optionLimit > 0 && held.filter((value) => value === ing).length >= optionLimit) continue;

    const candidate = structuredClone(dish);
    addToSlotTree(ix, ids, candidate.root, place.orderable, place.slot, ing);
    const after = resolveOrder(ix, candidate, ids);
    if (after.issues.length > 0 || after.order.slots.length !== before.order.slots.length + 1) continue;
    if (after.order.slots.filter((filled) => filled.ing === ing).length !== beforeTargetCount + 1) continue;
    dish.root = candidate.root;
    return true;
  }
  return false;
}

/**
 * Make a new legal dish for an otherwise unplaceable spare piece. Every
 * supporting ingredient is restricted to a one-piece production path, so the
 * repair cannot create a second kind of recipe remainder.
 */
function alignmentDish(
  ix: GraphIndex,
  ids: IdIndex,
  target: number,
  initialWeights: Map<number, number>,
  maxDishSlots: number,
): NodeDish | null {
  const hasUnitProduction = (ing: number) => productionCovers(ix, ing).every((amount) => amount === 1);
  const repairWeight = (ing: number): number => {
    if (ing === target) return 1_000_000;
    return (initialWeights.get(ing) ?? 0) > 0 && hasUnitProduction(ing)
      ? Math.max(1, initialWeights.get(ing) ?? 0)
      : 0;
  };

  for (const place of ix.placesOf[target] ?? []) {
    if (!ix.orderables.includes(place.orderable)) continue;
    const dish = buildDish(ix, ids, place.orderable, 1, repairWeight, () => 0.5, maxDishSlots);
    if (!dish) continue;
    let resolved = resolveOrder(ix, dish, ids);
    if (!resolved.order.slots.some((slot) => slot.ing === target)) {
      if (!tryAddToDish(ix, ids, dish, target, maxDishSlots)) continue;
      resolved = resolveOrder(ix, dish, ids);
    }
    if (resolved.issues.length > 0) continue;
    if (resolved.order.slots.some((slot) => slot.ing !== target && !hasUnitProduction(slot.ing))) continue;
    return dish;
  }
  return null;
}

function alignRecipePieces(
  ix: GraphIndex,
  ids: IdIndex,
  customers: NodeCustomerConfig[],
  weights: Map<number, number>,
  maxDishSlots: number,
  warn: (message: string) => void,
): void {
  const blocked = new Set<number>();
  let repairCustomer: NodeCustomerConfig | null = null;
  let guard = 2048;
  while (guard-- > 0) {
    const counts = ingredientCounts(ix, ids, customers);
    const pending = [...counts.entries()].find(([ing, count]) =>
      !blocked.has(ing) && alignmentAddition(ix, ing, count) !== 0
    );
    if (!pending) break;
    const [ing, count] = pending;
    if (alignmentAddition(ix, ing, count) < 0) {
      blocked.add(ing);
      continue;
    }

    let added = false;
    for (const customer of customers) {
      for (const dish of customer.dishes) {
        if (tryAddToDish(ix, ids, dish, ing, maxDishSlots)) {
          added = true;
          break;
        }
      }
      if (added) break;
    }
    if (added) continue;

    const dish = alignmentDish(ix, ids, ing, weights, maxDishSlots);
    if (dish) {
      if (!repairCustomer) {
        repairCustomer = { typeId: 0, waitTime: 0, weatherEff: 0, dishes: [] };
        customers.push(repairCustomer);
      }
      repairCustomer.dishes.push(dish);
      continue;
    }

    warn(`Could not place the spare piece of ${ix.ingName[ing]} in a legal dish without creating another recipe remainder.`);
    blocked.add(ing);
  }
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
  const initialWeightOf = (ing: number) => opts.weights.get(ing) ?? 0;
  const adaptive = adaptiveWeightTracker(opts.weights);

  // Ingredient weights are an option allowlist, not an all-or-nothing switch
  // for their composite. Probe the same builder used below with its smallest
  // dish budget, then resolve the result: the orderable enters the random dish-
  // type pool iff at least one enabled combination satisfies all of its real
  // base, nested-base, topping, group-minimum, and quantity rules.
  // A dish type weighted 0 is out before anything else is asked about it: the
  // generator picks the TYPE first, so a zero there means the type is simply
  // not in the draw, however its ingredients are weighted.
  const typeWeights = opts.compositeWeights;
  const candidates = ix.orderables.filter((composite) => {
    if (typeWeights && (typeWeights.get(composite) ?? 0) <= 0) return false;
    const slots = ix.slotsOfComposite[composite] ?? [];
    const probe = buildDish(ix, ids, composite, 1, initialWeightOf, () => 0, maxDishSlots);
    return probe !== null && resolveOrder(ix, probe, ids).issues.length === 0 && slots.length > 0;
  });
  if (candidates.length === 0 && counts.some((count) => count !== -1)) {
    warn(
      typeWeights && ix.orderables.every((composite) => (typeWeights.get(composite) ?? 0) <= 0)
        ? "No dish type is eligible: every dish type is weighted 0."
        : "No dish type is eligible: no enabled ingredient combination satisfies its base, required topping, or minimum quantities.",
    );
  }

  // Specials first, then the normal customers — see CustomerRole. Each result
  // is written back into its OWN position, so the arrival order the caller
  // asked for survives the reordering of the work.
  const roles = opts.roles ?? [];
  const buildOrder = counts
    .map((_, index) => index)
    .sort((a, b) => roleRank(roles[a]) - roleRank(roles[b]) || a - b);
  const built: (NodeCustomerConfig | null)[] = counts.map(() => null);

  buildOrder.forEach((index) => {
    const count = counts[index];
    if (count === -1) {
      built[index] = { typeId: 1, waitTime: 0, weatherEff: 0, dishes: [], staffAmount: 1 };
      return;
    }
    // The curve's y at this customer's position is the complexity target, in
    // ingredient slots — exactly what it means in the legacy generator.
    // NOTE: the position is the customer's ARRIVAL index, not the order they
    // happen to be built in — the curve describes the shape of the level as
    // played, and reading it in build order would flatten it.
    const realX =
      opts.curve.range.minX +
      (counts.length === 1 ? 0 : index / (counts.length - 1)) * (opts.curve.range.maxX - opts.curve.range.minX);
    const target = Math.max(1, Math.round(evaluateCurve(opts.curve, realX)));
    const dishCount = count > 0 ? count : autoDishCount(target, maxDishSlots);
    const perDish = Math.max(1, Math.round(target / Math.max(1, dishCount)));

    const dishes: NodeDish[] = [];
    for (let d = 0; d < dishCount; d++) {
      // Step one of building a dish: WHICH dish. Drawn from the configured
      // type weights when there are any, so "burgers are common, salads are
      // rare" is a thing a designer can say directly rather than approximate by
      // weighting ingredients.
      const orderable = weightedPick(
        candidates,
        (composite) => {
          if (typeWeights) return typeWeights.get(composite) ?? 0;
          const options = [...new Set((ix.slotsOfComposite[composite] ?? []).flatMap((slot) => slot.options))];
          if (options.length === 0) return 0;
          return options.reduce((sum, ing) => sum + adaptive.weightOf(ing), 0) / options.length;
        },
        rand,
      );
      if (orderable === null) continue;
      const dish = buildDish(ix, ids, orderable, perDish, adaptive.weightOf, rand, maxDishSlots);
      if (dish) {
        dishes.push(dish);
        adaptive.record(resolveOrder(ix, dish, ids).order.slots.map((slot) => slot.ing));
      }
      else warn(`Could not generate ${ix.compositeName[orderable]}: enabled ingredients cannot satisfy its base and group minimum quantities.`);
    }
    built[index] = { typeId: 0, waitTime: 0, weatherEff: 0, dishes };
  });

  for (const customer of built) {
    if (customer) out.push(customer);
  }
  alignRecipePieces(ix, ids, out, opts.weights, maxDishSlots, warn);
  return out;
}

/** Generation order: bosses and shippers before anyone else. */
function roleRank(role: CustomerRole | undefined): number {
  if (role === "boss") return 0;
  if (role === "shipper") return 1;
  return 2;
}
