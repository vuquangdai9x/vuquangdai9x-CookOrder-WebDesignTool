import { describe, expect, it } from "vitest";
import { MAP1_DATA } from "../data/configLoader.ts";
import { toMapDef } from "../data/mapLoader.ts";
import { runBotTrial, runBotTrials } from "./bot.ts";
import { EMPTY_GRID, level, testMap } from "./testFixtures.ts";

const map1 = toMapDef(MAP1_DATA);

/** Small deterministic PRNG so "random" tests are reproducible, not flaky. */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("random bot", () => {
  it("wins a level that's winnable regardless of pick order", () => {
    // 4 lanes, one item each — whichever order random picks them in, all 4
    // eventually get picked; the dish (needs cooked 0 and 1) completes
    // either way. Items 2/3 are harmless decoys (no one needs their output).
    const lvl = level({
      queueString: "0%1%2%3",
      gridString: EMPTY_GRID,
      customerString: "0;0;0;0.1",
    });
    const result = runBotTrial(testMap, lvl, { type: "random", rng: seededRng(42) });
    expect(result.status).toBe("won");
    expect(result.bailedOut).toBe(false);
  });

  it("runBotTrials aggregates wins/losses correctly", () => {
    const lvl = level({ queueString: "0%1%2%3", gridString: EMPTY_GRID, customerString: "0;0;0;0.1" });
    const batch = runBotTrials(testMap, lvl, { type: "random", rng: seededRng(7) }, 5);
    expect(batch.trials).toHaveLength(5);
    expect(batch.wins + batch.losses).toBe(5);
    expect(batch.wins).toBe(5); // this fixture always wins regardless of order
    expect(batch.zeroWins).toBe(false);
  });
});

describe("greedy bot", () => {
  it("wins map 1 level 1_1 deterministically (always picks what's needed)", () => {
    const result1 = runBotTrial(map1, map1.levels[0], { type: "greedy" });
    const result2 = runBotTrial(map1, map1.levels[0], { type: "greedy" });
    expect(result1.status).toBe("won");
    expect(result1.servedCount).toBe(7);
    // No RNG involved — identical every time.
    expect(result2.status).toBe("won");
    expect(result2.servedCount).toBe(result1.servedCount);
    expect(result2.iterations).toBe(result1.iterations);
  });
});

describe("intelligent bot", () => {
  it("wins simple fixtures with the default lookahead", () => {
    const lvl = level({ queueString: "0%1%2%3", gridString: EMPTY_GRID, customerString: "0;0;0;0.1" });
    const result = runBotTrial(testMap, lvl, { type: "intelligent" });
    expect(result.status).toBe("won");
  });

  it("wins map 1 level 1_1", () => {
    const result = runBotTrial(map1, map1.levels[0], { type: "intelligent", lookaheadN: 2 });
    expect(result.status).toBe("won");
    expect(result.servedCount).toBe(7);
  });
});

describe("driver iteration guard", () => {
  // A customer whose first dish needs many units of cooked0 (kept perpetually
  // "needed", so arriving cooked0 is always auto-served away and the grid
  // never overflows) and whose second dish needs cooked99 — an id no raw
  // ingredient in testMap ever produces, so the customer can never finish
  // and the level can never be won. waitTime 0 means an infinite timer, so
  // it never legitimately times out either: the only way this trial ends is
  // the driver's own maxIterations cap.
  const unwinnable = level({
    queueString: Array(200).fill(0).join(","),
    gridString: EMPTY_GRID,
    customerString: `0;0;0;${Array(50).fill(0).join(".")},99`,
  });

  for (const type of ["random", "greedy", "intelligent"] as const) {
    it(`bails out instead of hanging (${type})`, () => {
      const result = runBotTrial(testMap, unwinnable, { type, maxIterations: 15 });
      expect(result.bailedOut).toBe(true);
      expect(result.status).toBe("playing");
      expect(result.iterations).toBe(15);
    });
  }
});
