import { describe, expect, it } from "vitest";
import burgerJson from "./config/nodegraph/burger.json";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";
import { buildLookup, chainOf, depthOf, slotIndex, slotsOf, traceAll, traceOrderable } from "./nodeGraphResolve.ts";
import { chainedPotato } from "../core/nodeTestFixtures.ts";

const burger = burgerJson as unknown as NodeGraphMap;
const lk = buildLookup(burger);
const byName = (name: string) => traceAll(burger).find((t) => t.orderable === name)!;

describe("slot tree", () => {
  it("flattens each orderable into its choice points", () => {
    expect(slotsOf(lk, "burger").map((s) => [s.kind, s.group, s.isBase])).toEqual([
      ["fixed", null, true],
      ["group", "burger-toppings", false],
    ]);
    expect(slotsOf(lk, "fried-basket").map((s) => [s.kind, s.group, s.isBase, s.maxQuantity])).toEqual([
      // "exactly one" is now a cap of 1 rather than a SINGLE kind.
      ["group", "fried-basket-bases", true, 1],
      ["group", "fried-basket-sauces", false, -1],
    ]);
  });

  it("treats a direct ingredient topping as a fixed slot, not a group", () => {
    // soda's topping is `ice`, an ingredient rather than a group.
    const slots = slotsOf(lk, "soda");
    expect(slots).toHaveLength(2);
    expect(slots[1]).toMatchObject({ kind: "fixed", group: null, options: ["ice"], isBase: false });
  });

  it("marks exactly one slot as the base, however the composite is shaped", () => {
    for (const orderable of lk.orderables) {
      const bases = slotsOf(lk, orderable).filter((s) => s.isBase);
      expect(bases, `${orderable} should have exactly one base slot`).toHaveLength(1);
    }
  });
});

describe("traceOrderable — burger.json expectations", () => {
  it("finds exactly the three orderables", () => {
    expect(traceAll(burger).map((t) => t.orderable).sort()).toEqual(["burger", "fried-basket", "soda"]);
  });

  it("reports the expected leaf counts", () => {
    expect(byName("burger").leaves).toHaveLength(7);
    expect(byName("soda").leaves).toHaveLength(2);
    // 4 chicken cuts + potato + 3 sauces, minus chive/cheese-sauce overlap:
    // breast, wing, thigh, nugget, potato, chili-bowl, chive, cheese-sauce.
    expect(byName("fried-basket").leaves).toHaveLength(8);
  });

  it("every orderable traces to pickupables with nothing unreachable", () => {
    for (const trace of traceAll(burger)) expect(trace.unreachable, trace.orderable).toEqual([]);
  });

  it("fried-basket is depth 2 — the only two-tool route with a real intermediate", () => {
    expect(byName("burger").maxDepth).toBe(1);
    expect(byName("soda").maxDepth).toBe(1);
    expect(byName("fried-basket").maxDepth).toBe(2);
  });

  it("reports unbounded variants only where a group is uncapped", () => {
    expect(byName("burger").variantCount).toBeNull();
    expect(byName("fried-basket").variantCount).toBeNull();
    expect(byName("soda").variantCount).toBe(2); // with or without ice
  });

  it("offers potato alongside the chicken cuts, so every sauce applies to it", () => {
    const bases = slotsOf(lk, "fried-basket")[0];
    expect(bases.options).toContain("potato-fried");
    expect(bases.options).toHaveLength(5);
  });
});

describe("the two spellings of a two-tool route", () => {
  it("potato is ONE step with chainTools — no intermediate item", () => {
    // Derived from whatever burger.json says today, so re-authoring the route in
    // the editor cannot break a test about the chainTools spelling.
    const collapsed = buildLookup(chainedPotato(burger));
    const chain = chainOf(collapsed, "potato-fried");
    expect(chain).toMatchObject({ node: "potato-fried", tool: "cutting-board", chainTools: ["fryer"] });
    expect(chain.inputs).toHaveLength(1);
    expect(chain.inputs[0]).toEqual({ node: "potato", inputs: [] }); // pickupable, terminates
    expect(depthOf(collapsed, "potato-fried")).toBe(1);
  });

  it("chicken is TWO steps through a real coated intermediate", () => {
    const chain = chainOf(lk, "chicken-breast-fried");
    expect(chain).toMatchObject({ node: "chicken-breast-fried", tool: "fryer", amount: 1 });
    expect(chain.chainTools).toBeUndefined();

    const coated = chain.inputs[0];
    expect(coated).toMatchObject({ node: "chicken-breast-flour-coated", tool: "flour", amount: 1 });

    expect(coated.inputs[0]).toEqual({ node: "chicken-breast", inputs: [] });
    expect(depthOf(lk, "chicken-breast-fried")).toBe(2);
  });

  it("a pickupable terminates immediately", () => {
    expect(chainOf(lk, "bun")).toEqual({ node: "bun", inputs: [] });
    expect(depthOf(lk, "bun")).toBe(0);
  });
});

