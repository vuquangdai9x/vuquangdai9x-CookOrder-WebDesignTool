// Omniscient level validation. This intentionally shares the estimator's
// scoring, logging, and replay format while changing what the solver knows:
// every customer order and every queue row (including Hidden) is available at
// every decision. Customer patience is reported but does not affect whether
// the authored level has a winning route.

import type { GraphIndex } from "../../core/nodeIndex.ts";
import type { NodeLevelConfig } from "../../core/nodeSim.ts";
import type { EstimateOptions, EstimateResult } from "./estimateDifficulty.ts";
import { estimateNodeDifficulty } from "./nodeEstimateDifficulty.ts";

export function checkNodeSolvable(
  ix: GraphIndex,
  level: NodeLevelConfig,
  opts: EstimateOptions = {},
): EstimateResult {
  return estimateNodeDifficulty(ix, level, {
    ...opts,
    informationMode: "omniscient",
  });
}

/** Cache namespace: a player estimate must never satisfy an omniscient check. */
export function solvabilityCacheKey(scenarioKey: string): string {
  return `solvability:${scenarioKey}`;
}
