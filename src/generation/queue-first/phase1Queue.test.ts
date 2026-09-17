import { describe, expect, it } from "vitest";

import burgerJson from "../../data/config/nodegraph/maps/Graph-1-Burger.json";
import { buildIndex } from "../../core/nodeIndex.ts";
import type { GraphIndex } from "../../core/nodeIndex.ts";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import type { QueueGenerationVector } from "./contracts.ts";
import { generateQueuePhase } from "./phase1Queue.ts";
import { confirmVector, createAuthoringContext, createVectorDraft } from "./vectorArtifacts.ts";

function graphIndex(): GraphIndex {
  return {
    pickupable: Uint8Array.from([1, 1, 1, 0]),
    stackRange: [
      { min: 2, max: 3 },
      { min: 1, max: 2 },
      { min: 2, max: 4 },
      { min: 1, max: 1 },
    ],
  } as GraphIndex;
}

function vector(overrides: Partial<QueueGenerationVector> = {}): QueueGenerationVector {
  return {
    seed: 42,
    laneCount: 4,
    targetPickupUnits: 36,
    targetQueueSlots: 18,
    ingredientWeights: { 0: 3, 1: 2, 2: 1 },
    amountMode: "balanced",
    texture: {
      maximumIdenticalRun: 3,
      maximumCrossLaneMirroring: 0.5,
      targetTransitionEntropy: 0.3,
      targetLaneImbalance: 0.3,
    },
    obstacleCoverage: { freeze: 0, hidden: 0.1, holdingKey: 0 },
    combinedCoverageBySize: { 2: 0.12, 3: 0, 4: 0, 5: 0 },
    linkedCoverageBySize: { 2: 0.12, 3: 0, 4: 0, 5: 0 },
    feasibilityMode: "free",
    ...overrides,
  };
}

