import { describe, expect, it } from "vitest";
import burgerJson from "../../data/config/nodegraph/maps/Graph-1-Burger.json";
import { buildIndex } from "../../core/nodeIndex.ts";
import { buildIdIndex } from "../../data/nodeIdTable.ts";
import { nodeAsMapDef } from "../../data/nodeGraphToMapDef.ts";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import { parseQueues } from "../../core/parser.ts";
import { parseNodeCustomers } from "../../core/nodeParser.ts";
import { parseDishCountSequence } from "../design/autoGenerate.ts";
import {
  generateLevel,
  linearShuffleCurve,
  MAX_CUSTOMERS,
  MAX_ROLLED_LANES,
  MAX_TOTAL_DISHES,
  MIN_CUSTOMERS,
  MIN_ROLLED_LANES,
  MIN_TOTAL_DISHES,
  randomDishCountSequence,
  resolveLaneCount,
  seededRng,
} from "./generateLevel.ts";
import type { GenerateContext } from "./generateLevel.ts";

const doc = burgerJson as unknown as NodeGraphMap;
const ix = buildIndex(doc);
const ids = buildIdIndex(doc.idTable);
const projected = nodeAsMapDef(doc, ix);
const ctx: GenerateContext = { ix, ids, projected };

function blank(overrides: Partial<LevelData> = {}): LevelData {
  return {
    id: 1,
    name: "gen",
    weather: "Normal",
    levelTag: "",
    featureUnlock: "",
    serveableSlots: 2,
    shuffleDistance: 0,
    queueString: "%%",
    gridString: new Array(16).fill("").join(","),
    customerString: "",
    ...overrides,
  };
}

describe("randomDishCountSequence", () => {
  it("stays inside the customer and total-dish bounds for every seed", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const counts = randomDishCountSequence(seededRng(seed));
      const total = counts.reduce((n, c) => n + c, 0);
      expect(counts.length).toBeGreaterThanOrEqual(MIN_CUSTOMERS);
      expect(counts.length).toBeLessThanOrEqual(MAX_CUSTOMERS);
      expect(total).toBeGreaterThanOrEqual(MIN_TOTAL_DISHES);
      expect(total).toBeLessThanOrEqual(MAX_TOTAL_DISHES);
      // Nobody is left ordering nothing — that would silently mean "Staff".
      expect(counts.every((c) => c >= 1)).toBe(true);
    }
  });
});

describe("resolveLaneCount", () => {
  it("keeps the lane count a populated queue already has", () => {
    expect(resolveLaneCount(blank({ queueString: "0,1%2%3%4" }), seededRng(7))).toBe(4);
  });

  it("rolls 3..5 for an empty queue", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const lanes = resolveLaneCount(blank(), seededRng(seed));
      expect(lanes).toBeGreaterThanOrEqual(MIN_ROLLED_LANES);
      expect(lanes).toBeLessThanOrEqual(MAX_ROLLED_LANES);
    }
  });

  it("rolls rather than trusting a queue string it cannot read", () => {
    const lanes = resolveLaneCount(blank({ queueString: "0,zz%1" }), seededRng(3));
    expect(lanes).toBeGreaterThanOrEqual(MIN_ROLLED_LANES);
    expect(lanes).toBeLessThanOrEqual(MAX_ROLLED_LANES);
  });
});

describe("linearShuffleCurve", () => {
  it("spans 0..maxY and never goes negative", () => {
    expect(linearShuffleCurve(3).range).toMatchObject({ minY: 0, maxY: 3 });
    expect(linearShuffleCurve(-2).range.maxY).toBe(0);
  });
});

