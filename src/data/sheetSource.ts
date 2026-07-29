// Data layer.
// - Reading: GoogleSheetCsvSource pulls the linked Google Sheet's tabs as CSV
//   (via the Vite dev proxy, see vite.config.ts) and converts the legacy
//   formats to the tool's canonical model.
// - Saving: exportProjectCsv() downloads CSV files instead of writing back to
//   the sheet (per design decision — the sheet is read-only for this tool).

import type { Project } from "../core/types.ts";
import {
  convertLegacyCustomer,
  convertLegacyLvConfig,
  convertLegacyQueueConfig,
  parseCsv,
} from "./legacyConvert.ts";
import type { LevelData, MapData } from "./mapLoader.ts";
import { toMapDef } from "./mapLoader.ts";
import { GLOBAL_DEFS, MAP1_DATA } from "./configLoader.ts";

export const SHEET_ID = "1wayrsZlHCTtuMGD1Qft2Fmaeb19b-ULfO2F6abTlAEA";

/** Tab name -> gid, discovered from the sheet (docs/SHEET_STRUCTURE.md). */
export const TAB_GIDS = {
  ConfigTables: 709436862,
  Ingredient_config: 675328923,
  Level_overall_config: 1529635743,
  TOOL_Level_ingredient_queue: 266021364,
  Level_Scenario_Map1_burger: 804770440,
  Level_Scenario_Map2_chicken_fried: 722547124,
} as const;

export interface DataSource {
  loadProject(): Promise<Project>;
}

/** CSV export URL, routed through the Vite proxy to avoid CORS in the browser. */
function tabCsvUrl(gid: number): string {
  return `/gsheet/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
}

async function fetchTabCsv(gid: number): Promise<string[][]> {
  const res = await fetch(tabCsvUrl(gid));
  if (!res.ok) throw new Error(`Sheet tab gid=${gid} fetch failed: ${res.status}`);
  return parseCsv(await res.text());
}

const GRID_W = 5;
const GRID_H = 2;

/**
 * Reads live level data for one map from the sheet's three level tabs.
 * `overallRowKey` = [Level_ID, Map] of the map's first level row, whose last
 * non-empty cell holds the '|'-joined MapConfig for the whole map.
 */
async function loadMapLevels(mapId: number, firstLevelId: number): Promise<LevelData[]> {
  const [overall, queues, scenario] = await Promise.all([
    fetchTabCsv(TAB_GIDS.Level_overall_config),
    fetchTabCsv(TAB_GIDS.TOOL_Level_ingredient_queue),
    fetchTabCsv(
      mapId === 1
        ? TAB_GIDS.Level_Scenario_Map1_burger
        : TAB_GIDS.Level_Scenario_Map2_chicken_fried,
    ),
  ]);

  const overallRow = overall.find(
    (r) => r[0] === String(firstLevelId) && r[1] === String(mapId),
  );
  const queueRow = queues.find(
    (r) => r[0] === String(mapId) && r[1] === String(firstLevelId),
  );
  if (!overallRow || !queueRow) throw new Error(`Map ${mapId} rows not found in sheet`);

  const lvConfigs = lastNonEmpty(overallRow).split("|");
  const queueConfigs = lastNonEmpty(queueRow).split("|");
  // Scenario FINAL cell lives on the header row; levels separated by '~'.
  const customerLevels = lastNonEmpty(scenario[0]).split("~");

  const n = Math.min(lvConfigs.length, queueConfigs.length, customerLevels.length);
  const levels: LevelData[] = [];
  for (let i = 0; i < n; i++) {
    const lv = convertLegacyLvConfig(lvConfigs[i], GRID_W * GRID_H);
    const q = convertLegacyQueueConfig(queueConfigs[i]);
    const customers = customerLevels[i]
      .split("|")
      .map(convertLegacyCustomer)
      .join("|");
    levels.push({
      id: i + 1,
      name: `${mapId}_${i + 1}`,
      weather: lv.weather,
      levelTag: lv.levelTag,
      featureUnlock: lv.featureUnlock,
      gridWidth: GRID_W,
      gridHeight: GRID_H,
      serveableSlots: 2,
      dirtyStackHeight: 5,
      shuffleDistance: q.shuffleDistance,
      queueString: q.queueString,
      gridString: lv.gridString,
      customerString: customers,
    });
  }
  return levels;
}

function lastNonEmpty(row: string[]): string {
  for (let i = row.length - 1; i >= 0; i--) {
    if (row[i].trim() !== "") return row[i];
  }
  return "";
}

/** Linked Google Sheet, read-only. Definition tables stay static for now. */
export class GoogleSheetCsvSource implements DataSource {
  async loadProject(): Promise<Project> {
    const levels = await loadMapLevels(1, 1);
    const map1: MapData = { ...MAP1_DATA, levels };
    return { globalDefs: GLOBAL_DEFS, maps: [toMapDef(map1)] };
  }
}

/** Bundled snapshot of the sheet's Map 1 data — works offline. */
export class BundledDataSource implements DataSource {
  async loadProject(): Promise<Project> {
    return { globalDefs: GLOBAL_DEFS, maps: [toMapDef(MAP1_DATA)] };
  }
}

// ---------- saving: CSV export ----------

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

export function levelsCsv(map: MapData): string {
  const header = [
    "Level_ID", "Name", "Weather", "LevelTag", "FeatureUnlock", "ShuffleDistance",
    "GridWidth", "GridHeight", "ServeableSlots", "DirtyStackHeight",
    "QueueString", "GridString", "CustomerString",
  ];
  const rows = map.levels.map((l) => [
    l.id, l.name, l.weather, l.levelTag, l.featureUnlock, l.shuffleDistance,
    l.gridWidth, l.gridHeight, l.serveableSlots, l.dirtyStackHeight,
    l.queueString, l.gridString, l.customerString,
  ]);
  return toCsv([header, ...rows]);
}

export function definitionsCsv(map: MapData): string {
  const rows: (string | number)[][] = [["-- Raw Ingredients --"]];
  rows.push(["ID", "Name", "Code", "Price", "NumSlices"]);
  for (const r of map.rawIngredients) {
    rows.push([r.id, r.name, r.code, r.price, r.numSlices]);
  }
  rows.push([], ["-- Cooked Ingredients --"], ["ID", "Name"]);
  for (const c of map.cookedIngredients) rows.push([c.id, c.name]);
  rows.push(
    [],
    ["-- Cooking Tools --"],
    ["ID", "Name", "NumSlots", "CookingTime", "Recipes (in>out x amount)"],
  );
  for (const t of map.tools) {
    rows.push([
      t.id,
      t.name,
      t.numSlots,
      t.cookingTime,
      t.recipes.map((r) => `${r.in}>${r.out}x${r.amount}`).join("; "),
    ]);
  }
  return toCsv(rows);
}

function downloadFile(name: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Save = download one levels CSV and one definitions CSV per map. */
export function exportProjectCsv(maps: MapData[]): void {
  for (const map of maps) {
    downloadFile(`map${map.id}_${map.name}_levels.csv`, levelsCsv(map));
    downloadFile(`map${map.id}_${map.name}_definitions.csv`, definitionsCsv(map));
  }
}
