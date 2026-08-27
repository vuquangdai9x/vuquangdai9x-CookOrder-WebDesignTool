import { describe, expect, it } from "vitest";
import burgerJson from "../../data/config/nodegraph/maps/Graph-1-Burger.json";
import coffeeJson from "../../data/config/nodegraph/maps/Graph-2-Coffee.json";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import { autoLayout, computeDepths, countLayoutCrossings, layoutKey } from "./autoLayout.ts";

const burger = burgerJson as unknown as NodeGraphMap;
const coffee = coffeeJson as unknown as NodeGraphMap;

describe("computeDepths", () => {
  const depth = computeDepths(burger);

  it("puts pickups at the left edge", () => {
    expect(depth.get("bun")).toBe(0);
    expect(depth.get("patty")).toBe(0);
    expect(depth.get("chicken-breast")).toBe(0);
  });

  it("reserves the leftmost column exclusively for pickupables", () => {
    const coffeeDepth = computeDepths(coffee);
    const pickupables = coffee.vertices.ingredient.filter((node) => node.pickupable);
    const otherIngredients = coffee.vertices.ingredient.filter((node) => !node.pickupable);
    expect(new Set(pickupables.map((node) => coffeeDepth.get(node.name)))).toEqual(new Set([0]));
    for (const node of otherIngredients) expect(coffeeDepth.get(node.name), node.name).toBeGreaterThan(0);
  });

  it("places a produced ingredient strictly right of the tool that makes it", () => {
    expect(depth.get("bun-sliced")!).toBeGreaterThan(depth.get("cutting-board")!);
    expect(depth.get("patty-cooked")!).toBeGreaterThan(depth.get("griddle")!);
  });

  it("keeps the whole chicken chain left to right: flour, coated, fryer, fried", () => {
    // The property that makes the picture readable at all — a two-step route
    // must not fold back on itself.
    const flour = depth.get("flour")!;
    const coated = depth.get("chicken-breast-flour-coated")!;
    const fryer = depth.get("fryer")!;
    const fried = depth.get("chicken-breast-fried")!;
    expect(flour).toBeLessThan(coated);
    expect(coated).toBeLessThan(fryer);
    expect(fryer).toBeLessThan(fried);
  });

  it("uses the LONGEST path, so a tool sits right of its deepest input", () => {
    // The fryer takes both a raw potato (depth 0) and a coated piece (deeper).
    // A shortest-path layout would drag it back to the left of the coating.
    expect(depth.get("fryer")!).toBeGreaterThan(depth.get("chicken-breast-flour-coated")!);
  });

  it("puts every orderable right of its members, and dirty right of that", () => {
    expect(depth.get("burger")!).toBeGreaterThan(depth.get("burger-toppings")!);
    expect(depth.get("dirty-plate")!).toBeGreaterThan(depth.get("burger")!);
  });

  it("returns rather than recursing forever on a cycle", () => {
    const cyclic = structuredClone(burger);
    cyclic.edges.process = cyclic.edges.process.map((e) =>
      e.to === "bun-sliced" ? { ...e, inputs: [{ ingredient: "bun-sliced", slot: 0 }] } : e,
    );
    expect(() => computeDepths(cyclic)).not.toThrow();
  });
});

