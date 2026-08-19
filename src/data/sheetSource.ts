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
import { GLOBAL_DEFS, MAP1_DATA, MAP_INDEX } from "./configLoader.ts";
import {
  clearStoredToken,
  getAccessTokenSilent,
  requestAccessTokenInteractive,
} from "./googleAuth.ts";
import remoteSheetColumnsJson from "./config/general/remote-sheet-columns.json";
import { columnLetter, letterToColumn, parseCsv } from "./csvColumns.ts";

// Re-exported for backward compatibility — ui/remote/index.ts, sheetWrite.ts,
// and sheetSource.test.ts all import these from here. The implementations
// live in csvColumns.ts (a dependency-free leaf module) so levelSnapshot.ts
// can use them without creating a circular import back through
// configLoader.ts, which this file itself imports from.
export { columnLetter, letterToColumn, parseCsv };

/**
 * No default on purpose: the actual spreadsheet id is project-private, so it
 * isn't checked into source — only someone who already has it (paste it into
 * the header's "Sheet ID" field, see main.ts) can pull live data. Every
 * caller here treats an empty id as "no sheet configured" and falls back to
 * the bundled snapshot rather than crashing.
 */
export const SHEET_ID = "";

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

// ---------- Remote Data tab: MapLevelProgress-style, one row per level ----------
// The Remote Data tab (ui/remote/index.ts) reads/writes a per-map-per-level
// sheet with one row per level and a named column per field — matching the
// real "MapLevelProgress" tab's shape (Map|Level|ID|Title|Weather|Tag|
// Customers|Grid|Queues|... — see docs/SHEET_STRUCTURE.md) rather than the
// key/value RemoteConfigData tab Unity's runtime script reads (a separate,
// unrelated concern). Column positions are data, not code — see
// config/general/remote-sheet-columns.json; edit that file if the real
// sheet's layout differs.

export interface RemoteSheetColumns {
  map: number;
  level: number;
  customerString: number;
  gridString: number;
  queueString: number;
  ingredientWeights: number;
  customerDishesSequence: number;
  complexityCurve: number;
  shuffleCurve: number;
}

export const REMOTE_SHEET_COLUMNS: RemoteSheetColumns = remoteSheetColumnsJson.columns;
export const REMOTE_SHEET_DEFAULT_TAB: string = remoteSheetColumnsJson.tabName;

/** Field keys carried in one level's row, in the fixed on-sheet column order the Remote Data tab renders them in. */
export const REMOTE_LEVEL_FIELDS: { label: string; key: keyof RemoteSheetColumns }[] = [
  { label: "Ingredient Weights", key: "ingredientWeights" },
  { label: "Customer Dishes Sequence", key: "customerDishesSequence" },
  { label: "Complexity Curve", key: "complexityCurve" },
  { label: "Shuffle Curve", key: "shuffleCurve" },
  { label: "Customers", key: "customerString" },
  { label: "Grid", key: "gridString" },
  { label: "Queues", key: "queueString" },
];

export interface LevelSheetRow {
  /** 1-indexed sheet row — needed to write this row's cells back in place. */
  rowNumber: number;
  fields: Partial<Record<keyof RemoteSheetColumns, string>>;
}

/** Matches a row's "Map" column cell against a known map by id (case-insensitive) or 1-based index. */
function resolveMapId(cell: string): string | null {
  const trimmed = cell.trim();
  if (!trimmed) return null;
  const byId = MAP_INDEX.find((m) => m.id.toLowerCase() === trimmed.toLowerCase());
  if (byId) return byId.id;
  const byIndex = MAP_INDEX.find((m) => String(m.index) === trimmed);
  return byIndex?.id ?? null;
}

/**
 * Reads every level row from the configured tab in ONE request, keyed by the
 * same `map_config_{mapId}_lv_{n}` convention used throughout the Remote Data
 * tab — so every subsequent read (a single row's Load, a field's Apply, a
 * whole-level Apply) can look up the already-fetched Map instead of hitting
 * the network again. `startRow` (1-indexed) skips the sheet's title/category/
 * header rows outright — the real MapLevelProgress sheet has 3 of them before
 * data starts at row 4. Any row whose Level column still doesn't parse to a
 * positive integer, or whose Map column doesn't match a known map, is also
 * skipped (covers stray/blank rows below `startRow`).
 */
export async function fetchLevelProgressRows(
  sheetId: string,
  token: string,
  tabName: string,
  columns: RemoteSheetColumns = REMOTE_SHEET_COLUMNS,
  startRow = 1,
): Promise<Map<string, LevelSheetRow>> {
  const rows = await fetchTabValues(tabName, token, sheetId);
  const byKey = new Map<string, LevelSheetRow>();
  rows.forEach((cells, i) => {
    const rowNumber = i + 1;
    if (rowNumber < startRow) return;
    const level = Number((cells[columns.level] ?? "").trim());
    if (!Number.isInteger(level) || level <= 0) return;
    const mapId = resolveMapId(cells[columns.map] ?? "");
    if (!mapId) return;
    const key = `map_config_${mapId}_lv_${level}`;
    const fields: LevelSheetRow["fields"] = {};
    for (const k of Object.keys(columns) as (keyof RemoteSheetColumns)[]) {
      if (k === "map" || k === "level") continue;
      fields[k] = cells[columns[k]] ?? "";
    }
    byKey.set(key, { rowNumber, fields });
  });
  return byKey;
}

