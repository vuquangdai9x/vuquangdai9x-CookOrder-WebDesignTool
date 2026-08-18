// Binding a parsed dish to the graph.
//
// Because a dish is authored as a bracket tree, this is a direct READ, not a
// recogniser: the outermost {cN:...} names the orderable, each nested {gN:...}
// is a slot, and a bare id is a fixed slot. Gates fall straight out of
// base-vs-topping position, so nothing has to be inferred at runtime.
//
// (The recogniser that turns a legacy FLAT dish into a bracket tree lives only
// in the migration — keeping it out of the runtime is the main structural
// benefit of the bracket format.)
//
// Total on garbage: an id that resolves to nothing, a member in the wrong
// bracket, a group that isn't part of the composite — all become issues, never
// exceptions. This runs on data a designer may be halfway through editing.

import type { GraphIndex } from "./nodeIndex.ts";
import type { DishNode, NodeDish } from "./nodeParser.ts";
import { buildIdIndex } from "../data/nodeIdTable.ts";
import type { IdIndex } from "../data/nodeIdTable.ts";

/** One filled position in a resolved order. */
export interface ResolvedSlot {
  /** Dense ingredient index. */
  ing: number;
  /**
   * The composite slot that must be filled before this one, or -1 when this IS
   * the base. Legacy re-derived the same gate on every serve attempt from the
   * ingredient's `baseId` list; here it is resolved once, off the slot tree,
   * and needs no per-ingredient table at all.
   */
  gate: number;
  /** Which slot of the composite's slot tree this fills; -1 when unmatched. */
  slot: number;
}

export interface ResolvedOrder {
  /** Dense composite index, or -1 when the dish named something unknown. */
  orderable: number;
  slots: ResolvedSlot[];
  /** Dense dirty index, or -1 for the map's generic dirty dish. */
  dirty: number;
}

export type OrderIssue =
  | { kind: "unknown-composite"; id: number }
  | { kind: "unknown-group"; id: number }
  | { kind: "unknown-ingredient"; id: number }
  /** INV-DISH-SINGLE-ORDERABLE: a member that belongs to a different composite. */
  | { kind: "foreign-member"; ingredient: string; belongsTo: string; foundIn: string }
  /** A member placed in a group that is not part of this composite. */
  | { kind: "wrong-group"; group: string; composite: string }
  | { kind: "over-limit"; ingredient: string; limit: number; used: number }
  | { kind: "below-group-minimum"; group: string; minimum: number; used: number }
  /** The composite declares `toppingRequired` but the dish leaves that slot empty. */
  | { kind: "missing-topping"; composite: string };

export interface OrderResolution {
  order: ResolvedOrder;
  issues: OrderIssue[];
}

/** Reusable id lookup, so callers resolving many dishes build it once. */
export function orderIdIndex(ix: GraphIndex): IdIndex {
  return buildIdIndex(ix.doc.idTable);
}

