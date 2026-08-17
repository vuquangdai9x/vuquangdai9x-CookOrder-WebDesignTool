// Projecting a legacy MapDef into a node graph — a TEST AND DEV adapter.
//
// Two jobs, both of them scaffolding rather than product:
//
//  1. Parity. Phase 4 drives `Simulation` and `NodeSimulation` with the same
//     script and asserts they agree. That is only a fair test if both read the
//     SAME rules, so this emits the RUNTIME-FAITHFUL graph — chicken goes
//     straight to the fryer here, with no flour step. burger.json deliberately
//     diverges from the runtime on exactly that point, so parity must not be
//     run against it.
//  2. Bootstrapping. A second map can be lifted into the editor from its
//     existing config instead of being redrawn by hand.
//
// The interesting part is inferring COMPOSITES, which legacy simply does not
// have. Legacy dishes are flat lists of cooked ids joined only by the
// `baseId` gate, so the composite structure has to be recovered:
//
//   * a topping is joined to every base it names in `baseId`;
//   * two cooked ids that appear TOGETHER in any authored dish are joined,
//     because a dish must resolve to one orderable.
//
// The connected components of that relation are the composites. Within one,
// the members with no `baseId` form the base slot and the rest form a single
// MULTIPLE topping group.
//
// Two deliberate imprecisions, both permissive rather than restrictive:
//   * the base slot is emitted as MULTIPLE even when the legacy data only ever
//     orders one member of it — legacy imposed no cardinality at all, and a
//     stricter slot would reject data the runtime accepts;
//   * a topping gates on the whole family's base slot rather than on its own
//     `baseId` subset, so a dish with two bases in one family can serve a
//     topping after either. Legacy's `baseId: Id[]` is already "any one of
//     these", so this only widens an existing OR.
//
// Neither imprecision can make a legal legacy dish illegal, which is the
// property parity needs.

import { findToolRecipe, resolveCookedId } from "./types.ts";
import type { CustomerConfig, LevelConfig, MapDef, QueueItem } from "./types.ts";
import type { NodeCustomerConfig, NodeDish } from "./nodeParser.ts";
import type { NodeLevelConfig } from "./nodeSim.ts";
import { buildMigration, buildRecogniser, migrateGridCells, recogniseDish } from "../data/nodeGraphMigrate.ts";
import type { LegacyNames } from "../data/nodeGraphMigrate.ts";
import type {
  CompositeVertex,
  DirtyVertex,
  GroupVertex,
  IdSpace,
  IngredientVertex,
  NodeGraphMap,
  ToolVertex,
} from "../data/nodeGraphTypes.ts";

/** Vertex name for a legacy COOKED ingredient id. */
/**
 * The adapter's naming scheme, exported.
 *
 * Tests need to address "the vertex legacy cooked id 3 became". That used to be
 * done by stamping `runtimeCookedId` onto the vertex — which put a LEGACY
 * concern into the shipped map format, where every authored map carried a field
 * only a test adapter ever read. The names are already a pure function of the
 * id, so exposing the function says the same thing and costs the data nothing.
 */
export const cookedName = (id: number) => `ck${id}`;
/** Vertex name for a legacy RAW ingredient id that needs a tool. */
export const rawName = (id: number) => `rw${id}`;
export const toolName = (id: number) => `tl${id}`;
export const dirtyName = (id: number) => `dt${id}`;

class UnionFind {
  private parent = new Map<number, number>();

