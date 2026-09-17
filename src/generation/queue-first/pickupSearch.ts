import { deriveSeed, seededRandom } from "./artifactHash.ts";
import type { PickupPlanArtifact, PickupPlanningVectorArtifact, QueueArtifact } from "./contracts.ts";
import {
  appendManualPickupStep,
  refreshPickupPlanArtifact,
  validatePickupPlan,
} from "./phase2PickupPlan.ts";
import { replayPickupSteps } from "./pickupState.ts";

export interface PickupSearchResult {
  artifact: PickupPlanArtifact;
  complete: boolean;
  exhausted: boolean;
  reason?: string;
}

interface Candidate {
  artifact: PickupPlanArtifact;
  score: number;
  tie: number;
}

const now = (): number => typeof performance === "undefined" ? Date.now() : performance.now();

function candidateScore(
  artifact: PickupPlanArtifact,
  queue: QueueArtifact,
  vector: PickupPlanningVectorArtifact,
): number {
  const replay = replayPickupSteps(queue, artifact.steps);
  const laneCounts = new Map<number, number>();
  const slotLane = new Map<string, number>();
  queue.lanes.forEach((lane, laneIndex) => lane.slots.forEach((slot) => slotLane.set(slot.id, laneIndex)));
  for (const step of artifact.steps) {
    for (const slotId of step.slotIds) {
      const lane = slotLane.get(slotId) ?? -1;
      laneCounts.set(lane, (laneCounts.get(lane) ?? 0) + 1);
    }
  }
  const laneValues = [...laneCounts.values()];
  const imbalance = laneValues.length === 0 ? 0 : Math.max(...laneValues) - Math.min(...laneValues);
  const last = artifact.steps.at(-1);
  const burst = last ? Object.values(last.releasedUnits).reduce((sum, value) => sum + value, 0) : 0;
  const previous = artifact.steps.at(-2);
  const aligned = last && previous
    ? Object.keys(last.releasedUnits).some((key) => key in previous.releasedUnits)
    : false;
  return -replay.remaining * 10_000
    + replay.legalActions.length * 20
    - imbalance * vector.values.preferLaneBalance
    + (aligned ? vector.values.preferIngredientWaveAlignment : 0)
    - Math.max(0, burst - (vector.values.targetWaveSize ?? 1)) * vector.values.penalizeAmountBurst;
}

/**
 * Deterministic bounded beam search. A partial prefix is preserved on budget exhaustion,
 * allowing manual-with-auto-suffix to continue from exactly what the designer authored.
 */
export function autoCompletePickupPlan(
  source: PickupPlanArtifact,
  queue: QueueArtifact,
  vector: PickupPlanningVectorArtifact,
): PickupSearchResult {
  if (source.queueHash !== queue.contentHash) {
    return { artifact: source, complete: false, exhausted: false, reason: "Pickup plan is stale for the current queue." };
  }
  const initialReplay = replayPickupSteps(queue, source.steps);
  if (!initialReplay.valid) {
    return { artifact: source, complete: false, exhausted: false, reason: initialReplay.error };
  }
  if (initialReplay.remaining === 0) return { artifact: source, complete: true, exhausted: false };

  const limits = vector.values.search;
  const beamWidth = Math.max(1, Math.trunc(limits.beamWidth));
  const maxExpanded = Math.max(1, Math.trunc(limits.maximumExpandedStates));
  const deadline = now() + Math.max(1, limits.wallTimeMs);
  const random = seededRandom(deriveSeed(vector.values.seed, `pickup-search:${source.contentHash}`));
  let beam: Candidate[] = [{ artifact: source, score: candidateScore(source, queue, vector), tie: random() }];
  let best = beam[0];
  let expanded = 0;
  let exhausted = false;

  while (beam.length > 0) {
    const next: Candidate[] = [];
    for (const candidate of beam) {
      if (expanded >= maxExpanded || now() >= deadline) {
        exhausted = true;
        break;
      }
      const replay = replayPickupSteps(queue, candidate.artifact.steps);
      if (replay.remaining === 0) {
        const complete = refreshPickupPlanArtifact({
          ...candidate.artifact,
          status: "valid",
          completion: "complete",
          diagnostics: { ...candidate.artifact.diagnostics, expandedStates: expanded, deadlockFree: true },
        });
        return { artifact: complete, complete: true, exhausted: false };
      }
      for (const action of replay.legalActions) {
        if (expanded >= maxExpanded || now() >= deadline) {
          exhausted = true;
          break;
        }
        const appended = appendManualPickupStep(
          candidate.artifact,
          queue,
          candidate.artifact.contentHash,
          action.id,
        );
        expanded++;
        if (appended.error) continue;
        const entry: Candidate = {
          artifact: appended.artifact,
          score: candidateScore(appended.artifact, queue, vector),
          tie: random(),
        };
        next.push(entry);
        if (entry.artifact.steps.length > best.artifact.steps.length || entry.score > best.score) best = entry;
      }
    }
    if (exhausted) break;
    next.sort((a, b) => b.score - a.score || a.tie - b.tie || a.artifact.contentHash.localeCompare(b.artifact.contentHash));
    const seen = new Set<string>();
    beam = next.filter((entry) => {
      const state = entry.artifact.steps.at(-1)?.stateHashAfter ?? "start";
      if (seen.has(state)) return false;
      seen.add(state);
      return true;
    }).slice(0, beamWidth);
  }

  const artifact = refreshPickupPlanArtifact({
    ...best.artifact,
    status: "draft",
    completion: "partial",
    warnings: [...best.artifact.warnings, exhausted ? "Pickup search budget exhausted." : "No complete pickup route was found."],
    diagnostics: { ...best.artifact.diagnostics, expandedStates: expanded, deadlockFree: "inconclusive" },
  });
  return {
    artifact,
    complete: false,
    exhausted,
    reason: exhausted ? "Pickup search budget exhausted." : "No complete pickup route was found.",
  };
}

export function validateAutomaticPickupPlan(
  artifact: PickupPlanArtifact,
  queue: QueueArtifact,
  vector: PickupPlanningVectorArtifact,
): { valid: boolean; errors: string[] } {
  const result = validatePickupPlan(artifact, queue);
  const errors = [...result.errors];
  if (artifact.vectorHash !== vector.contentHash) errors.push("Pickup plan vector hash does not match the confirmed vector.");
  if (artifact.completion !== "complete") errors.push("Pickup plan is incomplete.");
  return { valid: errors.length === 0, errors };
}
