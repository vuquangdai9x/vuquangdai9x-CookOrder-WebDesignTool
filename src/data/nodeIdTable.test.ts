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
  retireId,
  retiredName,
  validateIdTable,
} from "./nodeIdTable.ts";

const burger = burgerJson as unknown as NodeGraphMap;

describe("id table — round trip", () => {
  it("resolves every burger.json entry in both directions", () => {
    const ix = buildIdIndex(burger.idTable);
    for (const space of ID_SPACES) {
      for (const entry of burger.idTable[space]) {
        if (entry.node === null) continue;
        expect(nodeOf(ix, space, entry.id)).toBe(entry.node);
        expect(idOf(ix, space, entry.node)).toBe(entry.id);
      }
    }
  });

  it("covers every vertex in burger.json — nothing is unreachable from level data", () => {
    const ix = buildIdIndex(burger.idTable);
    for (const space of ["ingredient", "composite", "group", "tool", "dirty"] as const) {
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

describe("id table — the three rules that keep committed levels safe", () => {
  const table = (): IdTable => ({
    ingredient: [
      { id: 0, node: "bun" },
      { id: 1, node: "patty" },
    ],
    composite: [],
    group: [],
    tool: [],
    dirty: [],
  });

  it("APPEND-ONLY: a new node takes the next free id", () => {
    const t = table();
    expect(mintId(t, "ingredient", "tomato")).toBe(2);
    expect(mintId(t, "ingredient", "lettuce")).toBe(3);
  });

  it("APPEND-ONLY: minting is idempotent — an existing node keeps its id", () => {
    const t = table();
    expect(mintId(t, "ingredient", "patty")).toBe(1);
    expect(mintId(t, "ingredient", "patty")).toBe(1);
    expect(t.ingredient).toHaveLength(2);
  });

  it("APPEND-ONLY: a retired id is never reissued, so old data can't silently repoint", () => {
    const t = table();
    retireId(t, "ingredient", "patty"); // frees the NAME, not the id
    expect(nextId(t, "ingredient")).toBe(2); // NOT 1
    expect(mintId(t, "ingredient", "something-else")).toBe(2);
  });

  it("TOMBSTONE: a retired id resolves to null and remembers what it was", () => {
    const t = table();
    const retired = retireId(t, "ingredient", "patty");
    expect(retired).toBe(1);
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

  it("RENAME IS FREE: the id survives, so every level using it keeps working", () => {
    const t = table();
    expect(renameNode(t, "ingredient", "patty", "beef-patty")).toBe(true);
    const ix = buildIdIndex(t);
    expect(nodeOf(ix, "ingredient", 1)).toBe("beef-patty");
    expect(idOf(ix, "ingredient", "beef-patty")).toBe(1);
    expect(idOf(ix, "ingredient", "patty")).toBeNull();
  });
});

describe("id table — total on bad input", () => {
  it("returns null rather than throwing for unknown ids and names", () => {
    const ix = buildIdIndex(createIdTable());
    expect(nodeOf(ix, "ingredient", 7)).toBeNull();
    expect(idOf(ix, "ingredient", "nope")).toBeNull();
  });

  it("fills in spaces the JSON omitted", () => {
    const partial = { ingredient: [{ id: 0, node: "bun" }] };
    const t = normalizeIdTable(partial);
    for (const space of ID_SPACES) expect(Array.isArray(t[space])).toBe(true);
    expect(t.ingredient).toHaveLength(1);
  });

  it("does not alias the input", () => {
    const partial: Partial<IdTable> = { ingredient: [{ id: 0, node: "bun" }] };
    const t = normalizeIdTable(partial);
    t.ingredient.push({ id: 1, node: "patty" });
    expect(partial.ingredient).toHaveLength(1);
  });
});

describe("validateIdTable", () => {
  const base = (): IdTable => ({ ...createIdTable() });

  it("flags a duplicate id", () => {
    const t = base();
    t.ingredient = [
      { id: 0, node: "bun" },
      { id: 0, node: "patty" },
    ];
    expect(validateIdTable(t).map((i) => i.message)).toContain("Duplicate id 0 in the ingredient space.");
  });

  it("flags two ids claiming the same node", () => {
    const t = base();
    t.ingredient = [
      { id: 0, node: "bun" },
      { id: 1, node: "bun" },
    ];
    expect(validateIdTable(t)[0].message).toMatch(/claimed by both id 0 and id 1/);
  });

  it("flags a tombstone that forgot what it retired", () => {
    const t = base();
    t.ingredient = [{ id: 3, node: null }];
    expect(validateIdTable(t)[0].message).toMatch(/records no retired name/);
  });

  it("flags a negative id", () => {
    const t = base();
    t.ingredient = [{ id: -1, node: "bun" }];
    expect(validateIdTable(t)[0].message).toMatch(/non-negative integer/);
  });
});
