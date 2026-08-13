// "Estimate Difficulty" — a Design-mode solver that plays the level the way a
// competent-but-not-omniscient player would, and reports how much grid
// pressure each customer costs. Replaces the older "Auto-calculate assigned
// ingredient" heuristic, which only matched queue items to customers by
// counting and modelled none of the real rules.
//
// This drives the REAL Simulation (src/core/sim.ts), so tool slots, cooking
// times, chained recipes, baseId ordering, usageNum multi-serve, direct-serve
// and grid overflow all behave exactly as they do in Play mode — including
// the requirement that a landing ingredient is matched against *every*
// serveable dish, not just the one being worked on (Simulation.autoServe
// already walks all active customers and all their dishes).
//
// What's heuristic is only the *choice* of which lane to pick:
//
//   1. Recompute the serveable window (below) whenever a customer completes.
//   2. Score every pickable lane against every serveable dish at once:
//        - a base ingredient a dish still needs        -> great
//        - a topping whose base is already in the dish -> great
//        - a topping whose base isn't down yet         -> considerable
//      A match found in a lookahead row scores the same, decayed once per row
//      below the front, so digging two deep for a great item can still beat
//      taking a merely-considerable one off the top.
//   3. Pick the highest-scoring lane. If its winning match was buried rather
//      than fronting, the pick is a "detour" — we spent it digging.
//   4. If nothing scores, spend a pick keeping the queues flowing.
//   5. If the grid overflows, halt and report the level unsolvable.
//
// Every pick is stamped with a global pickup counter and the customer it was
// made for; queueSection.ts renders those as a per-tile order badge and
// customer colour. Results are keyed by `_cid` (see changeTracking.ts), which
// survives the structuredClone the caller uses to isolate the live draft.

import { CUSTOMER_STAFF } from "../../core/effects.ts";
import { Simulation } from "../../core/sim.ts";
import type { CustomerState, LoseReason } from "../../core/sim.ts";
import { findToolRecipe, resolveCookedId } from "../../core/types.ts";
import type { Id, LevelConfig, MapDef, QueueItem } from "../../core/types.ts";
import { cidOf } from "./changeTracking.ts";

/** What one queue tile turned out to be worth, once the solver got to it. */
export interface EstimateSlot {
  /** Global pickup order, starting at 1 — the number shown on the tile. */
  order: number;
  /** Index into the customer list this pick was made for; drives the tile colour. */
  customerIndex: number;
  /**
   * True when this pick wasn't itself wanted — it was spent digging toward a
   * buried ingredient, or keeping the queues flowing because nothing
   * reachable scored. These are what drive grid waste.
   */
  detour: boolean;
}

/** Per-customer cost of getting their order out. */
export interface CustomerCost {
  index: number;
  /**
   * Peak grid cells holding something this customer's order needs — including
   * pieces that can't be served yet because their base isn't down (a patty
   * waiting on a bun, ice waiting on a cup).
   */
  gridOccupied: number;
  /** Peak grid cells holding something this customer's order does NOT need. */
  gridWaste: number;
  /** How many picks were attributed to this customer. */
  picks: number;
  /** Of those, how many were digging/flow picks rather than a wanted ingredient. */
  detours: number;
}

/** Grid pressure snapshot taken right after one pick has fully settled. */
export interface OccupancySample {
  /** Total grid cells not empty — cooked, parked raw, or dirty stacks alike. */
  occupied: number;
  /** Of those, how many are dirty stacks specifically. */
  dirty: number;
  /**
   * The score `scoreLane()` gave this pick's winning match — 0 when `random`
   * is true (nothing scored anything, see estimateDifficulty()'s step 4).
   * Lets a caller (occupancyChart.ts) shade each pick by how confident the
   * solver was in it, relative to the rest of the run.
   */
  score: number;
  /** True when this pick came from the score-less fallback — the solver had nothing relevant reachable and just kept the queues moving. */
  random: boolean;
  /** Name of the ingredient(s)/sweeper this pick consumed — for the chart's hover tooltip. Usually one entry; more when a combined/linked block was picked as one. */
  pickedNames: string[];
  /** Customer index(es) whose order was fully served as a result of this pick, if any — drives the chart's per-completion marker. Usually empty or one entry. */
  completesCustomers: number[];
}

