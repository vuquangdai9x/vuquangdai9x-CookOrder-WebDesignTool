import { describe, expect, it } from "vitest";
import burgerJson from "./config/nodegraph/maps/Graph-1-Burger.json";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";
import { validateNodeGraph } from "./nodeGraphValidate.ts";
import { validateIdTable } from "./nodeIdTable.ts";

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

describe("INV-ORDER-REBUILDABLE — one ingredient, two slots of one composite", () => {
  it("flags an ingredient offered by two slots of ONE composite", () => {
    const doc = clone();
    // bun-sliced is already burger's fixed base; also offer it as a topping.
    doc.edges.option.push({ from: "burger-toppings", to: "bun-sliced", maxQuantity: -1 });
    const { errors } = validateNodeGraph(doc);
    const issue = errors.find((e) => e.invariantId === "INV-ORDER-REBUILDABLE");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("bun-sliced");
    expect(issue!.message).toContain("two slots of one composite");
  });

  /**
   * The relaxation, pinned. Sharing one ingredient between two orderables was
   * an error ("C2") because the retired flat-list recogniser could not tell
   * which composite a bare id belonged to. A bracket dish names its composite,
   * so resolution is scoped and the sharing is unambiguous — this is what lets
   * a fried potato and a fried basket offer the same sauce.
   */
  it("ALLOWS an ingredient hosted by two different orderables", () => {
    const doc = clone();
    // ice is soda's topping; also offer it among burger's toppings.
    doc.edges.option.push({ from: "burger-toppings", to: "ice", maxQuantity: -1 });
    const { errors } = validateNodeGraph(doc);
    expect(errors.filter((e) => e.invariantId === "INV-ORDER-REBUILDABLE")).toEqual([]);
  });

  it("nesting alone is NOT a violation — depth is not the hazard", () => {
    const doc = clone();
    // Wrap burger in another composite: outer -> burger -> ... (depth 2).
    doc.vertices.composite.push({ name: "meal", displayName: "Meal", orderable: true });
    doc.vertices.composite = doc.vertices.composite.map((c) =>
      c.name === "burger" ? { ...c, orderable: false } : c,
    );
    doc.edges.base.push({ from: "meal", to: "burger" });
    doc.idTable.composite.push("meal");
    const { errors } = validateNodeGraph(doc);
    expect(errors.filter((e) => e.invariantId === "INV-ORDER-REBUILDABLE")).toEqual([]);
  });
});

describe("graph structure invariants", () => {
  it("INV-UNIQUE-PRODUCER: two tools producing one ingredient", () => {
    const doc = clone();
    doc.edges.process.push({ from: "griddle", to: "bun-sliced", inputs: [{ ingredient: "bun", slot: 0 }], amount: 1 });
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
    doc.edges.process.push({ from: "burger", to: "bun-sliced", inputs: [{ ingredient: "bun", slot: 0 }], amount: 1 });
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
      e.to === "bun-sliced" ? { ...e, inputs: [{ ingredient: "bun-sliced", slot: 0 }] } : e,
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

  it("INV-GROUP-QUANTITY: minimum cannot exceed a finite maximum", () => {
    const doc = clone();
    const group = doc.vertices.group.find((value) => value.name === "burger-toppings")!;
    group.minQuantity = 3;
    group.maxQuantity = 2;
    const { errors } = validateNodeGraph(doc);
    expect(errors.find((error) => error.invariantId === "INV-GROUP-QUANTITY")?.message).toContain(
      "minQuantity 3",
    );
  });

  it("INV-TRACEABLE: an orderable needing something unobtainable", () => {
    const doc = clone();
    doc.vertices.ingredient.push({ name: "unobtainium", displayName: "Unobtainium", servable: true });
    doc.edges.option.push({ from: "burger-toppings", to: "unobtainium", maxQuantity: -1 });
    doc.idTable.ingredient.push("unobtainium");
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
      e.to === "patty-cooked" ? { ...e, inputs: [{ ingredient: "patty", slot: 0 }, { ingredient: "cheese", slot: 0 }] } : e,
    );
    const { errors, warnings } = validateNodeGraph(doc);
    expect(ids(warnings)).toContain("WARN-MULTI-INPUT");
    expect(ids(errors)).not.toContain("WARN-MULTI-INPUT");
  });
});

describe("id table invariants", () => {
  it("INV-IDTABLE-RESOLVES: an entry naming a vertex that does not exist", () => {
    const doc = clone();
    doc.idTable.ingredient.push("no-such-node");
    const { errors } = validateNodeGraph(doc);
    expect(errors.find((e) => e.invariantId === "INV-IDTABLE-RESOLVES")!.message).toContain("no-such-node");
  });

  it("INV-IDTABLE-RESOLVES: an entry pointing at the wrong kind", () => {
    const doc = clone();
    doc.idTable.ingredient.push("griddle");
    const { errors } = validateNodeGraph(doc);
    expect(errors.find((e) => e.invariantId === "INV-IDTABLE-RESOLVES")!.message).toContain("which is a tool");
  });

  it("INV-IDTABLE-UNIQUE: a duplicate id", () => {
    const doc = clone();
    doc.idTable.ingredient.push("bun-sliced");
    const { errors } = validateNodeGraph(doc);
    expect(ids(errors)).toContain("INV-IDTABLE-UNIQUE");
  });

  it("WARN-UNTABLED-NODE: a servable ingredient with no id", () => {
    const doc = clone();
    doc.idTable.ingredient = doc.idTable.ingredient.filter((node) => node !== "patty-cooked");
    const { warnings } = validateNodeGraph(doc);
    expect(warnings.find((w) => w.invariantId === "WARN-UNTABLED-NODE")!.message).toContain("patty-cooked");
  });

  it("an EMPTY id row is reported, since it is an id that names nothing", () => {
    // There are no tombstones any more, so a blank row is not a legitimate
    // "retired" state to skip past — it is a hole, and level data indexing
    // into it would resolve to nothing.
    const doc = clone();
    doc.idTable.ingredient.push("");
    const messages = validateIdTable(doc.idTable).map((i) => i.message);
    expect(messages.some((m) => /names nothing/.test(m))).toBe(true);
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
    doc.idTable.ingredient.push("spare");
    const { warnings } = validateNodeGraph(doc);
    expect(warnings.find((w) => w.invariantId === "WARN-UNUSED-PICKUP")!.message).toContain("spare");
  });

  it("WARN-EMPTY-TOOL: a tool with no recipes", () => {
    const doc = clone();
    doc.vertices.tool.push({ name: "idle-tool", displayName: "Idle", slotConfigs: [{ name: "Slot", slot: 1 }], cookingTime: 1 });
    doc.idTable.tool.push("idle-tool");
    const { warnings } = validateNodeGraph(doc);
    expect(warnings.find((w) => w.invariantId === "WARN-EMPTY-TOOL")!.message).toContain("idle-tool");
  });
});
