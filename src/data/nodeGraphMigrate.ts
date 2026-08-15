// Converting legacy level data onto the node graph.
//
// Two hops, and the middle one is the whole point:
//
//     legacy id  ->  node name  ->  new data id
//
// The first hop reads the `runtime*Id` fields the graph vertices carry for
// exactly this purpose; the second goes through the id table. Neither side
// ever sees the other's numbering, so the graph is free to renumber without
// touching legacy data and vice versa.
//
// Customer strings need a third step: legacy dishes are FLAT lists of cooked
// ids, while the new format is a bracket tree, so each dish is run through the
// recogniser to recover which composite it is and which slot each item fills.
// That reconstruction is only sound because every servable ingredient maps to
// exactly one slot (INV-ORDER-REBUILDABLE) — a dish the recogniser cannot
// place is reported for hand-review rather than guessed at.
//
// This is the ONLY place the recogniser lives. The runtime reads the bracket
// tree directly, which is the main structural benefit of the new format.
//
// Layering: imports core/parser + core/nodeParser (leaf-ish string modules) and
// data/nodeGraph* — deliberately NOT core/nodeIndex, which would make this
// data -> core -> data.

import { parseCustomers, parseGrid, parseQueues, serializeGrid, serializeQueues } from "../core/parser.ts";
import { serializeNodeCustomers } from "../core/nodeParser.ts";
import type { DishMember, DishNode, NodeCustomerConfig, NodeDish } from "../core/nodeParser.ts";
import { parseQueueGroups } from "../core/parser.ts";
import { CELL_INGREDIENT_SLOT } from "../core/effects.ts";
import type { GridCellConfig } from "../core/types.ts";
import type { LevelData, MapData } from "./mapLoader.ts";
import { buildLookup, slotIndex, slotsOf } from "./nodeGraphResolve.ts";
import { buildIdIndex } from "./nodeIdTable.ts";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";

/** Legacy id space -> new data id, one map per legacy space. */
export interface IdMigration {
  /** Legacy RAW ingredient id -> new ingredient data id. Queue strings use this. */
  raw: Map<number, number>;
  /** Legacy COOKED ingredient id -> new ingredient data id. Customer dishes use this. */
  cooked: Map<number, number>;
  tool: Map<number, number>;
  dirty: Map<number, number>;
}

export interface MigrationReport {
  remaps: { space: "raw" | "cooked" | "tool" | "dirty"; from: number; to: number; node: string }[];
  /** Ids a level string actually uses that no graph vertex claims — the blocking failures. */
  unmappedInUse: { space: "raw" | "cooked"; id: number; levels: number[] }[];
  /** Graph vertices with no legacy counterpart. Expected: the four coated intermediates. */
  newVertices: string[];
  /** Dishes the recogniser could not place, for hand-review. */
  unplacedDishes: { levelId: number; customer: number; dish: number; reason: string }[];
}

/** A level whose three strings speak the new id space. Structurally identical to LevelData. */
export type NodeLevelData = LevelData;

export function buildMigration(doc: NodeGraphMap): IdMigration {
  const ids = buildIdIndex(doc.idTable);
  const migration: IdMigration = { raw: new Map(), cooked: new Map(), tool: new Map(), dirty: new Map() };

  for (const vertex of doc.vertices.ingredient) {
    const newId = ids.byNode.ingredient.get(vertex.name);
    if (newId === undefined) continue;
    // A vertex may carry BOTH — ice is legacy raw 8 and cooked 8. Both legacy
    // spaces then point at the one new id, which is exactly the merge the new
    // single ingredient space is for.
    if (vertex.runtimeRawId !== undefined) migration.raw.set(vertex.runtimeRawId, newId);
    if (vertex.runtimeCookedId !== undefined) migration.cooked.set(vertex.runtimeCookedId, newId);
  }
  for (const vertex of doc.vertices.tool) {
    const newId = ids.byNode.tool.get(vertex.name);
    if (newId !== undefined && vertex.runtimeToolId !== undefined) migration.tool.set(vertex.runtimeToolId, newId);
  }
  for (const vertex of doc.vertices.dirty) {
    const newId = ids.byNode.dirty.get(vertex.name);
    if (newId !== undefined && vertex.runtimeDirtyId !== undefined) migration.dirty.set(vertex.runtimeDirtyId, newId);
  }
  return migration;
}

