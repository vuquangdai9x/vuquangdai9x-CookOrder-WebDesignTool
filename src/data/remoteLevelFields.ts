import type { LevelData } from "./mapLoader.ts";
import { REMOTE_LEVEL_FIELDS, REMOTE_NUMERIC_FIELDS, type LevelSheetRow, type RemoteSheetColumns } from "./sheetSource.ts";
import { decompressLevelString, refreshLevelCompression } from "./levelCompression.ts";
import { parseNodeCustomers } from "../core/nodeParser.ts";
import { parseGrid, parseQueues, parseQueueGroups } from "../core/parser.ts";

export function applyRemoteField(level: LevelData, key: keyof RemoteSheetColumns, value: string, gridCells: number): void {
  const target = level as unknown as Record<string, unknown>;
  if (key === "customerCompressed" || key === "queuesCompressed") {
    const decoded = decompressLevelString(value);
    if (key === "customerCompressed") {
      parseNodeCustomers(decoded);
      level.customerString = decoded;
    } else {
      parseQueues(decoded);
      parseQueueGroups(decoded);
      level.queueString = decoded;
    }
  } else if (key === "gridString") {
    parseGrid(value);
    level.gridString = value === "" ? ",".repeat(Math.max(0, gridCells - 1)) : value;
  } else if (REMOTE_NUMERIC_FIELDS.has(key)) {
    const trimmed = value.trim();
    if (trimmed === "" || !Number.isFinite(Number(trimmed))) delete target[key];
    else target[key] = Math.trunc(Number(trimmed));
  } else {
    target[key] = value;
  }
  refreshLevelCompression(level);
}

/** Preflight on a copy, then commit atomically, including removal of cleared numeric fields. */
export function applyRemoteFields(level: LevelData, fields: LevelSheetRow["fields"], gridCells: number): LevelData {
  const next = structuredClone(level);
  for (const field of REMOTE_LEVEL_FIELDS) {
    if (field.key === "customerCompressed" || field.key === "queuesCompressed") {
      const packed = fields[field.key] ?? "";
      // Older sheets have no compressed columns. Keep their readable source.
      if (!packed) continue;
      const rawKey = field.key === "customerCompressed" ? "customerString" : "queueString";
      const raw = fields[rawKey] ?? "";
      // The readable field always wins: it's applied via its own entry above
      // (REMOTE_LEVEL_FIELDS orders it before its compressed pair), and that
      // application's refreshLevelCompression call regenerates this field to
      // match — so a stale/mismatched compressed cell just gets skipped and
      // silently replaced, rather than blocking the whole apply.
      if (raw && decompressLevelString(packed) !== raw) continue;
    }
    applyRemoteField(next, field.key, fields[field.key] ?? "", gridCells);
  }
  const target = level as unknown as Record<string, unknown>;
  for (const key of REMOTE_NUMERIC_FIELDS) {
    if (!(key in next)) delete target[key];
  }
  return Object.assign(level, next);
}
