// The whole-level generate pipeline, shared by Level Path's Generate buttons
// and Design mode's Auto Generate.
//
// The nine steps are the designer's spec, in order:
//
//   1. seed        — mint one if the level has none; every later draw uses it
//   2. weights     — random per-ingredient weights when none are recorded
//   3. dish counts — a random customer/dish sequence when none is recorded
//   4. complexity  — a random built-in curve preset when none is recorded
//   5. lanes       — keep the level's current lane count, or roll 3..5
//   6. shuffle     — a linear 0..3 curve when none is recorded
//   7. build       — customers, then the queue that supplies them
//   8. verify      — estimate; on an unwinnable level lower the shuffle
//                    ceiling and rebuild, then try another seed
//   9. report      — warnings and errors, for the Status column
//
// The point of routing everything through the seed is REPRODUCIBILITY: the
// same seed on the same graph must rebuild the same level, which is what makes
// "this level is broken" something a designer can hand to someone else. That is
// also why a level whose seed the designer PINNED is never silently reseeded —
// the pipeline reports failure instead, because quietly returning a different
// level than the seed names breaks exactly the promise the seed makes.
//
// Nothing here touches the DOM, so it is unit testable and a batch run can call
// it in a loop without laying anything out.

import {
  DEFAULT_MAX_DISH_SLOTS,
  parseDishCountSequence,
  serializeDishCountSequence,
} from "../design/autoGenerate.ts";
import {
  BUILT_IN_CURVE_PRESETS,
  defaultCurve,
  parseCurve,
  serializeCurve,
} from "../design/curveEditor.ts";
import type { CurveState } from "../design/curveEditor.ts";
import {
  DEFAULT_INGREDIENT_WEIGHT,
  parseIngredientWeights,
  serializeIngredientWeights,
} from "../design/ingredientWeightEditor.ts";
import { estimateNodeDifficulty } from "../design/nodeEstimateDifficulty.ts";
import type { EstimateResult } from "../design/estimateDifficulty.ts";
import type { EstimateScenario } from "../design/estimateScenario.ts";
import { generateNodeCustomers } from "../nodedesign/nodeGenerate.ts";
import { generateNodeQueueLanes } from "../nodedesign/nodeQueueGenerate.ts";
import { parseQueues, serializeQueues } from "../../core/parser.ts";
import { serializeNodeCustomers } from "../../core/nodeParser.ts";
import type { NodeCustomerConfig } from "../../core/nodeParser.ts";
import type { GraphIndex } from "../../core/nodeIndex.ts";
import type { Id } from "../../core/types.ts";
import type { IdIndex } from "../../data/nodeIdTable.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import { toNodeLevelConfig } from "../../data/nodeLevel.ts";
import type { ProjectedMap } from "../../data/nodeGraphToMapDef.ts";

// ---------- tuning constants ----------

/**
 * How big a freshly rolled level is allowed to be.
 *
 * Editable from the Level Path config bar rather than fixed, because "how long
 * is a level" is a tuning decision that changes per map and per stage of a
 * project — and a designer who has to edit a constant to answer it will instead
 * hand-fix every generated level.
 */
export interface GenerateBounds {
  minCustomers: number;
  maxCustomers: number;
  minTotalDishes: number;
  maxTotalDishes: number;
}

export const DEFAULT_BOUNDS: GenerateBounds = {
  minCustomers: 5,
  maxCustomers: 10,
  minTotalDishes: 10,
  maxTotalDishes: 40,
};

/** Dishes one customer may be handed while the total is distributed. */
const MAX_DISHES_PER_CUSTOMER = 5;

/**
 * Bounds that cannot contradict themselves, whatever the config bar holds.
 *
 * A max below its min is a state the two independent inputs can genuinely be
 * left in mid-edit, and the roll below would loop or produce nonsense — so the
 * max gives way to the min rather than the generator having to defend itself at
 * every use.
 */
export function normalizeBounds(bounds: GenerateBounds = DEFAULT_BOUNDS): GenerateBounds {
  const minCustomers = Math.max(1, Math.round(bounds.minCustomers));
  const maxCustomers = Math.max(minCustomers, Math.round(bounds.maxCustomers));
  const minTotalDishes = Math.max(1, Math.round(bounds.minTotalDishes));
  const maxTotalDishes = Math.max(minTotalDishes, Math.round(bounds.maxTotalDishes));
  return { minCustomers, maxCustomers, minTotalDishes, maxTotalDishes };
}

/** Lane count rolled for a level whose queue is still empty. */
export const MIN_ROLLED_LANES = 3;
export const MAX_ROLLED_LANES = 5;

/** Starting ceiling of a freshly rolled shuffle curve — step 8 walks it down from here. */
export const DEFAULT_SHUFFLE_MAX_Y = 3;

