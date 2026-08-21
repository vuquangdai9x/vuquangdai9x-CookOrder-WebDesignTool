// Shared test fixtures for sim.test.ts and bot.test.ts — kept in a plain
// (non-`.test.ts`) module so both test files can import the same definitions
// without risking Vitest double-registering a test file.

import { parseCustomers, parseGrid, parseQueueGroups, parseQueues } from "./parser.ts";
import type { LevelConfig, MapDef } from "./types.ts";

/**
 * Small test map: one tool with plenty of slots and a 1s cook time, so sims
 * resolve quickly. Ingredient 2 has no recipe, so it goes straight to the grid.
 */
export const testMap: MapDef = {
  id: 99,
  name: "test",
  dirtyDishName: "plate",
  gridWidth: 5,
  gridHeight: 2,
  dirtyStackHeight: 5,
  visibleRows: 3,
  disabledRawIds: [],
  disabledCookedIds: [],
  rawIngredients: [0, 1, 2, 3].map((id) => ({
    id,
    name: `raw${id}`,
    icon: "",
    code: `raw${id}`,
    price: 1,
    numSlices: id === 3 ? 2 : 1,
  })),
  cookedIngredients: [0, 1, 2, 3].map((id) => ({ id, name: `cooked${id}`, icon: "" })),
  dirtyObjects: [],
  tools: [
    {
      id: 0,
      name: "Test Tool",
      numSlots: 8,
      cookingTime: 1,
      recipes: [
        { in: 0, out: 0, amount: 1 },
        { in: 1, out: 1, amount: 1 },
        // Ingredient 3 splits into two pieces, like a chopping board.
        { in: 3, out: 3, amount: 2 },
      ],
    },
  ],
  levels: [],
};

export function level(
  overrides: Partial<LevelConfig> & { queueString: string; gridString: string; customerString: string },
): LevelConfig {
  return {
    id: 1,
    name: "test",
    weather: "Normal",
    levelTag: "",
    featureUnlock: "",
    shuffleDistance: 0,
    serveableSlots: 2,
    queues: parseQueues(overrides.queueString),
    queueGroups: parseQueueGroups(overrides.queueString),
    grid: parseGrid(overrides.gridString),
    customers: parseCustomers(overrides.customerString),
    ...overrides,
  };
}

export const EMPTY_GRID = ",,,,,,,,,";
