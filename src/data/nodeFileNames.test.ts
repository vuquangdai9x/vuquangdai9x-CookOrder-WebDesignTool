import { describe, expect, it } from "vitest";

import type { NodeMapEntry } from "./nodeProject.ts";
import { nodeDownloadNames } from "./nodeFileNames.ts";

const entries: NodeMapEntry[] = [
  { id: "burger", name: "Map 1 — Burger", bundled: true, hasDraft: false },
  { id: "sushi", name: "Map 3 — Sushi", bundled: true, hasDraft: false },
  { id: "ramen", name: "Ramen", bundled: false, hasDraft: true },
];

describe("node map download names", () => {
  it("uses the bundled graph/level filename convention", () => {
    expect(nodeDownloadNames(entries, "sushi", "sushi")).toEqual({
      graphJson: "Graph-3-Sushi.json",
      graphCsv: "Graph-3-Sushi.csv",
      graphPng: "Graph-3-Sushi.png",
      levelsCsv: "LevelData-3-Sushi.csv",
    });
  });

  it("assigns custom maps the next available index and sanitizes the name", () => {
    expect(nodeDownloadNames(entries, "ramen", "Ramen: Deluxe/Hot").levelsCsv).toBe(
      "LevelData-4-Ramen-Deluxe-Hot.csv",
    );
  });
});
