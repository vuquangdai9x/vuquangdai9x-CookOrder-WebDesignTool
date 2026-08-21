// Loads the JSON config tree under src/data/config/ into the runtime model.
//
//   config/general/*        cross-map definitions (statuses, colours, meta)
//   config/map<i>-<id>/*    one folder per map: ingredients, cooking tools, levels
//
// Icons live on the definition rows themselves as `fileId` (Google Drive) with
// an `emoji` fallback — there is no separate icon table.

import type {
  BoosterParams,
  ElementDef,
  GlobalDefs,
  ParamDef,
} from "../core/types.ts";

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
