import { EFFECT_FREEZE, EFFECT_HIDDEN, EFFECT_HOLDING_KEY } from "../../core/effects.ts";
import type { GraphIndex } from "../../core/nodeIndex.ts";
import type { QueueCellRef, QueueGroup, QueueItem } from "../../core/types.ts";
import { checkQueueThaw } from "../../ui/design/queueThawCheck.ts";
import type {
  AuthoringContextArtifact,
  QueueArtifact,
  QueueArtifactGroup,
  QueueGenerationVector,
  QueueGenerationVectorArtifact,
} from "./contracts.ts";

export interface RuntimeQueueArtifact {
  queues: QueueItem[][];
  groups: QueueGroup[];
  coordinatesBySlotId: Map<string, QueueCellRef>;
}

export interface QueueArtifactValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  structuralVerdict: "safe" | "risky" | "deadlock" | "unknown";
  structuralMessage: string;
}

export function projectQueueArtifact(artifact: QueueArtifact): RuntimeQueueArtifact {
  const coordinatesBySlotId = new Map<string, QueueCellRef>();
  const queues = artifact.lanes.map((lane, x) => lane.slots.map((slot, y) => {
    coordinatesBySlotId.set(slot.id, { x, y });
    return {
      kind: "ingredient" as const,
      id: slot.ingredient,
      amount: slot.amount > 1 ? slot.amount : undefined,
      effects: slot.effects.map((effect) => ({ ...effect, params: [...effect.params] })),
    };
  }));
  const groups = artifact.groups.map((group) => ({
    kind: group.kind,
    cells: group.slotIds
      .map((id) => coordinatesBySlotId.get(id))
      .filter((cell): cell is QueueCellRef => cell !== undefined),
  }));
  return { queues, groups, coordinatesBySlotId };
}

function isConnected(cells: readonly QueueCellRef[]): boolean {
  if (cells.length === 0) return false;
  const all = new Set(cells.map((cell) => `${cell.x}:${cell.y}`));
  const seen = new Set<string>();
  const pending = [cells[0]];
  while (pending.length > 0) {
    const cell = pending.pop()!;
    const cellKey = `${cell.x}:${cell.y}`;
    if (seen.has(cellKey)) continue;
    seen.add(cellKey);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const next = `${cell.x + dx}:${cell.y + dy}`;
      if (all.has(next) && !seen.has(next)) pending.push({ x: cell.x + dx, y: cell.y + dy });
    }
  }
  return seen.size === all.size;
}

function validateGroup(
  group: QueueArtifactGroup,
  coordinates: ReadonlyMap<string, QueueCellRef>,
  claimed: Set<string>,
  errors: string[],
): void {
  if (group.slotIds.length < 2 || group.slotIds.length > 5) {
    errors.push(`Group ${group.id} must contain between 2 and 5 slots.`);
  }
  const unique = new Set(group.slotIds);
  if (unique.size !== group.slotIds.length) errors.push(`Group ${group.id} contains duplicate slots.`);
  for (const slotId of unique) {
    if (!coordinates.has(slotId)) errors.push(`Group ${group.id} references missing slot ${slotId}.`);
    if (claimed.has(slotId)) errors.push(`Slot ${slotId} belongs to more than one group.`);
    claimed.add(slotId);
  }
  if (group.kind === "combined") {
    const cells = [...unique].map((id) => coordinates.get(id)).filter((cell): cell is QueueCellRef => !!cell);
    if (cells.length === unique.size && !isConnected(cells)) {
      errors.push(`Combined group ${group.id} is not four-connected.`);
    }
  } else {
    const cells = [...unique].map((id) => coordinates.get(id)).filter((cell): cell is QueueCellRef => !!cell);
    const columns = cells.map((cell) => cell.x).sort((a, b) => a - b);
    if (cells.length === unique.size && (new Set(columns).size !== cells.length
      || columns.some((column, index) => index > 0 && column !== columns[index - 1] + 1))) {
      errors.push(`Linked group ${group.id} must use one slot from each adjacent column; rows may differ.`);
    }
  }
}

export function validateQueueArtifact(
  artifact: QueueArtifact,
  vectorArtifact: QueueGenerationVectorArtifact,
  context: AuthoringContextArtifact,
  index: GraphIndex,
): QueueArtifactValidation {
  const vector: QueueGenerationVector = vectorArtifact.values;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (artifact.contextHash !== context.contentHash) errors.push("Queue context hash does not match the current context.");
  if (artifact.graphHash !== context.graphHash) errors.push("Queue graph hash does not match the current context.");
  if (artifact.vectorHash !== vectorArtifact.contentHash) errors.push("Queue vector hash does not match the confirmed vector.");
  const projected = projectQueueArtifact(artifact);
  const slotIds = new Set<string>();
  let units = 0;
  for (const lane of artifact.lanes) {
    for (const slot of lane.slots) {
      if (slotIds.has(slot.id)) errors.push(`Duplicate queue slot id ${slot.id}.`);
      slotIds.add(slot.id);
      if (!Number.isInteger(slot.ingredient) || index.pickupable[slot.ingredient] !== 1) {
        errors.push(`Slot ${slot.id} ingredient ${slot.ingredient} is not a pickupable graph node.`);
      }
      if (!Number.isInteger(slot.amount) || slot.amount < 1) {
        errors.push(`Slot ${slot.id} has invalid amount ${slot.amount}.`);
      } else {
        units += slot.amount;
        const id = String(slot.ingredient);
        const configured = vector.amountRanges?.[id];
        const graph = index.stackRange[slot.ingredient] ?? { min: 1, max: 1 };
        const min = Math.max(1, configured?.min ?? graph.min);
        const max = Math.max(min, configured?.max ?? graph.max);
        if (slot.amount !== 1 && (slot.amount < min || slot.amount > max)) {
          errors.push(`Slot ${slot.id} amount ${slot.amount} is outside the legal range 1 or ${min}-${max}.`);
        }
      }
      for (const effect of slot.effects) {
        const mechanic = effect.effectId === EFFECT_FREEZE
          ? "freeze"
          : effect.effectId === EFFECT_HIDDEN
            ? "hidden"
            : effect.effectId === EFFECT_HOLDING_KEY
              ? "holdingKey"
              : null;
        if (!mechanic) errors.push(`Slot ${slot.id} uses unsupported queue effect ${effect.effectId}.`);
        else if (!context.authorizedMechanics.includes(mechanic)) {
          errors.push(`Slot ${slot.id} uses unauthorized mechanic ${mechanic}.`);
        }
      }
    }
  }
  if (units !== vector.targetPickupUnits) {
    errors.push(`Queue contains ${units} pickup units; vector requires ${vector.targetPickupUnits}.`);
  }
  const claimed = new Set<string>();
  for (const group of artifact.groups) validateGroup(group, projected.coordinatesBySlotId, claimed, errors);
  const audit = checkQueueThaw(projected.queues, projected.groups, {
    maxStates: 250_000,
    timeBudgetMs: Number.POSITIVE_INFINITY,
    randomRuns: 100,
    sampleBudgetMs: Number.POSITIVE_INFINITY,
  });
  if (audit.verdict === "deadlock") errors.push(`Queue structural deadlock: ${audit.message}`);
  if (audit.verdict === "unknown") errors.push(`Queue structural validation was inconclusive: ${audit.message}`);
  if (audit.verdict === "risky") warnings.push(audit.message);
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    structuralVerdict: audit.verdict,
    structuralMessage: audit.message,
  };
}
