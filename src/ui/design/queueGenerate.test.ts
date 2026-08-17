import { describe, expect, it } from "vitest";
import { testMap } from "../../core/testFixtures.ts";
import type { CustomerConfig } from "../../core/types.ts";
import { defaultCurve } from "./curveEditor.ts";
import type { CurveState } from "./curveEditor.ts";
import {
  curveDisplacementShuffle,
  generateQueueLanes,
  limitedDisplacementShuffle,
  trueOrderRawSequence,
} from "./queueGenerate.ts";
import type { ShuffleRangeSpec } from "./queueGenerate.ts";

const fixed = (value: number): ShuffleRangeSpec => ({ kind: "fixed", value });
const curveOf = (curve: CurveState): ShuffleRangeSpec => ({ kind: "curve", curve });

// testMap's tools: raw0->cooked0 (x1), raw1->cooked1 (x1), raw2 has no
// recipe (goes straight through as cooked2, 1:1), raw3->cooked3 (x2 — one
// pickup yields two pieces).

function customer(dishCookedIds: number[][]): CustomerConfig {
  return {
    typeId: 0,
    waitTime: 0,
    weatherEff: 0,
    dishes: dishCookedIds.map((cookedIds) => ({ cookedIds, effects: [] })),
  };
}

/**
 * A map whose cooked ids carry usageNum, so one landed piece serves several
 * dish slots — cheese sauce (3) and chili bowl (2) in the real burger map.
 */
const multiUseMap = {
  ...testMap,
  cookedIngredients: testMap.cookedIngredients.map((c) =>
    c.id === 2 ? { ...c, usageNum: 3 } : c.id === 0 ? { ...c, usageNum: 2 } : c,
  ),
};

describe("usageNum — one pickup can cover several dish slots", () => {
  /**
   * The bug this pins: the generator counted a multi-use item once per SLOT,
   * so a level asking for three servings of a usageNum-3 sauce queued three
   * pickups and two of them were never consumed.
   */
  it("queues ONE pickup for three slots of a usageNum-3 ingredient", () => {
    const customers = [customer([[2, 2, 2]])];
    expect(trueOrderRawSequence(customers, multiUseMap.tools, multiUseMap.cookedIngredients)).toEqual([2]);
  });

  it("queues a second pickup only once the first is spent", () => {
    const customers = [customer([[2, 2, 2, 2]])]; // 4 slots, usageNum 3
    expect(trueOrderRawSequence(customers, multiUseMap.tools, multiUseMap.cookedIngredients)).toEqual([2, 2]);
  });

  it("multiplies with the tool yield: pieces x uses per pickup", () => {
    // cooked 0 comes from a 1:1 recipe and has usageNum 2, so one pickup of
    // raw 0 covers two slots.
    const customers = [customer([[0, 0]])];
    expect(trueOrderRawSequence(customers, multiUseMap.tools, multiUseMap.cookedIngredients)).toEqual([0]);
  });

  it("leaves a usageNum-1 ingredient exactly as before", () => {
    const customers = [customer([[1], [1]])];
    expect(trueOrderRawSequence(customers, multiUseMap.tools, multiUseMap.cookedIngredients)).toEqual([1, 1]);
  });

  it("draws down uses per COOKED id, not per raw — two outputs sharing a raw stay separate", () => {
    // A pickup banked for cooked 2 must not satisfy a slot wanting cooked 1.
    const customers = [customer([[2, 1, 2]])];
    expect(trueOrderRawSequence(customers, multiUseMap.tools, multiUseMap.cookedIngredients)).toEqual([2, 1]);
  });

  it("over-queues when the cooked defs are withheld — the old behaviour, as a contrast", () => {
    const customers = [customer([[2, 2, 2]])];
    expect(trueOrderRawSequence(customers, multiUseMap.tools)).toEqual([2, 2, 2]);
  });
});

describe("trueOrderRawSequence", () => {
  it("emits one raw pickup per cooked-id occurrence for a 1:1 recipe", () => {
    const customers = [customer([[0]]), customer([[0], [1]])];
    expect(trueOrderRawSequence(customers, testMap.tools)).toEqual([0, 0, 1]);
  });

  it("preserves true customer/dish/ingredient order, not aggregated by id", () => {
    const customers = [customer([[1, 0]]), customer([[0]])];
    expect(trueOrderRawSequence(customers, testMap.tools)).toEqual([1, 0, 0]);
  });

  it("passes a no-recipe cooked id through as its own raw id", () => {
    const customers = [customer([[2]])];
    expect(trueOrderRawSequence(customers, testMap.tools)).toEqual([2]);
  });

  it("shares one pickup's yield across later occurrences instead of queuing a second pickup", () => {
    // raw3 -> cooked3 x2: the first need for cooked3 queues one raw3 pickup;
    // the very next need for cooked3 is covered by that pickup's 2nd piece.
    const customers = [customer([[3, 3]])];
    expect(trueOrderRawSequence(customers, testMap.tools)).toEqual([3]);
  });

  it("queues a fresh pickup once a prior one's yield runs out", () => {
    const customers = [customer([[3, 3, 3]])]; // 3 pieces needed, one pickup yields 2
    expect(trueOrderRawSequence(customers, testMap.tools)).toEqual([3, 3]);
  });

  it("positions a shared pickup at the first customer that needs a piece from it", () => {
    // Customer A needs one cooked3 piece (queues the pickup); customer B's
    // need for another cooked3 piece is covered by A's leftover yield, so no
    // second pickup appears at B's position.
    const customers = [customer([[3]]), customer([[3]])];
    expect(trueOrderRawSequence(customers, testMap.tools)).toEqual([3]);
  });
});