  add(x: number): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }

  find(x: number): number {
    this.add(x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path compression, so a long topping chain doesn't degrade.
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  /** Members grouped by root, each list sorted ascending. */
  components(): number[][] {
    const byRoot = new Map<number, number[]>();
    for (const x of this.parent.keys()) {
      const root = this.find(x);
      const list = byRoot.get(root) ?? [];
      list.push(x);
      byRoot.set(root, list);
    }
    return [...byRoot.values()].map((list) => list.sort((a, b) => a - b));
  }
}

const basesOf = (baseId: number | number[] | undefined): number[] =>
  baseId === undefined ? [] : Array.isArray(baseId) ? baseId : [baseId];

/**
 * True when the legacy runtime could never finish this dish: it holds an
 * ingredient whose `baseId` names bases the dish does not contain, so
 * `baseRequirementMet` can never become true and the order stalls forever.
 *
 * Such a dish is EXCLUDED from co-occurrence mining below. Co-occurrence is
 * evidence about how the runtime groups items — and a dish the runtime can
 * never serve is not evidence of anything. Including it merges families the
 * runtime keeps apart, which then shows up as a real behavioural difference:
 * Map 1's `13.16` (fried potato + cheese sauce) would drag fried potato into
 * the chicken family, and every plain-fries order would start leaving a dirty
 * chick box that the runtime never produced.
 */
function legacyUnsatisfiable(cookedIds: number[], map: MapDef): boolean {
  return cookedIds.some((id) => {
    const bases = basesOf(map.cookedIngredients.find((c) => c.id === id)?.baseId);
    return bases.length > 0 && !bases.some((b) => cookedIds.includes(b));
  });
}

/**
 * @param levels Dishes to mine for co-occurrence. Defaults to the map's own
 *   levels; test fixtures build levels separately and must pass them in, or
 *   every cooked ingredient lands in a composite of its own and a two-item dish
 *   becomes unresolvable.
 */
/**
 * The vertex a legacy RAW id picks up as.
 *
 * The only case where the name is not a plain function of the id: a raw with no
 * recipe IS its cooked form, so the two legacy ids converge on one vertex.
 */
export function pickupName(map: MapDef, rawId: number): string {
  if (findToolRecipe(map.tools, rawId)) return rawName(rawId);
  return cookedName(resolveCookedId(map.tools, map.rawIngredients, rawId));
}

export function legacyToGraph(map: MapDef, levels: LevelConfig[] = map.levels): NodeGraphMap {
  // ---------- ingredients ----------
  const ingredient: IngredientVertex[] = [];
  const byName = new Map<string, IngredientVertex>();

  const ensureCooked = (id: number): IngredientVertex => {
    const name = cookedName(id);
    const existing = byName.get(name);
    if (existing) return existing;
    const def = map.cookedIngredients.find((c) => c.id === id);
    const vertex: IngredientVertex = {
      name,
      displayName: def?.name ?? `cooked${id}`,
      servable: true,
      ...(def?.usageNum && def.usageNum > 1 ? { usageNum: def.usageNum } : {}),
      ...(def?.limit ? { limitPerDish: def.limit } : {}),
      ...(def?.localImage ? { localImage: def.localImage } : {}),
      ...(def?.fileId ? { fileId: def.fileId } : {}),
    };
    ingredient.push(vertex);
    byName.set(name, vertex);
    return vertex;
  };

  for (const def of map.cookedIngredients) ensureCooked(def.id);

  /** Vertex name a legacy raw id picks up as. */
  const pickupVertex = new Map<number, string>();
  for (const raw of map.rawIngredients) {
    if (findToolRecipe(map.tools, raw.id)) {
      // Needs a tool: a distinct, non-servable pickup vertex.
      const vertex: IngredientVertex = {
        name: rawName(raw.id),
        displayName: raw.name,
        pickupable: true,
        ...(raw.numSlices ? { numSlices: raw.numSlices } : {}),
        ...(raw.price ? { price: raw.price } : {}),
        ...(raw.code ? { code: raw.code } : {}),
        ...(raw.localImage ? { localImage: raw.localImage } : {}),
        ...(raw.fileId ? { fileId: raw.fileId } : {}),
      };
      ingredient.push(vertex);
      byName.set(vertex.name, vertex);
      pickupVertex.set(raw.id, vertex.name);
      continue;
    }
    // No tool: this raw IS its cooked form, so the two legacy ids converge on
    // one vertex — exactly the case legacy handled with mirrored numbering.
    const cooked = ensureCooked(resolveCookedId(map.tools, map.rawIngredients, raw.id));
    cooked.pickupable = true;
    pickupVertex.set(raw.id, cooked.name);
  }

  // ---------- tools and recipes ----------
  const tool: ToolVertex[] = map.tools.map((t) => ({
    name: toolName(t.id),
    displayName: t.name,
    // Legacy tools are single-input, so each becomes ONE slot point whose
    // lane count is the old numSlots — the shape that reproduces legacy
    // behaviour exactly, which is what the parity test depends on.
    slotConfigs: [{ name: "Slot", slot: t.numSlots }],
    cookingTime: t.cookingTime,
    runtimeToolId: t.id,
    ...(t.upgradeCosts ? { upgradeCosts: t.upgradeCosts } : {}),
    ...(t.localImage ? { localImage: t.localImage } : {}),
    ...(t.fileId ? { fileId: t.fileId } : {}),
  }));

  const process = map.tools.flatMap((t) =>
    t.recipes.map((r) => ({
      from: toolName(t.id),
      to: ensureCooked(r.out).name,
      inputs: [{ ingredient: pickupVertex.get(r.in) ?? rawName(r.in), slot: 0 }],
      amount: r.amount,
      ...(r.chainTools?.length ? { chainTools: r.chainTools.map(toolName) } : {}),
    })),
  );

  // ---------- composites, inferred ----------
  const uf = new UnionFind();
  for (const def of map.cookedIngredients) {
    uf.add(def.id);
    for (const base of basesOf(def.baseId)) uf.union(def.id, base);
  }
  for (const level of levels) {
    for (const customer of level.customers) {
      for (const dish of customer.dishes) {
        const ids = dish.cookedIds;
        if (legacyUnsatisfiable(ids, map)) continue;
        for (let i = 1; i < ids.length; i++) uf.union(ids[0], ids[i]);
        if (ids.length === 1) uf.add(ids[0]);
      }
    }
  }

  const composite: CompositeVertex[] = [];
  const group: GroupVertex[] = [];
  const base: { from: string; to: string }[] = [];
  const topping: { from: string; to: string }[] = [];
  const option: { from: string; to: string; maxQuantity?: number }[] = [];
  /** Cooked id -> the composite it lives in, for the dirty wiring below. */
  const familyOf = new Map<number, string>();

  const components = uf.components();
  components.forEach((members, index) => {
    const name = `comp${index}`;
    const displayName =
      map.cookedIngredients.find((c) => c.id === members[0])?.name ?? `Composite ${index}`;
    composite.push({ name, displayName, orderable: true });
    for (const id of members) familyOf.set(id, name);

    const bases = members.filter((id) => {
      const def = map.cookedIngredients.find((c) => c.id === id);
      return basesOf(def?.baseId).length === 0;
    });
    const toppings = members.filter((id) => !bases.includes(id));

    if (bases.length === 1) {
      base.push({ from: name, to: cookedName(bases[0]) });
    } else if (bases.length > 1) {
      const groupName = `${name}-bases`;
      // Uncapped: legacy imposed no cardinality on a baseless cooked id, so a
      // dish may legitimately hold two of them.
      group.push({ name: groupName, displayName: `${displayName} bases`, maxQuantity: -1 });
      base.push({ from: name, to: groupName });
      for (const id of bases) option.push({ from: groupName, to: cookedName(id), maxQuantity: -1 });
    }

    if (toppings.length > 0) {
      const groupName = `${name}-toppings`;
      group.push({
        name: groupName,
        displayName: `${displayName} toppings`,
        maxQuantity: -1,
      });
      topping.push({ from: name, to: groupName });
      for (const id of toppings) option.push({ from: groupName, to: cookedName(id), maxQuantity: -1 });
    }
  });

  // ---------- dirty objects ----------
  const dirty: DirtyVertex[] = map.dirtyObjects.map((d) => ({
    name: dirtyName(d.id),
    displayName: d.name,
    runtimeDirtyId: d.id,
    ...(d.localImage ? { localImage: d.localImage } : {}),
    ...(d.fileId ? { fileId: d.fileId } : {}),
  }));

  const leavesDirty: { from: string; to: string }[] = [];
  const claimed = new Set<string>();
  for (const def of map.dirtyObjects) {
    const sources = Array.isArray(def.sourceCookedId) ? def.sourceCookedId : [def.sourceCookedId];
    for (const source of sources) {
      const family = familyOf.get(source);
      // One leavesDirty edge per composite (maxOutgoingPerSource = 1); the
      // first dirty object claiming a family wins, matching legacy's first-hit
      // scan over dirtyObjects.
      if (!family || claimed.has(family)) continue;
      claimed.add(family);
      leavesDirty.push({ from: family, to: dirtyName(def.id) });
    }
  }

  // ---------- id table ----------
  // The table is ordered names; a row's index is its id.
  const idTable: Record<IdSpace, string[]> = {
    ingredient: ingredient.map((v) => v.name),
    composite: composite.map((v) => v.name),
    group: group.map((v) => v.name),
    tool: tool.map((v) => v.name),
    dirty: dirty.map((v) => v.name),
  };

  return {
    schemaVersion: 1,
    map: {
      id: `legacy-${map.id}`,
      name: map.name,
      gridWidth: map.gridWidth,
      gridHeight: map.gridHeight,
      dirtyStackHeight: map.dirtyStackHeight,
      visibleRows: map.visibleRows,
    },
    idTable,
    vertices: { ingredient, tool, group, composite, dirty },
    edges: { process, base, topping, option, leavesDirty },
  };
}

export interface LevelProjection {
  level: NodeLevelConfig;
  /** Dishes the recogniser could not place — the same report shape the migration uses. */
  unplaced: { customer: number; dish: number; reason: string }[];
}

/**
 * Recover "which vertex did legacy id N become" from a graph THIS adapter built.
 *
 * The naming scheme is the mapping — `rw3`/`ck3`/`tl3`/`dt3` — so it can be read
 * straight back off the vertex names, with no legacy ids stored in the data.
 * The one subtlety is the merge: a raw with no recipe IS its cooked form, so it
 * has no `rw` vertex and its id resolves to the `ck` one instead (legacy raw and
 * cooked ids mirror, which is what makes that a same-number lookup).
 *
 * Only meaningful for adapter-produced graphs. An authored map has no legacy
 * counterpart and yields empty maps, which is correct: nothing to migrate.
 */
export function legacyNamesOf(doc: NodeGraphMap): LegacyNames {
  const names = {
    raw: new Map<number, string>(),
    cooked: new Map<number, string>(),
    tool: new Map<number, string>(),
    dirty: new Map<number, string>(),
  };
  const have = new Set(doc.vertices.ingredient.map((v) => v.name));

  const idOfPrefix = (name: string, prefix: string): number | null => {
    if (!name.startsWith(prefix)) return null;
    const n = Number(name.slice(prefix.length));
    return Number.isInteger(n) ? n : null;
  };

  for (const vertex of doc.vertices.ingredient) {
    const cooked = idOfPrefix(vertex.name, "ck");
    if (cooked !== null) {
      names.cooked.set(cooked, vertex.name);
      // Merged: no separate rw vertex means this one is also the pickup.
      if (!have.has(rawName(cooked))) names.raw.set(cooked, vertex.name);
      continue;
    }
    const raw = idOfPrefix(vertex.name, "rw");
    if (raw !== null) names.raw.set(raw, vertex.name);
  }
  for (const vertex of doc.vertices.tool) {
    const id = idOfPrefix(vertex.name, "tl");
    if (id !== null) names.tool.set(id, vertex.name);
  }
  for (const vertex of doc.vertices.dirty) {
    const id = idOfPrefix(vertex.name, "dt");
    if (id !== null) names.dirty.set(id, vertex.name);
  }
  return names;
}

/**
 * Projects one parsed legacy level onto a graph produced by legacyToGraph().
 * Queue and grid geometry pass straight through; only the ids change, and the
 * flat dishes become bracket trees.
 */
export function legacyLevelToNode(doc: NodeGraphMap, level: LevelConfig): LevelProjection {
  const migration = buildMigration(doc, legacyNamesOf(doc));
  const rec = buildRecogniser(doc);
  const unplaced: { customer: number; dish: number; reason: string }[] = [];

  const queues: QueueItem[][] = level.queues.map((lane) =>
    lane.map((item) => {
      if (item.kind !== "ingredient") return item; // the sweeper keeps its negative id
      const mapped = migration.raw.get(item.id);
      return mapped === undefined ? item : { ...item, id: mapped };
    }),
  );

  const customers: NodeCustomerConfig[] = level.customers.map((customer: CustomerConfig, ci) => {
    const dishes: NodeDish[] = [];
    customer.dishes.forEach((dish, di) => {
      const ids = dish.cookedIds.map((id) => migration.cooked.get(id)).filter((id): id is number => id !== undefined);
      const result = recogniseDish(rec, ids);
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
    level: {
      id: level.id,
      name: level.name,
      weather: level.weather,
      levelTag: level.levelTag,
      featureUnlock: level.featureUnlock,
      shuffleDistance: level.shuffleDistance,
      serveableSlots: level.serveableSlots,
      queues,
      ...(level.queueGroups ? { queueGroups: level.queueGroups } : {}),
      // Cell effects are global except the ingredient-slot's raw id — see
      // migrateGridCells(); without this an ingredient-slot cell would keep
      // counting whatever legacy raw happened to inherit that number.
      grid: migrateGridCells(level.grid, migration).cells,
      customers,
      ...(level.outOfSlotPolicy ? { outOfSlotPolicy: level.outOfSlotPolicy } : {}),
      ...(level.boosterCharges ? { boosterCharges: level.boosterCharges } : {}),
    },
    unplaced,
  };
}
