// Headless auto-play bots for playtesting a level. Each bot drives its own
// fresh, instant-mode Simulation (no animation — flights resolve
// synchronously) through to a win or loss, so many trials can run quickly.
// See docs/GDD.md and PlayView's "Auto-play bot" panel (src/ui/play/index.ts).

import { findToolRecipe } from "./types.ts";
import type { Id, LevelConfig, MapDef } from "./types.ts";
import { Simulation } from "./sim.ts";
import type { SimStatus } from "./sim.ts";

export type BotType = "random" | "greedy" | "intelligent";

export interface BotRunOptions {
  type: BotType;
  /** "intelligent" only — how many picks ahead to search. Default 2. */
  lookaheadN?: number;
  /** Injectable for "random", so tests can seed a deterministic sequence. */
  rng?: () => number;
  /** Driver safety guard: max decision points (picks + stall-advances) per trial. Default 5000. */
  maxIterations?: number;
  /** Seconds to advance when truly stalled (nothing pickable, nothing cooking). Default 0.5. */
  stallTickStep?: number;
}

export interface BotTrialResult {
  status: SimStatus;
  servedCount: number;
  totalCustomers: number;
  time: number;
  iterations: number;
  /** True if the trial hit maxIterations while still "playing" — an inconclusive trial, counted as a loss. */
  bailedOut: boolean;
}

export interface BotBatchResult {
  type: BotType;
  trials: BotTrialResult[];
  wins: number;
  losses: number;
  /** wins === 0 — the UI's "this bot couldn't win" warning trigger. */
  zeroWins: boolean;
}

const DEFAULT_MAX_ITERATIONS = 5000;
const DEFAULT_STALL_TICK_STEP = 0.5;
const DEFAULT_LOOKAHEAD_N = 2;
/** Caps total lookahead search nodes per real decision, so a user-typed huge N degrades to a shallow best-effort search instead of hanging the tab. */
const MAX_LOOKAHEAD_NODES = 5000;

/**
 * Queue lanes whose fronting instance can be picked right now. A combined or
 * linked block spanning several columns fronts more than one lane, but it's
 * one instance — dedup by group so it isn't offered (and picked) twice, which
 * would otherwise bias Random toward wide blocks and waste Intelligent's
 * lookahead budget on duplicate children.
 */
function pickableCandidates(sim: Simulation): number[] {
  const out: number[] = [];
  const seenGroups = new Set<number>();
  for (let i = 0; i < sim.columnCount; i++) {
    const front = sim.frontCell(i);
    if (!front) continue;
    if (front.group !== -1) {
      if (seenGroups.has(front.group)) continue;
      seenGroups.add(front.group);
    }
    if (sim.canPick(i).ok) out.push(i);
  }
  return out;
}

/**
 * Shared decision loop for every strategy: while there's something pickable,
 * ask `chooseMove` which lane to pick from; otherwise advance time. Bounded
 * by `maxIterations` so a pathological stall (e.g. a freeze effect gated on
 * picks made, which time alone never clears) can't hang forever.
 */
function runDriver(
  sim: Simulation,
  chooseMove: (sim: Simulation, candidates: number[]) => number,
  maxIterations: number,
  stallTickStep: number,
): { iterations: number; bailedOut: boolean } {
  let iterations = 0;
  while (sim.status === "playing" && iterations < maxIterations) {
    iterations++;
    const candidates = pickableCandidates(sim);
    if (candidates.length > 0) {
      sim.pick(chooseMove(sim, candidates));
    } else {
      // fastForward() jumps straight to the next cooking completion, but
      // no-ops (returns 0) if nothing is cooking at all — fall back to a
      // plain tick so customer timers (and a legitimate customer-timeout
      // loss) can still progress in that case.
      const elapsed = sim.fastForward();
      if (elapsed === 0) sim.tick(stallTickStep);
    }
  }
  return { iterations, bailedOut: sim.status === "playing" };
}

// ---------- Random ----------

function chooseRandom(rng: () => number) {
  return (_sim: Simulation, candidates: number[]) => candidates[Math.floor(rng() * candidates.length)];
}

// ---------- Greedy ----------

/** Raw ingredient ids whose eventual cooked output is currently needed by some active customer's dish. */
function wantedRawIds(sim: Simulation, map: MapDef): Set<Id> {
  const needed = sim.neededCookedIds();
  const wanted = new Set<Id>();
  for (const raw of map.rawIngredients) {
    const match = findToolRecipe(map.tools, raw.id);
    if (needed.has(match ? match.recipe.out : raw.id)) wanted.add(raw.id);
  }
  return wanted;
}

/** Cooked id a raw ingredient eventually becomes (itself, if it needs no cooking). */
function producedCookedId(map: MapDef, rawId: Id): Id {
  const match = findToolRecipe(map.tools, rawId);
  return match ? match.recipe.out : rawId;
}

