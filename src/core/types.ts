// Core data model for the CookOrder level design tool.
// Pure types — no DOM, no runtime deps. See docs/GDD.md §4 and §7.

/** All designer-facing elements are keyed by integer ids. */
export type Id = number;

/** One attached effect instance: effect definition id + ordered params. */
export interface EffectInstance {
  effectId: Id;
  params: number[];
}

/** Param schema entry inside a definition table row. */
export interface ParamDef {
  name: string;
  dataType: "int" | "float" | "string" | "bool";
}

/** Shared shape of designer-editable definition rows (effects, cell types, customer types). */
export interface ElementDef {
  id: Id;
  name: string;
  /** Emoji fallback, used when neither the local nor the Drive image loads. */
  icon: string;
  /** Google Drive file id of the artwork — fallback when there's no local image. */
  fileId?: string;
  /** Bundled asset path relative to src/assets/ — tried before fileId/emoji. */
  localImage?: string;
  description: string;
  paramDefs: ParamDef[];
}

// ---------- Map-scoped definitions ----------

export interface RawIngredientDef {
  id: Id;
  name: string;
  icon: string;
  fileId?: string;
  /** Bundled asset path relative to src/assets/ — tried before fileId/emoji. */
  localImage?: string;
  /** String code used by the Unity game / sheet (e.g. "burger_bun_raw"). */
  code: string;
  price: number;
  /** How many pieces one raw unit yields when processed (sheet: NumSlices). */
  numSlices: number;
}

export interface CookedIngredientDef {
  id: Id;
  name: string;
  icon: string;
  fileId?: string;
  /** Bundled asset path relative to src/assets/ — tried before fileId/emoji. */
  localImage?: string;
  /**
   * Another cooked ingredient id that must already be in a dish before this
   * one can be served to it (e.g. Ice needs a Soda Cup already there; burger
   * toppings need a Sliced Bun already there). Undefined = no requirement —
   * this ingredient can serve on its own, or *is* a base.
   */
  baseId?: Id;
}

/**
 * What a served customer leaves behind on the grid instead of the generic
 * dirty dish — e.g. a burger dish leaves a Dirty Plate, a soda dish leaves a
 * Dirty Cup. `sourceCookedId` is the cooked ingredient whose presence in a
 * dish spawns this object (resolved from the config's "source" name at load
 * time — see data/configLoader.ts).
 */
export interface DirtyObjectDef {
  id: Id;
  name: string;
  icon: string;
  fileId?: string;
  /** Bundled asset path relative to src/assets/ — tried before fileId/emoji. */
  localImage?: string;
  sourceCookedId: Id;
}

/** What a tool turns one raw ingredient into, and how many come out. */
export interface ToolRecipe {
  in: Id;
  out: Id;
  amount: number;
}

/**
 * A cooking station. Holds `numSlots` ingredients at once; each occupied slot
 * finishes after `cookingTime` seconds. An ingredient with no recipe in any
 * tool needs no processing and goes straight to the grid.
 */
export interface CookingToolDef {
  id: Id;
  name: string;
  icon?: string;
  fileId?: string;
  /** Bundled asset path relative to src/assets/ — tried before fileId/emoji. */
  localImage?: string;
  numSlots: number;
  cookingTime: number;
  recipes: ToolRecipe[];
}

export interface MapDef {
  id: Id;
  name: string;
  dirtyDishName: string; // per-map skin: "plate" | "cup" | "box" | ...
  /**
   * Grid size and dirty-stack height are fixed per map, not per level — every
   * level in a map shares one board shape and one stack cap.
   */
  gridWidth: number;
  gridHeight: number;
  dirtyStackHeight: number;
  rawIngredients: RawIngredientDef[];
  cookedIngredients: CookedIngredientDef[];
  /** What served dishes leave behind on the grid — see DirtyObjectDef. */
  dirtyObjects: DirtyObjectDef[];
  /**
   * Bundled transparent-PNG avatar images (paths relative to src/assets/) —
   * Play mode picks one at random per customer card, stable for its lifetime.
   */
  customerAvatars: string[];
  tools: CookingToolDef[];
  levels: LevelConfig[];
  /**
   * Raw/cooked ingredient ids disabled for this map (e.g. Map 1's bun, id 0 in
   * both spaces). Play mode strips them from queues and orders before the
   * level starts; Design mode still shows and edits the underlying data.
   */
  disabledRawIds: Id[];
  disabledCookedIds: Id[];
}

/** Finds the tool (and its recipe) that processes a raw ingredient, if any. */
export function findToolRecipe(
  tools: CookingToolDef[],
  rawId: Id,
): { tool: CookingToolDef; recipe: ToolRecipe } | null {
  for (const tool of tools) {
    const recipe = tool.recipes.find((r) => r.in === rawId);
    if (recipe) return { tool, recipe };
  }
  return null;
}

// ---------- Level config ----------

export type QueueItemKind = "ingredient" | "sweeper";

export interface QueueItem {
  kind: QueueItemKind;
  /** Raw ingredient id for kind "ingredient"; reserved object id otherwise. */
  id: Id;
  effects: EffectInstance[];
}

export interface GridCellConfig {
  /** Effects / cell-type markers; empty = blank cell. */
  effects: EffectInstance[];
}

export interface Dish {
  cookedIds: Id[];
  effects: EffectInstance[];
}

export interface CustomerConfig {
  /**
   * Customer type id from the customer-types definition table (0 = Customer,
   * 1 = Staff; future types get new rows + a registered behavior). First
   * element of the customer config string.
   */
  typeId: Id;
  /** Patience timer in seconds; 0 = no time limit. */
  waitTime: number;
  /** 1 = customer is affected by weather (halved timer + minigame in the real game). */
  weatherEff: number;
  dishes: Dish[];
  /**
   * Staff only: how many dirty stacks they clear on arrival.
   * Absent/undefined means the default of 1.
   */
  staffAmount?: number;
}

/** What happens when every tool slot for a picked ingredient is busy. */
export type OutOfSlotPolicy = "block-pick" | "park-on-grid";

export interface LevelConfig {
  id: Id;
  name: string;
  weather: string; // "Normal" | "Rainy" | "Sunny" | "Freeze" (per sheet Weather table)
  levelTag: string; // e.g. "Hard"
  featureUnlock: string; // e.g. "egg_fried"
  /** Queue shuffle distance from the sheet's TOOL_Level_ingredient_queue. */
  shuffleDistance: number;
  /** Serveable customer slots (1–2 typical). */
  serveableSlots: number;
  queues: QueueItem[][];
  grid: GridCellConfig[]; // length = gridWidth * gridHeight, scan order
  customers: CustomerConfig[];
  /** Overrides the default behaviour when a picked ingredient's tool is full. */
  outOfSlotPolicy?: OutOfSlotPolicy;
}

// ---------- Global (cross-map) definitions ----------

export interface GlobalDefs {
  effects: ElementDef[];
  cellTypes: ElementDef[];
  customerTypes: ElementDef[];
}

export interface Project {
  globalDefs: GlobalDefs;
  maps: MapDef[];
}
