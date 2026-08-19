import { describe, expect, it } from "vitest";
import burgerJson from "../data/config/nodegraph/maps/Graph-1-Burger.json";
import type { NodeGraphMap } from "../data/nodeGraphTypes.ts";
import { validateNodeGraph } from "../data/nodeGraphValidate.ts";
import { cookedName, legacyLevelToNode, legacyToGraph, pickupName, rawName } from "./legacyToGraph.ts";
import { buildIndex } from "./nodeIndex.ts";
import { parseNodeCustomers } from "./nodeParser.ts";
import { NodeSimulation } from "./nodeSim.ts";
import type { NodeLevelConfig } from "./nodeSim.ts";
import { parseGrid, parseQueueGroups, parseQueues } from "./parser.ts";
import { chainedPotato } from "./nodeTestFixtures.ts";
import { EMPTY_GRID, level, testMap } from "./testFixtures.ts";

const burger = buildIndex(burgerJson as unknown as NodeGraphMap);
const ing = (name: string) => {
  const i = burger.ingByName.get(name);
  if (i === undefined) throw new Error(`no ingredient "${name}"`);
  return i;
};
const tool = (name: string) => {
  const i = burger.toolByName.get(name);
  if (i === undefined) throw new Error(`no tool "${name}"`);
  return i;
};

interface LevelStrings {
  queueString: string;
  gridString?: string;
  customerString: string;
  serveableSlots?: number;
  weather?: string;
}

/** A node-format level from the same three strings the legacy fixtures use. */
function nodeLevel(o: LevelStrings): NodeLevelConfig {
  return {
    id: 1,
    name: "test",
    weather: o.weather ?? "Normal",
    levelTag: "",
    featureUnlock: "",
    shuffleDistance: 0,
    serveableSlots: o.serveableSlots ?? 2,
    queues: parseQueues(o.queueString),
    queueGroups: parseQueueGroups(o.queueString),
    grid: parseGrid(o.gridString ?? EMPTY_GRID),
    customers: parseNodeCustomers(o.customerString),
  };
}

const sim = (o: LevelStrings, options = {}) => new NodeSimulation(burger, nodeLevel(o), options);

/**
 * The same map with potato spelled as ONE chainTools edge. `burger.json` is a
 * designer's file and may spell that route either way; these tests are about
 * the engine's handling of the spelling, so they derive it. See
 * `nodeTestFixtures.ts`.
 */
const chained = buildIndex(chainedPotato(burgerJson as unknown as NodeGraphMap));
const chainedIng = (name: string) => {
  const i = chained.ingByName.get(name);
  if (i === undefined) throw new Error(`no ingredient "${name}"`);
  return i;
};
const chainedTool = (name: string) => {
  const i = chained.toolByName.get(name);
  if (i === undefined) throw new Error(`no tool "${name}"`);
  return i;
};
const chainedSim = (o: LevelStrings, options = {}) =>
  new NodeSimulation(chained, nodeLevel(o), options);

// Burger id-table ids, for readability in the strings below.
// raws 0-16 · processed 100+ · composites c0 burger, c1 soda, c2 fried-basket
// groups g0 burger-toppings, g1 fried-basket-bases, g2 fried-basket-sauces.

