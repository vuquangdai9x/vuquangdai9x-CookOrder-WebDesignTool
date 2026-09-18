import type { GraphIndex } from "../../core/nodeIndex.ts";
import { artifactHash, deriveSeed, seededRandom } from "./artifactHash.ts";
import { partitionAmounts } from "./amountPartitioner.ts";
import type {
  AuthoringContextArtifact,
  GroupSizeCoverage,
  OrderabilityAdapter,
  PhaseReadinessIssue,
  QueueArtifact,
  QueueGenerationVector,
  QueueGenerationVectorArtifact,
} from "./contracts.ts";
import { placeQueueEffects } from "./effectPlacement.ts";
import { placeQueueGroups } from "./groupPlacement.ts";
import { getPhaseReadiness } from "./phaseReadiness.ts";
import { allocateLargestRemainder } from "./quotaAllocator.ts";
import { layoutQueue, measureQueueTexture } from "./queueLayout.ts";
import { analyzeQueueFeasibility } from "./queueFeasibility.ts";
import { validateQueueArtifact } from "./validation.ts";

export interface GenerateQueuePhaseInput {
  context: AuthoringContextArtifact;
  vector: QueueGenerationVectorArtifact;
  index: GraphIndex;
  orderability?: OrderabilityAdapter;
  createdAt?: string;
  /** Internal deterministic candidate index used by runtime-feasibility optimization. */
  attempt?: number;
}

export type GenerateQueuePhaseResult =
  | { started: false; readinessIssues: PhaseReadinessIssue[]; errors: string[] }
  | { started: true; artifact: QueueArtifact; errors: string[] };

const sizes = [2, 3, 4, 5] as const;

function validateCoverage(label: string, coverage: GroupSizeCoverage, errors: string[]): number {
  let total = 0;
  for (const size of sizes) {
    const value = coverage[size];
    if (!Number.isFinite(value) || value < 0 || value > 1) errors.push(`${label}[${size}] must be between 0 and 1.`);
    else total += value;
  }
  return total;
}

