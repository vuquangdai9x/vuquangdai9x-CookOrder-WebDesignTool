// Tracing a recipe graph: what does an orderable decompose into, and can a
// player actually obtain every piece of it?
//
// Pure — no DOM, no config imports beyond types — so it is unit-testable and
// safe to run live while a designer edits.
//
// The central idea is the SLOT TREE. A composite's base and topping each
// resolve to either a concrete ingredient (a fixed slot), a choice group (a
// choice slot), or another composite (which flattens into more
// slots). Nesting is therefore a resolve-time concept: however deeply
// composites nest, an order is a flat list of slots. That flattening is what
// lets the runtime stay O(1) per serve, and it is also what makes a legacy
// flat dish re-bracketable during migration.
//
// The other load-bearing rule is that AT MOST ONE process edge may produce any
// ingredient (INV-UNIQUE-PRODUCER). With that, walking backwards from an
// ingredient is deterministic — there is never a choice of *how* something was
// made, only of *which* option a group took.

import type {
  NodeGraphMap,
  ProcessEdge,
  VertexKindName,
} from "./nodeGraphTypes.ts";

/** One choice point inside an orderable, after nesting has been flattened away. */
export interface Slot {
  /** "fixed" = a concrete ingredient with no choice; "group" = a choice set. */
  kind: "fixed" | "group";
  /** Group name for a choice slot; null for a fixed one. */
  group: string | null;
  /** Ingredients that may fill this slot. Exactly one entry for a fixed slot. */
  options: string[];
  /**
   * Per-option cap, parallel to `options`; -1 = unlimited.
   *
   * This is what replaced the ingredient's own `limitPerDish`. That field said
   * "at most N of me per dish", which duplicated what the structure already
   * says: an ingredient sits in exactly one slot (INV-ORDER-REBUILDABLE), so
   * its per-dish cap IS its cap in that slot. Two places to state one fact is
   * two places to disagree.
   */
  optionMax: number[];
  /** -1 = unlimited. Group-level cap across ALL options; 1 for a fixed slot. */
  maxQuantity: number;
  /** Minimum total picks required across all options; 0 for a fixed slot. */
  minQuantity: number;
  /** True when this slot came down a `base` edge — the thing every other slot gates on. */
  isBase: boolean;
}

/** One step of a backward walk from a produced ingredient to its pickupables. */
export interface ChainStep {
  node: string;
  /** Absent at a pickupable leaf, where the chain terminates. */
  tool?: string;
  amount?: number;
  duration?: number;
  /** Extra tools visited after `tool`, producing no intermediate item. */
  chainTools?: string[];
  inputs: ChainStep[];
}

export interface OrderableTrace {
  orderable: string;
  slots: Slot[];
  /** Distinct pickupables needed across every concrete variant. */
  leaves: string[];
  /** One backward chain per distinct produced ingredient reachable from this orderable. */
  chains: ChainStep[];
  /**
   * Concrete variants, or null when unbounded. A MULTIPLE group with an
   * uncapped quantity makes the count infinite (build-your-own burgers), so
   * reachability is decided on the finite option SET while the count is
   * reported separately. Any design that enumerates variants hangs on real data.
   */
  variantCount: number | null;
  /** Longest tool chain depth — a coarse difficulty proxy. Chicken is 2, everything else 1. */
  maxDepth: number;
  /** Ingredients that never bottom out at a pickupable (INV-TRACEABLE failures). */
  unreachable: string[];
}

/** Adjacency and lookups derived once per document, shared by every trace. */
export interface GraphLookup {
  kindOf: Map<string, VertexKindName>;
  /** The single process edge producing an ingredient; absent = pickupable leaf. */
  producerOf: Map<string, ProcessEdge>;
  /** Every process edge that consumes an ingredient (v1 expects at most one). */
  consumersOf: Map<string, ProcessEdge[]>;
  baseOf: Map<string, string>;
  toppingOf: Map<string, string>;
  optionsOf: Map<string, { to: string; maxQuantity: number }[]>;
  dirtyOf: Map<string, string>;
  pickupable: Set<string>;
  servable: Set<string>;
  groupMax: Map<string, number>;
  groupMin: Map<string, number>;
  orderables: string[];
}

