// batchUpdateCells() writes IN PLACE, into specific cells of the same
// spreadsheet sheetSource.ts reads from (the user's own Sheet ID) — that's
// what the Remote Data tab's Apply buttons need, since they're editing live
// level rows. Every cell changed in one user action (a whole level's 7
// fields, or every level in "Apply All") goes out as ONE values:batchUpdate
// request rather than one request per cell, to stay well clear of the Sheets
// API's per-minute quota.

import { requestAccessTokenInteractive } from "./googleAuth.ts";
import { columnLetter, SheetAuthRequiredError, SheetPermissionError } from "./sheetSource.ts";

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
