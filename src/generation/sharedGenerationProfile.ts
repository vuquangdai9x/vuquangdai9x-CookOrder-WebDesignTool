import type { ObstacleConfig } from "../ui/levelpath/obstacles.ts";
import { emptyObstacles } from "../ui/levelpath/obstacles.ts";

export type GenerationStrategy = "customer-first" | "queue-first";
export type CoverageBySize = Record<2 | 3 | 4 | 5, number>;

export interface SharedObstacleCoverageProfile {
  grid: {
    blocked: number;
    orderLock: number;
    ingredientLock: number;
    lockAndKey: number;
  };
  queue: {
    hidden: number;
    frozen: number;
    combinedBySize: CoverageBySize;
    linkedBySize: CoverageBySize;
  };
  customer: {
    timed: number;
    shipper: number;
    boss: number;
  };
}

export interface SharedGenerationProfileV2 {
  /** Blank means the generator may choose a seed. */
  seed?: number;
  /** Stable graph composite name -> relative weight (0-100). Shared by both strategies. */
  dishTypeWeightsByName: Record<string, number>;
  /** Stable graph ingredient name -> relative weight (0-100). */
  ingredientWeightsByName: Record<string, number>;
  /** Stable graph ingredient name -> queue-slot amount override. */
  amountRangesByName: Record<string, { min: number; max: number }>;
  obstacles: SharedObstacleCoverageProfile;
}

export interface ObstacleCoverageBasis {
  gridCells: number;
  queueSlots: number;
  orderingCustomers: number;
}

export interface MaterializedObstacleCoverage {
  config: ObstacleConfig;
  /** Absolute group counts by size; legacy ObstacleConfig only carries totals. */
  combinedGroupsBySize: Record<2 | 3 | 4 | 5, number>;
  linkedGroupsBySize: Record<2 | 3 | 4 | 5, number>;
  warnings: string[];
}

const sizes = [2, 3, 4, 5] as const;

export const emptyCoverageBySize = (): CoverageBySize => ({ 2: 0, 3: 0, 4: 0, 5: 0 });

export const emptySharedObstacleCoverage = (): SharedObstacleCoverageProfile => ({
  grid: { blocked: 0, orderLock: 0, ingredientLock: 0, lockAndKey: 0 },
  queue: {
    hidden: 0,
    frozen: 0,
    combinedBySize: emptyCoverageBySize(),
    linkedBySize: emptyCoverageBySize(),
  },
  customer: { timed: 0, shipper: 0, boss: 0 },
});

export const clampCoverage = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

export function defaultSharedGenerationProfile(
  ingredientNames: readonly string[],
  dishTypeNames: readonly string[] = [],
): SharedGenerationProfileV2 {
  return {
    dishTypeWeightsByName: Object.fromEntries(dishTypeNames.map((name) => [name, 100])),
    ingredientWeightsByName: Object.fromEntries(ingredientNames.map((name) => [name, 100])),
    amountRangesByName: {},
    obstacles: emptySharedObstacleCoverage(),
  };
}

function count(coverage: number, basis: number, cap = Number.POSITIVE_INFINITY): number {
  if (basis <= 0) return 0;
  return Math.min(cap, Math.round(clampCoverage(coverage) * basis));
}

function groupCounts(coverage: CoverageBySize, queueSlots: number): CoverageBySize {
  const result = emptyCoverageBySize();
  for (const size of sizes) result[size] = count(coverage[size], queueSlots) / size;
  for (const size of sizes) result[size] = Math.round(result[size]);
  return result;
}

