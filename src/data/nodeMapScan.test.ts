// The map list is scanned from config/nodegraph/maps/ rather than hand-listed,
// so the FILENAME is the contract. These pin both halves of that: the parser
// that reads a name, and the registry it produces from the real folder.
//
// The stakes are asymmetric. A file that fails to parse must be skipped and
// reported — never allowed to throw — because the scan runs at module scope,
// before any error panel exists to catch it: one stray file in that folder
// would otherwise blank the whole app.

import { describe, expect, it } from "vitest";
import {
  blankLevel,
  blankNodeGraph,
  defaultNodeMapId,
  freshNodeProject,
  NODE_DOCS,
  parseMapFileName,
} from "./nodeProject.ts";

describe("filename convention", () => {
  it("reads the index and name out of a well-formed graph filename", () => {
    expect(parseMapFileName("./config/nodegraph/maps/Graph-2-Coffee.json", "Graph")).toEqual({
      index: 2,
      name: "Coffee",
    });
  });

  it("reads level data the same way", () => {
    expect(parseMapFileName("./x/LevelData-1-Burger.csv", "LevelData")).toEqual({
      index: 1,
      name: "Burger",
    });
  });

  it("keeps a name containing dashes intact", () => {
    // The regex is greedy on the name half for exactly this: a map called
    // "Ice-Cream" must not be truncated to "Ice".
    expect(parseMapFileName("./Graph-3-Ice-Cream.json", "Graph")?.name).toBe("Ice-Cream");
  });

  it("does not confuse the two prefixes with each other", () => {
    expect(parseMapFileName("./LevelData-1-Burger.csv", "Graph")).toBeNull();
    expect(parseMapFileName("./Graph-1-Burger.json", "LevelData")).toBeNull();
  });

  it.each([
    ["no index", "./Graph-Burger.json"],
    ["a non-numeric index", "./Graph-two-Coffee.json"],
    ["no name", "./Graph-2-.json"],
    ["no prefix", "./Coffee.json"],
    ["a stray file", "./README.md"],
    ["an index but nothing else", "./Graph-2.json"],
  ])("skips %s", (_why, path) => {
    expect(parseMapFileName(path, "Graph")).toBeNull();
  });
});

describe("the scanned registry", () => {
  it("found the committed maps, in index order", () => {
    expect(NODE_DOCS.map((d) => d.index)).toEqual([...NODE_DOCS.map((d) => d.index)].sort((a, b) => a - b));
    expect(NODE_DOCS.map((d) => d.name)).toEqual(["Map 1 — Burger", "Map 2 — Coffee", "Map 3 — Sushi"]);
  });

  it("joins level data to its graph by INDEX", () => {
    // Burger ships LevelData-1-Burger.csv; coffee has none yet.
    const byId = new Map(NODE_DOCS.map((d) => [d.id, d]));
    expect(byId.get("burger")?.levelsCsv).toContain("Level_ID");
    expect(byId.get("coffee")?.levelsCsv).toBeUndefined();
  });

  it("gives every map a distinct id and index", () => {
    expect(new Set(NODE_DOCS.map((d) => d.id)).size).toBe(NODE_DOCS.length);
    expect(new Set(NODE_DOCS.map((d) => d.index)).size).toBe(NODE_DOCS.length);
  });

  it("opens the lowest-indexed map by default", () => {
    expect(defaultNodeMapId()).toBe("burger");
  });
});

describe("every project has at least one level", () => {
  // NodeDesignView does `levels.find(...) ?? levels[0]` and reads fields off the
  // result; with an empty list that is `undefined` and the view dies on mount.
  // A map with no levels was therefore unopenable — the bug this guarantees away.

  it("gives a graph with no committed levels one empty level", () => {
    const coffee = freshNodeProject("coffee");
    expect(coffee.levels).toHaveLength(1);
    expect(coffee.levels[0].customerString).toBe("");
  });

  it("gives a brand-new custom map one too", () => {
    expect(freshNodeProject("a-map-that-does-not-exist").levels).toHaveLength(1);
  });

  it("still uses the committed dataset when there is one", () => {
    expect(freshNodeProject("burger").levels.length).toBeGreaterThan(1);
  });

  it("sizes the blank level's grid to the map", () => {
    const doc = blankNodeGraph("x", "X");
    doc.map.gridWidth = 5;
    doc.map.gridHeight = 3;
    // One cell per grid position, or the grid editor renders a board with
    // nothing to click into.
    expect(blankLevel(doc).gridString.split(",")).toHaveLength(15);
  });
});
