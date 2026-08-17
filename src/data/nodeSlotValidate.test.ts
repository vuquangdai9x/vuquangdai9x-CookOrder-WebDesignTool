// The three slot-point invariants, and the queue generator's obligation to
// supply every input of a multi-input recipe.
//
// All four failures here are SILENT at runtime — a recipe that never fires, a
// pickup routed to the wrong place, a machine that looks busy while nothing
// completes, a level that simply cannot be won. That is why they are checked at
// authoring time rather than discovered by playing.

import { describe, expect, it } from "vitest";
import coffeeJson from "./config/nodegraph/maps/Graph-2-Coffee.json";
import burgerJson from "./config/nodegraph/maps/Graph-1-Burger.json";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";
import { validateNodeGraph } from "./nodeGraphValidate.ts";
import { buildIdIndex } from "./nodeIdTable.ts";
import { buildIndex } from "../core/nodeIndex.ts";
import { parseNodeCustomers } from "../core/nodeParser.ts";
import { nodePickupSequence } from "../ui/nodedesign/nodeQueueGenerate.ts";

const coffee = () => structuredClone(coffeeJson) as unknown as NodeGraphMap;
const messagesFor = (doc: NodeGraphMap, id: string) =>
  [...validateNodeGraph(doc).errors, ...validateNodeGraph(doc).warnings]
    .filter((i) => i.invariantId === id)
    .map((i) => i.message);

describe("the shipped graphs are clean", () => {
  it("coffee validates with no errors", () => {
    expect(validateNodeGraph(coffee()).errors.map((e) => e.message)).toEqual([]);
  });

  it("burger validates with no errors after the slot migration", () => {
    expect(
      validateNodeGraph(burgerJson as unknown as NodeGraphMap).errors.map((e) => e.message),
    ).toEqual([]);
  });
});

describe("INV-INPUT-SLOT-RANGE", () => {
  it("rejects an input assigned to a point the tool does not have", () => {
    // The damage: that point can never be filled, so `laneReady` is never true
    // and the recipe silently never runs.
    const doc = coffee();
    doc.edges.process.find((e) => e.to === "coffee-cup-cool")!.inputs[1].slot = 7;
    const found = messagesFor(doc, "INV-INPUT-SLOT-RANGE");
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("never run");
  });
});

describe("INV-INPUT-SLOT-STABLE", () => {
  it("rejects one ingredient entering a tool at two different points", () => {
    // Dispatch routes an incoming pickup by INGREDIENT, so the destination
    // cannot depend on which of the tool's recipes happens to be consulted.
    const doc = coffee();
    doc.edges.process.find((e) => e.to === "coffee-teacup-hot")!.inputs[0].slot = 1;
    expect(messagesFor(doc, "INV-INPUT-SLOT-STABLE")).toHaveLength(1);
  });

  it("allows two DIFFERENT ingredients to share a point", () => {
    // Which is the shipped arrangement: cup and teacup both enter the cup point,
    // and it is the one present that decides the drink.
    expect(messagesFor(coffee(), "INV-INPUT-SLOT-STABLE")).toEqual([]);
  });
});

describe("WARN-UNEVEN-LANES", () => {
  it("warns when a recipe's points have different lane counts", () => {
    const doc = coffee();
    const machine = doc.vertices.tool.find((t) => t.name === "coffee-machine")!;
    machine.slotConfigs[0].slot = 3; // three coffees, still one cup
    const found = messagesFor(doc, "WARN-UNEVEN-LANES");
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toContain("never complete");
  });

  it("is a warning, not an error — the tool still works, it just wastes lanes", () => {
    const doc = coffee();
    doc.vertices.tool.find((t) => t.name === "coffee-machine")!.slotConfigs[0].slot = 3;
    expect(validateNodeGraph(doc).errors.map((e) => e.invariantId)).not.toContain("WARN-UNEVEN-LANES");
  });

  it("stays quiet when the points match", () => {
    const doc = coffee();
    for (const c of doc.vertices.tool.find((t) => t.name === "coffee-machine")!.slotConfigs) c.slot = 2;
    expect(messagesFor(doc, "WARN-UNEVEN-LANES")).toEqual([]);
  });
});

describe("the queue generator supplies every input", () => {
  const doc = coffee();
  const ix = buildIndex(doc);
  const ids = buildIdIndex(doc.idTable);
  const cid = (n: string) => doc.idTable.composite.indexOf(n);
  const iid = (n: string) => doc.idTable.ingredient.indexOf(n);
  const names = (customers: string) =>
    nodePickupSequence(ix, ids, parseNodeCustomers(customers)).map((i) => ix.ingName[i]).sort();

  it("queues the cup as well as the bean for a cool coffee", () => {
    // The bug this exists to prevent: legacy walks ONE input per recipe, so it
    // would queue the bean alone and the machine would wait forever.
    expect(names(`0;0;0;{c${cid("cool-coffee-with-milk")}:${iid("coffee-cup-cool")}}`)).toEqual([
      "coffee-bean",
      "cup",
    ]);
  });

  it("queues a TEACUP for the hot drink, not a cup", () => {
    expect(names(`0;0;0;{c${cid("hot-coffee-latte")}:${iid("coffee-teacup-hot")}}`)).toEqual([
      "coffee-bean",
      "teacup",
    ]);
  });

  it("still queues one pickup per item for a single-input chain", () => {
    // donut -> fryer -> donut-fried: one bare pickup, unchanged by slot points.
    expect(names(`0;0;0;{c${cid("donut-with-topping")}:${iid("donut-fried")}}`)).toEqual(["donut"]);
  });

  it("honours a multi-piece yield: one pickup covers both slices", () => {
    // The cutting board drops 2 kiwi slices, so two slices need ONE kiwi.
    const two = `0;0;0;{c${cid("donut-with-topping")}:${iid("donut-fried")}.${iid("kiwi-sliced")}.${iid("kiwi-sliced")}}`;
    expect(nodePickupSequence(ix, ids, parseNodeCustomers(two)).filter((i) => ix.ingName[i] === "kiwi"))
      .toHaveLength(1);
  });

  it("emits pickups in customer-arrival order", () => {
    const seq = nodePickupSequence(
      ix,
      ids,
      parseNodeCustomers(
        `0;0;0;{c${cid("hot-coffee-latte")}:${iid("coffee-teacup-hot")}}` +
          `|0;0;0;{c${cid("cool-coffee-with-milk")}:${iid("coffee-cup-cool")}}`,
      ),
    ).map((i) => ix.ingName[i]);
    // The first customer's pair comes before the second's, so a player working
    // top-down can actually serve them in order.
    expect(seq.slice(0, 2).sort()).toEqual(["coffee-bean", "teacup"]);
    expect(seq.slice(2).sort()).toEqual(["coffee-bean", "cup"]);
  });
});
