// Turns the JSON map data (level configs stored as canonical strings) into the
// fully parsed MapDef model, and back. The JSON string form is also what the
// CSV export writes.

import { parseCustomers, parseGrid, parseQueues } from "../core/parser.ts";
import type { LevelConfig, MapDef } from "../core/types.ts";

export interface LevelData {
  id: number;
  name: string;
  weather: string;
  levelTag: string;
  featureUnlock: string;
  gridWidth: number;
  gridHeight: number;
  serveableSlots: number;
  dirtyStackHeight: number;
  shuffleDistance: number;
  queueString: string;
  gridString: string;
  customerString: string;
  /** Optional per-level override of what happens when a tool is full. */
  outOfSlotPolicy?: "block-pick" | "park-on-grid";
}

export type MapData = Omit<MapDef, "levels"> & { levels: LevelData[] };

export function toLevelConfig(d: LevelData): LevelConfig {
  return {
    id: d.id,
    name: d.name,
    weather: d.weather,
    levelTag: d.levelTag,
    featureUnlock: d.featureUnlock,
    shuffleDistance: d.shuffleDistance,
    gridWidth: d.gridWidth,
    gridHeight: d.gridHeight,
    serveableSlots: d.serveableSlots,
    dirtyStackHeight: d.dirtyStackHeight,
    queues: parseQueues(d.queueString),
    grid: parseGrid(d.gridString),
    customers: parseCustomers(d.customerString),
    outOfSlotPolicy: d.outOfSlotPolicy,
  };
}

export function toMapDef(data: MapData): MapDef {
  return { ...data, levels: data.levels.map(toLevelConfig) };
}
