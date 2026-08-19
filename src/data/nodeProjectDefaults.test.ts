import { describe, expect, it } from "vitest";

import { parseQueues } from "../core/parser.ts";
import sushiJson from "./config/nodegraph/maps/Graph-3-Sushi.json";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";
import { blankLevel } from "./nodeProject.ts";

describe("new node level defaults", () => {
  it("starts with three empty ingredient queues", () => {
    const level = blankLevel(sushiJson as NodeGraphMap, 4);
    expect(level.queueString).toBe("%%");
    expect(parseQueues(level.queueString)).toEqual([[], [], []]);
    expect(level.customerString).toBe("");
  });
});
