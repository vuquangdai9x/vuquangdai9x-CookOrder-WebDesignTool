import { describe, it } from "vitest";
import { buildIndex } from "../../core/nodeIndex.ts";
import burgerGraph from "../../data/config/nodegraph/maps/Graph-1-Burger.json";
import burgerLevelsCsv from "../../data/config/nodegraph/maps/LevelData-1-Burger.csv?raw";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import { toNodeLevelConfig } from "../../data/nodeLevel.ts";
import { importLevelsCsv } from "../../data/sheetSource.ts";
import { defaultScenario } from "./estimateScenario.ts";
import { estimateNodeDifficulty } from "./nodeEstimateDifficulty.ts";

describe("temporary level 19 diagnosis", () => {
  it("sweeps cadence", () => {
    const ix = buildIndex(burgerGraph as unknown as NodeGraphMap);
    const level = toNodeLevelConfig(importLevelsCsv(burgerLevelsCsv).find((value) => value.id === 19)!);
    for (const interval of [0, 0.35, 0.75, 1, 1.25, 1.5, 2, 3, 5, 10, 20]) {
      const scenario = defaultScenario();
      scenario.fields.pickIntervalSeconds.value = interval;
      const result = estimateNodeDifficulty(ix, structuredClone(level), { scenario });
      console.log(JSON.stringify({ interval, solvable: result.solvable, served: `${result.servedCount}/${result.totalCustomers}`, reason: result.loseReason, detail: result.reason, picks: result.totalPicks, attempt: result.attemptCount, strategy: result.strategyName, effective: result.pickIntervalSeconds, timeouts: result.timedOutCustomers }));
    }
    const settleLike = defaultScenario();
    settleLike.fields.pickIntervalSeconds.value = 20;
    const authored = estimateNodeDifficulty(ix, structuredClone(level), { scenario: settleLike, maxRetries: 0 });
    console.log("authored-20", JSON.stringify({ solvable: authored.solvable, served: authored.servedCount, reason: authored.loseReason, picks: authored.totalPicks }));
    console.log("authored-20-trace", JSON.stringify(authored.occupancyHistory.map((sample, index) => ({ pick: index + 1, lane: authored.replaySteps[index]?.lane, occupied: sample.occupied, picked: sample.pickedNames }))));
    console.log("authored-20-scores", JSON.stringify(authored.replaySteps.map((step) => step.laneScores)));
    const unlearned = defaultScenario();
    unlearned.fields.pickIntervalSeconds.value = 19.12345;
    const unlearnedResult = estimateNodeDifficulty(ix, structuredClone(level), { scenario: unlearned });
    console.log("unlearned", JSON.stringify({ solvable: unlearnedResult.solvable, served: unlearnedResult.servedCount, reason: unlearnedResult.loseReason, picks: unlearnedResult.totalPicks, strategy: unlearnedResult.strategyName, attempt: unlearnedResult.attemptCount }));
    for (const interval of [0.35, 1, 1.5, 3, 5]) {
      const noGuard = defaultScenario();
      noGuard.fields.pickIntervalSeconds.value = interval;
      noGuard.fields.maxIterations.value = 4999;
      const result = estimateNodeDifficulty(ix, structuredClone(level), { scenario: noGuard });
      console.log("no-guard", JSON.stringify({ interval, solvable: result.solvable, served: result.servedCount, reason: result.loseReason, picks: result.totalPicks, strategy: result.strategyName, attempt: result.attemptCount, effective: result.pickIntervalSeconds }));
    }
  });
});
