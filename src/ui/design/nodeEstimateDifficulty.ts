// Graph-native difficulty estimator. Node Design, Play, and replay must use the
// same engine; a projected legacy MapDef cannot preserve multi-input slot state.

import { CUSTOMER_STAFF } from "../../core/effects.ts";
import type { GraphIndex } from "../../core/nodeIndex.ts";
import { NodeSimulation } from "../../core/nodeSim.ts";
import type { NodeCustomerState, NodeLevelConfig } from "../../core/nodeSim.ts";
import type { PackingMode, QueueItem, ToolProcessBehavior } from "../../core/types.ts";
import { queueItemAmount } from "../../core/parser.ts";
import { orderIdIndex } from "../../core/nodeOrder.ts";
import { supplyByRaw } from "../../data/recipeDemand.ts";
import { nodeDemandByRaw } from "../nodedesign/nodeQueueGenerate.ts";
import { cidOf } from "./changeTracking.ts";
import { resolveScenario } from "./estimateScenario.ts";
import type { ResolvedScenario, ScenarioFieldKey } from "./estimateScenario.ts";
import type {
  CustomerCost,
  EstimateOptions,
  EstimateResult,
  EstimateSlot,
  OccupancySample,
  EstimateReplayStep,
  EstimateFailureKnowledge,
  EstimateFailureCustomer,
  EstimatePickingStrategyName,
  EstimateProgress,
  EstimateStrategyName,
} from "./estimateDifficulty.ts";

// Every former tuning constant now lives in estimateScenario.ts, where the
// pre-run Scoring Scenario modal can edit or disable it. resolveScenario()
// with no argument yields exactly the values that used to be hard-coded here.

interface DemandClaim {
  units: number;
  priority: number;
  customerIndex: number;
  target: number;
  base: boolean;
  multiInput: boolean;
  /** The claim is placeable right now — a base, or a slot whose gate is open. */
  ready: boolean;
}

interface EstimateBehavior {
  packingMode: PackingMode;
  toolProcessBehavior: ToolProcessBehavior;
}

interface DemandUnit {
  target: number;
  customerIndex: number;
  priority: number;
  base: boolean;
  multiInput: boolean;
  ready: boolean;
  requirements: Map<number, number>;
}

interface PickupValue {
  score: number;
  customerIndex: number;
  /**
   * The strongest claim on this ingredient is placeable right now, so taking
   * it is the best kind of pick rather than work parked ahead of its base.
   * Drives CustomerCost.bestPicks and the customer card's colour cue.
   */
  ready: boolean;
}

type WorkWaitStrategy = "interval" | "wait-all";

interface LearnedSearchStep {
  lane: number;
  /** Total simulated wait before this pick, including mandatory and deliberate waits. */
  waitBeforePickSeconds?: number;
}

const CUSTOMER_PREVIEW_COUNT = 3;

