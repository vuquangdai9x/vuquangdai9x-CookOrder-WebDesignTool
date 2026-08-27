import { describe, expect, it } from "vitest";
import burgerJson from "../../data/config/nodegraph/maps/Graph-1-Burger.json";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import { buildIndex } from "../../core/nodeIndex.ts";
import { recipeGuideRows } from "./recipeGuide.ts";

const ix = buildIndex(burgerJson as unknown as NodeGraphMap);

describe("recipeGuideRows", () => {
  it("maps pickupable ingredients to their reachable serveable outputs", () => {
    const rows = recipeGuideRows(ix);
    expect(rows).toContainEqual({
      input: ix.ingByName.get("patty"),
      output: ix.ingByName.get("patty-cooked"),
    });
    expect(rows).toContainEqual({
      input: ix.ingByName.get("bun"),
      output: ix.ingByName.get("bun-sliced"),
    });
    expect(rows.every((row) => ix.pickupable[row.input] && ix.servable[row.output])).toBe(true);
  });

  it("does not emit duplicate input/output pairs", () => {
    const rows = recipeGuideRows(ix);
    expect(new Set(rows.map((row) => `${row.input}:${row.output}`)).size).toBe(rows.length);
  });
});
