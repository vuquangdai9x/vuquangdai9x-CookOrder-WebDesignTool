// Data layer.
// - Reading: GoogleSheetApiSource calls the Sheets API v4 directly with an
//   OAuth access token (see ../data/googleAuth.ts — Google Identity Services,
//   no backend/client-secret involved) and converts the legacy formats to the
//   tool's canonical model. Each user signs into their own Google account;
//   Google enforces per-account Drive sharing on every request.
// - Saving: exportProjectCsv() downloads CSV files instead of writing back to
//   the sheet (per design decision — the sheet is read-only for this tool).

import type { Project } from "../core/types.ts";
import {
  convertLegacyCustomer,
  convertLegacyLvConfig,
  convertLegacyQueueConfig,
} from "./legacyConvert.ts";
import type { LevelData, MapData } from "./mapLoader.ts";
import { toMapDef } from "./mapLoader.ts";
import { GLOBAL_DEFS, MAP1_DATA } from "./configLoader.ts";
import {
  clearStoredToken,
  getAccessTokenSilent,
  requestAccessTokenInteractive,
} from "./googleAuth.ts";

export const SHEET_ID = "1gfezXsHHO5y0Tb1r3IEXGLM6gUOSF2TD0QSDMBjFutQ";

/** Sheet tab names (exact titles), discovered from the sheet (docs/SHEET_STRUCTURE.md). */
export const TAB_NAMES = {
  Level_overall_config: "Level_overall_config",
  TOOL_Level_ingredient_queue: "TOOL_Level_ingredient_queue",
  Level_Scenario_Map1_burger: "Level_Scenario_Map1_burger",
  Level_Scenario_Map2_chicken_fried: "Level_Scenario_Map2_chicken_fried",
} as const;

export interface DataSource {
  loadProject(): Promise<Project>;
}

/**
 * Thrown when the user isn't signed in yet (or their token expired) — the
 * caller should trigger requestAccessTokenInteractive() from a click and
 * retry, rather than treating this as a hard failure.
 */
export class SheetAuthRequiredError extends Error {
  constructor(detail: string) {
    super(`Google sign-in required (${detail})`);
    this.name = "SheetAuthRequiredError";
  }
}

/**
 * Thrown when the user IS signed in but their Google account isn't on the
 * Sheet's share list (Sheets API returns 403 Forbidden for this case).
 */
export class SheetPermissionError extends Error {
  constructor(detail: string) {
    super(`No access to the Google Sheet (${detail})`);
    this.name = "SheetPermissionError";
  }
}

async function fetchTabValues(tabName: string, token: string, sheetId: string): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    clearStoredToken();
    throw new SheetAuthRequiredError("access token expired or invalid");
  }
  if (res.status === 403) {
    throw new SheetPermissionError("this Google account isn't shared on the sheet");
  }
  if (!res.ok) throw new Error(`Sheet tab "${tabName}" fetch failed: ${res.status}`);
  const json = (await res.json()) as { values?: unknown[][] };
  return (json.values ?? []).map((row) => row.map((cell) => String(cell ?? "")));
}

const GRID_W = 5;
const GRID_H = 2;

/**
 * Reads live level data for one map from the sheet's three level tabs.
 * `overallRowKey` = [Level_ID, Map] of the map's first level row, whose last
 * non-empty cell holds the '|'-joined MapConfig for the whole map.
 */
async function loadMapLevels(
  mapId: number,
  firstLevelId: number,
  token: string,
  sheetId: string,
): Promise<LevelData[]> {
  const [overall, queues, scenario] = await Promise.all([
    fetchTabValues(TAB_NAMES.Level_overall_config, token, sheetId),
    fetchTabValues(TAB_NAMES.TOOL_Level_ingredient_queue, token, sheetId),
    fetchTabValues(
      mapId === 1
        ? TAB_NAMES.Level_Scenario_Map1_burger
        : TAB_NAMES.Level_Scenario_Map2_chicken_fried,
      token,
      sheetId,
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
      serveableSlots: 2,
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

/**
 * Linked Google Sheet, read-only, via the Sheets API v4 + a per-user OAuth
 * token. Definition tables stay static for now (see data/configLoader.ts).
 */
export class GoogleSheetApiSource implements DataSource {
  /** `sheetId` defaults to the bundled SHEET_ID — pass a different id (e.g. from the header's spreadsheet-id field) to read a different spreadsheet with the same tab layout. */
  constructor(
    private interactive: boolean,
    private sheetId: string = SHEET_ID,
  ) {}

  async loadProject(): Promise<Project> {
    const token = this.interactive
      ? await requestAccessTokenInteractive()
      : await getAccessTokenSilent();
    if (!token) throw new SheetAuthRequiredError("no Google sign-in yet");

    const levels = await loadMapLevels(1, 1, token, this.sheetId);
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
    "ServeableSlots", "QueueString", "GridString", "CustomerString",
  ];
  const rows = map.levels.map((l) => [
    l.id, l.name, l.weather, l.levelTag, l.featureUnlock, l.shuffleDistance,
    l.serveableSlots, l.queueString, l.gridString, l.customerString,
  ]);
  return toCsv([header, ...rows]);
}

export function definitionsCsv(map: MapData): string {
  const rows: (string | number)[][] = [
    ["-- Map --"],
    ["GridWidth", "GridHeight", "DirtyStackHeight"],
    [map.gridWidth, map.gridHeight, map.dirtyStackHeight],
    [],
    ["-- Raw Ingredients --"],
  ];
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
