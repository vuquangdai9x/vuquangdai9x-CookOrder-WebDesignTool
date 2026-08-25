import { describe, expect, it } from "vitest";
import { parseGrid, parseQueueGroups, parseQueues } from "../../core/parser.ts";
import { seededRng } from "./generateLevel.ts";
import { CELL_COLOR_LOCK, STATUS_FREEZE, STATUS_HIDDEN, STATUS_HOLDING_KEY } from "./levelStats.ts";
import {
  rollObstacles,
  CELL_BLOCKED,
  CELL_INGREDIENT_SLOT,
  CELL_ORDER_LOCK,
  emptyObstacles,
  hasObstacles,
  obstacleSummary,
  parseObstacles,
  placeGridObstacles,
  placeQueueObstacles,
  serializeObstacles,
  setObstacleValue,
} from "./obstacles.ts";
import type { ObstacleConfig } from "./obstacles.ts";

const config = (overrides: Partial<Record<string, number>>): ObstacleConfig => {
  const c = emptyObstacles();
  for (const [key, value] of Object.entries(overrides)) {
    setObstacleValue(c, key as never, value as number);
  }
  return c;
};

/** A 6-lane queue, 5 deep — big enough for every group rule to have room. */
const queueOf = (lanes = 6, depth = 5): string =>
  Array.from({ length: lanes }, () => Array.from({ length: depth }, () => "0").join(",")).join("%");

const emptyGrid = (cells: number): string => new Array(cells).fill("").join(",");

describe("the obstacle string", () => {
  it("round-trips through a named grammar", () => {
    const source = config({ blocked: 2, frozen: 3, boss: 1, lockKey: 2 });
    const restored = parseObstacles(serializeObstacles(source));
    expect(restored).toEqual(source);
  });

  it("omits zeroes, so an empty budget is an empty string", () => {
    expect(serializeObstacles(emptyObstacles())).toBe("");
    expect(hasObstacles(emptyObstacles())).toBe(false);
  });

  it("survives unknown keys and junk without losing the ones it knows", () => {
    // A field added by a newer build, or a typo in a hand-edited cell, must not
    // take the rest of the budget down with it.
    const parsed = parseObstacles("blocked=2;whatever=9;;frozen=x;boss=1");
    expect(parsed.grid.blocked).toBe(2);
    expect(parsed.customer.boss).toBe(1);
    expect(parsed.queue.frozen).toBe(0);
  });

  it("keeps lock and key as ONE number", () => {
    // The whole point: there is no way to author two locks and one key.
    const parsed = parseObstacles("lockKey=3");
    expect(parsed.lockAndKey).toBe(3);
    expect(serializeObstacles(parsed)).toBe("lockKey=3");
  });

  it("summarises only what is set", () => {
    expect(obstacleSummary(config({ boss: 1, frozen: 2 })).map((s) => s.count)).toEqual([2, 1]);
  });
});

describe("rollObstacles", () => {
  const big = { customers: 10, dishes: 40, gridCells: 16 };
  const tiny = { customers: 2, dishes: 3, gridCells: 4 };

  it("scales every obstacle to the level's own size", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rolled = rollObstacles(big, seededRng(seed));
      expect(rolled.grid.blocked).toBeLessThanOrEqual(Math.min(3, Math.floor(16 / 8)));
      expect(rolled.grid.orderLock).toBeLessThanOrEqual(Math.min(2, Math.floor(10 / 4)));
      expect(rolled.grid.ingredientLock).toBeLessThanOrEqual(Math.min(2, Math.floor(10 / 5)));
      expect(rolled.lockAndKey).toBeLessThanOrEqual(Math.min(2, Math.floor(10 / 4)));
      expect(rolled.queue.hidden).toBeLessThanOrEqual(Math.min(5, Math.floor(40 / 4)));
      expect(rolled.queue.frozen).toBeLessThanOrEqual(Math.min(4, Math.floor(40 / 5)));
      expect(rolled.queue.linked).toBeLessThanOrEqual(Math.min(2, Math.floor(40 / 8)));
      expect(rolled.queue.combined).toBeLessThanOrEqual(Math.min(2, Math.floor(40 / 8)));
      expect(rolled.customer.timed).toBeLessThanOrEqual(Math.min(3, Math.floor(10 / 3)));
      expect(rolled.customer.shipper).toBeLessThanOrEqual(1);
      expect(rolled.customer.boss).toBeLessThanOrEqual(1);
    }
  });

  it("gives a tiny level almost nothing", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rolled = rollObstacles(tiny, seededRng(seed));
      // Three dishes cannot carry five hidden slots, and two customers cannot
      // carry a boss finale.
      expect(rolled.customer.boss).toBe(0);
      expect(rolled.customer.shipper).toBe(0);
      expect(rolled.queue.hidden).toBe(0);
      expect(rolled.queue.frozen).toBe(0);
    }
  });

  it("keeps a short level free of specials, which need a shape to punctuate", () => {
    for (let seed = 1; seed <= 100; seed++) {
      // 7 customers: long enough for a shipper, still short of a boss.
      const rolled = rollObstacles({ customers: 7, dishes: 20, gridCells: 16 }, seededRng(seed));
      expect(rolled.customer.boss).toBe(0);
    }
  });

  it("never rolls a grid budget past a quarter of the board", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rolled = rollObstacles({ customers: 20, dishes: 60, gridCells: 16 }, seededRng(seed));
      const onGrid =
        rolled.grid.blocked + rolled.grid.orderLock + rolled.grid.ingredientLock + rolled.lockAndKey;
      // The placer allows half; a ROLL stays well under, so an automatic budget
      // never produces the "ran out of cells" warning.
      expect(onGrid).toBeLessThanOrEqual(Math.floor(16 * 0.25));
    }
  });

  it("produces variety rather than the same furniture every level", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 50; seed++) seen.add(serializeObstacles(rollObstacles(big, seededRng(seed))));
    // A generated stretch where every level is identical buries the difficulty
    // curve the table exists to show.
    expect(seen.size).toBeGreaterThan(10);
  });

  it("is reproducible from the seed", () => {
    expect(serializeObstacles(rollObstacles(big, seededRng(77)))).toBe(
      serializeObstacles(rollObstacles(big, seededRng(77))),
    );
  });

  it("rolls nothing at all for an empty level", () => {
    const rolled = rollObstacles({ customers: 0, dishes: 0, gridCells: 0 }, seededRng(1));
    expect(serializeObstacles(rolled)).toBe("");
  });
});

