// Browser-safe Level Statistics + MCP evaluation report.
//
// The MCP service persists sessions and therefore cannot run in a Web Worker,
// but its public metric catalog and constraint evaluator are pure. This module
// uses those shared definitions and reproduces the service's tuning-profile
// measurements over the live, unsaved Design-mode level.

import { buildIndex } from "../../core/nodeIndex.ts";
import { orderIdIndex } from "../../core/nodeOrder.ts";
import type { NodeLevelConfig } from "../../core/nodeSim.ts";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import { supplyByRaw } from "../../data/recipeDemand.ts";
import { validateNodeGraph } from "../../data/nodeGraphValidate.ts";
import { buildIdIndex } from "../../data/nodeIdTable.ts";
import { listConstraintMetrics } from "../../mcp/constraintCatalog.ts";
import { evaluateConstraint, percentile, proportionInterval } from "../../mcp/constraintEvaluation.ts";
import {
  analyzeLevelQueueTexture,
  queueLanesFromString,
  queueSequenceSimilarity,
  referenceStyleDistance,
  textureEnvelope,
} from "../../mcp/queueTexture.ts";
import type { ConstraintValue, EvaluatedConstraint, MetricConstraint, ValidationFinding } from "../../mcp/types.ts";
import { PRODUCTION_BEHAVIOR } from "../../mcp/productionBehavior.ts";
import { computeLevelStats, type LevelStats } from "../levelpath/levelStats.ts";
import { nodeDemandByRaw } from "../nodedesign/nodeQueueGenerate.ts";
import { estimateNodeDifficulty } from "./nodeEstimateDifficulty.ts";
import { checkQueueThaw } from "./queueThawCheck.ts";
import { checkToolDeadlock } from "./toolDeadlockCheck.ts";
import type { EstimateProgress } from "./estimateDifficulty.ts";

export const STATISTIC_RUNS = 10;

export interface StatisticReport {
  levelStats: LevelStats;
  metrics: Record<string, ConstraintValue>;
  confidenceIntervals: Record<string, [number, number]>;
  checks: EvaluatedConstraint[];
  hardFailures: ValidationFinding[];
  failReasons: Record<string, number>;
  runs: number;
  passed: boolean;
  referenceSampleCount: number;
  nearestReferenceLevelId: number | null;
  notes: Record<string, string>;
}

export interface StatisticReportInput {
  graph: NodeGraphMap;
  level: NodeLevelConfig;
  levelData: LevelData;
  referenceLevels: LevelData[];
  runs?: number;
}

const seededRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
};

function exactSupply(ix: ReturnType<typeof buildIndex>, level: NodeLevelConfig): boolean {
  const demand = nodeDemandByRaw(ix, orderIdIndex(ix), level.customers);
  const supply = supplyByRaw(level.queues);
  const ids = new Set([...demand.keys(), ...supply.keys()]);
  for (const id of ids) {
    const wanted = demand.get(id);
    const have = (supply.get(id) ?? 0) * Math.max(1, wanted?.amount ?? 1);
    if (have !== (wanted?.need ?? 0)) return false;
  }
  return true;
}

function defaultChecks(metrics: Record<string, ConstraintValue>, runs: number): EvaluatedConstraint[] {
  const constraints: MetricConstraint[] = [
    { id: "design-structural", dimension: "fundamental", metric: "fundamental.structuralErrors", operator: "=", value: 0, priority: "hard", weight: 1, source: "Design Statistic" },
    { id: "design-supply", dimension: "fundamental", metric: "fundamental.exactSupply", operator: "=", value: true, priority: "hard", weight: 1, source: "Design Statistic" },
    { id: "design-victory", dimension: "fundamental", metric: "fundamental.solverVictory", operator: "=", value: true, priority: "hard", weight: 1, source: "Design Statistic", minimumRuns: STATISTIC_RUNS },
  ];
  return constraints.map((constraint) => evaluateConstraint(
    constraint,
    metrics[constraint.metric],
    constraint.minimumRuns ? Math.min(1, runs / constraint.minimumRuns) : undefined,
  ));
}

