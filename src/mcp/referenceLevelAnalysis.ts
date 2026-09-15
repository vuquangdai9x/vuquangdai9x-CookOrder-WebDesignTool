import { createHash } from "node:crypto";
import type { ReferenceLevelDataset } from "./repository.ts";
import {
  analyzeLevelQueueTexture,
  queueLanesFromString,
  queueSequenceSimilarity,
  referenceStyleDistance,
  textureEnvelope,
  type QueueTextureEnvelope,
  type QueueTextureMetrics,
} from "./queueTexture.ts";

export interface ReferenceLevelSelector {
  targetLevel?: number;
  cohortRadius?: number;
  levelMin?: number;
  levelMax?: number;
  limit?: number;
}

export interface ReferenceLevelSummary {
  id: number;
  name: string;
  tag: string;
  metrics: QueueTextureMetrics;
}

export interface ReferenceLevelAnalysis {
  referenceProfileId: string;
  mapId: string;
  sourceFile: string | null;
  sourceHash: string | null;
  selector: ReferenceLevelSelector;
  availableLevelCount: number;
  cohort: ReferenceLevelSummary[];
  envelope: QueueTextureEnvelope;
  recommendedTargets: {
    amountStyle: "single-unit" | "balanced";
    amountSlotRatio: [number, number];
    compactedUnitRatio: [number, number];
    maximumAdjacentDuplicateRatio: number;
    maximumIdenticalRun: number;
    maximumCrossLaneCloneRatio: number;
    minimumTransitionEntropy: number;
    maximumRepeatedNgramRatio: number;
    maximumLocalIngredientDominance: number;
    maximumReferenceStyleDistance: number;
    maximumNearestReferenceSimilarity: number;
  };
  warnings: string[];
}

function selectedLevels(dataset: ReferenceLevelDataset, selector: ReferenceLevelSelector) {
  const minimum = selector.levelMin ?? (selector.targetLevel === undefined ? -Infinity : selector.targetLevel - Math.max(1, Math.floor(selector.cohortRadius ?? 5)));
  const maximum = selector.levelMax ?? (selector.targetLevel === undefined ? Infinity : selector.targetLevel + Math.max(1, Math.floor(selector.cohortRadius ?? 5)));
  let selected = dataset.levels.filter((level) => level.id >= minimum && level.id <= maximum);
  if (!selected.length && selector.targetLevel !== undefined) {
    selected = [...dataset.levels].sort((left, right) => Math.abs(left.id - selector.targetLevel!) - Math.abs(right.id - selector.targetLevel!));
  }
  const limit = Math.max(1, Math.min(100, Math.floor(selector.limit ?? (selected.length || 1))));
  if (selector.targetLevel !== undefined) {
    selected.sort((left, right) => Math.abs(left.id - selector.targetLevel!) - Math.abs(right.id - selector.targetLevel!) || left.id - right.id);
  } else selected.sort((left, right) => left.id - right.id);
  return selected.slice(0, limit).sort((left, right) => left.id - right.id);
}

export function analyzeReferenceDataset(mapId: string, dataset: ReferenceLevelDataset, selector: ReferenceLevelSelector = {}): ReferenceLevelAnalysis {
  const selected = selectedLevels(dataset, selector);
  const cohort = selected.map((level) => ({
    id: level.id,
    name: level.name,
    tag: level.levelTag,
    metrics: analyzeLevelQueueTexture(level),
  }));
  const envelope = textureEnvelope(cohort.map((row) => row.metrics));
  const amountUsingLevels = cohort.filter((row) => row.metrics.amountSlotRatio > 0).length;
  const amountUseRate = cohort.length ? amountUsingLevels / cohort.length : 0;
  const warnings: string[] = [];
  if (!dataset.levels.length) warnings.push(`No committed sample levels were found for map ${mapId}. Use an explicitly reviewed cross-map fallback.`);
  else if (cohort.length < 3) warnings.push(`Only ${cohort.length} comparable sample level(s) were found; treat percentile targets as weak evidence.`);
  const profileSeed = JSON.stringify({ mapId, sourceHash: dataset.sourceHash, selector, levelIds: cohort.map((row) => row.id) });
  return {
    referenceProfileId: `reference-${createHash("sha256").update(profileSeed).digest("hex").slice(0, 12)}`,
    mapId,
    sourceFile: dataset.sourceFile,
    sourceHash: dataset.sourceHash,
    selector,
    availableLevelCount: dataset.levels.length,
    cohort,
    envelope,
    recommendedTargets: {
      amountStyle: amountUseRate >= 0.25 ? "balanced" : "single-unit",
      amountSlotRatio: [envelope.amountSlotRatio.p25, envelope.amountSlotRatio.p75],
      compactedUnitRatio: [envelope.compactedUnitRatio.p25, envelope.compactedUnitRatio.p75],
      maximumAdjacentDuplicateRatio: envelope.adjacentDuplicateRatio.p75,
      maximumIdenticalRun: Math.max(1, Math.ceil(envelope.maxIdenticalRun.p75)),
      maximumCrossLaneCloneRatio: envelope.crossLaneCloneRatio.p75,
      minimumTransitionEntropy: envelope.transitionEntropy.p25,
      maximumRepeatedNgramRatio: envelope.repeatedNgramRatio.p75,
      maximumLocalIngredientDominance: envelope.localIngredientDominance.p75,
      maximumReferenceStyleDistance: 0.35,
      maximumNearestReferenceSimilarity: 0.7,
    },
    warnings,
  };
}

export function compareQueueToReferences(
  queueString: string,
  dataset: ReferenceLevelDataset,
  analysis: ReferenceLevelAnalysis,
): { referenceStyleDistance: number; nearestReferenceSimilarity: number; nearestReferenceLevelId: number | null } {
  const candidateLanes = queueLanesFromString(queueString);
  const metrics = analyzeLevelQueueTexture({ queueString });
  let nearestReferenceSimilarity = 0;
  let nearestReferenceLevelId: number | null = null;
  for (const reference of dataset.levels.filter((level) => analysis.cohort.some((row) => row.id === level.id))) {
    const similarity = queueSequenceSimilarity(candidateLanes, queueLanesFromString(reference.queueString));
    if (similarity > nearestReferenceSimilarity) {
      nearestReferenceSimilarity = similarity;
      nearestReferenceLevelId = reference.id;
    }
  }
  return {
    referenceStyleDistance: referenceStyleDistance(metrics, analysis.envelope),
    nearestReferenceSimilarity,
    nearestReferenceLevelId,
  };
}
