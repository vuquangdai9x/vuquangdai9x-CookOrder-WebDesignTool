import { describe, expect, it } from "vitest";
import burgerJson from "./config/nodegraph/burger.json";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";
import { validateNodeGraph } from "./nodeGraphValidate.ts";

const burger = burgerJson as unknown as NodeGraphMap;
const clone = (): NodeGraphMap => structuredClone(burger);
const ids = (r: { invariantId: string }[]) => r.map((i) => i.invariantId);

describe("burger.json is clean", () => {
  it("produces no errors", () => {
    const { errors } = validateNodeGraph(burger);
    expect(errors.map((e) => `${e.invariantId}: ${e.message}`)).toEqual([]);
  });

  it("produces exactly two warnings, both the expected unbounded build-your-own groups", () => {
    const { warnings } = validateNodeGraph(burger);
    expect(warnings).toHaveLength(2);
    expect(ids(warnings)).toEqual(["WARN-UNBOUNDED", "WARN-UNBOUNDED"]);
    expect(warnings.map((w) => w.vertexName).sort()).toEqual(["burger", "fried-basket"]);
  });

  it("does NOT flag patty-cooked as an orphan output", () => {
    // patty-cooked is never a leaf — it is an intermediate reached THROUGH the
    // burger-toppings group. A leaf-membership test wrongly reports it, which
    // is a bug this codebase has already hit once.
    const { warnings } = validateNodeGraph(burger);
    expect(warnings.filter((w) => w.vertexName === "patty-cooked")).toEqual([]);
  });

  it("does NOT flag flour as an empty tool — it coats chicken", () => {
    const { warnings } = validateNodeGraph(burger);
    expect(warnings.filter((w) => w.invariantId === "WARN-EMPTY-TOOL")).toEqual([]);
  });
});

describe("INV-ORDER-REBUILDABLE — the two ways a flat dish stops being re-bracketable", () => {
  it("C1: an ingredient offered by two slots of ONE composite", () => {
    const doc = clone();
    // bun-sliced is already burger's fixed base; also offer it as a topping.
    doc.edges.option.push({ from: "burger-toppings", to: "bun-sliced", maxQuantity: -1 });
    const { errors } = validateNodeGraph(doc);
    const issue = errors.find((e) => e.invariantId === "INV-ORDER-REBUILDABLE");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("bun-sliced");
    expect(issue!.message).toContain("two slots of one composite (C1)");
  });

  it("C2: an ingredient hosted by two different orderables", () => {
    const doc = clone();
    // ice is soda's topping; also offer it among burger's toppings.
    doc.edges.option.push({ from: "burger-toppings", to: "ice", maxQuantity: -1 });
    const { errors } = validateNodeGraph(doc);
    const issue = errors.find((e) => e.invariantId === "INV-ORDER-REBUILDABLE");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("ice");
    expect(issue!.message).toContain("two orderables (C2)");
  });

  it("nesting alone is NOT a violation — depth is not the hazard", () => {
    const doc = clone();
    // Wrap burger in another composite: outer -> burger -> ... (depth 2).
    doc.vertices.composite.push({ name: "meal", displayName: "Meal", orderable: true });
    doc.vertices.composite = doc.vertices.composite.map((c) =>
      c.name === "burger" ? { ...c, orderable: false } : c,
    );
    doc.edges.base.push({ from: "meal", to: "burger" });
    doc.idTable.composite.push({ node: "meal" });
    const { errors } = validateNodeGraph(doc);
    expect(errors.filter((e) => e.invariantId === "INV-ORDER-REBUILDABLE")).toEqual([]);
  });
});

