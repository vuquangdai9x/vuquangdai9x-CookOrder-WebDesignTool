import { describe, expect, it } from "vitest";
import burgerJson from "../../data/config/nodegraph/maps/Graph-1-Burger.json";
import { buildIndex } from "../../core/nodeIndex.ts";
import { buildIdIndex } from "../../data/nodeIdTable.ts";
import { nodeAsMapDef } from "../../data/nodeGraphToMapDef.ts";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import { parseGrid, parseQueues } from "../../core/parser.ts";
import { parseNodeCustomers, serializeDish } from "../../core/nodeParser.ts";
import { parseDishCountSequence } from "../design/autoGenerate.ts";
import { BUILT_IN_CURVE_PRESETS } from "../design/curveEditor.ts";
import { getCustomerCatalog, setCustomerCatalog } from "../../data/customerCatalog.ts";
import { parseObstacles } from "./obstacles.ts";
import { validateLevel } from "./validateLevel.ts";

/** A graph with nothing in it — no seed can produce a playable level from this. */
function emptyCtx(): GenerateContext {
  const emptyDoc: NodeGraphMap = {
    ...structuredClone(doc),
    idTable: { ingredient: [], composite: [], group: [], tool: [], dirty: [] },
    vertices: { ingredient: [], tool: [], group: [], composite: [], dirty: [] },
    edges: { process: [], preservation: [], base: [], topping: [], option: [], leavesDirty: [] },
  };
  const emptyIx = buildIndex(emptyDoc);
  return { ix: emptyIx, ids: buildIdIndex(emptyDoc.idTable), projected: nodeAsMapDef(emptyDoc, emptyIx) };
}
import {
  DEFAULT_BOUNDS,
  generateLevel,
  linearShuffleCurve,
  MAX_ROLLED_LANES,
  MIN_ROLLED_LANES,
  normalizeBounds,
  randomComplexityCurve,
  randomDishCountSequence,
  resolveConfig,
  resolveLaneCount,
  seededRng,
} from "./generateLevel.ts";
import type { GenerateContext } from "./generateLevel.ts";

const MIN_CUSTOMERS = DEFAULT_BOUNDS.minCustomers;
const MAX_CUSTOMERS = DEFAULT_BOUNDS.maxCustomers;

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
  it("rolls only the customer count, and puts every one on Auto", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const counts = randomDishCountSequence(seededRng(seed));
      expect(counts.length).toBeGreaterThanOrEqual(MIN_CUSTOMERS);
      expect(counts.length).toBeLessThanOrEqual(MAX_CUSTOMERS);
      // 0 = Auto. The complexity curve is the ONE thing that shapes a level's
      // per-customer load; a second random source behind it fought that shape.
      expect(counts.every((c) => c === 0)).toBe(true);
    }
  });

  it("produces a range of level lengths", () => {
    const lengths = new Set(
      Array.from({ length: 60 }, (_, i) => randomDishCountSequence(seededRng(i + 1)).length),
    );
    expect(lengths.size).toBeGreaterThan(3);
  });
});

describe("configurable bounds", () => {
  it("honours a custom customer range", () => {
    const bounds = { ...DEFAULT_BOUNDS, minCustomers: 2, maxCustomers: 3 };
    for (let seed = 1; seed <= 100; seed++) {
      const counts = randomDishCountSequence(seededRng(seed), bounds);
      expect(counts.length).toBeGreaterThanOrEqual(2);
      expect(counts.length).toBeLessThanOrEqual(3);
    }
  });

  it("lets the min win when a max is left below it mid-edit", () => {
    expect(normalizeBounds({
      ...DEFAULT_BOUNDS,
      minCustomers: 8,
      maxCustomers: 2,
      minTotalDishes: 30,
      maxTotalDishes: 5,
      minComplexityMaxY: 12,
      maxComplexityMaxY: 3,
    })).toEqual({
      minCustomers: 8,
      maxCustomers: 8,
      minTotalDishes: 30,
      maxTotalDishes: 30,
      minComplexityMaxY: 12,
      maxComplexityMaxY: 12,
    });
  });

  it("never rolls a sequence that contradicts itself under inverted bounds", () => {
    const counts = randomDishCountSequence(seededRng(9), {
      ...DEFAULT_BOUNDS,
      minCustomers: 6,
      maxCustomers: 1,
    });
    expect(counts.length).toBe(6);
  });
});

