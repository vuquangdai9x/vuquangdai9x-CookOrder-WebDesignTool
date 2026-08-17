// Regression tests for the bug where ingredients could not be picked in the
// NODE play view: `render()` rebuilt all three tiers on every 100ms clock
// tick, so a tile that received mousedown could be destroyed before mouseup
// fired and the click never registered. `ui/play/structureKey.test.ts` pins
// the same fix on the legacy view; this is its graph-native counterpart.
//
// The key must stay stable while nothing but time advances (elapsed cook
// progress, patience countdowns) and must change whenever something a player
// would actually see differently happens (a tile leaves a lane, an item lands
// on the grid, a tool slot's occupant changes, a shared multi-use ingredient's
// remaining count decrements).

import { describe, expect, it } from "vitest";
import burgerJson from "../../data/config/nodegraph/burger.json";
import burgerLevelsCsv from "../../data/config/nodegraph/levels/burger-levels.csv?raw";
import { buildIndex } from "../../core/nodeIndex.ts";
import { NodeSimulation } from "../../core/nodeSim.ts";
import type { NodeLevelConfig } from "../../core/nodeSim.ts";
import { parseGrid, parseQueueGroups, parseQueues } from "../../core/parser.ts";
import { parseNodeCustomers } from "../../core/nodeParser.ts";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import { toNodeLevelConfig } from "../../data/nodeLevel.ts";
import { importLevelsCsv } from "../../data/sheetSource.ts";
import { customersStructureKey, middleStructureKey, playStructureKey, queuesStructureKey } from "./structureKey.ts";

const burger = buildIndex(burgerJson as unknown as NodeGraphMap);
const ing = (name: string): number => {
  const i = burger.ingByName.get(name);
  if (i === undefined) throw new Error(`no ingredient "${name}"`);
  return i;
};
const tool = (name: string): number => {
  const i = burger.toolByName.get(name);
  if (i === undefined) throw new Error(`no tool "${name}"`);
  return i;
};

const EMPTY_GRID = ",,,,,,,,,";

function nodeLevel(o: { queueString: string; gridString?: string; customerString: string }): NodeLevelConfig {
  return {
    id: 1,
    name: "test",
    weather: "Normal",
    levelTag: "",
    featureUnlock: "",
    shuffleDistance: 0,
    serveableSlots: 2,
    queues: parseQueues(o.queueString),
    queueGroups: parseQueueGroups(o.queueString),
    grid: parseGrid(o.gridString ?? EMPTY_GRID),
    customers: parseNodeCustomers(o.customerString),
  };
}

const sim = (o: Parameters<typeof nodeLevel>[0], options = {}) =>
  new NodeSimulation(burger, nodeLevel(o), options);

describe("node play view structure key", () => {
  it("stays stable while only time advances, so tiles survive between ticks", () => {
    const s = sim({ queueString: "0,1%1,0", customerString: "0;0;0;{c0:17.{g0:18}}" });
    const atRest = playStructureKey(s);
    for (let i = 0; i < 60; i++) s.tick(1 / 60); // a second of ticks, nothing picked
    expect(playStructureKey(s)).toBe(atRest);
  });

  it("stays stable while an item is cooking and its progress bar fills", () => {
    const s = sim(
      { queueString: "1", customerString: "0;0;0;{c0:17.{g0:18}}" },
      { instantFlights: false },
    );
    expect(s.pick(0)).toBe(true);
    s.completeAllFlights(); // reaches the griddle and starts cooking
    const cooking = middleStructureKey(s);
    s.tick(0.5); // elapsed advances, still the same slot
    expect(middleStructureKey(s)).toBe(cooking);
    expect(s.tools[tool("griddle")].slots[0].item?.elapsed).toBeGreaterThan(0);
  });

  it("stays stable while a patience timer counts down", () => {
    const s = sim({ queueString: "0,1", customerString: "0;60;0;{c0:17.{g0:18}}" });
    const before = customersStructureKey(s);
    s.tick(5);
    expect(s.active[0].timeLeft).toBeLessThan(60);
    expect(customersStructureKey(s)).toBe(before);
  });

  it("changes when a pick removes a tile from a queue", () => {
    const s = sim({ queueString: "0,1%1,0", customerString: "0;0;0;{c0:17.{g0:18}}" });
    const before = queuesStructureKey(s);
    s.pick(0);
    expect(queuesStructureKey(s)).not.toBe(before);
  });

  it("changes when cooking finishes and moves an item onto the grid", () => {
    const s = sim({ queueString: "1", customerString: "0;0;0;{c3:13}" }); // fries: nobody's waiting for a raw patty
    expect(s.pick(0)).toBe(true);
    const cooking = middleStructureKey(s);
    s.tick(10);
    expect(middleStructureKey(s)).not.toBe(cooking);
  });

  it("changes when an ingredient arrives in a tool slot", () => {
    // instantFlights off so the in-flight state is observable, exactly as the
    // play view runs it.
    const s = sim(
      { queueString: "1", customerString: "0;0;0;{c0:17.{g0:18}}" },
      { instantFlights: false },
    );
    s.pick(0);
    const inFlight = middleStructureKey(s);
    s.completeAllFlights(); // it lands in the slot, which occupies it
    expect(middleStructureKey(s)).not.toBe(inFlight);
  });

  it("changes when a multi-use cooked ingredient's remaining count decrements", () => {
    // chili-bowl is usageNum 2 in burger.json: one landed piece serves two
    // slots before the cell empties. The key must change on the second serve
    // even though the SAME ingredient stays in the SAME cell — only its
    // usesLeft differs, which is exactly the case the legacy regression test
    // for this bug covers.
    const s = sim({ queueString: "0", customerString: "0;0;0;{c0:17}" });
    // Land it on the grid directly via the public grid array — the sim's own
    // pick/serve choreography for a shared multi-use topping needs two
    // customers and a base gate; this isolates the key's sensitivity to
    // usesLeft without that ceremony.
    s.grid[0] = { kind: "cooked", ing: ing("chili-bowl"), usesLeft: 2 };
    const beforeServe = middleStructureKey(s);
    s.grid[0] = { kind: "cooked", ing: ing("chili-bowl"), usesLeft: 1 };
    expect(middleStructureKey(s)).not.toBe(beforeServe);
  });

  it("is stable on a real Map 1 level across a long idle stretch", () => {
    const data = importLevelsCsv(burgerLevelsCsv)[0];
    const s = new NodeSimulation(burger, toNodeLevelConfig(data));
    const before = playStructureKey(s);
    for (let i = 0; i < 300; i++) s.tick(1 / 60); // 5 seconds of ticks
    expect(playStructureKey(s)).toBe(before);
  });
});