export interface EstimateResult {
  solvable: boolean;
  /** Present when `solvable` is false — why the solver gave up. */
  reason?: string;
  loseReason?: LoseReason | null;
  totalPicks: number;
  servedCount: number;
  totalCustomers: number;
  byCid: Map<string, EstimateSlot>;
  perCustomer: CustomerCost[];
  /**
   * Grid pressure after each pick, in pickup order — occupancyHistory[i] is
   * the state right after pick #(i+1) (see byCid's 1-based `order`). Powers
   * customerSection.ts's occupancy chart. Length equals totalPicks.
   */
  occupancyHistory: OccupancySample[];
  /** Total grid cells this level's board has — the chart's y-axis ceiling and the line at which the run would overflow. */
  gridCapacity: number;
}

export interface EstimateOptions {
  /** Overrides the default seeded PRNG used to break ties between useless picks. */
  rng?: () => number;
  /** Safety valve against a pathological level; default 5000. */
  maxIterations?: number;
}

const DEFAULT_MAX_ITERATIONS = 5000;
/** Bound on draining cooking between picks — far above any real tool chain. */
const SETTLE_GUARD = 200;

/**
 * Two customers may be serveable at once only while their orders together are
 * small; past that the window narrows to one so a designer sees the same
 * pressure a player would. Recomputed on init and whenever a customer leaves.
 */
const MAX_PAIR_DISHES = 5;

/**
 * An ingredient a dish still needs and that nothing has to come before.
 * Exported as the ceiling occupancyChart.ts normalizes its tint gradient
 * against: a pick scoring at or above this is one of the "2 best scenarios"
 * (this, or SCORE_READY below) and reads as fully clear/no tint there.
 */
export const SCORE_BASE = 100;
/** A topping whose base is already down, so it can be served the moment it lands. */
const SCORE_READY = 100;
/** A topping the dish wants but can't accept yet — worth fetching, but not first. */
const SCORE_BLOCKED = 40;
/**
 * ...and barely worth anything once the grid is nearly full. A blocked
 * topping occupies its cell until its base shows up, so fetching one under
 * pressure is how a board deadlocks: the grid jams, and then a served
 * customer's dirty plate has nowhere to land.
 */
const SCORE_BLOCKED_TIGHT = 5;
/**
 * A sweeper while dirty stacks are on the board. Sits between a blocked
 * topping and a ready ingredient: clearing dirt isn't progress toward an
 * order, but it is real work — and on a tight grid it's the only thing
 * standing between the level and a dirty-overflow loss.
 */
const SCORE_SWEEPER = 60;
/** ...and it outranks everything once the grid is under pressure. */
const SCORE_SWEEPER_URGENT = 120;
/** Multiplied in once per row below the front, so shallow beats deep, all else equal. */
const ROW_DECAY = 0.5;

/**
 * The default RNG is deliberately a fixed-seed PRNG, not Math.random: a
 * designer clicking Estimate Difficulty twice on an unchanged level must get
 * the same verdict and the same pickup numbers, or the readout is impossible
 * to reason about. Randomness here only breaks ties between equally-useless
 * fallback picks; it isn't meant to sample a distribution.
 */
function seededRng(seed = 0x5eed): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const isOrdering = (c: CustomerState): boolean => c.config.typeId !== CUSTOMER_STAFF;

/**
 * How many customers should be serveable right now: two when the next two
 * orders total at most MAX_PAIR_DISHES dishes, otherwise one.
 */
function serveableWindow(sim: Simulation): number {
  const upcoming = [...sim.active, ...sim.pending];
  if (upcoming.length < 2) return 1;
  const dishes = upcoming[0].dishes.length + upcoming[1].dishes.length;
  return dishes <= MAX_PAIR_DISHES ? 2 : 1;
}

/**
 * Applies the window to the sim and lets it admit customers under the new
 * value. `tick(0)` is the public way to reach Simulation's private settle()
 * (which is what calls fillSlots) without advancing any timer.
 */
function syncWindow(sim: Simulation): void {
  for (let guard = 0; guard < 8; guard++) {
    sim.level.serveableSlots = serveableWindow(sim);
    if (sim.status !== "playing") return;
    if (sim.active.length >= sim.level.serveableSlots || sim.pending.length === 0) return;
    const before = sim.active.length;
    sim.tick(0);
    if (sim.active.length === before) return;
  }
}

/** Drains every in-progress cooking step so the board has settled before the next decision. */
function settle(sim: Simulation): void {
  let guard = SETTLE_GUARD;
  while (guard-- > 0 && sim.status === "playing") {
    if (sim.fastForward() === 0) break;
  }
}

