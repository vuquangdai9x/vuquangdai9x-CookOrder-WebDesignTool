import type { LevelData } from "../data/mapLoader.ts";
import type { SessionDraft } from "./types.ts";

export interface QueueTextureSlot {
  ingredient: string;
  amount: number;
}

export interface QueueTextureMetrics {
  authoredSlots: number;
  expandedUnits: number;
  distinctIngredients: number;
  amountSlotRatio: number;
  compactedUnitRatio: number;
  adjacentDuplicateRatio: number;
  maxIdenticalRun: number;
  crossLaneCloneRatio: number;
  transitionEntropy: number;
  repeatedNgramRatio: number;
  localIngredientDominance: number;
}

export interface QueueTextureEnvelope {
  sampleCount: number;
  amountSlotRatio: PercentileBand;
  compactedUnitRatio: PercentileBand;
  adjacentDuplicateRatio: PercentileBand;
  maxIdenticalRun: PercentileBand;
  crossLaneCloneRatio: PercentileBand;
  transitionEntropy: PercentileBand;
  repeatedNgramRatio: PercentileBand;
  localIngredientDominance: PercentileBand;
}

export interface PercentileBand {
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

const amount = (value: number | undefined): number => Math.max(1, Math.floor(value ?? 1));

export function queueLanesFromDraft(draft: SessionDraft): QueueTextureSlot[][] {
  return draft.lanes.map((lane) => lane.slots.map((slot) => ({
    ingredient: String(slot.ingredientId),
    amount: amount(slot.amount),
  })));
}

/** Parse only the ingredient/amount portion; effects and group suffixes do not affect texture. */
export function queueLanesFromString(queueString: string): QueueTextureSlot[][] {
  const queueOnly = queueString.split("$", 1)[0] ?? "";
  return queueOnly.split("%").map((lane) => lane.split(",").flatMap((token) => {
    const ingredientToken = (token.split("#", 1)[0] ?? "").trim();
    if (!ingredientToken) return [];
    const [ingredient, rawAmount] = ingredientToken.split(":");
    if (!/^\d+$/.test(ingredient)) return [];
    const parsedAmount = rawAmount === undefined ? 1 : Number(rawAmount);
    return [{ ingredient, amount: Number.isFinite(parsedAmount) ? amount(parsedAmount) : 1 }];
  }));
}

function normalizedEntropy(counts: Map<string, number>, distinctIngredients: number): number {
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 1 || distinctIngredients <= 1) return 0;
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / total;
    entropy -= probability * Math.log2(probability);
  }
  return entropy / Math.log2(Math.max(2, distinctIngredients * distinctIngredients));
}

function maximumWindowDominance(lanes: QueueTextureSlot[][], windowSize = 5): number {
  let maximum = 0;
  for (const lane of lanes) {
    for (let start = 0; start < lane.length; start++) {
      const window = lane.slice(start, start + windowSize);
      if (!window.length) continue;
      const counts = new Map<string, number>();
      window.forEach((slot) => counts.set(slot.ingredient, (counts.get(slot.ingredient) ?? 0) + 1));
      maximum = Math.max(maximum, Math.max(...counts.values()) / window.length);
    }
  }
  return maximum;
}

export function analyzeQueueTexture(lanes: QueueTextureSlot[][]): QueueTextureMetrics {
  const slots = lanes.flat();
  const expandedUnits = slots.reduce((sum, slot) => sum + amount(slot.amount), 0);
  const amountSlots = slots.filter((slot) => amount(slot.amount) > 1);
  let adjacentPairs = 0;
  let adjacentDuplicates = 0;
  let maxIdenticalRun = 0;
  let ngrams = 0;
  const uniqueNgrams = new Set<string>();
  const transitions = new Map<string, number>();

  for (const lane of lanes) {
    let previous = "";
    let run = 0;
    for (let index = 0; index < lane.length; index++) {
      const current = lane[index].ingredient;
      run = current === previous ? run + 1 : 1;
      maxIdenticalRun = Math.max(maxIdenticalRun, run);
      if (index > 0) {
        adjacentPairs++;
        if (current === previous) adjacentDuplicates++;
        const transition = `${previous}>${current}`;
        transitions.set(transition, (transitions.get(transition) ?? 0) + 1);
      }
      if (index >= 2) {
        ngrams++;
        uniqueNgrams.add(`${lane[index - 2].ingredient}>${previous}>${current}`);
      }
      previous = current;
    }
  }

  let crossLaneComparisons = 0;
  let crossLaneMatches = 0;
  for (let left = 0; left < lanes.length; left++) {
    for (let right = left + 1; right < lanes.length; right++) {
      const overlap = Math.min(lanes[left].length, lanes[right].length);
      for (let depth = 0; depth < overlap; depth++) {
        crossLaneComparisons++;
        if (lanes[left][depth].ingredient === lanes[right][depth].ingredient) crossLaneMatches++;
      }
    }
  }

  const adjacentDuplicateRatio = adjacentPairs ? adjacentDuplicates / adjacentPairs : 0;

  return {
    authoredSlots: slots.length,
    expandedUnits,
    distinctIngredients: new Set(slots.map((slot) => slot.ingredient)).size,
    amountSlotRatio: slots.length ? amountSlots.length / slots.length : 0,
    compactedUnitRatio: expandedUnits
      ? amountSlots.reduce((sum, slot) => sum + amount(slot.amount), 0) / expandedUnits
      : 0,
    adjacentDuplicateRatio,
    maxIdenticalRun,
    crossLaneCloneRatio: crossLaneComparisons ? crossLaneMatches / crossLaneComparisons : 0,
    // Self-repeat transitions can have high Shannon entropy while still looking dull;
    // discount them so this metric represents useful transition variety.
    transitionEntropy: normalizedEntropy(transitions, new Set(slots.map((slot) => slot.ingredient)).size) * (1 - adjacentDuplicateRatio),
    repeatedNgramRatio: ngrams ? 1 - uniqueNgrams.size / ngrams : 0,
    localIngredientDominance: maximumWindowDominance(lanes),
  };
}

