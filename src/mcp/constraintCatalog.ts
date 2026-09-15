import type { ConstraintOperator, RequirementPriority } from "./types.ts";

export type MetricValueType = "number" | "integer" | "ratio" | "boolean" | "string" | "distribution";

export interface ConstraintMetricDefinition {
  id: string;
  dimension: string;
  valueType: MetricValueType;
  unit: string;
  operators: ConstraintOperator[];
  statistical: boolean;
  description: string;
  defaultPriority: RequirementPriority;
  repairFamilies: string[];
  range?: { min?: number; max?: number };
}

const numeric = ["=", "!=", "<", "<=", ">", ">=", "between"] as ConstraintOperator[];
const integer = (id: string, dimension: string, unit: string, description: string, repairFamilies: string[], range?: { min?: number; max?: number }): ConstraintMetricDefinition => ({
  id, dimension, valueType: "integer", unit, operators: numeric, statistical: false,
  description, defaultPriority: "target", repairFamilies, ...(range ? { range } : {}),
});
const ratio = (id: string, dimension: string, description: string, repairFamilies: string[], statistical = false): ConstraintMetricDefinition => ({
  id, dimension, valueType: "ratio", unit: "ratio", operators: numeric, statistical,
  description, defaultPriority: "target", repairFamilies, range: { min: 0, max: 1 },
});

