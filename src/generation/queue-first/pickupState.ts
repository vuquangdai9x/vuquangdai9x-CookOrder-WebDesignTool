import {
  QueueStructuralState,
  type QueueStructuralSnapshot,
} from "../../ui/design/queueThawCheck.ts";
import { artifactHash } from "./artifactHash.ts";
import type { PickupPlanStep, QueueArtifact } from "./contracts.ts";
import { projectQueueArtifact } from "./validation.ts";

export interface LegalPickupAction {
  id: string;
  slotIds: string[];
  releasedUnits: Record<string, number>;
  grouped: boolean;
}

export interface PickupReplayResult {
  valid: boolean;
  error?: string;
  errorStep?: number;
  remaining: number;
  stateHash: string;
  legalActions: LegalPickupAction[];
  /** Runtime queue positions after replaying the requested prefix. */
  snapshot: QueueStructuralSnapshot;
}

function slotMaps(queue: QueueArtifact): {
  idByCoordinate: Map<string, string>;
  slotById: Map<string, QueueArtifact["lanes"][number]["slots"][number]>;
  groupedIds: Set<string>;
} {
  const idByCoordinate = new Map<string, string>();
  const slotById = new Map<string, QueueArtifact["lanes"][number]["slots"][number]>();
  queue.lanes.forEach((lane, x) => lane.slots.forEach((slot, y) => {
    idByCoordinate.set(`${x}:${y}`, slot.id);
    slotById.set(slot.id, slot);
  }));
  return {
    idByCoordinate,
    slotById,
    groupedIds: new Set(queue.groups.flatMap((group) => group.slotIds)),
  };
}

function actionId(slotIds: readonly string[]): string {
  return `action:${[...slotIds].sort().join("+")}`;
}

function publicActions(queue: QueueArtifact, state: QueueStructuralState): LegalPickupAction[] {
  const maps = slotMaps(queue);
  return state.legalActions().map((action) => {
    const slotIds = action.cells.map((cell) => maps.idByCoordinate.get(`${cell.x}:${cell.y}`))
      .filter((id): id is string => id !== undefined)
      .sort();
    const releasedUnits: Record<string, number> = {};
    for (const slotId of slotIds) {
      const slot = maps.slotById.get(slotId)!;
      const ingredient = String(slot.ingredient);
      releasedUnits[ingredient] = (releasedUnits[ingredient] ?? 0) + slot.amount;
    }
    return {
      id: actionId(slotIds),
      slotIds,
      releasedUnits,
      grouped: slotIds.length > 1 || slotIds.some((id) => maps.groupedIds.has(id)),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function structuralIdFor(
  queue: QueueArtifact,
  state: QueueStructuralState,
  slotIds: readonly string[],
): string | undefined {
  const wanted = new Set(slotIds);
  const maps = slotMaps(queue);
  return state.legalActions().find((action) => {
    const ids = action.cells.map((cell) => maps.idByCoordinate.get(`${cell.x}:${cell.y}`));
    return ids.length === wanted.size && ids.every((id) => id !== undefined && wanted.has(id));
  })?.id;
}

export function replayPickupSteps(queue: QueueArtifact, steps: readonly PickupPlanStep[]): PickupReplayResult {
  const runtime = projectQueueArtifact(queue);
  const state = new QueueStructuralState(runtime.queues, runtime.groups);
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const structuralId = structuralIdFor(queue, state, step.slotIds);
    if (!structuralId) {
      const snapshot = state.snapshot();
      return {
        valid: false,
        error: `Step ${index + 1} action ${step.actionId} is not legal.`,
        errorStep: index,
        remaining: state.remaining,
        stateHash: artifactHash(snapshot),
        legalActions: publicActions(queue, state),
        snapshot,
      };
    }
    state.apply(structuralId);
  }
  const snapshot = state.snapshot();
  return {
    valid: true,
    remaining: state.remaining,
    stateHash: artifactHash(snapshot),
    legalActions: publicActions(queue, state),
    snapshot,
  };
}

export function appendPickupAction(
  queue: QueueArtifact,
  steps: readonly PickupPlanStep[],
  selectedActionId: string,
): { step?: PickupPlanStep; replay: PickupReplayResult; error?: string } {
  const before = replayPickupSteps(queue, steps);
  if (!before.valid) return { replay: before, error: before.error };
  const selected = before.legalActions.find((action) => action.id === selectedActionId);
  if (!selected) return { replay: before, error: `Pickup action ${selectedActionId} is not currently legal.` };
  const provisional: PickupPlanStep = {
    index: steps.length,
    actionId: selected.id,
    slotIds: selected.slotIds,
    releasedUnits: selected.releasedUnits,
    legalAlternatives: before.legalActions.map((action) => action.id),
    stateHashAfter: "",
  };
  const after = replayPickupSteps(queue, [...steps, provisional]);
  provisional.stateHashAfter = after.stateHash;
  return { step: provisional, replay: after };
}