export function validateQueueGenerationVector(
  vector: QueueGenerationVector,
  context: AuthoringContextArtifact,
  index: GraphIndex,
  hasOrderabilityAdapter: boolean,
): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(vector.seed)) errors.push("seed must be an integer.");
  if (!Number.isInteger(vector.laneCount) || vector.laneCount < 1 || vector.laneCount > 5) {
    errors.push("laneCount must be an integer between 1 and 5.");
  }
  if (!Number.isInteger(vector.targetPickupUnits) || vector.targetPickupUnits < 1) {
    errors.push("targetPickupUnits must be a positive integer.");
  }
  if (vector.targetQueueSlots !== undefined && (!Number.isInteger(vector.targetQueueSlots) || vector.targetQueueSlots < 1)) {
    errors.push("targetQueueSlots must be a positive integer when provided.");
  }
  if (vector.targetLaneDepth !== undefined && (!Number.isInteger(vector.targetLaneDepth) || vector.targetLaneDepth < 1)) {
    errors.push("targetLaneDepth must be a positive integer when provided.");
  }
  const positiveWeights = Object.entries(vector.ingredientWeights).filter(([, weight]) => weight > 0);
  if (positiveWeights.length === 0) errors.push("At least one positive ingredient weight is required.");
  for (const [id, weight] of Object.entries(vector.ingredientWeights)) {
    const ingredient = Number(id);
    if (!Number.isInteger(ingredient) || index.pickupable[ingredient] !== 1) {
      errors.push(`Ingredient weight ${id} does not identify a pickupable graph ingredient.`);
    }
    if (!Number.isFinite(weight) || weight < 0) errors.push(`Ingredient weight ${id} must be a finite non-negative number.`);
  }
  for (const [id, range] of Object.entries(vector.amountRanges ?? {})) {
    const ingredient = Number(id);
    if (!Number.isInteger(ingredient) || index.pickupable[ingredient] !== 1) {
      errors.push(`Amount range ${id} does not identify a pickupable graph ingredient.`);
    }
    if (!Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min < 1 || range.max < range.min) {
      errors.push(`Amount range ${id} must use positive integer bounds with max >= min.`);
    }
  }
  const texture = vector.texture;
  if (texture.maximumIdenticalRun !== undefined
    && (!Number.isInteger(texture.maximumIdenticalRun) || texture.maximumIdenticalRun < 1)) {
    errors.push("texture.maximumIdenticalRun must be a positive integer.");
  }
  for (const [name, value] of [
    ["maximumCrossLaneMirroring", texture.maximumCrossLaneMirroring],
    ["targetTransitionEntropy", texture.targetTransitionEntropy],
    ["targetLaneImbalance", texture.targetLaneImbalance],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      errors.push(`texture.${name} must be between 0 and 1.`);
    }
  }
  const groupCoverage = validateCoverage("combinedCoverageBySize", vector.combinedCoverageBySize, errors)
    + validateCoverage("linkedCoverageBySize", vector.linkedCoverageBySize, errors);
  if (groupCoverage > 1 + Number.EPSILON) errors.push("Combined and linked group coverage must sum to at most 1.");
  let obstacleTotal = 0;
  for (const mechanic of ["freeze", "hidden", "holdingKey"] as const) {
    const value = vector.obstacleCoverage[mechanic];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(`obstacleCoverage.${mechanic} must be between 0 and 1.`);
    } else {
      obstacleTotal += value;
    }
    if (value > 0 && !context.authorizedMechanics.includes(mechanic)) {
      errors.push(`Mechanic ${mechanic} is not authorized by the authoring context.`);
    }
  }
  if (obstacleTotal > 1 + Number.EPSILON) errors.push("Queue effect coverage must sum to at most 1.");
  if (vector.obstacleCoverage.holdingKey > 0 && (vector.holdingKeyColors?.length ?? 0) === 0) {
    errors.push("holdingKeyColors is required when holdingKey coverage is non-zero.");
  }
  if (vector.holdingKeyColors?.some((color) => !Number.isInteger(color) || color < 0)) {
    errors.push("holdingKeyColors must contain non-negative integer color ids.");
  }
  if (vector.freezeStrength) {
    const { minAdjacentPicks: min, maxAdjacentPicks: max } = vector.freezeStrength;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) {
      errors.push("freezeStrength must contain positive integer bounds with max >= min.");
    }
  }
  if (vector.forceMove !== undefined && (!Number.isFinite(vector.forceMove) || vector.forceMove < 0 || vector.forceMove > 1)) {
    errors.push("forceMove must be between 0 and 1.");
  }
  if ((vector.feasibilityMode === "project-to-orderable" || vector.feasibilityMode === "strict-orderable") && !hasOrderabilityAdapter) {
    errors.push(`${vector.feasibilityMode} requires an orderability adapter.`);
  }
  return errors;
}

function textureMisses(vector: QueueGenerationVector, metrics: ReturnType<typeof measureQueueTexture>): string[] {
  const misses: string[] = [];
  const target = vector.texture;
  if (target.maximumIdenticalRun !== undefined && metrics.maximumIdenticalRun > target.maximumIdenticalRun) {
    misses.push(`maximum identical run ${metrics.maximumIdenticalRun} exceeds ${target.maximumIdenticalRun}`);
  }
  if (target.maximumCrossLaneMirroring !== undefined && metrics.crossLaneMirroring > target.maximumCrossLaneMirroring) {
    misses.push(`cross-lane mirroring ${metrics.crossLaneMirroring.toFixed(3)} exceeds ${target.maximumCrossLaneMirroring}`);
  }
  if (target.targetTransitionEntropy !== undefined && metrics.transitionEntropy < target.targetTransitionEntropy) {
    misses.push(`transition entropy ${metrics.transitionEntropy.toFixed(3)} is below ${target.targetTransitionEntropy}`);
  }
  if (target.targetLaneImbalance !== undefined && metrics.laneImbalance > target.targetLaneImbalance) {
    misses.push(`lane imbalance ${metrics.laneImbalance.toFixed(3)} exceeds ${target.targetLaneImbalance}`);
  }
  return misses;
}

