import { describe, expect, it } from "vitest";

import type {
  PickupPlanningVector,
  QueueArtifact,
} from "./contracts.ts";
import { appendManualPickupStep, createPickupPlan, validatePickupPlan } from "./phase2PickupPlan.ts";
import { replayPickupSteps } from "./pickupState.ts";
import { confirmVector, createAuthoringContext, createVectorDraft } from "./vectorArtifacts.ts";

const createdAt = "2026-01-01T00:00:00.000Z";

function queue(contextHash: string): QueueArtifact {
  return {
    schemaVersion: 1,
    kind: "queue",
    id: "queue-test",
    createdAt,
    seed: 1,
    graphHash: "graph-1",
    upstreamHashes: [contextHash, "queue-vector-hash"],
    contentHash: "queue-content-hash",
    status: "valid",
    warnings: [],
    contextHash,
    vectorHash: "queue-vector-hash",
    lanes: [
      { id: "lane-0", slots: [
        { id: "a", ingredient: 0, amount: 1, effects: [], provenance: "generated" },
        { id: "b", ingredient: 1, amount: 2, effects: [], provenance: "generated" },
      ] },
      { id: "lane-1", slots: [
        { id: "c", ingredient: 2, amount: 1, effects: [], provenance: "generated" },
      ] },
    ],
    groups: [{ id: "combined-1", kind: "combined", slotIds: ["a", "c"] }],
    diagnostics: {
      pickupUnits: 4,
      queueSlots: 3,
      laneDepths: [2, 1],
      ingredientUnits: { 0: 1, 1: 2, 2: 1 },
      amountHistogram: { 1: 2, 2: 1 },
      texture: { maximumIdenticalRun: 1, crossLaneMirroring: 0, transitionEntropy: 0, laneImbalance: 2 / 3 },
      textureMisses: [],
      combinedCoverage: [],
      linkedCoverage: [],
      effectTargets: { freeze: 0, hidden: 0, holdingKey: 0 },
      effectPlacements: { freeze: 0, hidden: 0, holdingKey: 0 },
      structuralVerdict: "safe",
      structuralMessage: "safe",
    },
  };
}

describe("manual pickup planning", () => {
  it("creates a draft, records grouped actions atomically, and validates a complete replay", () => {
    const context = createAuthoringContext({
      mapId: "map-1",
      graphHash: "graph-1",
      referenceProfileId: "reference-1",
      createdAt,
    });
    const values: PickupPlanningVector = {
      seed: 5,
      mode: "manual",
      completionPolicy: "require-manual-complete",
      preferLaneBalance: 1,
      preferIngredientWaveAlignment: 1,
      penalizeAmountBurst: 1,
      search: { beamWidth: 10, maximumExpandedStates: 100, wallTimeMs: 100 },
    };
    const vector = confirmVector(
      createVectorDraft({ kind: "pickup-vector" as const, values, context, createdAt }),
      "designer",
      createdAt,
    );
    const sourceQueue = queue(context.contentHash);
    const created = createPickupPlan(context, vector, sourceQueue, createdAt);
    expect(created.started).toBe(true);
    if (!created.started) return;
    const initial = replayPickupSteps(sourceQueue, created.artifact.steps);
    expect(initial.snapshot.remaining).toBe(3);
    expect(initial.snapshot.cells[0][0]).toMatchObject({ sourceX: 0, sourceY: 0 });
    expect(initial.legalActions).toEqual([
      expect.objectContaining({ slotIds: ["a", "c"], grouped: true }),
    ]);

    const first = appendManualPickupStep(
      created.artifact,
      sourceQueue,
      created.artifact.contentHash,
      initial.legalActions[0].id,
    );
    expect(first.error).toBeUndefined();
    expect(first.artifact.steps[0]).toMatchObject({ slotIds: ["a", "c"], releasedUnits: { 0: 1, 2: 1 } });
    expect(first.artifact.completion).toBe("partial");

    const remaining = replayPickupSteps(sourceQueue, first.artifact.steps);
    expect(remaining.snapshot.remaining).toBe(1);
    expect(remaining.snapshot.cells[0][0]).toMatchObject({ sourceX: 0, sourceY: 1 });
    const second = appendManualPickupStep(
      first.artifact,
      sourceQueue,
      first.artifact.contentHash,
      remaining.legalActions[0].id,
    );
    expect(second.error).toBeUndefined();
    expect(second.artifact.completion).toBe("complete");
    expect(second.artifact.status).toBe("valid");
    expect(second.artifact.diagnostics.amountBurstHistogram).toEqual({ 2: 2 });
    expect(validatePickupPlan(second.artifact, sourceQueue)).toEqual({ valid: true, errors: [] });
  });

  it("rejects stale revision writes", () => {
    const context = createAuthoringContext({
      mapId: "map-1",
      graphHash: "graph-1",
      referenceProfileId: "reference-1",
    });
    const values: PickupPlanningVector = {
      seed: 5,
      mode: "manual",
      completionPolicy: "require-manual-complete",
      preferLaneBalance: 1,
      preferIngredientWaveAlignment: 1,
      penalizeAmountBurst: 1,
      search: { beamWidth: 10, maximumExpandedStates: 100, wallTimeMs: 100 },
    };
    const vector = confirmVector(
      createVectorDraft({ kind: "pickup-vector" as const, values, context }),
      "designer",
    );
    const sourceQueue = queue(context.contentHash);
    const created = createPickupPlan(context, vector, sourceQueue);
    if (!created.started) throw new Error("test setup failed");
    const action = replayPickupSteps(sourceQueue, []).legalActions[0];
    const result = appendManualPickupStep(created.artifact, sourceQueue, "older-revision", action.id);
    expect(result.error).toContain("revision conflict");
  });
});