/** Return the closest pick to an event time; an exact midpoint favors the earlier pick. */
export function nearestPickIndex(pickTimes: readonly number[], eventTime: number): number {
  if (pickTimes.length === 0) return -1;
  let nearest = 0;
  let nearestDistance = Math.abs(pickTimes[0] - eventTime);
  for (let index = 1; index < pickTimes.length; index++) {
    const distance = Math.abs(pickTimes[index] - eventTime);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/** Exact Recipe Pieces have/need shortages, matching Design mode's foldout. */
function supplyShortages(ix: GraphIndex, level: NodeLevelConfig): SupplyShortage[] {
  const ids = orderIdIndex(ix);
  const demand = nodeDemandByRaw(ix, ids, level.customers);
  const supply = supplyByRaw(level.queues);
  const shortages: SupplyShortage[] = [];
  for (const [dataId, { need, amount }] of demand) {
    const have = (supply.get(dataId) ?? 0) * Math.max(1, amount);
    if (have >= need) continue;
    shortages.push({
      ingredient: ids.byId.ingredient.get(dataId) ?? `ingredient ${dataId}`,
      have,
      need,
    });
  }
  return shortages.sort((a, b) => a.ingredient.localeCompare(b.ingredient));
}

function seededRng(seed = 0x5eed): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const isOrdering = (customer: NodeCustomerState): boolean =>
  customer.config.typeId !== CUSTOMER_STAFF;

/**
 * Let the simulation re-evaluate pending customers against the shared
 * two-customer / 6-unit order-zone rules.
 */
function syncCustomerAdmission(sim: NodeSimulation): void {
  if (sim.status === "playing" && sim.pending.length > 0) sim.tick(0);
}

function pickableLanes(sim: NodeSimulation): number[] {
  const lanes: number[] = [];
  for (let x = 0; x < sim.columnCount; x++) if (sim.canPick(x).ok) lanes.push(x);
  return lanes;
}

function remainingQueueItems(sim: NodeSimulation): number {
  return sim.queueGrid.reduce(
    (sum, column) => sum + column.reduce((count, cell) => count + (cell ? 1 : 0), 0),
    0,
  );
}

function cloneSimulation(source: NodeSimulation): NodeSimulation {
  const raw = source as unknown as Record<string, unknown>;
  const options = raw.options;
  const index = raw.ix;
  const sourceCustomers = [...source.active, ...source.pending];
  const copy = Object.assign(
    Object.create(Object.getPrototypeOf(source)),
    structuredClone({ ...raw, options: undefined, ix: undefined, level: undefined }),
  ) as NodeSimulation;
  const copyRaw = copy as unknown as Record<string, unknown>;
  copyRaw.options = options;
  copyRaw.ix = index;
  copyRaw.level = { ...source.level };
  [...copy.active, ...copy.pending].forEach((customer, customerIndex) => {
    const sourceCustomer = sourceCustomers[customerIndex];
    customer.dishes.forEach((dish, dishIndex) => {
      Object.setPrototypeOf(dish, Object.getPrototypeOf(sourceCustomer.dishes[dishIndex]));
    });
  });
  return copy;
}

/**
 * A bounded witness-search beam used for the final retry. It expands legal
 * picks against the complete authored simulation state. Queue depletion is
 * deliberately absent from its score; active progress and board mobility are
 * what make a partial route promising.
 */
function findLearnedBeamPlan(
  ix: GraphIndex,
  level: NodeLevelConfig,
  cfg: ResolvedScenario,
  maxIterations: number,
  behavior: EstimateBehavior,
  allowOptionalWaits = false,
  onProgress?: (pickedItems: number, totalItems: number) => void,
): LearnedSearchStep[] | null {
  type SearchNode = { sim: NodeSimulation; path: LearnedSearchStep[]; score: number };
  const initial = new NodeSimulation(ix, structuredClone(level), {
    outOfSlotPolicy: "park-on-grid",
    packingMode: behavior.packingMode,
    toolProcessBehavior: behavior.toolProcessBehavior,
    instantFlights: true,
    continueAfterCustomerTimeout: true,
    // Finished outputs wait in their tool instead of losing outright, so a
    // stuck board is only ever reported through the sim's own no-legal-move
    // check — the same one Play mode runs. Without it the solver would keep
    // picking into a jammed grid until dirty dishes overflowed, and the
    // failure-driven strategy fallbacks would read the wrong reason.
    detectDeadlockLoss: true,
  });
  initial.tick(0);
  initial.completeAllFlights();
  syncCustomerAdmission(initial);

  const settleUntilDecision = (sim: NodeSimulation): number => {
    const startedAt = sim.time;
    for (let guard = 0; guard < 200 && sim.status === "playing"; guard++) {
      sim.completeAllFlights();
      syncCustomerAdmission(sim);
      if (pickableLanes(sim).length > 0) return sim.time - startedAt;
      const completion = sim.nextCompletionIn();
      if (completion === null) return sim.time - startedAt;
      if (sim.fastForward(Math.max(0.01, completion)) <= 0) return sim.time - startedAt;
    }
    return sim.time - startedAt;
  };
  const stateScore = (sim: NodeSimulation): number => {
    // Full information makes future orders visible; it must not make their
    // ingredients as urgent as the orders currently occupying the counter.
    // Reward concrete active-order progress and board mobility instead.
    const activeRemaining = sim.active.reduce((sum, customer) =>
      sum + (isOrdering(customer)
        ? customer.dishes.reduce((dishSum, dish) => dishSum + dish.remaining.length, 0)
        : 0), 0);
    const occupied = sim.grid.reduce((sum, cell) => sum + (cell.kind === "empty" ? 0 : 1), 0);
    const free = sim.grid.length - occupied;
    const legalMoves = pickableLanes(sim).length;
    const heldOutputs = sim.tools.reduce((sum, tool) =>
      sum + tool.slots.reduce((count, slot) => count + (slot.item?.completed ? 1 : 0), 0), 0);
    return sim.servedCount * 100_000
      - activeRemaining * 10_000
      + free * 3_000
      + legalMoves * 400
      - heldOutputs * 1_000;
  };
  const stateKey = (sim: NodeSimulation): string => JSON.stringify([
    sim.servedCount,
    sim.active.map((customer) => [customer.index, customer.dishes.map((dish) => dish.filled)]),
    sim.pending.map((customer) => customer.index),
    sim.grid,
    sim.tools.map((tool) => tool.slots.map((slot) => slot.item)),
    // Queue item amount is part of the future state: on bag levels, two cells
    // with the same ingredient/group but different remaining bag sizes are not
    // interchangeable. Effects are included for the same reason.
    sim.queueGrid.map((column) => column.map((cell) =>
      cell && [cell.ing, cell.group, cell.item.amount ?? 1, cell.item.effects])),
    sim.queueGrid.map((column) => column.slice(0, ix.doc.map.visibleRows)
      .map((cell) => cell && sim.freezeCount(cell.item))),
  ]);

  let beam: SearchNode[] = [{ sim: initial, path: [], score: stateScore(initial) }];
  const queueCells = initial.queueGrid.reduce(
    (sum, column) => sum + column.reduce((count, cell) => count + (cell ? 1 : 0), 0),
    0,
  );
  let furthestPicked = -1;
  const reportProgress = (sim: NodeSimulation): void => {
    const picked = queueCells - remainingQueueItems(sim);
    if (picked <= furthestPicked) return;
    furthestPicked = picked;
    onProgress?.(picked, queueCells);
  };
  reportProgress(initial);
  const depthLimit = Math.min(maxIterations, queueCells + 8);
  let expandedStates = 0;
  for (let depth = 0; depth < depthLimit && beam.length > 0; depth++) {
    const next: SearchNode[] = [];
    const seen = new Set<string>();
    for (const node of beam) {
      const mandatoryWait = settleUntilDecision(node.sim);
      if (node.sim.status === "won") return node.path;
      if (node.sim.status !== "playing") continue;
      // Search the normal configured cadence, plus bounded voluntary waits for
      // upcoming tool completions. A held output is recoverable when a later
      // serve frees grid space, so it is penalized by stateScore, never pruned
      // from historical gridJams.
      const decisions: Array<{ sim: NodeSimulation; waitBeforePickSeconds: number }> = [
        { sim: node.sim, waitBeforePickSeconds: mandatoryWait },
      ];
      if (allowOptionalWaits) {
        const waited = cloneSimulation(node.sim);
        // One explicit wait branch per state is enough to express "let the next
        // job finish before picking" without multiplying the beam by every
        // combination of several consecutive idle periods. Longer waits remain
        // representable at later decision depths and mandatory waits are handled
        // by settleUntilDecision.
        const completion = waited.nextCompletionIn();
        if (completion !== null) {
          const advanced = waited.fastForward(Math.max(0.01, completion));
          waited.completeAllFlights();
          syncCustomerAdmission(waited);
          if (advanced > 0) {
            decisions.push({ sim: waited, waitBeforePickSeconds: mandatoryWait + advanced });
          }
        }
      }

      for (const decision of decisions) {
        for (const lane of pickableLanes(decision.sim)) {
          if (++expandedStates > 20_000) return null;
          const sim = cloneSimulation(decision.sim);
          if (!sim.pick(lane)) continue;
          reportProgress(sim);
          sim.completeAllFlights();
          const interval = Math.max(0, cfg.pickIntervalSeconds);
          if (interval > 0 && sim.status === "playing") sim.tick(interval);
          sim.completeAllFlights();
          syncCustomerAdmission(sim);
          const step: LearnedSearchStep = {
            lane,
            ...(decision.waitBeforePickSeconds > 0
              ? { waitBeforePickSeconds: decision.waitBeforePickSeconds }
              : {}),
          };
          const path = [...node.path, step];
          if (sim.status === "won") return path;
          if (sim.status !== "playing") continue;
          const key = stateKey(sim);
          if (seen.has(key)) continue;
          seen.add(key);
          next.push({ sim, path, score: stateScore(sim) });
        }
      }
    }
    next.sort((a, b) => b.score - a.score);
    // Preserve progress diversity instead of letting a large set of locally
    // greedy states at one served-count tier evict every slower route. This is
    // still score-ranked inside each tier, but keeps recoverable setup routes
    // alive long enough to prove their later serves.
    const beamWidth = 60;
    const servedTierCount = new Set(next.map((entry) => entry.sim.servedCount)).size;
    const perTier = Math.max(1, Math.floor(beamWidth / Math.max(1, servedTierCount)));
    const tierCounts = new Map<number, number>();
    const selected = new Set<SearchNode>();
    for (const entry of next) {
      const tier = entry.sim.servedCount;
      const count = tierCounts.get(tier) ?? 0;
      if (count >= perTier) continue;
      tierCounts.set(tier, count + 1);
      selected.add(entry);
    }
    for (const entry of next) {
      if (selected.size >= beamWidth) break;
      selected.add(entry);
    }
    beam = next.filter((entry) => selected.has(entry)).slice(0, beamWidth);
  }
  return null;
}

interface SupplyShortage {
  ingredient: string;
  have: number;
  need: number;
}

/**
 * Complete-information planner used only by Check Solvable. Unlike the player
 * estimator and its beam fallback, this is a backtracking state search: it
 * tries every legal lane in a stable order, memoizes states already proven
 * dead, and accepts a branch only when the real simulation reaches `won`.
 * No lane or partial-state score selects the route.
 */
interface CompleteInformationSearchResult {
  plan: LearnedSearchStep[] | null;
  budgetExhausted: boolean;
  expandedStates: number;
  elapsedMs: number;
}

function findCompleteInformationPlan(
  ix: GraphIndex,
  level: NodeLevelConfig,
  cfg: ResolvedScenario,
  maxIterations: number,
  behavior: EstimateBehavior,
  maxStatesPerDepth: number,
  settleAllBetweenPicks = false,
  onProgress?: (pickedItems: number, totalItems: number) => void,
): CompleteInformationSearchResult {
  const startedAt = performance.now();
  const initial = new NodeSimulation(ix, structuredClone(level), {
    outOfSlotPolicy: "park-on-grid",
    packingMode: behavior.packingMode,
    toolProcessBehavior: behavior.toolProcessBehavior,
    instantFlights: true,
    continueAfterCustomerTimeout: true,
    detectDeadlockLoss: true,
  });
  initial.tick(0);
  initial.completeAllFlights();
  syncCustomerAdmission(initial);

  const settleUntilDecision = (sim: NodeSimulation): number => {
    const startedAt = sim.time;
    if (settleAllBetweenPicks && sim.status === "playing") {
      sim.completeAllFlights();
      sim.fastForward(600);
      sim.completeAllFlights();
      syncCustomerAdmission(sim);
    }
    for (let guard = 0; guard < 200 && sim.status === "playing"; guard++) {
      sim.completeAllFlights();
      syncCustomerAdmission(sim);
      if (pickableLanes(sim).length > 0) break;
      const completion = sim.nextCompletionIn();
      if (completion === null || sim.fastForward(Math.max(0.01, completion)) <= 0) break;
    }
    return sim.time - startedAt;
  };
  const stateKey = (sim: NodeSimulation): string => JSON.stringify([
    sim.servedCount,
    sim.active.map((customer) => [customer.index, customer.dishes.map((dish) => dish.filled)]),
    sim.pending.map((customer) => customer.index),
    sim.grid,
    sim.tools.map((tool) => tool.slots.map((slot) => slot.item)),
    sim.queueGrid.map((column) => column.map((cell) =>
      cell && [cell.ing, cell.group, cell.item.amount ?? 1, cell.item.effects,
        sim.freezeCount(cell.item)])),
  ]);

  const queueCells = initial.queueGrid.reduce(
    (sum, column) => sum + column.reduce((count, cell) => count + (cell ? 1 : 0), 0),
    0,
  );
  let furthestPicked = -1;
  const reportProgress = (sim: NodeSimulation): void => {
    const picked = queueCells - remainingQueueItems(sim);
    if (picked <= furthestPicked) return;
    furthestPicked = picked;
    onProgress?.(picked, queueCells);
  };
  reportProgress(initial);
  const depthLimit = Math.min(maxIterations, queueCells + 8);
  const deadStates = new Set<string>();
  let expandedStates = 0;
  let prunedStates = 0;

  const visit = (
    sim: NodeSimulation,
    path: readonly LearnedSearchStep[],
    seenAtDepth: Map<number, Set<string>>,
  ): LearnedSearchStep[] | null => {
    const mandatoryWait = settleUntilDecision(sim);
    if (sim.status === "won") return [...path];
    if (sim.status !== "playing" || path.length >= depthLimit) return null;

    const key = stateKey(sim);
    if (deadStates.has(key)) return null;
    const depth = path.length;
    let seenHere = seenAtDepth.get(depth);
    if (!seenHere) {
      seenHere = new Set<string>();
      seenAtDepth.set(depth, seenHere);
    }
    // The same complete simulation state has the same future regardless of
    // which lane sequence reached it, so duplicates do not consume quota.
    if (seenHere.has(key)) return null;
    if (seenHere.size >= maxStatesPerDepth) {
      prunedStates++;
      return null;
    }
    seenHere.add(key);
    const prunedBefore = prunedStates;

    const decisions: Array<{ sim: NodeSimulation; waitBeforePickSeconds: number }> = [
      { sim, waitBeforePickSeconds: mandatoryWait },
    ];
    if (!settleAllBetweenPicks) {
      const waited = cloneSimulation(sim);
      const completion = waited.nextCompletionIn();
      if (completion !== null) {
        const advanced = waited.fastForward(Math.max(0.01, completion));
        waited.completeAllFlights();
        syncCustomerAdmission(waited);
        if (advanced > 0) {
          decisions.push({ sim: waited, waitBeforePickSeconds: mandatoryWait + advanced });
        }
      }
    }

    for (const decision of decisions) {
      // Lane order controls traversal only: failed branches are backtracked and
      // every remaining legal lane is still explored within the search bound.
      const lanes = pickableLanes(decision.sim).reverse();
      for (const lane of lanes) {
        expandedStates++;
        const child = cloneSimulation(decision.sim);
        if (!child.pick(lane)) continue;
        reportProgress(child);
        child.completeAllFlights();
        const interval = Math.max(0, cfg.pickIntervalSeconds);
        if (interval > 0 && child.status === "playing") child.tick(interval);
        child.completeAllFlights();
        syncCustomerAdmission(child);
        const step: LearnedSearchStep = {
          lane,
          ...(decision.waitBeforePickSeconds > 0
            ? { waitBeforePickSeconds: decision.waitBeforePickSeconds }
            : {}),
        };
        const childPath = [...path, step];
        if (child.status === "won") return childPath;
        if (child.status !== "playing") continue;
        // Each root action receives a fresh per-depth quota. Previously the
        // first DFS root could consume the shared quota and starve every later
        // root lane, which made a larger bound paradoxically miss easy wins.
        const childSeen = path.length === 0 ? new Map<number, Set<string>>() : seenAtDepth;
        const solved = visit(child, childPath, childSeen);
        if (solved) return solved;
      }
    }

    // Only memoize a state as genuinely dead if its entire descendant tree was
    // explored. A state above a pruned branch remains eligible through another
    // route; pruning is an uncertainty bound, never an unsolvability proof.
    if (prunedStates === prunedBefore) deadStates.add(key);
    return null;
  };

  const plan = visit(initial, [], new Map<number, Set<string>>());
  return {
    plan,
    budgetExhausted: prunedStates > 0,
    expandedStates,
    elapsedMs: performance.now() - startedAt,
  };
}

/** True once this run has encountered grid pressure; used for failure wording, not search pruning. */
function hasStrandedOutput(sim: NodeSimulation): boolean {
  return sim.gridJams > 0;
}

/** Run one scoring strategy against the exact simulation used by Play and replay. */
function estimateNodeDifficultyAttempt(
  ix: GraphIndex,
  level: NodeLevelConfig,
  cfg: ResolvedScenario,
  rng: () => number,
  maxIterations: number,
  exploration: number,
  workWaitStrategy: WorkWaitStrategy,
  forcedPlan?: readonly LearnedSearchStep[],
  failureKnowledge: EstimateFailureKnowledge = emptyFailureKnowledge(),
  adaptiveStrategies?: readonly ScoringStrategy[],
  adaptivePickInterval = 5,
  behavior: EstimateBehavior = { packingMode: "unpacked-raw", toolProcessBehavior: "auto" },
  omniscient = false,
  onProgress?: (pickedItems: number, totalItems: number) => void,
): EstimateResult {
  const sim = new NodeSimulation(ix, level, {
    outOfSlotPolicy: "park-on-grid",
    packingMode: behavior.packingMode,
    toolProcessBehavior: behavior.toolProcessBehavior,
    instantFlights: true,
    continueAfterCustomerTimeout: true,
    // Finished outputs wait in their tool instead of losing outright, so a
    // stuck board is only ever reported through the sim's own no-legal-move
    // check — the same one Play mode runs. Without it the solver would keep
    // picking into a jammed grid until dirty dishes overflowed, and the
    // failure-driven strategy fallbacks would read the wrong reason.
    detectDeadlockLoss: true,
  });
  const totalQueueItems = remainingQueueItems(sim);
  onProgress?.(0, totalQueueItems);

  const byCid = new Map<string, EstimateSlot>();
  const costs = new Map<number, CustomerCost>();
  const occupancyHistory: OccupancySample[] = [];
  const replaySteps: EstimateReplayStep[] = [];
  const pickTimes: number[] = [];
  const servedAtByCustomer = new Map<number, number>();
  let currentReplayLaneScores: (number | null)[] = [];
  let counter = 0;
  let iterations = 0;
  let halted: string | undefined;
  let pendingWaitBeforePick = 0;
  let peakConcurrentWork = 0;
  let nextAdaptiveEvaluationPick = 0;
  const adaptiveStrategyHistory: EstimatePickingStrategyName[] = [];

  // Events are sampled throughout the run because NodeSimulation intentionally
  // keeps only a bounded recent log. Customer indices are unique, so rescanning
  // the current window is idempotent.
  const captureServedEvents = (): void => {
    for (const event of sim.events) {
      if (event.type === "served" && event.customerIndex !== undefined) {
        servedAtByCustomer.set(event.customerIndex, event.atTime);
      }
    }
  };

  const observeConcurrentWork = (): void => {
    peakConcurrentWork = Math.max(peakConcurrentWork, sim.cookingCount + sim.flights.length);
  };

  /**
   * Model the real bot cadence: transfers resolve logically, but cooking receives only the
   * configured interval before the next decision instead of being drained to completion.
   */
  const advanceBetweenPicks = (): void => {
    sim.completeAllFlights();
    observeConcurrentWork();
    const interval = Math.max(0, cfg.pickIntervalSeconds);
    if (interval > 0 && sim.status === "playing") sim.tick(interval);
    sim.completeAllFlights();
    observeConcurrentWork();
    if (workWaitStrategy === "wait-all" && sim.status === "playing") {
      const startedAt = sim.time;
      sim.fastForward(600);
      sim.completeAllFlights();
      pendingWaitBeforePick += sim.time - startedAt;
      observeConcurrentWork();
    }
  };

  /** Wait only until some queue becomes legal, not until every tool has finished cooking. */
  const waitUntilPickable = (): number => {
    const startedAt = sim.time;
    for (let guard = 0; guard < 2000 && sim.status === "playing"; guard++) {
      sim.completeAllFlights();
      if (pickableLanes(sim).length > 0) break;
      const completion = sim.nextCompletionIn();
      if (completion === null) break;
      if (sim.fastForward(Math.max(0.01, completion)) === 0) break;
      syncCustomerAdmission(sim);
    }
    sim.completeAllFlights();
    return sim.time - startedAt;
  };

  const sampleOccupancy = (): Pick<OccupancySample, "occupied" | "dirty"> => {
    let occupied = 0;
    let dirty = 0;
    for (const cell of sim.grid) {
      if (cell.kind === "empty") continue;
      occupied++;
      if (cell.kind === "dirty") dirty++;
    }
    return { occupied, dirty };
  };

  const countGrid = (): { free: number; dirty: number } => {
    let free = 0;
    let dirty = 0;
    for (const cell of sim.grid) {
      if (cell.kind === "empty") free++;
      else if (cell.kind === "dirty") dirty++;
    }
    return { free, dirty };
  };

  const laneFootprint = (lane: number): number => {
    let footprint = 0;
    for (const cell of sim.pickTargets(lane)) {
      const queued = sim.queueGrid[cell.x]?.[cell.y];
      if (queued?.item.kind !== "ingredient") continue;
      const perPiece = Math.max(1, ix.terminalYield[queued.ing] ?? 1);
      // A bag takes ONE cell for itself and cooks a piece at a time, so its
      // near-term footprint is the bag plus one piece's output — not the
      // whole bag's worth of pieces at once.
      footprint += queueItemAmount(queued.item) > 1 ? 1 + perPiece : perPiece;
    }
    return footprint;
  };

  /**
   * Allow overlapping work while every committed output still fits. When the next pick would make
   * the eventual grid load exceed capacity, wait for one ready cooking event and replan instead.
   */
  const waitForCapacityBefore = (lane: number): boolean => {
    const front = sim.frontCell(lane);
    if (front?.item.kind === "sweeper") return false;
    const committed = sim.cookingCount + sim.flights.length;
    if (committed <= 0) return false;
    const { free } = countGrid();
    const occupied = sim.grid.length - free;
    const learnedReserve = Math.min(
      Math.max(0, sim.grid.length - 1),
      Math.ceil(Math.max(0, cfg.gridTightThreshold - 0.5) * 10),
    );
    const safeCapacity = Math.max(1, sim.grid.length - learnedReserve);
    if (occupied + committed + laneFootprint(lane) <= safeCapacity) return false;
    const completion = sim.nextCompletionIn();
    if (completion === null) return false;
    const advanced = sim.fastForward(Math.max(0.01, completion));
    if (advanced <= 0) return false;
    pendingWaitBeforePick += advanced;
    observeConcurrentWork();
    syncCustomerAdmission(sim);
    return true;
  };

  let gridTight = false;

  /**
   * Exact backward recipe expansion. A hot coffee is not "whatever terminal
   * output coffee-bean happens to choose": it is one bean AND one teacup. The
   * output amount is folded in, so one kiwi (amount 2) contributes half a raw
   * unit to each requested slice.
   */
  const requirementsMemo = new Map<number, Map<number, number>>();
  const rawRequirements = (target: number, visiting = new Set<number>()): Map<number, number> => {
    const cached = requirementsMemo.get(target);
    if (cached) return cached;
    if (visiting.has(target)) return new Map([[target, 1]]);
    const step = ix.producerOf[target];
    if (!step) {
      const leaf = new Map([[target, 1]]);
      requirementsMemo.set(target, leaf);
      return leaf;
    }
    visiting.add(target);
    const result = new Map<number, number>();
    for (const input of step.inputs) {
      for (const [leaf, units] of rawRequirements(input.ing, visiting)) {
        result.set(leaf, (result.get(leaf) ?? 0) + units / Math.max(1, step.amount));
      }
    }
    visiting.delete(target);
    requirementsMemo.set(target, result);
    return result;
  };

  const productionDepthMemo = new Map<number, number>();
  const productionDepth = (target: number, visiting = new Set<number>()): number => {
    const cached = productionDepthMemo.get(target);
    if (cached !== undefined) return cached;
    if (visiting.has(target)) return 0;
    const step = ix.producerOf[target];
    if (!step) return 0;
    visiting.add(target);
    const depth = 1 + Math.max(0, ...step.inputs.map((input) => productionDepth(input.ing, visiting)));
    visiting.delete(target);
    productionDepthMemo.set(target, depth);
    return depth;
  };

  const hasMultiInputMemo = new Map<number, boolean>();
  const hasMultiInputRoute = (target: number, visiting = new Set<number>()): boolean => {
    const cached = hasMultiInputMemo.get(target);
    if (cached !== undefined) return cached;
    if (visiting.has(target)) return false;
    const step = ix.producerOf[target];
    if (!step) return false;
    visiting.add(target);
    const result = step.inputs.length > 1 || step.inputs.some((input) => hasMultiInputRoute(input.ing, visiting));
    visiting.delete(target);
    hasMultiInputMemo.set(target, result);
    return result;
  };

  // These names were observed only after the customer became active in an earlier failed run.
  // Exact remembered ingredients therefore affect exact active orders only. Preview scoring gets
  // a customer-level boost, never a hidden topping reveal.
  const learnedCustomerIngredients = new Map<number, Map<number, number>>();
  const learnedCustomerFailures = new Map<number, number>();
  for (const memory of failureKnowledge.customerPriorities ?? []) {
    learnedCustomerFailures.set(memory.customerIndex, Math.max(0, memory.failureCount));
    const ingredients = new Map<number, number>();
    for (const name of memory.ingredientNames ?? []) {
      const ing = ix.ingByName.get(name);
      if (ing !== undefined) ingredients.set(ing, Math.max(0, memory.failureCount));
    }
    learnedCustomerIngredients.set(memory.customerIndex, ingredients);
  }

  const activeFailurePriority = (customerIndex: number, ingredient: number): number => {
    const count = learnedCustomerIngredients.get(customerIndex)?.get(ingredient) ?? 0;
    return 1 + Math.min(1, count * 0.2);
  };

  const previewFailurePriority = (customerIndex: number): number => {
    const count = learnedCustomerFailures.get(customerIndex) ?? 0;
    return 1 + Math.min(0.4, count * 0.08);
  };

  /** Ingredients already committed to the pipeline, expressed as raw leaves. */
  const pipelineLeaves = (): Map<number, number> => {
    const supply = new Map<number, number>();
    const add = (ing: number): void => {
      for (const [leaf, units] of rawRequirements(ing)) {
        supply.set(leaf, (supply.get(leaf) ?? 0) + units);
      }
    };
    for (const cell of sim.grid) {
      if (cell.kind === "raw") add(cell.ing);
      else if (cell.kind === "backpack") for (const ing of cell.items) add(ing);
    }
    for (const flight of sim.flights) if (flight.ing >= 0) add(flight.ing);
    for (const tool of sim.tools) {
      for (const slot of tool.slots) if (slot.item) add(slot.item.ing);
    }
    return supply;
  };

  /** Remaining queue supply per raw leaf, used to favour scarce requirements. */
  const queueLeaves = (): Map<number, number> => {
    const supply = new Map<number, number>();
    for (const column of sim.queueGrid) {
      for (const cell of column) {
        if (!cell || cell.ing < 0) continue;
        for (const [leaf, units] of rawRequirements(cell.ing)) {
          supply.set(leaf, (supply.get(leaf) ?? 0) + units);
        }
      }
    }
    return supply;
  };

  /**
   * Build a score table from the active orders and the whole production graph.
   * Cooked grid pieces satisfy exact slots first; partial tool/grid work then
   * satisfies the raw leaves of the highest-priority claims. What remains is
   * what another queue pickup is genuinely worth.
   */
  const buildPickupValues = (): Map<number, PickupValue> => {
    const cooked = new Map<number, number>();
    for (const cell of sim.grid) {
      if (cell.kind === "cooked") cooked.set(cell.ing, (cooked.get(cell.ing) ?? 0) + (cell.usesLeft ?? 1));
    }

    const units: DemandUnit[] = [];
    const exactCustomers = omniscient ? [...sim.active, ...sim.pending] : sim.active;
    exactCustomers.forEach((customer, customerPosition) => {
      if (!isOrdering(customer)) return;
      for (const dish of customer.dishes) {
        const remainingCount = dish.remaining.length;
        dish.order.slots.forEach((slot, slotIndex) => {
          if (dish.filled[slotIndex]) return;
          // `gate === -1` identifies the outer base. The indexed slot also
          // knows about bases of nested composites, which deserve the same
          // production priority before their nested toppings.
          const indexedSlot = ix.slotsOfComposite[dish.order.orderable]?.[slot.slot];
          const base = indexedSlot?.isBase ?? slot.gate === -1;
          const open = dish.gateOpen(slotIndex);
          const multiInput = hasMultiInputRoute(slot.ing);
          const depth = productionDepth(slot.ing);
          let priority = base
            ? cfg.scoreBase
            : open
              ? cfg.scoreReady
              : gridTight
                ? cfg.scoreBlockedTight
                : cfg.scoreBlocked;
          // Long chains must start early, and every input of a multi-input
          // process that produces the composite base is itself base-critical.
          priority += Math.min(cfg.depthBonusCap, depth * cfg.depthBonusPerLevel);
          if (multiInput) priority += base ? cfg.multiInputBaseBonus : cfg.multiInputBonus;
          priority += Math.max(0, 4 - remainingCount) * cfg.nearCompletionBonus;
          priority /= 1 + customerPosition * cfg.customerPositionDecay;
          // A boss owns the counter alone, so every detour occupies capacity
          // that no second active customer can consume. Player mode only reads
          // a boss once active; Check Solvable deliberately knows pending
          // bosses and every other authored order.
          if (customer.config.isBoss) priority *= 1.25;
          priority *= activeFailurePriority(customer.index, slot.ing);
          units.push({
            target: slot.ing,
            customerIndex: customer.index,
            priority,
            base,
            multiInput,
            ready: base || open,
            requirements: rawRequirements(slot.ing),
          });
        });
      }
    });

    // A finished grid piece is already the solution for one exact slot. Give
    // it to the most urgent compatible claim before asking for more raws.
    units.sort((a, b) => b.priority - a.priority);
    const unsatisfied = units.filter((unit) => {
      const have = cooked.get(unit.target) ?? 0;
      if (have <= 0) return true;
      cooked.set(unit.target, have - 1);
      return false;
    });

    const claims = new Map<number, DemandClaim[]>();
    for (const unit of unsatisfied) {
      for (const [leaf, amount] of unit.requirements) {
        const list = claims.get(leaf) ?? [];
        list.push({
          units: amount,
          priority: unit.priority,
          customerIndex: unit.customerIndex,
          target: unit.target,
          base: unit.base,
          multiInput: unit.multiInput,
          ready: unit.ready,
        });
        claims.set(leaf, list);
      }
    }
    for (const list of claims.values()) list.sort((a, b) => b.priority - a.priority);

    // Composite-only lookahead for the next three customers. A fixed/base slot
    // remains informative; a choice group spreads its value evenly across all
    // legal options. This is intentionally separate from exact active claims:
    // preview demand never consumes committed supply or marks a pick "ready".
    const previewClaims = new Map<number, { score: number; customerIndex: number }>();
    if (!omniscient) sim.visiblePreviewCustomers(CUSTOMER_PREVIEW_COUNT).forEach((customer, previewPosition) => {
      if (!isOrdering(customer)) return;
      for (const dish of customer.dishes) {
        const slots = ix.slotsOfComposite[dish.order.orderable] ?? [];
        const composite = ix.doc.vertices.composite[dish.order.orderable];
        for (const slot of slots) {
          if (slot.options.length === 0) continue;
          const required = slot.isBase || slot.minQuantity > 0 || Boolean(composite?.toppingRequired);
          const confidence = required ? cfg.previewConfidence : cfg.previewConfidence * 0.45;
          const basePriority = slot.isBase ? cfg.scoreBase : cfg.scoreBlocked;
          const position = sim.active.length + previewPosition;
          const priority = (basePriority * confidence) /
            (1 + position * cfg.customerPositionDecay) /
            slot.options.length * previewFailurePriority(customer.index);
          for (const option of slot.options) {
            for (const [leaf, units] of rawRequirements(option)) {
              const score = priority * units;
              const current = previewClaims.get(leaf);
              if (current) current.score += score;
              else previewClaims.set(leaf, { score, customerIndex: customer.index });
            }
          }
        }
      }
    });

    const committed = pipelineLeaves();
    for (const [leaf, available] of committed) {
      let left = available;
      for (const claim of claims.get(leaf) ?? []) {
        if (left <= 0) break;
        const used = Math.min(left, claim.units);
        claim.units -= used;
        left -= used;
      }
    }

    const remainingQueue = queueLeaves();
    const values = new Map<number, PickupValue>();
    for (let ing = 0; ing < ix.ingName.length; ing++) {
      const contribution = rawRequirements(ing);
      let score = 0;
      let customerIndex = -1;
      let strongest = 0;
      let ready = false;
      for (const [leaf, amount] of contribution) {
        let capacity = amount;
        let leafScore = 0;
        const list = claims.get(leaf) ?? [];
        for (const claim of list) {
          if (capacity <= 0) break;
          if (claim.units <= 0) continue;
          const used = Math.min(capacity, claim.units);
          leafScore += claim.priority * used;
          capacity -= used;
          if (claim.priority > strongest) {
            strongest = claim.priority;
            customerIndex = claim.customerIndex;
            ready = claim.ready;
          }
        }
        const needed = list.reduce((sum, claim) => sum + Math.max(0, claim.units), 0);
        const available = remainingQueue.get(leaf) ?? 0;
        if (needed > 0 && available > 0) {
          // Exactly-enough or scarce ingredients must not be postponed behind
          // plentiful alternatives. Cap the bonus so priority still dominates.
          leafScore *= 1 + Math.min(cfg.scarcityCap, (needed / available) * cfg.scarcityFactor);
        }
        score += leafScore;

        const preview = previewClaims.get(leaf);
        if (preview) {
          const previewScore = preview.score * amount;
          score += previewScore;
          if (strongest === 0 && previewScore > 0) customerIndex = preview.customerIndex;
        }
      }

      // If the rest of a recipe is already loaded, prefer the missing input:
      // it releases the tool and produces the demanded base immediately.
      if (score > 0) {
        const committedLeaves = committed;
        for (const unit of unsatisfied) {
          const candidateLeaves = new Set(
            [...contribution.keys()].filter((leaf) => (unit.requirements.get(leaf) ?? 0) > 0),
          );
          if (candidateLeaves.size === 0) continue;
          const otherInputsReady = [...unit.requirements].every(([leaf, needed]) =>
            candidateLeaves.has(leaf) || (committedLeaves.get(leaf) ?? 0) >= needed,
          );
          if (otherInputsReady) {
            score += unit.priority * (unit.multiInput ? cfg.lastInputBonusMulti : cfg.lastInputBonusSingle);
          }
        }
      }
      values.set(ing, { score, customerIndex, ready });
    }
    return values;
  };

  let pickupValues = new Map<number, PickupValue>();

  const costFor = (index: number): CustomerCost => {
    let cost = costs.get(index);
    if (!cost) {
      cost = { index, gridOccupied: 0, gridWaste: 0, picks: 0, detours: 0, randomPicks: 0, bestPicks: 0 };
      costs.set(index, cost);
    }
    return cost;
  };

  const sweeperValue = (): number => {
    const { dirty } = countGrid();
    if (dirty === 0) return 0;
    return gridTight ? cfg.scoreSweeperUrgent : cfg.scoreSweeper;
  };

  const valueOfCell = (x: number, y: number): PickupValue => {
    const cell = sim.queueGrid[x]?.[y];
    if (!cell) return { score: 0, customerIndex: -1, ready: false };
    // A sweeper taken while stacks are dirty is the correct play, not a
    // compromise, so it counts as a ready (best) pick.
    if (cell.item.kind === "sweeper") {
      const score = sweeperValue();
      return { score, customerIndex: -1, ready: score > 0 };
    }
    return pickupValues.get(cell.ing) ?? { score: 0, customerIndex: -1, ready: false };
  };

  const scoreLane = (x: number, depth: number) => {
    // Score what this click ACTUALLY picks first. Combined/linked instances can
    // advance several requirements at once, so their values add instead of
    // silently keeping only one member.
    let immediate = 0;
    let immediateCustomer = -1;
    let strongestImmediate = 0;
    let immediateReady = false;
    const footprint = laneFootprint(x);
    for (const cell of sim.pickTargets(x)) {
      const value = valueOfCell(cell.x, cell.y);
      immediate += value.score;
      if (value.score > strongestImmediate) {
        strongestImmediate = value.score;
        immediateCustomer = value.customerIndex;
        immediateReady = value.ready;
      }
    }

    // Looking ahead is navigation value, not the value of the current pick.
    // It can justify a detour, but row decay and its grid-footprint penalty keep
    // a buried base from pretending the unrelated item in front is free.
    let future = 0;
    let futureCustomer = -1;
    for (let y = 1; y < depth; y++) {
      const cell = sim.queueGrid[x]?.[y];
      // With the Hidden-slot scenario toggle off, a hidden row is scored as if
      // it had already been revealed.
      if (!cell || (!omniscient && cfg.hiddenStatus && sim.isHidden(x, y))) continue;
      const value = valueOfCell(x, y);
      if (value.score === 0) continue;
      const decayed = value.score * cfg.rowDecay ** y;
      if (decayed > future) {
        future = decayed;
        futureCustomer = value.customerIndex;
      }
    }
    const detourPenalty = immediate === 0
      ? Math.max(1, footprint) * (gridTight ? cfg.detourPenaltyTight : cfg.detourPenalty)
      : 0;
    return {
      score: Math.max(0, immediate + future - detourPenalty),
      customerIndex: strongestImmediate > 0 ? immediateCustomer : futureCustomer,
      fromFront: strongestImmediate > 0,
      // Best only when the thing actually being picked is placeable now —
      // a lookahead-driven dig never qualifies.
      best: strongestImmediate > 0 && immediateReady,
    };
  };

  const nameOfItem = (item: QueueItem, ing: number): string =>
    item.kind === "sweeper" ? "Sweeper" : sim.ingredientName(ing);

  const take = (
    lane: number,
    customerIndex: number,
    detour: boolean,
    score = 0,
    random = false,
    best = false,
  ): boolean => {
    const cells = sim.pickTargets(lane);
    if (cells.length === 0) return false;
    const items = cells
      .map((cell) => sim.queueGrid[cell.x]?.[cell.y])
      .filter((cell): cell is NonNullable<typeof cell> => cell !== null);
    const pickTime = sim.time;
    if (!sim.pick(lane)) return false;
    onProgress?.(totalQueueItems - remainingQueueItems(sim), totalQueueItems);
    pickTimes.push(pickTime);
    observeConcurrentWork();
    replaySteps.push({
      lane,
      serveableSlots: sim.level.serveableSlots,
      laneScores: [...currentReplayLaneScores],
      waitBeforePickSeconds: pendingWaitBeforePick,
      pickIntervalSeconds: Math.max(0, cfg.pickIntervalSeconds),
    });
    pendingWaitBeforePick = 0;

    counter++;
    for (const cell of items) {
      const cid = cidOf(cell.item);
      if (cid) byCid.set(cid, { order: counter, customerIndex, detour });
    }
    const cost = costFor(customerIndex);
    cost.picks++;
    if (detour) cost.detours++;
    if (random) cost.randomPicks++;
    else if (best) cost.bestPicks++;
    advanceBetweenPicks();
    syncCustomerAdmission(sim);
    captureServedEvents();
    occupancyHistory.push({
      ...sampleOccupancy(),
      score,
      random,
      customerIndex,
      pickedNames: items.map((cell) => nameOfItem(cell.item, cell.ing)),
      completesCustomers: [],
    });
    return true;
  };

  const measure = (): void => {
    for (const customer of sim.active) {
      if (!isOrdering(customer)) continue;
      const needed = new Set<number>();
      for (const dish of customer.dishes) for (const ing of dish.remaining) needed.add(ing);
      let occupied = 0;
      let waste = 0;
      for (const cell of sim.grid) {
        const contents = cell.kind === "cooked"
          ? [cell.ing]
          : cell.kind === "raw"
            ? [ix.terminalOutput[cell.ing] ?? cell.ing]
            : cell.kind === "backpack"
              ? cell.items.map((ing) => ix.terminalOutput[ing] ?? ing)
              : [];
        for (const ing of contents) {
          if (needed.has(ing)) occupied++;
          else waste++;
        }
      }
      const cost = costFor(customer.index);
      cost.gridOccupied = Math.max(cost.gridOccupied, occupied);
      cost.gridWaste = Math.max(cost.gridWaste, waste);
    }
  };

  const selectAdaptiveStrategy = (): ScoringStrategy | undefined => {
    if (!adaptiveStrategies || adaptiveStrategies.length === 0) return undefined;
    const { free, dirty } = countGrid();
    const capacity = Math.max(1, sim.grid.length);
    const occupiedRatio = (capacity - free) / capacity;
    const dirtyRatio = dirty / capacity;
    const activeOrders = sim.active.filter(isOrdering);
    const activeRemaining = activeOrders.reduce(
      (sum, customer) => sum + customer.dishes.reduce((dishSum, dish) => dishSum + dish.remaining.length, 0),
      0,
    );
    const nearlyFinished = activeOrders.some((customer) =>
      customer.dishes.some((dish) => dish.remaining.length > 0 && dish.remaining.length <= 2));
    const remainingCustomers = Math.max(0, sim.totalCustomers - sim.servedCount);
    const visiblePreviewCount = omniscient
      ? sim.pending.filter(isOrdering).length
      : sim.visiblePreviewCustomers(CUSTOMER_PREVIEW_COUNT).length;
    const legalLanes = pickableLanes(sim).length;
    const totalLanes = Math.max(1, sim.queueGrid.length);
    const laneScarcity = 1 - legalLanes / totalLanes;
    const workRatio = Math.min(1, (sim.cookingCount + sim.flights.length) / capacity);
    const lateLevel = sim.totalCustomers > 0 ? 1 - remainingCustomers / sim.totalCustomers : 0;

    const scores: Record<EstimatePickingStrategyName, number> = {
      "grid-safe": occupiedRatio * 3 + dirtyRatio * 2 + workRatio + failureKnowledge.gridPressure,
      "front-loaded": activeOrders.length * 0.35 + Math.min(1, activeRemaining / 8) + failureKnowledge.randomPressure,
      "finish-first": (nearlyFinished ? 2 : 0) + lateLevel + failureKnowledge.urgencyPressure,
      "chain-first": Math.min(2, remainingCustomers * 0.08) + visiblePreviewCount * 0.2 + failureKnowledge.chainPressure,
      "scarcity-first": laneScarcity * 2.5 + failureKnowledge.scarcityPressure,
      "single-customer": activeOrders.length === 1 ? 1.5 : 0.15,
      "wide-counter": activeOrders.length >= 3 ? 1.25 : 0.2,
      "no-preview": occupiedRatio * 1.5 + (remainingCustomers <= activeOrders.length ? 1 : 0),
    };
    return [...adaptiveStrategies].sort((a, b) =>
      (scores[canonicalStrategyName(b.name) ?? "grid-safe"] ?? 0) -
      (scores[canonicalStrategyName(a.name) ?? "grid-safe"] ?? 0))[0];
  };

  sim.tick(0);
  sim.completeAllFlights();
  syncCustomerAdmission(sim);
  captureServedEvents();

  while (sim.status === "playing" && iterations < maxIterations) {
    iterations++;
    measure();
    gridTight = sim.hasActiveBoss || countGrid().free <= sim.grid.length * cfg.gridTightThreshold;
    if (adaptiveStrategies && counter >= nextAdaptiveEvaluationPick) {
      const selected = selectAdaptiveStrategy();
      if (selected) {
        cfg = selected.cfg;
        const selectedName = canonicalStrategyName(selected.name);
        if (selectedName && adaptiveStrategyHistory.at(-1) !== selectedName)
          adaptiveStrategyHistory.push(selectedName);
        nextAdaptiveEvaluationPick = counter + Math.max(1, Math.floor(adaptivePickInterval));
        syncCustomerAdmission(sim);
        gridTight = sim.hasActiveBoss || countGrid().free <= sim.grid.length * cfg.gridTightThreshold;
      }
    }
    // A complete-information witness can finish with processing/merging work
    // still in flight after its final pick. Do not fall back to the scoring
    // picker once the witness is exhausted: settle that work and require the
    // authored route itself to reach a win.
    if (forcedPlan && counter >= forcedPlan.length) {
      const startedAt = sim.time;
      sim.fastForward(600);
      sim.completeAllFlights();
      pendingWaitBeforePick += sim.time - startedAt;
      observeConcurrentWork();
      syncCustomerAdmission(sim);
      captureServedEvents();
      if (sim.servedCount >= sim.totalCustomers) continue;
      halted = "Planned route ended before the simulation reached a win.";
      break;
    }
    const forcedStep = forcedPlan?.[counter];
    const forcedWait = forcedStep?.waitBeforePickSeconds ?? 0;
    if (forcedWait > 0) {
      const startedAt = sim.time;
      sim.fastForward(forcedWait);
      sim.completeAllFlights();
      pendingWaitBeforePick += sim.time - startedAt;
      observeConcurrentWork();
      syncCustomerAdmission(sim);
      if (sim.status !== "playing") continue;
    }
    pickupValues = buildPickupValues();
    const lanes = pickableLanes(sim);
    if (lanes.length === 0) {
      const advanced = waitUntilPickable();
      if (advanced === 0) {
        if (pickableLanes(sim).length > 0) continue;
        halted = hasStrandedOutput(sim)
          ? "Stuck: finished ingredients are waiting in their tools with no free grid cell."
          : "Nothing left to pick and nothing cooking — the queues ran dry.";
        break;
      }
      pendingWaitBeforePick += advanced;
      observeConcurrentWork();
      syncCustomerAdmission(sim);
      continue;
    }

    const depth = Math.max(1, ix.doc.map.visibleRows);
    const candidateLanes = lanes;
    const pickable = new Set(candidateLanes);
    const scoresByLane = sim.queueGrid.map((_, lane) =>
      pickable.has(lane) ? scoreLane(lane, depth) : null,
    );
    currentReplayLaneScores = scoresByLane.map((value) => value?.score ?? null);
    let best = { lane: -1, score: 0, customerIndex: -1, fromFront: false, best: false };
    for (const lane of candidateLanes) {
      const candidate = scoresByLane[lane]!;
      if (candidate.score > best.score) best = { lane, ...candidate };
    }
    const forcedLane = forcedStep?.lane;
    if (forcedLane !== undefined && pickable.has(forcedLane)) {
      best = { lane: forcedLane, ...(scoresByLane[forcedLane] ?? {
        score: 0, customerIndex: -1, fromFront: false, best: false,
      }) };
    } else if (forcedLane !== undefined) {
      halted = `Planned lane ${forcedLane + 1} is no longer pickable.`;
      break;
    }
    // Failed player runs retry among visible choices. Omniscient solvability
    // uses the same exploration model after scoring every authored row.
    if (exploration > 0 && rng() < exploration) {
      const alternatives = candidateLanes
        .map((lane) => ({ lane, ...scoresByLane[lane]! }))
        .sort((a, b) => b.score - a.score);
      if (alternatives.length > 1) {
        const start = alternatives[0].score > 0 ? 1 : 0;
        best = alternatives[start + Math.floor(rng() * (alternatives.length - start))];
      }
    }
    if (best.lane !== -1) {
      // A beam witness was generated against the simulation's real capacity
      // rules. Do not insert the estimate picker's conservative capacity wait
      // while replaying it, or the timed witness becomes a different route.
      if (!forcedStep && waitForCapacityBefore(best.lane)) continue;
      const owner = best.customerIndex >= 0
        ? best.customerIndex
        : (sim.active.find(isOrdering)?.index ?? sim.active[0]?.index ?? 0);
      if (!take(best.lane, owner, !best.fromFront, best.score, false, best.best)) break;
      measure();
      continue;
    }

    const fallbackOwner = sim.active.find(isOrdering)?.index ?? sim.active[0]?.index ?? 0;
    let fallback = candidateLanes[Math.floor(rng() * candidateLanes.length)];
    if (gridTight) {
      let cheapestRisk = Infinity;
      for (const lane of candidateLanes) {
        const cell = sim.frontCell(lane);
        if (!cell) continue;
        const yieldAmount = cell.item.kind === "sweeper"
          ? -1
          : (ix.terminalYield[cell.ing] ?? 1) + (queueItemAmount(cell.item) > 1 ? 1 : 0);
        const risk = yieldAmount;
        if (risk < cheapestRisk) {
          cheapestRisk = risk;
          fallback = lane;
        }
      }
    }
    if (waitForCapacityBefore(fallback)) continue;
    if (!take(fallback, fallbackOwner, true, 0, true)) break;
    measure();
  }

  captureServedEvents();
  // A customer can finish while cooking advances between decisions. Graph
  // samples exist only at picks, so attach every served event to the pick
  // closest in gameplay time instead of silently dropping in-between serves.
  for (const [customerIndex, servedAt] of servedAtByCustomer) {
    const pickIndex = nearestPickIndex(pickTimes, servedAt);
    if (pickIndex >= 0) occupancyHistory[pickIndex]?.completesCustomers.push(customerIndex);
  }
  for (const sample of occupancyHistory) sample.completesCustomers.sort((a, b) => a - b);

  const bailed = sim.status === "playing" && !halted;
  const lost = sim.status === "lost";
  let reason = halted;
  if (!reason && lost) {
    reason = sim.loseReason === "grid-overflow"
      ? "The grid filled up — finished ingredients are stuck in their tools and nothing can move."
      : sim.loseReason === "dirty-overflow"
        ? "The grid filled up with dirty dishes."
        : sim.loseReason === "customer-timeout"
          ? "A customer's patience ran out."
          : sim.loseReason === "deadlock"
            ? "Nothing on the board can move — no lane can be picked and no tool can finish."
            : "The queues ran out of ingredients before every order was filled.";
  }
  if (!reason && bailed) reason = `Gave up after ${maxIterations} picks without finishing.`;


  return {
    solvable: sim.status === "won",
    gameplayDurationSeconds: sim.time,
    reason,
    loseReason: sim.loseReason,
    totalPicks: counter,
    servedCount: sim.servedCount,
    totalCustomers: sim.totalCustomers,
    byCid,
    perCustomer: [...costs.values()].sort((a, b) => a.index - b.index),
    occupancyHistory,
    gridCapacity: sim.grid.length,
    replaySteps,
    packingMode: behavior.packingMode,
    toolProcessBehavior: behavior.toolProcessBehavior,
    pickIntervalSeconds: Math.max(0, cfg.pickIntervalSeconds),
    peakConcurrentWork,
    timedOutCustomers: [...sim.timedOutCustomerIndices].map((index) => index + 1).sort((a, b) => a - b),
    adaptiveStrategyHistory: adaptiveStrategyHistory.length > 0 ? adaptiveStrategyHistory : undefined,
    failureCustomers: sim.status === "won" ? [] : sim.active
      .filter(isOrdering)
      .map((customer): EstimateFailureCustomer => ({
        customerIndex: customer.index,
        failureCount: 1,
        ingredientNames: [...new Set(customer.dishes.flatMap((dish) =>
          dish.order.slots
            .filter((_, slotIndex) => !dish.filled[slotIndex])
            .map((slot) => ix.ingName[slot.ing])
            .filter((name): name is string => Boolean(name))))],
      })),
  };
}

interface ScoringStrategy {
  name: string;
  cfg: ResolvedScenario;
  workWaitStrategy: WorkWaitStrategy;
}

const scaled = (value: number, factor: number): number => value * factor;
const bounded = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export function emptyFailureKnowledge(): EstimateFailureKnowledge {
  return {
    version: 3,
    failureCount: 0,
    gridPressure: 0,
    dirtyPressure: 0,
    urgencyPressure: 0,
    scarcityPressure: 0,
    chainPressure: 0,
    randomPressure: 0,
    pacingPressure: 0,
    attemptedStrategies: [],
    recommendedStrategy: null,
    customerPriorities: [],
    adaptivePickInterval: 5,
    adaptiveFailureCount: 0,
  };
}

const PRESET_STRATEGY_NAMES: readonly EstimatePickingStrategyName[] = [
  "grid-safe",
  "front-loaded",
  "finish-first",
  "chain-first",
  "scarcity-first",
  "single-customer",
  "wide-counter",
  "no-preview",
];

function canonicalStrategyName(name: string | undefined): EstimatePickingStrategyName | null {
  if (!name) return null;
  const baseName = name.split("+")[0] as EstimatePickingStrategyName;
  return PRESET_STRATEGY_NAMES.includes(baseName) ? baseName : null;
}

function recommendNextStrategy(
  knowledge: Omit<EstimateFailureKnowledge, "recommendedStrategy">,
): EstimateStrategyName {
  const scores: Record<EstimatePickingStrategyName, number> = {
    "grid-safe": Math.max(knowledge.gridPressure, knowledge.dirtyPressure, knowledge.pacingPressure),
    "front-loaded": knowledge.randomPressure,
    "finish-first": knowledge.urgencyPressure,
    "chain-first": knowledge.chainPressure,
    "scarcity-first": knowledge.scarcityPressure,
    "single-customer": knowledge.gridPressure * 0.2 + knowledge.randomPressure * 0.2,
    "wide-counter": knowledge.urgencyPressure * 0.5 + knowledge.chainPressure * 0.25,
    "no-preview": knowledge.randomPressure * 0.5 + knowledge.gridPressure * 0.1,
  };
  const attempted = new Set(knowledge.attemptedStrategies ?? []);
  return [...PRESET_STRATEGY_NAMES]
    .filter((name) => !attempted.has(name))
    .sort((a, b) => scores[b] - scores[a])[0] ?? "adaptive";
}

function mergeFailureCustomers(
  previous: readonly EstimateFailureCustomer[],
  current: readonly EstimateFailureCustomer[],
): EstimateFailureCustomer[] {
  const merged = new Map<number, EstimateFailureCustomer>();
  for (const memory of previous ?? []) {
    merged.set(memory.customerIndex, {
      customerIndex: memory.customerIndex,
      failureCount: Math.max(0, memory.failureCount),
      ingredientNames: [...new Set(memory.ingredientNames ?? [])],
    });
  }
  for (const memory of current ?? []) {
    const existing = merged.get(memory.customerIndex);
    if (!existing) {
      merged.set(memory.customerIndex, {
        customerIndex: memory.customerIndex,
        failureCount: Math.max(1, memory.failureCount),
        ingredientNames: [...new Set(memory.ingredientNames ?? [])],
      });
      continue;
    }
    existing.failureCount += Math.max(1, memory.failureCount);
    existing.ingredientNames = [...new Set([...existing.ingredientNames, ...(memory.ingredientNames ?? [])])];
  }
  return [...merged.values()]
    .sort((a, b) => b.failureCount - a.failureCount || a.customerIndex - b.customerIndex)
    .slice(0, 32);
}

/**
 * Distil one failed run into bounded pressures plus exact orders that were visibly active at the
 * failure. Hidden preview choices never enter customer ingredient memory.
 */
export function accumulateFailureKnowledge(
  previous: EstimateFailureKnowledge,
  failed: EstimateResult,
): EstimateFailureKnowledge {
  if (failed.solvable || failed.loseReason === "customer-timeout") return { ...previous };
  const capacity = Math.max(1, failed.gridCapacity);
  const peakGrid = failed.occupancyHistory.reduce(
    (peak, sample) => Math.max(peak, sample.occupied / capacity),
    0,
  );
  const peakDirty = failed.occupancyHistory.reduce(
    (peak, sample) => Math.max(peak, sample.dirty / capacity),
    0,
  );
  const picks = failed.perCustomer.reduce((sum, cost) => sum + cost.picks, 0);
  const randomPicks = failed.perCustomer.reduce((sum, cost) => sum + cost.randomPicks, 0);
  const detours = failed.perCustomer.reduce((sum, cost) => sum + cost.detours, 0);
  const randomRate = picks > 0 ? (randomPicks + detours * 0.25) / picks : 0;
  const unfinished = failed.totalCustomers > 0
    ? 1 - failed.servedCount / failed.totalCustomers
    : 1;
  const reason = failed.loseReason ?? "deadlock";
  const workRatio = Math.max(0, failed.peakConcurrentWork ?? 0) / capacity;
  const retain = 0.85;
  const pressure = (current: number, delta: number): number =>
    bounded(current * retain + delta, 0, 3);
  const failedStrategy = canonicalStrategyName(failed.strategyName);
  const failedAdaptive = failed.strategyName?.split("+")[0] === "adaptive";
  const previousAttempts = previous.attemptedStrategies ?? [];
  const attemptedStrategies = failedStrategy && !previousAttempts.includes(failedStrategy)
    ? [...previousAttempts, failedStrategy]
    : [...previousAttempts];
  const nextWithoutRecommendation: Omit<EstimateFailureKnowledge, "recommendedStrategy"> = {
    version: 3,
    failureCount: previous.failureCount + 1,
    gridPressure: pressure(
      previous.gridPressure,
      (reason === "grid-overflow" ? 1 : 0) + Math.max(0, peakGrid - 0.7),
    ),
    dirtyPressure: pressure(
      previous.dirtyPressure,
      (reason === "dirty-overflow" ? 1 : 0) + Math.max(0, peakDirty - 0.35),
    ),
    urgencyPressure: pressure(
      previous.urgencyPressure,
      unfinished * 0.1,
    ),
    scarcityPressure: pressure(
      previous.scarcityPressure,
      (reason === "out-of-ingredient" ? 1 : 0) + (reason === "deadlock" ? 0.2 : 0),
    ),
    chainPressure: pressure(
      previous.chainPressure,
      (reason === "deadlock" ? 1 : 0) + (reason === "out-of-ingredient" ? 0.15 : 0),
    ),
    randomPressure: pressure(previous.randomPressure, bounded(randomRate, 0, 1)),
    pacingPressure: pressure(
      previous.pacingPressure ?? 0,
      ((reason === "grid-overflow" || reason === "dirty-overflow") ? 0.75 : 0) +
        Math.max(0, workRatio - 0.25),
    ),
    attemptedStrategies,
    customerPriorities: mergeFailureCustomers(
      previous.customerPriorities ?? [],
      failed.failureCustomers ?? [],
    ),
    adaptivePickInterval: failedAdaptive
      ? Math.max(1, (previous.adaptivePickInterval ?? 5) - 1)
      : Math.max(1, previous.adaptivePickInterval ?? 5),
    adaptiveFailureCount: (previous.adaptiveFailureCount ?? 0) + (failedAdaptive ? 1 : 0),
  };
  return {
    ...nextWithoutRecommendation,
    recommendedStrategy: recommendNextStrategy(nextWithoutRecommendation),
  };
}

/** Apply prior failures after the selected preset, preserving the preset as the policy baseline. */
export function applyFailureKnowledge(
  cfg: ResolvedScenario,
  knowledge: EstimateFailureKnowledge,
): ResolvedScenario {
  if (knowledge.failureCount === 0) return cfg;
  const learned: ResolvedScenario = { ...cfg, enabled: { ...cfg.enabled } };
  const grid = knowledge.gridPressure;
  const dirty = knowledge.dirtyPressure;
  const urgency = knowledge.urgencyPressure;
  const scarcity = knowledge.scarcityPressure;
  const chain = knowledge.chainPressure;
  const guessing = knowledge.randomPressure;
  const pacing = knowledge.pacingPressure ?? 0;

  learned.scoreBlocked *= bounded(1 - grid * 0.18, 0.25, 1);
  learned.scoreBlockedTight *= bounded(1 - grid * 0.25, 0.1, 1);
  learned.previewConfidence = bounded(
    learned.previewConfidence * bounded(1 - grid * 0.16, 0.2, 1),
    0,
    1,
  );
  learned.detourPenalty *= 1 + grid * 0.3 + guessing * 0.1;
  learned.detourPenaltyTight *= 1 + grid * 0.45 + dirty * 0.15;
  learned.gridTightThreshold = bounded(learned.gridTightThreshold + grid * 0.05, 0, 0.85);
  learned.pickIntervalSeconds = bounded(
    learned.pickIntervalSeconds + 0.35 * (2 ** pacing - 1),
    0,
    5,
  );

  learned.scoreSweeper *= 1 + dirty * 0.35;
  learned.scoreSweeperUrgent *= 1 + dirty * 0.65;

  learned.scoreBase *= 1 + urgency * 0.08;
  learned.scoreReady *= 1 + urgency * 0.25;
  learned.nearCompletionBonus *= 1 + urgency * 0.5;
  learned.customerPositionDecay *= 1 + urgency * 0.2;

  learned.scarcityFactor *= 1 + scarcity * 0.55;
  learned.scarcityCap *= 1 + scarcity * 0.4;

  learned.depthBonusPerLevel *= 1 + chain * 0.2;
  learned.multiInputBaseBonus *= 1 + chain * 0.25;
  learned.multiInputBonus *= 1 + chain * 0.2;
  learned.lastInputBonusMulti *= 1 + chain * 0.45;
  learned.lastInputBonusSingle *= 1 + chain * 0.3;

  learned.rowDecay = bounded(
    learned.rowDecay + (1 - learned.rowDecay) * bounded(guessing * 0.15, 0, 0.45),
    0,
    1,
  );
  return learned;
}

function retune(
  base: ResolvedScenario,
  name: string,
  patch: Partial<Record<ScenarioFieldKey, number>>,
): ScoringStrategy {
  return {
    name,
    cfg: { ...base, ...patch, enabled: { ...base.enabled } },
    workWaitStrategy: "interval",
  };
}

/**
 * Deliberately different play styles, ordered from conservative to more
 * specialised. These are retries, not blended weights: a failed run starts
 * again from the untouched level under the next strategy.
 */
function strategicPresets(base: ResolvedScenario): ScoringStrategy[] {
  return [
    retune(base, "grid-safe", {
      previewConfidence: scaled(base.previewConfidence, 0.25),
      scoreBlocked: scaled(base.scoreBlocked, 0.3),
      scoreBlockedTight: 0,
      rowDecay: scaled(base.rowDecay, 0.55),
      detourPenalty: scaled(base.detourPenalty, 1.6),
      detourPenaltyTight: scaled(base.detourPenaltyTight, 1.6),
      gridTightThreshold: Math.max(base.gridTightThreshold, 0.68),
    }),
    retune(base, "front-loaded", {
      previewConfidence: scaled(base.previewConfidence, 0.15),
      scoreBase: scaled(base.scoreBase, 1.15),
      scoreReady: scaled(base.scoreReady, 1.2),
      scoreBlocked: scaled(base.scoreBlocked, 0.25),
      rowDecay: scaled(base.rowDecay, 0.3),
      detourPenalty: scaled(base.detourPenalty, 1.35),
    }),
    retune(base, "finish-first", {
      previewConfidence: scaled(base.previewConfidence, 0.2),
      scoreReady: scaled(base.scoreReady, 1.45),
      scoreBlocked: scaled(base.scoreBlocked, 0.3),
      scoreBlockedTight: 0,
      nearCompletionBonus: scaled(base.nearCompletionBonus, 3),
      rowDecay: scaled(base.rowDecay, 0.6),
    }),
    retune(base, "chain-first", {
      previewConfidence: scaled(base.previewConfidence, 0.35),
      scoreBlocked: scaled(base.scoreBlocked, 0.55),
      depthBonusPerLevel: scaled(base.depthBonusPerLevel, 1.75),
      multiInputBaseBonus: scaled(base.multiInputBaseBonus, 1.6),
      multiInputBonus: scaled(base.multiInputBonus, 1.4),
      rowDecay: scaled(base.rowDecay, 0.7),
    }),
    retune(base, "scarcity-first", {
      previewConfidence: scaled(base.previewConfidence, 0.25),
      scarcityFactor: Math.max(base.scarcityFactor, 0.75),
      scarcityCap: Math.max(base.scarcityCap, 1.4),
      rowDecay: scaled(base.rowDecay, 0.65),
    }),
    retune(base, "single-customer", {
      previewConfidence: 0,
      scoreBlocked: scaled(base.scoreBlocked, 0.25),
      rowDecay: scaled(base.rowDecay, 0.45),
    }),
    retune(base, "wide-counter", {
      previewConfidence: scaled(base.previewConfidence, 0.2),
      scoreReady: scaled(base.scoreReady, 1.25),
      scoreBlocked: scaled(base.scoreBlocked, 0.4),
    }),
    retune(base, "no-preview", {
      previewConfidence: 0,
      scoreBlocked: scaled(base.scoreBlocked, 0.45),
      scoreBlockedTight: scaled(base.scoreBlockedTight, 0.25),
      rowDecay: scaled(base.rowDecay, 0.5),
    }),
  ];
}

function randomizedStrategy(base: ResolvedScenario, retryIndex: number, random: () => number): ScoringStrategy {
  const factor = (low: number, high: number): number => low + random() * (high - low);
  return retune(base, `random-${retryIndex + 1}`, {
    scoreBase: scaled(base.scoreBase, factor(0.7, 1.5)),
    scoreReady: scaled(base.scoreReady, factor(0.7, 1.6)),
    scoreBlocked: scaled(base.scoreBlocked, factor(0.05, 0.8)),
    scoreBlockedTight: scaled(base.scoreBlockedTight, factor(0, 0.6)),
    previewConfidence: bounded(scaled(base.previewConfidence, factor(0, 0.6)), 0, 1),
    depthBonusPerLevel: scaled(base.depthBonusPerLevel, factor(0.6, 1.9)),
    nearCompletionBonus: scaled(base.nearCompletionBonus, factor(0.4, 3.2)),
    scarcityFactor: scaled(base.scarcityFactor, factor(0.5, 4)),
    scarcityCap: scaled(base.scarcityCap, factor(0.5, 3)),
    rowDecay: bounded(factor(0.08, 0.55), 0, 1),
    detourPenalty: scaled(base.detourPenalty, factor(0.8, 2.4)),
    detourPenaltyTight: scaled(base.detourPenaltyTight, factor(0.8, 2.4)),
    gridTightThreshold: factor(0.45, 0.8),
  });
}

/** Pick the next unused preset from the strongest learned failure signal. */
function learnedPreset(
  knowledge: EstimateFailureKnowledge,
  presets: ScoringStrategy[],
  used: ReadonlySet<string>,
): ScoringStrategy | undefined {
  if (knowledge.recommendedStrategy && !used.has(knowledge.recommendedStrategy)) {
    const recommended = presets.find((candidate) => candidate.name === knowledge.recommendedStrategy);
    if (recommended) return recommended;
  }
  const pressureByPreset: [string, number][] = [
    ["grid-safe", Math.max(knowledge.gridPressure, knowledge.dirtyPressure, knowledge.pacingPressure ?? 0)],
    ["finish-first", knowledge.urgencyPressure],
    ["scarcity-first", knowledge.scarcityPressure],
    ["chain-first", knowledge.chainPressure],
    ["front-loaded", knowledge.randomPressure],
  ];
  pressureByPreset.sort((a, b) => b[1] - a[1]);
  for (const [name, pressure] of pressureByPreset) {
    if (pressure <= 0 || used.has(name)) continue;
    const preset = presets.find((candidate) => candidate.name === name);
    if (preset) return preset;
  }
  return presets.find((candidate) => !used.has(candidate.name));
}

const betterFailure = (candidate: EstimateResult, current: EstimateResult | null): boolean => {
  if (!current) return true;
  if (candidate.servedCount !== current.servedCount) return candidate.servedCount > current.servedCount;
  return candidate.totalPicks > current.totalPicks;
};

/**
 * Estimate a node level, retrying failed runs with distinct scoring sets. Every failed attempt
 * also contributes aggregate knowledge that retunes all later attempts. Simple presets are
 * exhausted before Adaptive periodically reselects among them; the final bounded search remains a
 * hard-level safety net. A successful attempt returns immediately; otherwise the closest failed
 * run is retained.
 */
export function estimateNodeDifficulty(
  ix: GraphIndex,
  level: NodeLevelConfig,
  opts: EstimateOptions = {},
): EstimateResult {
  const omniscient = opts.informationMode === "omniscient";
  const resolved = resolveScenario(opts.scenario);
  // Omniscient solvability never treats authored Hidden slots as unknown,
  // regardless of the difficulty modal's player-visibility toggle.
  const base = omniscient ? { ...resolved, hiddenStatus: false } : resolved;
  const behavior: EstimateBehavior = {
    packingMode: opts.packingMode ?? "unpacked-raw",
    toolProcessBehavior: opts.toolProcessBehavior ?? "auto",
  };
  const retryCount = Math.min(10, Math.max(0, Math.floor(opts.maxRetries ?? base.retryCount)));
  const maxIterations = opts.maxIterations ?? base.maxIterations;
  const progressFor = (run: number, runTotal: number) => {
    let furthestPicked = -1;
    return (pickedItems: number, totalItems: number): void => {
      if (pickedItems <= furthestPicked) return;
      furthestPicked = pickedItems;
      const percentage = totalItems === 0
        ? 100
        : Math.max(0, Math.min(100, (pickedItems / totalItems) * 100));
      const progress: EstimateProgress = { run, runTotal, pickedItems, totalItems, percentage };
      opts.onProgress?.(progress);
    };
  };

  if (omniscient) {
    const shortages = supplyShortages(ix, level);
    if (shortages.length > 0) {
      const strategyName = "supply-precheck";
      const result = estimateNodeDifficultyAttempt(
        ix,
        structuredClone(level),
        base,
        opts.rng ?? seededRng(base.rngSeed),
        0,
        0,
        "interval",
        undefined,
        emptyFailureKnowledge(),
        undefined,
        5,
        behavior,
        true,
      );
      result.solvable = false;
      result.reason = "Missing Recipe Pieces supply: " + shortages
        .map(({ ingredient, have, need }) => `${ingredient} has ${have}, needs ${need}`)
        .join("; ") + ".";
      result.attemptCount = 1;
      result.strategyName = strategyName;
      result.attemptedStrategyNames = [strategyName];
      result.learnedFromFailures = 0;
      result.failureKnowledge = emptyFailureKnowledge();
      result.searchLimitReached = false;
      result.searchStatesExplored = 0;
      result.searchElapsedMs = 0;
      return result;
    }

    const stateLimit = Math.max(1, Math.floor(opts.searchStatesPerDepth ?? 64));
    const normalProgress = progressFor(1, 2);
    const normalSearch = findCompleteInformationPlan(
      ix,
      structuredClone(level),
      base,
      maxIterations,
      behavior,
      stateLimit,
      false,
      normalProgress,
    );
    const settleAllSearch = normalSearch.plan ? null : (() => {
      const settleProgress = progressFor(2, 2);
      return findCompleteInformationPlan(
        ix,
        structuredClone(level),
        base,
        maxIterations,
        behavior,
        stateLimit,
        true,
        settleProgress,
      );
    })();
    const plan = normalSearch.plan ?? settleAllSearch?.plan ?? null;
    const strategyName = normalSearch.plan
      ? "complete-information-search"
      : "complete-information-search+settle-all";
    const searches = settleAllSearch ? [normalSearch, settleAllSearch] : [normalSearch];
    const statesExplored = searches.reduce((sum, search) => sum + search.expandedStates, 0);
    const elapsedMs = searches.reduce((sum, search) => sum + search.elapsedMs, 0);
    const prunedWithoutProof = !plan && searches.some((search) => search.budgetExhausted);
    const result = estimateNodeDifficultyAttempt(
      ix,
      structuredClone(level),
      base,
      opts.rng ?? seededRng(base.rngSeed),
      plan ? maxIterations : 0,
      0,
      "interval",
      plan ?? undefined,
      emptyFailureKnowledge(),
      undefined,
      5,
      behavior,
      true,
    );
    result.attemptCount = searches.length;
    result.strategyName = strategyName;
    result.attemptedStrategyNames = searches.length === 1
      ? ["complete-information-search"]
      : ["complete-information-search", "complete-information-search+settle-all"];
    result.learnedFromFailures = 0;
    result.failureKnowledge = emptyFailureKnowledge();
    result.searchLimitReached = prunedWithoutProof;
    result.searchStatesExplored = statesExplored;
    result.searchElapsedMs = elapsedMs;
    if (!plan) {
      result.solvable = false;
      result.reason = prunedWithoutProof
        ? `Normal and settle-all searches pruned bounded branches after ${statesExplored} states ` +
          `(${elapsedMs.toFixed(0)} ms); solvability is inconclusive.`
        : "No winning route was found by either normal or settle-all complete-information search.";
    }
    return result;
  }

  const presets = strategicPresets(base);
  const strategyRandom = base.enabled.rngSeed
    ? seededRng((base.rngSeed ^ 0x9e3779b9) >>> 0)
    : Math.random;
  let best: EstimateResult | null = null;
  let bestStrategy = "authored";
  let knowledge = emptyFailureKnowledge();
  const usedStrategies = new Set<string>();
  const attemptedStrategyNames: string[] = [];

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    const attemptProgress = progressFor(attempt + 1, retryCount + 1);
    // Before changing scoring weights, isolate timing as the first fallback:
    // retry the authored picker after every tool/merge chain has settled. This
    // distinguishes a cadence failure from one that needs a different route.
    const authoredWaitFallback = attempt === 1;
    const adaptive = attempt > 1 && knowledge.recommendedStrategy === "adaptive";
    const baseline = attempt === 0
      ? { name: "authored", cfg: base, workWaitStrategy: "interval" as WorkWaitStrategy }
      : authoredWaitFallback
        ? { name: "authored", cfg: base, workWaitStrategy: "wait-all" as WorkWaitStrategy }
      : adaptive
        ? { name: "adaptive", cfg: base, workWaitStrategy: "wait-all" as WorkWaitStrategy }
      : learnedPreset(knowledge, presets, usedStrategies) ??
        randomizedStrategy(base, Math.max(0, attempt - presets.length - 1), strategyRandom);
    usedStrategies.add(baseline.name);
    const attemptKnowledge = authoredWaitFallback ? emptyFailureKnowledge() : knowledge;
    let strategy = {
      name: attempt > 0 ? `${baseline.name}+wait-all` : baseline.name,
      cfg: applyFailureKnowledge(baseline.cfg, attemptKnowledge),
      workWaitStrategy: attempt > 0 ? "wait-all" as WorkWaitStrategy : baseline.workWaitStrategy,
    };
    let forcedPlan: readonly LearnedSearchStep[] | undefined;
    // The final bounded witness search uses normal configured cadence. It can
    // additionally encode deliberate waits before individual picks, rather
    // than replacing the whole route with wait-until-idle behavior.
    if (attempt > 0 && attempt === retryCount) {
      const planningConfig: ResolvedScenario = {
        ...base,
        enabled: { ...base.enabled },
      };
      const plan = findLearnedBeamPlan(
        ix,
        structuredClone(level),
        planningConfig,
        maxIterations,
        behavior,
        false,
        attemptProgress,
      ) ?? findLearnedBeamPlan(
        ix,
        structuredClone(level),
        planningConfig,
        maxIterations,
        behavior,
        true,
        attemptProgress,
      );
      if (plan) {
        strategy = {
          name: "learned-space-search+interval",
          cfg: planningConfig,
          workWaitStrategy: "interval",
        };
        forcedPlan = plan;
      }
    }
    const attemptRng = opts.rng ?? (strategy.cfg.enabled.rngSeed
      ? seededRng((strategy.cfg.rngSeed + attempt * 0x6d2b79f5) >>> 0)
      : Math.random);
    const result = estimateNodeDifficultyAttempt(
      ix,
      structuredClone(level),
      strategy.cfg,
      attemptRng,
      maxIterations,
      // Synchronized retries already diversify through their scoring preset. Randomly leaving the
      // best visible route after every full settle reintroduced the exact grid stalls this mode
      // is intended to avoid (notably Map 1 Level 25).
      forcedPlan || strategy.workWaitStrategy === "wait-all"
        ? 0
        : (attempt === 0 ? 0 : Math.min(0.35, 0.08 + attempt * 0.025)),
      strategy.workWaitStrategy,
      forcedPlan,
      attemptKnowledge,
      adaptive && !forcedPlan ? presets.map((preset) => ({
        ...preset,
        cfg: applyFailureKnowledge(preset.cfg, knowledge),
        workWaitStrategy: "wait-all" as WorkWaitStrategy,
      })) : undefined,
      knowledge.adaptivePickInterval,
      behavior,
      omniscient,
      attemptProgress,
    );
    attemptedStrategyNames.push(strategy.name);
    result.attemptCount = attempt + 1;
    result.strategyName = strategy.name;
    result.attemptedStrategyNames = [...attemptedStrategyNames];
    result.learnedFromFailures = attemptKnowledge.failureCount;
    result.failureKnowledge = { ...knowledge };
    if (result.solvable) return result;
    if (betterFailure(result, best)) {
      best = result;
      bestStrategy = strategy.name;
    }
    knowledge = accumulateFailureKnowledge(knowledge, result);
  }

  const result = best!;
  result.attemptCount = retryCount + 1;
  result.strategyName = bestStrategy;
  result.attemptedStrategyNames = [...attemptedStrategyNames];
  result.failureKnowledge = { ...knowledge };
  result.reason = `${result.reason ?? "The solver could not finish."} Tried ${retryCount + 1} scoring strategies; best run used ${bestStrategy}.`;
  return result;
}
