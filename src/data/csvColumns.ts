// Dependency-free CSV/column-letter utilities — no project imports on
// purpose. sheetSource.ts (live Sheets API reads) and levelSnapshot.ts (the
// bundled level-data-snapshot.csv read at startup) both need these, and
// sheetSource.ts itself imports from configLoader.ts — if levelSnapshot.ts
// (which configLoader.ts imports from) pulled these from sheetSource.ts
// instead of this leaf module, that would close a circular import
// (configLoader -> levelSnapshot -> sheetSource -> configLoader).

/** 0-based column index -> spreadsheet letter ("A", "Z", "AA", ...). */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Inverse of columnLetter: spreadsheet letter(s) -> 0-based column index. Non-letter input (or empty) returns -1. */
export function letterToColumn(letters: string): number {
  const trimmed = letters.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(trimmed)) return -1;
  let n = 0;
  for (const ch of trimmed) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Minimal RFC4180 CSV parser: handles quoted fields with embedded commas,
 * escaped quotes (""), and both \r\n and \n line endings.
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