describe("core loop", () => {
  it("picks, cooks, serves and wins", () => {
    const s = sim({ queueString: "0,1", customerString: "0;0;0;{c0:17.{g0:18}}" });
    expect(s.active).toHaveLength(1);
    expect(s.issues).toEqual([]);
    s.pick(0);
    s.pick(0);
    s.runToEnd();
    expect(s.status).toBe("won");
    expect(s.servedCount).toBe(1);
  });

  it("places cooked output in the first free cell in scan order", () => {
    const s = sim({ queueString: "1", customerString: "0;0;0;{c0:17.{g0:18}}" });
    s.pick(0);
    s.tick(4);
    expect(s.grid[0]).toEqual({ kind: "cooked", ing: ing("patty-cooked") });
    expect(s.grid[1]).toEqual({ kind: "empty" });
  });

  it("skips blocked cells when placing", () => {
    const s = sim({
      queueString: "1",
      gridString: "#1,,,,,,,,,",
      customerString: "0;0;0;{c0:17.{g0:18}}",
    });
    s.pick(0);
    s.tick(4);
    expect(s.grid[0]).toEqual({ kind: "empty" });
    expect(s.grid[1]).toEqual({ kind: "cooked", ing: ing("patty-cooked") });
  });

  it("loses when the queues run dry with an order outstanding", () => {
    const s = sim({ queueString: "1", customerString: "0;0;0;{c0:17.{g0:18}}" });
    s.pick(0);
    s.runToEnd();
    expect(s.status).toBe("lost");
    expect(s.loseReason).toBe("out-of-ingredient");
  });

  it("loses when a customer runs out of patience", () => {
    const s = sim({ queueString: "0,1", customerString: "0;2;0;{c0:17.{g0:18}}" });
    s.runToEnd();
    expect(s.status).toBe("lost");
    expect(s.loseReason).toBe("customer-timeout");
  });

  it("halves patience for a weather-affected customer in bad weather", () => {
    const normal = sim({ queueString: "0", customerString: "0;10;1;{c0:17}" });
    const rainy = sim({ queueString: "0", customerString: "0;10;1;{c0:17}", weather: "Rainy" });
    expect(normal.active[0].timeLeft).toBe(10);
    expect(rainy.active[0].timeLeft).toBe(5);
  });
});

