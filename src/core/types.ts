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
  /** Direct web artwork URL, tried after localImage and before fileId. */
  imageURL?: string;
  /** String code used by the Unity game / sheet (e.g. "burger_bun_raw"). */
  code: string;
  price: number;
  /** How many pieces one raw unit yields when processed (sheet: NumSlices). */
  numSlices: number;
  /**
   * Cooked ingredient id this raw item becomes when it needs no tool at all
   * (findToolRecipe finds nothing) and that id differs from its own raw id —
   * e.g. map1's chili_bowl/cheese_sauce were renumbered on the cooked side
   * but kept their original raw id. Absent/equal-to-own-id is the normal
   * case: a tool-less raw ingredient just IS its own cooked form.
   */
  cookedId?: Id;
}

export interface CookedIngredientDef {
  id: Id;
  name: string;
  icon: string;
  fileId?: string;
  /** Bundled asset path relative to src/assets/ — tried before fileId/emoji. */
  localImage?: string;
  /** Direct web artwork URL, tried after localImage and before fileId. */
  imageURL?: string;
  /**
   * Another cooked ingredient id (or any one of several) that must already be
   * in a dish before this one can be served to it (e.g. Ice needs a Soda Cup
   * already there; burger toppings need a Sliced Bun already there; a sauce
   * shared across several fried-chicken bases needs any one of them there
   * first). Undefined = no requirement — this ingredient can serve on its
   * own, or *is* a base.
   */
  baseId?: Id | Id[];
  /**
   * How many times a single instance of this ingredient can be served before
   * it's consumed (e.g. a sauce that tops several dishes). Absent/1 = normal
   * single-use.
   */
  usageNum?: number;
  /**
   * Max copies of this ingredient one dish's order can call for (e.g. a bun
   * or a soda cup only ever appears once; a patty can repeat). Absent/0 = no
   * limit. Enforced by the Design mode dish editor when adding ingredients.
   */
  limit?: number;
}

/**
 * What a served customer leaves behind on the grid instead of the generic
 * dirty dish — e.g. a burger dish leaves a Dirty Plate, a soda dish leaves a
 * Dirty Cup. `sourceCookedId` is the cooked ingredient (or any one of
 * several, e.g. a fried-chicken box triggered by any of the fried bases)
 * whose presence in a dish spawns this object (resolved from the config's
 * "source" name(s) at load time — see data/configLoader.ts).
 */
export interface DirtyObjectDef {
  id: Id;
  name: string;
  icon: string;
  /** Per-type stack capacity; absent uses MapDef.dirtyStackHeight. */
  maxStack?: number;
  fileId?: string;
  /** Bundled asset path relative to src/assets/ — tried before fileId/emoji. */
  localImage?: string;
  /** Direct web artwork URL, tried after localImage and before fileId. */
  imageURL?: string;
  sourceCookedId: Id | Id[];
}

/** What a tool turns one raw ingredient into, and how many come out. */
export interface ToolRecipe {
  in: Id;
  out: Id;
  amount: number;
  /**
   * Additional tool ids to visit, in order, after this one, before `out` is
   * produced (e.g. potato: Cutting Board, then Fryer, then 2 pieces out).
   * Absent/empty = single-step, the common case.
   */
  chainTools?: Id[];
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
  /** Direct web artwork URL, tried after localImage and before fileId. */
  imageURL?: string;
  numSlots: number;
  cookingTime: number;
  recipes: ToolRecipe[];
  /**
   * Coin cost to upgrade this tool from level N to N+1, indexed from level 1
   * (upgradeCosts[0] = cost of the lvl1->lvl2 upgrade). Data captured from
   * the GDD's per-tool upgrade table; not yet wired into any gameplay or UI.
   */
  upgradeCosts?: number[];
}

/** One row of a map's per-level economy table (cost to unlock, reward on win). */
export interface LevelEconomyEntry {
  level: number;
  cost: number;
  rewardHardCurrency: number;
  coinBoost: number;
}

