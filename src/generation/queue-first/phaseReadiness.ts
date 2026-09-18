import type {
  AuthoringContextArtifact,
  CustomerGenerationVectorArtifact,
  PhaseReadiness,
  PhaseReadinessIssue,
  PickupPlanArtifact,
  PickupPlanningVectorArtifact,
  QueueArtifact,
  QueueFirstPhase,
  QueueGenerationVectorArtifact,
} from "./contracts.ts";

type AnyVector =
  | QueueGenerationVectorArtifact
  | PickupPlanningVectorArtifact
  | CustomerGenerationVectorArtifact;

export interface PhaseReadinessInput {
  phase: QueueFirstPhase;
  context?: AuthoringContextArtifact;
  vector?: AnyVector;
  queue?: QueueArtifact;
  pickupPlan?: PickupPlanArtifact;
}

function artifactIssue(
  artifact: { status: string } | undefined,
  input: "context" | "queue" | "pickup-plan",
  label: string,
  action: string,
): PhaseReadinessIssue | null {
  if (!artifact) return { code: "missing-artifact", input, message: `${label} is required.`, action };
  if (artifact.status === "stale") {
    return { code: "stale-artifact", input, message: `${label} is stale.`, action };
  }
  if (artifact.status !== "valid") {
    return { code: "invalid-artifact", input, message: `${label} must be valid.`, action };
  }
  return null;
}

function vectorIssues(
  vector: AnyVector | undefined,
  expectedKind: AnyVector["kind"],
  context: AuthoringContextArtifact | undefined,
): PhaseReadinessIssue[] {
  if (!vector || vector.kind !== expectedKind) {
    return [{
      code: "missing-vector",
      input: "vector",
      message: `A ${expectedKind} artifact is required.`,
      action: `Create and confirm the ${expectedKind}.`,
    }];
  }
  const issues: PhaseReadinessIssue[] = [];
  if (vector.status === "stale") {
    issues.push({
      code: "stale-vector",
      input: "vector",
      message: "The phase vector is stale.",
      action: "Review the vector against the current context and confirm a new revision.",
    });
  } else if (vector.status !== "valid" || !vector.confirmedAt || !vector.confirmedBy) {
    issues.push({
      code: "unconfirmed-vector",
      input: "vector",
      message: "The phase vector has not been explicitly confirmed.",
      action: "Confirm the vector before starting the phase.",
    });
  }
  if (context && (vector.contextHash !== context.contentHash || vector.graphHash !== context.graphHash)) {
    issues.push({
      code: "context-mismatch",
      input: "vector",
      message: "The phase vector belongs to a different authoring context.",
      action: "Create a vector revision from the current context.",
    });
  }
  return issues;
}

export function getPhaseReadiness(input: PhaseReadinessInput): PhaseReadiness {
  const issues: PhaseReadinessIssue[] = [];
  const contextIssue = artifactIssue(
    input.context,
    "context",
    "A current authoring-context artifact",
    "Load or create the authoring context.",
  );
  if (contextIssue) issues.push(contextIssue);

  const expectedKind = input.phase === "queue"
    ? "queue-vector"
    : input.phase === "pickup"
      ? "pickup-vector"
      : "customer-vector";
  issues.push(...vectorIssues(input.vector, expectedKind, input.context));

  if (input.phase === "pickup" || input.phase === "customers") {
    const queueIssue = artifactIssue(
      input.queue,
      "queue",
      "A current queue artifact",
      "Generate or import and validate a queue artifact.",
    );
    if (queueIssue) issues.push(queueIssue);
    if (input.queue && input.context && input.queue.contextHash !== input.context.contentHash) {
      issues.push({
        code: "hash-mismatch",
        input: "queue",
        message: "The queue was generated from a different authoring context.",
        action: "Regenerate the queue from the current context.",
      });
    }
  }

  if (input.phase === "customers") {
    const pickupIssue = artifactIssue(
      input.pickupPlan,
      "pickup-plan",
      "A current pickup-plan artifact",
      "Create and validate a complete pickup plan.",
    );
    if (pickupIssue) issues.push(pickupIssue);
    if (input.pickupPlan && input.pickupPlan.completion !== "complete") {
      issues.push({
        code: "incomplete-artifact",
        input: "pickup-plan",
        message: "The pickup plan is partial.",
        action: "Finish the manual path or auto-complete its suffix.",
      });
    }
    if (input.pickupPlan && input.queue && input.pickupPlan.queueHash !== input.queue.contentHash) {
      issues.push({
        code: "hash-mismatch",
        input: "pickup-plan",
        message: "The pickup plan does not belong to the current queue.",
        action: "Create a pickup-plan revision from the current queue.",
      });
    }
  }

  return { phase: input.phase, ready: issues.length === 0, issues };
}
