import { describe, expect, it } from "vitest";
import burgerJson from "../../data/config/nodegraph/maps/Graph-1-Burger.json";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import { buildIndex } from "../../core/nodeIndex.ts";
import { orderIdIndex } from "../../core/nodeOrder.ts";
import type {
  CustomerGenerationVector,
  PickupPlanArtifact,
  QueueArtifact,
} from "./contracts.ts";
import { enumerateDishTemplates } from "./dishTemplateCatalog.ts";
import { generateCustomersFromQueue, validateCustomerOrderArtifact } from "./phase3CustomerOrders.ts";
import { confirmVector, createAuthoringContext, createVectorDraft } from "./vectorArtifacts.ts";

describe("inverse customer generation", () => {
  it("builds graph-valid customers that consume a complete pickup plan exactly", () => {
    const ix = buildIndex(burgerJson as unknown as NodeGraphMap);
    const ids = orderIdIndex(ix);
    const template = enumerateDishTemplates(ix, ids, { seed: 3, maxDishSlots: 4, maximumCandidates: 30 })[0];
    expect(template).toBeDefined();
    const context = createAuthoringContext({ mapId: "burger", graphHash: "graph", referenceProfileId: "ref" });
    const queue: QueueArtifact = {
      schemaVersion: 1, kind: "queue", id: "queue", createdAt: context.createdAt, seed: 3,
      graphHash: "graph", upstreamHashes: [], contentHash: "queue-hash", status: "valid", warnings: [],
      contextHash: context.contentHash, vectorHash: "queue-vector",
      lanes: Object.entries(template.rawSignature).map(([ingredient, amount], index) => ({
        id: `lane-${index}`,
        slots: [{ id: `slot-${index}`, ingredient: Number(ingredient), amount, effects: [], provenance: "generated" as const }],
      })),
      groups: [],
      diagnostics: {
        pickupUnits: Object.values(template.rawSignature).reduce((sum, amount) => sum + amount, 0),
        queueSlots: Object.keys(template.rawSignature).length,
        laneDepths: Object.keys(template.rawSignature).map(() => 1),
        ingredientUnits: template.rawSignature,
        amountHistogram: {},
        texture: { maximumIdenticalRun: 1, crossLaneMirroring: 0, transitionEntropy: 1, laneImbalance: 0 },
        textureMisses: [], combinedCoverage: [], linkedCoverage: [],
        effectTargets: { freeze: 0, hidden: 0, holdingKey: 0 }, effectPlacements: { freeze: 0, hidden: 0, holdingKey: 0 },
        structuralVerdict: "safe", structuralMessage: "safe",
      },
    };
    const pickup: PickupPlanArtifact = {
      schemaVersion: 1, kind: "pickup-plan", id: "pickup", createdAt: context.createdAt, seed: 3,
      graphHash: "graph", upstreamHashes: [queue.contentHash], contentHash: "pickup-hash", status: "valid", warnings: [],
      queueHash: queue.contentHash, vectorHash: "pickup-vector", mode: "auto", completion: "complete",
      steps: queue.lanes.map((lane, index) => ({
        index,
        actionId: `action:${lane.slots[0].id}`,
        slotIds: [lane.slots[0].id],
        releasedUnits: { [String(lane.slots[0].ingredient)]: lane.slots[0].amount },
        legalAlternatives: [],
        stateHashAfter: `state-${index}`,
      })),
      diagnostics: { actionCount: queue.lanes.length, groupedActionCount: 0, amountBurstHistogram: {}, maximumLegalBranching: 1, expandedStates: 1, deadlockFree: true },
    };
    const values: CustomerGenerationVector = {
      seed: 3, mode: "auto", minCustomers: 1, maxCustomers: 4, minDishesPerCustomer: 1,
      maxDishesPerCustomer: 3, maxDishSlots: 4, serveableSlots: 1,
      earlyInventoryWeight: 1, pickupToDemandDistanceWeight: 1, varietyWeight: 1,
      search: { beamWidth: 16, maximumCandidates: 50, maximumExpandedStates: 10_000, wallTimeMs: 1_000 },
    };
    const vector = confirmVector(createVectorDraft({ kind: "customer-vector" as const, values, context }), "tester");
    const result = generateCustomersFromQueue(context, vector, queue, pickup, { ix, ids });
    expect(result.started).toBe(true);
    if (!result.started || !result.ok) throw new Error("generation failed");
    expect(result.artifact.status).toBe("valid");
    expect(result.artifact.diagnostics.exactSupply).toBe(true);
    expect(validateCustomerOrderArtifact(result.artifact, vector, queue, pickup, { ix, ids })).toEqual({ valid: true, errors: [] });
  });
});
