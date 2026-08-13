// Loads the JSON config tree under src/data/config/ into the runtime model.
//
//   config/general/*        cross-map definitions (statuses, colours, meta)
//   config/map<i>-<id>/*    one folder per map: ingredients, cooking tools, levels
//
// Icons live on the definition rows themselves as `fileId` (Google Drive) with
// an `emoji` fallback — there is no separate icon table.

import type {
  BoosterParams,
  CookingToolDef,
  DirtyObjectDef,
  ElementDef,
  GlobalDefs,
  LevelEconomyEntry,
  ParamDef,
} from "../core/types.ts";
import type { LevelData, MapData } from "./mapLoader.ts";
import { levelsForMap } from "./levelSnapshot.ts";

import boostersJson from "./config/general/boosters.json";
import cellStatusesJson from "./config/general/cell-statuses.json";
import customerTypesJson from "./config/general/customer-types.json";
import emotionsJson from "./config/general/emotions.json";
import ingredientStatusesJson from "./config/general/ingredient-statuses.json";
import keyColorsJson from "./config/general/key-colors.json";
import mapsJson from "./config/general/maps.json";
import metaJson from "./config/general/meta.json";
import remoteKeysJson from "./config/general/remote-keys.json";
import tagsJson from "./config/general/tags.json";
import weatherJson from "./config/general/weather.json";

import map1Json from "./config/map1-burger/map.json";
import map1CookedJson from "./config/map1-burger/cooked-ingredients.json";
import map1IngredientsJson from "./config/map1-burger/ingredients.json";
import map1ToolsJson from "./config/map1-burger/cooking-tools.json";
import map1DirtyJson from "./config/map1-burger/dirty-objects.json";
import map1AvatarsJson from "./config/map1-burger/customer-avatars.json";
import map1LevelEconomyJson from "./config/map1-burger/level-economy.json";

import map2Json from "./config/map2-donut/map.json";
import map2CookedJson from "./config/map2-donut/cooked-ingredients.json";
import map2IngredientsJson from "./config/map2-donut/ingredients.json";
import map2ToolsJson from "./config/map2-donut/cooking-tools.json";
import map2DirtyJson from "./config/map2-donut/dirty-objects.json";
import map2LevelEconomyJson from "./config/map2-donut/level-economy.json";

// ---------- shared row shapes ----------

interface StatusRow {
  id: number;
  name: string;
  emoji: string;
  fileId: string;
  localImage?: string;
  description: string;
  paramDefs: ParamDef[];
}

interface IngredientRow {
  id: number;
  name: string;
  code: string;
  price: number;
  numSlices: number;
  emoji: string;
  fileId: string;
  localImage?: string;
  cookedId?: number;
}

interface CookedRow {
  id: number;
  name: string;
  emoji: string;
  fileId: string;
  localImage?: string;
  baseId?: number | number[];
  usageNum?: number;
  limit?: number;
}

interface DirtyRow {
  id: number;
  name: string;
  /** Name of the cooked ingredient (or any one of several) whose presence in a dish spawns this object. */
  source: string | string[];
  emoji: string;
  fileId: string;
  localImage?: string;
}

const toElementDef = (r: StatusRow): ElementDef => ({
  id: r.id,
  name: r.name,
  icon: r.emoji,
  fileId: r.fileId,
  localImage: r.localImage,
  description: r.description,
  paramDefs: r.paramDefs,
});

// ---------- general ----------

export const KEY_COLORS = keyColorsJson.colors;
export const WEATHER = weatherJson.weather;
export const TAGS = tagsJson.tags;
export const EMOTIONS = emotionsJson.emotions;
export const META = metaJson;
export const MAP_INDEX = mapsJson.maps;
/** Which remote-config keys exist and how they're grouped — see the Remote Data tab (ui/remote/index.ts). */
export const REMOTE_KEYS = remoteKeysJson;

