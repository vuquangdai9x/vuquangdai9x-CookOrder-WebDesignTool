import { describe, expect, it } from "vitest";
import burgerJson from "../../data/config/nodegraph/maps/Graph-1-Burger.json";
import { buildIndex } from "../../core/nodeIndex.ts";
import { parseQueues } from "../../core/parser.ts";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import type { EstimateResult } from "../design/estimateDifficulty.ts";
import { bagsOutsideStackRange, validateLevel } from "./validateLevel.ts";

describe("bagsOutsideStackRange", () => {
  it("flags bags outside the ingredient's stackMin..stackMax and ignores plain slots", () => {
    const doc = structuredClone(burgerJson) as unknown as NodeGraphMap;
    const patty = doc.vertices.ingredient.find((v) => v.name === "patty")!;
    patty.stackMin = 2;
    patty.stackMax = 3;
    const bun = doc.vertices.ingredient.find((v) => v.name === "bun")!;
    bun.stackMin = 1;
    bun.stackMax = 1;
    const ix = buildIndex(doc);
    // id 1 = patty (range 2-3), id 0 = bun (range 1-1)
    const flagged = bagsOutsideStackRange(parseQueues("1:3,1:5,1,0:2%0"), ix);
    expect(flagged.map((f) => `${f.name} ${f.amount} ${f.min}-${f.max}`)).toEqual([
      "Patty 5 2-3",
      "Bun 2 1-1",
    ]);
  });
});

describe("validateLevel", () => {
  it("marks a pruned solvability result as an error, not a warning", () => {
    const level: LevelData = {
      id: 1,
      name: "inconclusive",
      weather: "Normal",
      levelTag: "",
      featureUnlock: "",
      serveableSlots: 2,
      shuffleDistance: 0,
      queueString: "%%",
      gridString: new Array(16).fill("").join(","),
      customerString: "",
    };
    const inconclusive = {
      solvable: false,
      reason: "Search pruned bounded branches; solvability is inconclusive.",
      loseReason: null,
      totalPicks: 0,
      servedCount: 0,
      totalCustomers: 1,
      byCid: new Map(),
      perCustomer: [],
      occupancyHistory: [],
      gridCapacity: 16,
      replaySteps: [],
      peakConcurrentWork: 0,
      timedOutCustomers: [],
      searchLimitReached: true,
    } satisfies EstimateResult;

    const status = validateLevel(level, buildIndex(burgerJson as unknown as NodeGraphMap), {
      skipDeadlock: true,
      solvability: inconclusive,
    });

    expect(status.errors.join(" ")).toContain("Solvability check inconclusive");
    expect(status.warnings.join(" ")).not.toContain("Solvability check inconclusive");
  });
});
