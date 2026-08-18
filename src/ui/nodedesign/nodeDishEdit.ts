import type { GraphIndex, IndexedSlot } from "../../core/nodeIndex.ts";
import type { DishNode } from "../../core/nodeParser.ts";
import type { IdIndex } from "../../data/nodeIdTable.ts";

export function slotCapacity(slot: IndexedSlot): number {
  if (slot.kind === "fixed") return 1;
  return slot.maxQuantity < 0 ? Number.POSITIVE_INFINITY : Math.max(1, slot.maxQuantity);
}

function groupCapacity(ix: GraphIndex, group: number): number {
  const maximum = ix.doc.vertices.group[group]?.maxQuantity ?? -1;
  return maximum < 0 ? Number.POSITIVE_INFINITY : Math.max(0, maximum);
}

function containerFor(
  ids: IdIndex,
  ix: GraphIndex,
  root: DishNode,
  slot: IndexedSlot,
  create: boolean,
  makeRoom = false,
): DishNode | null {
  if (slot.groupPath.length === 0) return root;
  let container = root;
  for (let depth = 0; depth < slot.groupPath.length; depth++) {
    const group = slot.groupPath[depth];
    const groupId = ids.byNode.group.get(ix.groupName[group]);
    if (groupId === undefined) return null;
    let child = container.members.find((member): member is DishNode => member.kind === "group" && member.id === groupId);
    if (depth > 0 && makeRoom) {
      const capacity = groupCapacity(ix, slot.groupPath[depth - 1]);
      if (capacity <= 0) return null;
      while (container.members.length >= capacity + (child ? 1 : 0)) {
        const removeAt = child ? container.members.findIndex((member) => member !== child) : 0;
        if (removeAt < 0) break;
        container.members.splice(removeAt, 1);
      }
    }
    if (!child) {
      if (!create) return null;
      child = { kind: "group", id: groupId, members: [] };
      container.members.push(child);
    }
    container = child;
  }
  return container;
}

function removeEmptyGroupPath(ids: IdIndex, ix: GraphIndex, root: DishNode, slot: IndexedSlot): void {
  const chain: { parent: DishNode; child: DishNode }[] = [];
  let parent = root;
  for (const group of slot.groupPath) {
    const groupId = ids.byNode.group.get(ix.groupName[group]);
    if (groupId === undefined) return;
    const child = parent.members.find((member): member is DishNode => member.kind === "group" && member.id === groupId);
    if (!child) return;
    chain.push({ parent, child });
    parent = child;
  }
  for (let index = chain.length - 1; index >= 0; index--) {
    const { parent: owner, child } = chain[index];
    if (child.members.length > 0) break;
    const at = owner.members.indexOf(child);
    if (at >= 0) owner.members.splice(at, 1);
  }
}

export function membersOf(
  ix: GraphIndex,
  ids: IdIndex,
  root: DishNode,
  orderable: number,
  slotIndex: number,
): number[] {
  const slot = ix.slotsOfComposite[orderable]?.[slotIndex];
  if (!slot) return [];
  const container = containerFor(ids, ix, root, slot, false);
  if (!container) return [];
  const out: number[] = [];
  for (const member of container.members) {
    if (member.kind !== "ingredient") continue;
    const name = ids.byId.ingredient.get(member.id);
    const ing = name === undefined ? undefined : ix.ingByName.get(name);
    if (ing !== undefined && slot.options.includes(ing)) out.push(ing);
  }
  return out;
}

export function addToSlot(
  ix: GraphIndex,
  ids: IdIndex,
  root: DishNode,
  orderable: number,
  slotIndex: number,
  ing: number,
): void {
  const slot = ix.slotsOfComposite[orderable]?.[slotIndex];
  if (!slot) return;
  const container = containerFor(ids, ix, root, slot, true, true);
  if (!container) return;
  const dataId = ids.byNode.ingredient.get(ix.ingName[ing]);
  if (dataId === undefined) return;

  const capacity = slot.groupPath.length > 0
    ? groupCapacity(ix, slot.groupPath[slot.groupPath.length - 1])
    : slotCapacity(slot);
  if (capacity <= 0) return;
  if (slot.groupPath.length > 0) {
    while (container.members.length >= capacity) container.members.shift();
  } else {
    let held = membersOf(ix, ids, root, orderable, slotIndex).length;
    while (held >= capacity) {
      const at = container.members.findIndex((member) => member.kind === "ingredient");
      if (at === -1) break;
      container.members.splice(at, 1);
      held--;
    }
  }
  container.members.push({ kind: "ingredient", id: dataId });
}

export function removeFromSlot(
  ix: GraphIndex,
  ids: IdIndex,
  root: DishNode,
  orderable: number,
  slotIndex: number,
  occurrence: number,
): void {
  const slot = ix.slotsOfComposite[orderable]?.[slotIndex];
  if (!slot) return;
  const container = containerFor(ids, ix, root, slot, false);
  if (!container) return;
  let seen = 0;
  for (let index = 0; index < container.members.length; index++) {
    const member = container.members[index];
    if (member.kind !== "ingredient") continue;
    const name = ids.byId.ingredient.get(member.id);
    const ing = name === undefined ? undefined : ix.ingByName.get(name);
    if (ing === undefined || !slot.options.includes(ing)) continue;
    if (seen++ !== occurrence) continue;
    container.members.splice(index, 1);
    break;
  }
  if (container !== root && container.members.length === 0) removeEmptyGroupPath(ids, ix, root, slot);
}

export function swapInSlot(
  ix: GraphIndex,
  ids: IdIndex,
  root: DishNode,
  orderable: number,
  slotIndex: number,
  occurrence: number,
  next: number,
): void {
  const slot = ix.slotsOfComposite[orderable]?.[slotIndex];
  if (!slot) return;
  const container = containerFor(ids, ix, root, slot, false);
  const dataId = ids.byNode.ingredient.get(ix.ingName[next]);
  if (!container || dataId === undefined) return;
  let seen = 0;
  for (const member of container.members) {
    if (member.kind !== "ingredient") continue;
    const name = ids.byId.ingredient.get(member.id);
    const ing = name === undefined ? undefined : ix.ingByName.get(name);
    if (ing === undefined || !slot.options.includes(ing)) continue;
    if (seen++ !== occurrence) continue;
    member.id = dataId;
    break;
  }
}