export function buildLookup(doc: NodeGraphMap): GraphLookup {
  const kindOf = new Map<string, VertexKindName>();
  for (const kind of ["ingredient", "tool", "group", "composite", "dirty"] as const) {
    for (const v of doc.vertices[kind]) kindOf.set(v.name, kind);
  }

  const producerOf = new Map<string, ProcessEdge>();
  const consumersOf = new Map<string, ProcessEdge[]>();
  for (const edge of doc.edges.process) {
    // First writer wins; a second producer is an INV-UNIQUE-PRODUCER error
    // reported by the validator. Resolving must stay total on invalid data.
    if (!producerOf.has(edge.to)) producerOf.set(edge.to, edge);
    for (const input of edge.inputs) {
      const list = consumersOf.get(input.ingredient) ?? [];
      list.push(edge);
      consumersOf.set(input.ingredient, list);
    }
  }

  const baseOf = new Map(doc.edges.base.map((e) => [e.from, e.to]));
  const toppingOf = new Map(doc.edges.topping.map((e) => [e.from, e.to]));
  const dirtyOf = new Map(doc.edges.leavesDirty.map((e) => [e.from, e.to]));

  const optionsOf = new Map<string, { to: string; maxQuantity: number }[]>();
  for (const edge of doc.edges.option) {
    const list = optionsOf.get(edge.from) ?? [];
    list.push({ to: edge.to, maxQuantity: edge.maxQuantity ?? -1 });
    optionsOf.set(edge.from, list);
  }

  return {
    kindOf,
    producerOf,
    consumersOf,
    baseOf,
    toppingOf,
    optionsOf,
    dirtyOf,
    pickupable: new Set(doc.vertices.ingredient.filter((i) => i.pickupable).map((i) => i.name)),
    servable: new Set(doc.vertices.ingredient.filter((i) => i.servable).map((i) => i.name)),
    groupMax: new Map(doc.vertices.group.map((g) => [g.name, g.maxQuantity ?? -1])),
    groupMin: new Map(doc.vertices.group.map((g) => [g.name, Math.max(0, g.minQuantity ?? 0)])),
    orderables: doc.vertices.composite.filter((c) => c.orderable).map((c) => c.name),
  };
}

/**
 * Flattens a composite into its slot list. Descends `base`/`topping` edges,
 * recursing through nested composites, and expands groups whose options are
 * themselves groups or composites.
 *
 * `isBase` propagates down: a slot reached entirely through `base` edges is
 * the dish's base, which is what every other slot gates on at serve time.
 */
export function slotsOf(lk: GraphLookup, composite: string): Slot[] {
  const acc: Slot[] = [];
  const visiting = new Set<string>();

  const walk = (node: string, isBase: boolean): void => {
    if (visiting.has(node)) return; // cyclic data — INV-ACYCLIC reports it
    visiting.add(node);

    const kind = lk.kindOf.get(node);
    if (kind === "ingredient") {
      acc.push({ kind: "fixed", group: null, options: [node], optionMax: [1], maxQuantity: 1, minQuantity: 0, isBase });
      visiting.delete(node);
      return;
    }
    if (kind === "group") {
      const leaves: string[] = [];
      const leafMax: number[] = [];
      for (const opt of lk.optionsOf.get(node) ?? []) {
        if (lk.kindOf.get(opt.to) === "ingredient") {
          leaves.push(opt.to);
          leafMax.push(opt.maxQuantity);
        } else {
          walk(opt.to, isBase); // a nested group or composite becomes its own slots
        }
      }
      if (leaves.length > 0) {
        acc.push({
          kind: "group",
          group: node,
          options: leaves,
          optionMax: leafMax,
          maxQuantity: lk.groupMax.get(node) ?? -1,
          minQuantity: lk.groupMin.get(node) ?? 0,
          isBase,
        });
      }
      visiting.delete(node);
      return;
    }
    if (kind === "composite") {
      const base = lk.baseOf.get(node);
      if (base) walk(base, isBase);
      const topping = lk.toppingOf.get(node);
      if (topping) walk(topping, false); // a topping is never the base, however deep
    }
    visiting.delete(node);
  };

  walk(composite, true);
  return acc;
}

/**
 * Backward chain from one ingredient to its pickupables. Terminates at a
 * pickupable, or at an ingredient nothing produces (which the caller reports
 * as unreachable). Carries a visiting set so cyclic data returns instead of
 * blowing the stack — this runs live while a designer is mid-edit.
 */
export function chainOf(lk: GraphLookup, node: string, visiting = new Set<string>()): ChainStep {
  if (lk.pickupable.has(node) || visiting.has(node)) return { node, inputs: [] };
  const edge = lk.producerOf.get(node);
  if (!edge) return { node, inputs: [] };
  const next = new Set(visiting).add(node);
  return {
    node,
    tool: edge.from,
    amount: edge.amount,
    duration: edge.duration,
    chainTools: edge.chainTools?.length ? edge.chainTools : undefined,
    inputs: edge.inputs.map((i) => chainOf(lk, i.ingredient, next)),
  };
}

/** How many tool visits separate this ingredient from its pickupables. A pickupable is 0. */
export function depthOf(lk: GraphLookup, node: string, visiting = new Set<string>()): number {
  if (lk.pickupable.has(node) || visiting.has(node)) return 0;
  const edge = lk.producerOf.get(node);
  if (!edge) return 0;
  const next = new Set(visiting).add(node);
  let deepest = 0;
  for (const input of edge.inputs) deepest = Math.max(deepest, depthOf(lk, input.ingredient, next));
  // A chainTools route visits several tools but produces one item, so it still
  // counts as one step — matching the runtime, where nothing lands mid-chain.
  return deepest + 1;
}