/**
 * Linked Google Sheet, read-only, via the Sheets API v4 + a per-user OAuth
 * token. Definition tables stay static for now (see data/configLoader.ts).
 */
export class GoogleSheetApiSource implements DataSource {
  /** `sheetId` has no baked-in default (see SHEET_ID) — pass the id from the header's "Sheet ID" field to read that spreadsheet. */
  constructor(
    private interactive: boolean,
    private sheetId: string = SHEET_ID,
  ) {}

  async loadProject(): Promise<Project> {
    if (!this.sheetId.trim()) {
      throw new Error("No spreadsheet id — paste one into the Sheet ID field");
    }
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

/** Column order for the levels CSV — shared by export and import so the two stay in sync. */
const LEVELS_CSV_HEADER = [
  "Level_ID", "Name", "Weather", "LevelTag", "FeatureUnlock", "ShuffleDistance",
  "ServeableSlots", "QueueString", "GridString", "CustomerString",
  "OutOfSlotPolicy", "BoosterCharges",
  "IngredientWeights", "CustomerDishesSequence", "ComplexityCurve", "ShuffleCurve", "DesignNote",
];

/** Level data only: metadata, customer, grid and queue strings — no map/ingredient/tool definitions. */
export function levelsCsv(map: Pick<MapData, "levels">): string {
  const rows = map.levels.map((l) => [
    l.id, l.name, l.weather, l.levelTag, l.featureUnlock, l.shuffleDistance,
    l.serveableSlots, l.queueString, l.gridString, l.customerString,
    l.outOfSlotPolicy ?? "", (l.boosterCharges ?? []).join("|"),
    l.ingredientWeights ?? "", l.customerDishesSequence ?? "", l.complexityCurve ?? "",
    l.shuffleCurve ?? "", l.designNote ?? "",
  ]);
  return toCsv([LEVELS_CSV_HEADER, ...rows]);
}

/** `mime` defaults to CSV, the only thing this module itself downloads. */
export function downloadFile(name: string, content: string, mime = "text/csv"): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Save = download one levels CSV per map. */
export function exportProjectCsv(maps: MapData[]): void {
  for (const map of maps) {
    downloadFile(`LevelData-${map.id}-${map.name}.csv`, levelsCsv(map));
  }
}

// ---------- loading: CSV import ----------

/** Reverses levelsCsv() — parses a levels CSV (with or without the header row) back into LevelData[]. */
export function importLevelsCsv(text: string): LevelData[] {
  const allRows = parseCsv(text).filter((r) => r.some((cell) => cell.trim() !== ""));
  if (allRows.length === 0) throw new Error("CSV has no rows");
  const rows = allRows[0][0] === LEVELS_CSV_HEADER[0] ? allRows.slice(1) : allRows;

  return rows.map((r, i) => {
    const [
      id, name, weather, levelTag, featureUnlock, shuffleDistance,
      serveableSlots, queueString, gridString, customerString,
      outOfSlotPolicy, boosterCharges,
      ingredientWeights, customerDishesSequence, complexityCurve, shuffleCurve, designNote,
    ] = r;
    if (!id || Number.isNaN(Number(id))) {
      throw new Error(`Row ${i + 1}: invalid Level_ID "${id ?? ""}"`);
    }
    const level: LevelData = {
      id: Number(id),
      name: name ?? "",
      weather: weather ?? "",
      levelTag: levelTag ?? "",
      featureUnlock: featureUnlock ?? "",
      shuffleDistance: Number(shuffleDistance) || 0,
      serveableSlots: Number(serveableSlots) || 0,
      queueString: queueString ?? "",
      gridString: gridString ?? "",
      customerString: customerString ?? "",
    };
    if (outOfSlotPolicy === "block-pick" || outOfSlotPolicy === "park-on-grid") {
      level.outOfSlotPolicy = outOfSlotPolicy;
    }
    if (boosterCharges) {
      const charges = boosterCharges.split("|").map(Number);
      if (charges.every((n) => !Number.isNaN(n))) level.boosterCharges = charges;
    }
    if (ingredientWeights) level.ingredientWeights = ingredientWeights;
    if (customerDishesSequence) level.customerDishesSequence = customerDishesSequence;
    if (complexityCurve) level.complexityCurve = complexityCurve;
    if (shuffleCurve) level.shuffleCurve = shuffleCurve;
    if (designNote) level.designNote = designNote;
    return level;
  });
}