/** What the recogniser needs: which slot holds an ingredient, and the ids to write. */
interface Recogniser {
  /** New ingredient data id -> where it belongs. */
  placeOf: Map<number, { composite: string; slot: number }>;
  /** Composite name -> its data id and slot descriptors. */
  compositeInfo: Map<string, { id: number; slots: { groupId: number | null }[] }>;
}

function buildRecogniser(doc: NodeGraphMap): Recogniser {
  const lk = buildLookup(doc);
  const ids = buildIdIndex(doc.idTable);
  const { slotOf } = slotIndex(lk);

  const placeOf = new Map<number, { composite: string; slot: number }>();
  for (const [ingredient, place] of slotOf) {
    const dataId = ids.byNode.ingredient.get(ingredient);
    if (dataId !== undefined) placeOf.set(dataId, { composite: place.orderable, slot: place.slot });
  }

  const compositeInfo = new Map<string, { id: number; slots: { groupId: number | null }[] }>();
  for (const orderable of lk.orderables) {
    const id = ids.byNode.composite.get(orderable);
    if (id === undefined) continue;
    const slots = slotsOf(lk, orderable).map((slot) => ({
      groupId: slot.group === null ? null : (ids.byNode.group.get(slot.group) ?? null),
    }));
    compositeInfo.set(orderable, { id, slots });
  }
  return { placeOf, compositeInfo };
}

/**
 * Flat list of new ingredient data ids -> a bracket tree. Returns null with a
 * reason when the dish cannot be placed, so the caller can report it instead of
 * emitting something wrong.
 */
export function recogniseDish(
  rec: Recogniser,
  ingredientIds: number[],
): { dish: NodeDish } | { error: string } {
  if (ingredientIds.length === 0) return { error: "dish has no ingredients" };

  const places = ingredientIds.map((id) => ({ id, place: rec.placeOf.get(id) }));
  const missing = places.filter((p) => !p.place).map((p) => p.id);
  if (missing.length > 0) {
    return { error: `no slot for ingredient id(s) ${[...new Set(missing)].join(", ")}` };
  }

  const composites = new Set(places.map((p) => p.place!.composite));
  if (composites.size > 1) {
    return { error: `mixes ${[...composites].join(" and ")} — a dish must be one orderable` };
  }
  const composite = [...composites][0];
  const info = rec.compositeInfo.get(composite);
  if (!info) return { error: `composite "${composite}" has no id-table entry` };

  // Bucket by slot, preserving the order ingredients appeared in.
  const bySlot = new Map<number, number[]>();
  for (const { id, place } of places) {
    const list = bySlot.get(place!.slot) ?? [];
    list.push(id);
    bySlot.set(place!.slot, list);
  }

  // Emit in slot-tree order, so the base comes first and output is deterministic.
  const members: DishMember[] = [];
  for (let slot = 0; slot < info.slots.length; slot++) {
    const contents = bySlot.get(slot);
    if (!contents || contents.length === 0) continue;
    const groupId = info.slots[slot].groupId;
    if (groupId === null) {
      for (const id of contents) members.push({ kind: "ingredient", id });
    } else {
      members.push({
        kind: "group",
        id: groupId,
        members: contents.map((id) => ({ kind: "ingredient", id }) as DishMember),
      });
    }
  }

  const root: DishNode = { kind: "composite", id: info.id, members };
  return { dish: { root, effects: [] } };
}

/**
 * Grid cells carry GLOBAL cell-effect ids — with exactly one exception. The
 * ingredient-slot cell (CELL_INGREDIENT_SLOT, "#3:<rawId>:<amount>") names a RAW
 * INGREDIENT in its first param, so it has to be remapped like a queue id or the
 * cell would silently start counting a different ingredient.
 *
 * No authored Map 1 level uses it today, which is precisely why it is worth
 * handling here rather than leaving as a trap for the first level that does.
 */
export function migrateGridCells(cells: GridCellConfig[], migration: IdMigration): {
  cells: GridCellConfig[];
  unmappedRaw: number[];
} {
  const unmappedRaw: number[] = [];
  const mapped = cells.map((cell) => ({
    effects: cell.effects.map((effect) => {
      if (effect.effectId !== CELL_INGREDIENT_SLOT || effect.params.length === 0) return effect;
      const to = migration.raw.get(effect.params[0]);
      if (to === undefined) {
        unmappedRaw.push(effect.params[0]);
        return effect;
      }
      return { ...effect, params: [to, ...effect.params.slice(1)] };
    }),
  }));
  return { cells: mapped, unmappedRaw };
}