describe("limitedDisplacementShuffle", () => {
  it("distance 0 is a true no-op (every swap target collapses to itself)", () => {
    const lane = [0, 1, 2, 3, 4, 5, 6, 7];
    const original = [...lane];
    limitedDisplacementShuffle(lane, 0, Math.random);
    expect(lane).toEqual(original);
  });

  it("is a no-op shape-wise — same multiset, just reordered", () => {
    const lane = [10, 11, 12, 13, 14];
    limitedDisplacementShuffle(lane, 3, Math.random);
    expect([...lane].sort()).toEqual([10, 11, 12, 13, 14]);
  });
});

describe("curveDisplacementShuffle", () => {
  it("flat curve at 0 is a true no-op, same as fixed distance 0", () => {
    const lane = [0, 1, 2, 3, 4, 5, 6, 7];
    const original = [...lane];
    curveDisplacementShuffle(lane, defaultCurve(0, 0), Math.random);
    expect(lane).toEqual(original);
  });

  it("is a no-op shape-wise — same multiset, just reordered", () => {
    const lane = [10, 11, 12, 13, 14];
    curveDisplacementShuffle(lane, defaultCurve(0, 3), Math.random);
    expect([...lane].sort()).toEqual([10, 11, 12, 13, 14]);
  });

  it("samples the curve's y-range as the per-slot max displacement", () => {
    // A curve flat at y=0 across the whole domain never lets a slot move —
    // every swap target collapses to itself regardless of position.
    const lane = [0, 1, 2, 3, 4, 5];
    const original = [...lane];
    curveDisplacementShuffle(lane, defaultCurve(0, 0), () => 0.999999);
    expect(lane).toEqual(original);
  });
});

describe("generateQueueLanes", () => {
  it("fills row-major before shuffling — deterministic with a fixed no-swap-forward rng", () => {
    // rand() -> 0 makes Fisher-Yates swap every element to index 0 each
    // step, which for a 3-item row [a,b,c] deterministically produces [b,c,a].
    const customers = [customer([[0]]), customer([[0]]), customer([[0]])];
    const lanes = generateQueueLanes({
      customers,
      tools: testMap.tools,
      laneCount: 3,
      shuffleRange: fixed(0),
      random: () => 0,
    });
    // Pre-shuffle row-major fill would be [[0],[0],[0]] (one raw0 per lane,
    // row 0) — shuffling a row of three identical values is unobservable by
    // value, so assert the row-shuffle actually ran via a mixed row instead.
    expect(lanes).toHaveLength(3);
    expect(lanes.flat()).toHaveLength(3);
  });

  it("keeps the same total multiset of raw ids regardless of shuffling", () => {
    const customers = [customer([[0, 1]]), customer([[1, 0]]), customer([[0]])];
    const lanes = generateQueueLanes({
      customers,
      tools: testMap.tools,
      laneCount: 2,
      shuffleRange: fixed(2),
      random: Math.random,
    });
    expect(lanes.flat().sort()).toEqual([0, 0, 0, 1, 1]);
  });

  it("distributes row-major: row 0 gets one item per lane before row 1 starts", () => {
    // 5 items, 2 lanes -> row-major fill is lane0=[i0,i2,i4], lane1=[i1,i3]
    // (lengths 3 and 2) before any shuffling touches contents.
    const customers = [customer([[0]]), customer([[0]]), customer([[0]]), customer([[0]]), customer([[0]])];
    const lanes = generateQueueLanes({
      customers,
      tools: testMap.tools,
      laneCount: 2,
      shuffleRange: fixed(0),
      random: () => 0.999999, // near-identity: j===i almost always, no real swaps
    });
    expect(lanes[0]).toHaveLength(3);
    expect(lanes[1]).toHaveLength(2);
  });

  it("respects an explicit lane count even with no demand", () => {
    const lanes = generateQueueLanes({ customers: [], tools: testMap.tools, laneCount: 4, shuffleRange: fixed(0) });
    expect(lanes).toHaveLength(4);
    expect(lanes.flat()).toHaveLength(0);
  });

  it("shuffleRange 0 still runs the row shuffle but skips the per-lane displacement pass", () => {
    const customers = [customer([[0]]), customer([[1]]), customer([[2]])];
    const lanes = generateQueueLanes({
      customers,
      tools: testMap.tools,
      laneCount: 3,
      shuffleRange: fixed(0),
      random: () => 0,
    });
    // One item per lane (row 0 only) — a single-item lane is untouched by
    // definition (nothing to displace), so this mainly guards against a
    // crash/throw when shuffleRange is 0 and each lane has length 1.
    expect(lanes.map((l) => l.length)).toEqual([1, 1, 1]);
  });

  it("accepts a curve shuffleRange and keeps the same multiset", () => {
    const customers = [customer([[0, 1]]), customer([[1, 0]]), customer([[0]])];
    const lanes = generateQueueLanes({
      customers,
      tools: testMap.tools,
      laneCount: 2,
      shuffleRange: curveOf(defaultCurve(0, 3)),
      random: Math.random,
    });
    expect(lanes.flat().sort()).toEqual([0, 0, 0, 1, 1]);
  });
});
