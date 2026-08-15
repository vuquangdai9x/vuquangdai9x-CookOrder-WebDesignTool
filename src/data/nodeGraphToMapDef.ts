// A LOSSY projection of a graph document into the legacy `MapDef` shape.
//
// Used ONLY by the Design UI and the icon layer, never by `nodeSim`. The
// simulation reads the graph directly; this exists because the Design sections
// were written against `MapDef` and reusing them unchanged is worth far more
// than the projection costs.
//
// What survives is exactly what those sections read: names, icons, ids,
// `limit`, `usageNum`, a `baseId` DISPLAY HINT, recipe `amount` (as the whole
// chain's yield, so the "recipe pieces" counters stay truthful), and the grid
// dimensions. What does not survive — chainTools, intermediates, slot trees,
// the composite structure — is exactly what the Design sections never consult.
//
// The ids are DATA IDS from the map's id table, matching what a level string
// carries and what `ui/nodegraph/iconAdapter.ts` feeds the icon layer, so a
// single integer means the same thing everywhere in the node stack.

import type {
  CookedIngredientDef,
  CookingToolDef,
  CustomerConfig,
  DirtyObjectDef,
  LevelConfig,
  MapDef,
  RawIngredientDef,
  ToolRecipe,
} from "../core/types.ts";
import { buildIndex } from "../core/nodeIndex.ts";
import type { GraphIndex } from "../core/nodeIndex.ts";
import { orderIdIndex, resolveOrder } from "../core/nodeOrder.ts";
import type { NodeCustomerConfig } from "../core/nodeParser.ts";
import { parseGrid, parseQueueGroups, parseQueues } from "../core/parser.ts";
import type { LevelData } from "./mapLoader.ts";
import { toNodeLevelConfig } from "./nodeLevel.ts";
import { buildIdIndex } from "./nodeIdTable.ts";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";

export interface ProjectedMap {
  map: MapDef;
  ix: GraphIndex;
  /** Data id -> dense ingredient index, for views that hold one and need the other. */
  denseOf: Map<number, number>;
  /** Dense ingredient index -> data id. */
  dataIdOf: Map<number, number>;
}