describe("slotIndex — where each ingredient may sit", () => {
  it("places every servable ingredient, with none ambiguous WITHIN a composite", () => {
    const { slotOf, ambiguousWithinComposite } = slotIndex(lk);
    // Two slots of ONE composite is the dangerous case and burger has none.
    // Sharing across two DIFFERENT composites is allowed and not counted here.
    expect(ambiguousWithinComposite.size).toBe(0);
    const servable = burger.vertices.ingredient.filter((i) => i.servable);
    expect(servable.length).toBe(17);
    for (const ing of servable) {
      expect(slotOf.get(ing.name), `${ing.name} has no slot`).toBeDefined();
    }
  });

  it("lists EVERY place a shared ingredient may sit, not just the first", () => {
    // The property that replaced the old C2 ban: an ingredient offered by two
    // orderables is legal, and callers that need the whole picture (the
    // base-slot hint, the foreign-member message) read `placesOf`.
    const shared = structuredClone(burger);
    shared.edges.option.push({ from: "burger-toppings", to: "ice", maxQuantity: -1 });
    const { placesOf, ambiguousWithinComposite } = slotIndex(buildLookup(shared));
    expect(placesOf.get("ice")!.map((p) => p.orderable).sort()).toEqual(["burger", "soda"]);
    expect(ambiguousWithinComposite.has("ice")).toBe(false);
  });

  it("places each ingredient in the orderable that actually offers it", () => {
    const { slotOf } = slotIndex(lk);
    expect(slotOf.get("bun-sliced")).toEqual({ orderable: "burger", slot: 0 });
    expect(slotOf.get("patty-cooked")).toEqual({ orderable: "burger", slot: 1 });
    expect(slotOf.get("ice")).toEqual({ orderable: "soda", slot: 1 });
    expect(slotOf.get("chicken-wing-fried")).toEqual({ orderable: "fried-basket", slot: 0 });
    expect(slotOf.get("chili-bowl")).toEqual({ orderable: "fried-basket", slot: 1 });
  });
});

describe("nesting is not the hazard", () => {
  /** A -> B -> C -> ingredient, three composites deep. */
  const nested = (): NodeGraphMap => ({
    schemaVersion: 1,
    map: { id: "t", name: "T", gridWidth: 2, gridHeight: 2, dirtyStackHeight: 3, visibleRows: 3 },
    idTable: { ingredient: [], composite: [], group: [], tool: [], dirty: [] },
    vertices: {
      ingredient: [
        { name: "leaf", displayName: "Leaf", pickupable: true, servable: true },
        { name: "mid", displayName: "Mid", servable: true },
        { name: "top", displayName: "Top", pickupable: true, servable: true },
      ],
      tool: [{ name: "t1", displayName: "T1", numSlots: 1, cookingTime: 1 }],
      group: [],
      composite: [
        { name: "outer", displayName: "Outer", orderable: true },
        { name: "middle", displayName: "Middle" },
        { name: "inner", displayName: "Inner" },
      ],
      dirty: [],
    },
    edges: {
      process: [{ from: "t1", to: "mid", inputs: ["leaf"], amount: 1 }],
      base: [
        { from: "outer", to: "middle" },
        { from: "middle", to: "inner" },
        { from: "inner", to: "mid" },
      ],
      topping: [{ from: "outer", to: "top" }],
      option: [],
      leavesDirty: [],
    },
  });

  it("flattens a depth-3 composite chain into a flat slot list", () => {
    const deep = buildLookup(nested());
    const slots = slotsOf(deep, "outer");
    expect(slots.map((s) => s.options[0])).toEqual(["mid", "top"]);
    // The base marker survives three levels of nesting.
    expect(slots[0].isBase).toBe(true);
    expect(slots[1].isBase).toBe(false);
  });

  it("still traces to pickupables through that nesting", () => {
    const deep = buildLookup(nested());
    const trace = traceOrderable(deep, "outer");
    expect(trace.unreachable).toEqual([]);
    expect(trace.leaves).toEqual(["leaf", "top"]);
    expect(trace.maxDepth).toBe(1);
  });
});

describe("total on malformed data", () => {
  it("returns instead of recursing forever on a cyclic base chain", () => {
    const cyclic: NodeGraphMap = {
      schemaVersion: 1,
      map: { id: "t", name: "T", gridWidth: 2, gridHeight: 2, dirtyStackHeight: 3, visibleRows: 3 },
      idTable: { ingredient: [], composite: [], group: [], tool: [], dirty: [] },
      vertices: {
        ingredient: [],
        tool: [],
        group: [],
        composite: [
          { name: "a", displayName: "A", orderable: true },
          { name: "b", displayName: "B" },
        ],
        dirty: [],
      },
      edges: {
        process: [],
        base: [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
        topping: [],
        option: [],
        leavesDirty: [],
      },
    };
    const cyc = buildLookup(cyclic);
    expect(() => slotsOf(cyc, "a")).not.toThrow();
    expect(() => traceOrderable(cyc, "a")).not.toThrow();
  });

  it("reports an ingredient nothing produces as unreachable rather than throwing", () => {
    const orphaned = structuredClone(burger);
    orphaned.edges.process = orphaned.edges.process.filter((e) => e.to !== "bun-sliced");
    const trace = traceOrderable(buildLookup(orphaned), "burger");
    expect(trace.unreachable).toContain("bun-sliced");
  });
});