export const GLOBAL_DEFS: GlobalDefs = {
  effects: (ingredientStatusesJson.statuses as StatusRow[]).map(toElementDef),
  cellTypes: (cellStatusesJson.statuses as StatusRow[]).map(toElementDef),
  customerTypes: (customerTypesJson.types as StatusRow[]).map(toElementDef),
  boosters: (boostersJson.boosters as StatusRow[]).map(toElementDef),
};

/** Global booster tuning (Ingredient Pick's row count, Clean Table's stack count, Save Me's count, the backpack icon spec). Static — not editable in Design mode. */
export const BOOSTER_PARAMS: BoosterParams = boostersJson.params as BoosterParams;

// ---------- per-map ----------

interface MapMeta {
  index: number;
  id: string;
  name: string;
  dirtyDishName: string;
  gridWidth: number;
  gridHeight: number;
  dirtyStackHeight: number;
  visibleRows?: number;
  disabledRawIds?: number[];
  disabledCookedIds?: number[];
}

function buildMap(
  meta: MapMeta,
  ingredients: IngredientRow[],
  cooked: CookedRow[],
  tools: CookingToolDef[],
  levels: LevelData[],
  dirty: DirtyRow[] = [],
  customerAvatars: string[] = [],
  levelEconomy: LevelEconomyEntry[] = [],
): MapData {
  return {
    id: meta.index,
    name: meta.id,
    dirtyDishName: meta.dirtyDishName,
    gridWidth: meta.gridWidth,
    gridHeight: meta.gridHeight,
    dirtyStackHeight: meta.dirtyStackHeight,
    visibleRows: meta.visibleRows ?? 3,
    disabledRawIds: meta.disabledRawIds ?? [],
    disabledCookedIds: meta.disabledCookedIds ?? [],
    rawIngredients: ingredients.map((r) => ({
      id: r.id,
      name: r.name,
      icon: r.emoji,
      fileId: r.fileId,
      localImage: r.localImage,
      code: r.code,
      price: r.price,
      numSlices: r.numSlices,
      cookedId: r.cookedId,
    })),
    cookedIngredients: cooked.map((c) => ({
      id: c.id,
      name: c.name,
      icon: c.emoji,
      fileId: c.fileId,
      localImage: c.localImage,
      baseId: c.baseId,
      usageNum: c.usageNum,
      limit: c.limit,
    })),
    dirtyObjects: dirty.map((d): DirtyObjectDef => {
      const names = Array.isArray(d.source) ? d.source : [d.source];
      const ids = names.map((name) => cooked.find((c) => c.name === name)?.id ?? -1);
      return {
        id: d.id,
        name: d.name,
        icon: d.emoji,
        fileId: d.fileId,
        localImage: d.localImage,
        sourceCookedId: ids.length === 1 ? ids[0] : ids,
      };
    }),
    customerAvatars,
    tools,
    levels,
    ...(levelEconomy.length > 0 ? { levelEconomy } : {}),
  };
}

export const MAP1_DATA: MapData = buildMap(
  map1Json,
  map1IngredientsJson.ingredients as IngredientRow[],
  map1CookedJson.cookedIngredients as CookedRow[],
  map1ToolsJson.tools as CookingToolDef[],
  levelsForMap(map1Json.id),
  map1DirtyJson.cookedIngredients as DirtyRow[],
  map1AvatarsJson.avatars as string[],
  map1LevelEconomyJson.levelEconomy as LevelEconomyEntry[],
);

export const MAP2_DATA: MapData = buildMap(
  map2Json,
  map2IngredientsJson.ingredients as IngredientRow[],
  map2CookedJson.cookedIngredients as CookedRow[],
  map2ToolsJson.tools as CookingToolDef[],
  levelsForMap(map2Json.id),
  map2DirtyJson.cookedIngredients as DirtyRow[],
  [],
  map2LevelEconomyJson.levelEconomy as LevelEconomyEntry[],
);

/** Maps that actually have level data to open in the tool. */
export const ALL_MAPS: MapData[] = [MAP1_DATA, MAP2_DATA].filter(
  (m) => m.levels.length > 0,
);