/** Convert the authored percentage profile into the absolute budget consumed by legacy placers. */
export function materializeObstacleCoverage(
  profile: SharedObstacleCoverageProfile,
  basis: ObstacleCoverageBasis,
): MaterializedObstacleCoverage {
  const warnings: string[] = [];
  const config = emptyObstacles();
  const gridLimit = Math.floor(Math.max(0, basis.gridCells) * 0.5);
  const gridTargets = {
    blocked: count(profile.grid.blocked, basis.gridCells),
    orderLock: count(profile.grid.orderLock, basis.gridCells),
    ingredientLock: count(profile.grid.ingredientLock, basis.gridCells),
    lockAndKey: count(profile.grid.lockAndKey, basis.gridCells),
  };
  const requestedGrid = Object.values(gridTargets).reduce((sum, value) => sum + value, 0);
  if (requestedGrid > gridLimit) {
    warnings.push(`Grid obstacle target ${requestedGrid} exceeds the ${gridLimit}-cell (50%) safety cap; later fields were reduced.`);
  }
  let remainingGrid = gridLimit;
  const spend = (wanted: number): number => {
    const placed = Math.min(wanted, remainingGrid);
    remainingGrid -= placed;
    return placed;
  };
  config.grid.blocked = spend(gridTargets.blocked);
  config.grid.orderLock = spend(gridTargets.orderLock);
  config.grid.ingredientLock = spend(gridTargets.ingredientLock);
  config.lockAndKey = spend(gridTargets.lockAndKey);

  config.queue.hidden = count(profile.queue.hidden, basis.queueSlots);
  config.queue.frozen = count(profile.queue.frozen, basis.queueSlots);
  const combinedGroupsBySize = groupCounts(profile.queue.combinedBySize, basis.queueSlots);
  const linkedGroupsBySize = groupCounts(profile.queue.linkedBySize, basis.queueSlots);
  config.queue.combined = Object.values(combinedGroupsBySize).reduce((sum, value) => sum + value, 0);
  config.queue.linked = Object.values(linkedGroupsBySize).reduce((sum, value) => sum + value, 0);

  config.customer.timed = count(profile.customer.timed, basis.orderingCustomers);
  config.customer.shipper = count(profile.customer.shipper, basis.orderingCustomers);
  config.customer.boss = count(profile.customer.boss, basis.orderingCustomers, 1);
  if (config.customer.shipper + config.customer.boss > basis.orderingCustomers) {
    const overflow = config.customer.shipper + config.customer.boss - basis.orderingCustomers;
    config.customer.shipper = Math.max(0, config.customer.shipper - overflow);
    warnings.push("Customer special-role coverage exceeded the ordering-customer count; shipper count was reduced.");
  }
  return { config, combinedGroupsBySize, linkedGroupsBySize, warnings };
}

export function coverageFromLegacyCounts(
  config: ObstacleConfig,
  basis: ObstacleCoverageBasis,
  actualGroups?: { combined: Partial<CoverageBySize>; linked: Partial<CoverageBySize> },
): { profile: SharedObstacleCoverageProfile; warnings: string[] } {
  const profile = emptySharedObstacleCoverage();
  const warnings: string[] = [];
  const ratio = (value: number, denominator: number, label: string): number => {
    if (value <= 0) return 0;
    if (denominator <= 0) {
      warnings.push(`${label} count ${value} needs conversion after a generated basis exists.`);
      return 0;
    }
    return clampCoverage(value / denominator);
  };
  profile.grid.blocked = ratio(config.grid.blocked, basis.gridCells, "Blocked grid");
  profile.grid.orderLock = ratio(config.grid.orderLock, basis.gridCells, "Order-lock grid");
  profile.grid.ingredientLock = ratio(config.grid.ingredientLock, basis.gridCells, "Ingredient-lock grid");
  profile.grid.lockAndKey = ratio(config.lockAndKey, basis.gridCells, "Lock-and-key");
  profile.queue.hidden = ratio(config.queue.hidden, basis.queueSlots, "Hidden queue");
  profile.queue.frozen = ratio(config.queue.frozen, basis.queueSlots, "Frozen queue");
  profile.customer.timed = ratio(config.customer.timed, basis.orderingCustomers, "Timed customer");
  profile.customer.shipper = ratio(config.customer.shipper, basis.orderingCustomers, "Shipper");
  profile.customer.boss = ratio(config.customer.boss, basis.orderingCustomers, "Boss");

  const migrateGroups = (
    kind: "combined" | "linked",
    total: number,
    target: CoverageBySize,
  ): void => {
    const actual = actualGroups?.[kind];
    const actualCount = actual ? sizes.reduce((sum, size) => sum + (actual[size] ?? 0), 0) : 0;
    if (actual && actualCount > 0 && basis.queueSlots > 0) {
      for (const size of sizes) target[size] = clampCoverage(((actual[size] ?? 0) * size) / basis.queueSlots);
    } else if (total > 0) {
      warnings.push(`${kind} group count ${total} has no recoverable size distribution; it remains a legacy-only override until reviewed.`);
    }
  };
  migrateGroups("combined", config.queue.combined, profile.queue.combinedBySize);
  migrateGroups("linked", config.queue.linked, profile.queue.linkedBySize);
  return { profile, warnings };
}
