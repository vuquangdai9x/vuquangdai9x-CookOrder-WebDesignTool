// Worker host for Design mode's two CPU-heavy analyses. Keeping the exact
// graph-native implementation here lets the editor remain interactive without
// changing estimate/solvability semantics or replay output.

import { buildIndex } from "../../core/nodeIndex.ts";
import type { NodeLevelConfig } from "../../core/nodeSim.ts";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import { checkNodeSolvable } from "./checkSolvable.ts";
import type { EstimateOptions, EstimateProgress, EstimateResult } from "./estimateDifficulty.ts";
import { estimateNodeDifficulty } from "./nodeEstimateDifficulty.ts";

export type AnalysisWorkerKind = "estimate" | "solvability";

export type AnalysisWorkerOptions = Pick<
  EstimateOptions,
  | "maxIterations"
  | "searchStatesPerDepth"
  | "maxRetries"
  | "scenario"
  | "packingMode"
  | "toolProcessBehavior"
>;

export interface AnalysisWorkerRequest {
  kind: AnalysisWorkerKind;
  graph: NodeGraphMap;
  level: NodeLevelConfig;
  opts: AnalysisWorkerOptions;
}

export type AnalysisWorkerResponse =
  | { type: "progress"; progress: EstimateProgress }
  | { type: "result"; result: EstimateResult }
  | { type: "error"; error: string };

self.onmessage = (event: MessageEvent<AnalysisWorkerRequest>) => {
  const { kind, graph, level, opts } = event.data;
  try {
    const ix = buildIndex(graph);
    const onProgress = (progress: EstimateProgress): void => {
      self.postMessage({ type: "progress", progress } satisfies AnalysisWorkerResponse);
    };
    const result = kind === "solvability"
      ? checkNodeSolvable(ix, level, { ...opts, onProgress })
      : estimateNodeDifficulty(ix, level, { ...opts, onProgress });
    self.postMessage({ type: "result", result } satisfies AnalysisWorkerResponse);
  } catch (err) {
    self.postMessage({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    } satisfies AnalysisWorkerResponse);
  }
};