/**
 * Fresh seeds tried before giving up on an unseeded level. Bounded because
 * every attempt costs a full estimator run, and a level that fails four
 * independent seeds at shuffle 0 is not one a fifth seed rescues — it is a
 * graph or grid problem, and saying so is more useful than spinning.
 */
export const MAX_SEED_ATTEMPTS = 4;

// ---------- rng ----------

/** The LCG the estimator and the deadlock audit already use, so "seeded" means one thing tool-wide. */
export function seededRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function mintSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 0xffffffff) >>> 0;
}

const randInt = (rand: () => number, min: number, max: number): number =>
  min + Math.floor(rand() * (max - min + 1));

// ---------- steps 2..6: filling in what the level does not have ----------

/** A weight per ingredient the graph can actually put in a dish, 20..100. */
export function randomIngredientWeights(projected: ProjectedMap, rand: () => number): Map<Id, number> {
  const weights = new Map<Id, number>();
  for (const ingredient of projected.map.cookedIngredients) {
    weights.set(ingredient.id, randInt(rand, 20, DEFAULT_INGREDIENT_WEIGHT));
  }
  return weights;
}

/**
 * A dish-count-per-customer sequence: 5..10 customers sharing 10..40 dishes.
 *
 * Every customer starts at one dish and the remainder is handed out one at a
 * time, so nobody is left with zero — a customer who orders nothing is a Staff
 * customer, a deliberate authoring choice, not something a random split should
 * invent.
 */
export function randomDishCountSequence(rand: () => number, rawBounds?: GenerateBounds): number[] {
  const bounds = normalizeBounds(rawBounds);
  const customers = randInt(rand, bounds.minCustomers, bounds.maxCustomers);
  const lowest = Math.max(bounds.minTotalDishes, customers);
  const highest = Math.max(
    lowest,
    Math.min(bounds.maxTotalDishes, customers * MAX_DISHES_PER_CUSTOMER),
  );
  const total = randInt(rand, lowest, highest);

  const counts = new Array<number>(customers).fill(1);
  let remaining = total - customers;
  let guard = remaining * 8 + 16;
  while (remaining > 0 && guard-- > 0) {
    const at = Math.floor(rand() * customers) % customers;
    if (counts[at] >= MAX_DISHES_PER_CUSTOMER) continue;
    counts[at]++;
    remaining--;
  }
  return counts;
}

/** One of the built-in curve shapes, scaled to the legal dish-complexity range. */
export function randomComplexityCurve(rand: () => number): CurveState {
  const at = Math.floor(rand() * BUILT_IN_CURVE_PRESETS.length) % BUILT_IN_CURVE_PRESETS.length;
  return {
    range: { minX: 0, maxX: 1, minY: 1, maxY: DEFAULT_MAX_DISH_SLOTS },
    keyframes: structuredClone(BUILT_IN_CURVE_PRESETS[at].keyframes),
  };
}

/** The step-6 default: displacement rising linearly from 0 to `maxY` along the lane. */
export function linearShuffleCurve(maxY: number): CurveState {
  return {
    range: { minX: 0, maxX: 1, minY: 0, maxY: Math.max(0, maxY) },
    keyframes: [
      { x: 0, y: 0, tangent: 1 },
      { x: 1, y: 1, tangent: 1 },
    ],
  };
}

/** Lanes the level already has, or a fresh 3..5 when its queue holds nothing. */
export function resolveLaneCount(level: LevelData, rand: () => number): number {
  try {
    const lanes = parseQueues(level.queueString);
    const filled = lanes.reduce((n, lane) => n + lane.length, 0);
    if (lanes.length > 0 && filled > 0) return lanes.length;
  } catch {
    // An unreadable queue string carries no lane count worth honouring.
  }
  return randInt(rand, MIN_ROLLED_LANES, MAX_ROLLED_LANES);
}

// ---------- the pipeline ----------

export interface GenerateContext {
  ix: GraphIndex;
  ids: IdIndex;
  projected: ProjectedMap;
  /** Scoring scenario for the verifying estimate; omitted means every default. */
  scenario?: EstimateScenario;
}

export interface GenerateLevelOptions {
  /**
   * Discard the level's recorded weights/sequence/curves and roll fresh ones.
   * Off by default: re-generating a level a designer has tuned must reuse their
   * inputs, or "Generate" would silently mean "randomise everything again".
   */
  rerollConfig?: boolean;
  /** Overrides Math.random when minting a seed — for deterministic tests. */
  random?: () => number;
  /** Cap on estimator work per attempt; forwarded verbatim. */
  maxIterations?: number;
  /** How big a rolled level may be; omitted means DEFAULT_BOUNDS. */
  bounds?: GenerateBounds;
}

