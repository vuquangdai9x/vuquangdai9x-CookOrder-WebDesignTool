// Worker host for the combined Level Statistics + MCP evaluation report.

import type { EstimateProgress } from "./estimateDifficulty.ts";
import {
  createStatisticReport,
  type StatisticReport,
  type StatisticReportInput,
} from "./statisticsReport.ts";

export type StatisticsWorkerRequest = StatisticReportInput;

export type StatisticsWorkerResponse =
  | { type: "progress"; progress: EstimateProgress }
  | { type: "result"; result: StatisticReport }
  | { type: "error"; error: string };

self.onmessage = (event: MessageEvent<StatisticsWorkerRequest>) => {
  try {
    const result = createStatisticReport(event.data, (progress) => {
      self.postMessage({ type: "progress", progress } satisfies StatisticsWorkerResponse);
    });
    self.postMessage({ type: "result", result } satisfies StatisticsWorkerResponse);
  } catch (err) {
    self.postMessage({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    } satisfies StatisticsWorkerResponse);
  }
};