describe("seededRng", () => {
  it("gives neighbouring seeds unrelated first draws", () => {
    // The seed walk and every "one draw decides this field" caller depend on
    // this. A bare LCG fails it: seeds 1..60 all start within a few
    // thousandths of each other.
    const first = Array.from({ length: 60 }, (_, i) => seededRng(i + 1)());
    const buckets = new Set(first.map((v) => Math.floor(v * 16)));
    expect(buckets.size).toBeGreaterThan(8);
  });

  it("is still perfectly reproducible", () => {
    const a = seededRng(1234);
    const b = seededRng(1234);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("randomComplexityCurve", () => {
  it("rolls the ceiling inside the configured range", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const curve = randomComplexityCurve(seededRng(seed));
      expect(curve.range.maxY).toBeGreaterThanOrEqual(DEFAULT_BOUNDS.minComplexityMaxY);
      expect(curve.range.maxY).toBeLessThanOrEqual(DEFAULT_BOUNDS.maxComplexityMaxY);
      expect(curve.range.minY).toBe(1);
    }
  });

  it("honours a narrowed range", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const curve = randomComplexityCurve(seededRng(seed), {
        ...DEFAULT_BOUNDS,
        minComplexityMaxY: 7,
        maxComplexityMaxY: 7,
      });
      expect(curve.range.maxY).toBe(7);
    }
  });

  it("varies both the shape and the height across seeds", () => {
    // Rolling only the shape would give a set of levels that all peak
    // identically, which is the thing the ceiling roll exists to avoid.
    const shapes = new Set<string>();
    const heights = new Set<number>();
    for (let seed = 1; seed <= 60; seed++) {
      const curve = randomComplexityCurve(seededRng(seed));
      shapes.add(JSON.stringify(curve.keyframes));
      heights.add(curve.range.maxY);
    }
    expect(shapes.size).toBeGreaterThan(3);
    expect(heights.size).toBeGreaterThan(3);
  });

  it("only ever picks a shape that ships with the tool", () => {
    const known = new Set(BUILT_IN_CURVE_PRESETS.map((p) => JSON.stringify(p.keyframes)));
    for (let seed = 1; seed <= 60; seed++) {
      expect(known.has(JSON.stringify(randomComplexityCurve(seededRng(seed)).keyframes))).toBe(true);
    }
  });
});

