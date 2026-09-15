// Queue auto-generation on the node graph.
//
// The legacy generator maps one dish item to ONE raw pickup (`recipe.in`),
// which is exactly the assumption slot points break: a cool coffee needs ground
// coffee AND a cup, and a queue holding only coffee makes the level
// unwinnable — quietly, since nothing is missing until the machine sits
// half-filled forever.
//
// So this walks the graph BACKWARDS from each ordered item, emitting a pickup
// for every input of every step along the way. That is the same inversion
// `nodeGenerate.ts` uses for customers: work from the structure rather than
// from a flat list, and the result is correct by construction instead of by
// post-hoc repair.
//
// The shuffles are imported from the legacy module rather than reimplemented —
// a designer's "shuffle range 3" must mean the same thing in both modes.

import { curveDisplacementShuffle, limitedDisplacementShuffle } from "../design/queueGenerate.ts";
import type { ShuffleRangeSpec } from "../design/queueGenerate.ts";
import type { GraphIndex } from "../../core/nodeIndex.ts";
import type { NodeCustomerConfig, DishNode } from "../../core/nodeParser.ts";
import type { IdIndex } from "../../data/nodeIdTable.ts";
import type { RawDemand } from "../../data/recipeDemand.ts";

export interface NodeQueueOptions {
  ix: GraphIndex;
  ids: IdIndex;
  customers: NodeCustomerConfig[];
  laneCount: number;
  shuffleRange: ShuffleRangeSpec;
  /** How Auto Generate chooses a target size inside each ingredient's stack range. */
  bagFill?: BagFillMode;
  /** Injectable for deterministic tests; defaults to Math.random. */
  random?: () => number;
}

export type BagFillMode = "min" | "random" | "max";

/** One generated queue slot. `amount` is physical pieces, not recipe uses. */
export interface GeneratedQueueSlot {
  id: number;
  amount: number;
}

interface DenseBag {
  leaf: number;
  amount: number;
}

/**
 * Every servable ingredient a customer list asks for, in arrival order, as
 * DENSE indices.
 *
 * A dish carries DATA ids — the whole point of the id table — so this is the
 * one place the two numbering systems meet. An id naming nothing is skipped
 * rather than queued as a bogus pickup.
 */
function orderedItems(ix: GraphIndex, ids: IdIndex, customers: NodeCustomerConfig[]): number[] {
  const out: number[] = [];
  const walk = (node: DishNode): void => {
    for (const member of node.members) {
      if (member.kind !== "ingredient") {
        walk(member);
        continue;
      }
      const name = ids.byId.ingredient.get(member.id);
      const dense = name === undefined ? undefined : ix.ingByName.get(name);
      if (dense !== undefined) out.push(dense);
    }
  };
  for (const customer of customers) for (const dish of customer.dishes) walk(dish.root);
  return out;
}

/**
 * The pickups one dish slot needs, and how many slots each ultimately covers.
 *
 * Walks back through `producerOf` to the pickupable leaves. A multi-input step
 * contributes EVERY input, which is the whole point — and each is followed to
 * its own leaf, so a cup that is itself pickupable stops there while ground
 * coffee keeps going back to the bean.
 *
 * `covers` is the process-output multiplier kept per leaf: pieces one pickup
 * yields at the tool (1 tomato -> 2 slices). Shipped graphs are 1-out; this
 * remains for custom graphs.
 */
function leavesFor(ix: GraphIndex, ing: number): { leaf: number; covers: number }[] {
  const out: { leaf: number; covers: number }[] = [];

  const walk = (node: number, yieldSoFar: number, seen: Set<number>): void => {
    // A cycle would otherwise recurse forever; INV-ACYCLIC reports it, and a
    // generator run must not be the thing that hangs the editor.
    if (seen.has(node)) return;
    const step = ix.producerOf[node];
    if (!step || ix.pickupable[node]) {
      out.push({ leaf: node, covers: Math.max(1, yieldSoFar) });
      return;
    }
    const next = new Set(seen).add(node);
    for (const input of step.inputs) {
      walk(input.ing, yieldSoFar * Math.max(1, step.amount), next);
    }
  };

  walk(ing, 1, new Set());
  return out;
}

/**
 * Recipe Pieces demand keyed by pickupable DATA id. Unlike MapDef demand,
 * this follows every input of every producer step, so a coffee output counts
 * both its coffee/bean chain and its cup input.
 */
export function nodeDemandByRaw(
  ix: GraphIndex,
  ids: IdIndex,
  customers: NodeCustomerConfig[],
): Map<number, RawDemand> {
  const demand = new Map<number, RawDemand>();
  for (const item of orderedItems(ix, ids, customers)) {
    for (const { leaf, covers } of leavesFor(ix, item)) {
      const name = ix.ingName[leaf];
      const dataId = name === undefined ? undefined : ids.byNode.ingredient.get(name);
      if (dataId === undefined) continue;
      const existing = demand.get(dataId);
      if (existing) {
        existing.need++;
        // A valid graph normally reaches a leaf with one stable yield. Keep
        // the smaller capacity if invalid paths disagree, so the warning is
        // conservative rather than hiding a shortage.
        existing.amount = Math.min(existing.amount, Math.max(1, covers));
      } else {
        demand.set(dataId, { need: 1, amount: Math.max(1, covers) });
      }
    }
  }
  return demand;
}