describe("the two spellings of a two-tool route", () => {
  /**
   * The chicken route: TWO process edges through a real `*-flour-coated`
   * vertex. The coated piece is a genuine output, so the danger is that it
   * lands on the grid and stops — no dish ever wants it. The forwarding rule
   * (non-servable AND consumed ⇒ hop onward) is what stops that, and this test
   * watches every hop to prove nothing touches the grid.
   */
  it("forwards a coated chicken piece flour -> fryer with no grid landing", () => {
    const s = sim(
      { queueString: "9", customerString: "0;0;0;{c2:{g1:25}}" },
      { instantFlights: false },
    );
    expect(s.pick(0)).toBe(true);
    s.completeAllFlights();
    expect(s.tools[tool("flour")].slots[0].item?.ing).toBe(ing("chicken-breast"));

    s.tick(1);
    expect(s.flights.map((f) => f.kind)).toEqual(["tool-to-tool"]);
    expect(s.flights[0].ing).toBe(ing("chicken-breast-flour-coated"));
    // A forward carries NO chain state — the fryer owns a real recipe for it.
    expect(s.flights[0].chain).toBeUndefined();

    s.completeAllFlights();
    expect(s.tools[tool("fryer")].slots[0].item?.ing).toBe(ing("chicken-breast-flour-coated"));
    expect(s.grid.every((c) => c.kind === "empty")).toBe(true);

    s.tick(1);
    expect(s.flights.map((f) => f.kind)).toEqual(["tool-to-customer"]);
    s.completeAllFlights();
    expect(s.status).toBe("won");
  });

  /**
   * The potato route: ONE process edge with chainTools. No intermediate vertex
   * exists at all, so the RAW potato itself hops, carrying the chain state that
   * says what it will eventually become.
   */
  it("hops a potato cutting-board -> fryer carrying its chain state", () => {
    const s = chainedSim(
      { queueString: "13", customerString: "0;0;0;{c2:{g1:29}}" },
      { instantFlights: false },
    );
    s.pick(0);
    s.completeAllFlights();
    const chain = s.tools[chainedTool("cutting-board")].slots[0].item?.chain;
    expect(chain?.remaining.map((t) => chained.toolName[t])).toEqual(["fryer"]);
    expect(chain?.out).toBe(chainedIng("potato-fried"));

    s.tick(1);
    expect(s.flights.map((f) => f.kind)).toEqual(["tool-to-tool"]);
    // Still the RAW potato — unlike chicken, nothing intermediate exists.
    expect(s.flights[0].ing).toBe(chainedIng("potato"));
    s.completeAllFlights();

    s.tick(1);
    // The collapsed edge carries the whole chain's yield. One piece flies
    // straight to the waiting customer; any surplus lands on the grid.
    const yield_ = chained.terminalYield[chainedIng("potato")];
    expect(s.flights.map((f) => f.kind).sort()).toEqual(
      yield_ > 1 ? ["tool-to-customer", "tool-to-grid"] : ["tool-to-customer"],
    );
    s.completeAllFlights();
    expect(s.status).toBe("won");
    expect(s.grid.filter((c) => c.kind === "cooked")).toHaveLength(yield_ - 1);
  });

  it("forwards one batched intermediate and parks the surplus until the next tool frees", () => {
    const doc = structuredClone(burgerJson as unknown as NodeGraphMap);
    const slicedEdge = doc.edges.process.find((edge) => edge.to === "potato_sliced")!;
    slicedEdge.amount = 2;
    const batch = buildIndex(doc);
    const sliced = batch.ingByName.get("potato_sliced")!;
    const fryer = batch.toolByName.get("fryer")!;
    const s = new NodeSimulation(
      batch,
      nodeLevel({
        queueString: "13",
        customerString: "0;0;0;{c2:{g1:29}}|0;0;0;{c2:{g1:29}}",
      }),
      { instantFlights: false },
    );

    s.pick(0);
    s.completeAllFlights();
    s.tick(100); // cutting board finishes: one slice forwards, one heads to grid
    expect(s.flights.map((flight) => flight.kind).sort()).toEqual(["tool-to-grid", "tool-to-tool"]);
    s.completeAllFlights();

    expect(s.tools[fryer].slots[0].item?.ing).toBe(sliced);
    expect(s.grid.some((cell) => cell.kind === "cooked" && cell.ing === sliced)).toBe(true);

    s.tick(100); // fryer empties; the parked slice is reclaimed in the same settle pass
    expect(s.flights.map((flight) => flight.kind).sort()).toEqual(["grid-to-tool", "tool-to-customer"]);
    s.completeAllFlights();
    expect(s.grid.some((cell) => cell.kind === "cooked" && cell.ing === sliced)).toBe(false);
    expect(s.tools[fryer].slots[0].item?.ing).toBe(sliced);

    s.tick(100);
    s.completeAllFlights();
    expect(s.status).toBe("won");
  });

  it("stalls a forward rather than dropping the piece when the fryer is taken", () => {
    // The fryer has ONE slot and is the destination of BOTH spellings, so they
    // contend: a potato claims it as a chain hop in the same tick a coated
    // breast wants it as a forward. The loser must wait at the flour tool —
    // never spill onto the grid, and never be lost.
    const s = chainedSim(
      {
        queueString: "13%9",
        customerString: "0;0;0;{c2:{g1:29}}|0;0;0;{c2:{g1:25}}",
      },
      { instantFlights: false },
    );
    s.pick(0); // potato -> cutting board
    s.pick(1); // breast -> flour
    s.completeAllFlights();

    s.tick(1);
    // The potato hopped first (tools advance in graph order) and reserved the
    // fryer slot; the coated breast found nothing free.
    expect(s.flights.map((f) => f.kind)).toEqual(["tool-to-tool"]);
    expect(s.flights[0].ing).toBe(chainedIng("potato"));
    expect(s.tools[chainedTool("flour")].slots[0].item?.ing).toBe(chainedIng("chicken-breast"));
    expect(s.grid.every((c) => c.kind === "empty")).toBe(true);

    s.completeAllFlights();
    s.tick(1); // the fryer empties this tick, so the forward now gets through
    expect(s.flights.some((f) => f.ing === chainedIng("chicken-breast-flour-coated"))).toBe(true);
    s.completeAllFlights();
    s.runToEnd();
    expect(s.status).toBe("won");
  });
});

