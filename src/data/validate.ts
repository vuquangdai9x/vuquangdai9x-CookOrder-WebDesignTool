// Level sanity checks surfaced to designers in Design mode.

import { parseCustomers, parseGrid, parseQueues } from "../core/parser.ts";
import { findToolRecipe } from "../core/types.ts";
import type { MapData } from "./mapLoader.ts";

export interface LevelWarning {
  levelName: string;
  message: string;
}

export function validateMap(map: MapData): LevelWarning[] {
  const warnings: LevelWarning[] = [];
  const rawIds = new Set(map.rawIngredients.map((r) => r.id));
  const cookedIds = new Set(map.cookedIngredients.map((c) => c.id));

  for (const level of map.levels) {
    const add = (message: string) => warnings.push({ levelName: level.name, message });

    let queues, grid, customers;
    try {
      queues = parseQueues(level.queueString);
      grid = parseGrid(level.gridString);
      customers = parseCustomers(level.customerString);
    } catch (err) {
      add(`Unparsable config: ${(err as Error).message}`);
      continue;
    }

    const itemCount = queues.reduce((n, q) => n + q.length, 0);
    if (itemCount === 0) add("No ingredients in any queue — level is unplayable.");

    if (grid.length !== level.gridWidth * level.gridHeight) {
      add(`Grid has ${grid.length} cells but is declared ${level.gridWidth}×${level.gridHeight}.`);
    }

    const unknownRaw = queues
      .flat()
      .filter((i) => i.kind === "ingredient" && !rawIds.has(i.id))
      .map((i) => i.id);
    if (unknownRaw.length) add(`Unknown raw ingredient id(s): ${[...new Set(unknownRaw)].join(", ")}`);

    const unknownCooked = customers
      .flatMap((c) => c.dishes.flatMap((d) => d.cookedIds))
      .filter((id) => !cookedIds.has(id));
    if (unknownCooked.length) {
      add(`Unknown cooked ingredient id(s) in orders: ${[...new Set(unknownCooked)].join(", ")}`);
    }

    // Supply check: can the queues cover every ordered cooked ingredient?
    // A tool recipe may yield several pieces from one raw unit (e.g. 1 tomato
    // → 2 slices), and an ingredient with no tool passes through as itself.
    const supply = new Map<number, number>();
    for (const item of queues.flat()) {
      if (item.kind !== "ingredient") continue;
      const match = findToolRecipe(map.tools, item.id);
      if (match) {
        supply.set(
          match.recipe.out,
          (supply.get(match.recipe.out) ?? 0) + match.recipe.amount,
        );
      } else {
        supply.set(item.id, (supply.get(item.id) ?? 0) + 1);
      }
    }
    const demand = new Map<number, number>();
    for (const c of customers) {
      for (const d of c.dishes) {
        for (const id of d.cookedIds) demand.set(id, (demand.get(id) ?? 0) + 1);
      }
    }
    for (const [id, need] of demand) {
      const have = supply.get(id) ?? 0;
      if (have < need) {
        const name = map.cookedIngredients.find((c) => c.id === id)?.name ?? id;
        add(`Not enough ${name}: orders need ${need}, queues supply ${have}.`);
      }
    }

    const usableCells = grid.filter((c) => c.effects.length === 0).length;
    if (usableCells === 0 && grid.length > 0) add("No usable grid cells.");
  }
  return warnings;
}
