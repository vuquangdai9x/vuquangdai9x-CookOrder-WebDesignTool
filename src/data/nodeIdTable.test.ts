import { describe, expect, it } from "vitest";
import burgerJson from "./config/nodegraph/maps/Graph-1-Burger.json";
import type { IdTable, NodeGraphMap } from "./nodeGraphTypes.ts";
import { buildLookup } from "./nodeGraphResolve.ts";
import {
  buildIdIndex,
  createIdTable,
  ID_SPACES,
  idOf,
  mintId,
  nextId,
  nodeOf,
  normalizeIdTable,
  removeId,
  renameNode,
  reorderIdEntry,
  validateIdTable,
} from "./nodeIdTable.ts";

const burger = burgerJson as unknown as NodeGraphMap;

describe("id table — round trip", () => {
  it("resolves every burger.json entry in both directions, by POSITION", () => {
    const ix = buildIdIndex(burger.idTable);
    for (const space of ID_SPACES) {
      burger.idTable[space].forEach((node, id) => {
        expect(nodeOf(ix, space, id)).toBe(node);
        expect(idOf(ix, space, node)).toBe(id);
      });
    }
  });

  it("covers every vertex level data can NAME — nothing addressable is unreachable", () => {
    // The rule is not "every vertex has an id". A non-servable, non-pickupable
    // intermediate is never written into a queue or a customer string, so an id
    // for it would be an id nothing can use. The rule is that everything level
    // data CAN name is nameable. WARN-UNTABLED-NODE says the same at load.
    const ix = buildIdIndex(burger.idTable);
    const lookup = buildLookup(burger);
    for (const vertex of burger.vertices.ingredient) {
      if (!lookup.servable.has(vertex.name) && !vertex.pickupable) continue;
      expect(idOf(ix, "ingredient", vertex.name), `ingredient "${vertex.name}" has no id`).not.toBeNull();
    }
    for (const vertex of burger.vertices.composite) {
      if (!vertex.orderable) continue; // only an orderable composite can be named by `{cN:`
      expect(idOf(ix, "composite", vertex.name), `composite "${vertex.name}" has no id`).not.toBeNull();
    }
    for (const space of ["group", "tool", "dirty"] as const) {
      for (const vertex of burger.vertices[space]) {
        expect(idOf(ix, space, vertex.name), `${space} "${vertex.name}" has no id`).not.toBeNull();
      }
    }
  });

  it("keeps the five spaces independent — id 0 means a different node in each", () => {
    const ix = buildIdIndex(burger.idTable);
    expect(nodeOf(ix, "ingredient", 0)).toBe("bun");
    expect(nodeOf(ix, "composite", 0)).toBe("burger");
    expect(nodeOf(ix, "group", 0)).toBe("burger-toppings");
    expect(nodeOf(ix, "tool", 0)).toBe("griddle");
    expect(nodeOf(ix, "dirty", 0)).toBe("dirty-plate");
  });

  it("reports no structural issues for burger.json", () => {
    expect(validateIdTable(burger.idTable)).toEqual([]);
  });
});

describe("id table — the rules that keep committed levels safe", () => {
  const table = (): IdTable => ({
    ingredient: ["bun", "patty"],
    composite: [],
    group: [],
    tool: [],
    dirty: [],
  });

  it("APPEND: a new node takes the next position", () => {
    const t = table();
    expect(mintId(t, "ingredient", "tomato")).toBe(2);
    expect(mintId(t, "ingredient", "lettuce")).toBe(3);
  });

  it("APPEND: minting is idempotent — an existing node keeps its id", () => {
    const t = table();
    expect(mintId(t, "ingredient", "patty")).toBe(1);
    expect(mintId(t, "ingredient", "patty")).toBe(1);
    expect(t.ingredient).toHaveLength(2);
  });

  /**
   * There are no tombstones. Removing a row splices it out, so every id after
   * it shifts down — the same renumber a reorder causes, and confirmed the
   * same way at the call site. This pins that it really does shift, because a
   * half-measure (leave a hole) would be worse than either choice.
   */
  it("REMOVE renumbers: every later id shifts down by one", () => {
    const t = table();
    t.ingredient.push("tomato");
    expect(removeId(t, "ingredient", "patty")).toBe(1);
    expect(t.ingredient).toEqual(["bun", "tomato"]);
    const ix = buildIdIndex(t);
    expect(nodeOf(ix, "ingredient", 1)).toBe("tomato"); // slid down from 2
    expect(nodeOf(ix, "ingredient", 2)).toBeNull();
  });

  it("REMOVE: the freed id is reused by the next mint, because nothing reserves it", () => {
    const t = table();
    removeId(t, "ingredient", "patty");
    expect(nextId(t, "ingredient")).toBe(1);
    expect(mintId(t, "ingredient", "tomato")).toBe(1);
  });

  it("REMOVE: removing an absent node is a no-op, not a throw", () => {
    const t = table();
    expect(removeId(t, "ingredient", "never-existed")).toBeNull();
    expect(t.ingredient).toHaveLength(2);
  });

  it("RENAME IS FREE: the position survives, so every level using it keeps working", () => {
    const t = table();
    expect(renameNode(t, "ingredient", "patty", "beef-patty")).toBe(true);
    const ix = buildIdIndex(t);
    expect(nodeOf(ix, "ingredient", 1)).toBe("beef-patty");
    expect(idOf(ix, "ingredient", "beef-patty")).toBe(1);
    expect(idOf(ix, "ingredient", "patty")).toBeNull();
  });
});

