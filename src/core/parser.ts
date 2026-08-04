// Parse / serialize the three level-config string formats. See docs/GDD.md §7.
// Invariant: serialize(parse(s)) === s for canonical strings, and
// parse(serialize(x)) is deep-equal to x.

import type {
  CustomerConfig,
  Dish,
  EffectInstance,
  GridCellConfig,
  QueueGroup,
  QueueGroupKind,
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
// "<queueData>[$<combinedSlots>$<linkedSlots>]"
//   queueData      "0,1#4:5,0,1%0,0,1,0%1,7,1,7,7" — '%' between columns, ','
//                   between items, "#effectId:param" suffixes (unchanged).
//   group sections "0-0,1-0;0-2,0-3" — ';' between groups, ',' between cells,
//                   each cell "<x>-<y>" (x = column, y = row; both
//                   non-negative, so '-' is an unambiguous separator).
// The two group sections are omitted ENTIRELY when there are no groups, so
// every pre-existing string (with no '$' at all) round-trips byte-for-byte —
// see mapLoader.test.ts's exact round-trip assertion.
// e.g. "0,1,0%0,0,1%1,7,1$0-0,1-0;0-2,0-3$1-1,2-1"

/** Splits the sectioned string on "$"; a missing section comes back as "". */
function queueSections(s: string): [string, string, string] {
  const parts = s.split("$");
  return [parts[0] ?? "", parts[1] ?? "", parts[2] ?? ""];
}

export function parseQueues(s: string): QueueItem[][] {
  const [data] = queueSections(s);
  if (data.trim() === "") return [];
  return data.split("%").map((queueStr) =>
    queueStr.split(",").map((itemStr) => {
      const { base, effects } = splitEffects(itemStr);
      const id = parseIntStrict(base, itemStr);
      return { kind: id < 0 ? "sweeper" : "ingredient", id, effects } as QueueItem;
    }),
  );
}

/** Combined groups first, then linked — the order serializeQueues re-splits on. */
export function parseQueueGroups(s: string): QueueGroup[] {
  const [, combined, linked] = queueSections(s);
  return [...parseGroupSection(combined, "combined"), ...parseGroupSection(linked, "linked")];
}

function parseGroupSection(section: string, kind: QueueGroupKind): QueueGroup[] {
  if (section.trim() === "") return [];
  return section.split(";").map((groupStr) => ({
    kind,
    cells: groupStr.split(",").map((pair) => {
      const nums = pair.split("-");
      // Both coordinates are non-negative, so a valid pair is exactly two
      // non-empty parts. Without this guard, parseIntStrict("") silently
      // returns 0 (Number("") === 0 IS an integer), so "-1-2" would parse as
      // {x:0,y:1} and "1-" as {x:1,y:0} instead of throwing.
      if (nums.length !== 2 || nums[0] === "" || nums[1] === "") {
        throw new Error(`Invalid queue-group cell "${pair}": expected "<x>-<y>"`);
      }
      return { x: parseIntStrict(nums[0], pair), y: parseIntStrict(nums[1], pair) };
    }),
  }));
}

/**
 * `groups` defaults to [] so every existing call site (which doesn't know
 * about grouping) still compiles and behaves byte-identically: with no
 * groups, no "$" is emitted at all — that's what keeps a group-less string's
 * round-trip exact.
 */
export function serializeQueues(queues: QueueItem[][], groups: QueueGroup[] = []): string {
  const data = queues
    .map((q) => q.map((item) => item.id + serializeEffects(item.effects)).join(","))
    .join("%");
  if (groups.length === 0) return data;
  return [data, serializeGroupSection(groups, "combined"), serializeGroupSection(groups, "linked")].join("$");
}

function serializeGroupSection(groups: QueueGroup[], kind: QueueGroupKind): string {
  return groups
    .filter((g) => g.kind === kind)
    .map((g) => g.cells.map((c) => `${c.x}-${c.y}`).join(","))
    .join(";");
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
// Canonical: "0;0;0;1.0|0;60;1;1.0.6,0.1.2.5#4|1;0;0;;3"
// 4 params per customer: typeId ; waitTime ; weatherEff ; dishes, plus an
// optional 5th (staffAmount, meaningful for type Staff; absent = 1 stack).
// typeId comes from the customer-types definition table (0 Customer, 1 Staff,
// extensible). Dish ids are "."-separated; legacy digit-runs ("0125") are
// accepted when every id is a single digit.
//
// Legacy pre-typeId forms are still parsed (and normalize to canonical on the
// next serialize): "waitTime;weatherEff;dishes" and the staff variant
// "waitTime;weatherEff;;staffAmount" — recognizable among 4-part strings
// because its dishes slot is empty where a canonical 4-part string has a
// numeric weatherEff in that position. Legacy typeId is inferred: empty
// dishes = Staff (1), otherwise Customer (0).

export function parseCustomers(s: string): CustomerConfig[] {
  if (s.trim() === "") return [];
  return s.split("|").map((custStr) => {
    const parts = custStr.split(";");

    // Legacy: 3 parts, or 4 parts with the empty-dishes staff signature.
    if (parts.length === 3 || (parts.length === 4 && parts[2] === "")) {
      const dishes = parts[2] === "" ? [] : parts[2].split(",").map(parseDish);
      const staffAmount = parts.length === 4 ? parseIntStrict(parts[3], custStr) : undefined;
      return {
        typeId: dishes.length === 0 ? 1 : 0,
        waitTime: parseIntStrict(parts[0], custStr),
        weatherEff: parseIntStrict(parts[1], custStr),
        dishes,
        ...(staffAmount !== undefined ? { staffAmount } : {}),
      };
    }

    if (parts.length !== 4 && parts.length !== 5) {
      throw new Error(`Customer "${custStr}" must have 4 or 5 ';'-separated params`);
    }
    const staffAmount = parts.length === 5 ? parseIntStrict(parts[4], custStr) : undefined;
    return {
      typeId: parseIntStrict(parts[0], custStr),
      waitTime: parseIntStrict(parts[1], custStr),
      weatherEff: parseIntStrict(parts[2], custStr),
      dishes: parts[3] === "" ? [] : parts[3].split(",").map(parseDish),
      ...(staffAmount !== undefined ? { staffAmount } : {}),
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
    .map((c) => {
      const base = [c.typeId, c.waitTime, c.weatherEff, c.dishes.map(serializeDish).join(",")];
      if (c.staffAmount !== undefined) base.push(c.staffAmount);
      return base.join(";");
    })
    .join("|");
}

function serializeDish(dish: Dish): string {
  return dish.cookedIds.join(".") + serializeEffects(dish.effects);
}
