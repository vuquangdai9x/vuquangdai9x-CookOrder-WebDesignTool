// The obstacle budget a generated level is built to, and the rules for
// spending it.
//
// An obstacle config is a set of COUNTS, not placements: "this level should
// have two blocked cells, three frozen queue slots and a boss". Where each one
// lands is decided here, from the seed, under the placement rules the game
// itself imposes — a combined block has to be a straight run of adjacent
// cells, a linked pair has to straddle two adjacent columns, and every colour
// lock has to have a key somewhere in the queue that opens it.
//
// Those rules are the reason this is not just "sprinkle N effects at random".
// Every one of them is a way a randomly-placed obstacle turns a level from hard
// into impossible, and impossible is indistinguishable from hard until someone
// plays it.
//
// LOCK AND KEY IS ONE NUMBER. A colour lock on the grid and a key-carrying
// ingredient in the queue are two halves of one mechanic, and letting a
// designer set them independently only creates two ways to author a level that
// can never be opened. One count means one lock and its key, always in step.
//
// DOM-free, so the placement can be unit tested against the rules rather than
// eyeballed in the table.

import { parseGrid, parseQueues, serializeGrid, serializeQueues } from "../../core/parser.ts";
import type { EffectInstance, GridCellConfig, QueueGroup, QueueItem } from "../../core/types.ts";
import { KEY_COLORS } from "../../data/configLoader.ts";
import { CELL_COLOR_LOCK, STATUS_FREEZE, STATUS_HIDDEN, STATUS_HOLDING_KEY } from "./levelStats.ts";

/** Cell-status ids the grid half of a budget can spend (see config/general/cell-statuses.json). */
export const CELL_BLOCKED = 1;
export const CELL_ORDER_LOCK = 2;
export const CELL_INGREDIENT_SLOT = 3;

// ---------- the budget ----------

export interface ObstacleConfig {
  grid: {
    blocked: number;
    orderLock: number;
    ingredientLock: number;
  };
  queue: {
    hidden: number;
    frozen: number;
    /** Linked GROUPS, not cells — each one is a pair straddling two columns. */
    linked: number;
    /** Combined GROUPS — each one a straight run of 2 or 3 adjacent cells. */
    combined: number;
  };
  customer: {
    /** Customers given a patience timer. */
    timed: number;
    shipper: number;
    boss: number;
  };
  /**
   * Lock/key PAIRS: one colour-locked grid cell plus the key-carrying queue
   * ingredient that opens it. See the header — this is deliberately one number.
   */
  lockAndKey: number;
}

export function emptyObstacles(): ObstacleConfig {
  return {
    grid: { blocked: 0, orderLock: 0, ingredientLock: 0 },
    queue: { hidden: 0, frozen: 0, linked: 0, combined: 0 },
    customer: { timed: 0, shipper: 0, boss: 0 },
    lockAndKey: 0,
  };
}

/**
 * Every field, flattened — what the editor renders and what the string carries.
 *
 * The icon lives HERE rather than in a second table beside the summary, so the
 * editor row and the table cell can never end up showing different symbols for
 * the same obstacle. Where the game already has a symbol for a status (the
 * cell- and ingredient-status tables), that is the one used, so a designer
 * reading a budget sees the same glyph they see on the board.
 */