export function resolveOrder(ix: GraphIndex, dish: NodeDish, ids: IdIndex = orderIdIndex(ix)): OrderResolution {
  const issues: OrderIssue[] = [];

  const compositeName = ids.byId.composite.get(dish.root.id);
  if (compositeName === undefined) {
    issues.push({ kind: "unknown-composite", id: dish.root.id });
    return { order: { orderable: -1, slots: [], dirty: -1 }, issues };
  }
  const orderable = ix.compositeByName.get(compositeName) ?? -1;
  if (orderable === -1) {
    issues.push({ kind: "unknown-composite", id: dish.root.id });
    return { order: { orderable: -1, slots: [], dirty: -1 }, issues };
  }

  const slotTree = ix.slotsOfComposite[orderable] ?? [];
  const baseSlot = slotTree.findIndex((s) => s.isBase);

  // Which slot each ingredient of THIS composite belongs to.
  const slotForIng = new Map<number, number>();
  slotTree.forEach((slot, index) => {
    for (const option of slot.options) slotForIng.set(option, index);
  });
  const groupsHere = new Set(slotTree.map((s) => s.group).filter((g) => g !== -1));

  const slots: ResolvedSlot[] = [];
  const usedPerIng = new Map<number, number>();
  const usedPerGroup = new Map<number, number>();

  const walk = (node: DishNode): void => {
    if (node !== dish.root) {
      // Every nested bracket must be a group this composite actually offers.
      // (Nested composites flatten into the same slot tree, so their groups
      // are present here too.)
      const groupName = node.kind === "group" ? ids.byId.group.get(node.id) : ids.byId.composite.get(node.id);
      if (groupName === undefined) {
        issues.push(
          node.kind === "group"
            ? { kind: "unknown-group", id: node.id }
            : { kind: "unknown-composite", id: node.id },
        );
      } else if (node.kind === "group") {
        const groupIndex = ix.groupByName.get(groupName);
        if (groupIndex === undefined || !groupsHere.has(groupIndex)) {
          issues.push({ kind: "wrong-group", group: groupName, composite: compositeName });
        } else {
          usedPerGroup.set(groupIndex, (usedPerGroup.get(groupIndex) ?? 0) + node.members.length);
        }
      }
    }

    for (const member of node.members) {
      if (member.kind !== "ingredient") {
        walk(member);
        continue;
      }
      const name = ids.byId.ingredient.get(member.id);
      if (name === undefined) {
        issues.push({ kind: "unknown-ingredient", id: member.id });
        continue;
      }
      const ing = ix.ingByName.get(name);
      if (ing === undefined) {
        issues.push({ kind: "unknown-ingredient", id: member.id });
        continue;
      }

      const slot = slotForIng.get(ing);
      if (slot === undefined) {
        // INV-DISH-SINGLE-ORDERABLE: this ingredient belongs to some other
        // composite (or none). Record it and keep going — the order still
        // resolves, minus this member.
        // An ingredient may legitimately belong to SEVERAL composites (a
        // shared sauce); name them all, or the message points at one arbitrary
        // home and reads as though the others do not exist.
        const homes = [...new Set((ix.placesOf[ing] ?? []).map((p) => ix.compositeName[p.orderable]))];
        issues.push({
          kind: "foreign-member",
          ingredient: name,
          belongsTo: homes.length > 0 ? homes.join(" / ") : "(no orderable)",
          foundIn: compositeName,
        });
        continue;
      }

      const used = (usedPerIng.get(ing) ?? 0) + 1;
      usedPerIng.set(ing, used);
      // The cap lives on the slot's own option, not on the ingredient: an
      // ingredient fills exactly one slot, so its per-dish limit IS its cap
      // there. See Slot.optionMax.
      const indexed = slotTree[slot];
      const at = indexed?.options.indexOf(ing) ?? -1;
      const limit = at === -1 ? -1 : (indexed.optionMax[at] ?? -1);
      if (limit > 0 && used > limit) {
        issues.push({ kind: "over-limit", ingredient: name, limit, used });
      }

      slots.push({ ing, gate: slot === baseSlot ? -1 : baseSlot, slot });
    }
  };
  walk(dish.root);

  // A group with a positive minimum is mandatory even when its composite's
  // slot would otherwise be optional. An omitted bracket therefore counts as
  // zero and produces the same issue as an under-filled bracket.
  const checkedGroups = new Set<number>();
  for (const slot of slotTree) {
    if (slot.kind !== "group" || slot.group < 0 || !checkedGroups.add(slot.group)) continue;
    const minimum = Math.max(0, slot.minQuantity);
    const used = usedPerGroup.get(slot.group) ?? 0;
    if (used < minimum) {
      issues.push({
        kind: "below-group-minimum",
        group: ix.groupName[slot.group] ?? `group ${slot.group}`,
        minimum,
        used,
      });
    }
  }

  // `toppingRequired` is a property of the COMPOSITE, so it can only be checked
  // once the whole dish has been walked — a topping may sit in any bracket.
  if (ix.doc.vertices.composite[orderable]?.toppingRequired) {
    const filledNonBase = slots.some((s) => s.slot !== baseSlot);
    if (!filledNonBase) issues.push({ kind: "missing-topping", composite: compositeName });
  }

  return {
    order: { orderable, slots, dirty: ix.dirtyOf[orderable] ?? -1 },
    issues,
  };
}

/** Convenience: resolve a whole customer's dishes, tagging issues with their dish index. */
export function resolveDishes(
  ix: GraphIndex,
  dishes: NodeDish[],
  ids: IdIndex = orderIdIndex(ix),
): { orders: ResolvedOrder[]; issues: { dish: number; issue: OrderIssue }[] } {
  const orders: ResolvedOrder[] = [];
  const issues: { dish: number; issue: OrderIssue }[] = [];
  dishes.forEach((dish, index) => {
    const resolved = resolveOrder(ix, dish, ids);
    orders.push(resolved.order);
    for (const issue of resolved.issues) issues.push({ dish: index, issue });
  });
  return { orders, issues };
}

/** Human-readable form for a validation panel or a test failure message. */
export function describeIssue(issue: OrderIssue): string {
  switch (issue.kind) {
    case "unknown-composite":
      return `No composite has id ${issue.id}.`;
    case "unknown-group":
      return `No group has id ${issue.id}.`;
    case "unknown-ingredient":
      return `No ingredient has id ${issue.id}.`;
    case "foreign-member":
      return `"${issue.ingredient}" belongs to ${issue.belongsTo}, but appears inside ${issue.foundIn}.`;
    case "wrong-group":
      return `Group "${issue.group}" is not part of composite "${issue.composite}".`;
    case "over-limit":
      return `"${issue.ingredient}" appears ${issue.used} times but is limited to ${issue.limit} per dish.`;
    case "below-group-minimum":
      return `Group "${issue.group}" requires at least ${issue.minimum} item(s), but this dish has ${issue.used}.`;
    case "missing-topping":
      return `${issue.composite} requires a topping, but this dish has only its base.`;
  }
}