function setup(values = vector()) {
  const context = createAuthoringContext({
    mapId: "map-1",
    graphHash: "graph-1",
    referenceProfileId: "reference-1",
    authorizedMechanics: ["hidden", "freeze", "holdingKey"],
    constraints: { gridCapacity: 10 },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const inputVector = confirmVector(
    createVectorDraft({
      kind: "queue-vector" as const,
      values,
      context,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    "designer",
    "2026-01-01T00:01:00.000Z",
  );
  return { context, inputVector };
}

describe("generateQueuePhase", () => {
  it("is deterministic and preserves exact physical supply", () => {
    const { context, inputVector } = setup();
    const first = generateQueuePhase({
      context,
      vector: inputVector,
      index: graphIndex(),
      createdAt: "2026-01-01T00:02:00.000Z",
    });
    const second = generateQueuePhase({
      context,
      vector: inputVector,
      index: graphIndex(),
      createdAt: "2026-01-01T00:02:00.000Z",
    });
    expect(first.started).toBe(true);
    expect(second.started).toBe(true);
    if (!first.started || !second.started) return;
    expect(first.errors).toEqual([]);
    expect(first.artifact).toEqual(second.artifact);
    expect(first.artifact.status).toBe("valid");
    expect(first.artifact.diagnostics.pickupUnits).toBe(36);
    expect(first.artifact.lanes.flatMap((lane) => lane.slots)
      .reduce((sum, slot) => sum + slot.amount, 0)).toBe(36);
    expect(first.artifact.diagnostics.queueSlots).toBe(18);
    expect(first.artifact.diagnostics.structuralVerdict).not.toBe("deadlock");
  });

  it("measures separate combined and linked size coverage", () => {
    const { context, inputVector } = setup();
    const result = generateQueuePhase({ context, vector: inputVector, index: graphIndex() });
    expect(result.started).toBe(true);
    if (!result.started) return;
    const combined = result.artifact.diagnostics.combinedCoverage.find((entry) => entry.size === 2)!;
    const linked = result.artifact.diagnostics.linkedCoverage.find((entry) => entry.size === 2)!;
    expect(combined.targetGroups).toBeGreaterThan(0);
    expect(linked.targetGroups).toBeGreaterThan(0);
    expect(combined.placedGroups).toBeGreaterThan(0);
    expect(linked.placedGroups).toBeGreaterThan(0);
    const allMembers = result.artifact.groups.flatMap((group) => group.slotIds);
    expect(new Set(allMembers).size).toBe(allMembers.length);
  });

  it("refuses projection mode when no orderability adapter is supplied", () => {
    const { context, inputVector } = setup(vector({ feasibilityMode: "project-to-orderable" }));
    const result = generateQueuePhase({ context, vector: inputVector, index: graphIndex() });
    expect(result).toMatchObject({
      started: false,
      errors: [expect.stringContaining("requires an orderability adapter")],
    });
  });

  it("generates a replayable pickup witness in runtime-feasible mode", () => {
    const { context, inputVector } = setup(vector({
      feasibilityMode: "runtime-feasible",
      forceMove: 1,
      targetPickupUnits: 12,
      targetQueueSlots: 6,
      combinedCoverageBySize: { 2: 0, 3: 0, 4: 0, 5: 0 },
      linkedCoverageBySize: { 2: 0, 3: 0, 4: 0, 5: 0 },
      obstacleCoverage: { freeze: 0, hidden: 0, holdingKey: 0 },
    }));
    const result = generateQueuePhase({ context, vector: inputVector, index: graphIndex() });
    expect(result.started).toBe(true);
    if (!result.started) return;
    expect(result.errors).toEqual([]);
    expect(result.artifact.diagnostics.feasibility?.capacitySafe).toBe(true);
    expect(result.artifact.diagnostics.feasibility?.witnessSteps.length).toBeGreaterThan(0);
  });

  it("invalidates runtime-feasible queues whose atomic pickup exceeds grid capacity", () => {
    const context = createAuthoringContext({
      mapId: "map-1",
      graphHash: "graph-1",
      referenceProfileId: "reference-1",
      authorizedMechanics: ["hidden", "freeze", "holdingKey"],
      constraints: { gridCapacity: 1 },
    });
    const values = vector({ feasibilityMode: "runtime-feasible", forceMove: 1 });
    const inputVector = confirmVector(createVectorDraft({ kind: "queue-vector" as const, values, context }), "designer");
    const result = generateQueuePhase({ context, vector: inputVector, index: graphIndex() });
    expect(result.started).toBe(true);
    if (!result.started) return;
    expect(result.artifact.status).toBe("invalid");
    expect(result.errors.join(" ")).toContain("grid capacity of 1");
  });

  it("enforces the authored one-to-five lane limit", () => {
    const { context, inputVector } = setup(vector({ laneCount: 6 }));
    const result = generateQueuePhase({ context, vector: inputVector, index: graphIndex() });
    expect(result).toMatchObject({ started: false, errors: [expect.stringContaining("between 1 and 5")] });
  });

  it("rejects mechanics that were not authorized by context", () => {
    const context = createAuthoringContext({
      mapId: "map-1",
      graphHash: "graph-1",
      referenceProfileId: "reference-1",
      authorizedMechanics: [],
    });
    const inputVector = confirmVector(
      createVectorDraft({ kind: "queue-vector" as const, values: vector(), context }),
      "designer",
    );
    const result = generateQueuePhase({ context, vector: inputVector, index: graphIndex() });
    expect(result).toMatchObject({ started: false, errors: [expect.stringContaining("hidden")] });
  });

  it("generates a structurally valid queue from the shipped Burger graph", () => {
    const index = buildIndex(burgerJson as unknown as NodeGraphMap);
    const pickupables = Array.from(index.pickupable)
      .map((flag, ingredient) => flag === 1 ? ingredient : -1)
      .filter((ingredient) => ingredient !== -1)
      .slice(0, 5);
    const values = vector({
      targetPickupUnits: 45,
      targetQueueSlots: 30,
      ingredientWeights: Object.fromEntries(pickupables.map((ingredient, at) => [ingredient, at + 1])),
      obstacleCoverage: { freeze: 0.04, hidden: 0.08, holdingKey: 0 },
    });
    const { context, inputVector } = setup(values);
    const result = generateQueuePhase({ context, vector: inputVector, index, createdAt: "2026-01-01T00:02:00.000Z" });
    expect(result.started).toBe(true);
    if (!result.started) return;
    expect(result.errors).toEqual([]);
    expect(result.artifact.status).toBe("valid");
    expect(result.artifact.diagnostics.pickupUnits).toBe(45);
    expect(result.artifact.diagnostics.structuralVerdict).not.toMatch(/deadlock|unknown/);
  });
});
