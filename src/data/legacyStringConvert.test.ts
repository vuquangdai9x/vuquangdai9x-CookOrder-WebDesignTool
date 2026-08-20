import { describe, expect, it } from "vitest";
import graphJson from "./config/nodegraph/maps/Graph-1-Burger.json";
import { parseNodeCustomers } from "../core/nodeParser.ts";
import { parseQueues } from "../core/parser.ts";
import { MAP1_DATA } from "./configLoader.ts";
import { toMapDef } from "./mapLoader.ts";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";
import {
  convertLegacyCustomerString,
  convertLegacyIngredientQueueString,
} from "./legacyStringConvert.ts";

const legacyMap = toMapDef(MAP1_DATA);
const graph = graphJson as NodeGraphMap;

describe("legacy string conversion uses the graph's current positional ids", () => {
  it("remaps queue ids after ingredient id-table rows are edited", () => {
    const edited = structuredClone(graph);
    [edited.idTable.ingredient[0], edited.idTable.ingredient[1]] = [
      edited.idTable.ingredient[1],
      edited.idTable.ingredient[0],
    ];

    const converted = convertLegacyIngredientQueueString("0,1%1#2", legacyMap, edited);
    expect(converted).toBe("1,0%0#2");
    expect(() => parseQueues(converted)).not.toThrow();
  });

  it("remaps cooked ids and rebuilds bracketed dishes after id edits", () => {
    const edited = structuredClone(graph);
    [edited.idTable.ingredient[17], edited.idTable.ingredient[18]] = [
      edited.idTable.ingredient[18],
      edited.idTable.ingredient[17],
    ];

    const converted = convertLegacyCustomerString("0;0;0;0.1", legacyMap, edited);
    expect(converted).toBe("0;0;0;{c0:18.{g0:17}}");
    expect(() => parseNodeCustomers(converted)).not.toThrow();
  });

  it("refuses to convert into a different active map", () => {
    const coffee = structuredClone(graph);
    coffee.map.name = "Coffee";
    expect(() => convertLegacyIngredientQueueString("0", legacyMap, coffee)).toThrow(
      /Open the matching graph first/,
    );
  });
});