export interface MapDef {
  id: Id;
  name: string;
  dirtyDishName: string; // per-map skin: "plate" | "cup" | "box" | ...
  /**
   * Grid size and fallback dirty-stack height are fixed per map, not per level.
   * A DirtyObjectDef may override the stack height for its own type.
   */
  gridWidth: number;
  gridHeight: number;
  dirtyStackHeight: number;
  /**
   * Queue rows Play mode shows per column: 1 interactable front row plus the
   * rest as preview-only. Default 3 (1 interactable + 2 preview).
   */
  visibleRows: number;
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
  /** Per-level unlock cost / win reward table from the GDD; not yet wired into any gameplay or UI. */
  levelEconomy?: LevelEconomyEntry[];
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

/**
 * What a raw ingredient's cooked identity actually is: a tool recipe's
 * output if it has one, otherwise its own RawIngredientDef.cookedId override
 * (or its own id — the common case where raw and cooked ids are the same,
 * which every id in this codebase was originally built around).
 */
export function resolveCookedId(
  tools: CookingToolDef[],
  rawIngredients: RawIngredientDef[],
  rawId: Id,
): Id {
  const match = findToolRecipe(tools, rawId);
  if (match) return match.recipe.out;
  return rawIngredients.find((r) => r.id === rawId)?.cookedId ?? rawId;
}

// ---------- Level config ----------

export type QueueItemKind = "ingredient" | "sweeper";

export interface QueueItem {
  kind: QueueItemKind;
  /** Raw ingredient id for kind "ingredient"; reserved object id otherwise. */
  id: Id;
  effects: EffectInstance[];
}

/**
 * "combined": a 4-connected block of cells (may span several columns and
 * rows) that moves and is picked as one solid instance — if any of its cells
 * can't rise, none of it does, and the plain slots behind it in its columns
 * are blocked too (holes can appear at runtime).
 * "linked": N cells (need not be adjacent) chained together and drawn with
 * ropes. Doesn't restrict movement at all; pickable only once every member
 * has reached the front row, and then all fly together.
 */
export type QueueGroupKind = "combined" | "linked";

/** Authored coordinate into the dense queue grid: x = column, y = row (0 = front). */
export interface QueueCellRef {
  x: number;
  y: number;
}

export interface QueueGroup {
  kind: QueueGroupKind;
  cells: QueueCellRef[];
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
  /**
   * Combined/linked-slot lookup, addressed by (x,y) into the dense `queues`
   * grid (x = column/queue index, y = row, 0 = front). Absent/empty means
   * every item is a plain single slot. `queues` itself stays dense — this
   * list is the sole carrier of grouping geometry.
   */
  queueGroups?: QueueGroup[];
  grid: GridCellConfig[]; // length = gridWidth * gridHeight, scan order
  customers: CustomerConfig[];
  /** Overrides the default behaviour when a picked ingredient's tool is full. */
  outOfSlotPolicy?: OutOfSlotPolicy;
  /**
   * Starting charge count for each of the 4 boosters, indexed the same as
   * GlobalDefs.boosters (Shift-up Row, Ingredient Pick, Clean Table, Auto
   * Complete). Absent means every booster starts with DEFAULT_BOOSTER_CHARGES.
   */
  boosterCharges?: number[];
}

// ---------- Global (cross-map) definitions ----------

export interface GlobalDefs {
  effects: ElementDef[];
  cellTypes: ElementDef[];
  customerTypes: ElementDef[];
  boosters: ElementDef[];
}

/**
 * Global (whole-game, not per-map) booster tuning — loaded once from
 * config/general/boosters.json's "params" block. Static; not editable in
 * Design mode.
 */
export interface BoosterParams {
  /** Ingredient Pick — rows revealed while the booster is armed. */
  numRowPick: number;
  /** Clean Table — dirty stacks cleared; -1 clears all of them. */
  numCleanStack: number;
  /** Save Me — how many times a run may be rescued from a loss. */
  saveMeCount: number;
  /** Icon spec for the Save Me backpack — structurally matches ui/icon.ts's IconSpec. */
  backpack: { name: string; emoji: string; fileId?: string; localImage?: string };
}

export interface Project {
  globalDefs: GlobalDefs;
  maps: MapDef[];
}
