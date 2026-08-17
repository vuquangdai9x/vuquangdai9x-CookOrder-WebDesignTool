import { describe, expect, it } from "vitest";
import burgerJson from "../data/config/nodegraph/maps/Graph-1-Burger.json";
import type { NodeGraphMap } from "../data/nodeGraphTypes.ts";
import { buildIndex, reaches, reachesAny } from "./nodeIndex.ts";
import { chainedPotato } from "./nodeTestFixtures.ts";

const ix = buildIndex(burgerJson as unknown as NodeGraphMap);
const ing = (name: string): number => {
  const i = ix.ingByName.get(name);
  if (i === undefined) throw new Error(`no ingredient "${name}"`);
  return i;
};
const nameOf = (i: number) => ix.ingName[i];

describe("interning", () => {
  it("covers every vertex kind", () => {
    // Counts come from the document. Hard-coding them made this a test of the
    // designer's current data rather than of interning.
    const doc = burgerJson as unknown as NodeGraphMap;
    expect(ix.ingName).toHaveLength(doc.vertices.ingredient.length);
    expect(ix.toolName).toHaveLength(doc.vertices.tool.length);
    expect(ix.groupName).toHaveLength(doc.vertices.group.length);
    expect(ix.compositeName).toHaveLength(doc.vertices.composite.length);
    expect(ix.dirtyName).toHaveLength(doc.vertices.dirty.length);
    for (const kind of ["ingredient", "tool", "group", "composite", "dirty"] as const) {
      expect(doc.vertices[kind].length, `no ${kind} vertices`).toBeGreaterThan(0);
    }
  });

  it("round-trips name <-> dense index", () => {
    for (let i = 0; i < ix.ingName.length; i++) expect(ing(nameOf(i))).toBe(i);
  });
});

describe("terminalOutput / terminalYield / chainDepth", () => {
  it("resolves a one-step recipe to its output", () => {
    expect(nameOf(ix.terminalOutput[ing("bun")])).toBe("bun-sliced");
    expect(ix.terminalYield[ing("bun")]).toBe(1);
    expect(ix.chainDepth[ing("bun")]).toBe(1);
  });

  it("carries the real yield, not 1 — a chopping board drops several pieces", () => {
    expect(ix.terminalYield[ing("tomato")]).toBe(2);
    // cheese yields 3 in cooking-tools.json, disagreeing with numSlices 2;
    // `amount` is authoritative because that is what the sim reads.
    expect(ix.terminalYield[ing("cheese")]).toBe(3);
  });

  it("follows the chicken chain THROUGH the coated intermediate to the fried output", () => {
    // The single most important property in the index. One hop would stop at
    // chicken-breast-flour-coated, which no dish wants — the estimator would
    // then score chicken at 0 and never pick it.
    expect(nameOf(ix.terminalOutput[ing("chicken-breast")])).toBe("chicken-breast-fried");
    expect(ix.chainDepth[ing("chicken-breast")]).toBe(2);
    expect(ix.terminalYield[ing("chicken-breast")]).toBe(1);
    for (const cut of ["wing", "thigh", "nugget"]) {
      expect(nameOf(ix.terminalOutput[ing(`chicken-${cut}`)])).toBe(`chicken-${cut}-fried`);
      expect(ix.chainDepth[ing(`chicken-${cut}`)]).toBe(2);
    }
  });

  it("treats a chainTools route as ONE step — nothing lands mid-chain", () => {
    // Derived, not assumed: burger.json may spell potato either way, and this
    // test is about the chainTools spelling itself. See nodeTestFixtures.ts.
    const cx = buildIndex(chainedPotato(burgerJson as unknown as NodeGraphMap));
    const potato = cx.ingByName.get("potato")!;
    expect(cx.ingName[cx.terminalOutput[potato]]).toBe("potato-fried");
    expect(cx.chainDepth[potato]).toBe(1);
    // Two tools, but one step: no intermediate vertex exists to land on.
    expect(cx.ingByName.has("potato_sliced")).toBe(false);
  });

  it("multiplies yield along a collapsed chain", () => {
    // Collapsing two edges into chainTools must not change what a potato is
    // worth — that is the whole claim `terminalYield` makes.
    const cx = buildIndex(chainedPotato(burgerJson as unknown as NodeGraphMap));
    expect(cx.terminalYield[cx.ingByName.get("potato")!]).toBe(ix.terminalYield[ing("potato")]);
  });

  it("leaves a pickupable-and-servable ingredient as its own terminal", () => {
    for (const name of ["ice", "chili-bowl", "cheese-sauce"]) {
      expect(nameOf(ix.terminalOutput[ing(name)])).toBe(name);
      expect(ix.chainDepth[ing(name)]).toBe(0);
      expect(ix.terminalYield[ing(name)]).toBe(1);
    }
  });

  it("stops at a servable output rather than running past it", () => {
    expect(nameOf(ix.terminalOutput[ing("bun-sliced")])).toBe("bun-sliced");
    expect(ix.chainDepth[ing("bun-sliced")]).toBe(0);
  });
});