describe("graph structure invariants", () => {
  it("INV-UNIQUE-PRODUCER: two tools producing one ingredient", () => {
    const doc = clone();
    doc.edges.process.push({ from: "griddle", to: "bun-sliced", inputs: ["bun"], amount: 1 });
    const { errors } = validateNodeGraph(doc);
    const issue = errors.find((e) => e.invariantId === "INV-UNIQUE-PRODUCER");
    expect(issue!.message).toContain("bun-sliced");
    expect(issue!.message).toContain("2 tools");
  });

  it("INV-UNIQUE-PRODUCER: an ingredient that is neither pickupable nor produced", () => {
    const doc = clone();
    doc.edges.process = doc.edges.process.filter((e) => e.to !== "bun-sliced");
    const { errors } = validateNodeGraph(doc);
    expect(errors.find((e) => e.invariantId === "INV-UNIQUE-PRODUCER")!.message).toContain(
      "nothing can ever obtain it",
    );
  });

  it("INV-REF: an edge naming a vertex that does not exist", () => {
    const doc = clone();
    doc.edges.option.push({ from: "burger-toppings", to: "ghost-ingredient" });
    const { errors } = validateNodeGraph(doc);
    expect(errors.find((e) => e.invariantId === "INV-REF")!.message).toContain("ghost-ingredient");
  });

  it("INV-REF: an edge whose endpoint is the wrong kind", () => {
    const doc = clone();
    doc.edges.process.push({ from: "burger", to: "bun-sliced", inputs: ["bun"], amount: 1 });
    const { errors } = validateNodeGraph(doc);
    expect(errors.some((e) => e.invariantId === "INV-REF" && e.message.includes("which is a composite"))).toBe(true);
  });

  it("INV-NAMESPACE: one name used by two kinds", () => {
    const doc = clone();
    doc.vertices.group.push({ name: "griddle", displayName: "Clash", maxQuantity: 1 });
    const { errors } = validateNodeGraph(doc);
    expect(errors.find((e) => e.invariantId === "INV-NAMESPACE")!.message).toContain("griddle");
  });

  it("INV-ACYCLIC: a cycle in the production graph", () => {
    const doc = clone();
    // Make bun-sliced require itself, via a tool consuming its own output.
    doc.edges.process = doc.edges.process.map((e) =>
      e.to === "bun-sliced" ? { ...e, inputs: ["bun-sliced"] } : e,
    );
    const { errors } = validateNodeGraph(doc);
    expect(ids(errors)).toContain("INV-ACYCLIC");
  });

  it("INV-BASE-REQUIRED: a composite with no base", () => {
    const doc = clone();
    doc.edges.base = doc.edges.base.filter((e) => e.from !== "soda");
    const { errors } = validateNodeGraph(doc);
    expect(errors.find((e) => e.invariantId === "INV-BASE-REQUIRED")!.message).toContain("soda");
  });

  it("INV-GROUP-NONEMPTY: a group with no options", () => {
    const doc = clone();
    doc.edges.option = doc.edges.option.filter((e) => e.from !== "fried-basket-sauces");
    const { errors } = validateNodeGraph(doc);
    expect(errors.find((e) => e.invariantId === "INV-GROUP-NONEMPTY")!.message).toContain(
      "fried-basket-sauces",
    );
  });

  it("INV-TRACEABLE: an orderable needing something unobtainable", () => {
    const doc = clone();
    doc.vertices.ingredient.push({ name: "unobtainium", displayName: "Unobtainium", servable: true });
    doc.edges.option.push({ from: "burger-toppings", to: "unobtainium", maxQuantity: -1 });
    doc.idTable.ingredient.push({ node: "unobtainium" });
    const { errors } = validateNodeGraph(doc);
    expect(errors.find((e) => e.invariantId === "INV-TRACEABLE")!.message).toContain("unobtainium");
  });

  it("INV-INTERMEDIATE-AMOUNT: a non-servable intermediate yielding more than one", () => {
    const doc = clone();
    doc.edges.process = doc.edges.process.map((e) =>
      e.to === "chicken-breast-flour-coated" ? { ...e, amount: 2 } : e,
    );
    const { errors } = validateNodeGraph(doc);
    expect(errors.find((e) => e.invariantId === "INV-INTERMEDIATE-AMOUNT")!.message).toContain(
      "chicken-breast-flour-coated",
    );
  });

  it("WARN-MULTI-INPUT: a recipe with more than one input survives as data but is flagged", () => {
    const doc = clone();
    doc.edges.process = doc.edges.process.map((e) =>
      e.to === "patty-cooked" ? { ...e, inputs: ["patty", "cheese"] } : e,
    );
    const { errors, warnings } = validateNodeGraph(doc);
    expect(ids(warnings)).toContain("WARN-MULTI-INPUT");
    expect(ids(errors)).not.toContain("WARN-MULTI-INPUT");
  });
});