describe("autoLayout", () => {
  it("positions every vertex exactly once", () => {
    const layout = autoLayout(burger);
    const total =
      burger.vertices.ingredient.length +
      burger.vertices.tool.length +
      burger.vertices.group.length +
      burger.vertices.composite.length +
      burger.vertices.dirty.length;
    expect(Object.keys(layout)).toHaveLength(total);
    expect(layout[layoutKey("ingredient", "bun")]).toBeDefined();
    expect(layout[layoutKey("tool", "fryer")]).toBeDefined();
  });

  it("is STABLE — layout is persisted, so a re-run must diff clean", () => {
    expect(autoLayout(burger)).toEqual(autoLayout(burger));
  });

  it("shares one x per column and never overlaps two nodes in it", () => {
    const layout = autoLayout(burger);
    const byX = new Map<number, number[]>();
    for (const { x, y } of Object.values(layout)) {
      byX.set(x, [...(byX.get(x) ?? []), y]);
    }
    for (const [x, ys] of byX) {
      expect(new Set(ys).size, `column ${x} has two nodes at the same y`).toBe(ys.length);
    }
  });

  it("honours the caller's spacing", () => {
    const layout = autoLayout(burger, { columnWidth: 100, rowHeight: 10, originX: 0, originY: 0 });
    expect(layout[layoutKey("ingredient", "bun")]).toEqual({ x: 0, y: expect.any(Number) });
    for (const { x } of Object.values(layout)) expect(x % 100).toBe(0);
  });

  it("removes a crossing caused purely by alphabetical row order", () => {
    const graph = crossedFixture();
    expect(countLayoutCrossings(graph, legacyAlphabeticalLayout(graph))).toBe(2);
    expect(countLayoutCrossings(graph, autoLayout(graph, { familyGap: 0 }))).toBe(0);
  });

  it("does not regress Burger or Coffee versus the previous alphabetical algorithm", () => {
    const samples = [burger, coffee];
    const comparison = samples.map((graph) => ({
      old: countLayoutCrossings(graph, legacyAlphabeticalLayout(graph)),
      next: countLayoutCrossings(graph, autoLayout(graph)),
    }));
    for (const result of comparison) expect(result.next).toBeLessThanOrEqual(result.old);
    expect(comparison.some((result) => result.next < result.old)).toBe(true);
  });

  it("uses rendered card heights, so tall tools cannot overlap their neighbours", () => {
    const height = (kind: Parameters<typeof layoutKey>[0], name: string): number => {
      if (kind === "composite") return 46 + 2 * 22;
      if (kind !== "tool") return 46;
      const recipes = burger.edges.process.filter((edge) => edge.from === name).length;
      const preservation = (burger.vertices.tool.find((tool) => tool.name === name)?.preservationSlots ?? 0) > 0 ? 1 : 0;
      return 46 + (recipes + preservation + 1) * 22;
    };
    const layout = autoLayout(burger, { nodeHeight: height, nodeGap: 20, rowHeight: 10, familyGap: 0 });
    const nodes = new Map<string, { kind: Parameters<typeof layoutKey>[0]; name: string }>();
    for (const kind of ["ingredient", "tool", "group", "composite", "dirty"] as const) {
      for (const node of burger.vertices[kind]) nodes.set(layoutKey(kind, node.name), { kind, name: node.name });
    }
    const byX = new Map<number, { key: string; y: number }[]>();
    for (const [key, point] of Object.entries(layout)) byX.set(point.x, [...(byX.get(point.x) ?? []), { key, y: point.y }]);
    for (const entries of byX.values()) {
      entries.sort((a, b) => a.y - b.y);
      for (let index = 1; index < entries.length; index++) {
        const previous = entries[index - 1];
        const previousNode = nodes.get(previous.key)!;
        expect(entries[index].y).toBeGreaterThanOrEqual(previous.y + height(previousNode.kind, previousNode.name) + 20 - 0.01);
      }
    }
  });

  it("keeps variants from _foodOrderableMap inside one family band", () => {
    const separate = crossedFixture();
    const grouped = {
      ...structuredClone(separate),
      _foodOrderableMap: { letters: ["order-a", "order-b"] },
    } as unknown as NodeGraphMap;
    const options = { rowHeight: 20, nodeGap: 0, familyGap: 200, nodeHeight: () => 20, sweeps: 1 };
    const separateLayout = autoLayout(separate, options);
    const groupedLayout = autoLayout(grouped, options);
    const gap = (layout: ReturnType<typeof autoLayout>) =>
      Math.abs(layout[layoutKey("composite", "order-a")].y - layout[layoutKey("composite", "order-b")].y);
    expect(gap(groupedLayout)).toBeLessThan(gap(separateLayout));
  });

  it("places every orderable composite on one shared x coordinate", () => {
    const layout = autoLayout(coffee);
    const xs = coffee.vertices.composite
      .filter((node) => node.orderable)
      .map((node) => layout[layoutKey("composite", node.name)].x);
    expect(new Set(xs).size).toBe(1);
  });

  it("centers tools and groups on the rendered span of their connected ingredients", () => {
    const graph = centeredHubFixture();
    const height = (kind: Parameters<typeof layoutKey>[0]) => kind === "tool" ? 120 : kind === "group" ? 80 : 40;
    const layout = autoLayout(graph, {
      rowHeight: 60,
      nodeGap: 20,
      familyGap: 0,
      nodeHeight: height,
      sweeps: 12,
    });
    const center = (kind: Parameters<typeof layoutKey>[0], name: string) =>
      layout[layoutKey(kind, name)].y + height(kind) / 2;
    const spanCenter = (names: string[]) => {
      const centers = names.map((name) => center("ingredient", name));
      return (Math.min(...centers) + Math.max(...centers)) / 2;
    };
    expect(center("tool", "prep-station")).toBeCloseTo(spanCenter(["raw-a", "raw-b", "prepared"]), 1);
    expect(center("group", "topping-choice")).toBeCloseTo(spanCenter(["topping-a", "topping-b"]), 1);
  });
});

