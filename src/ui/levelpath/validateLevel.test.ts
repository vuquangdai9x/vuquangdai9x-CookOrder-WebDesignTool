import { describe, expect, it } from "vitest";
import burgerJson from "../../data/config/nodegraph/maps/Graph-1-Burger.json";
import { buildIndex } from "../../core/nodeIndex.ts";
import { parseQueues } from "../../core/parser.ts";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import { bagsOutsideStackRange } from "./validateLevel.ts";

describe("bagsOutsideStackRange", () => {
  it("flags bags outside the ingredient's stackMin..stackMax and ignores plain slots", () => {
    const doc = structuredClone(burgerJson) as unknown as NodeGraphMap;
    const patty = doc.vertices.ingredient.find((v) => v.name === "patty")!;
    patty.stackMin = 2;
    patty.stackMax = 3;
    const bun = doc.vertices.ingredient.find((v) => v.name === "bun")!;
    bun.stackMin = 1;
    bun.stackMax = 1;
    const ix = buildIndex(doc);
    // id 1 = patty (range 2-3), id 0 = bun (range 1-1)
    const flagged = bagsOutsideStackRange(parseQueues("1:3,1:5,1,0:2%0"), ix);
    expect(flagged.map((f) => `${f.name} ${f.amount} ${f.min}-${f.max}`)).toEqual([
      "Patty 5 2-3",
      "Bun 2 1-1",
    ]);
  });
});
