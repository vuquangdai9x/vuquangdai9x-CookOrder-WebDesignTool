import { describe, expect, it } from "vitest";
import burgerJson from "../data/config/nodegraph/maps/Graph-1-Burger.json";
import sushiJson from "../data/config/nodegraph/maps/Graph-3-Sushi.json";
import type { NodeGraphMap } from "../data/nodeGraphTypes.ts";
import { buildIndex } from "./nodeIndex.ts";
import { parseDish } from "./nodeParser.ts";
import { describeIssue, orderIdIndex, resolveDishes, resolveOrder } from "./nodeOrder.ts";

const doc = burgerJson as unknown as NodeGraphMap;
const ix = buildIndex(doc);
const ids = orderIdIndex(ix);
const resolve = (s: string) => resolveOrder(ix, parseDish(s), ids);
const named = (r: ReturnType<typeof resolve>) =>
  r.order.slots.map((s) => `${ix.ingName[s.ing]}@${s.slot}/gate${s.gate}`);

// Ids from burger.json's table: composites c0-c2,
// groups g0-g2, raws 0-16, processed 100+.
const BURGER = "{c0:17.{g0:18.18.19}}"; // bun + 2 patty + 1 tomato
const SODA = "{c1:24.8}"; // soda cup + ice
const CHICKEN = "{c2:{g1:26}.{g2:14}}"; // fried basket: wing + chili
const FRIES = "{c2:{g1:29}}"; // fried basket: just potato, no sauce
const SAUCY_FRIES = "{c2:{g1:29}.{g2:16}}"; // potato + cheese sauce

describe("resolveOrder — reading the bracket tree", () => {
  it("resolves a burger, keeping quantity as repeated slots", () => {
    const r = resolve(BURGER);
    expect(r.issues).toEqual([]);
    expect(ix.compositeName[r.order.orderable]).toBe("burger");
    expect(named(r)).toEqual([
      "bun-sliced@0/gate-1",
      "patty-cooked@1/gate0",
      "patty-cooked@1/gate0",
      "tomato-sliced@1/gate0",
    ]);
  });

  it("gates every non-base slot on the base slot actually ordered", () => {
    const r = resolve(CHICKEN);
    expect(r.issues).toEqual([]);
    const [base, sauce] = r.order.slots;
    expect(ix.ingName[base.ing]).toBe("chicken-wing-fried");
    expect(base.gate).toBe(-1); // this IS the base
    expect(ix.ingName[sauce.ing]).toBe("chili-bowl");
    expect(sauce.gate).toBe(0); // waits for slot 0, whichever cut was chosen
  });

  it("handles two fixed slots with no group", () => {
    const r = resolve(SODA);
    expect(r.issues).toEqual([]);
    expect(named(r)).toEqual(["soda-cup@0/gate-1", "ice@1/gate0"]);
  });

  it("handles a base-only order, with the topping group left empty", () => {
    const r = resolve(FRIES);
    expect(r.issues).toEqual([]);
    expect(named(r)).toEqual(["potato-fried@0/gate-1"]);
  });

  it("lets potato take a sauce, like any other fried base", () => {
    // The whole point of folding potato into the fried basket: this dish was
    // impossible in the legacy runtime, where cheese sauce required a chicken cut.
    const r = resolve(SAUCY_FRIES);
    expect(r.issues).toEqual([]);
    expect(named(r)).toEqual(["potato-fried@0/gate-1", "cheese-sauce@1/gate0"]);
  });

  it("attaches the composite's dirty object", () => {
    expect(ix.dirtyName[resolve(BURGER).order.dirty]).toBe("dirty-plate");
    expect(ix.dirtyName[resolve(SODA).order.dirty]).toBe("dirty-cup");
    expect(ix.dirtyName[resolve(CHICKEN).order.dirty]).toBe("dirty-chick-box");
    expect(ix.dirtyName[resolve(FRIES).order.dirty]).toBe("dirty-chick-box");
  });
});

describe("INV-DISH-SINGLE-ORDERABLE at dish level", () => {
  it("rejects a member belonging to a different composite", () => {
    const r = resolve("{c0:17.24}"); // a soda cup inside a burger
    expect(r.issues).toHaveLength(1);
    expect(describeIssue(r.issues[0])).toBe('"soda-cup" belongs to soda, but appears inside burger.');
    // The rest of the order still resolves — one bad member is not fatal.
    expect(named(r)).toEqual(["bun-sliced@0/gate-1"]);
  });

  it("rejects a group that is not part of this composite", () => {
    const r = resolve("{c0:17.{g2:14}}"); // fried-chicken's sauce group inside a burger
    const kinds = r.issues.map((i) => i.kind);
    expect(kinds).toContain("wrong-group");
    expect(r.issues.map(describeIssue).join(" ")).toContain("fried-basket-sauces");
  });
});

