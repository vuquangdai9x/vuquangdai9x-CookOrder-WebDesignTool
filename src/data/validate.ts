// Level sanity checks surfaced to designers in Design mode.

import { EFFECT_FREEZE } from "../core/effects.ts";
import { parseCustomers, parseGrid, parseQueueGroups, parseQueues } from "../core/parser.ts";
import type { QueueGroup } from "../core/types.ts";
import { findToolRecipe } from "../core/types.ts";
import type { MapData } from "./mapLoader.ts";

/** True when every cell of a group forms one 4-connected block. */
function isFourConnected(cells: { x: number; y: number }[]): boolean {
  if (cells.length === 0) return true;
  const key = (x: number, y: number) => `${x}:${y}`;
  const set = new Set(cells.map((c) => key(c.x, c.y)));
  const seen = new Set([key(cells[0].x, cells[0].y)]);
  const queue = [cells[0]];
  while (queue.length > 0) {
    const { x, y } = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const k = key(x + dx, y + dy);
      if (set.has(k) && !seen.has(k)) {
        seen.add(k);
        queue.push({ x: x + dx, y: y + dy });
      }
    }
  }
  return seen.size === set.size;
}

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

    let queues, groups: QueueGroup[], grid, customers;
    try {
      queues = parseQueues(level.queueString);
      groups = parseQueueGroups(level.queueString);
      grid = parseGrid(level.gridString);
      customers = parseCustomers(level.customerString);
    } catch (err) {
      add(`Unparsable config: ${(err as Error).message}`);
      continue;
    }

    const itemCount = queues.reduce((n, q) => n + q.length, 0);
    if (itemCount === 0) add("No ingredients in any queue — level is unplayable.");

    if (grid.length !== map.gridWidth * map.gridHeight) {
      add(`Grid has ${grid.length} cells but the map declares ${map.gridWidth}×${map.gridHeight}.`);
    }

    const unknownRaw = queues
      .flat()
      .filter((i) => i.kind === "ingredient" && !rawIds.has(i.id))
      .map((i) => i.id);
    if (unknownRaw.length) add(`Unknown raw ingredient id(s): ${[...new Set(unknownRaw)].join(", ")}`);

    // Combined/linked-slot group integrity.
    const cellOwner = new Map<string, number>();
    groups.forEach((g, gi) => {
      const label = `${g.kind === "combined" ? "Combined" : "Linked"} queue group ${gi + 1}`;
      for (const { x, y } of g.cells) {
        if (x < 0 || x >= queues.length || y < 0 || y >= (queues[x]?.length ?? 0)) {
          add(`${label} references out-of-range cell (${x},${y}).`);
          continue;
        }
        const key = `${x}:${y}`;
        const owner = cellOwner.get(key);
        if (owner !== undefined && owner !== gi) {
          add(`Queue cell (${x},${y}) belongs to more than one group.`);
        } else {
          cellOwner.set(key, gi);
        }
      }
      if (g.cells.length < 2) add(`${label} has fewer than 2 cells.`);
      if (g.kind === "combined" && !isFourConnected(g.cells)) {
        add(`${label} isn't a single 4-connected block.`);
      }
      if (g.kind === "combined") {
        const frozen = g.cells.some((c) =>
          queues[c.x]?.[c.y]?.effects.some((e) => e.effectId === EFFECT_FREEZE),
        );
        if (frozen) {
          add(
            `${label} contains a Freeze effect — since it's a rigid combined ` +
              "block, it (and everything behind it, in its columns) can never " +
              "move while frozen. It can still thaw from a pick in an adjacent " +
              "lane, but if no adjacent lane ever offers one, this is an " +
              "unrecoverable deadlock — double-check the surrounding columns.",
          );
        }
      }
    });

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
