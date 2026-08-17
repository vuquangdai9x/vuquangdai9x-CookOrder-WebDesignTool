// Pure "Auto-Generate Queue" logic — kept free of any DOM/UI import so it
// can be unit tested under Vitest's default node environment. The button
// that collects the shuffle-range input and applies the result lives in
// queueSection.ts.
//
// Algorithm (per the design ask):
// 1. Fill row-major (row 0 left-to-right across every lane, then row 1, ...)
//    with raw-ingredient pickups in the customers' true arrival order.
// 2. Shuffle each row's items among that row's lanes (so the same items are
//    still due at roughly the same "time", just not predictably left-to-right).
// 3. If shuffleRange > 0, apply the same limited-displacement shuffle used
//    by the standalone "Shuffle Queue" action, independently within each
//    lane (column) — items only ever jitter forward/back a few slots, never
//    across lanes.

import type { CookedIngredientDef, CookingToolDef, CustomerConfig, Id } from "../../core/types.ts";
import { evaluateCurve } from "./curveEditor.ts";
import type { CurveState } from "./curveEditor.ts";

/**
 * Either a single displacement distance applied uniformly down each lane, or
 * a curve sampled at each slot's normalized position within its own lane
 * (x = position, y = max displacement distance at that position).
 */
export type ShuffleRangeSpec = { kind: "fixed"; value: number } | { kind: "curve"; curve: CurveState };

export interface GenerateQueueOptions {
  customers: CustomerConfig[];
  tools: CookingToolDef[];
  laneCount: number;
  /**
   * Needed for `usageNum`: how many dish slots one landed piece fills. Optional
   * so an older caller still compiles, but omitting it over-queues every
   * multi-use ingredient.
   */
  cookedIngredients?: CookedIngredientDef[];
  /** Limited-displacement shuffle applied within each lane after the row shuffle. `{kind:"fixed",value:0}` = skip. */
  shuffleRange: ShuffleRangeSpec;
  /** Injectable for deterministic tests; defaults to Math.random. */
  random?: () => number;
}

/**
 * Raw id + how many DISH SLOTS one pickup of it ultimately covers.
 *
 * Two multipliers, and missing either over-queues:
 *
 *   amount   — pieces one pickup yields at the tool (1 tomato -> 2 slices).
 *   usageNum — slots ONE landed piece then fills before it is spent. A cheese
 *              sauce with usageNum 3 serves three dishes from a single pickup.
 *
 * So one pickup covers `amount * usageNum` slots. Counting only `amount` is
 * what left a level over-supplied with multi-use items (cheese sauce, chili
 * bowl) that no customer ever consumed.
 */
function rawForCooked(
  tools: CookingToolDef[],
  cooked: CookedIngredientDef[],
  cookedId: Id,
): { rawId: Id; covers: number } {
  const uses = Math.max(1, cooked.find((c) => c.id === cookedId)?.usageNum ?? 1);
  for (const tool of tools) {
    for (const recipe of tool.recipes) {
      if (recipe.out === cookedId) return { rawId: recipe.in, covers: recipe.amount * uses };
    }
  }
  // No recipe: the raw IS its cooked form, so one pickup is one piece.
  return { rawId: cookedId, covers: uses };
}

/**
 * Raw-ingredient pickups in true customer-arrival order: walking every
 * customer's dishes' cookedIds in order, a raw pickup is only emitted the
 * first time its current yield is exhausted — so a multi-piece tool recipe
 * (e.g. one raw tomato -> 2 slices) queues once for both pieces, positioned
 * at the *first* customer that needs a piece from it (later customers whose
 * need is covered by that same pickup's leftover yield don't add another).
 */
export function trueOrderRawSequence(
  customers: CustomerConfig[],
  tools: CookingToolDef[],
  cooked: CookedIngredientDef[] = [],
): Id[] {
  // Slots still covered by an already-queued pickup, keyed by raw id. Tracked
  // per COOKED id as well, because two cooked outputs can share a raw and only
  // the matching one draws down that pickup's remaining uses.
  const remaining = new Map<string, number>();
  const sequence: Id[] = [];
  for (const customer of customers) {
    for (const dish of customer.dishes) {
      for (const cookedId of dish.cookedIds) {
        const { rawId, covers } = rawForCooked(tools, cooked, cookedId);
        const key = `${rawId}:${cookedId}`;
        const left = remaining.get(key) ?? 0;
        if (left > 0) {
          remaining.set(key, left - 1);
        } else {
          sequence.push(rawId);
          remaining.set(key, Math.max(0, covers - 1));
        }
      }
    }
  }
  return sequence;
}

/** In-place Fisher-Yates using an injectable RNG. */
function shuffleInPlace<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Local jitter only, items never cross lanes: each slot swaps with a random
 * slot no further back than `distanceAt(i)`. Shared core for both the fixed-
 * distance and curve-sampled variants below.
 */
function displaceInPlace<T>(lane: T[], distanceAt: (index: number) => number, rand: () => number): void {
  for (let i = lane.length - 1; i > 0; i--) {
    const lowest = Math.max(0, i - distanceAt(i));
    const j = lowest + Math.floor(rand() * (i - lowest + 1));
    [lane[i], lane[j]] = [lane[j], lane[i]];
  }
}

/** Same algorithm as the standalone "Shuffle Queue" action: local jitter only, items never cross lanes. */
export function limitedDisplacementShuffle<T>(lane: T[], distance: number, rand: () => number): void {
  displaceInPlace(lane, () => distance, rand);
}

/**
 * Same local-jitter shuffle, but the max displacement distance at each slot
 * is sampled from `curve` at that slot's normalized position within its own
 * lane (0 = front, 1 = back) — a "shuffle more near the back" curve produces
 * exactly that, per-lane.
 */
export function curveDisplacementShuffle<T>(lane: T[], curve: CurveState, rand: () => number): void {
  const last = lane.length - 1;
  displaceInPlace(
    lane,
    (i) => Math.max(0, Math.round(evaluateCurve(curve, last <= 0 ? 0 : i / last))),
    rand,
  );
}

/** Builds fresh lanes of raw ids (caller tags them into real QueueItems) per the algorithm above. */
export function generateQueueLanes(opts: GenerateQueueOptions): Id[][] {
  const rand = opts.random ?? Math.random;
  const laneCount = Math.max(1, opts.laneCount);
  const sequence = trueOrderRawSequence(opts.customers, opts.tools, opts.cookedIngredients ?? []);

  const lanes: Id[][] = Array.from({ length: laneCount }, () => []);
  sequence.forEach((rawId, i) => lanes[i % laneCount].push(rawId));

  // Shuffle within each row: gather every lane's item at row y (only lanes
  // long enough to have one), shuffle that set, write back to the same slots.
  const maxRows = lanes.reduce((h, l) => Math.max(h, l.length), 0);
  for (let y = 0; y < maxRows; y++) {
    const laneIndices = lanes.map((l, x) => (y < l.length ? x : -1)).filter((x) => x !== -1);
    const values = laneIndices.map((x) => lanes[x][y]);
    shuffleInPlace(values, rand);
    laneIndices.forEach((x, k) => (lanes[x][y] = values[k]));
  }

  if (opts.shuffleRange.kind === "fixed") {
    if (opts.shuffleRange.value > 0) {
      for (const lane of lanes) limitedDisplacementShuffle(lane, opts.shuffleRange.value, rand);
    }
  } else {
    for (const lane of lanes) curveDisplacementShuffle(lane, opts.shuffleRange.curve, rand);
  }

  return lanes;
}