export function nodeAsMapDef(doc: NodeGraphMap, ix: GraphIndex = buildIndex(doc)): ProjectedMap {
  const ids = buildIdIndex(doc.idTable);
  const denseOf = new Map<number, number>();
  const dataIdOf = new Map<number, number>();
  for (const [id, name] of ids.byId.ingredient) {
    const dense = ix.ingByName.get(name);
    if (dense === undefined) continue;
    denseOf.set(id, dense);
    dataIdOf.set(dense, id);
  }

  const rawIngredients: RawIngredientDef[] = [];
  const cookedIngredients: CookedIngredientDef[] = [];
  for (const [id, dense] of denseOf) {
    const vertex = doc.vertices.ingredient[dense];
    if (!vertex) continue;
    const shared = {
      id,
      name: vertex.displayName,
      icon: vertex.emoji ?? "❔",
      ...(vertex.fileId ? { fileId: vertex.fileId } : {}),
      ...(vertex.localImage ? { localImage: vertex.localImage } : {}),
    };
    if (vertex.pickupable) {
      rawIngredients.push({
        ...shared,
        code: vertex.code ?? vertex.name,
        price: vertex.price ?? 0,
        // The whole chain's yield, not one hop: a raw chicken breast really
        // does produce one fried piece, through two tools.
        numSlices: ix.terminalYield[dense] || 1,
      });
    }
    if (vertex.servable) {
      cookedIngredients.push({
        ...shared,
        ...(vertex.usageNum && vertex.usageNum > 1 ? { usageNum: vertex.usageNum } : {}),
        ...(vertex.limitPerDish ? { limit: vertex.limitPerDish } : {}),
        ...(baseHintFor(ix, dense, dataIdOf) ?? {}),
      });
    }
  }

  // Recipes are COLLAPSED: one per pickup, from the pickup straight to what it
  // finally becomes, with the intermediate tools expressed as legacy's
  // `chainTools`. Two things fall out of that, and both matter:
  //
  //   * The estimator and any legacy-shaped consumer see chicken-breast
  //     producing chicken-breast-FRIED, not the coated intermediate no dish
  //     wants. A one-hop projection would score chicken at 0 and never pick it
  //     — the exact silent failure the design notes warn about.
  //   * The two-tool COST survives. `chainTools` makes a legacy Simulation hop
  //     the piece through both tools, occupying both, so a difficulty estimate
  //     still pays for the flour step rather than pretending it is free.
  const routes = new Map<number, { tool: number; out: number; amount: number; chainTools: number[] }>();
  for (let dense = 0; dense < ix.ingName.length; dense++) {
    if (!ix.pickupable[dense]) continue;
    const route = collapsedRoute(ix, dense);
    if (route) routes.set(dense, route);
  }

  const tools: CookingToolDef[] = doc.vertices.tool.map((vertex, dense) => {
    const recipes: ToolRecipe[] = [];
    for (const [pickup, route] of routes) {
      if (route.tool !== dense) continue;
      const inId = dataIdOf.get(pickup);
      const outId = dataIdOf.get(route.out);
      if (inId === undefined || outId === undefined) continue;
      recipes.push({
        in: inId,
        out: outId,
        amount: route.amount,
        ...(route.chainTools.length
          ? { chainTools: route.chainTools.map((t) => ids.byNode.tool.get(doc.vertices.tool[t].name) ?? t) }
          : {}),
      });
    }
    return {
      id: ids.byNode.tool.get(vertex.name) ?? dense,
      name: vertex.displayName,
      icon: vertex.emoji ?? "🍳",
      ...(vertex.fileId ? { fileId: vertex.fileId } : {}),
      ...(vertex.localImage ? { localImage: vertex.localImage } : {}),
      numSlots: vertex.numSlots,
      cookingTime: vertex.cookingTime,
      recipes,
      ...(vertex.upgradeCosts ? { upgradeCosts: vertex.upgradeCosts } : {}),
    };
  });

  const dirtyObjects: DirtyObjectDef[] = doc.vertices.dirty.map((vertex, dense) => {
    // Which servable items belong to a composite that leaves this object —
    // a display hint only; the sim reads the leavesDirty edge itself.
    const sources: number[] = [];
    ix.dirtyOf.forEach((dirty, composite) => {
      if (dirty !== dense) return;
      for (const slot of ix.slotsOfComposite[composite] ?? []) {
        if (!slot.isBase) continue;
        for (const option of slot.options) {
          const id = dataIdOf.get(option);
          if (id !== undefined) sources.push(id);
        }
      }
    });
    return {
      id: ids.byNode.dirty.get(vertex.name) ?? dense,
      name: vertex.displayName,
      icon: vertex.emoji ?? "🍽",
      ...(vertex.fileId ? { fileId: vertex.fileId } : {}),
      ...(vertex.localImage ? { localImage: vertex.localImage } : {}),
      sourceCookedId: sources.length === 1 ? sources[0] : sources,
    };
  });

  const map: MapDef = {
    id: 0,
    name: doc.map.name,
    dirtyDishName: doc.vertices.dirty[0]?.displayName ?? "dish",
    gridWidth: doc.map.gridWidth,
    gridHeight: doc.map.gridHeight,
    dirtyStackHeight: doc.map.dirtyStackHeight,
    visibleRows: doc.map.visibleRows,
    rawIngredients,
    cookedIngredients,
    dirtyObjects,
    customerAvatars: [],
    tools,
    levels: [],
    disabledRawIds: [],
    disabledCookedIds: [],
  };

  return { map, ix, denseOf, dataIdOf };
}

/**
 * A node level in the legacy `LevelConfig` shape, so tools written against it —
 * the difficulty estimator above all — run on node data unchanged.
 *
 * The lossy part is the dish: a bracket tree becomes the flat list of data ids
 * it resolves to. That is exactly the direction the migration proved lossless
 * in reverse, and the gate survives anyway, carried by the projected `baseId`
 * hint on each servable item.
 */
