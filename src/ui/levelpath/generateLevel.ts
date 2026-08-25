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
//   7. obstacles   — a budget scaled to the level's size when none is authored
//   8. build       — customers (specials first, then timers), grid obstacles,
//                    then the queue that supplies them and its slot obstacles
//   9. verify      — estimate, then a deadlock audit on whatever survives it;
//                    on a failure lower the shuffle ceiling, relax the timers,
//                    and on exhausting that ladder walk to the next seed
//  10. report      — warnings and errors, for the Status column
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
  emptyWeightSet,
  parseWeightSet,
  serializeWeightSet,
} from "../design/ingredientWeightEditor.ts";
import type { WeightSet } from "../design/ingredientWeightEditor.ts";
import { estimateNodeDifficulty } from "../design/nodeEstimateDifficulty.ts";
import { validateLevel } from "./validateLevel.ts";
import type { EstimateResult } from "../design/estimateDifficulty.ts";
import type { EstimateScenario } from "../design/estimateScenario.ts";
import { generateNodeCustomers } from "../nodedesign/nodeGenerate.ts";
import { generateNodeQueueLanes } from "../nodedesign/nodeQueueGenerate.ts";
import {
  assignSpecialAvatars,
  assignWaitTimes,
  moveBossesLast,
  planCustomers,
} from "./customerRoles.ts";
import {
  emptyObstacles,
  hasObstacles,
  parseObstacles,
  placeGridObstacles,
  placeQueueObstacles,
  rollObstacles,
  serializeObstacles,
  dropUnkeyedLocks,
} from "./obstacles.ts";
import type { ObstacleConfig } from "./obstacles.ts";
import { parseQueues, serializeQueues } from "../../core/parser.ts";
import { resolveOrder } from "../../core/nodeOrder.ts";
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
  /**
   * Dishes the whole level should end up with.
   *
   * No longer an input to the roll — every customer is generated on AUTO and
   * the complexity curve decides their load, so nothing here dials the total
   * directly any more. It is a GUARDRAIL instead: a build landing outside this
   * range is reported. That is what the number was actually for ("levels of
   * this map should be 10-40 dishes"), and it stays honest about the curve
   * being what produces it.
   */
  minTotalDishes: number;
  maxTotalDishes: number;
  /**
   * The ceiling a rolled COMPLEXITY curve is scaled to, in ingredient slots per
   * customer at the curve's peak.
   *
   * Rolled per level rather than fixed, so a stretch of generated levels varies
   * in how demanding its busiest customers are — with one ceiling every level
   * peaks at the same load, and the curve shape is the only thing that differs.
   */
  minComplexityMaxY: number;
  maxComplexityMaxY: number;
}

export const DEFAULT_BOUNDS: GenerateBounds = {
  minCustomers: 5,
  maxCustomers: 10,
  minTotalDishes: 10,
  maxTotalDishes: 40,
  minComplexityMaxY: 5,
  maxComplexityMaxY: 15,
};

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
  const minComplexityMaxY = Math.max(1, Math.round(bounds.minComplexityMaxY));
  const maxComplexityMaxY = Math.max(minComplexityMaxY, Math.round(bounds.maxComplexityMaxY));
  return {
    minCustomers,
    maxCustomers,
    minTotalDishes,
    maxTotalDishes,
    minComplexityMaxY,
    maxComplexityMaxY,
  };
}

/** Lane count rolled for a level whose queue is still empty. */
export const MIN_ROLLED_LANES = 3;
export const MAX_ROLLED_LANES = 5;

/** Starting ceiling of a freshly rolled shuffle curve — step 8 walks it down from here. */
export const DEFAULT_SHUFFLE_MAX_Y = 3;

