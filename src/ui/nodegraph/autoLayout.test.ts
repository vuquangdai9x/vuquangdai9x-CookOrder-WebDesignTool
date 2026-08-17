import { describe, expect, it } from "vitest";
import burgerJson from "../../data/config/nodegraph/maps/Graph-1-Burger.json";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import { autoLayout, computeDepths, layoutKey } from "./autoLayout.ts";

const burger = burgerJson as unknown as NodeGraphMap;

describe("computeDepths", () => {
  const depth = computeDepths(burger);

  it("puts pickups at the left edge", () => {
    expect(depth.get("bun")).toBe(0);
    expect(depth.get("patty")).toBe(0);
    expect(depth.get("chicken-breast")).toBe(0);
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
      e.to === "bun-sliced" ? { ...e, inputs: ["bun-sliced"] } : e,
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
});
