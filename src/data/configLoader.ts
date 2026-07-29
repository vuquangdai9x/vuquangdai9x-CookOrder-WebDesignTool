// Loads the JSON config tree under src/data/config/ into the runtime model.
//
//   config/general/*        cross-map definitions (statuses, colours, meta)
//   config/map<i>-<id>/*    one folder per map: ingredients, cooking tools, levels
//
// Icons live on the definition rows themselves as `fileId` (Google Drive) with
// an `emoji` fallback — there is no separate icon table.

import type {
  CookingToolDef,
  ElementDef,
  GlobalDefs,
  ParamDef,
} from "../core/types.ts";
import type { LevelData, MapData } from "./mapLoader.ts";

import cellStatusesJson from "./config/general/cell-statuses.json";
import customerTypesJson from "./config/general/customer-types.json";
import emotionsJson from "./config/general/emotions.json";
import ingredientStatusesJson from "./config/general/ingredient-statuses.json";
import keyColorsJson from "./config/general/key-colors.json";
import mapsJson from "./config/general/maps.json";
import metaJson from "./config/general/meta.json";
import weatherJson from "./config/general/weather.json";

import map1Json from "./config/map1-burger/map.json";
import map1CookedJson from "./config/map1-burger/cooked-ingredients.json";
import map1IngredientsJson from "./config/map1-burger/ingredients.json";
import map1LevelsJson from "./config/map1-burger/levels.json";
import map1ToolsJson from "./config/map1-burger/cooking-tools.json";

import map2Json from "./config/map2-chicken_fried/map.json";
import map2IngredientsJson from "./config/map2-chicken_fried/ingredients.json";
import map2LevelsJson from "./config/map2-chicken_fried/levels.json";
import map2ToolsJson from "./config/map2-chicken_fried/cooking-tools.json";

// ---------- shared row shapes ----------

interface StatusRow {
  id: number;
  name: string;
  emoji: string;
  fileId: string;
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
}

interface CookedRow {
  id: number;
  name: string;
  emoji: string;
  fileId: string;
}

const toElementDef = (r: StatusRow): ElementDef => ({
  id: r.id,
  name: r.name,
  icon: r.emoji,
  fileId: r.fileId,
  description: r.description,
  paramDefs: r.paramDefs,
});

// ---------- general ----------

export const KEY_COLORS = keyColorsJson.colors;
export const WEATHER = weatherJson.weather;
export const EMOTIONS = emotionsJson.emotions;
export const META = metaJson;
export const MAP_INDEX = mapsJson.maps;

export const GLOBAL_DEFS: GlobalDefs = {
  effects: (ingredientStatusesJson.statuses as StatusRow[]).map(toElementDef),
  cellTypes: (cellStatusesJson.statuses as StatusRow[]).map(toElementDef),
  customerTypes: (customerTypesJson.types as StatusRow[]).map(toElementDef),
};

// ---------- per-map ----------

function buildMap(
  meta: { index: number; id: string; name: string; dirtyDishName: string },
  ingredients: IngredientRow[],
  cooked: CookedRow[],
  tools: CookingToolDef[],
  levels: LevelData[],
): MapData {
  return {
    id: meta.index,
    name: meta.id,
    dirtyDishName: meta.dirtyDishName,
    rawIngredients: ingredients.map((r) => ({
      id: r.id,
      name: r.name,
      icon: r.emoji,
      fileId: r.fileId,
      code: r.code,
      price: r.price,
      numSlices: r.numSlices,
    })),
    cookedIngredients: cooked.map((c) => ({
      id: c.id,
      name: c.name,
      icon: c.emoji,
      fileId: c.fileId,
    })),
    tools,
    levels,
  };
}

/** Cooked rows are derived for maps that don't declare their own yet. */
function cookedFromTools(ingredients: IngredientRow[], tools: CookingToolDef[]): CookedRow[] {
  const outIds = new Set(tools.flatMap((t) => t.recipes.map((r) => r.out)));
  return ingredients
    .filter((i) => outIds.has(i.id))
    .map((i) => ({ id: i.id, name: i.name, emoji: i.emoji, fileId: i.fileId }));
}

export const MAP1_DATA: MapData = buildMap(
  map1Json,
  map1IngredientsJson.ingredients as IngredientRow[],
  map1CookedJson.cookedIngredients as CookedRow[],
  map1ToolsJson.tools as CookingToolDef[],
  map1LevelsJson.levels as LevelData[],
);

export const MAP2_DATA: MapData = buildMap(
  map2Json,
  map2IngredientsJson.ingredients as IngredientRow[],
  cookedFromTools(
    map2IngredientsJson.ingredients as IngredientRow[],
    map2ToolsJson.tools as CookingToolDef[],
  ),
  map2ToolsJson.tools as CookingToolDef[],
  map2LevelsJson.levels as LevelData[],
);

/** Maps that actually have level data to open in the tool. */
export const ALL_MAPS: MapData[] = [MAP1_DATA, MAP2_DATA].filter(
  (m) => m.levels.length > 0,
);
