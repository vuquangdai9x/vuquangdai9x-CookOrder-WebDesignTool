import { describe, expect, it } from "vitest";
import { buildIndex } from "../../core/nodeIndex.ts";
import { parseGrid, parseQueueGroups, parseQueues } from "../../core/parser.ts";
import { parseNodeCustomers } from "../../core/nodeParser.ts";
import type { NodeLevelConfig } from "../../core/nodeSim.ts";
import coffeeGraph from "../../data/config/nodegraph/maps/Graph-2-Coffee.json";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import { checkToolDeadlock, classifyReason } from "./toolDeadlockCheck.ts";

// Map 2 is the map with the multi-input, preservation-slot tools: the grinder
// takes a bean and holds the ground coffee in a preservation slot, and the
// machine needs ground coffee AND a cup together before it can produce anything.
const ix = buildIndex(coffeeGraph as unknown as NodeGraphMap);

// Level strings are written in ID-TABLE ids (the row position in the graph's id
// table), so name them rather than hard-coding digits that renumber whenever a
// designer reorders the table.
const ing = (name: string): number => {
  const id = ix.doc.idTable.ingredient.indexOf(name);
  if (id === -1) throw new Error(`no ingredient "${name}" in the id table`);
  return id;
};
const composite = (name: string): number => {
  const id = ix.doc.idTable.composite.indexOf(name);
  if (id === -1) throw new Error(`no composite "${name}" in the id table`);
  return id;
};

const BEAN = ing("coffee-bean");
const TEACUP = ing("teacup");
const MILK = ing("milk");
const HOT = ing("coffee-teacup-hot");
const LATTE = `0;0;0;{c${composite("hot-coffee-latte")}:${HOT}.${MILK}}`;

const EMPTY_GRID = ",,,,,,,,,";

function level(queueString: string, customerString = LATTE, gridString = EMPTY_GRID): NodeLevelConfig {
  return {
    id: 1,
    name: "test",
    weather: "Normal",
    levelTag: "",
    featureUnlock: "",
    shuffleDistance: 0,
    serveableSlots: 2,
    queues: parseQueues(queueString),
    queueGroups: parseQueueGroups(queueString),
    grid: parseGrid(gridString),
    customers: parseNodeCustomers(customerString),
  } as NodeLevelConfig;
}

describe("classifyReason", () => {
  it("separates a jammed tool from a full board", () => {
    expect(classifyReason("coffee-machine is full")).toBe("tool");
    expect(classifyReason("coffee-grinder preservation slots are full")).toBe("tool");
    expect(classifyReason("No free grid cell")).toBe("grid");
    expect(classifyReason("coffee-machine is full and the grid has no space")).toBe("grid");
  });
});

describe("checkToolDeadlock", () => {
  it("passes a level whose queue can actually feed its tools", () => {
    const report = checkToolDeadlock(ix, level(`${BEAN},${TEACUP}%${MILK},${BEAN}`), { randomRuns: 10 });
    expect(report.clean).toBe(true);
    expect(report.toolBlocked).toBe(0);
  });

  it("catches slots that fill with one input while the other never arrives", () => {
    // Beans and nothing else: the grinder's slot and preservation slot fill with
    // ground coffee that no cup will ever pair with, and the board fills behind
    // it. Every play style hits the same wall.
    const jam = `${BEAN},${BEAN},${BEAN},${BEAN}%${BEAN},${BEAN},${BEAN},${BEAN}`;
    const report = checkToolDeadlock(ix, level(jam), { randomRuns: 10 });
    expect(report.clean).toBe(false);
    expect(report.runs.every((run) => !run.ok)).toBe(true);
    // The reason names the tool that jammed, so a designer knows where to look.
    expect(report.reasonCounts.some((r) => /coffee-(grinder|machine)|grid/i.test(r.reason))).toBe(true);
    // And the panel gets the slot-by-slot picture of the jam.
    expect(report.toolSnapshot.length).toBeGreaterThan(0);
  });

  it("counts a tool jam apart from the board simply filling up", () => {
    const jam = `${BEAN},${BEAN},${BEAN},${BEAN}%${BEAN},${BEAN},${BEAN},${BEAN}`;
    const report = checkToolDeadlock(ix, level(jam), { randomRuns: 10 });
    expect(report.toolBlocked + report.gridBlocked).toBeGreaterThan(0);
    for (const entry of report.reasonCounts) expect(["tool", "grid", "other"]).toContain(entry.kind);
  });

  it("does not call a level deadlocked just because the queue ran out", () => {
    // Too short to fill the order: a losing level, not a jammed one.
    const report = checkToolDeadlock(ix, level(`${BEAN}%${TEACUP}`), { randomRuns: 5 });
    expect(report.toolBlocked).toBe(0);
    expect(report.clean).toBe(true);
  });

  it("stops sampling once its time budget is gone, keeping the counts honest", () => {
    const report = checkToolDeadlock(ix, level(`${BEAN},${TEACUP}%${MILK},${BEAN}`), {
      randomRuns: 10_000,
      budgetMs: 1,
    });
    expect(report.randomRuns).toBeGreaterThan(0);
    expect(report.randomRuns).toBeLessThan(10_000);
  });
});