describe("producerOf / recipeForInput", () => {
  it("gives a pickupable no producer and a produced ingredient exactly one", () => {
    expect(ix.producerOf[ing("bun")]).toBeNull();
    const step = ix.producerOf[ing("bun-sliced")]!;
    expect(ix.toolName[step.tool]).toBe("cutting-board");
    expect(step.inputs.map((i) => nameOf(i.ing))).toEqual(["bun"]);
  });

  it("folds the tool's cookingTime into each step's duration", () => {
    // No burger recipe overrides duration, so each step inherits its tool's.
    expect(ix.producerOf[ing("patty-cooked")]!.duration).toBe(3); // griddle
    expect(ix.producerOf[ing("bun-sliced")]!.duration).toBe(1); // cutting-board
    expect(ix.producerOf[ing("soda-cup")]!.duration).toBe(2); // coca-machine
  });

  it("keeps chainTools on the step that owns them", () => {
    const cx = buildIndex(chainedPotato(burgerJson as unknown as NodeGraphMap));
    const potato = cx.producerOf[cx.ingByName.get("potato-fried")!]!;
    expect(potato.chainTools.map((t) => cx.toolName[t])).toEqual(["fryer"]);
    // The chicken route uses two real edges instead, so neither carries chainTools.
    expect(ix.producerOf[ing("chicken-breast-fried")]!.chainTools).toEqual([]);
    expect(ix.producerOf[ing("chicken-breast-flour-coated")]!.chainTools).toEqual([]);
  });

  it("points recipeForInput at what a pickup goes into", () => {
    expect(ix.toolName[ix.recipeForInput[ing("chicken-breast")]!.tool]).toBe("flour");
    expect(ix.toolName[ix.recipeForInput[ing("chicken-breast-flour-coated")]!.tool]).toBe("fryer");
    expect(ix.recipeForInput[ing("ice")]).toBeNull();
  });
});

describe("reachability", () => {
  it("includes the ingredient itself", () => {
    expect(reaches(ix, ing("bun"), ing("bun"))).toBe(true);
  });

  it("reaches forward across the whole chicken chain", () => {
    expect(reaches(ix, ing("chicken-breast"), ing("chicken-breast-flour-coated"))).toBe(true);
    expect(reaches(ix, ing("chicken-breast"), ing("chicken-breast-fried"))).toBe(true);
  });

  it("does not reach sideways or backwards", () => {
    expect(reaches(ix, ing("chicken-breast"), ing("chicken-wing-fried"))).toBe(false);
    expect(reaches(ix, ing("bun-sliced"), ing("bun"))).toBe(false);
  });

  it("reachesAny answers 'is this pick wanted' against a demand set", () => {
    const demand = new Uint8Array(Math.ceil(ix.ingName.length / 8));
    const want = ing("chicken-thigh-fried");
    demand[want >> 3] |= 1 << (want & 7);
    // A raw thigh leads there through two tools; a bun never does.
    expect(reachesAny(ix, ing("chicken-thigh"), demand)).toBe(true);
    expect(reachesAny(ix, ing("bun"), demand)).toBe(false);
  });
});

describe("assembly", () => {
  it("indexes the slot tree of every orderable", () => {
    const burger = ix.compositeByName.get("burger")!;
    const slots = ix.slotsOfComposite[burger];
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({ kind: "fixed", isBase: true });
    expect(slots[0].options.map(nameOf)).toEqual(["bun-sliced"]);
    expect(slots[1]).toMatchObject({ kind: "group", isBase: false });
    expect(slots[1].options).toHaveLength(6);
  });

  it("maps each servable ingredient to its one slot", () => {
    const burger = ix.compositeByName.get("burger")!;
    expect(ix.slotOf[ing("bun-sliced")]).toEqual({ orderable: burger, slot: 0 });
    expect(ix.slotOf[ing("patty-cooked")]).toEqual({ orderable: burger, slot: 1 });
  });

  it("links each composite to its dirty object, or -1 for the generic dish", () => {
    const dirtyFor = (name: string) => {
      const d = ix.dirtyOf[ix.compositeByName.get(name)!];
      return d === -1 ? null : ix.dirtyName[d];
    };
    expect(dirtyFor("burger")).toBe("dirty-plate");
    expect(dirtyFor("soda")).toBe("dirty-cup");
    // Potato now rides in the fried basket, so a fries order leaves a chick
    // box where the runtime left nothing — a known consequence of that merge.
    expect(dirtyFor("fried-basket")).toBe("dirty-chick-box");
  });

  it("lists exactly the orderable composites", () => {
    expect(ix.orderables.map((c) => ix.compositeName[c]).sort()).toEqual([
      "burger",
      "fried-basket",
      "soda",
    ]);
  });
});

describe("per-ingredient scalars", () => {
  it("hoists usageNum out of a linear scan", () => {
    expect(ix.usageNum[ing("chili-bowl")]).toBe(2);
    expect(ix.usageNum[ing("cheese-sauce")]).toBe(3);
    expect(ix.usageNum[ing("patty-cooked")]).toBe(1);
  });

  it("hoists servable and pickupable", () => {
    expect(ix.servable[ing("bun-sliced")]).toBe(1);
    expect(ix.servable[ing("bun")]).toBe(0);
    expect(ix.pickupable[ing("bun")]).toBe(1);
    expect(ix.pickupable[ing("bun-sliced")]).toBe(0);
    // A coated intermediate is neither — it only ever sits between two tools.
    expect(ix.servable[ing("chicken-breast-flour-coated")]).toBe(0);
    expect(ix.pickupable[ing("chicken-breast-flour-coated")]).toBe(0);
  });
});
