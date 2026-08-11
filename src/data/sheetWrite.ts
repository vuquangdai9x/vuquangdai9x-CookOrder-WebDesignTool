// Writes level data out to the "WebTool-Write" tab of a separate spreadsheet
// (see config/general/sheet-write-columns.json for its column layout) via the
// Sheets API v4, using the same OAuth token flow as sheetSource.ts's reads
// (googleAuth.ts). Each write appends a new row rather than editing one in
// place — this tab is a write log, not a live-edited table.
//
// batchUpdateCells() below is different: it writes IN PLACE, into specific
// cells of the SAME spreadsheet sheetSource.ts reads from (the user's own
// Sheet ID, not the fixed WebTool-Write one) — that's what the Remote Data
// tab's Apply buttons need, since they're editing live level rows. Every
// cell changed in one user action (a whole level's 7 fields, or every level
// in "Apply All") goes out as ONE values:batchUpdate request rather than one
// request per cell, to stay well clear of the Sheets API's per-minute quota.

import sheetColumns from "./config/general/sheet-write-columns.json";
import { requestAccessTokenInteractive } from "./googleAuth.ts";
import { columnLetter, SheetAuthRequiredError, SheetPermissionError } from "./sheetSource.ts";

const { spreadsheetId, sheetName, columns } = sheetColumns;

export type WriteField = "customerSequence" | "grid" | "ingredientQueue";

export interface LevelIdentity {
  mapIndex: number;
  levelIndex: number;
  weather: string;
  tag: string;
  unlock: string;
}

/**
 * Appends one row to WebTool-Write: the level's identity (map/level index,
 * weather, tag, unlock) is always filled in, and only the given field values
 * are populated — anything else is left blank in that row. Callers pass the
 * exact strings to write (usually a live, possibly-unsaved draft's
 * serialization) rather than this module reaching into saved level data
 * itself, so a section can write what's on screen right now.
 */
export async function writeRowToSheet(
  identity: LevelIdentity,
  fields: Partial<Record<WriteField, string>>,
): Promise<void> {
  const token = await requestAccessTokenInteractive();

  const width = Math.max(...Object.values(columns)) + 1;
  const row: (string | number)[] = new Array(width).fill("");
  row[columns.mapIndex] = identity.mapIndex;
  row[columns.levelIndex] = identity.levelIndex;
  row[columns.weather] = identity.weather;
  row[columns.tag] = identity.tag;
  row[columns.unlock] = identity.unlock;
  for (const [field, value] of Object.entries(fields) as [WriteField, string][]) {
    row[columns[field]] = value;
  }

  const range = encodeURIComponent(`${sheetName}!A:H`);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}` +
    `:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [row] }),
  });
  if (res.status === 401) throw new SheetAuthRequiredError("access token expired or invalid");
  if (res.status === 403) throw new SheetPermissionError("this Google account can't write to the sheet");
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Sheet write failed: ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
}

export interface CellUpdate {
  /** 1-indexed sheet row — the row a matching fetchLevelProgressRows() read came from. */
  row: number;
  /** 0-indexed column. */
  col: number;
  value: string;
}

/**
 * Writes any number of cells on `tabName` in ONE Sheets API request
 * (values:batchUpdate) — used for every write the Remote Data tab makes,
 * from a single field (one cell) up to "Apply All tool data" across every
 * level of every map (hundreds of cells), so a bulk action never turns into
 * one HTTP request per cell. Requires an interactive token: this is always
 * triggered from a button click, so popping the consent screen here (if
 * needed) is safe. A no-op (no request at all) when `updates` is empty.
 */
export async function batchUpdateCells(sheetId: string, tabName: string, updates: CellUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  const token = await requestAccessTokenInteractive();

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      valueInputOption: "USER_ENTERED",
      data: updates.map((u) => ({
        range: `${tabName}!${columnLetter(u.col)}${u.row}`,
        values: [[u.value]],
      })),
    }),
  });
  if (res.status === 401) throw new SheetAuthRequiredError("access token expired or invalid");
  if (res.status === 403) throw new SheetPermissionError("this Google account can't write to the sheet");
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Sheet batch write failed: ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
}
