import { describe, expect, it } from "vitest";

import { buildIndex } from "../../core/nodeIndex.ts";
import { parseNodeCustomers } from "../../core/nodeParser.ts";
import coffeeJson from "../../data/config/nodegraph/maps/Graph-2-Coffee.json";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import { orderIdIndex } from "../../core/nodeOrder.ts";
import { nodeDemandByRaw } from "./nodeQueueGenerate.ts";

describe("node Recipe Pieces demand", () => {
  it("counts every input of Map 2's coffee machine process", () => {
    const ix = buildIndex(coffeeJson as NodeGraphMap);
    const ids = orderIdIndex(ix);
    // Composite 0 is cool-coffee-with-milk; ingredient 23 is its
    // coffee-cup-cool base. Producing it consumes ground coffee + cup, and
    // producing the ground coffee consumes a coffee bean.
    const customers = parseNodeCustomers("0;0;0;{c0:23}");
    const demand = nodeDemandByRaw(ix, ids, customers);

    expect(demand.get(0)).toMatchObject({ need: 1 }); // coffee-bean
    expect(demand.get(1)).toMatchObject({ need: 1 }); // cup
    expect([...demand.keys()].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it("accumulates both inputs for repeated coffee orders", () => {
    const ix = buildIndex(coffeeJson as NodeGraphMap);
    const ids = orderIdIndex(ix);
    const customers = parseNodeCustomers("0;0;0;{c0:23},{c0:23}");
    const demand = nodeDemandByRaw(ix, ids, customers);

    expect(demand.get(0)?.need).toBe(2);
    expect(demand.get(1)?.need).toBe(2);
  });
});