export const OBSTACLE_FIELDS = [
  { key: "blocked", group: "Grid", icon: "⛔", label: "Blocked", hint: "Cells locked for the whole level." },
  { key: "orderLock", group: "Grid", icon: "🔒", label: "Lock by order", hint: "Cells that open after N orders are served." },
  { key: "ingredientLock", group: "Grid", icon: "🍽", label: "Ingredient lock", hint: "Cells that open once N of one ingredient have been used." },
  { key: "lockKey", group: "Grid", icon: "🎨", label: "Lock & key", hint: "Colour-locked cells, each with a matching key-carrying queue ingredient. One number, because the two halves are one mechanic." },
  { key: "hidden", group: "Queue", icon: "❔", label: "Hidden", hint: "Queue slots whose ingredient the player cannot see until it reaches the front." },
  { key: "frozen", group: "Queue", icon: "🧊", label: "Frozen", hint: "Queue slots that need neighbouring picks before they thaw." },
  { key: "linked", group: "Queue", icon: "🔗", label: "Linked", hint: "Pairs chained across two adjacent columns; pickable only once both reach the front." },
  { key: "combined", group: "Queue", icon: "🧩", label: "Combined", hint: "Straight runs of 2-3 adjacent slots that move and are picked as one block." },
  { key: "timed", group: "Customer", icon: "⏱", label: "Have timer", hint: "Customers given a patience timer." },
  { key: "shipper", group: "Customer", icon: "🚚", label: "Shipper", hint: "Big orders (4-5 dishes) with a Shipper avatar." },
  { key: "boss", group: "Customer", icon: "👑", label: "Boss", hint: "Big orders (4-5 dishes) with a Boss avatar. Always arrives last." },
] as const;

export type ObstacleFieldKey = (typeof OBSTACLE_FIELDS)[number]["key"];

export const OBSTACLE_GROUPS = ["Grid", "Queue", "Customer"] as const;

/** One flat accessor pair per field, so the editor and the string share one map. */
const ACCESS: Record<ObstacleFieldKey, { get(c: ObstacleConfig): number; set(c: ObstacleConfig, v: number): void }> = {
  blocked: { get: (c) => c.grid.blocked, set: (c, v) => (c.grid.blocked = v) },
  orderLock: { get: (c) => c.grid.orderLock, set: (c, v) => (c.grid.orderLock = v) },
  ingredientLock: { get: (c) => c.grid.ingredientLock, set: (c, v) => (c.grid.ingredientLock = v) },
  lockKey: { get: (c) => c.lockAndKey, set: (c, v) => (c.lockAndKey = v) },
  hidden: { get: (c) => c.queue.hidden, set: (c, v) => (c.queue.hidden = v) },
  frozen: { get: (c) => c.queue.frozen, set: (c, v) => (c.queue.frozen = v) },
  linked: { get: (c) => c.queue.linked, set: (c, v) => (c.queue.linked = v) },
  combined: { get: (c) => c.queue.combined, set: (c, v) => (c.queue.combined = v) },
  timed: { get: (c) => c.customer.timed, set: (c, v) => (c.customer.timed = v) },
  shipper: { get: (c) => c.customer.shipper, set: (c, v) => (c.customer.shipper = v) },
  boss: { get: (c) => c.customer.boss, set: (c, v) => (c.customer.boss = v) },
};

export const obstacleValue = (config: ObstacleConfig, key: ObstacleFieldKey): number =>
  ACCESS[key].get(config);

export const setObstacleValue = (config: ObstacleConfig, key: ObstacleFieldKey, value: number): void =>
  ACCESS[key].set(config, Math.max(0, Math.round(value)));

/**
 * `"blocked=2;frozen=3;boss=1"`.
 *
 * A named grammar rather than a positional one, because this string is
 * hand-edited in the Design panel and hand-copied into a spreadsheet cell —
 * positional would make "which zero is the shipper" a counting exercise, and
 * adding a field later would silently reinterpret every existing string.
 * Zeroes are omitted for the same reason weights omit them: they carry nothing.
 */
export function serializeObstacles(config: ObstacleConfig): string {
  return OBSTACLE_FIELDS.filter((field) => obstacleValue(config, field.key) > 0)
    .map((field) => `${field.key}=${obstacleValue(config, field.key)}`)
    .join(";");
}

/** Unknown keys and malformed pairs are skipped, not fatal — this is design metadata. */
export function parseObstacles(text: string | undefined): ObstacleConfig {
  const config = emptyObstacles();
  if (!text || !text.trim()) return config;
  for (const part of text.split(";")) {
    const [rawKey, rawValue] = part.split("=");
    const key = rawKey?.trim() as ObstacleFieldKey;
    if (!key || !(key in ACCESS)) continue;
    const value = Number(rawValue);
    if (Number.isFinite(value)) setObstacleValue(config, key, value);
  }
  return config;
}