export function nodeLevelAsLevelConfig(projected: ProjectedMap, data: LevelData): LevelConfig {
  const node = toNodeLevelConfig(data);
  const ids = orderIdIndex(projected.ix);
  const customers: CustomerConfig[] = node.customers.map((customer: NodeCustomerConfig) => ({
    typeId: customer.typeId,
    waitTime: customer.waitTime,
    weatherEff: customer.weatherEff,
    dishes: customer.dishes.map((dish) => {
      const { order } = resolveOrder(projected.ix, dish, ids);
      const cookedIds: number[] = [];
      for (const slot of order.slots) {
        const id = projected.dataIdOf.get(slot.ing);
        if (id !== undefined) cookedIds.push(id);
      }
      return { cookedIds, effects: dish.effects };
    }),
    ...(customer.staffAmount !== undefined ? { staffAmount: customer.staffAmount } : {}),
  }));

  return {
    id: data.id,
    name: data.name,
    weather: data.weather,
    levelTag: data.levelTag,
    featureUnlock: data.featureUnlock,
    shuffleDistance: data.shuffleDistance,
    serveableSlots: data.serveableSlots,
    queues: parseQueues(data.queueString),
    queueGroups: parseQueueGroups(data.queueString),
    grid: parseGrid(data.gridString),
    customers,
    ...(data.outOfSlotPolicy ? { outOfSlotPolicy: data.outOfSlotPolicy } : {}),
    ...(data.boosterCharges ? { boosterCharges: data.boosterCharges } : {}),
  };
}

/**
 * Every tool a pickup passes through on its way to what it finally becomes,
 * flattened into legacy's one-recipe-plus-chainTools shape.
 *
 * Both graph spellings of a multi-tool route collapse the same way here:
 * potato's single edge already carries `chainTools`, while chicken's two edges
 * through a real coated intermediate contribute one tool each. The runtime
 * distinction between them is real and the node sim keeps it; a legacy-shaped
 * consumer only needs to know it costs two tool visits and yields one piece.
 *
 * Guarded against cyclic data — INV-ACYCLIC reports that separately, and this
 * must stay total.
 */
function collapsedRoute(
  ix: GraphIndex,
  pickup: number,
): { tool: number; out: number; amount: number; chainTools: number[] } | null {
  const first = ix.recipeForInput[pickup];
  if (!first) return null;
  const chainTools: number[] = [...first.chainTools];
  let amount = first.amount;
  let current = first.out;
  const seen = new Set<number>([pickup]);

  // Follow the chain exactly as GraphIndex.terminalOutput does — until the
  // output is servable, or nothing consumes it.
  while (!ix.servable[current] && !seen.has(current)) {
    seen.add(current);
    const next = ix.recipeForInput[current];
    if (!next) break;
    chainTools.push(next.tool, ...next.chainTools);
    amount *= next.amount;
    current = next.out;
  }
  return { tool: first.tool, out: current, amount, chainTools };
}

/**
 * The `baseId` a Design section would show for a servable item: the data ids of
 * its composite's base slot, when this item is NOT itself the base. Purely a
 * hint for the dish editor's ordering — the runtime gate comes from the
 * resolved order, not from here.
 */
function baseHintFor(
  ix: GraphIndex,
  dense: number,
  dataIdOf: Map<number, number>,
): { baseId: number | number[] } | null {
  const place = ix.slotOf[dense];
  if (!place) return null;
  const slots = ix.slotsOfComposite[place.orderable] ?? [];
  if (slots[place.slot]?.isBase) return null;
  const base = slots.find((s) => s.isBase);
  if (!base) return null;
  const options = base.options.map((o) => dataIdOf.get(o)).filter((id): id is number => id !== undefined);
  if (options.length === 0) return null;
  return { baseId: options.length === 1 ? options[0] : options };
}