export function analyzeDraftQueueTexture(draft: SessionDraft): QueueTextureMetrics {
  return analyzeQueueTexture(queueLanesFromDraft(draft));
}

export function analyzeLevelQueueTexture(level: Pick<LevelData, "queueString">): QueueTextureMetrics {
  return analyzeQueueTexture(queueLanesFromString(level.queueString));
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * ratio)] ?? 0;
}

function band(rows: QueueTextureMetrics[], key: keyof QueueTextureMetrics): PercentileBand {
  const values = rows.map((row) => Number(row[key]));
  return {
    p25: percentile(values, 0.25),
    p50: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p90: percentile(values, 0.9),
  };
}

export function textureEnvelope(rows: QueueTextureMetrics[]): QueueTextureEnvelope {
  return {
    sampleCount: rows.length,
    amountSlotRatio: band(rows, "amountSlotRatio"),
    compactedUnitRatio: band(rows, "compactedUnitRatio"),
    adjacentDuplicateRatio: band(rows, "adjacentDuplicateRatio"),
    maxIdenticalRun: band(rows, "maxIdenticalRun"),
    crossLaneCloneRatio: band(rows, "crossLaneCloneRatio"),
    transitionEntropy: band(rows, "transitionEntropy"),
    repeatedNgramRatio: band(rows, "repeatedNgramRatio"),
    localIngredientDominance: band(rows, "localIngredientDominance"),
  };
}

/** Zero means inside the reference interquartile envelope; one is a strong style outlier. */
export function referenceStyleDistance(metrics: QueueTextureMetrics, envelope: QueueTextureEnvelope): number {
  if (!envelope.sampleCount) return 1;
  const comparisons: Array<[keyof QueueTextureMetrics, PercentileBand]> = [
    ["amountSlotRatio", envelope.amountSlotRatio],
    ["compactedUnitRatio", envelope.compactedUnitRatio],
    ["adjacentDuplicateRatio", envelope.adjacentDuplicateRatio],
    ["crossLaneCloneRatio", envelope.crossLaneCloneRatio],
    ["transitionEntropy", envelope.transitionEntropy],
    ["repeatedNgramRatio", envelope.repeatedNgramRatio],
    ["localIngredientDominance", envelope.localIngredientDominance],
  ];
  const distances = comparisons.map(([key, range]) => {
    const value = Number(metrics[key]);
    if (value >= range.p25 && value <= range.p75) return 0;
    const edge = value < range.p25 ? range.p25 : range.p75;
    const scale = Math.max(0.05, range.p90 - range.p25, range.p75 - range.p25);
    return Math.min(1, Math.abs(value - edge) / scale);
  });
  return distances.reduce((sum, value) => sum + value, 0) / distances.length;
}

function trigrams(lanes: QueueTextureSlot[][]): Set<string> {
  const result = new Set<string>();
  lanes.forEach((lane) => {
    for (let index = 2; index < lane.length; index++) {
      result.add(`${lane[index - 2].ingredient}>${lane[index - 1].ingredient}>${lane[index].ingredient}`);
    }
  });
  return result;
}

/** Jaccard similarity of lane-local ingredient trigrams; used to avoid copying a reference sequence. */
export function queueSequenceSimilarity(left: QueueTextureSlot[][], right: QueueTextureSlot[][]): number {
  const a = trigrams(left);
  const b = trigrams(right);
  if (!a.size && !b.size) return 1;
  const intersection = [...a].filter((item) => b.has(item)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}