function chooseGreedy(map: MapDef) {
  return (sim: Simulation, candidates: number[]): number => {
    const wanted = wantedRawIds(sim, map);
    const needed = candidates.filter((i) => {
      const item = sim.frontCell(i)!.item;
      return item.kind === "ingredient" && wanted.has(item.id);
    });

    if (needed.length > 0) {
      // Tie-break: soonest-timing-out customer who needs it, then the dish
      // closest to completion, then lowest queue index (deterministic).
      let best = needed[0];
      let bestKey: [number, number] = urgencyKey(sim, map, best);
      for (const i of needed.slice(1)) {
        const key = urgencyKey(sim, map, i);
        if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
          best = i;
          bestKey = key;
        }
      }
      return best;
    }

    // Nothing currently needed is pickable. A sweeper only helps if there's
    // actually something dirty to clear; otherwise it's a wasted pick.
    const hasDirty = sim.grid.some((c) => c.kind === "dirty");
    if (hasDirty) {
      const sweeper = candidates.find((i) => sim.frontCell(i)!.item.kind === "sweeper");
      if (sweeper !== undefined) return sweeper;
    }

    // Otherwise keep queues flowing (e.g. a topping whose base isn't in the
    // dish yet still needs to arrive eventually) — lowest index, deterministic.
    return candidates[0];
  };
}

/** [minTimeLeft among customers needing this pick, fewest-remaining-items of that dish]. */
function urgencyKey(sim: Simulation, map: MapDef, queueIndex: number): [number, number] {
  const item = sim.frontCell(queueIndex)!.item;
  const cookedId = producedCookedId(map, item.id);
  let minTimeLeft = Infinity;
  let minRemaining = Infinity;
  for (const c of sim.active) {
    for (const dish of c.dishes) {
      if (!dish.remaining.includes(cookedId)) continue;
      if (c.timeLeft < minTimeLeft) minTimeLeft = c.timeLeft;
      if (dish.remaining.length < minRemaining) minRemaining = dish.remaining.length;
    }
  }
  return [minTimeLeft, minRemaining];
}

// ---------- Intelligent ----------

function terminalScore(sim: Simulation): number {
  if (sim.status === "won") return 100_000 + sim.servedCount;
  // A loss that happened later (more served first) still beats an earlier one.
  return -100_000 + sim.servedCount * 10;
}

function leafScore(sim: Simulation): number {
  let score = 1000 * sim.servedCount;
  for (const c of sim.active) {
    for (const dish of c.dishes) score -= 10 * dish.remaining.length;
    if (c.config.waitTime > 0) {
      const urgency = Math.max(0, 1 - c.timeLeft / c.config.waitTime);
      score -= 5 * urgency;
    }
  }
  score -= 50 * sim.grid.filter((c) => c.kind === "dirty").length;
  return score;
}

interface LookaheadState {
  nodesUsed: number;
}

function evaluateBranch(sim: Simulation, depthRemaining: number, state: LookaheadState, stallGuard = 0): number {
  if (sim.status !== "playing") return terminalScore(sim);
  if (depthRemaining <= 0 || state.nodesUsed >= MAX_LOOKAHEAD_NODES) return leafScore(sim);

  const candidates = pickableCandidates(sim);
  if (candidates.length === 0) {
    if (stallGuard > 20) return leafScore(sim);
    const elapsed = sim.fastForward();
    if (elapsed === 0) sim.tick(DEFAULT_STALL_TICK_STEP);
    // Advancing time doesn't consume a depth level — only a pick does.
    return evaluateBranch(sim, depthRemaining, state, stallGuard + 1);
  }

  let best = -Infinity;
  for (const idx of candidates) {
    state.nodesUsed++;
    const child = sim.clone();
    child.pick(idx);
    best = Math.max(best, evaluateBranch(child, depthRemaining - 1, state));
    if (state.nodesUsed >= MAX_LOOKAHEAD_NODES) break;
  }
  return best;
}

function chooseIntelligent(n: number) {
  return (sim: Simulation, candidates: number[]): number => {
    const state: LookaheadState = { nodesUsed: 0 };
    let bestScore = -Infinity;
    let bestIndex = candidates[0];
    for (const idx of candidates) {
      const branch = sim.clone();
      branch.pick(idx);
      const score = evaluateBranch(branch, n - 1, state);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = idx;
      }
      if (state.nodesUsed >= MAX_LOOKAHEAD_NODES) break;
    }
    return bestIndex;
  };
}

// ---------- public API ----------

export function runBotTrial(map: MapDef, level: LevelConfig, opts: BotRunOptions): BotTrialResult {
  const sim = new Simulation(map, level, { outOfSlotPolicy: level.outOfSlotPolicy ?? "block-pick" });
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const stallTickStep = opts.stallTickStep ?? DEFAULT_STALL_TICK_STEP;

  const chooseMove =
    opts.type === "random"
      ? chooseRandom(opts.rng ?? Math.random)
      : opts.type === "greedy"
        ? chooseGreedy(map)
        : chooseIntelligent(opts.lookaheadN ?? DEFAULT_LOOKAHEAD_N);

  const { iterations, bailedOut } = runDriver(sim, chooseMove, maxIterations, stallTickStep);

  return {
    status: sim.status,
    servedCount: sim.servedCount,
    totalCustomers: sim.totalCustomers,
    time: sim.time,
    iterations,
    bailedOut,
  };
}

export function runBotTrials(
  map: MapDef,
  level: LevelConfig,
  opts: BotRunOptions,
  count: number,
): BotBatchResult {
  const trials: BotTrialResult[] = [];
  for (let i = 0; i < count; i++) trials.push(runBotTrial(map, level, opts));
  const wins = trials.filter((t) => t.status === "won").length;
  return {
    type: opts.type,
    trials,
    wins,
    losses: trials.length - wins,
    zeroWins: wins === 0,
  };
}
