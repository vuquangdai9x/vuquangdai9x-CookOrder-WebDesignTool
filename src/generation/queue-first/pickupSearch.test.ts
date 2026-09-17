import { describe, expect, it } from "vitest";
import type { PickupPlanningVector, QueueArtifact } from "./contracts.ts";
import { autoCompletePickupPlan, validateAutomaticPickupPlan } from "./pickupSearch.ts";
import { createPickupPlan } from "./phase2PickupPlan.ts";
import { confirmVector, createAuthoringContext, createVectorDraft } from "./vectorArtifacts.ts";

describe("automatic pickup planning", () => {
  it("completes a deterministic legal route", () => {
    const context = createAuthoringContext({ mapId: "map", graphHash: "graph", referenceProfileId: "ref" });
    const values: PickupPlanningVector = {
      seed: 9,
      mode: "auto",
      completionPolicy: "allow-auto-suffix",
      preferLaneBalance: 1,
      preferIngredientWaveAlignment: 1,
      penalizeAmountBurst: 1,
      search: { beamWidth: 8, maximumExpandedStates: 100, wallTimeMs: 1_000 },
    };
    const vector = confirmVector(createVectorDraft({ kind: "pickup-vector" as const, values, context }), "tester");
    const queue: QueueArtifact = {
      schemaVersion: 1, kind: "queue", id: "q", createdAt: context.createdAt, seed: 1,
      graphHash: "graph", upstreamHashes: [], contentHash: "queue-hash", status: "valid", warnings: [],
      contextHash: context.contentHash, vectorHash: "queue-vector",
      lanes: [
        { id: "l0", slots: [{ id: "a", ingredient: 0, amount: 1, effects: [], provenance: "generated" }] },
        { id: "l1", slots: [{ id: "b", ingredient: 1, amount: 1, effects: [], provenance: "generated" }] },
      ],
      groups: [],
      diagnostics: {
        pickupUnits: 2, queueSlots: 2, laneDepths: [1, 1], ingredientUnits: { 0: 1, 1: 1 },
        amountHistogram: { 1: 2 }, texture: { maximumIdenticalRun: 1, crossLaneMirroring: 0, transitionEntropy: 1, laneImbalance: 0 },
        textureMisses: [], combinedCoverage: [], linkedCoverage: [],
        effectTargets: { freeze: 0, hidden: 0, holdingKey: 0 }, effectPlacements: { freeze: 0, hidden: 0, holdingKey: 0 },
        structuralVerdict: "safe", structuralMessage: "safe",
      },
    };
    const created = createPickupPlan(context, vector, queue);
    if (!created.started) throw new Error("setup failed");
    const result = autoCompletePickupPlan(created.artifact, queue, vector);
    expect(result.complete).toBe(true);
    expect(result.artifact.steps).toHaveLength(2);
    expect(validateAutomaticPickupPlan(result.artifact, queue, vector)).toEqual({ valid: true, errors: [] });
  });
});
