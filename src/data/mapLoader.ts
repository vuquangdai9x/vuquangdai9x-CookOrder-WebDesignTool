// Turns the JSON map data (level configs stored as canonical strings) into the
// fully parsed MapDef model, and back. The JSON string form is also what the
// CSV export writes.

import { parseCustomers, parseGrid, parseQueueGroups, parseQueues } from "../core/parser.ts";
import type { LevelConfig, MapDef } from "../core/types.ts";

export interface LevelData {
  id: number;
  name: string;
  weather: string;
  levelTag: string;
  featureUnlock: string;
  serveableSlots: number;
  shuffleDistance: number;
  queueString: string;
  gridString: string;
  customerString: string;
  /** Optional per-level override of what happens when a tool is full. */
  outOfSlotPolicy?: "block-pick" | "park-on-grid";
  /** Starting charge count for each of the 4 boosters — see LevelConfig.boosterCharges. */
  boosterCharges?: number[];
  /**
   * Design-time record of the last Auto Generate run's inputs (Customer
   * section) — not consumed by Play/sim, purely so a designer can inspect or
   * re-edit the recipe that produced the current customer list. Format:
   * "<cookedId>:<weight>;..." (0-100 each), one entry per ingredient with a
   * nonzero weight — see ui/design/ingredientWeightEditor.ts.
   */
  ingredientWeights?: string;
  /** Same record, dish count per customer: "<count>;<count>;..." — see ui/design/autoGenerate.ts. */
  customerDishesSequence?: string;
  /** Same record, the complexity curve used — JSON-encoded CurveState, see ui/design/curveEditor.ts. */
  complexityCurve?: string;
  /** Same record for the Queue section's Auto Generate curve-mode shuffle distance — JSON-encoded CurveState. */
  shuffleCurve?: string;
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
    serveableSlots: d.serveableSlots,
    queues: parseQueues(d.queueString),
    queueGroups: parseQueueGroups(d.queueString),
    grid: parseGrid(d.gridString),
    customers: parseCustomers(d.customerString),
    outOfSlotPolicy: d.outOfSlotPolicy,
    boosterCharges: d.boosterCharges,
  };
}

export function toMapDef(data: MapData): MapDef {
  return { ...data, levels: data.levels.map(toLevelConfig) };
}
