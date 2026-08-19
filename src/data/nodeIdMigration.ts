import { parseNodeCustomers, serializeNodeCustomers } from "../core/nodeParser.ts";
import type { DishNode } from "../core/nodeParser.ts";
import { parseQueueGroups, parseQueues, serializeQueues } from "../core/parser.ts";
import type { LevelData } from "./mapLoader.ts";
import type { IdSpace, IdTable } from "./nodeGraphTypes.ts";

export interface LevelIdMigration {
  levels: LevelData[];
  changedLevels: number;
  changedQueueReferences: number;
  changedCustomerReferences: number;
}

function idMap(from: IdTable, to: IdTable, space: IdSpace): Map<number, number> {
  const nextByName = new Map(to[space].map((name, id) => [name, id]));
  return new Map(from[space].map((name, id) => [id, nextByName.get(name) ?? -1]));
}

function remap(id: number, ids: Map<number, number>, context: string): number {
  const next = ids.get(id);
  if (next === undefined || next < 0) throw new Error(`${context} references missing id ${id}`);
  return next;
}

function migrateDishNode(
  node: DishNode,
  ingredientIds: Map<number, number>,
  compositeIds: Map<number, number>,
  groupIds: Map<number, number>,
  changed: { count: number },
): void {
  const ids = node.kind === "composite" ? compositeIds : groupIds;
  const nextNodeId = remap(node.id, ids, `${node.kind} member`);
  if (nextNodeId !== node.id) changed.count++;
  node.id = nextNodeId;
  for (const member of node.members) {
    if (member.kind === "ingredient") {
      const nextIngredientId = remap(member.id, ingredientIds, "customer ingredient");
      if (nextIngredientId !== member.id) changed.count++;
      member.id = nextIngredientId;
    } else {
      migrateDishNode(member, ingredientIds, compositeIds, groupIds, changed);
    }
  }
}

/** True only when every ID space contains exactly the same named rows. */
export function idTablesAreReorders(from: IdTable, to: IdTable): boolean {
  const spaces: IdSpace[] = ["ingredient", "composite", "group", "tool", "dirty"];
  return spaces.every((space) => {
    if (from[space].length !== to[space].length) return false;
    const remaining = new Map<string, number>();
    for (const name of from[space]) remaining.set(name, (remaining.get(name) ?? 0) + 1);
    for (const name of to[space]) {
      const count = remaining.get(name) ?? 0;
      if (count === 0) return false;
      remaining.set(name, count - 1);
    }
    return [...remaining.values()].every((count) => count === 0);
  });
}

/**
 * Rewrites every level reference so each ID continues to resolve to the same
 * named node after a positional ID-table reorder. The input levels are never
 * mutated, and one malformed level aborts the entire operation.
 */
export function migrateLevelsForIdTableReorder(
  levels: LevelData[],
  from: IdTable,
  to: IdTable,
): LevelIdMigration {
  if (!idTablesAreReorders(from, to)) throw new Error("ID-table migration requires a pure reorder");

  const ingredientIds = idMap(from, to, "ingredient");
  const compositeIds = idMap(from, to, "composite");
  const groupIds = idMap(from, to, "group");
  let changedQueueReferences = 0;
  let changedCustomerReferences = 0;
  let changedLevels = 0;

  const migrated = levels.map((level) => {
    try {
      const queues = parseQueues(level.queueString);
      for (const queue of queues) {
        for (const item of queue) {
          if (item.kind !== "ingredient") continue;
          const next = remap(item.id, ingredientIds, "queue ingredient");
          if (next !== item.id) changedQueueReferences++;
          item.id = next;
        }
      }
      const queueString = serializeQueues(queues, parseQueueGroups(level.queueString));

      const customers = parseNodeCustomers(level.customerString);
      const customerChanges = { count: 0 };
      for (const customer of customers) {
        for (const dish of customer.dishes) {
          migrateDishNode(dish.root, ingredientIds, compositeIds, groupIds, customerChanges);
        }
      }
      changedCustomerReferences += customerChanges.count;
      const customerString = serializeNodeCustomers(customers);
      if (queueString === level.queueString && customerString === level.customerString) return level;
      changedLevels++;
      return { ...level, queueString, customerString };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot migrate level "${level.name}" (id ${level.id}): ${message}`);
    }
  });

  return { levels: migrated, changedLevels, changedQueueReferences, changedCustomerReferences };
}
