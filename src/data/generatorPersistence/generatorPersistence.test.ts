import { describe, expect, it } from "vitest";
import type { LevelData } from "../mapLoader.ts";
import { createAuthoringContext, createVectorDraft, confirmVector } from "../../generation/queue-first/index.ts";
import type { QueueGenerationVector } from "../../generation/queue-first/index.ts";
import {
  applyCustomerGeneratorData,
  createQueuePhaseData,
  decodeCustomerGeneratorData,
  decodeQueuePhaseData,
  decodeGeneratorWorkspaceData,
  encodeGeneratorWorkspaceData,
  encodeCustomerGeneratorData,
  encodeQueuePhaseData,
  levelProjectionHashes,
  recoverGeneratorSheetValues,
  stalePhaseForLevel,
} from "./index.ts";
import { defaultSharedGenerationProfile } from "../../generation/sharedGenerationProfile.ts";

const level = (overrides: Partial<LevelData> = {}): LevelData => ({
  id: 1,
  name: "Level 1",
  weather: "Normal",
  levelTag: "",
  featureUnlock: "",
  serveableSlots: 1,
  shuffleDistance: 0,
  queueString: "0%1",
  gridString: ",,,",
  customerString: "",
  ...overrides,
});

const queueVector = (): QueueGenerationVector => ({
  seed: 7,
  laneCount: 2,
  targetPickupUnits: 2,
  ingredientWeights: { 0: 1, 1: 1 },
  amountMode: "balanced",
  texture: {},
  obstacleCoverage: { freeze: 0, hidden: 0, holdingKey: 0 },
  combinedCoverageBySize: { 2: 0, 3: 0, 4: 0, 5: 0 },
  linkedCoverageBySize: { 2: 0, 3: 0, 4: 0, 5: 0 },
  feasibilityMode: "free",
});

describe("generator persistence", () => {
  it("round-trips customer-first settings while weights and seed stay separate", () => {
    const source = level({
      ingredientWeights: "0:75;1:25",
      customerDishesSequence: "1;2;1",
      complexityCurve: "{\"points\":[]}",
      shuffleCurve: "{\"points\":[1]}",
      obstacleData: "frozen=2",
      bagFill: "max",
      randomSeed: 0,
    });
    const encoded = encodeCustomerGeneratorData(source);
    expect(encoded.startsWith("cg1_")).toBe(true);
    const decoded = decodeCustomerGeneratorData(encoded);
    const target = level({ ingredientWeights: source.ingredientWeights, randomSeed: source.randomSeed });
    applyCustomerGeneratorData(target, decoded);
    expect(target).toMatchObject({
      ingredientWeights: "0:75;1:25",
      randomSeed: 0,
      customerDishesSequence: "1;2;1",
      obstacleData: "frozen=2",
      bagFill: "max",
    });
  });

  it("round-trips a phase vector and detects a changed playable projection", () => {
    const sourceLevel = level();
    const context = createAuthoringContext({ mapId: "burger", graphHash: "graph", referenceProfileId: "ref" });
    const vector = confirmVector(createVectorDraft({ kind: "queue-vector" as const, values: queueVector(), context }), "tester");
    const phase = createQueuePhaseData({ context, vector, levelProjectionHashes: levelProjectionHashes(sourceLevel) });
    const encoded = encodeQueuePhaseData(phase);
    expect(encoded.startsWith("qfq1_")).toBe(true);
    expect(decodeQueuePhaseData(encoded)).toEqual(phase);
    const stale = stalePhaseForLevel(phase, { ...sourceLevel, queueString: "changed" });
    expect(stale.vector.status).toBe("stale");
    expect(() => encodeQueuePhaseData(stale)).not.toThrow();
  });

  it("reads legacy E/F/G/I cells without rewriting them", () => {
    const source = level();
    const recovered = recoverGeneratorSheetValues(source, {
      ingredientWeights: "0:100",
      customerGeneratorData: "1;2",
      queuePhaseData: "complexity-json",
      pickupPhaseData: "shuffle-json",
      randomSeed: "0",
      customerPhaseData: "frozen=1",
      author: "designer",
    });
    expect(recovered.customer).toMatchObject({
      customerDishesSequence: "1;2",
      complexityCurve: "complexity-json",
      shuffleCurve: "shuffle-json",
      obstacleData: "frozen=1",
    });
    expect(recovered.warnings[0]).toContain("legacy");
    expect(source.customerGeneratorData).toBeUndefined();
  });

  it("rejects corrupted payloads without producing partial data", () => {
    expect(() => decodeCustomerGeneratorData("cg1_not-valid-deflate")).toThrow(/Invalid/);
    expect(() => decodeCustomerGeneratorData("cg2_future")).toThrow(/Unsupported/);
  });

  it("round-trips the v2 unified workspace in the existing customer-generator cell", () => {
    const source = {
      schemaVersion: 2 as const,
      kind: "generator-workspace" as const,
      activeStrategy: "queue-first" as const,
      shared: { ...defaultSharedGenerationProfile(["tomato"]), seed: 17 },
      customerFirst: { dishTypeWeightsByName: { burger: 80 }, bagFill: "random" as const },
      queueFirst: { queuePhaseHash: "phase" },
      migrationWarnings: [],
      contentHash: "",
    };
    const encoded = encodeGeneratorWorkspaceData(source);
    expect(encoded.startsWith("gw2_")).toBe(true);
    const decoded = decodeGeneratorWorkspaceData(encoded);
    expect(decoded.shared.seed).toBe(17);
    expect(decoded.shared.ingredientWeightsByName.tomato).toBe(100);
    expect(decoded.shared.dishTypeWeightsByName.burger).toBe(80);
    expect(decoded.customerFirst.dishTypeWeightsByName).toBeUndefined();
    expect(decoded.activeStrategy).toBe("queue-first");
  });
});
