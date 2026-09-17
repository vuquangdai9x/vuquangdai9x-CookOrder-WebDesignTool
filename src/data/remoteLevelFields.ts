import type { LevelData } from "./mapLoader.ts";
import { REMOTE_LEVEL_FIELDS, REMOTE_NUMERIC_FIELDS, type LevelSheetRow, type RemoteSheetColumns } from "./sheetSource.ts";
import { decompressLevelString, refreshLevelCompression } from "./levelCompression.ts";
import { parseNodeCustomers } from "../core/nodeParser.ts";
import { parseGrid, parseQueues, parseQueueGroups } from "../core/parser.ts";
import { applyCustomerGeneratorData, decodeCustomerGeneratorData } from "./generatorPersistence/customerGeneratorData.ts";

export function applyRemoteField(level: LevelData, key: keyof RemoteSheetColumns, value: string, gridCells: number): void {
  const target = level as unknown as Record<string, unknown>;
  if (key === "customerDishesSequence") {
    if (value === "") {
      delete level.customerGeneratorData;
      delete level.customerDishesSequence;
    } else if (value.startsWith("gw2_")) level.customerGeneratorData = value;
    else if (value.startsWith("cg1_")) applyCustomerGeneratorData(level, decodeCustomerGeneratorData(value));
    else if (/^(?:cg|gw)\d+_/.test(value)) throw new Error("Unsupported generator workspace payload version.");
    else level.customerDishesSequence = value;
  } else if (key === "complexityCurve") {
    if (value === "") {
      delete level.queuePhaseData;
      delete level.complexityCurve;
    } else if (value.startsWith("qfq1_") || /^qfq\d+_/.test(value)) level.queuePhaseData = value;
    else level.complexityCurve = value;
  } else if (key === "shuffleCurve") {
    if (value === "") {
      delete level.pickupPhaseData;
      delete level.shuffleCurve;
    } else if (value.startsWith("qfp1_") || /^qfp\d+_/.test(value)) level.pickupPhaseData = value;
    else level.shuffleCurve = value;
  } else if (key === "obstacleData") {
    if (value === "") {
      delete level.customerPhaseData;
      delete level.obstacleData;
    } else if (value.startsWith("qfc1_") || /^qfc\d+_/.test(value)) level.customerPhaseData = value;
    else level.obstacleData = value;
  } else if (key === "customerCompressed" || key === "queuesCompressed") {
    const decoded = decompressLevelString(value);
    if (key === "customerCompressed") {
      parseNodeCustomers(decoded);
      level.customerString = decoded;
    } else {
      parseQueues(decoded);
      parseQueueGroups(decoded);
      level.queueString = decoded;
    }
  } else if (key === "gridString" || key === "gridCompressed") {
    parseGrid(value);
    level.gridString = value === "" ? ",".repeat(Math.max(0, gridCells - 1)) : value;
  } else if (key === "author") {
    level.author = value.trim() || null;
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
    if (field.key === "customerCompressed" || field.key === "gridCompressed" || field.key === "queuesCompressed") {
      const packed = fields[field.key] ?? "";
      // Older sheets have no compressed columns. Keep their readable source.
      if (!packed) continue;
      const rawKey = field.key === "customerCompressed"
        ? "customerString"
        : field.key === "gridCompressed" ? "gridString" : "queueString";
      const raw = fields[rawKey] ?? "";
      // The readable field always wins: it's applied via its own entry above
      // (REMOTE_LEVEL_FIELDS orders it before its compressed pair), and that
      // application's refreshLevelCompression call regenerates this field to
      // match — so a stale/mismatched compressed cell just gets skipped and
      // silently replaced, rather than blocking the whole apply.
      if (raw) {
        try {
          const decoded = field.key === "gridCompressed" ? packed : decompressLevelString(packed);
          const expected = field.key === "gridCompressed" ? raw.replace(/^,*$/, "") : raw;
          if (decoded !== expected) continue;
        } catch {
          // A readable source is sufficient to repair a corrupt legacy V/W
          // cell. Applying that source above regenerated a valid compressed
          // value on `next`, so ignore this bad companion instead of rejecting
          // the entire level (notably the multi-sheet Assigned Level fetch).
          continue;
        }
      }
    }
    applyRemoteField(next, field.key, fields[field.key] ?? "", gridCells);
  }
  const target = level as unknown as Record<string, unknown>;
  for (const key of REMOTE_NUMERIC_FIELDS) {
    if (!(key in next)) delete target[key];
  }
  return Object.assign(level, next);
}

export type RemoteFieldsApplyResult = { ok: true } | { ok: false; error: Error };

/** Bulk imports use this boundary so one malformed sheet row cannot cancel every valid level. */
export function tryApplyRemoteFields(
  level: LevelData,
  fields: LevelSheetRow["fields"],
  gridCells: number,
): RemoteFieldsApplyResult {
  try {
    applyRemoteFields(level, fields, gridCells);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}