export const hasObstacles = (config: ObstacleConfig): boolean =>
  OBSTACLE_FIELDS.some((field) => obstacleValue(config, field.key) > 0);

/** A short human summary for the table cell: "⛔2 🧊3 👑1". */
export function obstacleSummary(config: ObstacleConfig): { icon: string; count: number; label: string }[] {
  return OBSTACLE_FIELDS.filter((field) => obstacleValue(config, field.key) > 0).map((field) => ({
    icon: field.icon,
    count: obstacleValue(config, field.key),
    label: field.label,
  }));
}

// ---------- rolling a budget ----------

/** What a rolled budget is sized against. */
export interface ObstacleBasis {
  /** Ordering customers — Staff excluded, since they order nothing. */
  customers: number;
  /** Dishes across the whole level. */
  dishes: number;
  /** Cells on the board. */
  gridCells: number;
}

/**
 * How much of each obstacle a level of a given size may be given.
 *
 * `per` is the divisor: `blocked` at `per: 8` over `gridCells` means "at most
 * one blocked cell per 8 cells of board". `cap` is the hard ceiling regardless
 * of size, because these do not stay fun as they scale — five frozen slots is
 * a puzzle, fifteen is a wall.
 *
 * The rolled value is then uniform in `0..limit`, so plenty of levels come out
 * with none of a given obstacle. That variety is the point: a generated stretch
 * where every level has exactly the same furniture reads as a template, and the
 * difficulty curve the designer is trying to see gets buried under it.
 */
const ROLL_RULES: {
  key: ObstacleFieldKey;
  basis: keyof ObstacleBasis;
  per: number;
  cap: number;
  /** The level must be at least this big before the obstacle appears at all. */
  min?: number;
}[] = [
  { key: "blocked", basis: "gridCells", per: 8, cap: 3 },
  { key: "orderLock", basis: "customers", per: 4, cap: 2 },
  { key: "ingredientLock", basis: "customers", per: 5, cap: 2 },
  { key: "lockKey", basis: "customers", per: 4, cap: 2 },
  { key: "hidden", basis: "dishes", per: 4, cap: 5 },
  { key: "frozen", basis: "dishes", per: 5, cap: 4 },
  { key: "linked", basis: "dishes", per: 8, cap: 2 },
  { key: "combined", basis: "dishes", per: 8, cap: 2 },
  { key: "timed", basis: "customers", per: 3, cap: 3 },
  // Specials need a level long enough to have a shape for them to punctuate.
  { key: "shipper", basis: "customers", per: 6, cap: 1, min: 6 },
  { key: "boss", basis: "customers", per: 8, cap: 1, min: 8 },
];

/**
 * Total grid obstacles as a share of the board.
 *
 * The placer refuses to fill past half (MAX_GRID_SHARE); this keeps a ROLLED
 * budget well under that, so an automatic roll never produces the warning that
 * a hand-authored over-ambitious one would.
 */
const ROLLED_GRID_SHARE = 0.25;

/** Which rolled fields land on the board, for the share cap above. */
const GRID_KEYS: ObstacleFieldKey[] = ["blocked", "orderLock", "ingredientLock", "lockKey"];

/**
 * A budget scaled to the level's own size, drawn from the seed.
 *
 * This runs only when the level records NO budget of its own — an authored one
 * is a design decision and is never overwritten by a roll.
 */
