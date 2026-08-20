// Multi-input recipes: a tool's slot POINTS, and the rule that a recipe runs
// only once every point it names is filled.
//
// Driven by the real coffee graph rather than a fixture, because the case that
// motivated the whole feature lives there: `coffee-machine` has a ground-coffee
// point and a cup point, and TWO recipes sharing the first — coffee + cup makes
// the cool drink, coffee + teacup the hot one. That sharing is what makes
// "which recipe is this lane making?" a real question, and it is the question
// the old one-input-per-recipe model could not ask.

import { describe, expect, it } from "vitest";
import coffeeJson from "../data/config/nodegraph/maps/Graph-2-Coffee.json";
import type { NodeGraphMap } from "../data/nodeGraphTypes.ts";
import { buildIndex, flatSlot, inputPoint, toolSlotLayout } from "./nodeIndex.ts";
import { NodeSimulation } from "./nodeSim.ts";
import type { NodeLevelConfig } from "./nodeSim.ts";
import { parseNodeCustomers } from "./nodeParser.ts";
import { parseQueues } from "./parser.ts";

const doc = coffeeJson as unknown as NodeGraphMap;
const ix = buildIndex(doc);

const ing = (name: string) => {
  const i = ix.ingByName.get(name);
  if (i === undefined) throw new Error(`no ingredient "${name}"`);
  return i;
};
const tool = (name: string) => {
  const i = ix.toolByName.get(name);
  if (i === undefined) throw new Error(`no tool "${name}"`);
  return i;
};
/** Data id, which is what a queue or dish string carries. */
const id = (name: string) => doc.idTable.ingredient.indexOf(name);
const cid = (name: string) => doc.idTable.composite.indexOf(name);

function level(queue: string, customers: string): NodeLevelConfig {
  return {
    id: 1,
    name: "slot points",
    weather: "Normal",
    levelTag: "",
    featureUnlock: "",
    shuffleDistance: 0,
    serveableSlots: 4,
    queues: parseQueues(queue),
    grid: Array.from({ length: 16 }, () => ({ type: 0, effects: [] })),
    customers: parseNodeCustomers(customers),
  };
}

/** What is sitting in each of a tool's slots, by point name. */
function contents(sim: NodeSimulation, toolIndex: number): Record<string, (string | null)[]> {
  const state = sim.tools[toolIndex];
  const out: Record<string, (string | null)[]> = {};
  state.layout.points.forEach((point, p) => {
    out[point.name] = Array.from({ length: point.lanes }, (_, lane) => {
      const flat = flatSlot(state.layout, p, lane);
      const item = flat === -1 ? null : state.slots[flat].item;
      return item ? ix.ingName[item.ing] : null;
    });
  });
  return out;
}

describe("the index reads slot points off the graph", () => {
  it("flattens points into lanes, point-major", () => {
    const layout = toolSlotLayout({
      name: "t",
      displayName: "T",
      cookingTime: 1,
      slotConfigs: [
        { name: "left", slot: 2 },
        { name: "right", slot: 1 },
      ],
    });
    expect(layout.flat).toEqual([
      { point: 0, lane: 0 },
      { point: 0, lane: 1 },
      { point: 1, lane: 0 },
    ]);
    expect(layout.laneCount).toBe(2);
    // The right point has no lane 1 — that pairing simply does not exist.
    expect(flatSlot(layout, 1, 1)).toBe(-1);
  });

  it("gives a tool with no configured points one anyway", () => {
    // Zero points would mean nothing could ever cook there, and the failure
    // would read as a level that mysteriously stalls.
    const layout = toolSlotLayout({ name: "t", displayName: "T", cookingTime: 1, slotConfigs: [] });
    expect(layout.points).toHaveLength(1);
    expect(layout.flat).toHaveLength(1);
  });

  it("records which point each input of a real recipe enters", () => {
    const step = ix.producerOf[ing("coffee-cup-cool")]!;
    expect(ix.toolName[step.tool]).toBe("coffee-machine");
    expect(inputPoint(step, ing("coffee-grinded"))).toBe(0);
    expect(inputPoint(step, ing("cup"))).toBe(1);
  });

  it("collects every recipe a tool owns, which is what disambiguates a lane", () => {
    const outs = ix.stepsOfTool[tool("coffee-machine")].map((s) => ix.ingName[s.out]).sort();
    expect(outs).toEqual(["coffee-cup-cool", "coffee-teacup-hot"]);
  });
});