describe("reorderIdEntry — the one edit that deliberately RENUMBERS", () => {
  const table = (): IdTable => ({
    ingredient: ["bun", "patty", "tomato"],
    composite: [],
    group: [],
    tool: [],
    dirty: [],
  });

  it("moves a row and renumbers everything from the lower position onward", () => {
    const next = reorderIdEntry(table(), "ingredient", 0, 2);
    const ix = buildIdIndex(next);
    expect(nodeOf(ix, "ingredient", 0)).toBe("patty");
    expect(nodeOf(ix, "ingredient", 1)).toBe("tomato");
    expect(nodeOf(ix, "ingredient", 2)).toBe("bun");
  });

  it("does not mutate the table it was handed", () => {
    const before = table();
    reorderIdEntry(before, "ingredient", 0, 2);
    expect(before.ingredient).toEqual(["bun", "patty", "tomato"]);
  });

  it("returns the SAME table for a no-op or an out-of-range move", () => {
    // A drag that ends where it started must do nothing at all — not push an
    // undo entry's worth of new object.
    const before = table();
    expect(reorderIdEntry(before, "ingredient", 1, 1)).toBe(before);
    expect(reorderIdEntry(before, "ingredient", 0, 9)).toBe(before);
    expect(reorderIdEntry(before, "ingredient", -1, 0)).toBe(before);
  });

  it("round-trips: moving a row out and back restores the original numbering", () => {
    const before = table();
    const there = reorderIdEntry(before, "ingredient", 0, 2);
    const back = reorderIdEntry(there, "ingredient", 2, 0);
    expect(back.ingredient).toEqual(before.ingredient);
  });

  it("leaves every OTHER space untouched", () => {
    const t = table();
    t.tool = ["griddle", "fryer"];
    const next = reorderIdEntry(t, "ingredient", 0, 2);
    expect(next.tool).toEqual(["griddle", "fryer"]);
  });
});

describe("id table — total on bad input", () => {
  it("returns null rather than throwing for unknown ids and names", () => {
    const ix = buildIdIndex(createIdTable());
    expect(nodeOf(ix, "ingredient", 7)).toBeNull();
    expect(idOf(ix, "ingredient", "nope")).toBeNull();
  });

  it("fills in spaces the JSON omitted", () => {
    const t = normalizeIdTable({ ingredient: ["bun"] });
    for (const space of ID_SPACES) expect(Array.isArray(t[space])).toBe(true);
    expect(t.ingredient).toHaveLength(1);
  });

  it("does not alias the input", () => {
    const partial: Partial<IdTable> = { ingredient: ["bun"] };
    const t = normalizeIdTable(partial);
    t.ingredient.push("patty");
    expect(partial.ingredient).toHaveLength(1);
  });
});

describe("validateIdTable", () => {
  const base = (): IdTable => ({ ...createIdTable() });

  /**
   * Duplicate and negative ids were the two things this used to check. Both are
   * now unrepresentable — an id is an array index — which is the main thing the
   * positional model buys, so what remains is the checks that still can fail.
   */
  it("flags two rows claiming the same node", () => {
    const t = base();
    t.ingredient = ["bun", "bun"];
    expect(validateIdTable(t)[0].message).toMatch(/claimed by both id 0 and id 1/);
  });

  it("flags an empty row, which would be an id that names nothing", () => {
    const t = base();
    t.ingredient = ["bun", "", "tomato"];
    expect(validateIdTable(t)[0].message).toMatch(/names nothing/);
  });

  it("accepts a well-formed table", () => {
    const t = base();
    t.ingredient = ["bun", "patty", "tomato"];
    expect(validateIdTable(t)).toEqual([]);
  });
});