describe("placeGridObstacles", () => {
  const base = {
    gridString: emptyGrid(16),
    width: 4,
    height: 4,
    customerCount: 8,
    ingredientUsage: new Map([[3, 4], [7, 2]]),
  };

  it("places each requested obstacle exactly once", () => {
    const result = placeGridObstacles({
      ...base,
      config: config({ blocked: 2, orderLock: 1, ingredientLock: 1, lockKey: 2 }),
      rand: seededRng(11),
    });
    const cells = parseGrid(result.gridString);
    const count = (id: number) => cells.filter((c) => c.effects.some((e) => e.effectId === id)).length;

    expect(count(CELL_BLOCKED)).toBe(2);
    expect(count(CELL_ORDER_LOCK)).toBe(1);
    expect(count(CELL_INGREDIENT_SLOT)).toBe(1);
    expect(count(CELL_COLOR_LOCK)).toBe(2);
    expect(result.lockColors).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it("never asks an order lock for more orders than the level has", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const result = placeGridObstacles({
        ...base,
        customerCount: 3,
        config: config({ orderLock: 3 }),
        rand: seededRng(seed),
      });
      for (const cell of parseGrid(result.gridString)) {
        for (const effect of cell.effects) {
          if (effect.effectId !== CELL_ORDER_LOCK) continue;
          // A lock needing more orders than exist can never open.
          expect(effect.params[0]).toBeGreaterThanOrEqual(1);
          expect(effect.params[0]).toBeLessThanOrEqual(3);
        }
      }
    }
  });

  it("keys ingredient locks only to ingredients the level orders", () => {
    const result = placeGridObstacles({
      ...base,
      config: config({ ingredientLock: 2 }),
      rand: seededRng(5),
    });
    for (const cell of parseGrid(result.gridString)) {
      for (const effect of cell.effects) {
        if (effect.effectId !== CELL_INGREDIENT_SLOT) continue;
        expect([3, 7]).toContain(effect.params[0]);
        expect(effect.params[1]).toBeGreaterThan(0);
      }
    }
  });

  it("says so rather than keying a lock to an ingredient nobody orders", () => {
    const result = placeGridObstacles({
      ...base,
      ingredientUsage: new Map(),
      config: config({ ingredientLock: 1 }),
      rand: seededRng(5),
    });
    expect(result.warnings.join(" ")).toMatch(/order nothing to key one to/);
  });

  it("never fills more than half the board, and reports the shortfall", () => {
    const result = placeGridObstacles({
      ...base,
      config: config({ blocked: 99 }),
      rand: seededRng(3),
    });
    const filled = parseGrid(result.gridString).filter((c) => c.effects.length > 0).length;
    expect(filled).toBeLessThanOrEqual(8);
    expect(result.warnings.join(" ")).toMatch(/Only placed \d+\/99 blocked cells/);
  });

  it("leaves cells a designer already authored alone", () => {
    const authored = [`#${CELL_BLOCKED}`, "", "", ""].concat(new Array(12).fill("")).join(",");
    const result = placeGridObstacles({
      ...base,
      gridString: authored,
      config: config({ orderLock: 1 }),
      rand: seededRng(9),
    });
    // The authored blocked cell still has exactly its own effect.
    expect(parseGrid(result.gridString)[0].effects).toEqual([{ effectId: CELL_BLOCKED, params: [] }]);
  });
});

