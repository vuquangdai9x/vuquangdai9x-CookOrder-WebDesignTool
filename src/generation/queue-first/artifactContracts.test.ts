import { describe, expect, it } from "vitest";

import { artifactHash, deriveSeed } from "./artifactHash.ts";
import type { PickupPlanningVector, QueueGenerationVector } from "./contracts.ts";
import { getPhaseReadiness } from "./phaseReadiness.ts";
import {
  confirmVector,
  createAuthoringContext,
  createVectorDraft,
  reviseVectorDraft,
} from "./vectorArtifacts.ts";

const emptyCoverage = { 2: 0, 3: 0, 4: 0, 5: 0 } as const;

const queueVector = (seed = 4): QueueGenerationVector => ({
  seed,
  laneCount: 3,
  targetPickupUnits: 12,
  ingredientWeights: { 0: 1 },
  amountMode: "balanced",
  texture: {},
  obstacleCoverage: { freeze: 0, hidden: 0, holdingKey: 0 },
  combinedCoverageBySize: emptyCoverage,
  linkedCoverageBySize: emptyCoverage,
  feasibilityMode: "free",
});

describe("queue-first artifact contracts", () => {
  it("hashes object keys canonically and derives isolated named streams", () => {
    expect(artifactHash({ b: 2, a: 1 })).toBe(artifactHash({ a: 1, b: 2 }));
    expect(deriveSeed(7, "queue.layout")).toBe(deriveSeed(7, "queue.layout"));
    expect(deriveSeed(7, "queue.layout")).not.toBe(deriveSeed(7, "queue.effects"));
  });

  it("requires explicit vector confirmation before Phase 1 is ready", () => {
    const context = createAuthoringContext({
      mapId: "map-1",
      graphHash: "graph-a",
      referenceProfileId: "reference-a",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const draft = createVectorDraft({
      kind: "queue-vector" as const,
      values: queueVector(),
      context,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(getPhaseReadiness({ phase: "queue", context, vector: draft })).toMatchObject({
      ready: false,
      issues: [expect.objectContaining({ code: "unconfirmed-vector" })],
    });
    const confirmed = confirmVector(draft, "designer", "2026-01-01T00:01:00.000Z");
    expect(getPhaseReadiness({ phase: "queue", context, vector: confirmed })).toEqual({
      phase: "queue",
      ready: true,
      issues: [],
    });
  });

  it("turns edits to a confirmed vector back into an unconfirmed draft", () => {
    const context = createAuthoringContext({
      mapId: "map-1",
      graphHash: "graph-a",
      referenceProfileId: "reference-a",
    });
    const confirmed = confirmVector(
      createVectorDraft({ kind: "queue-vector" as const, values: queueVector(), context }),
      "designer",
    );
    const revised = reviseVectorDraft(confirmed, queueVector(9));
    expect(revised.status).toBe("draft");
    expect(revised.confirmedAt).toBeUndefined();
    expect(revised.contentHash).not.toBe(confirmed.contentHash);
  });

  it("blocks pickup planning when the queue artifact is absent", () => {
    const context = createAuthoringContext({
      mapId: "map-1",
      graphHash: "graph-a",
      referenceProfileId: "reference-a",
    });
    const values: PickupPlanningVector = {
      seed: 1,
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
    const readiness = getPhaseReadiness({ phase: "pickup", context, vector });
    expect(readiness.ready).toBe(false);
    expect(readiness.issues).toContainEqual(expect.objectContaining({ input: "queue", code: "missing-artifact" }));
  });
});