/** Exact ordering used before the lane/crossing-aware algorithm. */
function legacyAlphabeticalLayout(graph: NodeGraphMap) {
  const depths = computeDepths(graph);
  const kinds = ["ingredient", "tool", "group", "composite", "dirty"] as const;
  const columns = new Map<number, { kind: (typeof kinds)[number]; name: string }[]>();
  for (const kind of kinds) {
    for (const node of graph.vertices[kind]) {
      const column = depths.get(node.name) ?? 0;
      columns.set(column, [...(columns.get(column) ?? []), { kind, name: node.name }]);
    }
  }
  const layout: ReturnType<typeof autoLayout> = {};
  for (const [column, entries] of columns) {
    entries.sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.name.localeCompare(b.name));
    entries.forEach((entry, row) => {
      layout[layoutKey(entry.kind, entry.name)] = { x: 60 + column * 300, y: 40 + row * 96 };
    });
  }
  return layout;
}

function crossedFixture(): NodeGraphMap {
  return {
    schemaVersion: 1,
    map: { id: "crossed", name: "Crossed", gridWidth: 2, gridHeight: 2, dirtyStackHeight: 2, visibleRows: 2 },
    idTable: {
      ingredient: ["a", "b"],
      composite: ["order-a", "order-b"],
      group: ["group-z-for-a", "group-a-for-b"],
      tool: [],
      dirty: [],
    },
    vertices: {
      ingredient: [
        { name: "a", displayName: "A", pickupable: true, emoji: "🅰️" },
        { name: "b", displayName: "B", pickupable: true, emoji: "🅱️" },
      ],
      tool: [],
      group: [
        { name: "group-z-for-a", displayName: "A choice", maxQuantity: 1 },
        { name: "group-a-for-b", displayName: "B choice", maxQuantity: 1 },
      ],
      composite: [
        { name: "order-a", displayName: "Order A", orderable: true, emoji: "🅰️" },
        { name: "order-b", displayName: "Order B", orderable: true, emoji: "🅱️" },
      ],
      dirty: [],
    },
    edges: {
      process: [],
      preservation: [],
      base: [
        { from: "order-a", to: "group-z-for-a" },
        { from: "order-b", to: "group-a-for-b" },
      ],
      topping: [],
      option: [
        { from: "group-z-for-a", to: "a" },
        { from: "group-a-for-b", to: "b" },
      ],
      leavesDirty: [],
    },
    layout: {},
    notes: [],
  };
}

function centeredHubFixture(): NodeGraphMap {
  return {
    schemaVersion: 1,
    map: { id: "centered-hubs", name: "Centered Hubs", gridWidth: 2, gridHeight: 2, dirtyStackHeight: 2, visibleRows: 2 },
    idTable: {
      ingredient: ["raw-a", "raw-b", "topping-a", "topping-b", "prepared"],
      composite: ["order"],
      group: ["topping-choice"],
      tool: ["prep-station"],
      dirty: [],
    },
    vertices: {
      ingredient: [
        { name: "raw-a", displayName: "Raw A", pickupable: true, emoji: "🅰️" },
        { name: "raw-b", displayName: "Raw B", pickupable: true, emoji: "🅱️" },
        { name: "topping-a", displayName: "Topping A", pickupable: true, emoji: "🔴" },
        { name: "topping-b", displayName: "Topping B", pickupable: true, emoji: "🔵" },
        { name: "prepared", displayName: "Prepared", emoji: "🍽️" },
      ],
      tool: [{ name: "prep-station", displayName: "Prep Station", slotConfigs: [{ name: "input", slot: 2 }], cookingTime: 2, emoji: "⚙️" }],
      group: [{ name: "topping-choice", displayName: "Topping Choice", minQuantity: 1, maxQuantity: 1 }],
      composite: [{ name: "order", displayName: "Order", orderable: true, toppingRequired: true, emoji: "🍽️" }],
      dirty: [],
    },
    edges: {
      process: [{
        from: "prep-station",
        to: "prepared",
        inputs: [{ ingredient: "raw-a", slot: 0 }, { ingredient: "raw-b", slot: 0 }],
        amount: 1,
      }],
      preservation: [],
      base: [{ from: "order", to: "prepared" }],
      topping: [{ from: "order", to: "topping-choice" }],
      option: [
        { from: "topping-choice", to: "topping-a", maxQuantity: 1 },
        { from: "topping-choice", to: "topping-b", maxQuantity: 1 },
      ],
      leavesDirty: [],
    },
    layout: {},
    notes: [],
  };
}
