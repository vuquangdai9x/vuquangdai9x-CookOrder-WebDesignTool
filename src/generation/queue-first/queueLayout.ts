import type { QueueTextureMetrics } from "./contracts.ts";
import type { AmountSlotDraft } from "./amountPartitioner.ts";
import type { EffectInstance } from "../../core/types.ts";

export interface LaidOutSlot extends AmountSlotDraft {
  id: string;
  effects: EffectInstance[];
}

function takeBest(
  remaining: AmountSlotDraft[],
  lanes: LaidOutSlot[][],
  lane: number,
  row: number,
  random: () => number,
): AmountSlotDraft {
  const byIngredient = new Map<number, AmountSlotDraft[]>();
  for (const slot of remaining) {
    const list = byIngredient.get(slot.ingredient);
    if (list) list.push(slot);
    else byIngredient.set(slot.ingredient, [slot]);
  }
  const previous = lanes[lane][row - 1]?.ingredient;
  const left = lanes[lane - 1]?.[row]?.ingredient;
  const ranked = [...byIngredient.entries()].map(([ingredient, slots]) => {
    let score = slots.length * 2 + random();
    if (ingredient === previous) score -= 12;
    if (ingredient === left) score -= 8;
    for (let x = 0; x < lanes.length; x++) if (lanes[x][row]?.ingredient === ingredient) score -= 3;
    return { ingredient, slots, score };
  }).sort((a, b) => b.score - a.score || a.ingredient - b.ingredient);
  const selected = ranked[0].slots.sort((a, b) => b.amount - a.amount)[0];
  remaining.splice(remaining.indexOf(selected), 1);
  return selected;
}

export function layoutQueue(
  slots: readonly AmountSlotDraft[],
  laneCount: number,
  vectorHash: string,
  random: () => number,
): LaidOutSlot[][] {
  const lanes: LaidOutSlot[][] = Array.from({ length: laneCount }, () => []);
  const remaining = slots.map((slot) => ({ ...slot }));
  let position = 0;
  while (remaining.length > 0) {
    const lane = position % laneCount;
    const row = Math.floor(position / laneCount);
    const slot = takeBest(remaining, lanes, lane, row, random);
    lanes[lane].push({
      ...slot,
      id: `slot-${vectorHash.slice(0, 8)}-${lane}-${row}`,
      effects: [],
    });
    position++;
  }
  return lanes;
}

export function measureQueueTexture(lanes: ReadonlyArray<ReadonlyArray<{ ingredient: number }>>): QueueTextureMetrics {
  let maximumIdenticalRun = 0;
  const transitions = new Map<string, number>();
  let transitionTotal = 0;
  for (const lane of lanes) {
    let run = 0;
    let previous: number | undefined;
    for (const slot of lane) {
      run = slot.ingredient === previous ? run + 1 : 1;
      maximumIdenticalRun = Math.max(maximumIdenticalRun, run);
      if (previous !== undefined) {
        const key = `${previous}>${slot.ingredient}`;
        transitions.set(key, (transitions.get(key) ?? 0) + 1);
        transitionTotal++;
      }
      previous = slot.ingredient;
    }
  }
  let entropy = 0;
  if (transitionTotal > 0 && transitions.size > 1) {
    for (const count of transitions.values()) {
      const probability = count / transitionTotal;
      entropy -= probability * Math.log2(probability);
    }
    entropy /= Math.log2(transitions.size);
  }
  let mirrored = 0;
  let mirrorComparisons = 0;
  const maxDepth = Math.max(0, ...lanes.map((lane) => lane.length));
  for (let y = 0; y < maxDepth; y++) {
    for (let x = 1; x < lanes.length; x++) {
      const a = lanes[x - 1][y];
      const b = lanes[x][y];
      if (!a || !b) continue;
      mirrorComparisons++;
      if (a.ingredient === b.ingredient) mirrored++;
    }
  }
  const depths = lanes.map((lane) => lane.length);
  const average = depths.reduce((sum, depth) => sum + depth, 0) / Math.max(1, depths.length);
  return {
    maximumIdenticalRun,
    crossLaneMirroring: mirrorComparisons === 0 ? 0 : mirrored / mirrorComparisons,
    transitionEntropy: entropy,
    laneImbalance: average === 0 ? 0 : (Math.max(...depths) - Math.min(...depths)) / average,
  };
}
