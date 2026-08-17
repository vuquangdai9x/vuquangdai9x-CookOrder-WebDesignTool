import { describe, expect, it } from "vitest";
import burgerJson from "./config/nodegraph/maps/Graph-1-Burger.json";
import { reorderToolProcesses } from "./nodeGraphEdit.ts";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";

const burger = burgerJson as unknown as NodeGraphMap;

/** A two-tool graph whose process edges deliberately INTERLEAVE. */
const interleaved = (): NodeGraphMap => ({
  ...structuredClone(burger),
  edges: {
    ...structuredClone(burger.edges),
    process: [
      { from: "a", to: "a1", inputs: [{ ingredient: "x", slot: 0 }], amount: 1 },
      { from: "b", to: "b1", inputs: [{ ingredient: "y", slot: 0 }], amount: 1 },
      { from: "a", to: "a2", inputs: [{ ingredient: "x", slot: 0 }], amount: 1 },
      { from: "b", to: "b2", inputs: [{ ingredient: "y", slot: 0 }], amount: 1 },
      { from: "a", to: "a3", inputs: [{ ingredient: "x", slot: 0 }], amount: 1 },
    ],
  },
});

const outputs = (doc: NodeGraphMap) => doc.edges.process.map((e) => `${e.from}:${e.to}`);
const forTool = (doc: NodeGraphMap, tool: string) =>
  doc.edges.process.filter((e) => e.from === tool).map((e) => e.to);

describe("reorderToolProcesses", () => {
  it("moves a recipe within its own tool", () => {
    const next = reorderToolProcesses(interleaved(), "a", 0, 2);
    expect(forTool(next, "a")).toEqual(["a2", "a3", "a1"]);
  });

  /**
   * The property the whole function exists for. A naive splice on the flat
   * array would reorder b's recipes as a side effect of moving a's — silently
   * changing which of b's recipes claims a free slot first.
   */
  it("leaves every OTHER tool's order and array slots untouched", () => {
    const before = interleaved();
    const next = reorderToolProcesses(before, "a", 2, 0);
    expect(forTool(next, "b")).toEqual(forTool(before, "b"));
    // b's entries sit at the same flat indices they started at.
    expect(outputs(next).map((s, i) => (s.startsWith("b:") ? i : null))).toEqual(
      outputs(before).map((s, i) => (s.startsWith("b:") ? i : null)),
    );
  });

  it("never changes how many edges exist", () => {
    const before = interleaved();
    for (const [from, to] of [[0, 2], [2, 0], [1, 2], [0, 1]]) {
      expect(reorderToolProcesses(before, "a", from, to).edges.process).toHaveLength(5);
    }
  });

  it("does not mutate the document it was handed", () => {
    const before = interleaved();
    const snapshot = outputs(before);
    reorderToolProcesses(before, "a", 0, 2);
    expect(outputs(before)).toEqual(snapshot);
  });

  it("returns the SAME document for a no-op or an out-of-range drop", () => {
    // A drag that ends where it started, or off the end of the list, must do
    // nothing at all — not push an undo entry's worth of new object.
    const before = interleaved();
    expect(reorderToolProcesses(before, "a", 1, 1)).toBe(before);
    expect(reorderToolProcesses(before, "a", 0, 9)).toBe(before);
    expect(reorderToolProcesses(before, "a", -1, 0)).toBe(before);
    expect(reorderToolProcesses(before, "nosuchtool", 0, 1)).toBe(before);
  });

  it("round-trips: moving a recipe out and back restores the original order", () => {
    const before = interleaved();
    const there = reorderToolProcesses(before, "a", 0, 2);
    const back = reorderToolProcesses(there, "a", 2, 0);
    expect(outputs(back)).toEqual(outputs(before));
  });

  it("works on the real graph without disturbing other tools", () => {
    const tool = burger.edges.process.find((e) => e.from)?.from ?? "";
    const mine = forTool(burger, tool);
    if (mine.length < 2) return; // nothing to reorder in this data; the synthetic cases cover it
    const next = reorderToolProcesses(burger, tool, 0, mine.length - 1);
    expect(forTool(next, tool)).toEqual([...mine.slice(1), mine[0]]);
    for (const other of new Set(burger.edges.process.map((e) => e.from))) {
      if (other === tool) continue;
      expect(forTool(next, other), other).toEqual(forTool(burger, other));
    }
  });
});