/**
 * Seeds walked before giving up on an unseeded level.
 *
 * The search WALKS: seed, seed+1, seed+2. Not fresh random seeds — because the
 * one thing a designer does with a failed generate is look at the seed, and a
 * contiguous run is something they can reason about and resume. (The LCG
 * multiplies its state, so neighbouring seeds produce completely unrelated
 * streams; +1 is a bookkeeping choice, not a similarity one.)
 *
 * Bounded by BOTH a count and a clock. Every seed costs a full estimator run
 * plus, for the ones that get that far, a deadlock audit — so a graph that
 * cannot produce a playable level at all would otherwise spin forever, and
 * "it is still going" is the least useful thing a generator can say.
 */
export const MAX_SEED_ATTEMPTS = 64;
export const DEFAULT_SEED_BUDGET_MS = 20_000;

/** How much extra patience each rung of the retry ladder grants the timers. */
export const TIME_RELAXATION_PER_STEP = 0.35;

// ---------- rng ----------

/**
 * The LCG the estimator and the deadlock audit already use — with the seed
 * AVALANCHED first.
 *
 * That extra step is not decoration. A bare LCG's first output is very nearly
 * linear in its seed: for seeds 1..60 the first value lands inside a band a few
 * thousandths wide, so every one of those seeds picks the same curve preset,
 * the same first ingredient, the same everything-decided-by-one-draw. Two
 * things here depend on that being false — the seed walk (seed, seed+1, seed+2)
 * needs neighbours to be unrelated, and several config fields are decided by a
 * single draw from a freshly seeded stream.
 *
 * The mixer is the standard 32-bit murmur3 finalizer. Same seed still gives the
 * same stream, so reproducibility is untouched.
 */
export function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  s ^= s >>> 16;
  s = Math.imul(s, 0x7feb352d) >>> 0;
  s ^= s >>> 15;
  s = Math.imul(s, 0x846ca68b) >>> 0;
  s ^= s >>> 16;
  s = s >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function mintSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 0xffffffff) >>> 0;
}

const randInt = (rand: () => number, min: number, max: number): number =>
  min + Math.floor(rand() * (max - min + 1));

// ---------- steps 2..6: filling in what the level does not have ----------

/**
 * A weight per ingredient AND per dish type, 20..100 each.
 *
 * Dish types are rolled too, so a generated stretch varies in what customers
 * order and not only in what goes inside it — with every type at 100 the mix is
 * the same on every level, which is exactly the sameness the roll exists to
 * break up.
 */
export function randomIngredientWeights(
  projected: ProjectedMap,
  rand: () => number,
  ctx?: { ix: GraphIndex; ids: IdIndex },
): WeightSet {
  const ingredients = new Map<Id, number>();
  for (const ingredient of projected.map.cookedIngredients) {
    ingredients.set(ingredient.id, randInt(rand, 20, DEFAULT_INGREDIENT_WEIGHT));
  }

  const composites = new Map<Id, number>();
  if (ctx) {
    for (const composite of ctx.ix.orderables) {
      const dataId = ctx.ids.byNode.composite.get(ctx.ix.compositeName[composite]);
      if (dataId !== undefined) composites.set(dataId, randInt(rand, 20, DEFAULT_INGREDIENT_WEIGHT));
    }
  }
  return { ingredients, composites };
}

/**
 * A dish-count-per-customer sequence: 5..10 customers, every one on AUTO.
 *
 * Only the customer count is rolled. Each entry is 0, which means "the
 * complexity curve decides" — and that is the point: the curve is the thing
 * that shapes a level, so a second random source handing out dish counts
 * behind it was fighting the shape the designer drew. A customer's load now
 * comes from exactly one place.
 *
 * The specials are the exception, and they are set later by `planCustomers`:
 * a shipper or boss IS a big order, so its count is the one thing about it
 * that cannot be left to a curve.
 */
export function randomDishCountSequence(rand: () => number, rawBounds?: GenerateBounds): number[] {
  const bounds = normalizeBounds(rawBounds);
  return new Array<number>(randInt(rand, bounds.minCustomers, bounds.maxCustomers)).fill(0);
}

/**
 * One of the built-in curve shapes, scaled to a ceiling rolled from the bounds.
 *
 * Both the SHAPE and the HEIGHT are drawn, because they are independent
 * questions: the shape says when a level gets busy, the ceiling says how busy
 * its busiest moment is. Rolling only the shape gives a set of levels that all
 * peak identically.
 */
