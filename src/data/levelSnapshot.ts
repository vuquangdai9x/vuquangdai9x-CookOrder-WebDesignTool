// Reads the bundled, point-in-time snapshot of the live "MapLevelProgress"
// sheet (config/level-data-snapshot.csv) once at module load, and builds
// each map's LevelData[] from it — this is what configLoader.ts's
// buildMap() now gets its `levels` from, replacing the old per-map
// levels.json files entirely. Column positions come from
// config/general/level-data-snapshot-schema.json (letters, e.g. "D"), the
// same shape ui/remote/index.ts's live Remote Data tab uses for the real
// Sheets API read — kept as a separate schema/file pair since one drives a
// live network read and this one drives a bundled asset, but the row-shape
// assumptions (one row per level, a handful of named columns) are shared.
//
// Deliberately reads config/general/maps.json directly (not MAP_INDEX from
// configLoader.ts) to avoid a circular import: configLoader.ts calls into
// this module to get each map's levels.

import snapshotCsv from "./config/level-data-snapshot.csv?raw";
import schemaJson from "./config/general/level-data-snapshot-schema.json";
import mapsJson from "./config/general/maps.json";
import { letterToColumn, parseCsv } from "./csvColumns.ts";
import type { LevelData } from "./mapLoader.ts";

interface SnapshotColumns {
  map: string;
  level: string;
  ingredientWeights: string;
  customerDishesSequence: string;
  complexityCurve: string;
  shuffleCurve: string;
  designNote: string;
  weather: string;
  tag: string;
  customerString: string;
  gridString: string;
  queueString: string;
}

const schema = schemaJson as { startRow: number; columns: SnapshotColumns };

const columnIndex = Object.fromEntries(
  (Object.entries(schema.columns) as [keyof SnapshotColumns, string][]).map(([key, letter]) => [
    key,
    letterToColumn(letter),
  ]),
) as Record<keyof SnapshotColumns, number>;

/** Matches a row's "Map" column cell against a known map by id (case-insensitive) or 1-based index. */
function resolveMapId(cell: string): string | null {
  const trimmed = cell.trim();
  if (!trimmed) return null;
  const byId = mapsJson.maps.find((m) => m.id.toLowerCase() === trimmed.toLowerCase());
  if (byId) return byId.id;
  const byIndex = mapsJson.maps.find((m) => String(m.index) === trimmed);
  return byIndex?.id ?? null;
}

const cell = (cells: string[], key: keyof SnapshotColumns): string => cells[columnIndex[key]] ?? "";

/**
 * Parses the whole snapshot into a LevelData[] per map id — exported for
 * testing; production code should go through `levelsForMap`, which reads
 * this lazily-computed, module-cached result instead of re-parsing on every
 * call. A row is skipped (not "data-ready") if it's above `startRow` but its
 * Level column isn't a positive integer, its Map column doesn't match a
 * known map, or its Customers column is blank — mirroring the old per-map
 * levels.json's convention of only bundling authored levels (e.g. Map 2's
 * levels.json was `{ levels: [] }` until any got authored).
 */
export function parseLevelSnapshot(csvText: string): Map<string, LevelData[]> {
  const rows = parseCsv(csvText);
  const byMap = new Map<string, LevelData[]>();

  rows.forEach((cells, i) => {
    const rowNumber = i + 1;
    if (rowNumber < schema.startRow) return;

    const level = Number(cell(cells, "level").trim());
    if (!Number.isInteger(level) || level <= 0) return;

    const mapCellRaw = cell(cells, "map").trim();
    const mapId = resolveMapId(mapCellRaw);
    if (!mapId) return;

    const customerString = cell(cells, "customerString");
    if (!customerString.trim()) return; // not yet authored

    const data: LevelData = {
      id: level,
      name: `${mapCellRaw}_${level}`,
      weather: cell(cells, "weather") || "Normal",
      levelTag: cell(cells, "tag"),
      featureUnlock: "",
      serveableSlots: 2,
      shuffleDistance: 0,
      queueString: cell(cells, "queueString"),
      gridString: cell(cells, "gridString"),
      customerString,
    };
    const ingredientWeights = cell(cells, "ingredientWeights");
    if (ingredientWeights) data.ingredientWeights = ingredientWeights;
    const customerDishesSequence = cell(cells, "customerDishesSequence");
    if (customerDishesSequence) data.customerDishesSequence = customerDishesSequence;
    const complexityCurve = cell(cells, "complexityCurve");
    if (complexityCurve) data.complexityCurve = complexityCurve;
    const shuffleCurve = cell(cells, "shuffleCurve");
    if (shuffleCurve) data.shuffleCurve = shuffleCurve;
    const designNote = cell(cells, "designNote");
    if (designNote) data.designNote = designNote;

    const list = byMap.get(mapId);
    if (list) list.push(data);
    else byMap.set(mapId, [data]);
  });

  for (const list of byMap.values()) list.sort((a, b) => a.id - b.id);
  return byMap;
}

const parsed = parseLevelSnapshot(snapshotCsv);

/** All data-ready levels for one map, sorted by level number — `[]` if the snapshot has none yet (e.g. an unauthored map). */
export function levelsForMap(mapId: string): LevelData[] {
  return parsed.get(mapId) ?? [];
}
