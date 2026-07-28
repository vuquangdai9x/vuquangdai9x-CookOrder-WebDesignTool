// Parse / serialize the three level-config string formats. See docs/GDD.md §7.
// Invariant: serialize(parse(s)) === s for canonical strings, and
// parse(serialize(x)) is deep-equal to x.

import type {
  CustomerConfig,
  Dish,
  EffectInstance,
  GridCellConfig,
  QueueItem,
} from "./types.ts";

/**
 * Non-ingredient queue objects use negative ids so they can never collide
 * with ingredient ids (which are non-negative integers).
 */
export const SWEEPER_ID = -1;

// ---------- effects ----------

/** "1#4:5#2" -> { base: "1", effects: [{4,[5]},{2,[]}] } */
function splitEffects(token: string): { base: string; effects: EffectInstance[] } {
  const parts = token.split("#");
  const base = parts[0];
  const effects = parts.slice(1).map((e) => {
    const nums = e.split(":");
    return {
      effectId: parseIntStrict(nums[0], token),
      params: nums.slice(1).map((p) => parseIntStrict(p, token)),
    };
  });
  return { base, effects };
}

function serializeEffects(effects: EffectInstance[]): string {
  return effects
    .map((e) => "#" + [e.effectId, ...e.params].join(":"))
    .join("");
}

function parseIntStrict(s: string, context: string): number {
  const n = Number(s);
  if (!Number.isInteger(n)) {
    throw new Error(`Invalid integer "${s}" in "${context}"`);
  }
  return n;
}

// ---------- ingredient queues ----------
// "0,1#4:5,0,1%0,0,1,0%1,7,1,7,7"

export function parseQueues(s: string): QueueItem[][] {
  if (s.trim() === "") return [];
  return s.split("%").map((queueStr) =>
    queueStr.split(",").map((itemStr) => {
      const { base, effects } = splitEffects(itemStr);
      const id = parseIntStrict(base, itemStr);
      return { kind: id < 0 ? "sweeper" : "ingredient", id, effects } as QueueItem;
    }),
  );
}

export function serializeQueues(queues: QueueItem[][]): string {
  return queues
    .map((q) => q.map((item) => item.id + serializeEffects(item.effects)).join(","))
    .join("%");
}

// ---------- grid ----------
// ",,#4:1:1,,,,,#3#2:1,,"  (cell = effect list only; empty = blank)

export function parseGrid(s: string): GridCellConfig[] {
  return s.split(",").map((cellStr) => {
    if (cellStr === "") return { effects: [] };
    if (!cellStr.startsWith("#")) {
      throw new Error(`Invalid grid cell "${cellStr}": expected "" or "#effect..."`);
    }
    const { effects } = splitEffects(cellStr);
    return { effects };
  });
}

export function serializeGrid(grid: GridCellConfig[]): string {
  return grid.map((cell) => serializeEffects(cell.effects)).join(",");
}

// ---------- customers ----------
// "0;0;1.0|60;1;1.0.6,0.1.2.5#4"
// 3 params per customer: waitTime ; weatherEff ; dishes.
// Dish ids are "."-separated; legacy digit-runs ("0125") are accepted when
// every id is a single digit.

export function parseCustomers(s: string): CustomerConfig[] {
  if (s.trim() === "") return [];
  return s.split("|").map((custStr) => {
    const parts = custStr.split(";");
    if (parts.length !== 3) {
      throw new Error(`Customer "${custStr}" must have 3 ';'-separated params`);
    }
    return {
      waitTime: parseIntStrict(parts[0], custStr),
      weatherEff: parseIntStrict(parts[1], custStr),
      dishes: parts[2] === "" ? [] : parts[2].split(",").map(parseDish),
    };
  });
}

function parseDish(dishStr: string): Dish {
  const { base, effects } = splitEffects(dishStr);
  const cookedIds = base.includes(".")
    ? base.split(".").map((t) => parseIntStrict(t, dishStr))
    : [...base].map((ch) => parseIntStrict(ch, dishStr)); // legacy digit-run
  return { cookedIds, effects };
}

export function serializeCustomers(customers: CustomerConfig[]): string {
  return customers
    .map((c) =>
      [c.waitTime, c.weatherEff, c.dishes.map(serializeDish).join(",")].join(";"),
    )
    .join("|");
}

function serializeDish(dish: Dish): string {
  return dish.cookedIds.join(".") + serializeEffects(dish.effects);
}
