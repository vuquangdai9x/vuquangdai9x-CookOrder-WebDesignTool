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

/** Tab the C# RemoteConfigDefaultSetterCakeOrder.cs script reads/writes (key col D, value col E). */
export const REMOTE_CONFIG_TAB = "RemoteConfigData";

export interface RemoteConfigRow {
  key: string;
  value: string;
  /** 1-indexed sheet row — needed to write this row's value cell back in place. */
  row: number;
}

/**
 * Reads every Key/Value pair from the RemoteConfigData tab (columns D/E,
 * matching the C# script's default `_keyColumnLetter`/`_valueColumnLetter`),
 * keyed by row number so a later write targets the exact cell it was read
 * from rather than a row index that could have shifted.
 */
export async function fetchRemoteConfigRows(
  sheetId: string,
  token: string,
): Promise<Map<string, RemoteConfigRow>> {
  const rows = await fetchTabValues(REMOTE_CONFIG_TAB, token, sheetId);
  const byKey = new Map<string, RemoteConfigRow>();
  rows.forEach((cells, i) => {
    const key = (cells[3] ?? "").trim();
    if (!key || key === "Key") return; // skip blanks and the header row
    byKey.set(key, { key, value: cells[4] ?? "", row: i + 1 });
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
];

/** Level data only: metadata, customer, grid and queue strings — no map/ingredient/tool definitions. */
export function levelsCsv(map: MapData): string {
  const rows = map.levels.map((l) => [
    l.id, l.name, l.weather, l.levelTag, l.featureUnlock, l.shuffleDistance,
    l.serveableSlots, l.queueString, l.gridString, l.customerString,
    l.outOfSlotPolicy ?? "", (l.boosterCharges ?? []).join("|"),
  ]);
  return toCsv([LEVELS_CSV_HEADER, ...rows]);
}

function downloadFile(name: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Save = download one levels CSV per map. */
export function exportProjectCsv(maps: MapData[]): void {
  for (const map of maps) {
    downloadFile(`map${map.id}_${map.name}_levels.csv`, levelsCsv(map));
  }
}

// ---------- loading: CSV import ----------

/**
 * Minimal RFC4180 CSV parser: handles quoted fields with embedded commas,
 * escaped quotes (""), and both \r\n and \n line endings. Needed because
 * csvEscape() quotes GridString/CustomerString whenever they contain a comma.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

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
    return level;
  });
}
