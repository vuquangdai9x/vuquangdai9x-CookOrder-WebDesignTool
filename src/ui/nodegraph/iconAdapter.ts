// Projecting a node graph into the shape `ui/icon.ts` and `ui/imagePreload.ts`
// already understand.
//
// Both read an ambient "active map" through four arrays keyed by INTEGER ID:
// rawIngredients, cookedIngredients, dirtyObjects, tools. That module has one
// `let activeMap`, set by the shell, and every `ingredientIconEl(id)` call in
// the codebase reads it. Rather than teach `icon.ts` about the graph — which
// would mean editing legacy code every renderer depends on — the graph is
// projected into that same shape here. **Zero change to icon.ts.**
//
// Two things make the projection exact rather than approximate:
//
//   * The ids are DATA IDS from the map's id table, not dense indices, because
//     that is what a level string carries and therefore what a view has in hand
//     when it asks for an icon.
//   * The new system has ONE ingredient space, so the SAME array is handed to
//     both `rawIngredients` and `cookedIngredients`. A pickup and a servable
//     item are the same vertex now; giving icon.ts two views of one list is how
//     that fact survives an interface built around the old split.
//
// Only the four structural fields icon.ts actually reads (name, icon, fileId,
// localImage) carry real data. The rest exist to satisfy the legacy interfaces
// and are never consulted for rendering.

import type {
  CookedIngredientDef,
  CookingToolDef,
  DirtyObjectDef,
  RawIngredientDef,
} from "../../core/types.ts";
import { buildIdIndex } from "../../data/nodeIdTable.ts";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";

/** Structurally satisfies both `IconMapSource` (icon.ts) and `ImageBearingMap` (imagePreload.ts). */
export interface NodeIconSource {
  rawIngredients: RawIngredientDef[];
  cookedIngredients: CookedIngredientDef[];
  dirtyObjects: DirtyObjectDef[];
  tools: CookingToolDef[];
}

export function nodeIconSource(doc: NodeGraphMap): NodeIconSource {
  const ids = buildIdIndex(doc.idTable);

  const byName = new Map(doc.vertices.ingredient.map((v) => [v.name, v]));
  const ingredients: RawIngredientDef[] = [];
  for (const [id, name] of ids.byId.ingredient) {
    const vertex = byName.get(name);
    if (!vertex) continue; // the id table names a vertex that no longer exists — INV-IDTABLE-RESOLVES reports it
    ingredients.push({
      id,
      name: vertex.displayName,
      icon: vertex.emoji ?? "❔",
      ...(vertex.fileId ? { fileId: vertex.fileId } : {}),
      ...(vertex.localImage ? { localImage: vertex.localImage } : {}),
      // Legacy-shaped fields icon.ts never reads; present so the type holds.
      code: vertex.code ?? vertex.name,
      price: vertex.price ?? 0,
      numSlices: 1, // icon.ts never reads it; the real yield comes from the process chain
    });
  }

  const toolByName = new Map(doc.vertices.tool.map((v) => [v.name, v]));
  const tools: CookingToolDef[] = [];
  for (const [id, name] of ids.byId.tool) {
    const vertex = toolByName.get(name);
    if (!vertex) continue;
    tools.push({
      id,
      name: vertex.displayName,
      icon: vertex.emoji ?? "🍳",
      ...(vertex.fileId ? { fileId: vertex.fileId } : {}),
      ...(vertex.localImage ? { localImage: vertex.localImage } : {}),
      numSlots: (vertex.slotConfigs ?? []).reduce((n, c) => n + Math.max(1, c.slot), 0) || 1,
      cookingTime: vertex.cookingTime,
      recipes: [],
    });
  }

  const dirtyByName = new Map(doc.vertices.dirty.map((v) => [v.name, v]));
  const dirtyObjects: DirtyObjectDef[] = [];
  for (const [id, name] of ids.byId.dirty) {
    const vertex = dirtyByName.get(name);
    if (!vertex) continue;
    dirtyObjects.push({
      id,
      name: vertex.displayName,
      icon: vertex.emoji ?? "🍽",
      ...(vertex.fileId ? { fileId: vertex.fileId } : {}),
      ...(vertex.localImage ? { localImage: vertex.localImage } : {}),
      sourceCookedId: -1, // the graph states this with a leavesDirty edge instead
    });
  }

  // One ingredient space: the same array, deliberately, under both names.
  return { rawIngredients: ingredients, cookedIngredients: ingredients, dirtyObjects, tools };
}
