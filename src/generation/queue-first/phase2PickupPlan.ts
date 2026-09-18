import { artifactHash } from "./artifactHash.ts";
import type {
  AuthoringContextArtifact,
  PhaseReadinessIssue,
  PickupPlanArtifact,
  PickupPlanningVectorArtifact,
  QueueArtifact,
} from "./contracts.ts";
import { getPhaseReadiness } from "./phaseReadiness.ts";
import { appendPickupAction, replayPickupSteps } from "./pickupState.ts";

export type CreatePickupPlanResult =
  | { started: false; readinessIssues: PhaseReadinessIssue[] }
  | { started: true; artifact: PickupPlanArtifact };

export function refreshPickupPlanArtifact(artifact: PickupPlanArtifact): PickupPlanArtifact {
  const contentHash = artifactHash({
    queueHash: artifact.queueHash,
    vectorHash: artifact.vectorHash,
    mode: artifact.mode,
    completion: artifact.completion,
    steps: artifact.steps,
  });
  return { ...artifact, id: `pickup-plan-${contentHash.slice(0, 12)}`, contentHash };
}

export function createPickupPlan(
  context: AuthoringContextArtifact,
  vector: PickupPlanningVectorArtifact,
  queue: QueueArtifact,
  createdAt?: string,
): CreatePickupPlanResult {
  const readiness = getPhaseReadiness({ phase: "pickup", context, vector, queue });
  if (!readiness.ready) return { started: false, readinessIssues: readiness.issues };
  const replay = replayPickupSteps(queue, []);
  const artifact = refreshPickupPlanArtifact({
    schemaVersion: 1,
    kind: "pickup-plan",
    id: "",
    createdAt: createdAt ?? vector.confirmedAt ?? vector.createdAt,
    seed: vector.values.seed,
    graphHash: context.graphHash,
    upstreamHashes: [queue.contentHash, vector.contentHash],
    contentHash: "",
    status: "draft",
    warnings: [],
    queueHash: queue.contentHash,
    vectorHash: vector.contentHash,
    mode: vector.values.mode,
    completion: replay.remaining === 0 ? "complete" : "partial",
    steps: [],
    diagnostics: {
      actionCount: 0,
      groupedActionCount: 0,
      amountBurstHistogram: {},
      maximumLegalBranching: replay.legalActions.length,
      expandedStates: 0,
      deadlockFree: replay.remaining === 0 ? true : "inconclusive",
    },
  });
  if (artifact.completion === "complete") artifact.status = "valid";
  return { started: true, artifact };
}

export function appendManualPickupStep(
  artifact: PickupPlanArtifact,
  queue: QueueArtifact,
  expectedRevision: string,
  actionId: string,
): { artifact: PickupPlanArtifact; error?: string } {
  if (artifact.contentHash !== expectedRevision) return { artifact, error: "Pickup plan revision conflict." };
  if (artifact.queueHash !== queue.contentHash) return { artifact, error: "Pickup plan is stale for the current queue." };
  if (artifact.completion === "complete") return { artifact, error: "Pickup plan is already complete." };
  const appended = appendPickupAction(queue, artifact.steps, actionId);
  if (!appended.step) return { artifact, error: appended.error };
  const steps = [...artifact.steps, appended.step];
  const amountBurstHistogram = { ...artifact.diagnostics.amountBurstHistogram };
  const released = Object.values(appended.step.releasedUnits).reduce((sum, amount) => sum + amount, 0);
  amountBurstHistogram[String(released)] = (amountBurstHistogram[String(released)] ?? 0) + 1;
  const completion = appended.replay.remaining === 0 ? "complete" : "partial";
  return {
    artifact: refreshPickupPlanArtifact({
      ...artifact,
      status: completion === "complete" ? "valid" : "draft",
      completion,
      steps,
      diagnostics: {
        ...artifact.diagnostics,
        actionCount: steps.length,
        groupedActionCount: artifact.diagnostics.groupedActionCount
          + (appended.step.slotIds.length > 1 ? 1 : 0),
        amountBurstHistogram,
        maximumLegalBranching: Math.max(
          artifact.diagnostics.maximumLegalBranching,
          appended.step.legalAlternatives.length,
        ),
        deadlockFree: completion === "complete" ? true : "inconclusive",
      },
    }),
  };
}

/** Replays and truncates a manual route without mutating the supplied revision. */
export function truncatePickupPlan(
  artifact: PickupPlanArtifact,
  queue: QueueArtifact,
  expectedRevision: string,
  stepCount: number,
): { artifact: PickupPlanArtifact; error?: string } {
  if (artifact.contentHash !== expectedRevision) return { artifact, error: "Pickup plan revision conflict." };
  const count = Math.max(0, Math.min(artifact.steps.length, Math.trunc(stepCount)));
  const steps = artifact.steps.slice(0, count);
  const replay = replayPickupSteps(queue, steps);
  if (!replay.valid) return { artifact, error: replay.error };
  const amountBurstHistogram: Record<string, number> = {};
  let groupedActionCount = 0;
  let maximumLegalBranching = 0;
  for (const step of steps) {
    const released = Object.values(step.releasedUnits).reduce((sum, amount) => sum + amount, 0);
    amountBurstHistogram[String(released)] = (amountBurstHistogram[String(released)] ?? 0) + 1;
    if (step.slotIds.length > 1) groupedActionCount++;
    maximumLegalBranching = Math.max(maximumLegalBranching, step.legalAlternatives.length);
  }
  const completion = replay.remaining === 0 ? "complete" : "partial";
  return {
    artifact: refreshPickupPlanArtifact({
      ...artifact,
      steps,
      completion,
      status: completion === "complete" ? "valid" : "draft",
      diagnostics: {
        ...artifact.diagnostics,
        actionCount: steps.length,
        groupedActionCount,
        amountBurstHistogram,
        maximumLegalBranching,
        deadlockFree: completion === "complete" ? true : "inconclusive",
      },
    }),
  };
}

export function validatePickupPlan(
  artifact: PickupPlanArtifact,
  queue: QueueArtifact,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (artifact.queueHash !== queue.contentHash) errors.push("Pickup plan queue hash does not match the current queue.");
  const replay = replayPickupSteps(queue, artifact.steps);
  if (!replay.valid) errors.push(replay.error ?? "Pickup plan replay failed.");
  if (artifact.completion === "complete" && replay.remaining !== 0) errors.push("Complete pickup plan does not empty the queue.");
  if (artifact.completion === "partial" && replay.remaining === 0) errors.push("Pickup plan is marked partial but empties the queue.");
  return { valid: errors.length === 0, errors };
}
