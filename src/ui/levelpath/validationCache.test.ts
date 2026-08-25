import { beforeEach, describe, expect, it } from "vitest";
import { defaultScenario } from "../design/estimateScenario.ts";
import type { EstimateResult } from "../design/estimateDifficulty.ts";
import {
  cachedEstimate,
  cachedStatus,
  cacheEstimate,
  cacheStatus,
  clearValidationCache,
  forgetLevel,
  levelSignature,
  scenarioSignature,
} from "./validationCache.ts";
import type { LevelStatus } from "./validateLevel.ts";

const strings = {
  customerString: "0;0;0;{c0:1}",
  gridString: ",,,",
  queueString: "0,1%2",
};

const estimateOf = (picks: number): EstimateResult =>
  ({
    solvable: true,
    totalPicks: picks,
    servedCount: 1,
    totalCustomers: 1,
    byCid: new Map(),
    perCustomer: [],
    occupancyHistory: [],
    gridCapacity: 16,
    replaySteps: [],
  }) as EstimateResult;

const statusOf = (note: string): LevelStatus => ({ ok: true, errors: [], warnings: [note] });

const DEFAULT_SCENARIO = scenarioSignature(defaultScenario());

beforeEach(() => clearValidationCache());

describe("levelSignature", () => {
  it("changes when any solver-visible string changes", () => {
    const base = levelSignature(strings);
    expect(levelSignature({ ...strings, queueString: "0,1%3" })).not.toBe(base);
    expect(levelSignature({ ...strings, gridString: ",,,," })).not.toBe(base);
    expect(levelSignature({ ...strings, customerString: "" })).not.toBe(base);
  });

  it("changes on the level settings the simulation reads, not just the strings", () => {
    const base = levelSignature(strings);
    expect(levelSignature({ ...strings, weather: "Rainy" })).not.toBe(base);
    expect(levelSignature({ ...strings, outOfSlotPolicy: "park-on-grid" })).not.toBe(base);
    expect(levelSignature({ ...strings, serveableSlots: 3 })).not.toBe(base);
    expect(levelSignature({ ...strings, boosterCharges: [1, 0, 0, 0] })).not.toBe(base);
  });

  it("is stable for the same input", () => {
    expect(levelSignature(strings)).toBe(levelSignature({ ...strings }));
  });
});

describe("scenarioSignature", () => {
  it("treats no scenario and a default one as different keys", () => {
    // "no scenario given" resolves to defaults inside the solver, but the two
    // are separate cache keys — being wrong here would serve a tuned run's
    // answer to an untuned one.
    expect(scenarioSignature(null)).not.toBe(scenarioSignature(defaultScenario()));
  });

  it("changes when a field's value or its toggle changes", () => {
    const base = scenarioSignature(defaultScenario());

    const retuned = defaultScenario();
    retuned.fields.scoreBase.value += 1;
    expect(scenarioSignature(retuned)).not.toBe(base);

    const toggled = defaultScenario();
    toggled.fields.scoreBase.enabled = !toggled.fields.scoreBase.enabled;
    expect(scenarioSignature(toggled)).not.toBe(base);

    const hidden = defaultScenario();
    hidden.hiddenStatus = !hidden.hiddenStatus;
    expect(scenarioSignature(hidden)).not.toBe(base);
  });
});

describe("the shared cache", () => {
  it("hands one view the estimate another view paid for", () => {
    const signature = levelSignature(strings);
    cacheEstimate("burger", 3, signature, DEFAULT_SCENARIO, estimateOf(42));
    expect(cachedEstimate("burger", 3, signature, DEFAULT_SCENARIO)?.totalPicks).toBe(42);
  });

  it("misses once the level has been edited", () => {
    cacheEstimate("burger", 3, levelSignature(strings), DEFAULT_SCENARIO, estimateOf(42));
    const edited = levelSignature({ ...strings, queueString: "9" });
    expect(cachedEstimate("burger", 3, edited, DEFAULT_SCENARIO)).toBeNull();
  });

  it("misses under a different scoring scenario", () => {
    const signature = levelSignature(strings);
    cacheEstimate("burger", 3, signature, DEFAULT_SCENARIO, estimateOf(42));
    expect(cachedEstimate("burger", 3, signature, "other-scenario")).toBeNull();
  });

  it("keeps levels of different maps apart even at the same id", () => {
    const signature = levelSignature(strings);
    cacheEstimate("burger", 1, signature, DEFAULT_SCENARIO, estimateOf(10));
    cacheEstimate("coffee", 1, signature, DEFAULT_SCENARIO, estimateOf(20));
    expect(cachedEstimate("burger", 1, signature, DEFAULT_SCENARIO)?.totalPicks).toBe(10);
    expect(cachedEstimate("coffee", 1, signature, DEFAULT_SCENARIO)?.totalPicks).toBe(20);
  });

  it("keeps a Validate verdict when a fresh estimate lands on the same signature", () => {
    const signature = levelSignature(strings);
    cacheStatus("burger", 1, signature, DEFAULT_SCENARIO, statusOf("checked"));
    cacheEstimate("burger", 1, signature, DEFAULT_SCENARIO, estimateOf(7));
    // Same input, so the audit result did not become wrong — only cheaper.
    expect(cachedStatus("burger", 1, signature, DEFAULT_SCENARIO)?.warnings).toEqual(["checked"]);
    expect(cachedEstimate("burger", 1, signature, DEFAULT_SCENARIO)?.totalPicks).toBe(7);
  });

  it("adopts the estimate a cached status carries", () => {
    const signature = levelSignature(strings);
    cacheStatus("burger", 1, signature, DEFAULT_SCENARIO, {
      ...statusOf("validated"),
      estimate: estimateOf(99),
    });
    expect(cachedEstimate("burger", 1, signature, DEFAULT_SCENARIO)?.totalPicks).toBe(99);
  });

  it("forgets a deleted level, whose id may be reused by a different one", () => {
    const signature = levelSignature(strings);
    cacheEstimate("burger", 5, signature, DEFAULT_SCENARIO, estimateOf(1));
    forgetLevel("burger", 5);
    expect(cachedEstimate("burger", 5, signature, DEFAULT_SCENARIO)).toBeNull();
  });

  it("stays bounded under a batch far larger than its capacity", () => {
    const signature = levelSignature(strings);
    for (let id = 0; id < 900; id++) {
      cacheEstimate("burger", id, signature, DEFAULT_SCENARIO, estimateOf(id));
    }
    // The oldest are evicted; the most recent survive.
    expect(cachedEstimate("burger", 0, signature, DEFAULT_SCENARIO)).toBeNull();
    expect(cachedEstimate("burger", 899, signature, DEFAULT_SCENARIO)?.totalPicks).toBe(899);
  });
});
