// Old-string -> bag migration.
//
// Before bags, a pickup that yielded several pieces did so through its PROCESS
// (tomato -> 2 slices). Those edges now yield one piece and the multiplier
// lives on the queue slot instead (`2:2` = a bag of two tomatoes). A level
// authored under the old rule has no ':amount' on any slot; migrating it means
// stamping the former multiplier onto every slot carrying one of those ids, so
// the level supplies exactly as many pieces as it did before.
//
// The multipliers were captured per map when the graphs were rewritten — see
// config/nodegraph/migration/BagMigration-<index>-<name>.json, joined to a
// graph by INDEX exactly like LevelData-*.csv (nodeProject.ts).

import { parseQueueGroups, parseQueues, serializeQueues } from "../core/parser.ts";

export interface BagMigrationLookup {
  /** Key = ingredient DATA id (idTable position), value = former output multiplier. */
  multipliers: Record<string, number>;
  names?: Record<string, string>;
}

const LOOKUP_FILES = import.meta.glob("./config/nodegraph/migration/*.json", {
  eager: true,
}) as Record<string, { default: BagMigrationLookup }>;

/** The lookup shipped for a map index, or null when that map was never migrated. */
export function bagMigrationLookup(mapIndex: number): BagMigrationLookup | null {
  for (const [path, mod] of Object.entries(LOOKUP_FILES)) {
    const file = path.slice(path.lastIndexOf("/") + 1);
    const match = /^BagMigration-(\d+)-.+\.json$/i.exec(file);
    if (match && Number(match[1]) === mapIndex) return mod.default;
  }
  return null;
}

/** An OLD string: it has at least one ingredient slot and none of them carries an amount. */
export function isOldQueueString(queueString: string): boolean {
  let slots = 0;
  for (const lane of parseQueues(queueString)) {
    for (const item of lane) {
      if (item.kind !== "ingredient") continue;
      slots++;
      if ((item.amount ?? 1) > 1) return false;
    }
  }
  return slots > 0;
}

/**
 * Stamps the lookup's multiplier onto every slot carrying one of its ids.
 * Returns the unchanged string when it is not an old string (already migrated,
 * or empty) or when no slot matched, so a caller can compare to detect a change.
 */
export function migrateQueueString(queueString: string, lookup: BagMigrationLookup): string {
  if (!isOldQueueString(queueString)) return queueString;
  const queues = parseQueues(queueString);
  let changed = 0;
  for (const lane of queues) {
    for (const item of lane) {
      if (item.kind !== "ingredient") continue;
      const multiplier = lookup.multipliers[String(item.id)];
      if (multiplier !== undefined && multiplier > 1) {
        item.amount = Math.floor(multiplier);
        changed++;
      }
    }
  }
  return changed === 0 ? queueString : serializeQueues(queues, parseQueueGroups(queueString));
}