describe("slot gates", () => {
  it("holds a topping back until the dish's base is in place", () => {
    const s = sim({ queueString: "1,0", customerString: "0;0;0;{c0:17.{g0:18}}" });
    s.pick(0); // patty first — its slot is gated on the bun
    s.tick(4);
    const dish = s.active[0].dishes[0];
    expect(dish.filled).toEqual([false, false]);
    expect(s.grid.some((c) => c.kind === "cooked" && c.ing === ing("patty-cooked"))).toBe(true);

    s.pick(0); // now the bun
    s.runToEnd();
    expect(s.status).toBe("won");
  });

  it("serves a base immediately — it gates on nothing", () => {
    const s = sim({ queueString: "0", customerString: "0;0;0;{c0:17}" });
    s.pick(0);
    s.tick(2);
    expect(s.status).toBe("won");
    // Straight from the tool to the customer; the grid was never involved.
    expect(s.grid.every((c) => c.kind !== "cooked")).toBe(true);
  });

  it("tracks quantity per slot, not per ingredient", () => {
    // Two patties are two slots. Filling one must not satisfy the other.
    const s = sim({ queueString: "0,1,1", customerString: "0;0;0;{c0:17.{g0:18.18}}" });
    const dish = s.active[0].dishes[0];
    expect(dish.order.slots).toHaveLength(3);
    s.pick(0);
    s.pick(0);
    s.tick(4);
    expect(dish.filled.filter(Boolean)).toHaveLength(2);
    expect(s.status).toBe("playing");
    s.pick(0);
    s.runToEnd();
    expect(s.status).toBe("won");
  });
});

describe("multi-use ingredients", () => {
  it("lands a usageNum ingredient on the grid and spends one use per serve", () => {
    // cheese-sauce has usageNum 3, so it must NOT direct-serve: the other two
    // uses would be thrown away.
    const s = sim({ queueString: "13,16", customerString: "0;0;0;{c2:{g1:29}.{g2:16}}" });
    s.pick(0); // potato -> 2 fries, one serves the base slot
    s.tick(3);
    s.pick(0); // cheese sauce needs no tool
    s.runToEnd();
    expect(s.status).toBe("won");
    const sauce = s.grid.find((c) => c.kind === "cooked" && c.ing === ing("cheese-sauce"));
    expect(sauce).toEqual({ kind: "cooked", ing: ing("cheese-sauce"), usesLeft: 2 });
  });
});

describe("dirty objects", () => {
  it("reads the dirty object off the composite, not off a source-id scan", () => {
    const s = sim({ queueString: "0%7", customerString: "0;0;0;{c0:17},{c1:24}" });
    s.pick(0);
    s.pick(1);
    s.runToEnd();
    expect(s.status).toBe("won");
    const stacks = s.grid
      .filter((c): c is { kind: "dirty"; dirtyId: number; count: number } => c.kind === "dirty")
      .map((c) => burger.dirtyName[c.dirtyId])
      .sort();
    expect(stacks).toEqual(["dirty-cup", "dirty-plate"]);
  });

  it("stacks same-type dirty dishes and never mixes types", () => {
    const s = sim({
      queueString: "0,0",
      customerString: "0;0;0;{c0:17}|0;0;0;{c0:17}",
      serveableSlots: 1,
    });
    s.pick(0);
    s.runToEnd(0.25, 20);
    s.pick(0);
    s.runToEnd(0.25, 20);
    expect(s.status).toBe("won");
    const dirty = s.grid.filter((c) => c.kind === "dirty");
    expect(dirty).toHaveLength(1);
    expect(dirty[0]).toMatchObject({ count: 2 });
  });

  it("lets a staff customer clear stacks", () => {
    const s = sim({
      queueString: "0,0",
      customerString: "0;0;0;{c0:17}|1;0;0;;2|0;0;0;{c0:17}",
      serveableSlots: 1,
    });
    s.pick(0);
    s.runToEnd(0.25, 20);
    expect(s.grid.filter((c) => c.kind === "dirty")).toHaveLength(0);
    s.pick(0);
    s.runToEnd(0.25, 20);
    expect(s.status).toBe("won");
  });
});

describe("data problems are collected, never thrown", () => {
  it("reports an unknown queue id instead of crashing", () => {
    const s = sim({ queueString: "999", customerString: "0;0;0;{c0:17}" });
    expect(s.issues).toEqual(['Queue references unknown ingredient id 999']);
    expect(s.pick(0)).toBe(false);
  });

  it("reports a dish naming a composite id past the end of the table", () => {
    // There are no tombstones: a removed row is spliced out, so an id that no
    // longer exists is simply unknown. The dish still binds — minus its root —
    // rather than throwing, which is the property that matters here.
    const beyond = burger.doc.idTable.composite.length;
    const s = sim({ queueString: "0", customerString: `0;0;0;{c${beyond}:29}` });
    expect(s.issues[0]).toContain(`No composite has id ${beyond}`);
    expect(s.active[0].dishes[0].order.orderable).toBe(-1);
  });
});