describe("id table invariants", () => {
  it("INV-IDTABLE-RESOLVES: an entry naming a vertex that does not exist", () => {
    const doc = clone();
    doc.idTable.ingredient.push({ node: "no-such-node" });
    const { errors } = validateNodeGraph(doc);
    expect(errors.find((e) => e.invariantId === "INV-IDTABLE-RESOLVES")!.message).toContain("no-such-node");
  });

  it("INV-IDTABLE-RESOLVES: an entry pointing at the wrong kind", () => {
    const doc = clone();
    doc.idTable.ingredient.push({ node: "griddle" });
    const { errors } = validateNodeGraph(doc);
    expect(errors.find((e) => e.invariantId === "INV-IDTABLE-RESOLVES")!.message).toContain("which is a tool");
  });

  it("INV-IDTABLE-UNIQUE: a duplicate id", () => {
    const doc = clone();
    doc.idTable.ingredient.push({ node: "bun-sliced" });
    const { errors } = validateNodeGraph(doc);
    expect(ids(errors)).toContain("INV-IDTABLE-UNIQUE");
  });

  it("WARN-UNTABLED-NODE: a servable ingredient with no id", () => {
    const doc = clone();
    doc.idTable.ingredient = doc.idTable.ingredient.filter((e) => e.node !== "patty-cooked");
    const { warnings } = validateNodeGraph(doc);
    expect(warnings.find((w) => w.invariantId === "WARN-UNTABLED-NODE")!.message).toContain("patty-cooked");
  });

  it("a tombstoned id is not treated as an unresolved reference", () => {
    const doc = clone();
    doc.idTable.ingredient.push({ node: null, retired: "long-gone" });
    const { errors } = validateNodeGraph(doc);
    expect(errors.filter((e) => e.invariantId.startsWith("INV-IDTABLE"))).toEqual([]);
  });
});

describe("warnings", () => {
  it("WARN-ORPHAN-OUTPUT: something produced that no orderable needs", () => {
    const doc = clone();
    doc.edges.option = doc.edges.option.filter((e) => e.to !== "chive-sliced");
    const { warnings } = validateNodeGraph(doc);
    expect(warnings.find((w) => w.invariantId === "WARN-ORPHAN-OUTPUT")!.message).toContain("chive-sliced");
  });

  it("WARN-UNUSED-PICKUP: a pickupable no orderable reaches", () => {
    const doc = clone();
    doc.vertices.ingredient.push({ name: "spare", displayName: "Spare", pickupable: true });
    doc.idTable.ingredient.push({ node: "spare" });
    const { warnings } = validateNodeGraph(doc);
    expect(warnings.find((w) => w.invariantId === "WARN-UNUSED-PICKUP")!.message).toContain("spare");
  });

  it("WARN-EMPTY-TOOL: a tool with no recipes", () => {
    const doc = clone();
    doc.vertices.tool.push({ name: "idle-tool", displayName: "Idle", numSlots: 1, cookingTime: 1 });
    doc.idTable.tool.push({ node: "idle-tool" });
    const { warnings } = validateNodeGraph(doc);
    expect(warnings.find((w) => w.invariantId === "WARN-EMPTY-TOOL")!.message).toContain("idle-tool");
  });
});