describe("placeQueueObstacles", () => {
  const run = (overrides: Partial<Record<string, number>>, seed = 7, lockColors: number[] = []) =>
    placeQueueObstacles({
      queueString: queueOf(),
      config: config(overrides),
      lockColors,
      rand: seededRng(seed),
    });

  it("never touches the front row", () => {
    // Every lane's front tile is what keeps the queue moving.
    for (let seed = 1; seed <= 30; seed++) {
      const result = run({ hidden: 4, frozen: 4, linked: 2, combined: 2 }, seed);
      const lanes = parseQueues(result.queueString);
      for (const lane of lanes) expect(lane[0].effects).toEqual([]);
      for (const group of parseQueueGroups(result.queueString)) {
        for (const cell of group.cells) expect(cell.y).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("builds combined blocks as straight adjacent runs of 2 or 3", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const result = run({ combined: 3 }, seed);
      for (const group of parseQueueGroups(result.queueString)) {
        if (group.kind !== "combined") continue;
        expect(group.cells.length).toBeGreaterThanOrEqual(2);
        expect(group.cells.length).toBeLessThanOrEqual(3);

        const sameColumn = group.cells.every((c) => c.x === group.cells[0].x);
        const sameRow = group.cells.every((c) => c.y === group.cells[0].y);
        expect(sameColumn || sameRow).toBe(true);

        // …and contiguous along whichever axis moves.
        const along = (sameColumn ? group.cells.map((c) => c.y) : group.cells.map((c) => c.x)).sort((a, b) => a - b);
        for (let i = 1; i < along.length; i++) expect(along[i] - along[i - 1]).toBe(1);
      }
    }
  });

  it("puts a linked pair in two adjacent columns on one row", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const result = run({ linked: 3 }, seed);
      for (const group of parseQueueGroups(result.queueString)) {
        if (group.kind !== "linked") continue;
        expect(group.cells.length).toBe(2);
        expect(Math.abs(group.cells[0].x - group.cells[1].x)).toBe(1);
        expect(group.cells[0].y).toBe(group.cells[1].y);
      }
    }
  });

  it("never puts one slot in two groups, or a status on a grouped slot", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const result = run({ linked: 2, combined: 2, hidden: 3, frozen: 3 }, seed, [1, 2]);
      const lanes = parseQueues(result.queueString);
      const seen = new Set<string>();
      for (const group of parseQueueGroups(result.queueString)) {
        for (const cell of group.cells) {
          const key = `${cell.x}:${cell.y}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
          // A frozen member of a combined block is legal to write and awful to play.
          expect(lanes[cell.x][cell.y].effects).toEqual([]);
        }
      }
    }
  });

  it("emits exactly one key per colour lock", () => {
    const result = run({}, 4, [1, 3, 5]);
    const lanes = parseQueues(result.queueString);
    const keys = lanes
      .flat()
      .flatMap((item) => item.effects.filter((e) => e.effectId === STATUS_HOLDING_KEY))
      .map((e) => e.params[0])
      .sort();
    expect(keys).toEqual([1, 3, 5]);
    expect(result.warnings).toEqual([]);
  });

  it("never freezes every lane of one row", () => {
    // A fully frozen row has nothing beside it to thaw from.
    for (let seed = 1; seed <= 30; seed++) {
      const result = placeQueueObstacles({
        queueString: queueOf(3, 4),
        config: config({ frozen: 20 }),
        lockColors: [],
        rand: seededRng(seed),
      });
      const lanes = parseQueues(result.queueString);
      const perRow = new Map<number, number>();
      lanes.forEach((lane) =>
        lane.forEach((item, y) => {
          if (item.effects.some((e) => e.effectId === STATUS_FREEZE)) {
            perRow.set(y, (perRow.get(y) ?? 0) + 1);
          }
        }),
      );
      for (const count of perRow.values()) expect(count).toBeLessThan(lanes.length);
    }
  });

  it("places the requested statuses when there is room", () => {
    const result = run({ hidden: 3, frozen: 2 }, 12);
    const items = parseQueues(result.queueString).flat();
    const count = (id: number) => items.filter((i) => i.effects.some((e) => e.effectId === id)).length;
    expect(count(STATUS_HIDDEN)).toBe(3);
    expect(count(STATUS_FREEZE)).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it("reports rather than silently dropping what did not fit", () => {
    const result = placeQueueObstacles({
      queueString: queueOf(2, 2),
      config: config({ hidden: 20 }),
      lockColors: [],
      rand: seededRng(1),
    });
    expect(result.warnings.join(" ")).toMatch(/Only placed \d+\/20 hidden slots/);
  });

  it("leaves an unreadable queue alone instead of throwing", () => {
    const result = placeQueueObstacles({
      queueString: "0,zz%1",
      config: config({ hidden: 2 }),
      lockColors: [],
      rand: seededRng(1),
    });
    expect(result.queueString).toBe("0,zz%1");
    expect(result.warnings).toHaveLength(1);
  });
});
