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

  return {
    ...level,
    queues: level.queues.map((lane) =>
      lane.filter((item) => item.kind !== "ingredient" || !rawDisabled.has(item.id)),
    ),
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
