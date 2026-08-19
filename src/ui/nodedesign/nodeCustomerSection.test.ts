import { describe, expect, it } from "vitest";
import sushiJson from "../../data/config/nodegraph/maps/Graph-3-Sushi.json";
import coffeeJson from "../../data/config/nodegraph/maps/Graph-2-Coffee.json";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import { buildIndex } from "../../core/nodeIndex.ts";
import { orderIdIndex } from "../../core/nodeOrder.ts";
import type { DishNode } from "../../core/nodeParser.ts";

describe("nested group selection", () => {
  const ix = buildIndex(sushiJson as unknown as NodeGraphMap);
  const ids = orderIdIndex(ix);
  const orderable = ix.compositeByName.get("gunkan-with-topping")!;
  const slots = ix.slotsOfComposite[orderable];
  const roeSlot = slots.findIndex((slot) => ix.groupName[slot.group] === "single-fish-roe");
  const outerSlot = slots.findIndex((slot) => ix.groupName[slot.group] === "gunkan-top");
  const roe = ix.ingByName.get("fish-roe-orange")!;
  const wakame = ix.ingByName.get("wakame-seasame")!;
  const baseSlot = slots.findIndex((slot) => slot.baseOf.includes(orderable));
  const base = slots[baseSlot].options[0];
  const outerId = ids.byNode.group.get("gunkan-top")!;
  const roeId = ids.byNode.group.get("single-fish-roe")!;

  const outerOf = (root: DishNode): DishNode =>
    root.members.find((member): member is DishNode => member.kind === "group" && member.id === outerId)!;

  const basedRoot = async (): Promise<DishNode> => {
    const { addToSlot } = await import("./nodeDishEdit.ts");
    const root: DishNode = { kind: "composite", id: ids.byNode.composite.get("gunkan-with-topping")!, members: [] };
    addToSlot(ix, ids, root, orderable, baseSlot, base);
    return root;
  };

  it("replaces nested roe when another max-one topping is selected", async () => {
    const { addToSlot } = await import("./nodeDishEdit.ts");
    const root = await basedRoot();
    addToSlot(ix, ids, root, orderable, roeSlot, roe);
    addToSlot(ix, ids, root, orderable, outerSlot, wakame);
    expect(outerOf(root).members).toEqual([{ kind: "ingredient", id: ids.byNode.ingredient.get("wakame-seasame") }]);
  });

  it("replaces another topping when nested roe is selected", async () => {
    const { addToSlot } = await import("./nodeDishEdit.ts");
    const root = await basedRoot();
    addToSlot(ix, ids, root, orderable, outerSlot, wakame);
    addToSlot(ix, ids, root, orderable, roeSlot, roe);
    const members = outerOf(root).members;
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ kind: "group", id: roeId });
  });
});

describe("nested composite base gating", () => {
  const ix = buildIndex(coffeeJson as unknown as NodeGraphMap);
  const ids = orderIdIndex(ix);
  const orderable = ix.compositeByName.get("cupcake-with-cream")!;
  const nested = ix.compositeByName.get("whiping-cream-with-topping")!;
  const slots = ix.slotsOfComposite[orderable];
  const outerBaseSlot = slots.findIndex((slot) => slot.baseOf.includes(orderable));
  const nestedBaseSlot = slots.findIndex((slot) => slot.baseOf.includes(nested));
  const nestedToppingSlot = slots.findIndex((slot) => slot.requiresBaseOf.includes(nested));
  const cupcake = ix.ingByName.get("cupcake-baked")!;
  const cream = ix.ingByName.get("whiping-cream")!;
  const fruit = ix.ingByName.get("kiwi-sliced")!;

  const root = (): DishNode => ({
    kind: "composite",
    id: ids.byNode.composite.get("cupcake-with-cream")!,
    members: [],
  });

  it("refuses a nested topping until that nested composite's base is selected", async () => {
    const { addToSlot, membersOf, unmetSlotBase } = await import("./nodeDishEdit.ts");
    const dish = root();
    addToSlot(ix, ids, dish, orderable, outerBaseSlot, cupcake);

    expect(unmetSlotBase(ix, ids, dish, orderable, nestedToppingSlot)).toBe(nested);
    addToSlot(ix, ids, dish, orderable, nestedToppingSlot, fruit);
    expect(membersOf(ix, ids, dish, orderable, nestedToppingSlot)).toEqual([]);

    addToSlot(ix, ids, dish, orderable, nestedBaseSlot, cream);
    expect(unmetSlotBase(ix, ids, dish, orderable, nestedToppingSlot)).toBe(-1);
    addToSlot(ix, ids, dish, orderable, nestedToppingSlot, fruit);
    expect(membersOf(ix, ids, dish, orderable, nestedToppingSlot)).toEqual([fruit]);
  });
});