function leavesOf(lk: GraphLookup, node: string, out: Set<string>, bad: Set<string>, visiting = new Set<string>()): void {
  if (visiting.has(node)) return;
  if (lk.pickupable.has(node)) {
    out.add(node);
    return;
  }
  const edge = lk.producerOf.get(node);
  if (!edge) {
    bad.add(node); // not pickupable and nothing produces it
    return;
  }
  const next = new Set(visiting).add(node);
  for (const input of edge.inputs) leavesOf(lk, input.ingredient, out, bad, next);
}

/**
 * Concrete variants for one slot list, or null when unbounded.
 *
 * A fixed slot contributes 2 (present or absent) for a topping, 1 for a base —
 * a base is not optional. A group contributes every multiset of size
 * 0..maxQuantity over its options, so a cap of 1 gives "one option or none",
 * which is what the old SINGLE meant. An uncapped group is unbounded and
 * short-circuits to null.
 */
function countVariants(slots: Slot[]): number | null {
  let total = 1;
  for (const slot of slots) {
    if (slot.kind === "fixed") {
      total *= slot.isBase ? 1 : 2;
      continue;
    }
    if (slot.maxQuantity < 0) return null; // uncapped — infinitely many
    // Every multiset of size 0..maxQuantity drawn from this group's options.
    let sum = 0;
    for (let take = slot.minQuantity; take <= slot.maxQuantity; take++) {
      sum += combinationsWithRepetition(slot.options.length, take);
    }
    total *= sum;
  }
  return total;
}

/** C(n + k - 1, k) — multisets of size k drawn from n options. */
function combinationsWithRepetition(n: number, k: number): number {
  if (k === 0) return 1;
  if (n === 0) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n + i)) / (i + 1);
  return Math.round(result);
}

export function traceOrderable(lk: GraphLookup, orderable: string): OrderableTrace {
  const slots = slotsOf(lk, orderable);
  const leaves = new Set<string>();
  const unreachable = new Set<string>();
  const chains: ChainStep[] = [];
  let maxDepth = 0;

  const seen = new Set<string>();
  for (const slot of slots) {
    for (const option of slot.options) {
      leavesOf(lk, option, leaves, unreachable);
      maxDepth = Math.max(maxDepth, depthOf(lk, option));
      if (!lk.pickupable.has(option) && !seen.has(option)) {
        seen.add(option);
        chains.push(chainOf(lk, option));
      }
    }
  }

  return {
    orderable,
    slots,
    leaves: [...leaves].sort(),
    chains,
    variantCount: countVariants(slots),
    maxDepth,
    unreachable: [...unreachable].sort(),
  };
}

export function traceAll(doc: NodeGraphMap): OrderableTrace[] {
  const lk = buildLookup(doc);
  return lk.orderables.map((o) => traceOrderable(lk, o));
}

/**
 * Where each ingredient may sit: `placesOf` lists every `{orderable, slot}`,
 * and `slotOf` names the FIRST — enough for a display hint that only needs one
 * representative.
 *
 * `ambiguousWithinComposite` is the one genuinely dangerous case: the same
 * ingredient offered by two slots of ONE composite. `resolveOrder` maps an
 * ingredient to a slot per composite, last write winning, so a dish authored
 * into slot 0 silently resolves into slot 1 — with a gate it can never open.
 * That is INV-ORDER-REBUILDABLE (C1).
 *
 * Sharing an ingredient across two DIFFERENT orderables (once "C2") is NOT
 * returned here and is no longer an error. The bracket format names the
 * composite, so resolution is scoped to it and the sharing is unambiguous —
 * a shared sauce offered by both a fried basket and a fried potato resolves
 * correctly in each. C2 only ever mattered to the flat-list recogniser the
 * retired legacy migration used.
 */
export function slotIndex(lk: GraphLookup): {
  slotOf: Map<string, { orderable: string; slot: number }>;
  placesOf: Map<string, { orderable: string; slot: number }[]>;
  ambiguousWithinComposite: Map<string, { orderable: string; slot: number }[]>;
} {
  const placesOf = new Map<string, { orderable: string; slot: number }[]>();
  for (const orderable of lk.orderables) {
    slotsOf(lk, orderable).forEach((slot, index) => {
      for (const option of slot.options) {
        const list = placesOf.get(option) ?? [];
        list.push({ orderable, slot: index });
        placesOf.set(option, list);
      }
    });
  }
  const slotOf = new Map<string, { orderable: string; slot: number }>();
  const ambiguousWithinComposite = new Map<string, { orderable: string; slot: number }[]>();
  for (const [ingredient, places] of placesOf) {
    slotOf.set(ingredient, places[0]);
    const byComposite = new Map<string, number>();
    for (const place of places) {
      byComposite.set(place.orderable, (byComposite.get(place.orderable) ?? 0) + 1);
    }
    if ([...byComposite.values()].some((n) => n > 1)) {
      ambiguousWithinComposite.set(ingredient, places);
    }
  }
  return { slotOf, placesOf, ambiguousWithinComposite };
}
