// The scenario that motivated relaxing INV-ORDER-REBUILDABLE, built and run
// end to end: split `potato-fried` out of the fried basket into its own
// orderable, and let `cheese-sauce` be offered by BOTH.
//
// That is exactly what the old rule called a "C2" violation and rejected as an
// error. The rule existed for the flat-list recogniser the legacy migration
// used: given a bare multiset of ids, a shared ingredient made the composite
// undecidable. Dishes are authored as bracket trees now — the outermost
// `{cN:` names the composite — so resolution is scoped to it and nothing is
// ambiguous. The migration that needed the guarantee is retired.
//
// What stayed an error is the other half: one ingredient in two slots of the
// SAME composite. See `resolves into the WRONG slot` below, which measures the
// damage rather than asserting it.

import { describe, expect, it } from "vitest";
import burgerJson from "./config/nodegraph/burger.json";
import { buildIndex } from "../core/nodeIndex.ts";
import { orderIdIndex, resolveOrder } from "../core/nodeOrder.ts";
import { parseNodeCustomers } from "../core/nodeParser.ts";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";
import { mintId } from "./nodeIdTable.ts";
import { validateNodeGraph } from "./nodeGraphValidate.ts";
import { nodeAsMapDef } from "./nodeGraphToMapDef.ts";

/** Burger, with fried potato promoted to its own orderable sharing the sauce. */
function splitPotato(): NodeGraphMap {
  const doc = structuredClone(burgerJson) as unknown as NodeGraphMap;
  doc.vertices.composite.push({ name: "fried-potato", displayName: "Fried Potato", orderable: true });
  doc.vertices.group.push({ name: "potato-sauces", displayName: "Potato Sauces", maxQuantity: 1 });
  doc.edges.base.push({ from: "fried-potato", to: "potato-fried" });
  doc.edges.topping.push({ from: "fried-potato", to: "potato-sauces" });
  doc.edges.option.push({ from: "potato-sauces", to: "cheese-sauce", maxQuantity: 1 });
  doc.edges.leavesDirty.push({ from: "fried-potato", to: "dirty-chick-box" });
  // Potato leaves the basket; cheese-sauce stays offered by both.
  doc.edges.option = doc.edges.option.filter(
    (e) => !(e.from === "fried-basket-bases" && e.to === "potato-fried"),
  );
  mintId(doc.idTable, "composite", "fried-potato");
  mintId(doc.idTable, "group", "potato-sauces");
  return doc;
}

const doc = splitPotato();
const ix = buildIndex(doc);
const ids = orderIdIndex(ix);

const cid = (name: string) => doc.idTable.composite.indexOf(name);
const gid = (name: string) => doc.idTable.group.indexOf(name);
const iid = (name: string) => doc.idTable.ingredient.indexOf(name);

const resolve = (text: string) =>
  resolveOrder(ix, parseNodeCustomers(`0;0;0;${text}`)[0].dishes[0], ids);

describe("a sauce shared by two orderables", () => {
  it("is not an error — the graph validates clean", () => {
    expect(validateNodeGraph(doc).errors.map((e) => e.message)).toEqual([]);
  });

  it("resolves inside the fried potato, with the right slot, gate and dirty object", () => {
    const r = resolve(`{c${cid("fried-potato")}:${iid("potato-fried")}.{g${gid("potato-sauces")}:${iid("cheese-sauce")}}}`);
    expect(r.issues).toEqual([]);
    expect(ix.compositeName[r.order.orderable]).toBe("fried-potato");
    expect(r.order.slots.map((s) => [ix.ingName[s.ing], s.slot, s.gate])).toEqual([
      ["potato-fried", 0, -1],
      ["cheese-sauce", 1, 0],
    ]);
    expect(ix.dirtyName[r.order.dirty]).toBe("dirty-chick-box");
  });

  it("resolves inside the fried basket too — the SAME sauce, a different dish", () => {
    const r = resolve(
      `{c${cid("fried-basket")}:{g${gid("fried-basket-bases")}:${iid("chicken-wing-fried")}}.{g${gid("fried-basket-sauces")}:${iid("cheese-sauce")}}}`,
    );
    expect(r.issues).toEqual([]);
    expect(ix.compositeName[r.order.orderable]).toBe("fried-basket");
    expect(r.order.slots.map((s) => [ix.ingName[s.ing], s.slot, s.gate])).toEqual([
      ["chicken-wing-fried", 0, -1],
      ["cheese-sauce", 1, 0],
    ]);
  });

  it("records both homes, so a projection can gate on either base", () => {
    const sauce = ix.ingByName.get("cheese-sauce")!;
    const homes = (ix.placesOf[sauce] ?? []).map((p) => ix.compositeName[p.orderable]).sort();
    expect(homes).toEqual(["fried-basket", "fried-potato"]);

    // The legacy projection's `baseId` is `Id | Id[]` precisely so it can say
    // "either of these" — the union of both composites' bases.
    const projected = nodeAsMapDef(doc, ix);
    const dataId = projected.dataIdOf.get(sauce)!;
    const cooked = projected.map.cookedIngredients.find((c) => c.id === dataId)!;
    const bases = Array.isArray(cooked.baseId) ? cooked.baseId : [cooked.baseId!];
    expect(bases).toContain(projected.dataIdOf.get(ix.ingByName.get("potato-fried")!));
    expect(bases).toContain(projected.dataIdOf.get(ix.ingByName.get("chicken-wing-fried")!));
  });
});

describe("the half that stayed an error: one ingredient, two slots of one composite", () => {
  /** The basket offering cheese-sauce as a BASE as well as a sauce. */
  const doubled = (): NodeGraphMap => {
    const d = structuredClone(burgerJson) as unknown as NodeGraphMap;
    d.edges.option.push({ from: "fried-basket-bases", to: "cheese-sauce", maxQuantity: 1 });
    return d;
  };

  it("is still reported", () => {
    const errors = validateNodeGraph(doubled()).errors;
    const issue = errors.find((e) => e.invariantId === "INV-ORDER-REBUILDABLE");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("two slots of one composite");
  });

  /**
   * Why it stays: the damage is silent. `resolveOrder` maps ingredient -> slot
   * per composite with the last write winning, so a dish authored into the
   * BASE group lands in the sauce slot instead — carrying a gate on a base it
   * no longer has, which can never open.
   */
  it("resolves into the WRONG slot, with a gate that can never open", () => {
    const d = doubled();
    const ix2 = buildIndex(d);
    const ids2 = orderIdIndex(ix2);
    const text = `{c${d.idTable.composite.indexOf("fried-basket")}:{g${d.idTable.group.indexOf("fried-basket-bases")}:${d.idTable.ingredient.indexOf("cheese-sauce")}}}`;
    const r = resolveOrder(ix2, parseNodeCustomers(`0;0;0;${text}`)[0].dishes[0], ids2);
    expect(r.order.slots).toHaveLength(1);
    // Authored into slot 0 (the base group); resolved into slot 1, gated on 0.
    expect(r.order.slots[0].slot).toBe(1);
    expect(r.order.slots[0].gate).toBe(0);
  });
});