describe("total on bad ids", () => {
  it("reports an unknown composite and returns an unresolved order", () => {
    const r = resolve("{c99:17}");
    expect(r.order.orderable).toBe(-1);
    expect(r.order.slots).toEqual([]);
    expect(describeIssue(r.issues[0])).toBe("No composite has id 99.");
  });

  it("reports an unknown ingredient but keeps the rest of the dish", () => {
    const r = resolve("{c0:17.{g0:999}}");
    expect(describeIssue(r.issues[0])).toBe("No ingredient has id 999.");
    expect(named(r)).toEqual(["bun-sliced@0/gate-1"]);
  });

  it("reports an id past the end of the table as simply unknown", () => {
    // There are no tombstones: a deleted node's row is removed outright, so a
    // level string still carrying its id now names whatever slid into that
    // slot — or, past the end, nothing at all. "Unknown" is the whole story.
    const beyond = doc.idTable.ingredient.length;
    const r = resolve(`{c0:17.{g0:${beyond}}}`);
    expect(describeIssue(r.issues[0])).toBe(`No ingredient has id ${beyond}.`);
  });

  it("never throws on a structurally valid but semantically wrong dish", () => {
    expect(() => resolve("{c1:17.18.19}")).not.toThrow();
  });
});

describe("limitPerDish", () => {
  it("flags exceeding a per-dish limit", () => {
    // bun-sliced has limitPerDish 1.
    const r = resolve("{c0:17.17}");
    const issue = r.issues.find((i) => i.kind === "over-limit");
    expect(issue).toBeDefined();
    expect(describeIssue(issue!)).toBe('"bun-sliced" appears 2 times but is limited to 1 per dish.');
  });

  it("allows unlimited repetition where limitPerDish is 0", () => {
    const r = resolve("{c0:17.{g0:18.18.18.18}}");
    expect(r.issues).toEqual([]);
    expect(r.order.slots).toHaveLength(5);
  });
});

describe("group minQuantity", () => {
  const withMinimum = (): { ix: ReturnType<typeof buildIndex>; ids: ReturnType<typeof orderIdIndex> } => {
    const clone = structuredClone(doc);
    const group = clone.vertices.group.find((value) => value.name === "burger-toppings")!;
    group.minQuantity = 2;
    const next = buildIndex(clone);
    return { ix: next, ids: orderIdIndex(next) };
  };

  it("flags an omitted or under-filled group", () => {
    const next = withMinimum();
    for (const text of ["{c0:17}", "{c0:17.{g0:18}}"] ) {
      const result = resolveOrder(next.ix, parseDish(text), next.ids);
      expect(result.issues.map((issue) => issue.kind)).toContain("below-group-minimum");
    }
  });

  it("accepts a group that reaches its minimum", () => {
    const next = withMinimum();
    const result = resolveOrder(next.ix, parseDish("{c0:17.{g0:18.19}}"), next.ids);
    expect(result.issues).toEqual([]);
  });
});

describe("nested group quantity", () => {
  const sushi = sushiJson as unknown as NodeGraphMap;
  const sushiIx = buildIndex(sushi);
  const sushiIds = orderIdIndex(sushiIx);
  const id = (space: "ingredient" | "composite" | "group", name: string): number => sushiIds.byNode[space].get(name)!;
  const composite = id("composite", "gunkan-with-topping");
  const outer = id("group", "gunkan-top");
  const roe = id("group", "single-fish-roe");
  const roeItem = id("ingredient", "fish-roe-orange");
  const other = id("ingredient", "wakame-seasame");

  it("counts a nested group as one item of its parent maximum", () => {
    const text = `{c${composite}:{g${outer}:{g${roe}:${roeItem}}.${other}}}`;
    const result = resolveOrder(sushiIx, parseDish(text), sushiIds);
    expect(result.issues.map((issue) => issue.kind)).toContain("above-group-maximum");
    expect(result.issues.map(describeIssue).join(" ")).toContain("gunkan-top");
  });

  it("requires the inner roe group to stay inside gunkan-top", () => {
    const text = `{c${composite}:{g${roe}:${roeItem}}.{g${outer}:${other}}}`;
    const result = resolveOrder(sushiIx, parseDish(text), sushiIds);
    expect(result.issues.map((issue) => issue.kind)).toContain("misnested-group");
  });

  it("accepts either the nested roe choice or another gunkan topping", () => {
    for (const member of [`{g${roe}:${roeItem}}`, String(other)]) {
      const result = resolveOrder(sushiIx, parseDish(`{c${composite}:{g${outer}:${member}}}`), sushiIds);
      expect(result.issues).toEqual([]);
    }
  });
});

describe("resolveDishes", () => {
  it("resolves a customer's dishes and tags issues with their dish index", () => {
    const { orders, issues } = resolveDishes(ix, [parseDish(BURGER), parseDish("{c1:17}")], ids);
    expect(orders).toHaveLength(2);
    expect(ix.compositeName[orders[0].orderable]).toBe("burger");
    expect(issues).toHaveLength(1);
    expect(issues[0].dish).toBe(1);
    expect(describeIssue(issues[0].issue)).toContain("bun-sliced");
  });
});