export function randomComplexityCurve(rand: () => number, rawBounds?: GenerateBounds): CurveState {
  const bounds = normalizeBounds(rawBounds);
  const at = Math.floor(rand() * BUILT_IN_CURVE_PRESETS.length) % BUILT_IN_CURVE_PRESETS.length;
  const maxY = randInt(rand, bounds.minComplexityMaxY, bounds.maxComplexityMaxY);
  return {
    range: { minX: 0, maxX: 1, minY: 1, maxY },
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
  /**
   * Accept a level on the difficulty estimate alone, without auditing it for
   * deadlocks. Much faster, and wrong for anything a designer will ship.
   */
  skipDeadlock?: boolean;
  /** Random pick orders per deadlock audit. */
  deadlockRuns?: number;
  /**
   * Wall-clock ceiling on the whole seed search. The search walks seeds until
   * one produces a playable level, so without this a graph that cannot produce
   * one at all would spin.
   */
  seedBudgetMs?: number;
  /**
   * Treat a PINNED seed as the search's starting point rather than its only
   * candidate — "Generate until valid".
   *
   * Off by default, and that default is the important half: a pinned seed is a
   * promise that this level reproduces from this number, so the pipeline
   * normally reports failure rather than quietly delivering a level built from
   * a different one. Turning this on is the designer saying "I want a working
   * level more than I want that exact seed", which is a choice only they can
   * make — so it is a button they press, never an inference.
   */
  searchFromSeed?: boolean;
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
  gridString: string;
  warnings: string[];
  estimate: EstimateResult | null;
  ok: boolean;
  failure?: string;
}

interface BuildConfig {
  weights: WeightSet;
  dishCounts: number[];
  complexity: CurveState;
  laneCount: number;
  shuffleCurve: CurveState;
  obstacles: ObstacleConfig;
  /** Size guardrails, for the post-build dish-total check. */
  bounds?: GenerateBounds;
  /** Multiplies every generated patience timer — the retry ladder's handle. */
  timeScale: number;
  /** Skip the deadlock audits — for callers that only want playability. */
  skipDeadlock?: boolean;
  /** Random pick orders per deadlock audit; omitted uses the small default. */
  deadlockRuns?: number;
}

/**
 * Builds one candidate level, in the order the obstacles require:
 *
 *   customers (specials first, then normals, then timers)
 *     -> grid obstacles, which need the customer count and the ordered
 *        ingredients to key their locks to
 *     -> the queue that supplies those customers
 *     -> queue obstacles, which need the queue to exist and the grid's colour
 *        locks to know how many keys to emit
 *
 * The dependencies run one way, which is why the order is fixed rather than a
 * preference: keys cannot be placed before the locks they open are known, and
 * locks cannot be keyed to ingredients before anyone has ordered one.
 */
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
  for (const [dataId, weight] of config.weights.ingredients) {
    const dense = ctx.projected.denseOf.get(dataId);
    if (dense !== undefined && weight > 0) denseWeights.set(dense, weight);
  }
  // Composites have their own data-id space, and no projection map — the graph
  // index resolves them by name, which is the id table's whole purpose.
  const denseComposites = new Map<number, number>();
  for (const [dataId, weight] of config.weights.composites) {
    const name = ctx.ids.byId.composite.get(dataId);
    const dense = name === undefined ? undefined : ctx.ix.compositeByName.get(name);
    if (dense !== undefined) denseComposites.set(dense, weight);
  }

  const plan = planCustomers(config.dishCounts, config.obstacles, rand);
  const sizeBounds = normalizeBounds(config.bounds);

  let customers: NodeCustomerConfig[];
  try {
    customers = generateNodeCustomers(ctx.ix, ctx.ids, {
      dishCounts: plan.dishCounts,
      roles: plan.roles,
      weights: denseWeights,
      ...(denseComposites.size > 0 ? { compositeWeights: denseComposites } : {}),
      curve: config.complexity,
      random: rand,
      onWarning: (message) => warnings.push(message),
    });
  } catch (err) {
    return {
      customerString: "",
      queueString: "",
      gridString: level.gridString,
      warnings,
      estimate: null,
      ok: false,
      failure: `Customer generation failed: ${(err as Error).message}`,
    };
  }

  // The aligner may have appended a repair customer after the boss; put the
  // boss back where the design says it belongs, and realign the roles to the
  // list as it now stands.
  const roles = moveBossesLast(customers, plan.roles);

  // Avatars draw from their OWN stream. Sharing the build stream would make the
  // level's dishes depend on how many catalog rows happen to exist for this
  // map — so adding a boss portrait would silently regenerate every level built
  // from the same seed.
  const avatarRand = seededRng(seed ^ 0x85ebca6b);
  assignSpecialAvatars(customers, roles, ctx.ix.doc.map.id, avatarRand, (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  });

  const slotsOf = (customer: NodeCustomerConfig): number =>
    customer.dishes.reduce((n, dish) => n + resolveOrder(ctx.ix, dish, ctx.ids).order.slots.length, 0);
  assignWaitTimes(customers, config.obstacles, slotsOf, rand, config.timeScale);

  // Grid obstacles are placed against the orders that now exist, so an
  // ingredient lock is keyed to something this level actually uses.
  const usage = new Map<number, number>();
  for (const customer of customers) {
    for (const dish of customer.dishes) {
      for (const slot of resolveOrder(ctx.ix, dish, ctx.ids).order.slots) {
        const dataId = ctx.ids.byNode.ingredient.get(ctx.ix.ingName[slot.ing]);
        if (dataId !== undefined) usage.set(dataId, (usage.get(dataId) ?? 0) + 1);
      }
    }
  }
  // The dish total is an outcome now, not an input — so it is checked rather
  // than dialled. A level outside the configured range is still delivered; the
  // designer is simply told, because the fix is the curve, not another retry.
  const totalDishes = customers.reduce((n, customer) => n + customer.dishes.length, 0);
  if (totalDishes < sizeBounds.minTotalDishes || totalDishes > sizeBounds.maxTotalDishes) {
    warnings.push(
      `${totalDishes} dishes, outside the configured ${sizeBounds.minTotalDishes}-${sizeBounds.maxTotalDishes} — raise or lower the complexity curve to move it.`,
    );
  }

  const grid = placeGridObstacles({
    gridString: level.gridString,
    width: ctx.ix.doc.map.gridWidth,
    height: ctx.ix.doc.map.gridHeight,
    customerCount: customers.filter((c) => c.typeId !== 1).length,
    ingredientUsage: usage,
    config: config.obstacles,
    rand,
  });
  warnings.push(...grid.warnings);

  const lanes = generateNodeQueueLanes({
    ix: ctx.ix,
    ids: ctx.ids,
    customers,
    laneCount: config.laneCount,
    shuffleRange: { kind: "curve", curve: config.shuffleCurve },
    random: rand,
  });

  const customerString = serializeNodeCustomers(customers);
  const plainQueue = serializeQueues(
    lanes.map((lane) => lane.map((id) => ({ kind: "ingredient" as const, id, effects: [] }))),
    [],
  );
  const decorated = placeQueueObstacles({
    queueString: plainQueue,
    config: config.obstacles,
    lockColors: grid.lockColors,
    rand,
  });
  warnings.push(...decorated.warnings);
  const queueString = decorated.queueString;
  // Every colour lock must have its keys, per colour — the grid pass could not
  // know how many keys would fit, so the surplus locks come off here.
  const gridString = dropUnkeyedLocks(grid.gridString, decorated.keyedColors);

  // Verify against exactly the strings that will be saved, not the in-memory
  // objects they came from: a level that only works before serialization is a
  // level that does not work.
  const probe: LevelData = { ...level, customerString, queueString, gridString };
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
      gridString,
      failure: `Estimate failed: ${(err as Error).message}`,
    };
  }

  const built = { customerString, queueString, gridString, warnings, estimate };
  if (!estimate.solvable) {
    return {
      ...built,
      ok: false,
      failure: estimate.reason ?? "the estimator could not win this level.",
    };
  }

  // Deadlock audits run ONLY on a candidate that already passes the estimate.
  // They are far more expensive than the solve, and a candidate that cannot be
  // won is rejected either way — so the cheap test goes first and the expensive
  // one runs about once per generate rather than once per attempt.
  //
  // This is also what makes the seed search meaningful: a level can be solvable
  // and still jam a tool on a different pick order, and searching seeds without
  // checking for that would happily settle on one.
  if (!config.skipDeadlock) {
    // The gate IS the validator, running the same three audits at the same
    // budget — deliberately, not for convenience. A gate that is any weaker
    // than the Validate button emits levels that fail validation the moment a
    // designer presses it, which is exactly the loop this gate exists to close.
    // The estimate is handed over so the expensive solve is not repeated.
    const verdict = validateLevel(probe, ctx.ix, {
      ...(ctx.scenario ? { scenario: ctx.scenario } : {}),
      ...(config.deadlockRuns !== undefined ? { deadlockRuns: config.deadlockRuns } : {}),
      estimate,
    });
    if (verdict.errors.length > 0) {
      return { ...built, ok: false, failure: verdict.errors.join("; ") };
    }
    // Warnings ride along: a grid that fills up under one pick order is a real
    // note for the designer, but it is policy-dependent and not a reason to
    // throw the seed away.
    for (const warning of verdict.warnings) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  }

  return { ...built, ok: true };
}

