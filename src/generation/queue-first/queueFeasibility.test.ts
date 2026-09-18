import { describe, expect, it } from "vitest";
import type { QueueArtifact } from "./contracts.ts";
import { analyzeQueueFeasibility } from "./queueFeasibility.ts";
import { replayPickupSteps } from "./pickupState.ts";

function queue(amounts: number[][], groups: QueueArtifact["groups"] = []): QueueArtifact {
  const lanes = amounts.map((lane, x) => ({
    id: `lane-${x}`,
    slots: lane.map((amount, y) => ({
      id: `slot-${x}-${y}`,
      ingredient: x + 1,
      amount,
      effects: [],
      provenance: "generated" as const,
    })),
  }));
  return {
    schemaVersion: 1,
    kind: "queue",
    id: "queue-test",
    createdAt: "2026-01-01T00:00:00.000Z",
    seed: 1,
    graphHash: "graph",
    upstreamHashes: [],
    contentHash: "queue-test-hash",
    status: "valid",
    warnings: [],
    contextHash: "context",
    vectorHash: "vector",
    lanes,
    groups,
    diagnostics: {
      pickupUnits: amounts.flat().reduce((sum, amount) => sum + amount, 0),
      queueSlots: amounts.flat().length,
      laneDepths: amounts.map((lane) => lane.length),
      ingredientUnits: {},
      amountHistogram: {},
      texture: { maximumIdenticalRun: 1, crossLaneMirroring: 0, transitionEntropy: 0, laneImbalance: 0 },
      textureMisses: [],
      combinedCoverage: [],
      linkedCoverage: [],
      effectTargets: { freeze: 0, hidden: 0, holdingKey: 0 },
      effectPlacements: { freeze: 0, hidden: 0, holdingKey: 0 },
      structuralVerdict: "safe",
      structuralMessage: "test",
    },
  };
}

describe("queue runtime feasibility", () => {
  it("hard-rejects a pickup burst larger than the playable grid", () => {
    const result = analyzeQueueFeasibility(queue([[12]]), 10, 1);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("releases 12 items");
    expect(result.reason).toContain("capacity of 10");
  });

  it("counts an entire combined pickup against grid capacity", () => {
    const artifact = queue([[6], [6]], [{ id: "g", kind: "combined", slotIds: ["slot-0-0", "slot-1-0"] }]);
    expect(analyzeQueueFeasibility(artifact, 10, 1).reason).toContain("releases 12 items");
  });

  it("returns a complete replayable witness and supports the free-choice endpoint", () => {
    const artifact = queue([[1], [1]]);
    const result = analyzeQueueFeasibility(artifact, 10, 0);
    expect(result.ok).toBe(true);
    expect(result.witness?.forceMove).toBe(0);
    const replay = replayPickupSteps(artifact, result.witness?.witnessSteps ?? []);
    expect(replay.valid).toBe(true);
    expect(replay.remaining).toBe(0);
  });
});
