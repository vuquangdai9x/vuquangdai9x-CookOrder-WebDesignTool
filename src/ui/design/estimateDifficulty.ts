// Shared difficulty-estimate types and pure helpers. The graph-native solver
// lives in nodeEstimateDifficulty.ts; this file is what both it and the
// Design/Play UI (customerSection.ts's difficulty bar, occupancyChart.ts's
// chart) share, so a projected result reads identically regardless of which
// solver produced it.

import type { LoseReason } from "../../core/simTypes.ts";
import type { EstimateScenario } from "./estimateScenario.ts";

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
  /**
   * Picks where nothing reachable scored at all, so the solver just took
   * something to keep the queues moving. One of these means a player serving
   * this customer has to guess.
   */
  randomPicks: number;
  /**
   * Picks that were the best available move: the front item was itself wanted,
   * either for a dish base or for a slot whose gate is already open. A sweeper
   * taken while the grid is dirty counts too — that is the correct play, not a
   * guess. Everything else (digging toward a buried piece, or fetching a piece
   * whose base is not down yet) is neither random nor best.
   */
  bestPicks: number;
}

/** Grid pressure snapshot taken right after one pick has fully settled. */
export interface OccupancySample {
  /** Total grid cells not empty — cooked, parked raw, or dirty stacks alike. */
  occupied: number;
  /** Of those, how many are dirty stacks specifically. */
  dirty: number;
  /**
   * The score the solver gave this pick's winning match — 0 when `random`
   * is true (nothing scored anything, i.e. a score-less fallback pick).
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
  /** Customer this pick was attributed to — lets hovering a customer card light up their own points on the chart. -1 when the solver had no owner for it. */
  customerIndex: number;
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
  /** Solver actions used by the node Play renderer to replay this estimate. */
  replaySteps: EstimateReplayStep[];
  /** Number of scoring attempts used before this result was selected. */
  attemptCount?: number;
  /** Scoring strategy that produced this result. */
  strategyName?: string;
}

export interface EstimateReplayStep {
  /** Queue column picked at this solver step. */
  lane: number;
  /** Dynamic serve window used by the estimator immediately before the pick. */
  serveableSlots: number;
  /** Score of every queue column at this decision; null means it was not pickable. */
  laneScores: (number | null)[];
}

export interface EstimateOptions {
  /** Overrides the default seeded PRNG used to break ties between useless picks. */
  rng?: () => number;
  /** Safety valve against a pathological level; overrides the scenario field. */
  maxIterations?: number;
  /** Overrides the modal retry count; clamped to 0..10. */
  maxRetries?: number;
  /** Scoring scenario from the pre-run modal; omitted means every default. */
  scenario?: EstimateScenario;
}

/**
 * An ingredient a dish still needs and that nothing has to come before.
 * Exported as the ceiling occupancyChart.ts normalizes its tint gradient
 * against: a pick scoring at or above this is one of the "2 best scenarios"
 * and reads as fully clear/no tint there.
 */
export const SCORE_BASE = 100;

/**
 * The three-state cue drawn on top of a customer card. It answers "how much
 * is the player guessing while serving this customer":
 *   "random" — at least one pick had nothing matching reachable, so the
 *              player must take a random ingredient. Red.
 *   "best"   — every pick was the best available move: a dish base, or a
 *              piece for a slot whose base is already down. Green.
 *   "mixed"  — everything in between; no guessing, but detours and pieces
 *              fetched ahead of their base. Yellow.
 * A customer the solver never had to pick for reads "best": nothing was
 * forced on the player for them.
 */
export type PickQuality = "random" | "best" | "mixed";

export function pickQuality(cost: CustomerCost): PickQuality {
  if (cost.randomPicks > 0) return "random";
  return cost.bestPicks >= cost.picks ? "best" : "mixed";
}

const PICK_QUALITY_COLOR: Record<PickQuality, string> = {
  random: "hsl(0, 70%, 45%)",
  mixed: "hsl(45, 85%, 50%)",
  best: "hsl(120, 70%, 45%)",
};

export function pickQualityColor(quality: PickQuality): string {
  return PICK_QUALITY_COLOR[quality];
}

/** Tooltip for the cue — says which picks earned the color. */
export function pickQualityLabel(cost: CustomerCost): string {
  switch (pickQuality(cost)) {
    case "random":
      return `${cost.randomPicks} random pick(s): nothing matching was reachable, so the player has to guess`;
    case "best":
      return cost.picks === 0
        ? "No pick was needed for this customer"
        : `All ${cost.picks} pick(s) were the best available match`;
    default:
      return `${cost.picks - cost.bestPicks} of ${cost.picks} pick(s) were detours, or fetched before their base was down`;
  }
}
