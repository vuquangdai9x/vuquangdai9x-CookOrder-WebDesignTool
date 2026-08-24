// Graph-native difficulty estimator. Node Design, Play, and replay must use the
// same engine; a projected legacy MapDef cannot preserve multi-input slot state.

import { CUSTOMER_STAFF } from "../../core/effects.ts";
import type { GraphIndex } from "../../core/nodeIndex.ts";
import { NodeSimulation } from "../../core/nodeSim.ts";
import type { NodeCustomerState, NodeLevelConfig } from "../../core/nodeSim.ts";
import type { QueueItem } from "../../core/types.ts";
import { cidOf } from "./changeTracking.ts";
import { resolveScenario } from "./estimateScenario.ts";
import type { ResolvedScenario } from "./estimateScenario.ts";
import type {
  CustomerCost,
  EstimateOptions,
  EstimateResult,
  EstimateSlot,
  OccupancySample,
  EstimateReplayStep,
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
}

interface DemandUnit {
  target: number;
  customerIndex: number;
  priority: number;
  base: boolean;
  multiInput: boolean;
  requirements: Map<number, number>;
}

interface PickupValue {
  score: number;
  customerIndex: number;
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

function serveableWindow(sim: NodeSimulation, cfg: ResolvedScenario): number {
  const upcoming = [...sim.active, ...sim.pending];
  if (upcoming.length < 2) return 1;
  const dishes = upcoming[0].dishes.length + upcoming[1].dishes.length;
  return dishes <= cfg.maxPairDishes ? 2 : 1;
}

/**
 * Keep the serve window in step with who is at the counter, then let pending
 * customers walk in. With the dynamic window disabled the level's own
 * serveableSlots is held fixed, but the promotion loop still has to run or the
 * counter would never refill.
 */
function syncWindow(sim: NodeSimulation, cfg: ResolvedScenario, fixedSlots: number): void {
  for (let guard = 0; guard < 8; guard++) {
    sim.level.serveableSlots = cfg.dynamicServeWindow ? serveableWindow(sim, cfg) : fixedSlots;
    if (sim.status !== "playing") return;
    if (sim.active.length >= sim.level.serveableSlots || sim.pending.length === 0) return;
    const before = sim.active.length;
    sim.tick(0);
    if (sim.active.length === before) return;
  }
}

/** Drain every flight and ready tool lane to the resting state replay uses. */
function settle(sim: NodeSimulation): void {
  for (let guard = 0; guard < 200 && sim.status === "playing"; guard++) {
    sim.completeAllFlights();
    const completion = sim.nextCompletionIn();
    if (completion === null) break;
    sim.tick(Math.max(0.01, completion));
  }
  sim.completeAllFlights();
}

function pickableLanes(sim: NodeSimulation): number[] {
  const lanes: number[] = [];
  for (let x = 0; x < sim.columnCount; x++) if (sim.canPick(x).ok) lanes.push(x);
  return lanes;
}

/** Estimate a node level with the exact simulation used by Play and replay. */
export function estimateNodeDifficulty(
  ix: GraphIndex,
  level: NodeLevelConfig,
  opts: EstimateOptions = {},
): EstimateResult {
  const cfg = resolveScenario(opts.scenario);
  const rng = opts.rng ?? (cfg.enabled.rngSeed ? seededRng(cfg.rngSeed) : Math.random);
  const maxIterations = opts.maxIterations ?? cfg.maxIterations;
  const fixedSlots = Math.max(1, level.serveableSlots ?? 1);
  const sim = new NodeSimulation(ix, level, {
    outOfSlotPolicy: level.outOfSlotPolicy ?? "block-pick",
    instantFlights: true,
  });

  const byCid = new Map<string, EstimateSlot>();
  const costs = new Map<number, CustomerCost>();
  const occupancyHistory: OccupancySample[] = [];
  const replaySteps: EstimateReplayStep[] = [];
  let currentReplayLaneScores: (number | null)[] = [];
  let counter = 0;
  let iterations = 0;
  let halted: string | undefined;

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
    sim.active.forEach((customer, customerPosition) => {
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
          units.push({
            target: slot.ing,
            customerIndex: customer.index,
            priority,
            base,
            multiInput,
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
        });
        claims.set(leaf, list);
      }
    }
    for (const list of claims.values()) list.sort((a, b) => b.priority - a.priority);

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
      values.set(ing, { score, customerIndex });
    }
    return values;
  };

  let pickupValues = new Map<number, PickupValue>();

  const costFor = (index: number): CustomerCost => {
    let cost = costs.get(index);
    if (!cost) {
      cost = { index, gridOccupied: 0, gridWaste: 0, picks: 0, detours: 0 };
      costs.set(index, cost);
    }
    return cost;
  };

  const sweeperValue = (): number => {
    const { dirty } = countGrid();
    if (dirty === 0) return 0;
    return gridTight ? cfg.scoreSweeperUrgent : cfg.scoreSweeper;
  };

  const valueOfCell = (x: number, y: number): { score: number; customerIndex: number } => {
    const cell = sim.queueGrid[x]?.[y];
    if (!cell) return { score: 0, customerIndex: -1 };
    if (cell.item.kind === "sweeper") return { score: sweeperValue(), customerIndex: -1 };
    return pickupValues.get(cell.ing) ?? { score: 0, customerIndex: -1 };
  };

  const scoreLane = (x: number, depth: number) => {
    // Score what this click ACTUALLY picks first. Combined/linked instances can
    // advance several requirements at once, so their values add instead of
    // silently keeping only one member.
    let immediate = 0;
    let immediateCustomer = -1;
    let strongestImmediate = 0;
    let footprint = 0;
    for (const cell of sim.pickTargets(x)) {
      const value = valueOfCell(cell.x, cell.y);
      immediate += value.score;
      if (value.score > strongestImmediate) {
        strongestImmediate = value.score;
        immediateCustomer = value.customerIndex;
      }
      const queued = sim.queueGrid[cell.x]?.[cell.y];
      if (queued?.item.kind === "ingredient") footprint += Math.max(1, ix.terminalYield[queued.ing] ?? 1);
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
      if (!cell || (cfg.hiddenStatus && sim.isHidden(x, y))) continue;
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
  ): boolean => {
    const cells = sim.pickTargets(lane);
    if (cells.length === 0) return false;
    const items = cells
      .map((cell) => sim.queueGrid[cell.x]?.[cell.y])
      .filter((cell): cell is NonNullable<typeof cell> => cell !== null);
    const activeBefore = new Set(sim.active.map((customer) => customer.index));
    if (!sim.pick(lane)) return false;
    replaySteps.push({
      lane,
      serveableSlots: sim.level.serveableSlots,
      laneScores: [...currentReplayLaneScores],
    });

    counter++;
    for (const cell of items) {
      const cid = cidOf(cell.item);
      if (cid) byCid.set(cid, { order: counter, customerIndex, detour });
    }
    const cost = costFor(customerIndex);
    cost.picks++;
    if (detour) cost.detours++;
    settle(sim);
    syncWindow(sim, cfg, fixedSlots);
    const stillActive = new Set(sim.active.map((customer) => customer.index));
    occupancyHistory.push({
      ...sampleOccupancy(),
      score,
      random,
      pickedNames: items.map((cell) => nameOfItem(cell.item, cell.ing)),
      completesCustomers: [...activeBefore].filter((index) => !stillActive.has(index)),
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

  settle(sim);
  syncWindow(sim, cfg, fixedSlots);

  while (sim.status === "playing" && iterations < maxIterations) {
    iterations++;
    measure();
    gridTight = countGrid().free <= sim.grid.length * cfg.gridTightThreshold;
    pickupValues = buildPickupValues();
    const lanes = pickableLanes(sim);
    if (lanes.length === 0) {
      if (sim.fastForward() === 0) {
        halted = "Nothing left to pick and nothing cooking — the queues ran dry.";
        break;
      }
      syncWindow(sim, cfg, fixedSlots);
      continue;
    }

    const depth = Math.max(1, ix.doc.map.visibleRows);
    const pickable = new Set(lanes);
    const scoresByLane = sim.queueGrid.map((_, lane) =>
      pickable.has(lane) ? scoreLane(lane, depth) : null,
    );
    currentReplayLaneScores = scoresByLane.map((value) => value?.score ?? null);
    let best = { lane: -1, score: 0, customerIndex: -1, fromFront: false };
    for (const lane of lanes) {
      const candidate = scoresByLane[lane]!;
      if (candidate.score > best.score) best = { lane, ...candidate };
    }

    if (best.lane !== -1) {
      const owner = best.customerIndex >= 0
        ? best.customerIndex
        : (sim.active.find(isOrdering)?.index ?? sim.active[0]?.index ?? 0);
      if (!take(best.lane, owner, !best.fromFront, best.score, false)) break;
      measure();
      continue;
    }

    const fallbackOwner = sim.active.find(isOrdering)?.index ?? sim.active[0]?.index ?? 0;
    let fallback = lanes[Math.floor(rng() * lanes.length)];
    if (gridTight) {
      let cheapestYield = Infinity;
      for (const lane of lanes) {
        const cell = sim.frontCell(lane);
        if (!cell) continue;
        const yieldAmount = cell.item.kind === "sweeper" ? -1 : (ix.terminalYield[cell.ing] ?? 1);
        if (yieldAmount < cheapestYield) {
          cheapestYield = yieldAmount;
          fallback = lane;
        }
      }
    }
    if (!take(fallback, fallbackOwner, true, 0, true)) break;
    measure();
  }

  const bailed = sim.status === "playing" && !halted;
  const lost = sim.status === "lost";
  let reason = halted;
  if (!reason && lost) {
    reason = sim.loseReason === "grid-overflow"
      ? "The grid filled up — no free cell for a finished ingredient."
      : sim.loseReason === "dirty-overflow"
        ? "The grid filled up with dirty dishes."
        : sim.loseReason === "customer-timeout"
          ? "A customer's patience ran out."
          : "The queues ran out of ingredients before every order was filled.";
  }
  if (!reason && bailed) reason = `Gave up after ${maxIterations} picks without finishing.`;

  return {
    solvable: sim.status === "won",
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
  };
}
