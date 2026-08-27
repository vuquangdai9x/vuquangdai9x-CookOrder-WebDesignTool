import { describe, expect, it } from "vitest";

import { parseQueues } from "../core/parser.ts";
import sushiJson from "./config/nodegraph/maps/Graph-3-Sushi.json";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";
import { blankLevel, blankNodeGraph } from "./nodeProject.ts";

describe("new node level defaults", () => {
  it("uses the default 5×2 map grid", () => {
    const doc = blankNodeGraph("new-map", "New Map");
    expect(doc.map.gridWidth).toBe(5);
    expect(doc.map.gridHeight).toBe(2);
    expect(blankLevel(doc).gridString.split(",")).toHaveLength(10);
  });

  it("starts with three empty ingredient queues", () => {
    const level = blankLevel(sushiJson as NodeGraphMap, 4);
    expect(level.queueString).toBe("%%");
    expect(parseQueues(level.queueString)).toEqual([[], [], []]);
    expect(level.customerString).toBe("");
  });
});