describe("generateLevel", () => {
  it("fills an empty level and pins the seed it used", () => {
    const level = blank();
    const result = generateLevel(level, ctx);

    expect(result.ok).toBe(true);
    expect(level.randomSeed).toBe(result.seed);
    // Every step-2..6 input is written back, so the row can reproduce the run.
    expect(level.ingredientWeights).toBeTruthy();
    expect(level.customerDishesSequence).toBeTruthy();
    expect(level.complexityCurve).toBeTruthy();
    expect(level.shuffleCurve).toBeTruthy();
    expect(parseNodeCustomers(level.customerString).length).toBeGreaterThan(0);
    expect(parseQueues(level.queueString).some((lane) => lane.length > 0)).toBe(true);
  });

  it("is reproducible: the same pinned seed rebuilds byte-identical strings", () => {
    const first = blank();
    const firstResult = generateLevel(first, ctx);
    expect(firstResult.ok).toBe(true);

    const second = blank({ randomSeed: firstResult.seed });
    const secondResult = generateLevel(second, ctx);

    expect(secondResult.ok).toBe(true);
    expect(second.customerString).toBe(first.customerString);
    expect(second.queueString).toBe(first.queueString);
  });

  it("honours a recorded dish sequence instead of rolling a new one", () => {
    const level = blank({ customerDishesSequence: "1;1;2" });
    const result = generateLevel(level, ctx);

    expect(result.ok).toBe(true);
    expect(parseDishCountSequence(level.customerDishesSequence ?? "")).toEqual([1, 1, 2]);
    // Three configured customers; the aligner may append one repair customer,
    // so the count is a floor rather than an equality.
    expect(parseNodeCustomers(level.customerString).length).toBeGreaterThanOrEqual(3);
  });

  it("rerolls the recorded config when asked to", () => {
    const level = blank({ customerDishesSequence: "1;1;1" });
    const result = generateLevel(level, ctx, { rerollConfig: true });

    expect(result.ok).toBe(true);
    const counts = parseDishCountSequence(level.customerDishesSequence ?? "");
    expect(counts.length).toBeGreaterThanOrEqual(MIN_CUSTOMERS);
  });

  it("keeps the level's own lane count", () => {
    const level = blank({ queueString: "0%1%2%3", customerDishesSequence: "1;1" });
    expect(generateLevel(level, ctx).ok).toBe(true);
    expect(parseQueues(level.queueString).length).toBe(4);
  });

  it("says so when it had to lower the shuffle ceiling to win", () => {
    const level = blank();
    const result = generateLevel(level, ctx);

    expect(result.ok).toBe(true);
    // The warning is the pipeline's own, raised against the ceiling this run
    // started from — a caller cannot reconstruct it from a constant, because
    // the starting ceiling comes from the level when it records one.
    const lowered = result.shuffleMaxY < result.startShuffleMaxY;
    expect(result.warnings.some((w) => /Shuffle ceiling lowered/.test(w))).toBe(lowered);
  });

  it("leaves a level untouched when no build can be verified", () => {
    // An empty graph can produce no dish at all, so every attempt fails and the
    // original strings have to survive.
    const emptyDoc: NodeGraphMap = {
      ...structuredClone(doc),
      idTable: { ingredient: [], composite: [], group: [], tool: [], dirty: [] },
      vertices: { ingredient: [], tool: [], group: [], composite: [], dirty: [] },
      edges: { process: [], preservation: [], base: [], topping: [], option: [], leavesDirty: [] },
    };
    const emptyIx = buildIndex(emptyDoc);
    const emptyCtx: GenerateContext = {
      ix: emptyIx,
      ids: buildIdIndex(emptyDoc.idTable),
      projected: nodeAsMapDef(emptyDoc, emptyIx),
    };

    const level = blank({ customerString: "keep-me", queueString: "0%1" });
    const result = generateLevel(level, emptyCtx);

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(level.customerString).toBe("keep-me");
    expect(level.queueString).toBe("0%1");
  });

  it("reports failure rather than reseeding a level whose seed was pinned", () => {
    const emptyDoc: NodeGraphMap = {
      ...structuredClone(doc),
      idTable: { ingredient: [], composite: [], group: [], tool: [], dirty: [] },
      vertices: { ingredient: [], tool: [], group: [], composite: [], dirty: [] },
      edges: { process: [], preservation: [], base: [], topping: [], option: [], leavesDirty: [] },
    };
    const emptyIx = buildIndex(emptyDoc);
    const emptyCtx: GenerateContext = {
      ix: emptyIx,
      ids: buildIdIndex(emptyDoc.idTable),
      projected: nodeAsMapDef(emptyDoc, emptyIx),
    };

    const level = blank({ randomSeed: 4242 });
    const result = generateLevel(level, emptyCtx);

    expect(result.ok).toBe(false);
    expect(result.seed).toBe(4242);
    expect(result.seedsTried).toBe(1);
    expect(level.randomSeed).toBe(4242);
    expect(result.errors.join(" ")).toMatch(/Pinned seed 4242/);
  });
});