describe("the machine waits for BOTH inputs", () => {
  const order = `0;0;0;{c${cid("cool-coffee-with-milk")}:${id("coffee-cup-cool")}}`;

  it("does not start cooking with only the coffee in", () => {
    const sim = new NodeSimulation(ix, level(`${id("coffee-bean")}`, order));
    expect(sim.pick(0)).toBe(true);
    sim.tick(3); // grind
    sim.tick(3); // the ground coffee forwards into the machine

    const held = contents(sim, tool("coffee-machine"));
    expect(held["ground-coffee-container"]).toEqual(["coffee-grinded"]);
    expect(held["cup-slot"]).toEqual([null]);

    // Ten seconds of nothing happening: the timer has not started, so the
    // coffee is not quietly burning while its cup is still in the queue.
    sim.tick(10);
    expect(contents(sim, tool("coffee-machine"))["ground-coffee-container"]).toEqual(["coffee-grinded"]);
    expect(sim.grid.every((c) => c.kind === "empty")).toBe(true);
    expect(sim.servedCount).toBe(0);
  });

  it("brews once the cup lands, and serves the cool drink", () => {
    const sim = new NodeSimulation(ix, level(`${id("coffee-bean")},${id("cup")}`, order));
    expect(sim.pick(0)).toBe(true); // bean -> grinder
    sim.tick(6); // grind, then forward into the machine
    expect(sim.pick(0)).toBe(true); // cup -> the machine's cup point

    const held = contents(sim, tool("coffee-machine"));
    expect(held["ground-coffee-container"]).toEqual(["coffee-grinded"]);
    expect(held["cup-slot"]).toEqual(["cup"]);

    sim.runToEnd(60);
    expect(sim.status).toBe("won");
    expect(sim.servedCount).toBe(1);
  });

  it("empties EVERY point of the lane when the job completes", () => {
    const sim = new NodeSimulation(ix, level(`${id("coffee-bean")},${id("cup")}`, order));
    sim.pick(0);
    sim.tick(6);
    sim.pick(0);
    sim.tick(20);
    // A cup left behind would block the next brew forever.
    expect(contents(sim, tool("coffee-machine"))).toEqual({
      "ground-coffee-container": [null],
      "cup-slot": [null],
    });
  });
});

describe("tool preservation slots", () => {
  it("buffers one extra bean while completed ground coffee waits for the running machine", () => {
    const bufferedDoc = structuredClone(doc);
    const machine = bufferedDoc.vertices.tool.find((value) => value.name === "coffee-machine")!;
    machine.cookingTime = 3;
    const buffered = buildIndex(bufferedDoc);
    const bean = buffered.ingByName.get("coffee-bean")!;
    const ground = buffered.ingByName.get("coffee-grinded")!;
    const grinderIndex = buffered.toolByName.get("coffee-grinder")!;
    const machineIndex = buffered.toolByName.get("coffee-machine")!;
    const cool = `{c${cid("cool-coffee-with-milk")}:${id("coffee-cup-cool")}}`;
    const sim = new NodeSimulation(
      buffered,
      level(
        `${id("coffee-bean")},${id("cup")},${id("coffee-bean")},${id("coffee-bean")},${id("coffee-bean")}`,
        `0;0;0;${cool},${cool}`,
      ),
    );

    expect(sim.pick(0)).toBe(true); // bean passes through preservation into grinder
    sim.tick(1); // ground coffee reaches the machine and waits
    expect(sim.pick(0)).toBe(true); // cup starts the three-second brew
    expect(sim.pick(0)).toBe(true); // next bean enters the now-free grinder
    sim.tick(1); // its completed ground coffee is held because the machine is still running

    const grinder = sim.tools[grinderIndex];
    expect(grinder.slots[0].item?.ing).toBe(ground);
    expect(sim.pick(0)).toBe(true); // one more bean fits in the preservation buffer
    expect(grinder.slots[grinder.processSlotCount].item?.ing).toBe(bean);
    expect(sim.canPick(0)).toMatchObject({ ok: false });
    expect(sim.canPick(0).reason).toContain("preservation slots are full");

    sim.tick(2); // machine finishes: held ground moves in, buffered bean starts grinding
    expect(sim.tools[machineIndex].slots[0].item?.ing).toBe(ground);
    expect(sim.tools[machineIndex].slots[1].item).toBeNull(); // waits for the next cup
    expect(grinder.slots[0].item?.ing).toBe(bean);
    expect(grinder.slots[grinder.processSlotCount].item).toBeNull();
  });
});

