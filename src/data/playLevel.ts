// Play-mode-only data transform: strips ids the map has disabled (e.g. Map 1's
// bun, raw+cooked id 0) out of the queues and customer orders before the sim
// ever sees them. Design mode calls `toMapDef` directly and never this — a
// designer must still be able to see and edit the underlying ids; only actual
// play skips them, per the ask ("if disabled, on play mode, skip it").

import type { LevelConfig, MapDef } from "../core/types.ts";

export function toPlayableLevelConfig(map: MapDef, level: LevelConfig): LevelConfig {
  if (map.disabledRawIds.length === 0 && map.disabledCookedIds.length === 0) return level;

  const rawDisabled = new Set(map.disabledRawIds);
  const cookedDisabled = new Set(map.disabledCookedIds);
  const keep = (item: (typeof level.queues)[number][number]) =>
    item.kind !== "ingredient" || !rawDisabled.has(item.id);

  // Filtering re-densifies each lane, shifting every row index below a
  // removed item. queueGroups is authored against the *unfiltered* grid, so
  // its coordinates must be remapped or they'd silently point at the wrong
  // cells once a disabled ingredient is filtered out (this only bites on
  // real data — Map 1 disables raw id 0 — so it looks fine in a synthetic
  // test unless one exercises it). newRow[x][oldY] = the new row index, or
  // -1 if that item was filtered away. `x` itself never shifts: this filters
  // *within* each lane and never removes a lane.
  const newRow = level.queues.map((lane) => {
    let next = 0;
    return lane.map((item) => (keep(item) ? next++ : -1));
  });

  const queueGroups = level.queueGroups
    ?.map((g) => ({
      kind: g.kind,
      cells: g.cells
        .map((c) => ({ x: c.x, y: newRow[c.x]?.[c.y] ?? -1 }))
        .filter((c) => c.y !== -1),
    }))
    // A group that merely shrank is still meaningful (a 2x2 combined block
    // losing one cell is still a 3-cell block); below 2 cells there's no
    // grouping semantics left — a 1-cell "combined" moves/picks exactly like
    // a plain item and a 1-cell "linked" fires alone — so dropping it is
    // behavior-preserving and keeps every group-cell enumeration in sim.ts
    // from ever seeing a degenerate list.
    .filter((g) => g.cells.length >= 2);

  return {
    ...level,
    queues: level.queues.map((lane) => lane.filter(keep)),
    // Only emit the field at all when the level had one, so an untouched
    // level's playable form stays structurally identical to its authored one.
    ...(level.queueGroups ? { queueGroups } : {}),
    customers: level.customers.map((customer) => ({
      ...customer,
      dishes: customer.dishes.map((dish) => ({
        ...dish,
        // A dish left with no required ids auto-completes — nothing further
        // to serve for it, which is the correct behavior for "skip reading it".
        cookedIds: dish.cookedIds.filter((id) => !cookedDisabled.has(id)),
      })),
    })),
  };
}