export interface LevelMigration {
  level: NodeLevelData;
  unmappedRaw: number[];
  unmappedCooked: number[];
  unplaced: { customer: number; dish: number; reason: string }[];
}

export function migrateLevel(level: LevelData, migration: IdMigration, rec: Recogniser): LevelMigration {
  const unmappedRaw: number[] = [];
  const unmappedCooked: number[] = [];
  const unplaced: { customer: number; dish: number; reason: string }[] = [];

  // --- queues: remap raw ids, keep groups and effects untouched ---
  const queues = parseQueues(level.queueString).map((lane) =>
    lane.map((item) => {
      if (item.kind !== "ingredient") return item; // the sweeper keeps its negative id
      const mapped = migration.raw.get(item.id);
      if (mapped === undefined) {
        unmappedRaw.push(item.id);
        return item;
      }
      return { ...item, id: mapped };
    }),
  );
  const queueString = serializeQueues(queues, parseQueueGroups(level.queueString));

  // --- grid: global cell-effect ids, except the ingredient-slot's raw id ---
  const gridResult = migrateGridCells(parseGrid(level.gridString), migration);
  unmappedRaw.push(...gridResult.unmappedRaw);
  const gridString = serializeGrid(gridResult.cells);

  // --- customers: remap cooked ids, then re-bracket each dish ---
  const customers: NodeCustomerConfig[] = parseCustomers(level.customerString).map((customer, ci) => {
    const dishes: NodeDish[] = [];
    customer.dishes.forEach((dish, di) => {
      const mappedIds: number[] = [];
      for (const cookedId of dish.cookedIds) {
        const mapped = migration.cooked.get(cookedId);
        if (mapped === undefined) {
          unmappedCooked.push(cookedId);
          continue;
        }
        mappedIds.push(mapped);
      }
      const result = recogniseDish(rec, mappedIds);
      if ("error" in result) {
        unplaced.push({ customer: ci, dish: di, reason: result.error });
        return;
      }
      dishes.push({ ...result.dish, effects: dish.effects });
    });
    return {
      typeId: customer.typeId,
      waitTime: customer.waitTime,
      weatherEff: customer.weatherEff,
      dishes,
      ...(customer.staffAmount !== undefined ? { staffAmount: customer.staffAmount } : {}),
    };
  });

  return {
    level: { ...level, queueString, gridString, customerString: serializeNodeCustomers(customers) },
    unmappedRaw,
    unmappedCooked,
    unplaced,
  };
}

export function migrateMap(legacy: MapData, doc: NodeGraphMap): { levels: NodeLevelData[]; report: MigrationReport } {
  const migration = buildMigration(doc);
  const rec = buildRecogniser(doc);
  const ids = buildIdIndex(doc.idTable);

  const levels: NodeLevelData[] = [];
  const unmapped = new Map<string, { space: "raw" | "cooked"; id: number; levels: Set<number> }>();

  const unplacedDishes: MigrationReport["unplacedDishes"] = [];
  for (const level of legacy.levels) {
    const result = migrateLevel(level, migration, rec);
    levels.push(result.level);
    for (const [space, list] of [
      ["raw", result.unmappedRaw],
      ["cooked", result.unmappedCooked],
    ] as const) {
      for (const id of list) {
        const key = `${space}:${id}`;
        const entry = unmapped.get(key) ?? { space, id, levels: new Set<number>() };
        entry.levels.add(level.id);
        unmapped.set(key, entry);
      }
    }
    for (const u of result.unplaced) unplacedDishes.push({ levelId: level.id, ...u });
  }

  const remaps: MigrationReport["remaps"] = [];
  for (const vertex of doc.vertices.ingredient) {
    const to = ids.byNode.ingredient.get(vertex.name);
    if (to === undefined) continue;
    if (vertex.runtimeRawId !== undefined) remaps.push({ space: "raw", from: vertex.runtimeRawId, to, node: vertex.name });
    if (vertex.runtimeCookedId !== undefined) {
      remaps.push({ space: "cooked", from: vertex.runtimeCookedId, to, node: vertex.name });
    }
  }

  const newVertices = doc.vertices.ingredient
    .filter((v) => v.runtimeRawId === undefined && v.runtimeCookedId === undefined)
    .map((v) => v.name);

  return {
    levels,
    report: {
      remaps,
      unmappedInUse: [...unmapped.values()].map((u) => ({ space: u.space, id: u.id, levels: [...u.levels].sort((a, b) => a - b) })),
      newVertices,
      unplacedDishes,
    },
  };
}

export { buildRecogniser };
export type { Recogniser };
