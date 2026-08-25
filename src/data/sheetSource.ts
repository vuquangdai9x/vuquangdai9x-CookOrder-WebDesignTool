// Data layer: the Remote Data tab's Sheets API v4 read/write plumbing (per-user
// OAuth token, see ../data/googleAuth.ts — Google Identity Services, no
// backend/client-secret involved; each user signs into their own Google
// account, and Google enforces per-account Drive sharing on every request),
// plus the levels-CSV export/import round trip shared with the node graph's
// CSV tooling.

import type { LevelData, MapData } from "./mapLoader.ts";
import { MAP_INDEX } from "./configLoader.ts";
import { clearStoredToken } from "./googleAuth.ts";
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
  randomSeed: number;
  obstacleData: number;
}

export const REMOTE_SHEET_COLUMNS: RemoteSheetColumns = remoteSheetColumnsJson.columns;
export const REMOTE_SHEET_DEFAULT_TAB: string = remoteSheetColumnsJson.tabName;

/** Field keys carried in one level's row, in the fixed on-sheet column order the Remote Data tab renders them in. */
export const REMOTE_LEVEL_FIELDS: { label: string; key: keyof RemoteSheetColumns }[] = [
  { label: "Ingredient Weights", key: "ingredientWeights" },
  { label: "Customer Dishes Sequence", key: "customerDishesSequence" },
  { label: "Complexity Curve", key: "complexityCurve" },
  { label: "Shuffle Curve", key: "shuffleCurve" },
  { label: "Random Seed", key: "randomSeed" },
  { label: "Obstacle Data", key: "obstacleData" },
  { label: "Customers", key: "customerString" },
  { label: "Grid", key: "gridString" },
  { label: "Queues", key: "queueString" },
];

/**
 * Remote fields whose LevelData counterpart is a NUMBER, not a string.
 *
 * Everything a sheet cell holds arrives as text, and every other level field is
 * text too — so the Remote Data tab could assign straight through. `randomSeed`
 * is the first that cannot: writing "1234" into it would leave a level whose
 * seed is a string, which compares and reproduces differently from the number
 * every other path puts there.
 */
export const REMOTE_NUMERIC_FIELDS: ReadonlySet<keyof RemoteSheetColumns> = new Set(["randomSeed"]);

export interface LevelSheetRow {
  /** 1-indexed sheet row — needed to write this row's cells back in place. */
  rowNumber: number;
  /** Semantic map id resolved from this row's Map cell (column A by default). */
  mapId: string;
  /** Level number read from this row's Level cell (column B by default). */
  level: number;
  fields: Partial<Record<keyof RemoteSheetColumns, string>>;
}

/**
 * Optional sheet-cell aliases for views whose semantic map ids differ from
 * the legacy registry (for example sheet Map `2` is the node graph `coffee`,
 * while the legacy map registry still calls index 2 `donut`). Keys are
 * matched case-insensitively.
 */
export type RemoteSheetMapAliases = Readonly<Record<string, string>>;

/** Matches a row's "Map" cell against an explicit alias, known id, or 1-based index. */
function resolveMapId(cell: string, aliases: RemoteSheetMapAliases = {}): string | null {
  const trimmed = cell.trim();
  if (!trimmed) return null;
  const alias = Object.entries(aliases).find(([key]) => key.toLowerCase() === trimmed.toLowerCase())?.[1];
  if (alias) return alias;
  const byId = MAP_INDEX.find((m) => m.id.toLowerCase() === trimmed.toLowerCase());
  if (byId) return byId.id;
  const byIndex = MAP_INDEX.find((m) => String(m.index) === trimmed);
  return byIndex?.id ?? null;
}

/** Pure row parser shared by the network loader and schema regression tests. */
export function parseLevelProgressRows(
  rows: string[][],
  columns: RemoteSheetColumns = REMOTE_SHEET_COLUMNS,
  startRow = 1,
  mapAliases: RemoteSheetMapAliases = {},
): Map<string, LevelSheetRow> {
  const byKey = new Map<string, LevelSheetRow>();
  rows.forEach((cells, i) => {
    const rowNumber = i + 1;
    if (rowNumber < startRow) return;
    const level = Number((cells[columns.level] ?? "").trim());
    if (!Number.isInteger(level) || level <= 0) return;
    const mapId = resolveMapId(cells[columns.map] ?? "", mapAliases);
    if (!mapId) return;
    const key = `map_config_${mapId}_lv_${level}`;
    const fields: LevelSheetRow["fields"] = {};
    for (const k of Object.keys(columns) as (keyof RemoteSheetColumns)[]) {
      if (k === "map" || k === "level") continue;
      fields[k] = cells[columns[k]] ?? "";
    }
    byKey.set(key, { rowNumber, mapId, level, fields });
  });
  return byKey;
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
  mapAliases: RemoteSheetMapAliases = {},
): Promise<Map<string, LevelSheetRow>> {
  const rows = await fetchTabValues(tabName, token, sheetId);
  return parseLevelProgressRows(rows, columns, startRow, mapAliases);
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
  "RandomSeed", "ObstacleData",
];

/** Level data only: metadata, customer, grid and queue strings — no map/ingredient/tool definitions. */
export function levelsCsv(map: Pick<MapData, "levels">): string {
  const rows = map.levels.map((l) => [
    l.id, l.name, l.weather, l.levelTag, l.featureUnlock, l.shuffleDistance,
    l.serveableSlots, l.queueString, l.gridString, l.customerString,
    l.outOfSlotPolicy ?? "", (l.boosterCharges ?? []).join("|"),
    l.ingredientWeights ?? "", l.customerDishesSequence ?? "", l.complexityCurve ?? "",
    l.shuffleCurve ?? "", l.designNote ?? "",
    l.randomSeed ?? "", l.obstacleData ?? "",
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
      randomSeed, obstacleData,
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
    // Seed 0 is a legal seed, so the guard is parseability rather than
    // truthiness — "0" has to survive a CSV round-trip like any other value.
    if (randomSeed !== undefined && randomSeed.trim() !== "" && Number.isFinite(Number(randomSeed))) {
      level.randomSeed = Math.trunc(Number(randomSeed));
    }
    if (obstacleData) level.obstacleData = obstacleData;
    return level;
  });
}