export function rollObstacles(basis: ObstacleBasis, rand: () => number): ObstacleConfig {
  const config = emptyObstacles();
  const sizes: Record<keyof ObstacleBasis, number> = {
    customers: Math.max(0, Math.floor(basis.customers)),
    dishes: Math.max(0, Math.floor(basis.dishes)),
    gridCells: Math.max(0, Math.floor(basis.gridCells)),
  };

  for (const rule of ROLL_RULES) {
    const size = sizes[rule.basis];
    if (rule.min !== undefined && size < rule.min) continue;
    const limit = Math.min(rule.cap, Math.floor(size / rule.per));
    if (limit <= 0) continue;
    setObstacleValue(config, rule.key, Math.floor(rand() * (limit + 1)));
  }

  // Trim the board back to its share if the independent draws overshot
  // together. Trimmed from the least structural end first: a blocked cell is
  // furniture, while a lock is a mechanic with a key already paired to it.
  const gridCeiling = Math.floor(sizes.gridCells * ROLLED_GRID_SHARE);
  const gridTotal = () => GRID_KEYS.reduce((n, key) => n + obstacleValue(config, key), 0);
  for (const key of GRID_KEYS) {
    while (gridTotal() > gridCeiling && obstacleValue(config, key) > 0) {
      setObstacleValue(config, key, obstacleValue(config, key) - 1);
    }
  }

  return config;
}

// ---------- placement: the grid ----------

/**
 * Never fill more than this share of the board.
 *
 * A grid with no free cells cannot be played at all, and the estimator would
 * report that as "unwinnable" without saying why. Capping here means an
 * over-ambitious budget comes back as a warning naming the obstacles that did
 * not fit, which is an answer a designer can act on.
 */
const MAX_GRID_SHARE = 0.5;

export interface GridPlacementInput {
  gridString: string;
  width: number;
  height: number;
  /** Customers in the level — an order lock that needs more than this never opens. */
  customerCount: number;
  /** Ordered ingredient data ids and how many times each is used, for ingredient locks. */
  ingredientUsage: Map<number, number>;
  config: ObstacleConfig;
  rand: () => number;
}

export interface GridPlacementResult {
  gridString: string;
  /** Colour ids that got a lock, in placement order — the queue must supply one key each. */
  lockColors: number[];
  warnings: string[];
}

/** Colour ids a lock may use — everything but "None". */
const lockColorIds = (): number[] => KEY_COLORS.filter((c) => c.id !== 0).map((c) => c.id);

