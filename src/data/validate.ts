// Level sanity checks surfaced to designers in Design mode.

import { EFFECT_FREEZE } from "../core/effects.ts";
import { parseCustomers, parseGrid, parseQueueGroups, parseQueues } from "../core/parser.ts";
import type { QueueGroup } from "../core/types.ts";
import type { MapData } from "./mapLoader.ts";
import { demandByRaw, rawYieldAmounts, supplyByRaw } from "./recipeDemand.ts";

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
    // Compares in USE units, not physical pickup count — need is a straight
    // count of order occurrences, have is supply × yield × usageNum (how many
    // times the queued pieces can actually be served). Shares this math —
    // including a tool recipe's per-pickup yield and a usageNum ingredient's
    // multi-serve capacity — with ui/design/queueSection.ts's live Recipe
    // Pieces foldout; see recipeDemand.ts for why this is one implementation,
    // not two.
    const demand = demandByRaw(map, customers);
    const supply = supplyByRaw(queues);
    const rawYield = rawYieldAmounts(map);
    for (const [rawId, info] of demand) {
      const amount = info.amount || rawYield.get(rawId) || 1;
      const have = (supply.get(rawId) ?? 0) * amount * info.usageNum;
      const name = map.rawIngredients.find((r) => r.id === rawId)?.name ?? rawId;
      if (have < info.need) {
        add(`Not enough ${name}: orders need ${info.need} use(s), queues supply ${have}.`);
      } else if (info.usageNum > 1 && have > info.need) {
        // Bottles are indivisible, so a usageNum ingredient's supply almost
        // never lands exactly on demand — flag it so a designer can see a
        // landed piece's spare capacity will go unused, not just infer it.
        add(
          `Leftover ${name}: queues supply ${have} use(s) but orders only need ${info.need} — ` +
            `some capacity of a landed piece will go unused.`,
        );
      }
    }

    const usableCells = grid.filter((c) => c.effects.length === 0).length;
    if (usableCells === 0 && grid.length > 0) add("No usable grid cells.");
  }
  return warnings;
}