describe("resolveConfig", () => {
  it("rolls the same field a full generate would, for the same seed", () => {
    // The table's per-cell Regenerate goes through this; if it drifted from the
    // pipeline, re-rolling one curve by hand would give a different level than
    // re-rolling the whole thing.
    const level = blank();
    const first = resolveConfig(level, ctx, 1234, true);
    const second = resolveConfig(level, ctx, 1234, true);
    expect(second.dishCounts).toEqual(first.dishCounts);
    expect(second.complexity).toEqual(first.complexity);
    expect([...second.weights.ingredients]).toEqual([...first.weights.ingredients]);
    expect([...second.weights.composites]).toEqual([...first.weights.composites]);
  });

  it("keeps what the level records when not rerolling", () => {
    const level = blank({ customerDishesSequence: "2;2;2" });
    expect(resolveConfig(level, ctx, 1234, false).dishCounts).toEqual([2, 2, 2]);
    expect(resolveConfig(level, ctx, 1234, true).dishCounts).not.toEqual([2, 2, 2]);
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

  it("builds the obstacle budget into the level it produces", () => {
    const level = blank({ obstacleData: "blocked=2;boss=1;hidden=2" });
    const result = generateLevel(level, ctx);
    expect(result.ok).toBe(true);

    const cells = parseGrid(level.gridString);
    expect(cells.filter((c) => c.effects.some((e) => e.effectId === 1))).toHaveLength(2);

    const items = parseQueues(level.queueString).flat();
    expect(items.filter((i) => i.effects.some((e) => e.effectId === 2))).toHaveLength(2);

    // The boss is the finale, and orders far more than a normal customer.
    const customers = parseNodeCustomers(level.customerString);
    const boss = customers[customers.length - 1];
    expect(boss.dishes.length).toBeGreaterThanOrEqual(4);
  });

  it("builds the same level whether or not the catalog has avatar art", () => {
    // Avatar draws come from their own stream, so adding a boss portrait to the
    // catalog must not silently regenerate every level built from that seed.
    const withoutArt = blank({ obstacleData: "boss=1", randomSeed: 4242 });
    generateLevel(withoutArt, ctx);

    const original = getCustomerCatalog();
    setCustomerCatalog([
      { index: 7, id: "b", name: "Boss", desc: "", type: "Boss", baseMap: doc.map.id, mapIndex: 1, fileId: "", icon: "👑" },
    ]);
    const withArt = blank({ obstacleData: "boss=1", randomSeed: 4242 });
    generateLevel(withArt, ctx);
    setCustomerCatalog(original);

    // Compare the ORDERS, which is what a seed promises to reproduce. The
    // pinned avatar is the one thing that is legitimately different.
    const dishesOf = (level: LevelData) =>
      parseNodeCustomers(level.customerString).map((c) => c.dishes.map(serializeDish).join(","));
    expect(dishesOf(withArt)).toEqual(dishesOf(withoutArt));
    expect(withArt.queueString).toBe(withoutArt.queueString);
    expect(withArt.gridString).toBe(withoutArt.gridString);

    // …and the avatar really was pinned, so this is not passing vacuously.
    const boss = parseNodeCustomers(withArt.customerString).at(-1);
    expect(boss?.customerIndex).toBe(7);
  });

  it("gives every colour lock a key, so no lock is unopenable", () => {
    const level = blank({ obstacleData: "lockKey=2" });
    expect(generateLevel(level, ctx).ok).toBe(true);

    const locks = parseGrid(level.gridString)
      .flatMap((c) => c.effects)
      .filter((e) => e.effectId === 4)
      .map((e) => e.params[0])
      .sort();
    const keys = parseQueues(level.queueString)
      .flat()
      .flatMap((i) => i.effects)
      .filter((e) => e.effectId === 3)
      .map((e) => e.params[0])
      .sort();
    expect(keys).toEqual(locks);
  });

  it("rolls a budget for a level that records none, and writes it back", () => {
    const level = blank();
    expect(generateLevel(level, ctx).ok).toBe(true);
    // The rolled budget is recorded, so the level reproduces and the designer
    // can see and edit what the generator chose for them.
    expect(level.obstacleData).toBeDefined();
    const rolled = parseObstacles(level.obstacleData);

    // Scaled to THIS level rather than to a constant.
    const counts = parseDishCountSequence(level.customerDishesSequence ?? "");
    const customers = counts.length;
    const gridCells = doc.map.gridWidth * doc.map.gridHeight;
    expect(rolled.grid.blocked).toBeLessThanOrEqual(Math.min(3, Math.floor(gridCells / 8)));
    expect(rolled.customer.timed).toBeLessThanOrEqual(Math.min(3, Math.floor(customers / 3)));

    // Regenerating from the recorded seed reproduces the same budget.
    const again = blank({ randomSeed: level.randomSeed });
    generateLevel(again, ctx);
    expect(again.obstacleData).toBe(level.obstacleData);
  });

  it("keeps an authored budget exactly as written", () => {
    // "This level has a boss" is a design decision; a roll must never overwrite it.
    const level = blank({ obstacleData: "boss=1" });
    expect(generateLevel(level, ctx).ok).toBe(true);
    expect(level.obstacleData).toBe("boss=1");
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

  it("walks the seed by one until it finds a playable level", () => {
    // A graph that can never produce a level, so every seed fails: the walk is
    // observable in seedsTried and in the seed it gave up on.
    const level = blank();
    const result = generateLevel(level, emptyCtx(), { random: () => 0, seedBudgetMs: 2000 });

    expect(result.ok).toBe(false);
    expect(result.seedsTried).toBeGreaterThan(1);
    // Started at 0 (random: () => 0) and walked upward by one per round.
    expect(result.seed).toBe(result.seedsTried - 1);
  });

  it("stops walking once the time budget is gone, and says so", () => {
    const result = generateLevel(blank(), emptyCtx(), { random: () => 0, seedBudgetMs: 0 });
    expect(result.ok).toBe(false);
    // A budget of 0 lets exactly the first round run, then stops.
    expect(result.seedsTried).toBe(1);
    expect(result.errors.join(" ")).toMatch(/search budget ran out/);
  });

  it("rejects a seed whose level is solvable but deadlocks", () => {
    // The deadlock audit is what makes the seed walk meaningful: a level can
    // pass the estimator and still jam a tool on a different pick order.
    const level = blank();
    const withAudit = generateLevel(level, ctx, { deadlockRuns: 12 });
    expect(withAudit.ok).toBe(true);
    // Whatever it settled on survives an independent audit at the same budget.
    expect(validateLevel(level, ix, { deadlockRuns: 12 }).errors).toEqual([]);
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