export function placeGridObstacles(input: GridPlacementInput): GridPlacementResult {
  const warnings: string[] = [];
  let cells: GridCellConfig[];
  try {
    cells = parseGrid(input.gridString);
  } catch {
    cells = [];
  }
  const total = Math.max(1, input.width * input.height);
  while (cells.length < total) cells.push({ effects: [] });

  // Only cells that are still empty are candidates: an obstacle placed on top
  // of another would silently replace it and the budget would be a lie.
  const free: number[] = [];
  cells.forEach((cell, at) => {
    if (cell.effects.length === 0) free.push(at);
  });
  shuffleInPlace(free, input.rand);

  const ceiling = Math.floor(total * MAX_GRID_SHARE);
  let spent = cells.filter((c) => c.effects.length > 0).length;
  const take = (): number | null => {
    if (spent >= ceiling) return null;
    const at = free.pop();
    if (at === undefined) return null;
    spent++;
    return at;
  };
  const shortfall = (label: string, wanted: number, placed: number): void => {
    if (placed < wanted) {
      warnings.push(`Only placed ${placed}/${wanted} ${label} — the grid ran out of free cells.`);
    }
  };

  const put = (at: number, effect: EffectInstance): void => {
    cells[at] = { effects: [effect] };
  };

  let placed = 0;
  for (let i = 0; i < input.config.grid.blocked; i++) {
    const at = take();
    if (at === null) break;
    put(at, { effectId: CELL_BLOCKED, params: [] });
    placed++;
  }
  shortfall("blocked cells", input.config.grid.blocked, placed);

  // An order lock must open before the level ends, so it can never ask for more
  // orders than the level actually has — and asking for the very last one means
  // the cell is decorative.
  placed = 0;
  const maxOrders = Math.max(1, Math.floor(input.customerCount * 0.7));
  for (let i = 0; i < input.config.grid.orderLock; i++) {
    const at = take();
    if (at === null) break;
    put(at, { effectId: CELL_ORDER_LOCK, params: [1 + Math.floor(input.rand() * maxOrders)] });
    placed++;
  }
  shortfall("order locks", input.config.grid.orderLock, placed);

  // Likewise an ingredient lock keyed to an ingredient this level never orders
  // can never open, so the pool is the level's own usage.
  placed = 0;
  const usable = [...input.ingredientUsage.entries()].filter(([, count]) => count > 0);
  for (let i = 0; i < input.config.grid.ingredientLock; i++) {
    if (usable.length === 0) {
      warnings.push("No ingredient lock placed: this level's customers order nothing to key one to.");
      break;
    }
    const at = take();
    if (at === null) break;
    const [ingredientId, count] = usable[Math.floor(input.rand() * usable.length) % usable.length];
    const amount = 1 + Math.floor(input.rand() * Math.max(1, Math.min(3, count)));
    put(at, { effectId: CELL_INGREDIENT_SLOT, params: [ingredientId, amount] });
    placed++;
  }
  shortfall("ingredient locks", input.config.grid.ingredientLock, placed);

  // Colour locks, each of which the QUEUE then has to supply a key for. One key
  // per lock (keyCount 1), so "enough keys" is a property of the count rather
  // than of arithmetic nobody can see.
  const lockColors: number[] = [];
  const palette = lockColorIds();
  for (let i = 0; i < input.config.lockAndKey; i++) {
    if (palette.length === 0) break;
    const at = take();
    if (at === null) break;
    const colorId = palette[i % palette.length];
    put(at, { effectId: CELL_COLOR_LOCK, params: [colorId, 1] });
    lockColors.push(colorId);
  }
  shortfall("colour locks", input.config.lockAndKey, lockColors.length);

  return { gridString: serializeGrid(cells), lockColors, warnings };
}

// ---------- placement: the queue ----------

export interface QueuePlacementInput {
  queueString: string;
  config: ObstacleConfig;
  /** One key is emitted per colour here — produced by the grid pass. */
  lockColors: number[];
  rand: () => number;
}

export interface QueuePlacementResult {
  queueString: string;
  /**
   * Colours a key was actually placed for, one entry per key.
   *
   * The grid pass runs first and cannot know how many free queue slots there
   * will be, so this is how the two halves are reconciled: any lock whose
   * colour is not in here has no key and gets removed from the board. See
   * dropUnkeyedLocks.
   */
  keyedColors: number[];
  warnings: string[];
}

interface Cell {
  x: number;
  y: number;
}

const cellKey = (c: Cell): string => `${c.x}:${c.y}`;

/**
 * Adds slot obstacles to a generated queue.
 *
 * The rules enforced here are the game's, not preferences:
 *
 *   - nothing lands on the FRONT row. Every lane's front tile is what keeps the
 *     queue moving; freezing or hiding the whole front is how a queue stops
 *     dead before the player has made a single choice.
 *   - a combined block is a straight run of 2 or 3 ADJACENT cells, horizontal
 *     or vertical. Anything else is not a shape the game can move as one.
 *   - a linked pair straddles two ADJACENT COLUMNS, on the same row, so both
 *     halves reach the front together — a pair on different rows is pickable
 *     only after the deeper one has climbed, which reads as a bug.
 *   - a cell belongs to at most one group, and a grouped cell is never frozen.
 *     Both combinations are legal to serialize and miserable to play.
 *   - one key per colour lock, so every lock the grid placed can be opened.
 */
