import { describe, expect, it } from "vitest";

import type { GraphIndex } from "../../core/nodeIndex.ts";
import { groupIntoBags } from "./nodeQueueGenerate.ts";

function index(ranges: Array<{ min: number; max: number }>): GraphIndex {
  return { stackRange: ranges } as GraphIndex;
}

const piecesByLeaf = (bags: Array<{ leaf: number; amount: number }>) => {
  const counts = new Map<number, number>();
  for (const bag of bags) counts.set(bag.leaf, (counts.get(bag.leaf) ?? 0) + bag.amount);
  return counts;
};

describe("groupIntoBags", () => {
  it("preserves every physical pickup and only groups consecutive leaves", () => {
    const sequence = [0, 0, 1, 0, 0, 0];
    const bags = groupIntoBags(sequence, index([{ min: 1, max: 5 }, { min: 1, max: 3 }]), () => 0.99, "max");

    expect(bags).toEqual([
      { leaf: 0, amount: 2 },
      { leaf: 1, amount: 1 },
      { leaf: 0, amount: 3 },
    ]);
    expect(piecesByLeaf(bags)).toEqual(new Map([[0, 5], [1, 1]]));
  });

  it("supports min and max fill modes", () => {
    const ix = index([{ min: 1, max: 4 }]);
    expect(groupIntoBags([0, 0, 0, 0], ix, () => 0.5, "min")).toEqual([
      { leaf: 0, amount: 1 },
      { leaf: 0, amount: 1 },
      { leaf: 0, amount: 1 },
      { leaf: 0, amount: 1 },
    ]);
    expect(groupIntoBags([0, 0, 0, 0], ix, () => 0.5, "max")).toEqual([
      { leaf: 0, amount: 4 },
    ]);
  });

  it("uses injected randomness deterministically and stays inside the range", () => {
    const sequence = new Array<number>(12).fill(0);
    const draws = [0, 0.99, 0.4, 0.7];
    const makeRandom = () => {
      let at = 0;
      return () => draws[at++ % draws.length];
    };
    const first = groupIntoBags(sequence, index([{ min: 2, max: 4 }]), makeRandom(), "random");
    const second = groupIntoBags(sequence, index([{ min: 2, max: 4 }]), makeRandom(), "random");

    expect(second).toEqual(first);
    expect(first.reduce((sum, bag) => sum + bag.amount, 0)).toBe(sequence.length);
    expect(first.every((bag) => bag.amount >= 2 && bag.amount <= 4)).toBe(true);
  });

  it("repairs a short tail or emits legal plain leftover slots", () => {
    expect(groupIntoBags(new Array<number>(7).fill(0), index([{ min: 3, max: 5 }]), () => 0.99, "max"))
      .toEqual([{ leaf: 0, amount: 4 }, { leaf: 0, amount: 3 }]);
    expect(groupIntoBags(new Array<number>(7).fill(0), index([{ min: 4, max: 5 }]), () => 0.99, "max"))
      .toEqual([{ leaf: 0, amount: 5 }, { leaf: 0, amount: 1 }, { leaf: 0, amount: 1 }]);
  });

  it("defaults missing ranges to one-piece slots", () => {
    expect(groupIntoBags([0, 0, 0], index([]), () => 0.99, "random")).toEqual([
      { leaf: 0, amount: 1 },
      { leaf: 0, amount: 1 },
      { leaf: 0, amount: 1 },
    ]);
  });
});
