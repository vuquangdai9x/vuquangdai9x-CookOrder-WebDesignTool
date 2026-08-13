// "Estimate Difficulty" — a Design-mode solver that plays the level the way a
// competent-but-not-omniscient player would, and reports how much grid
// pressure each customer costs. Replaces the older "Auto-calculate assigned
// ingredient" heuristic, which only matched queue items to customers by
// counting and modelled none of the real rules.
//
// This drives the REAL Simulation (src/core/sim.ts), so tool slots, cooking
// times, chained recipes, baseId ordering, usageNum multi-serve, direct-serve
// and grid overflow all behave exactly as they do in Play mode. What's
// heuristic is only the *choice* of which lane to pick, per the algorithm
// below:
//
//   for each customer, in arrival order:
//     for each of their dishes, in order:
//       - look along the FRONT row for something this dish still needs
//         (bases first, so toppings aren't stranded), and pick it
//       - otherwise look into the lookahead rows (2nd/3rd, per the map's
//         visibleRows). If a needed item is buried at (x, y), pick lane x's
//         front to dig toward it — those digging picks are "detours"
//       - otherwise pick at random, to keep the queues flowing
//       - if the grid overflows, halt and report the level unsolvable
//
// Every pick is stamped with a global pickup counter and the customer it was
// made for; queueSection.ts renders those as a per-tile order badge and
// customer colour. Results are keyed by `_cid` (see changeTracking.ts), which
// survives the structuredClone the caller uses to isolate the live draft.

import { CUSTOMER_STAFF } from "../../core/effects.ts";
import { Simulation } from "../../core/sim.ts";
import type { LoseReason } from "../../core/sim.ts";
import { resolveCookedId } from "../../core/types.ts";
import type { CookedIngredientDef, Id, LevelConfig, MapDef, QueueItem } from "../../core/types.ts";
import { cidOf } from "./changeTracking.ts";

/** What one queue tile turned out to be worth, once the solver got to it. */
export interface EstimateSlot {
  /** Global pickup order, starting at 1 — the number shown on the tile. */
  order: number;
  /** Index into the customer list this pick was made for; drives the tile colour. */
  customerIndex: number;
  /**
   * True when this pick wasn't itself wanted — it was made to dig toward a
   * buried ingredient, or at random because nothing useful was reachable.
   * These are what drive grid waste.
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
  /** How many picks were spent while this customer was the target. */
  picks: number;
  /** Of those, how many were digging/random picks rather than wanted ingredients. */
  detours: number;
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
}

export interface EstimateOptions {
  /** Overrides the default seeded PRNG used by the random fallback. */
  rng?: () => number;
  /** Safety valve against a pathological level; default 5000. */
  maxIterations?: number;
}

const DEFAULT_MAX_ITERATIONS = 5000;

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
/** Bound on draining cooking between picks — far above any real tool chain. */
const SETTLE_GUARD = 200;

/** Raw ingredient ids that eventually become each cooked id. */
function rawsByCooked(map: MapDef): Map<Id, Id[]> {
  const out = new Map<Id, Id[]>();
  for (const raw of map.rawIngredients) {
    const cooked = resolveCookedId(map.tools, map.rawIngredients, raw.id);
    const bucket = out.get(cooked);
    if (bucket) bucket.push(raw.id);
    else out.set(cooked, [raw.id]);
  }
  return out;
}

const defOf = (map: MapDef, cookedId: Id): CookedIngredientDef | undefined =>
  map.cookedIngredients.find((c) => c.id === cookedId);

/**
 * Orders a dish's outstanding ingredients so the solver reaches for a base
 * before the toppings that depend on it. Without this the solver happily
 * fetches four toppings that can't be served, filling the grid with
 * base-blocked pieces — which is exactly the failure the old heuristic
 * couldn't see.
 */
function prioritize(map: MapDef, remaining: Id[], filled: Id[]): Id[] {
  const rank = (id: Id): number => {
    const base = defOf(map, id)?.baseId;
    if (base === undefined) return 0; // a base itself, or needs nothing — always first
    const options = Array.isArray(base) ? base : [base];
    return options.some((b) => filled.includes(b)) ? 1 : 2; // servable now, else blocked
  };
  return [...remaining].sort((a, b) => rank(a) - rank(b));
}

