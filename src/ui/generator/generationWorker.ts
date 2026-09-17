/// <reference lib="webworker" />

import { buildIndex } from "../../core/nodeIndex.ts";
import { buildIdIndex } from "../../data/nodeIdTable.ts";
import { nodeAsMapDef } from "../../data/nodeGraphToMapDef.ts";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import type { EstimateScenario } from "../design/estimateScenario.ts";
import { generateLevel, type GenerateBounds } from "../levelpath/generateLevel.ts";
import type { SharedObstacleCoverageProfile } from "../../generation/sharedGenerationProfile.ts";
import {
  autoCompletePickupPlan,
  generateCustomersFromQueue,
  generateQueuePhase,
  type AuthoringContextArtifact,
  type CustomerGenerationVectorArtifact,
  type CustomerOrderArtifact,
  type PickupPlanArtifact,
  type PickupPlanningVectorArtifact,
  type QueueArtifact,
  type QueueGenerationVectorArtifact,
} from "../../generation/queue-first/index.ts";

export type BackgroundGenerationRequest =
  | {
      id: string;
      kind: "customer-first";
      level: LevelData;
      doc: NodeGraphMap;
      scenario?: EstimateScenario;
      bounds: GenerateBounds;
      obstacleCoverage: SharedObstacleCoverageProfile;
      preserveGridData?: boolean;
    }
  | {
      id: string;
      kind: "queue";
      context: AuthoringContextArtifact;
      vector: QueueGenerationVectorArtifact;
      doc: NodeGraphMap;
    }
  | {
      id: string;
      kind: "pickup";
      source: PickupPlanArtifact;
      queue: QueueArtifact;
      vector: PickupPlanningVectorArtifact;
    }
  | {
      id: string;
      kind: "customers";
      context: AuthoringContextArtifact;
      vector: CustomerGenerationVectorArtifact;
      queue: QueueArtifact;
      pickup: PickupPlanArtifact;
      doc: NodeGraphMap;
      existing?: CustomerOrderArtifact;
    };

export type BackgroundGenerationResponse =
  | { id: string; type: "progress"; percentage: number; description: string }
  | { id: string; type: "result"; kind: BackgroundGenerationRequest["kind"]; payload: unknown }
  | { id: string; type: "error"; message: string };

const send = (message: BackgroundGenerationResponse): void => self.postMessage(message);
const progress = (id: string, percentage: number, description: string): void =>
  send({ id, type: "progress", percentage, description });

self.onmessage = (event: MessageEvent<BackgroundGenerationRequest>) => {
  const request = event.data;
  try {
    if (request.kind === "customer-first") {
      const ix = buildIndex(request.doc);
      const ids = buildIdIndex(request.doc.idTable);
      const projected = nodeAsMapDef(request.doc, ix);
      const level = structuredClone(request.level);
      const result = generateLevel(level, {
        ix,
        ids,
        projected,
        ...(request.scenario ? { scenario: request.scenario } : {}),
      }, {
        bounds: request.bounds,
        obstacleCoverage: request.obstacleCoverage,
        ...(request.preserveGridData ? { preserveGridData: true } : {}),
        onProgress: (percentage, description) => progress(request.id, percentage, description),
      });
      send({ id: request.id, type: "result", kind: request.kind, payload: { level, result } });
      return;
    }
    if (request.kind === "queue") {
      progress(request.id, 10, "Resolving ingredient quotas…");
      const ix = buildIndex(request.doc);
      progress(request.id, 45, "Building lanes, groups, and queue effects…");
      const result = generateQueuePhase({ context: request.context, vector: request.vector, index: ix });
      progress(request.id, 100, request.vector.values.feasibilityMode === "runtime-feasible"
        ? "Queue feasibility and pickup timeline verified."
        : "Queue artifact generated.");
      send({ id: request.id, type: "result", kind: request.kind, payload: result });
      return;
    }
    if (request.kind === "pickup") {
      progress(request.id, 8, "Replaying the selected manual prefix…");
      const result = autoCompletePickupPlan(request.source, request.queue, request.vector);
      progress(request.id, 100, result.complete ? "Pickup path completed." : "Best partial pickup path returned.");
      send({ id: request.id, type: "result", kind: request.kind, payload: result });
      return;
    }
    progress(request.id, 10, "Enumerating graph-valid dishes…");
    const ix = buildIndex(request.doc);
    const ids = buildIdIndex(request.doc.idTable);
    progress(request.id, 40, "Allocating queue supply along the pickup path…");
    const result = generateCustomersFromQueue(
      request.context,
      request.vector,
      request.queue,
      request.pickup,
      { ix, ids },
      request.existing,
    );
    progress(request.id, 100, "Customer artifact generation finished.");
    send({ id: request.id, type: "result", kind: request.kind, payload: result });
  } catch (error) {
    send({ id: request.id, type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
