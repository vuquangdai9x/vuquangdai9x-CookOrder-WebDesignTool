import { EFFECT_FREEZE, EFFECT_HIDDEN, EFFECT_HOLDING_KEY } from "../../core/effects.ts";
import type { QueueGroup, QueueItem } from "../../core/types.ts";
import { checkQueueThaw } from "../../ui/design/queueThawCheck.ts";
import type {
  QueueArtifactGroup,
  QueueGenerationVector,
  QueueMechanic,
} from "./contracts.ts";
import type { LaidOutSlot } from "./queueLayout.ts";

interface Candidate {
  x: number;
  y: number;
  slot: LaidOutSlot;
}

export interface EffectPlacementResult {
  targets: Record<QueueMechanic, number>;
  placements: Record<QueueMechanic, number>;
  warnings: string[];
}

function shuffle<T>(values: T[], random: () => number): void {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
}

function runtime(
  lanes: readonly LaidOutSlot[][],
  groups: readonly QueueArtifactGroup[],
): { queues: QueueItem[][]; queueGroups: QueueGroup[] } {
  const coordinate = new Map<string, { x: number; y: number }>();
  const queues = lanes.map((lane, x) => lane.map((slot, y) => {
    coordinate.set(slot.id, { x, y });
    return {
      kind: "ingredient" as const,
      id: slot.ingredient,
      amount: slot.amount > 1 ? slot.amount : undefined,
      effects: slot.effects.map((effect) => ({ ...effect, params: [...effect.params] })),
    };
  }));
  const queueGroups = groups.map((group) => ({
    kind: group.kind,
    cells: group.slotIds.map((id) => coordinate.get(id)).filter((cell): cell is { x: number; y: number } => !!cell),
  }));
  return { queues, queueGroups };
}

export function placeQueueEffects(
  lanes: LaidOutSlot[][],
  groups: readonly QueueArtifactGroup[],
  vector: QueueGenerationVector,
  random: () => number,
): EffectPlacementResult {
  const total = lanes.reduce((sum, lane) => sum + lane.length, 0);
  const targets: Record<QueueMechanic, number> = {
    freeze: Math.round(total * vector.obstacleCoverage.freeze),
    hidden: Math.round(total * vector.obstacleCoverage.hidden),
    holdingKey: Math.round(total * vector.obstacleCoverage.holdingKey),
  };
  const placements: Record<QueueMechanic, number> = { freeze: 0, hidden: 0, holdingKey: 0 };
  const warnings: string[] = [];
  const grouped = new Set(groups.flatMap((group) => group.slotIds));
  const candidates = lanes.flatMap((lane, x) => lane.map((slot, y) => ({ x, y, slot })))
    .filter((cell) => cell.y > 0 && !grouped.has(cell.slot.id));
  shuffle(candidates, random);

  const takePlain = (): Candidate | undefined => {
    const at = candidates.findIndex((candidate) => candidate.slot.effects.length === 0);
    if (at === -1) return undefined;
    return candidates.splice(at, 1)[0];
  };

  for (let i = 0; i < targets.holdingKey; i++) {
    const cell = takePlain();
    if (!cell) break;
    const colors = vector.holdingKeyColors ?? [];
    cell.slot.effects.push({ effectId: EFFECT_HOLDING_KEY, params: [colors[i % colors.length]] });
    placements.holdingKey++;
  }
  for (let i = 0; i < targets.hidden; i++) {
    const cell = takePlain();
    if (!cell) break;
    cell.slot.effects.push({ effectId: EFFECT_HIDDEN, params: [] });
    placements.hidden++;
  }

  const strength = vector.freezeStrength ?? { minAdjacentPicks: 1, maxAdjacentPicks: 2 };
  for (let i = 0; i < targets.freeze; i++) {
    const available = candidates.filter((candidate) => candidate.slot.effects.length === 0);
    let accepted = false;
    while (available.length > 0) {
      const cell = available.shift()!;
      const sourceAt = candidates.indexOf(cell);
      if (sourceAt !== -1) candidates.splice(sourceAt, 1);
      const range = strength.maxAdjacentPicks - strength.minAdjacentPicks + 1;
      const thaw = strength.minAdjacentPicks + Math.floor(random() * range);
      cell.slot.effects.push({ effectId: EFFECT_FREEZE, params: [thaw] });
      const projected = runtime(lanes, groups);
      const audit = checkQueueThaw(projected.queues, projected.queueGroups, {
        maxStates: 50_000,
        timeBudgetMs: Number.POSITIVE_INFINITY,
        randomRuns: 60,
        sampleBudgetMs: Number.POSITIVE_INFINITY,
      });
      if (audit.verdict !== "deadlock" && audit.verdict !== "unknown") {
        placements.freeze++;
        accepted = true;
        break;
      }
      cell.slot.effects.pop();
    }
    if (!accepted) break;
  }

  for (const mechanic of ["freeze", "hidden", "holdingKey"] as const) {
    if (placements[mechanic] < targets[mechanic]) {
      warnings.push(
        `Placed ${placements[mechanic]}/${targets[mechanic]} ${mechanic} effects; no safe ungrouped slot remained.`,
      );
    }
  }
  return { targets, placements, warnings };
}