/** Cooked ids a customer still needs across every one of their dishes. */
function neededByCustomer(dishes: { remaining: Id[] }[]): Set<Id> {
  const set = new Set<Id>();
  for (const dish of dishes) for (const id of dish.remaining) set.add(id);
  return set;
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

const produces = (item: QueueItem | undefined, rawIds: Id[]): boolean =>
  !!item && item.kind === "ingredient" && rawIds.includes(item.id);

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
  const rawsFor = rawsByCooked(map);

  const sim = new Simulation(map, level, {
    outOfSlotPolicy: level.outOfSlotPolicy ?? "block-pick",
    instantFlights: true,
  });

  const byCid = new Map<string, EstimateSlot>();
  const costs = new Map<number, CustomerCost>();
  let counter = 0;
  let iterations = 0;
  let halted: string | undefined;

  const costFor = (index: number): CustomerCost => {
    let c = costs.get(index);
    if (!c) {
      c = { index, gridOccupied: 0, gridWaste: 0, picks: 0, detours: 0 };
      costs.set(index, c);
    }
    return c;
  };

  /**
   * One pick, stamped onto every tile it consumed. A combined or linked block
   * is a single pick spanning several tiles, and they all share one counter
   * value — the requirement that grouped slots read as one pickup.
   *
   * The items are captured before pick() (which empties those cells) but only
   * stamped after it succeeds, so a rejected pick never burns a counter value.
   */
  const take = (lane: number, customerIndex: number, detour: boolean): boolean => {
    const cells = sim.pickTargets(lane);
    if (cells.length === 0) return false;
    const items = cells
      .map((c) => sim.queueGrid[c.x]?.[c.y]?.item)
      .filter((i): i is QueueItem => !!i);

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
    return true;
  };

  /** Re-measures peak grid pressure from the target customer's point of view. */
  const measure = (customerIndex: number, needed: Set<Id>): void => {
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
    const cost = costFor(customerIndex);
    cost.gridOccupied = Math.max(cost.gridOccupied, occupied);
    cost.gridWaste = Math.max(cost.gridWaste, waste);
  };

  settle(sim);

  while (sim.status === "playing" && iterations < maxIterations) {
    iterations++;

    // The customer we're working for: the earliest active non-staff order.
    // Staff clear dirty stacks on arrival and need nothing fetched.
    const target = sim.active.find((c) => c.config.typeId !== CUSTOMER_STAFF);
    if (!target) {
      // Only staff (or nobody) is serveable — keep the queues moving so the
      // next real customer can come forward.
      const lanes = pickableLanes(sim);
      if (lanes.length === 0) {
        if (sim.fastForward() === 0) {
          halted = "Nothing left to pick and nothing cooking — the queues ran dry.";
          break;
        }
        continue;
      }
      if (!take(lanes[Math.floor(rng() * lanes.length)], sim.active[0]?.index ?? 0, true)) break;
      continue;
    }

    const needed = neededByCustomer(target.dishes);
    measure(target.index, needed);

    // Work the first unfinished dish, in priority order so a base is always
    // fetched before the toppings that are stuck behind it.
    const dish = target.dishes.find((d) => d.remaining.length > 0);
    const wanted = dish ? prioritize(map, dish.remaining, dish.filled) : [...needed];

    const lanes = pickableLanes(sim);

    // 1. Highest-priority ingredient that's already at the front. The loop is
    //    over `wanted` (not over lanes) precisely so priority wins over lane order.
    let direct: number | undefined;
    for (const cookedId of wanted) {
      const raws = rawsFor.get(cookedId);
      if (!raws) continue;
      direct = lanes.find((x) => produces(sim.frontCell(x)?.item, raws));
      if (direct !== undefined) break;
    }
    if (direct !== undefined) {
      if (!take(direct, target.index, false)) break;
      measure(target.index, needed);
      continue;
    }

    // 2. Buried in a lookahead row — dig toward it by picking its lane's
    //    front. Highest-priority ingredient first, then the shallowest one;
    //    the front item we pick isn't what we want, so it's a detour.
    const depth = Math.max(1, map.visibleRows);
    let dig: number | undefined;
    for (const cookedId of wanted) {
      const raws = rawsFor.get(cookedId);
      if (!raws) continue;
      let digDepth = Infinity;
      for (let y = 1; y < depth; y++) {
        for (let x = 0; x < sim.columnCount; x++) {
          if (!produces(sim.queueGrid[x]?.[y]?.item, raws)) continue;
          if (y < digDepth && lanes.includes(x)) {
            dig = x;
            digDepth = y;
          }
        }
      }
      if (dig !== undefined) break;
    }
    if (dig !== undefined) {
      if (!take(dig, target.index, true)) break;
      measure(target.index, needed);
      continue;
    }

    // 3. Nothing reachable is useful. Let cooking land first if it can —
    //    the piece we're waiting on may already be in a tool.
    if (lanes.length === 0) {
      if (sim.fastForward() === 0) {
        halted = "Nothing pickable and nothing cooking — this order can't be completed.";
        break;
      }
      continue;
    }

    // 4. Nothing for this customer is reachable, so we have to spend a pick
    //    just to keep the queues flowing. Prefer something a *different*
    //    serveable customer needs over a blind random grab — it lands on the
    //    grid either way, but this way it gets consumed instead of becoming
    //    dead weight. Still a detour: it wasn't for the customer we're on.
    const alsoNeeded = sim.neededCookedIds();
    const useful = lanes.find((x) => {
      const item = sim.frontCell(x)?.item;
      if (!item || item.kind !== "ingredient") return false;
      for (const id of alsoNeeded) if (rawsFor.get(id)?.includes(item.id)) return true;
      return false;
    });
    const fallback = useful ?? lanes[Math.floor(rng() * lanes.length)];
    if (!take(fallback, target.index, true)) break;
    measure(target.index, needed);
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
  };
}
