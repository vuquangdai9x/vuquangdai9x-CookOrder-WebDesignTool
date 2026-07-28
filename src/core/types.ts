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
  icon: string;
  description: string;
  paramDefs: ParamDef[];
}

// ---------- Map-scoped definitions ----------

export interface RawIngredientDef {
  id: Id;
  name: string;
  icon: string;
  /** String code used by the Unity game / sheet (e.g. "burger_bun_raw"). */
  code: string;
  price: number;
  prepareTime: number; // seconds at x1 speed
  cookTime: number;
}

export interface CookedIngredientDef {
  id: Id;
  name: string;
  icon: string;
}

/** One raw ingredient produces N cooked ingredients. */
export interface CookMapping {
  rawId: Id;
  cookedIds: Id[];
}

export interface MapDef {
  id: Id;
  name: string;
  dirtyDishName: string; // per-map skin: "plate" | "cup" | "box" | ...
  rawIngredients: RawIngredientDef[];
  cookedIngredients: CookedIngredientDef[];
  cookMappings: CookMapping[];
  levels: LevelConfig[];
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
  /** Patience timer in seconds; 0 = no time limit. */
  waitTime: number;
  /** 1 = customer is affected by weather (halved timer + minigame in the real game). */
  weatherEff: number;
  dishes: Dish[];
}

export interface LevelConfig {
  id: Id;
  name: string;
  weather: string; // "Normal" | "Rainy" | "Sunny" | "Freeze" (per sheet Weather table)
  levelTag: string; // e.g. "Hard"
  featureUnlock: string; // e.g. "egg_fried"
  /** Queue shuffle distance from the sheet's TOOL_Level_ingredient_queue. */
  shuffleDistance: number;
  gridWidth: number;
  gridHeight: number;
  /** Serveable customer slots (1–2 typical). */
  serveableSlots: number;
  /** Max dirty dishes per stack before a new stack starts. */
  dirtyStackHeight: number;
  queues: QueueItem[][];
  grid: GridCellConfig[]; // length = gridWidth * gridHeight, scan order
  customers: CustomerConfig[];
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