const CATALOG: ConstraintMetricDefinition[] = [
  { id: "fundamental.structuralErrors", dimension: "fundamental", valueType: "integer", unit: "errors", operators: numeric, statistical: false, description: "Serialization and structural validation errors.", defaultPriority: "hard", repairFamilies: ["structure"], range: { min: 0 } },
  { id: "fundamental.exactSupply", dimension: "fundamental", valueType: "boolean", unit: "boolean", operators: ["=", "!="], statistical: false, description: "Whether authored pickup supply exactly serves demand after process yields.", defaultPriority: "hard", repairFamilies: ["supply", "amount"] },
  { id: "fundamental.solverVictory", dimension: "fundamental", valueType: "boolean", unit: "boolean", operators: ["=", "!="], statistical: true, description: "Whether the solver serves every customer without timeout.", defaultPriority: "hard", repairFamilies: ["queue-order", "grid-capacity", "pacing"] },
  ratio("experience.winRate", "experience", "Winning simulations divided by completed simulations.", ["queue-order", "grid-capacity", "pacing"], true),
  { id: "experience.durationP50", dimension: "experience", valueType: "number", unit: "seconds", operators: numeric, statistical: true, description: "Median gameplay duration.", defaultPriority: "target", repairFamilies: ["customers", "queue", "tools"], range: { min: 0 } },
  { id: "experience.durationP90", dimension: "experience", valueType: "number", unit: "seconds", operators: numeric, statistical: true, description: "90th percentile gameplay duration.", defaultPriority: "target", repairFamilies: ["customers", "queue", "tools"], range: { min: 0 } },
  ratio("experience.randomPickRatio", "experience", "Share of picks whose best choices are strategically indistinguishable.", ["queue-order", "lane-layout"], true),
  ratio("experience.detourRatio", "experience", "Share of picks that do not immediately advance visible demand.", ["queue-order", "dish-order"], true),
  integer("queue.laneCount", "queue", "lanes", "Number of authored queue lanes.", ["lane-layout"], { min: 1 }),
  integer("queue.maxDepth", "queue", "rows", "Maximum authored queue depth.", ["lane-layout", "queue-order"], { min: 0 }),
  ratio("queue.laneBalance", "queue", "How evenly slots are distributed across lanes.", ["lane-layout"]),
  ratio("queue.pickingOrderStuckRate", "queue", "Queue-order simulations that reach a stuck picking sequence; grid state is excluded.", ["queue-order", "effects", "groups"], true),
  { id: "queue.deadlockReasonDistribution", dimension: "queue", valueType: "distribution", unit: "cases", operators: ["=", "in"], statistical: true, description: "Distribution of queue-only stuck reasons.", defaultPriority: "preference", repairFamilies: ["queue-order", "effects", "groups"] },
  ratio("queue.adjacentDuplicateRatio", "queue-texture", "Share of lane-local adjacent pairs containing the same ingredient.", ["queue-order", "lane-layout"]),
  integer("queue.maxIdenticalRun", "queue-texture", "slots", "Longest lane-local run of one identical ingredient.", ["queue-order", "amount-partition"], { min: 0 }),
  ratio("queue.crossLaneCloneRatio", "queue-texture", "Share of cross-lane positions showing the same ingredient at the same depth.", ["lane-layout", "queue-order"]),
  ratio("queue.transitionEntropy", "queue-texture", "Normalized diversity of lane-local ingredient transitions.", ["queue-order"]),
  ratio("queue.repeatedNgramRatio", "queue-texture", "Share of lane-local ingredient trigrams that repeat an earlier trigram.", ["queue-order"]),
  ratio("queue.localIngredientDominance", "queue-texture", "Maximum same-ingredient share in any five-slot lane window.", ["queue-order", "amount-partition"]),
  ratio("queue.referenceStyleDistance", "queue-texture", "Normalized distance outside the comparable shipped-level interquartile style envelope.", ["reference-selection", "queue-order", "amount-partition"]),
  ratio("queue.nearestReferenceSimilarity", "queue-texture", "Highest trigram similarity to a comparable shipped level; cap this to avoid copying.", ["queue-order", "seed"]),
  ratio("amount.compactedUnitRatio", "amount", "Pickup units represented by amount values above one.", ["amount-partition"]),
  ratio("amount.amountSlotRatio", "amount", "Queue slots carrying amount values above one.", ["amount-partition"]),
  integer("amount.maxAmount", "amount", "units", "Largest atomic release authored on one queue slot.", ["amount-split", "queue-order"], { min: 1 }),
  integer("amount.expandedItemCount", "amount", "items", "Physical one-use items after unpacked expansion.", ["supply", "amount-partition"], { min: 0 }),
  integer("amount.maxDestinationDemand", "amount", "destinations", "Largest destination requirement caused by one atomic amount pick.", ["amount-split", "queue-order", "grid-capacity"], { min: 1 }),
  integer("amount.maxGridLandingBurst", "amount", "grid cells", "Largest number of items from one pick that must land on the grid.", ["amount-split", "queue-order", "grid-capacity"], { min: 0 }),
  ratio("amount.atomicDestinationBlockRate", "amount", "Amount picks blocked because all expanded items cannot receive destinations.", ["amount-split", "queue-order", "grid-capacity"], true),
  integer("grid.usableCells", "grid", "cells", "Grid cells available for normal item parking.", ["grid-effects"], { min: 0 }),
  ratio("grid.peakOccupancy", "grid", "Peak occupied usable-grid ratio.", ["grid-capacity", "queue-order"], true),
  integer("customers.count", "customers", "customers", "Number of customers in the arrival sequence.", ["customers"], { min: 1 }),
  integer("customers.dishCount", "customers", "dishes", "Total ordered dishes.", ["customers", "dishes"], { min: 1 }),
  integer("content.distinctComposites", "content", "composites", "Distinct orderable composite types used.", ["dishes"], { min: 1 }),
  { id: "pacing.peakConcurrentWork", dimension: "pacing", valueType: "integer", unit: "work items", operators: numeric, statistical: true, description: "Peak concurrently active cooking work.", defaultPriority: "target", repairFamilies: ["queue-order", "dish-order", "tools"], range: { min: 0 } },
  integer("mechanics.authorizedCount", "mechanics", "mechanics", "Number of explicitly authorized special mechanic families.", ["requirements"], { min: 0 }),
];

export function listConstraintMetrics(dimension?: string): ConstraintMetricDefinition[] {
  const normalized = dimension?.trim().toLowerCase();
  return structuredClone(normalized ? CATALOG.filter((item) => item.dimension === normalized) : CATALOG);
}

export function constraintMetric(metric: string): ConstraintMetricDefinition | undefined {
  return CATALOG.find((item) => item.id === metric);
}