/** Everything steps 2..6 decide, for one seed. */
export type RolledConfig = Omit<BuildConfig, "shuffleCurve" | "timeScale"> & { baseShuffle: CurveState };

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

  const storedWeights = reroll ? emptyWeightSet() : parseWeightSet(level.ingredientWeights ?? "");
  const rolled =
    storedWeights.ingredients.size > 0
      ? null
      : randomIngredientWeights(ctx.projected, rand, { ix: ctx.ix, ids: ctx.ids });
  // A record from before dish types were weightable has ingredients but no
  // composites; it keeps its ingredients and gets rolled types, rather than
  // being thrown away wholesale.
  const weights: WeightSet = rolled ?? {
    ingredients: storedWeights.ingredients,
    composites:
      storedWeights.composites.size > 0
        ? storedWeights.composites
        : randomIngredientWeights(ctx.projected, rand, { ix: ctx.ix, ids: ctx.ids }).composites,
  };

  const storedCounts = reroll ? [] : parseDishCountSequence(level.customerDishesSequence ?? "");
  const dishCounts = storedCounts.length > 0 ? storedCounts : randomDishCountSequence(rand, bounds);

  const complexity =
    !reroll && level.complexityCurve
      ? parseCurve(level.complexityCurve, defaultCurve(1, DEFAULT_MAX_DISH_SLOTS))
      : randomComplexityCurve(rand, bounds);

  const laneCount = resolveLaneCount(level, rand);

  const baseShuffle =
    !reroll && level.shuffleCurve
      ? parseCurve(level.shuffleCurve, linearShuffleCurve(DEFAULT_SHUFFLE_MAX_Y))
      : linearShuffleCurve(DEFAULT_SHUFFLE_MAX_Y);

  // An AUTHORED budget is a design decision and is kept exactly as written. A
  // level with none gets one rolled to its own size — see rollObstacles for the
  // rule, which scales off this level's own customer and dish counts.
  const stored = reroll ? emptyObstacles() : parseObstacles(level.obstacleData);
  const obstacles = hasObstacles(stored)
    ? stored
    : rollObstacles(
        {
          customers: dishCounts.filter((count) => count !== -1).length,
          dishes: dishCounts.reduce((n, count) => n + Math.max(0, count), 0),
          gridCells: ctx.ix.doc.map.gridWidth * ctx.ix.doc.map.gridHeight,
        },
        rand,
      );

  return { weights, dishCounts, complexity, laneCount, baseShuffle, obstacles };
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

  const startedAt = performance.now();
  const searching = !pinned || opts.searchFromSeed === true;
  const seedBudget = searching ? MAX_SEED_ATTEMPTS : 1;
  const timeBudget = opts.seedBudgetMs ?? DEFAULT_SEED_BUDGET_MS;
  let ranOutOfTime = false;

  for (let seedRound = 0; seedRound < seedBudget; seedRound++) {
    // Checked before the round rather than after, so the budget bounds the time
    // spent STARTING work, not the time already spent.
    if (seedRound > 0 && performance.now() - startedAt > timeBudget) {
      ranOutOfTime = true;
      break;
    }
    // Walked here rather than after the round, so a run that gives up reports
    // the last seed it actually TRIED — reporting the next one would name a
    // seed nobody built, which is exactly the number a designer would go and
    // paste into the field to reproduce the failure.
    if (seedRound > 0) seed = (seed + 1) >>> 0;
    seedsTried++;
    const { weights, dishCounts, complexity, laneCount, baseShuffle, obstacles } = resolveConfig(
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
      // Each rung of the ladder makes the level easier in the two ways the
      // generator controls: less queue shuffling, and more patience on the
      // timers it handed out. Relaxing only the shuffle would leave a level
      // that is unwinnable BECAUSE of its timers stuck failing at every rung.
      const timeScale = 1 + TIME_RELAXATION_PER_STEP * (startMaxY - maxY);
      const candidate = buildCandidate(
        level,
        ctx,
        seed,
        {
          weights,
          dishCounts,
          complexity,
          laneCount,
          shuffleCurve,
          obstacles,
          timeScale,
          ...(opts.bounds ? { bounds: opts.bounds } : {}),
          ...(opts.skipDeadlock !== undefined ? { skipDeadlock: opts.skipDeadlock } : {}),
          ...(opts.deadlockRuns !== undefined ? { deadlockRuns: opts.deadlockRuns } : {}),
        },
        opts.maxIterations,
      );
      lastEstimate = candidate.estimate ?? lastEstimate;
      for (const message of candidate.warnings) {
        if (!warnings.includes(message)) warnings.push(message);
      }

      if (!candidate.ok) {
        // Only the LAST rung is reported: the failures on the way down are the
        // ladder working, not news. Capped so a 64-seed search does not hand
        // back 64 lines of the same sentence.
        if (maxY === 0 && candidate.failure && errors.length < 5) {
          errors.push(`Seed ${seed}: ${candidate.failure}`);
        }
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
      level.ingredientWeights = serializeWeightSet(weights);
      level.customerDishesSequence = serializeDishCountSequence(dishCounts);
      level.complexityCurve = serializeCurve(complexity);
      level.shuffleCurve = serializeCurve(shuffleCurve);
      // A ROLLED budget is written back like every other rolled input, so the
      // level reproduces and the designer can see — and edit — what the
      // generator chose for them. An authored one round-trips unchanged.
      level.obstacleData = serializeObstacles(obstacles);
      level.customerString = candidate.customerString;
      level.queueString = candidate.queueString;
      level.gridString = candidate.gridString;
      if (timeScale > 1 && obstacles.customer.timed > 0) {
        warnings.push(
          `Patience timers relaxed to ${Math.round(timeScale * 100)}% to make the level winnable.`,
        );
      }
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

    if (!searching) {
      errors.push(
        `Pinned seed ${seed} produced no winnable level down to shuffle 0. Clear the seed, or use Generate until valid, to let the generator try others.`,
      );
      break;
    }
  }

  if (searching) {
    errors.push(
      ranOutOfTime
        ? `No playable level after ${seedsTried} seed(s) and ${attempts} build(s) — the ${Math.round(timeBudget / 1000)}s search budget ran out.`
        : `No playable level after ${seedsTried} seed(s) and ${attempts} build(s).`,
    );
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