export function placeQueueObstacles(input: QueuePlacementInput): QueuePlacementResult {
  const warnings: string[] = [];
  let lanes: QueueItem[][];
  try {
    lanes = parseQueues(input.queueString);
  } catch {
    return {
      queueString: input.queueString,
      keyedColors: [],
      warnings: ["Queue string could not be read; no slot obstacles added."],
    };
  }
  if (lanes.length === 0) return { queueString: input.queueString, keyedColors: [], warnings };

  const taken = new Set<string>();
  const groups: QueueGroup[] = [];
  const at = (c: Cell): QueueItem | undefined => lanes[c.x]?.[c.y];
  const usable = (c: Cell): boolean =>
    c.y >= 1 && at(c) !== undefined && at(c)!.kind === "ingredient" && !taken.has(cellKey(c));

  /** Every cell behind the front row, shuffled — the candidate pool for everything below. */
  const pool: Cell[] = [];
  lanes.forEach((lane, x) => {
    for (let y = 1; y < lane.length; y++) pool.push({ x, y });
  });
  shuffleInPlace(pool, input.rand);

  const claim = (cells: Cell[]): void => {
    for (const cell of cells) taken.add(cellKey(cell));
  };

  // ---- combined blocks: straight runs of 2 or 3 ----
  let placed = 0;
  for (let i = 0; i < input.config.queue.combined; i++) {
    const run = findRun(pool, usable, input.rand, 2 + Math.floor(input.rand() * 2));
    if (!run) break;
    groups.push({ kind: "combined", cells: run.map((c) => ({ x: c.x, y: c.y })) });
    claim(run);
    placed++;
  }
  if (placed < input.config.queue.combined) {
    warnings.push(`Only placed ${placed}/${input.config.queue.combined} combined blocks — no room for a legal run.`);
  }

  // ---- linked pairs: two adjacent columns, same row ----
  placed = 0;
  for (let i = 0; i < input.config.queue.linked; i++) {
    const pair = findLinkedPair(lanes.length, pool, usable, input.rand);
    if (!pair) break;
    groups.push({ kind: "linked", cells: pair.map((c) => ({ x: c.x, y: c.y })) });
    claim(pair);
    placed++;
  }
  if (placed < input.config.queue.linked) {
    warnings.push(`Only placed ${placed}/${input.config.queue.linked} linked pairs — no two adjacent columns had a free row.`);
  }

  // ---- per-tile statuses ----
  // Grouped cells are excluded: a frozen member of a combined block, or a key
  // inside a linked pair, is legal to write and awful to play.
  const singles = pool.filter((c) => usable(c));

  // One key per lock, placed before anything else can claim the slots — a lock
  // without its key is an unopenable cell, which is strictly worse than one
  // fewer hidden slot.
  const keyedColors: number[] = [];
  for (const colorId of input.lockColors) {
    const cell = singles.pop();
    if (!cell) break;
    addEffect(at(cell)!, { effectId: STATUS_HOLDING_KEY, params: [colorId] });
    taken.add(cellKey(cell));
    keyedColors.push(colorId);
  }
  if (keyedColors.length < input.lockColors.length) {
    warnings.push(
      `The queue had room for only ${keyedColors.length}/${input.lockColors.length} keys, so ${input.lockColors.length - keyedColors.length} colour lock(s) were removed rather than left unopenable.`,
    );
  }

  placed = 0;
  for (let i = 0; i < input.config.queue.hidden; i++) {
    const cell = singles.pop();
    if (!cell) break;
    addEffect(at(cell)!, { effectId: STATUS_HIDDEN, params: [] });
    taken.add(cellKey(cell));
    placed++;
  }
  if (placed < input.config.queue.hidden) {
    warnings.push(`Only placed ${placed}/${input.config.queue.hidden} hidden slots — not enough free queue cells.`);
  }

  // Freeze last, and never on every lane of one row: a fully frozen row has
  // nothing beside it to thaw from, which is the classic unwinnable queue.
  placed = 0;
  const frozenPerRow = new Map<number, number>();
  for (let i = 0; i < input.config.queue.frozen; i++) {
    const index = singles.findIndex((c) => (frozenPerRow.get(c.y) ?? 0) < lanes.length - 1);
    if (index === -1) break;
    const [cell] = singles.splice(index, 1);
    // A thaw count of 1-2 keeps the dig short enough that the audit can clear it.
    addEffect(at(cell)!, { effectId: STATUS_FREEZE, params: [1 + Math.floor(input.rand() * 2)] });
    frozenPerRow.set(cell.y, (frozenPerRow.get(cell.y) ?? 0) + 1);
    taken.add(cellKey(cell));
    placed++;
  }
  if (placed < input.config.queue.frozen) {
    warnings.push(`Only placed ${placed}/${input.config.queue.frozen} frozen slots — every remaining row would have frozen solid.`);
  }

  return { queueString: serializeQueues(lanes, groups), keyedColors, warnings };
}