export function createStatisticReport(
  input: StatisticReportInput,
  onProgress?: (progress: EstimateProgress) => void,
): StatisticReport {
  const ix = buildIndex(input.graph);
  const runs = Math.max(1, Math.min(50, Math.floor(input.runs ?? STATISTIC_RUNS)));
  const totalItems = input.level.queues.reduce((sum, lane) => sum + lane.length, 0);
  const emit = (run: number, percentage: number, pickedItems = 0): void => onProgress?.({
    run: Math.min(runs, Math.max(1, run)),
    runTotal: runs,
    pickedItems,
    totalItems,
    percentage: Math.max(0, Math.min(100, percentage)),
  });
  emit(1, 0);

  const levelStats = computeLevelStats(input.levelData, ix, buildIdIndex(input.graph.idTable));
  const graphValidation = validateNodeGraph(input.graph);
  const hardFailures: ValidationFinding[] = [
    ...graphValidation.errors.map((issue) => ({ severity: "error" as const, code: issue.invariantId, message: issue.message })),
    ...levelStats.parseErrors.map((message) => ({ severity: "error" as const, code: "LEVEL_PARSE", message })),
  ];

  const thaw = checkQueueThaw(input.level.queues, input.level.queueGroups, {
    timeBudgetMs: 400,
    sampleBudgetMs: 200,
  });
  if (thaw.verdict === "deadlock") {
    hardFailures.push({ severity: "error", code: "QUEUE_THAW", message: thaw.message });
  }
  emit(1, 3);
  const tool = checkToolDeadlock(ix, input.level, {
    randomRuns: 10,
    budgetMs: 500,
    packingMode: PRODUCTION_BEHAVIOR.packingMode,
    toolProcessBehavior: PRODUCTION_BEHAVIOR.toolProcessBehavior,
  });
  if (tool.toolBlocked > 0) {
    hardFailures.push({ severity: "error", code: "TOOL_DEADLOCK", message: `${tool.toolBlocked} diagnostic runs jammed in tool slots.` });
  }

  const estimates = Array.from({ length: runs }, (_, runIndex) => estimateNodeDifficulty(ix, input.level, {
    rng: seededRng(0x5eed + runIndex * 2654435761),
    maxRetries: 2,
    packingMode: PRODUCTION_BEHAVIOR.packingMode,
    toolProcessBehavior: PRODUCTION_BEHAVIOR.toolProcessBehavior,
    onProgress: (inner) => {
      const completed = runIndex + inner.percentage / 100;
      emit(runIndex + 1, 5 + completed / runs * 94, inner.pickedItems);
    },
  }));

  const wins = estimates.filter((estimate) =>
    estimate.solvable && estimate.servedCount === estimate.totalCustomers && estimate.timedOutCustomers.length === 0
  ).length;
  const durations = estimates.map((estimate) => estimate.gameplayDurationSeconds ?? 0);
  const totalPicks = estimates.reduce((sum, estimate) => sum + estimate.totalPicks, 0);
  const randomPicks = estimates.reduce((sum, estimate) =>
    sum + estimate.occupancyHistory.filter((sample) => sample.random).length, 0);
  const detours = estimates.reduce((sum, estimate) =>
    sum + estimate.perCustomer.reduce((subtotal, customer) => subtotal + customer.detours, 0), 0);
  const peakOccupied = Math.max(0, ...estimates.flatMap((estimate) =>
    estimate.occupancyHistory.map((sample) => sample.occupied)));
  const amounts = input.level.queues.flatMap((lane) => lane)
    .filter((slot) => slot.kind === "ingredient")
    .map((slot) => Math.max(1, slot.amount ?? 1));
  const amountSlots = amounts.filter((amount) => amount > 1);
  const totalUnits = amounts.reduce((sum, amount) => sum + amount, 0);
  const amountUnits = amountSlots.reduce((sum, amount) => sum + amount, 0);
  const laneDepths = input.level.queues.map((lane) => lane.length);
  const texture = analyzeLevelQueueTexture(input.levelData);

  const referenceRows = input.referenceLevels.map((level) => analyzeLevelQueueTexture(level));
  const envelope = textureEnvelope(referenceRows);
  const candidateLanes = queueLanesFromString(input.levelData.queueString);
  let nearestReferenceSimilarity = 0;
  let nearestReferenceLevelId: number | null = null;
  for (const reference of input.referenceLevels) {
    const similarity = queueSequenceSimilarity(candidateLanes, queueLanesFromString(reference.queueString));
    if (similarity > nearestReferenceSimilarity) {
      nearestReferenceSimilarity = similarity;
      nearestReferenceLevelId = reference.id;
    }
  }

  const deadlockReasonDistribution = Object.fromEntries(thaw.reasonCounts.map((row) => [row.reason, row.count]));
  const gridCapacity = input.level.grid.filter((cell) => !cell.effects.some((effect) => effect.effectId === 1)).length;
  const metrics: Record<string, ConstraintValue> = {
    "fundamental.structuralErrors": hardFailures.length,
    "fundamental.exactSupply": exactSupply(ix, input.level),
    "fundamental.solverVictory": wins === estimates.length,
    "experience.winRate": wins / estimates.length,
    "experience.durationP50": percentile(durations, 0.5),
    "experience.durationP90": percentile(durations, 0.9),
    "experience.randomPickRatio": totalPicks ? randomPicks / totalPicks : 0,
    "experience.detourRatio": totalPicks ? detours / totalPicks : 0,
    "queue.laneCount": input.level.queues.length,
    "queue.maxDepth": Math.max(0, ...laneDepths),
    "queue.laneBalance": laneDepths.length && Math.max(...laneDepths) > 0
      ? 1 - (Math.max(...laneDepths) - Math.min(...laneDepths)) / Math.max(...laneDepths)
      : 1,
    "queue.pickingOrderStuckRate": thaw.randomRuns ? thaw.randomStuck / thaw.randomRuns : thaw.verdict === "deadlock" ? 1 : 0,
    "queue.deadlockReasonDistribution": deadlockReasonDistribution,
    "queue.adjacentDuplicateRatio": texture.adjacentDuplicateRatio,
    "queue.maxIdenticalRun": texture.maxIdenticalRun,
    "queue.crossLaneCloneRatio": texture.crossLaneCloneRatio,
    "queue.transitionEntropy": texture.transitionEntropy,
    "queue.repeatedNgramRatio": texture.repeatedNgramRatio,
    "queue.localIngredientDominance": texture.localIngredientDominance,
    "queue.referenceStyleDistance": referenceStyleDistance(texture, envelope),
    "queue.nearestReferenceSimilarity": nearestReferenceSimilarity,
    "amount.compactedUnitRatio": totalUnits ? amountUnits / totalUnits : 0,
    "amount.amountSlotRatio": amounts.length ? amountSlots.length / amounts.length : 0,
    "amount.maxAmount": Math.max(1, ...amounts),
    "amount.expandedItemCount": totalUnits,
    "amount.maxDestinationDemand": Math.max(1, ...amounts),
    "amount.maxGridLandingBurst": Math.max(0, ...amounts.map((amount) => amount - 1)),
    "amount.atomicDestinationBlockRate": tool.randomRuns + tool.runs.length
      ? tool.gridBlocked / (tool.randomRuns + tool.runs.length)
      : 0,
    "grid.usableCells": gridCapacity,
    "grid.peakOccupancy": gridCapacity ? peakOccupied / gridCapacity : 0,
    "customers.count": input.level.customers.length,
    "customers.dishCount": input.level.customers.reduce((sum, customer) => sum + customer.dishes.length, 0),
    "content.distinctComposites": new Set(input.level.customers.flatMap((customer) =>
      customer.dishes.map((dish) => dish.root.id))).size,
    "pacing.peakConcurrentWork": Math.max(0, ...estimates.map((estimate) => estimate.peakConcurrentWork ?? 0)),
    "mechanics.authorizedCount": 0,
  };
  // Keep the UI honest if the catalog grows: new metrics are shown as
  // unavailable instead of silently vanishing from the report.
  const notes: Record<string, string> = {
    "mechanics.authorizedCount": "Design mode has no MCP requirement session, so no mechanics are explicitly authorized here.",
    "queue.referenceStyleDistance": `Compared with ${referenceRows.length} saved level(s) in the open map.`,
    "queue.nearestReferenceSimilarity": nearestReferenceLevelId === null
      ? "No saved reference level was available."
      : `Nearest saved reference: level ${nearestReferenceLevelId}.`,
  };
  for (const definition of listConstraintMetrics()) {
    if (!(definition.id in metrics)) notes[definition.id] = "Not available in the live Design-mode evaluation.";
  }

  const checks = defaultChecks(metrics, estimates.length);
  const failReasons: Record<string, number> = {};
  for (const estimate of estimates.filter((row) => !row.solvable)) {
    const reason = estimate.loseReason ?? estimate.reason ?? "unsolved";
    failReasons[reason] = (failReasons[reason] ?? 0) + 1;
  }
  emit(runs, 100, totalItems);
  return {
    levelStats,
    metrics,
    confidenceIntervals: { "experience.winRate": proportionInterval(wins, estimates.length) },
    checks,
    hardFailures,
    failReasons,
    runs: estimates.length,
    passed: hardFailures.length === 0 && checks.every((check) => check.pass),
    referenceSampleCount: referenceRows.length,
    nearestReferenceLevelId,
    notes,
  };
}
