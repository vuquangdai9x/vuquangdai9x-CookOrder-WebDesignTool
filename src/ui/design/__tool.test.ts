import { describe, expect, it } from "vitest";
import { buildIndex } from "../../core/nodeIndex.ts";
import coffeeGraph from "../../data/config/nodegraph/maps/Graph-2-Coffee.json";
import coffeeCsv from "../../data/config/nodegraph/maps/LevelData-2-Coffee.csv?raw";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import { toNodeLevelConfig } from "../../data/nodeLevel.ts";
import { importLevelsCsv } from "../../data/sheetSource.ts";
import { checkToolDeadlock } from "./toolDeadlockCheck.ts";

describe("map 2 tools", () => {
  it("scans every coffee level", () => {
    const ix = buildIndex(coffeeGraph as unknown as NodeGraphMap);
    console.log("tools: " + ix.doc.vertices.tool.map((t, i) => `${i}:${t.displayName} slots=${ix.toolSlots[i].flat.length} preserve=${ix.preservationSlots[i]}`).join(" | "));
    for (const data of importLevelsCsv(coffeeCsv)) {
      const level = toNodeLevelConfig(data);
      const t = performance.now();
      const r = checkToolDeadlock(ix, level, { randomRuns: 30, budgetMs: 3000 });
      const ms = performance.now() - t;
      const failed = r.runs.filter((x) => !x.ok).map((x) => x.name);
      console.log(
        `TOOL ${data.name}: clean=${r.clean} blockedPolicies=[${failed}] random=${r.randomBlocked}/${r.randomRuns} ms=${ms.toFixed(0)} reasons=${r.reasonCounts.slice(0, 3).map((x) => x.reason + "×" + x.count).join(" ; ")}`,
      );
    }
    expect(1).toBe(1);
  });
}, 120_000);
