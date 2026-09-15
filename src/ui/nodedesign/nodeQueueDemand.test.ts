import { describe, expect, it } from "vitest";

import { buildIndex } from "../../core/nodeIndex.ts";
import { parseNodeCustomers } from "../../core/nodeParser.ts";
import coffeeJson from "../../data/config/nodegraph/maps/Graph-2-Coffee.json";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import { orderIdIndex } from "../../core/nodeOrder.ts";
import { generateNodeQueueLanes, nodeDemandByRaw } from "./nodeQueueGenerate.ts";

describe("node Recipe Pieces demand", () => {
  it("counts every input of Map 2's coffee machine process", () => {
    const ix = buildIndex(coffeeJson as NodeGraphMap);
    const ids = orderIdIndex(ix);
    // Composite 0 is cool-coffee-with-milk; ingredient 23 is its
    // coffee-cup-cool base. Producing it consumes ground coffee + cup, and
    // producing the ground coffee consumes a coffee bean.
    const customers = parseNodeCustomers("0;0;0;{c0:23}");
    const demand = nodeDemandByRaw(ix, ids, customers);
    const bean = ids.byNode.ingredient.get("coffee-bean")!;
    const cup = ids.byNode.ingredient.get("cup")!;

    expect(demand.get(bean)).toMatchObject({ need: 1 });
    expect(demand.get(cup)).toMatchObject({ need: 1 });
    expect([...demand.keys()].sort((a, b) => a - b)).toEqual([bean, cup].sort((a, b) => a - b));
  });

  it("accumulates both inputs for repeated coffee orders", () => {
    const ix = buildIndex(coffeeJson as NodeGraphMap);
    const ids = orderIdIndex(ix);
    const customers = parseNodeCustomers("0;0;0;{c0:23},{c0:23}");
    const demand = nodeDemandByRaw(ix, ids, customers);

    expect(demand.get(ids.byNode.ingredient.get("coffee-bean")!)?.need).toBe(2);
    expect(demand.get(ids.byNode.ingredient.get("cup")!)?.need).toBe(2);
  });
});

describe("amount-aware node queue generation", () => {
  it("carries a spawned slot's leftover pieces into later dishes", () => {
    const ix = buildIndex(coffeeJson as NodeGraphMap);
    const ids = orderIdIndex(ix);
    const customers = parseNodeCustomers("0;0;0;{c0:23}|0;0;0;{c0:23}");
    const lanes = generateNodeQueueLanes({
      ix,
      ids,
      customers,
      laneCount: 1,
      shuffleRange: { kind: "fixed", value: 0 },
      bagFill: "max",
      random: () => 0.5,
    });
    const bean = ids.byNode.ingredient.get("coffee-bean")!;
    const cup = ids.byNode.ingredient.get("cup")!;

    expect(lanes[0]).toEqual([
      { id: bean, amount: 2 },
      { id: cup, amount: 2 },
    ]);
  });

  it("uses an enabled ordered-ingredient range instead of the graph defaults", () => {
    const ix = buildIndex(coffeeJson as NodeGraphMap);
    const ids = orderIdIndex(ix);
    const customers = parseNodeCustomers("0;0;0;{c0:23}|0;0;0;{c0:23}");
    const ordered = ix.ingByName.get(ids.byId.ingredient.get(23) ?? "");
    expect(ordered).toBeDefined();
    const lanes = generateNodeQueueLanes({
      ix,
      ids,
      customers,
      laneCount: 1,
      shuffleRange: { kind: "fixed", value: 0 },
      bagFill: "max",
      amountRanges: new Map([[ordered!, { min: 1, max: 1 }]]),
      random: () => 0.5,
    });
    const bean = ids.byNode.ingredient.get("coffee-bean")!;
    const cup = ids.byNode.ingredient.get("cup")!;

    expect(lanes[0]).toEqual([
      { id: bean, amount: 1 },
      { id: cup, amount: 1 },
      { id: bean, amount: 1 },
      { id: cup, amount: 1 },
    ]);
  });
});
