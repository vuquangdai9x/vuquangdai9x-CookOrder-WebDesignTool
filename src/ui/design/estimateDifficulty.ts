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