export interface GenerateLevelResult {
  ok: boolean;
  /** Seed the delivered level was built from — already written back onto it. */
  seed: number;
  /** Seeds tried, and total build+estimate rounds across them. */
  seedsTried: number;
  attempts: number;
  /** Shuffle ceiling the accepted build used; -1 when nothing was accepted. */
  shuffleMaxY: number;
  /** Ceiling the run STARTED from — what `shuffleMaxY` has to be read against. */
  startShuffleMaxY: number;
  errors: string[];
  warnings: string[];
  /** The verifying estimate for the accepted build, or the last failing one. */
  estimate: EstimateResult | null;
}

/** One built candidate, before it is known whether it survives verification. */
interface Candidate {
  customerString: string;
  queueString: string;
  warnings: string[];
  estimate: EstimateResult | null;
  ok: boolean;
  failure?: string;
}

interface BuildConfig {
  weights: Map<Id, number>;
  dishCounts: number[];
  complexity: CurveState;
  laneCount: number;
  shuffleCurve: CurveState;
}

function buildCandidate(
  level: LevelData,
  ctx: GenerateContext,
  seed: number,
  config: BuildConfig,
  maxIterations?: number,
): Candidate {
  const warnings: string[] = [];
  // One rng for the whole build, so a change anywhere upstream reshuffles
  // everything downstream — the property a single seed is meant to buy.
  const rand = seededRng(seed);

  // The weight grid speaks DATA ids; the generator speaks dense indices. This
  // is the one place the two numbering systems meet, same as the dialog's.
  const denseWeights = new Map<number, number>();
  for (const [dataId, weight] of config.weights) {
    const dense = ctx.projected.denseOf.get(dataId);
    if (dense !== undefined && weight > 0) denseWeights.set(dense, weight);
  }

  let customers: NodeCustomerConfig[];
  try {
    customers = generateNodeCustomers(ctx.ix, ctx.ids, {
      dishCounts: config.dishCounts,
      weights: denseWeights,
      curve: config.complexity,
      random: rand,
      onWarning: (message) => warnings.push(message),
    });
  } catch (err) {
    return {
      customerString: "",
      queueString: "",
      warnings,
      estimate: null,
      ok: false,
      failure: `Customer generation failed: ${(err as Error).message}`,
    };
  }

  const lanes = generateNodeQueueLanes({
    ix: ctx.ix,
    ids: ctx.ids,
    customers,
    laneCount: config.laneCount,
    shuffleRange: { kind: "curve", curve: config.shuffleCurve },
    random: rand,
  });

  const customerString = serializeNodeCustomers(customers);
  const queueString = serializeQueues(
    lanes.map((lane) => lane.map((id) => ({ kind: "ingredient" as const, id, effects: [] }))),
    [],
  );

  // Verify against exactly the strings that will be saved, not the in-memory
  // objects they came from: a level that only works before serialization is a
  // level that does not work.
  const probe: LevelData = { ...level, customerString, queueString };
  let estimate: EstimateResult | null = null;
  try {
    estimate = estimateNodeDifficulty(ctx.ix, toNodeLevelConfig(probe), {
      ...(ctx.scenario ? { scenario: ctx.scenario } : {}),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
    });
  } catch (err) {
    return {
      customerString,
      queueString,
      warnings,
      estimate: null,
      ok: false,
      failure: `Estimate failed: ${(err as Error).message}`,
    };
  }

  return {
    customerString,
    queueString,
    warnings,
    estimate,
    ok: estimate.solvable,
    ...(estimate.solvable
      ? {}
      : { failure: estimate.reason ?? "the estimator could not win this level." }),
  };
}

/** Everything steps 2..6 decide, for one seed. */
export type RolledConfig = Omit<BuildConfig, "shuffleCurve"> & { baseShuffle: CurveState };

/**
 * Steps 2..6 for one seed. Rolled per seed so a retry rerolls the blanks too.
 *
 * Exported because the table's per-cell "Regenerate" needs exactly one field of
 * this — and it has to be the SAME field the pipeline would have rolled, or
 * regenerating a curve by hand would give a different level than regenerating
 * the whole thing. Calling this with `reroll` is how that stays true instead of
 * being re-implemented per cell.
 */