describe("the lane's recipe is decided by the whole set, not the first item", () => {
  // Ground coffee is input 0 of BOTH drinks, so it names neither on its own.
  // `recipeForInput` returns whichever was registered first; if the sim trusted
  // that, a teacup would silently brew a cool coffee.
  it("brews the HOT drink when the teacup is the partner", () => {
    const sim = new NodeSimulation(
      ix,
      level(
        `${id("coffee-bean")},${id("teacup")}`,
        `0;0;0;{c${cid("hot-coffee-latte")}:${id("coffee-teacup-hot")}}`,
      ),
    );
    sim.pick(0);
    sim.tick(6);
    sim.pick(0);
    sim.runToEnd(60);

    expect(sim.status).toBe("won");
    expect(sim.servedCount).toBe(1);
  });

  it("and the COOL drink when the plain cup is", () => {
    const sim = new NodeSimulation(
      ix,
      level(
        `${id("coffee-bean")},${id("cup")}`,
        `0;0;0;{c${cid("cool-coffee-with-milk")}:${id("coffee-cup-cool")}}`,
      ),
    );
    sim.pick(0);
    sim.tick(6);
    sim.pick(0);
    sim.runToEnd(60);

    expect(sim.status).toBe("won");
    expect(sim.servedCount).toBe(1);
  });
});

describe("lanes pair up rather than spreading", () => {
  /** The coffee machine widened to two lanes per point. */
  const twoLane = (): NodeGraphMap => {
    const clone = structuredClone(doc);
    const machine = clone.vertices.tool.find((t) => t.name === "coffee-machine")!;
    machine.slotConfigs = machine.slotConfigs.map((c) => ({ ...c, slot: 2 }));
    return clone;
  };

  it("puts a cup in the SAME lane as the waiting coffee", () => {
    // The failure this guards: coffee into lane 0, cup into lane 1. The machine
    // then looks full while neither job can ever complete.
    const wide = buildIndex(twoLane());
    const sim = new NodeSimulation(
      wide,
      level(
        `${id("coffee-bean")},${id("cup")}`,
        `0;0;0;{c${cid("cool-coffee-with-milk")}:${id("coffee-cup-cool")}}`,
      ),
    );
    sim.pick(0);
    sim.tick(6);
    sim.pick(0);

    const machine = wide.toolByName.get("coffee-machine")!;
    const state = sim.tools[machine];
    const laneOf = (point: number) =>
      state.layout.flat.findIndex(
        (addr, flat) => addr.point === point && state.slots[flat].item !== null,
      );
    expect(laneOf(0)).not.toBe(-1);
    expect(state.layout.flat[laneOf(0)].lane).toBe(state.layout.flat[laneOf(1)].lane);
  });
});

describe("single-input tools are untouched", () => {
  it("still cooks the moment its one input lands", () => {
    // The regression that matters most: every existing map is single-input, and
    // per-lane cooking must reduce to exactly the old per-slot behaviour.
    const sim = new NodeSimulation(ix, level(`${id("cupcake")}`, "0;0;0;"));
    expect(sim.pick(0)).toBe(true);
    const baker = tool("baker");
    expect(contents(sim, baker)["Slot"]).toEqual(["cupcake"]);
    sim.tick(30);
    expect(contents(sim, baker)["Slot"]).toEqual([null]);
    expect(sim.grid.some((c) => c.kind === "cooked")).toBe(true);
  });
});