/**
 * Pickups in true customer-arrival order.
 *
 * A pickup is emitted only when its running yield is exhausted, so a chopping
 * board that drops two slices queues once for both — positioned at the FIRST
 * customer needing a piece. Tracked per (leaf, ordered item) pair because two
 * dish items can share a leaf while drawing on different yields.
 */
export function nodePickupSequence(
  ix: GraphIndex,
  ids: IdIndex,
  customers: NodeCustomerConfig[],
): number[] {
  const remaining = new Map<string, number>();
  const sequence: number[] = [];

  for (const item of orderedItems(ix, ids, customers)) {
    for (const { leaf, covers } of leavesFor(ix, item)) {
      const key = `${leaf}:${item}`;
      const left = remaining.get(key) ?? 0;
      if (left > 0) {
        remaining.set(key, left - 1);
        continue;
      }
      sequence.push(leaf);
      remaining.set(key, Math.max(0, covers - 1));
    }
  }
  return sequence;
}

/**
 * Collapse consecutive pickup pieces into bags before they are dealt or
 * shuffled. A random target is chosen per bag, so a seeded generator remains
 * deterministic while still producing varied stack sizes.
 *
 * A final tail below stackMin is folded into the preceding bag whenever it
 * still fits under stackMax. If it cannot fit, the tail remains a legal small
 * leftover slot, as required by the authoring rule.
 */
export function groupIntoBags(
  sequence: number[],
  ix: GraphIndex,
  random: () => number = Math.random,
  mode: BagFillMode = "random",
): DenseBag[] {
  const bags: DenseBag[] = [];
  let at = 0;

  while (at < sequence.length) {
    const leaf = sequence[at];
    let end = at + 1;
    while (end < sequence.length && sequence[end] === leaf) end++;

    const available = end - at;
    const range = ix.stackRange[leaf] ?? { min: 1, max: 1 };
    const min = Math.max(1, Math.floor(range.min) || 1);
    const max = Math.max(min, Math.floor(range.max) || min);
    const run: DenseBag[] = [];
    let remaining = available;

    while (remaining > 0) {
      const target =
        mode === "min"
          ? min
          : mode === "max"
            ? max
            : min + Math.floor(Math.min(0.9999999999999999, Math.max(0, random())) * (max - min + 1));
      const amount = Math.min(remaining, target);
      run.push({ leaf, amount });
      remaining -= amount;
    }

    const tail = run.at(-1);
    const previous = run.at(-2);
    if (tail && previous && tail.amount < min) {
      if (previous.amount + tail.amount <= max) {
        previous.amount += tail.amount;
        run.pop();
      } else {
        const needed = min - tail.amount;
        if (previous.amount - needed >= min) {
          previous.amount -= needed;
          tail.amount += needed;
        } else if (tail.amount > 1) {
          // No legal rebalance exists for this remainder. Plain one-piece
          // slots are the legal leftover representation and do not produce an
          // out-of-range bag warning.
          run.splice(run.length - 1, 1, ...Array.from({ length: tail.amount }, () => ({ leaf, amount: 1 })));
        }
      }
    } else if (tail && tail.amount > 1 && tail.amount < min) {
      run.splice(run.length - 1, 1, ...Array.from({ length: tail.amount }, () => ({ leaf, amount: 1 })));
    }

    bags.push(...run);
    at = end;
  }

  return bags;
}

/**
 * Group the sequence into bags, deal those slots across lanes, then jitter
 * whole slots. Returns DATA ids plus physical piece amounts.
 *
 * Round-robin rather than contiguous blocks: dealing lane by lane would put
 * every early customer's ingredients in lane 0, so the player would drain one
 * column while the others sat untouched.
 */
export function generateNodeQueueLanes(opts: NodeQueueOptions): GeneratedQueueSlot[][] {
  const rand = opts.random ?? Math.random;
  const laneCount = Math.max(1, opts.laneCount);
  const lanes: GeneratedQueueSlot[][] = Array.from({ length: laneCount }, () => []);

  const sequence = nodePickupSequence(opts.ix, opts.ids, opts.customers);
  const bags = groupIntoBags(sequence, opts.ix, rand, opts.bagFill ?? "random");
  bags.forEach((bag, at) => {
    const dataId = opts.ids.byNode.ingredient.get(opts.ix.ingName[bag.leaf]);
    // An ingredient with no id cannot appear in a queue string at all; dropping
    // it is right, and WARN-UNTABLED-NODE already names it in Map Process.
    if (dataId !== undefined) lanes[at % laneCount].push({ id: dataId, amount: bag.amount });
  });

  for (const lane of lanes) {
    if (opts.shuffleRange.kind === "fixed") {
      if (opts.shuffleRange.value > 0) limitedDisplacementShuffle(lane, opts.shuffleRange.value, rand);
    } else {
      curveDisplacementShuffle(lane, opts.shuffleRange.curve, rand);
    }
  }
  return lanes;
}
