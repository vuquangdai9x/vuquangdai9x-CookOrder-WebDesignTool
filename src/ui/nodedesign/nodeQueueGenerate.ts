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

export interface NodeQueueOptions {
  ix: GraphIndex;
  ids: IdIndex;
  customers: NodeCustomerConfig[];
  laneCount: number;
  shuffleRange: ShuffleRangeSpec;
  /** Injectable for deterministic tests; defaults to Math.random. */
  random?: () => number;
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
 * `covers` is the legacy pair of multipliers, kept per leaf:
 *   amount   — pieces one pickup yields at the tool (1 tomato -> 2 slices)
 *   usageNum — dish slots one landed piece then fills
 * Missing either over-queues, which is the bug this file's ancestor had.
 */
function leavesFor(ix: GraphIndex, ing: number): { leaf: number; covers: number }[] {
  const uses = Math.max(1, ix.usageNum[ing] ?? 1);
  const out: { leaf: number; covers: number }[] = [];

  const walk = (node: number, yieldSoFar: number, seen: Set<number>): void => {
    // A cycle would otherwise recurse forever; INV-ACYCLIC reports it, and a
    // generator run must not be the thing that hangs the editor.
    if (seen.has(node)) return;
    const step = ix.producerOf[node];
    if (!step || ix.pickupable[node]) {
      out.push({ leaf: node, covers: Math.max(1, yieldSoFar) * uses });
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
 * Deal the sequence across lanes and jitter it, returning DATA ids.
 *
 * Round-robin rather than contiguous blocks: dealing lane by lane would put
 * every early customer's ingredients in lane 0, so the player would drain one
 * column while the others sat untouched.
 */
export function generateNodeQueueLanes(opts: NodeQueueOptions): number[][] {
  const rand = opts.random ?? Math.random;
  const laneCount = Math.max(1, opts.laneCount);
  const lanes: number[][] = Array.from({ length: laneCount }, () => []);

  const sequence = nodePickupSequence(opts.ix, opts.ids, opts.customers);
  sequence.forEach((ing, at) => {
    const dataId = opts.ids.byNode.ingredient.get(opts.ix.ingName[ing]);
    // An ingredient with no id cannot appear in a queue string at all; dropping
    // it is right, and WARN-UNTABLED-NODE already names it in Map Process.
    if (dataId !== undefined) lanes[at % laneCount].push(dataId);
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