/**
 * Removes colour locks the queue could not key, so every remaining lock has
 * exactly as many keys as it needs, PER COLOUR.
 *
 * This is the reconciliation the two passes need. The grid is placed first
 * (its locks are what tell the queue how many keys to emit), but how many keys
 * fit depends on the queue — so the only place the invariant can actually be
 * enforced is here, after both. Leaving the surplus lock on the board would be
 * a cell the player can see, is told how to open, and never can.
 */
export function dropUnkeyedLocks(gridString: string, keyedColors: number[]): string {
  let cells: GridCellConfig[];
  try {
    cells = parseGrid(gridString);
  } catch {
    return gridString;
  }

  // Keys still available per colour; a lock consumes as many as its keyCount.
  const available = new Map<number, number>();
  for (const colorId of keyedColors) available.set(colorId, (available.get(colorId) ?? 0) + 1);

  let changed = false;
  const kept = cells.map((cell) => {
    const lock = cell.effects.find((effect) => effect.effectId === CELL_COLOR_LOCK);
    if (!lock) return cell;
    const colorId = lock.params[0] ?? 0;
    const needed = Math.max(1, lock.params[1] ?? 1);
    const have = available.get(colorId) ?? 0;
    if (have < needed) {
      changed = true;
      return { effects: [] };
    }
    available.set(colorId, have - needed);
    return cell;
  });

  return changed ? serializeGrid(kept) : gridString;
}

function addEffect(item: QueueItem, effect: EffectInstance): void {
  item.effects = [...item.effects, effect];
}

/** A straight run of `length` adjacent free cells, horizontal or vertical. */
function findRun(
  pool: Cell[],
  usable: (c: Cell) => boolean,
  rand: () => number,
  length: number,
): Cell[] | null {
  const wanted = Math.max(2, Math.min(3, length));
  for (const start of pool) {
    if (!usable(start)) continue;
    // Try both orientations, in a seed-dependent order so a level's blocks are
    // not all horizontal.
    const orientations = rand() < 0.5 ? [[1, 0], [0, 1]] : [[0, 1], [1, 0]];
    for (const [dx, dy] of orientations) {
      const run: Cell[] = [];
      for (let step = 0; step < wanted; step++) {
        const cell = { x: start.x + dx * step, y: start.y + dy * step };
        if (!usable(cell)) break;
        run.push(cell);
      }
      if (run.length === wanted) return run;
    }
  }
  return null;
}

/** Two free cells on the same row, in adjacent columns. */
function findLinkedPair(
  laneCount: number,
  pool: Cell[],
  usable: (c: Cell) => boolean,
  rand: () => number,
): Cell[] | null {
  for (const start of pool) {
    if (!usable(start)) continue;
    const sides = rand() < 0.5 ? [1, -1] : [-1, 1];
    for (const dx of sides) {
      const other = { x: start.x + dx, y: start.y };
      if (other.x < 0 || other.x >= laneCount) continue;
      if (!usable(other)) continue;
      return [start, other];
    }
  }
  return null;
}

/** Fisher-Yates, from the caller's seeded rng so a level's layout is reproducible. */
function shuffleInPlace<T>(items: T[], rand: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}
