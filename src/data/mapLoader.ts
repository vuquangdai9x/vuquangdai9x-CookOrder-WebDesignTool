// Shared level/map draft shapes. LevelData holds a level's canonical strings
// (grid/queue/customer) plus design-time metadata; MapData/MapDef is the
// runtime projection shape the graph system produces via
// data/nodeGraphToMapDef.ts (nodeAsMapDef) so the Design UI it shares with
// the graph system (gridSection.ts, queueSection.ts, estimateDifficulty.ts's
// types) can be written against one shape regardless of which system
// produced it.

import type { MapDef } from "../core/types.ts";

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
  /** Free-text design note from the level data snapshot's "Design Note" column — design-time only, not consumed by Play/sim. */
  designNote?: string;
  /**
   * Seed every random draw in the generate pipeline is taken from, so the same
   * seed rebuilds the same level (see ui/levelpath/generateLevel.ts).
   *
   * Absent means "no seed pinned yet" — the pipeline mints one and writes it
   * back, which is what makes a generated level reproducible after the fact.
   * A pinned seed is also a promise the pipeline keeps: it will never silently
   * reseed a level whose seed the designer chose, it reports failure instead.
   */
  randomSeed?: number;
}

export type MapData = Omit<MapDef, "levels"> & { levels: LevelData[] };