describe("unsatisfiableSlots", () => {
  it("names a slot nothing left on the board could fill", () => {
    const s = sim({ queueString: "0", customerString: "0;0;0;{c0:17.{g0:18}}" });
    const stuck = s.unsatisfiableSlots();
    expect(stuck).toHaveLength(1);
    expect(burger.ingName[stuck[0].ing]).toBe("patty-cooked");
  });

  it("says nothing while the ingredient is still somewhere in the chain", () => {
    const s = sim({ queueString: "9", customerString: "0;0;0;{c2:{g1:25}}" }, { instantFlights: false });
    expect(s.unsatisfiableSlots()).toEqual([]);
    s.pick(0);
    s.completeAllFlights();
    // Now mid-chain, cooking at the flour tool — still obtainable.
    expect(s.unsatisfiableSlots()).toEqual([]);
  });
});

describe("pickPolicy: wanted-only", () => {
  it("is OFF by default, so a queue-flow pick still works", () => {
    const s = sim({ queueString: "5,0", customerString: "0;0;0;{c0:17}" });
    // cheese leads only to cheese-sliced, which nobody ordered.
    expect(s.pick(0)).toBe(true);
  });

  it("refuses a pick that cannot reach anything wanted when switched on", () => {
    const s = sim(
      { queueString: "5,0", customerString: "0;0;0;{c0:17}" },
      { pickPolicy: "wanted-only" },
    );
    const check = s.canPick(0);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("Cheese");
    expect(s.pick(0)).toBe(false);
  });
});

describe("legacyToGraph — the parity adapter", () => {
  const legacyLevel = level({
    queueString: "0,1",
    gridString: EMPTY_GRID,
    customerString: "0;0;0.1",
  });
  const doc = legacyToGraph(testMap, [legacyLevel]);

  it("produces a graph with no validation errors", () => {
    expect(validateNodeGraph(doc).errors.map((e) => e.message)).toEqual([]);
  });

  it("merges a tool-less raw and its cooked form into ONE vertex", () => {
    // testMap ingredient 2 has no recipe: raw 2 and cooked 2 are the same thing.
    // Addressed through the adapter's naming scheme rather than a legacy id
    // stamped on the vertex — the shipped format carries no legacy ids.
    expect(pickupName(testMap, 2)).toBe(cookedName(2));
    const merged = doc.vertices.ingredient.find((v) => v.name === cookedName(2))!;
    expect(merged.pickupable).toBe(true);
    expect(buildIndex(doc).lookup.servable.has(merged.name)).toBe(true);
  });

  it("keeps a raw that needs a tool separate from its output", () => {
    expect(pickupName(testMap, 0)).toBe(rawName(0));
    const raw = doc.vertices.ingredient.find((v) => v.name === rawName(0))!;
    const cooked = doc.vertices.ingredient.find((v) => v.name === cookedName(0))!;
    expect(raw.name).not.toBe(cooked.name);
    expect(buildIndex(doc).lookup.servable.has(raw.name)).toBe(false);
    expect(cooked.pickupable).toBeUndefined();
  });

  it("infers a composite from ingredients that appear in the same dish", () => {
    // Legacy has no composites at all; cooked 0 and 1 are only related by
    // having been ordered together.
    const withBoth = doc.vertices.composite.find((c) => {
      const bases = doc.edges.base.find((e) => e.from === c.name);
      return bases?.to.endsWith("-bases");
    });
    expect(withBoth).toBeDefined();
    const options = doc.edges.option.filter((e) => e.from === `${withBoth!.name}-bases`);
    expect(options).toHaveLength(2);
  });

  it("runs the projected level to a win, exactly as the legacy sim does", () => {
    const ix = buildIndex(doc);
    const projected = legacyLevelToNode(doc, legacyLevel);
    expect(projected.unplaced).toEqual([]);
    const s = new NodeSimulation(ix, projected.level);
    expect(s.issues).toEqual([]);
    s.pick(0);
    s.pick(0);
    s.runToEnd();
    expect(s.status).toBe("won");
  });
});