export function resolveConfig(
  level: LevelData,
  ctx: GenerateContext,
  seed: number,
  reroll: boolean,
  bounds?: GenerateBounds,
): RolledConfig {
  // Config draws come from their own stream, derived from the seed: sharing
  // the build stream would make the config depend on how many draws the build
  // happened to make, which is not something a seed should encode.
  const rand = seededRng(seed ^ 0x9e3779b9);

  const storedWeights = reroll ? null : parseIngredientWeights(level.ingredientWeights ?? "");
  const weights =
    storedWeights && storedWeights.size > 0 ? storedWeights : randomIngredientWeights(ctx.projected, rand);

  const storedCounts = reroll ? [] : parseDishCountSequence(level.customerDishesSequence ?? "");
  const dishCounts = storedCounts.length > 0 ? storedCounts : randomDishCountSequence(rand, bounds);

  const complexity =
    !reroll && level.complexityCurve
      ? parseCurve(level.complexityCurve, defaultCurve(1, DEFAULT_MAX_DISH_SLOTS))
      : randomComplexityCurve(rand);

  const laneCount = resolveLaneCount(level, rand);

  const baseShuffle =
    !reroll && level.shuffleCurve
      ? parseCurve(level.shuffleCurve, linearShuffleCurve(DEFAULT_SHUFFLE_MAX_Y))
      : linearShuffleCurve(DEFAULT_SHUFFLE_MAX_Y);

  return { weights, dishCounts, complexity, laneCount, baseShuffle };
}

/**
 * Runs the pipeline and, on success, writes the result INTO `level`: every
 * generated string plus the seed and the config the build actually used, so
 * the row a designer sees and the data that reproduces it are one thing.
 *
 * A failed run leaves the level's strings untouched, so a generate that cannot
 * find a winnable build never destroys the level that was already there.
 */
export function generateLevel(
  level: LevelData,
  ctx: GenerateContext,
  opts: GenerateLevelOptions = {},
): GenerateLevelResult {
  const pinned = typeof level.randomSeed === "number" && Number.isFinite(level.randomSeed);
  const errors: string[] = [];
  const warnings: string[] = [];

  let seed = pinned ? (level.randomSeed as number) >>> 0 : mintSeed(opts.random);
  let attempts = 0;
  let seedsTried = 0;
  let lastEstimate: EstimateResult | null = null;

  const seedBudget = pinned ? 1 : MAX_SEED_ATTEMPTS;
  for (let seedRound = 0; seedRound < seedBudget; seedRound++) {
    seedsTried++;
    const { weights, dishCounts, complexity, laneCount, baseShuffle } = resolveConfig(
      level,
      ctx,
      seed,
      opts.rerollConfig ?? false,
      opts.bounds,
    );

    // Step 8 walks the ceiling down one whole step at a time, so a level that
    // is unwinnable ONLY because its queue is jumbled becomes winnable without
    // touching anything the designer authored.
    const startMaxY = Math.max(0, Math.round(baseShuffle.range.maxY));
    for (let maxY = startMaxY; maxY >= 0; maxY--) {
      attempts++;
      const shuffleCurve: CurveState = {
        range: { ...baseShuffle.range, maxY },
        keyframes: structuredClone(baseShuffle.keyframes),
      };
      const candidate = buildCandidate(
        level,
        ctx,
        seed,
        { weights, dishCounts, complexity, laneCount, shuffleCurve },
        opts.maxIterations,
      );
      lastEstimate = candidate.estimate ?? lastEstimate;
      for (const message of candidate.warnings) {
        if (!warnings.includes(message)) warnings.push(message);
      }

      if (!candidate.ok) {
        if (maxY === 0 && candidate.failure) errors.push(`Seed ${seed}: ${candidate.failure}`);
        continue;
      }

      // Lowering the ceiling silently would mean a designer's authored shuffle
      // distance quietly becoming a smaller one. Only this loop knows what it
      // started from, so the warning is raised here rather than reconstructed
      // by a caller comparing the result against some constant.
      if (maxY < startMaxY) {
        warnings.push(`Shuffle ceiling lowered from ${startMaxY} to ${maxY} to make the level winnable.`);
      }

      level.randomSeed = seed;
      level.ingredientWeights = serializeIngredientWeights(weights);
      level.customerDishesSequence = serializeDishCountSequence(dishCounts);
      level.complexityCurve = serializeCurve(complexity);
      level.shuffleCurve = serializeCurve(shuffleCurve);
      level.customerString = candidate.customerString;
      level.queueString = candidate.queueString;
      return {
        ok: true,
        seed,
        seedsTried,
        attempts,
        shuffleMaxY: maxY,
        startShuffleMaxY: startMaxY,
        errors: [],
        warnings,
        estimate: candidate.estimate,
      };
    }

    if (pinned) {
      errors.push(
        `Pinned seed ${seed} produced no winnable level down to shuffle 0. Clear the seed to let the generator try others.`,
      );
      break;
    }
    seed = mintSeed(opts.random);
  }

  if (!pinned) {
    errors.push(`No winnable level after ${seedsTried} seed(s) and ${attempts} build(s).`);
  }
  return {
    ok: false,
    seed,
    seedsTried,
    attempts,
    shuffleMaxY: -1,
    startShuffleMaxY: -1,
    errors,
    warnings,
    estimate: lastEstimate,
  };
}