export function estimateDifficulty(
  map: MapDef,
  level: LevelConfig,
  opts: EstimateOptions = {},
): EstimateResult {
  const rng = opts.rng ?? seededRng();
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const baseOf = new Map(map.cookedIngredients.map((c) => [c.id, c.baseId]));

  const sim = new Simulation(map, level, {
    outOfSlotPolicy: level.outOfSlotPolicy ?? "block-pick",
    instantFlights: true,
  });

  const byCid = new Map<string, EstimateSlot>();
  const costs = new Map<number, CustomerCost>();
  const occupancyHistory: OccupancySample[] = [];
  let counter = 0;
  let iterations = 0;
  let halted: string | undefined;

  /** One point on the occupancy chart — the board's state once a pick has fully settled. */
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

  /**
   * True from half-full onward, not just when nearly jammed: a chopping-board
   * pick drops TWO pieces at once, so the room has to already be there.
   * Recomputed once per decision and read by the scorers, so "is this pick
   * safe right now?" is part of the score rather than an afterthought.
   */
  let gridTight = false;
  const countGrid = (): { free: number; dirty: number } => {
    let free = 0;
    let dirty = 0;
    for (const cell of sim.grid) {
      if (cell.kind === "empty") free++;
      else if (cell.kind === "dirty") dirty++;
    }
    return { free, dirty };
  };

  /**
   * Cooked ids the serveable dishes still need *beyond what's already coming*:
   * demand minus everything on the grid, in flight, or cooking. Without this
   * the solver happily fetches a third tomato for a dish that wanted one,
   * and since a chopping-board pick yields two pieces at a time, a 10-cell
   * grid jams long before the orders are filled.
   */
  let outstanding = new Map<Id, number>();
  const computeOutstanding = (): Map<Id, number> => {
    const need = new Map<Id, number>();
    for (const customer of sim.active) {
      if (!isOrdering(customer)) continue;
      for (const dish of customer.dishes) {
        for (const id of dish.remaining) need.set(id, (need.get(id) ?? 0) + 1);
      }
    }
    // Supply already in the pipeline.
    for (const cell of sim.grid) {
      if (cell.kind === "cooked" && need.has(cell.cookedId)) {
        need.set(cell.cookedId, need.get(cell.cookedId)! - (cell.usesLeft ?? 1));
      }
    }
    for (const flight of sim.flights) {
      if (need.has(flight.itemId)) need.set(flight.itemId, need.get(flight.itemId)! - 1);
    }
    for (const tool of sim.tools) {
      for (const slot of tool.slots) {
        const item = slot.item;
        if (!item) continue;
        const recipe = tool.def.recipes.find((r) => r.in === item.rawId);
        const out = item.chain?.out ?? recipe?.out ?? item.rawId;
        if (!need.has(out)) continue;
        need.set(out, need.get(out)! - (item.chain?.amount ?? recipe?.amount ?? 1));
      }
    }
    return need;
  };

  const costFor = (index: number): CustomerCost => {
    let c = costs.get(index);
    if (!c) {
      c = { index, gridOccupied: 0, gridWaste: 0, picks: 0, detours: 0 };
      costs.set(index, c);
    }
    return c;
  };

  /**
   * What a cooked id is worth to the dishes that are serveable *right now*,
   * across every active customer — plus which customer wants it most, for
   * attribution. 0 means nothing serveable wants it.
   */
  const valueOf = (cookedId: Id): { score: number; customerIndex: number } => {
    let score = 0;
    let customerIndex = -1;
    // Enough of this is already on the grid or on its way — another one would
    // only take up a cell.
    if ((outstanding.get(cookedId) ?? 0) <= 0) return { score, customerIndex };
    for (const customer of sim.active) {
      if (!isOrdering(customer)) continue;
      for (const dish of customer.dishes) {
        if (!dish.remaining.includes(cookedId)) continue;
        const base = baseOf.get(cookedId);
        let s: number;
        if (base === undefined) {
          s = SCORE_BASE;
        } else {
          const options = Array.isArray(base) ? base : [base];
          s = options.some((b) => dish.filled.includes(b))
            ? SCORE_READY
            : gridTight
              ? SCORE_BLOCKED_TIGHT
              : SCORE_BLOCKED;
        }
        if (s > score) {
          score = s;
          customerIndex = customer.index;
        }
      }
    }
    return { score, customerIndex };
  };

  /**
   * What clearing the oldest dirty stack is worth right now. Nothing while the
   * grid is clean; urgent once there's barely anywhere left to land an
   * ingredient, which is the situation that ends runs as `dirty-overflow`.
   */
  const sweeperValue = (): number => {
    const { dirty } = countGrid();
    if (dirty === 0) return 0;
    return gridTight ? SCORE_SWEEPER_URGENT : SCORE_SWEEPER;
  };

  /** What one queue item is worth, whichever kind it is. */
  const valueOfItem = (item: QueueItem): { score: number; customerIndex: number } => {
    if (item.kind === "sweeper") return { score: sweeperValue(), customerIndex: -1 };
    return valueOf(resolveCookedId(map.tools, map.rawIngredients, item.id));
  };

  /**
   * The best thing reachable down one lane. A match in row y is decayed by
   * ROW_DECAY^y, because getting at it costs y extra picks — that's what makes
   * "dig two deep for a base" comparable to "take a blocked topping off the top".
   */
  const scoreLane = (x: number, depth: number) => {
    let score = 0;
    let customerIndex = -1;
    let fromFront = false;
    for (let y = 0; y < depth; y++) {
      const item = sim.queueGrid[x]?.[y]?.item;
      if (!item) continue;
      const v = valueOfItem(item);
      if (v.score === 0) continue;
      const decayed = v.score * ROW_DECAY ** y;
      if (decayed > score) {
        score = decayed;
        customerIndex = v.customerIndex;
        fromFront = y === 0;
      }
    }
    return { score, customerIndex, fromFront };
  };

  /**
   * One pick, stamped onto every tile it consumed. A combined or linked block
   * is a single pick spanning several tiles, and they all share one counter
   * value — the requirement that grouped slots read as one pickup.
   *
   * The items are captured before pick() (which empties those cells) but only
   * stamped after it succeeds, so a rejected pick never burns a counter value.
   */
  /** Human-readable label for a queue tile — the chart's hover tooltip, never gameplay-relevant. */
  const nameOfItem = (item: QueueItem): string =>
    item.kind === "sweeper"
      ? "Sweeper"
      : (map.rawIngredients.find((r) => r.id === item.id)?.name ?? `#${item.id}`);

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
      .map((c) => sim.queueGrid[c.x]?.[c.y]?.item)
      .filter((i): i is QueueItem => !!i);

    // Snapshot who's up before the pick lands, so completeCustomer()'s
    // splice out of sim.active — the only way a customer leaves it — can be
    // diffed afterward without depending on sim.events' 200-entry cap.
    const activeBefore = new Set(sim.active.map((c) => c.index));

    if (!sim.pick(lane)) return false;

    counter++;
    for (const item of items) {
      const cid = cidOf(item);
      if (cid) byCid.set(cid, { order: counter, customerIndex, detour });
    }
    const cost = costFor(customerIndex);
    cost.picks++;
    if (detour) cost.detours++;
    settle(sim);
    syncWindow(sim);
    const stillActive = new Set(sim.active.map((c) => c.index));
    const completesCustomers = [...activeBefore].filter((idx) => !stillActive.has(idx));
    // Sampled once the pick has fully settled (cooking drained, window
    // resynced), so the chart shows the board's resting state after each
    // pick rather than a mid-flight snapshot.
    occupancyHistory.push({
      ...sampleOccupancy(),
      score,
      random,
      pickedNames: items.map(nameOfItem),
      completesCustomers,
    });
    return true;
  };

  /**
   * Re-measures peak grid pressure from every serveable customer's point of
   * view — with two orders up at once, the same cell is "occupied" for the
   * customer that wants it and "waste" for the one that doesn't.
   */
  const measure = (): void => {
    for (const customer of sim.active) {
      if (!isOrdering(customer)) continue;
      const needed = new Set<Id>();
      for (const dish of customer.dishes) for (const id of dish.remaining) needed.add(id);

      let occupied = 0;
      let waste = 0;
      for (const cell of sim.grid) {
        let cooked: Id | null = null;
        if (cell.kind === "cooked") cooked = cell.cookedId;
        else if (cell.kind === "raw") cooked = resolveCookedId(map.tools, map.rawIngredients, cell.rawId);
        else continue;
        if (needed.has(cooked)) occupied++;
        else waste++;
      }
      const cost = costFor(customer.index);
      cost.gridOccupied = Math.max(cost.gridOccupied, occupied);
      cost.gridWaste = Math.max(cost.gridWaste, waste);
    }
  };

  settle(sim);
  syncWindow(sim);

  while (sim.status === "playing" && iterations < maxIterations) {
    iterations++;
    measure();
    gridTight = countGrid().free * 2 <= sim.grid.length;
    outstanding = computeOutstanding();

    const lanes = pickableLanes(sim);
    if (lanes.length === 0) {
      if (sim.fastForward() === 0) {
        halted = "Nothing left to pick and nothing cooking — the queues ran dry.";
        break;
      }
      syncWindow(sim);
      continue;
    }

    const depth = Math.max(1, map.visibleRows);
    let best = { lane: -1, score: 0, customerIndex: -1, fromFront: false };
    for (const x of lanes) {
      const s = scoreLane(x, depth);
      if (s.score > best.score) {
        best = { lane: x, score: s.score, customerIndex: s.customerIndex, fromFront: s.fromFront };
      }
    }

    if (best.lane !== -1) {
      // A sweeper belongs to no order, so it's booked against whoever is up.
      const owner =
        best.customerIndex >= 0
          ? best.customerIndex
          : (sim.active.find(isOrdering)?.index ?? sim.active[0]?.index ?? 0);
      // A buried winner means this pick is spent digging toward it, not on
      // the thing we actually want — that's what makes it a detour.
      if (!take(best.lane, owner, !best.fromFront, best.score, false)) break;
      measure();
      continue;
    }

    // Nothing serveable wants anything reachable, so this pick only exists to
    // keep the queues moving. Spend the cheapest one: a chopping-board pick
    // drops TWO pieces on the grid, and on a level like a frozen-key order
    // (where the wanted item is unpickable for several turns) a run of
    // two-piece fallbacks is exactly what jams the board and ends the run.
    const fallbackOwner = sim.active.find(isOrdering)?.index ?? sim.active[0]?.index ?? 0;
    let fallback = lanes[Math.floor(rng() * lanes.length)];
    if (gridTight) {
      // While the grid is genuinely roomy, holding out for the smallest item
      // just starves the queues, so footprint only decides it under pressure.
      let cheapestYield = Infinity;
      for (const x of lanes) {
        const item = sim.frontCell(x)?.item;
        if (!item) continue;
        // A sweeper frees a cell instead of filling one — always cheapest.
        const y = item.kind === "sweeper"
          ? -1
          : (findToolRecipe(map.tools, item.id)?.recipe.amount ?? 1);
        if (y < cheapestYield) {
          cheapestYield = y;
          fallback = x;
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
    reason =
      sim.loseReason === "grid-overflow"
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
  };
}

/**
 * Green→red for a 0..1 severity ratio — used by customerSection.ts's
 * per-customer difficulty bar. A straight hue sweep (green 120° to red 0°)
 * rather than a lightness/opacity ramp, so the color reads at a glance
 * without needing to compare bars side by side.
 */
export function difficultyColor(ratio: number): string {
  const clamped = Math.min(1, Math.max(0, ratio));
  const hue = 120 * (1 - clamped);
  return `hsl(${hue.toFixed(0)}, 70%, 45%)`;
}

/**
 * How severe one customer's peak grid footprint is, relative to the worst
 * customer *in the same level* — not the board's raw capacity. A single
 * customer's own order almost never fills the whole board (two customers
 * share it, alongside waste and dirty stacks), so scaling against total grid
 * cells left every bar clustered in green/yellow with no real customer ever
 * reading red. Scaling against this level's own worst offender instead
 * guarantees the color always spans the full range: the hardest customer in
 * any given level reads true red, an untouched one reads true green.
 */
export function difficultyRatio(occupied: number, perCustomer: CustomerCost[]): number {
  const worst = perCustomer.reduce((n, c) => Math.max(n, c.gridOccupied), 0);
  return worst > 0 ? occupied / worst : 0;
}

/**
 * Lanes whose fronting instance can be picked right now, deduped by group so
 * a combined/linked block spanning several columns is offered once.
 */
function pickableLanes(sim: Simulation): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (let x = 0; x < sim.columnCount; x++) {
    const front = sim.frontCell(x);
    if (!front) continue;
    if (front.group !== -1) {
      if (seen.has(front.group)) continue;
      seen.add(front.group);
    }
    if (sim.canPick(x).ok) out.push(x);
  }
  return out;
}