export function generateQueuePhase(input: GenerateQueuePhaseInput): GenerateQueuePhaseResult {
  const readiness = getPhaseReadiness({ phase: "queue", context: input.context, vector: input.vector });
  if (!readiness.ready) return { started: false, readinessIssues: readiness.issues, errors: [] };
  const vector = input.vector.values;
  const vectorErrors = validateQueueGenerationVector(vector, input.context, input.index, !!input.orderability);
  if (vectorErrors.length > 0) return { started: false, readinessIssues: [], errors: vectorErrors };

  if (vector.feasibilityMode === "runtime-feasible" && input.attempt === undefined) {
    const candidates = Array.from({ length: 4 }, (_, attempt) => generateQueuePhase({ ...input, attempt }));
    const valid = candidates.filter((candidate): candidate is Extract<GenerateQueuePhaseResult, { started: true }> =>
      candidate.started && candidate.errors.length === 0 && candidate.artifact.status === "valid"
        && candidate.artifact.diagnostics.feasibility !== undefined);
    if (valid.length > 0) {
      const force = vector.forceMove ?? 0.5;
      valid.sort((a, b) => {
        const aBranching = a.artifact.diagnostics.feasibility!.averageBranching;
        const bBranching = b.artifact.diagnostics.feasibility!.averageBranching;
        const direction = 2 * force - 1;
        return direction * (aBranching - bBranching)
          || a.artifact.diagnostics.feasibility!.exploredStates - b.artifact.diagnostics.feasibility!.exploredStates
          || a.artifact.contentHash.localeCompare(b.artifact.contentHash);
      });
      return valid[0];
    }
    return candidates.find((candidate): candidate is Extract<GenerateQueuePhaseResult, { started: true }> => candidate.started)
      ?? candidates[0];
  }

  let quotas = allocateLargestRemainder(vector.ingredientWeights, vector.targetPickupUnits).quotas;
  let orderability: QueueArtifact["diagnostics"]["orderability"];
  if (vector.feasibilityMode === "project-to-orderable" || vector.feasibilityMode === "strict-orderable") {
    const evaluated = input.orderability!.evaluate(quotas, vector.feasibilityMode);
    if (!evaluated.exactDecompositionExists) {
      return { started: false, readinessIssues: [], errors: [evaluated.reason ?? "No exact order decomposition exists."] };
    }
    const original = quotas;
    if (vector.feasibilityMode === "project-to-orderable" && evaluated.projectedQuotas) quotas = evaluated.projectedQuotas;
    const projectedTotal = Object.values(quotas).reduce((sum, amount) => sum + amount, 0);
    if (projectedTotal !== vector.targetPickupUnits || Object.values(quotas).some((amount) => !Number.isInteger(amount) || amount < 0)) {
      return { started: false, readinessIssues: [], errors: ["Orderability projection returned invalid pickup quotas."] };
    }
    orderability = {
      mode: vector.feasibilityMode,
      exactDecompositionExists: true,
      projectedUnitDelta: Object.fromEntries(
        [...new Set([...Object.keys(original), ...Object.keys(quotas)])]
          .sort((a, b) => Number(a) - Number(b))
          .map((id) => [id, (quotas[id] ?? 0) - (original[id] ?? 0)]),
      ),
    };
  }

  const amounts = partitionAmounts(quotas, vector, input.index);
  const attemptSalt = input.attempt ?? 0;
  const salt = (name: string): string => attemptSalt === 0 ? name : `${name}:${attemptSalt}`;
  const lanes = layoutQueue(
    amounts.slots,
    vector.laneCount,
    input.vector.contentHash,
    seededRandom(deriveSeed(vector.seed, salt("queue.layout"))),
  );
  const groupResult = placeQueueGroups(
    lanes,
    vector.combinedCoverageBySize,
    vector.linkedCoverageBySize,
    input.vector.contentHash,
    seededRandom(deriveSeed(vector.seed, salt("queue.combined-groups"))),
    seededRandom(deriveSeed(vector.seed, salt("queue.linked-groups"))),
  );
  const effects = placeQueueEffects(
    lanes,
    groupResult.groups,
    vector,
    seededRandom(deriveSeed(vector.seed, salt("queue.effects"))),
  );
  const texture = measureQueueTexture(lanes);
  const misses = textureMisses(vector, texture);
  const warnings = [...amounts.warnings, ...groupResult.warnings, ...effects.warnings, ...misses];
  if (vector.targetLaneDepth !== undefined) {
    const actual = Math.max(...lanes.map((lane) => lane.length));
    if (actual !== vector.targetLaneDepth) warnings.push(`Maximum lane depth is ${actual}; targetLaneDepth=${vector.targetLaneDepth}.`);
  }
  const artifactLanes = lanes.map((lane, x) => ({
    id: `lane-${input.vector.contentHash.slice(0, 8)}-${x}`,
    slots: lane.map((slot) => ({
      id: slot.id,
      ingredient: slot.ingredient,
      amount: slot.amount,
      effects: slot.effects.map((effect) => ({ ...effect, params: [...effect.params] })),
      provenance: "generated" as const,
    })),
  }));
  const ingredientUnits = Object.fromEntries(
    Object.keys(quotas).sort((a, b) => Number(a) - Number(b)).map((id) => [id, quotas[id]]),
  );
  const content = {
    contextHash: input.context.contentHash,
    vectorHash: input.vector.contentHash,
    lanes: artifactLanes,
    groups: groupResult.groups,
  };
  const contentHash = artifactHash(content);
  const artifact: QueueArtifact = {
    schemaVersion: 1,
    kind: "queue",
    id: `queue-${contentHash.slice(0, 12)}`,
    createdAt: input.createdAt ?? input.vector.confirmedAt ?? input.vector.createdAt,
    seed: vector.seed,
    graphHash: input.context.graphHash,
    upstreamHashes: [input.context.contentHash, input.vector.contentHash],
    contentHash,
    status: "draft",
    warnings,
    ...content,
    diagnostics: {
      pickupUnits: Object.values(quotas).reduce((sum, amount) => sum + amount, 0),
      queueSlots: artifactLanes.reduce((sum, lane) => sum + lane.slots.length, 0),
      laneDepths: artifactLanes.map((lane) => lane.slots.length),
      ingredientUnits,
      amountHistogram: amounts.histogram,
      texture,
      textureMisses: misses,
      combinedCoverage: groupResult.combinedCoverage,
      linkedCoverage: groupResult.linkedCoverage,
      effectTargets: effects.targets,
      effectPlacements: effects.placements,
      structuralVerdict: "unknown",
      structuralMessage: "Structural validation has not run.",
      orderability,
    },
  };
  const validation = validateQueueArtifact(artifact, input.vector, input.context, input.index);
  artifact.status = validation.valid ? "valid" : "invalid";
  artifact.warnings = [...artifact.warnings, ...validation.warnings];
  artifact.diagnostics.structuralVerdict = validation.structuralVerdict;
  artifact.diagnostics.structuralMessage = validation.structuralMessage;
  const errors = [...validation.errors];
  if (validation.valid && vector.feasibilityMode === "runtime-feasible") {
    const gridCapacity = input.context.constraints.gridCapacity;
    if (!Number.isInteger(gridCapacity) || (gridCapacity as number) < 0) {
      errors.push("Runtime feasibility requires a non-negative integer constraints.gridCapacity in the authoring context.");
    } else {
      const feasibility = analyzeQueueFeasibility(artifact, gridCapacity as number, vector.forceMove ?? 0.5, {
        maximumExpandedStates: 50_000,
        wallTimeMs: 2_500,
      });
      if (feasibility.ok && feasibility.witness) {
        artifact.diagnostics.feasibility = feasibility.witness;
      } else {
        errors.push(feasibility.reason ?? "Queue runtime feasibility could not be proven.");
      }
    }
  }
  artifact.status = errors.length === 0 ? "valid" : "invalid";
  return { started: true, artifact, errors };
}
