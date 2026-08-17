import { describe, expect, it } from "vitest";
import burgerJson from "./config/nodegraph/burger.json";
import type { IdTable, NodeGraphMap } from "./nodeGraphTypes.ts";
import {
  buildIdIndex,
  createIdTable,
  ID_SPACES,
  idOf,
  isRetired,
  mintId,
  nextId,
  nodeOf,
  normalizeIdTable,
  renameNode,
  reorderIdEntry,
  retireId,
  retiredName,
  validateIdTable,
} from "./nodeIdTable.ts";

const burger = burgerJson as unknown as NodeGraphMap;

describe("id table — round trip", () => {
  it("resolves every burger.json entry in both directions, by POSITION", () => {
    const ix = buildIdIndex(burger.idTable);
    for (const space of ID_SPACES) {
      burger.idTable[space].forEach((entry, id) => {
        if (entry.node === null) return;
        expect(nodeOf(ix, space, id)).toBe(entry.node);
        expect(idOf(ix, space, entry.node)).toBe(id);
      });
    }
  });

  it("covers every vertex level data can NAME — nothing addressable is unreachable", () => {
    // The rule is not "every vertex has an id". A non-servable, non-pickupable
    // intermediate is never written into a queue or a customer string, so an id
    // for it would be an id nothing can use. The rule is that everything level
    // data CAN name is nameable. WARN-UNTABLED-NODE says the same at load.
    const ix = buildIdIndex(burger.idTable);
    for (const vertex of burger.vertices.ingredient) {
      if (!vertex.servable && !vertex.pickupable) continue;
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
    ingredient: [{ node: "bun" }, { node: "patty" }],
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

  it("APPEND: a retired slot is never reused, so old data can't silently repoint", () => {
    const t = table();
    retireId(t, "ingredient", "patty"); // frees the NAME, not the slot
    expect(nextId(t, "ingredient")).toBe(2); // NOT 1
    expect(mintId(t, "ingredient", "something-else")).toBe(2);
  });

  /**
   * The property the whole positional model rests on: a delete must not shift
   * the rows after it. Splicing would renumber every later id and silently
   * repoint every level string that used one.
   */
  it("TOMBSTONE: retiring keeps the row in place, so later ids do not move", () => {
    const t = table();
    t.ingredient.push({ node: "tomato" });
    retireId(t, "ingredient", "patty");
    expect(t.ingredient).toHaveLength(3);
    const ix = buildIdIndex(t);
    expect(nodeOf(ix, "ingredient", 0)).toBe("bun");
    expect(nodeOf(ix, "ingredient", 1)).toBeNull();
    expect(nodeOf(ix, "ingredient", 2)).toBe("tomato"); // did NOT slide down to 1
  });

  it("TOMBSTONE: a retired id resolves to null and remembers what it was", () => {
    const t = table();
    expect(retireId(t, "ingredient", "patty")).toBe(1);
    const ix = buildIdIndex(t);
    expect(nodeOf(ix, "ingredient", 1)).toBeNull();
    expect(isRetired(ix, "ingredient", 1)).toBe(true);
    expect(retiredName(ix, "ingredient", 1)).toBe("patty");
    // An id that never existed is distinguishable from one that was retired.
    expect(isRetired(ix, "ingredient", 99)).toBe(false);
  });

  it("TOMBSTONE: retiring an absent node is a no-op, not a throw", () => {
    const t = table();
    expect(retireId(t, "ingredient", "never-existed")).toBeNull();
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
    ingredient: [{ node: "bun" }, { node: "patty" }, { node: "tomato" }],
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
    expect(before.ingredient.map((e) => e.node)).toEqual(["bun", "patty", "tomato"]);
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
    expect(back.ingredient.map((e) => e.node)).toEqual(before.ingredient.map((e) => e.node));
  });

  it("leaves every OTHER space untouched", () => {
    const t = table();
    t.tool = [{ node: "griddle" }, { node: "fryer" }];
    const next = reorderIdEntry(t, "ingredient", 0, 2);
    expect(next.tool.map((e) => e.node)).toEqual(["griddle", "fryer"]);
  });
});

describe("id table — total on bad input", () => {
  it("returns null rather than throwing for unknown ids and names", () => {
    const ix = buildIdIndex(createIdTable());
    expect(nodeOf(ix, "ingredient", 7)).toBeNull();
    expect(idOf(ix, "ingredient", "nope")).toBeNull();
  });

  it("fills in spaces the JSON omitted", () => {
    const t = normalizeIdTable({ ingredient: [{ node: "bun" }] });
    for (const space of ID_SPACES) expect(Array.isArray(t[space])).toBe(true);
    expect(t.ingredient).toHaveLength(1);
  });

  it("does not alias the input", () => {
    const partial: Partial<IdTable> = { ingredient: [{ node: "bun" }] };
    const t = normalizeIdTable(partial);
    t.ingredient.push({ node: "patty" });
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
    t.ingredient = [{ node: "bun" }, { node: "bun" }];
    expect(validateIdTable(t)[0].message).toMatch(/claimed by both id 0 and id 1/);
  });

  it("flags a tombstone that forgot what it retired", () => {
    const t = base();
    t.ingredient = [{ node: null }];
    expect(validateIdTable(t)[0].message).toMatch(/records no retired name/);
  });

  it("flags a hole, which would otherwise read as an id that means nothing", () => {
    const t = base();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    t.ingredient = [{ node: "bun" }, undefined as any, { node: "tomato" }];
    expect(validateIdTable(t)[0].message).toMatch(/is a hole/);
  });

  it("accepts a well-formed table", () => {
    const t = base();
    t.ingredient = [{ node: "bun" }, { node: null, retired: "patty" }, { node: "tomato" }];
    expect(validateIdTable(t)).toEqual([]);
  });
});
