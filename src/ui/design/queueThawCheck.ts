// "Can the ice actually be broken?" — a queue-only deadlock audit for the
// Freeze status, run from the Ingredient Queues header button.
//
// Freeze thaws SIDEWAYS ONLY (see nodeSim.ts's decrementAdjacentFreezes): a
// pick decrements the frozen cells immediately left and right of every cell it
// removes, at the same row. That makes it easy to author a queue nobody can
// finish — two frozen fronts facing each other with nothing left to thaw them
// — and the failure is invisible until someone plays the level.
//
// Three passes, because "solvable" and "safe" are different questions:
//   A  exhaustive  — explores every reachable board state, so it can say
//                    definitively whether a player can strand themselves, and
//                    counts how many of those states are dead ends.
//   B  strategies  — plays named policies (left-to-right, ice-first, ...) plus
//                    a batch of random orders to the end, so a warning can say
//                    WHICH way of playing falls into the hole, and what share
//                    of unplanned play does.
//   C  metrics     — tightness (fewest legal picks at any reachable moment)
//                    and frozen slots that only ever have one side to thaw
//                    from: the two numbers that predict a fragile queue.
//
// The model ignores the grid, the tools and the orders — the question is only
// about the queue. It mirrors nodeSim's queue rules exactly (front-of-lane
// picking, linked chains needing every member at the front, rigid combined
// blocks, one-cell-at-a-time gravity) so a verdict means what the real engine
// would do.

import { EFFECT_FREEZE } from "../../core/effects.ts";
import type { QueueGroup, QueueGroupKind, QueueItem } from "../../core/types.ts";

/** "safe" — no reachable dead end at all. "risky" — finishable, but a player can strand themselves. */
export type ThawVerdict = "safe" | "risky" | "deadlock" | "unknown";

export interface StrategyResult {
  /** Display name of the play style. */
  name: string;
  /** True when this policy emptied the queue. */
  ok: boolean;
  /** Picks it managed before finishing or getting stuck. */
  picks: number;
}

export interface ThawReport {
  verdict: ThawVerdict;
  /** One line, ready to show as the panel's headline. */
  message: string;
  /**
   * Cells left on the board in the dead end the audit reports, at their
   * AUTHORED coordinates — what a designer has to unblock.
   */
  stuck: { x: number; y: number; freeze: number }[];
  /**
   * The frozen slots among those, keyed "x:y" — flagged in the panel until the
   * queue is edited and re-validated.
   */
  culprits: Set<string>;

  // ---- A: exhaustive ----
  /** Reachable states that finish the queue. */
  successStates: number;
  /** Reachable states with items left and no legal pick. */
  deadEndStates: number;
  /** Total states expanded. */
  statesExplored: number;
  /** True when the state budget or time limit stopped the exhaustive pass early. */
  budgetHit: boolean;

  // ---- B: strategies ----
  strategies: StrategyResult[];
  /** Random pick orders played to the end. */
  randomRuns: number;
  /** How many of those ended stuck — the "share of unplanned play that jams" number. */
  randomStuck: number;

  // ---- C: metrics ----
  /** Fewest legal picks available at any reachable state; 1 means a forced move. */
  tightness: number;
  /** Frozen slots whose ice can only ever be reached from one side (an edge lane, or a neighbour with nothing left). */
  singleSourceFrozen: { x: number; y: number; freeze: number }[];

  /** True when the queue carries no Freeze at all, so nothing had to be checked. */
  trivial: boolean;
  /** Wall-clock cost of the whole audit, for the panel's footer. */
  elapsedMs: number;
}

interface Cell {
  /** 1-based identity, stamped once — the state key reads this instead of a Map lookup. */
  id: number;
  /** Freeze picks still owed before this cell can be taken; 0 = free. */
  freeze: number;
  /** Index into `kinds`, or -1 for an ungrouped cell. */
  group: number;
  /**
   * Where this cell sits in the DRAFT the designer is editing. Cells slide as
   * the audit picks, so a dead end's own coordinates mean nothing to the UI —
   * these are what the queue panel flags.
   */
  ox: number;
  oy: number;
}

type Grid = (Cell | null)[][];

// High enough that the time budget below is what actually stops the in-page
// audit; it only guards against a queue whose states are cheap but endless.
const DEFAULT_MAX_STATES = 1_000_000;
/**
 * Exhaustive-pass ceiling for the in-page audit. Enough to finish every shipped
 * level except the very biggest frozen queue; past it, the verdict falls back on
 * the playthroughs and the panel offers the uncapped worker run.
 */
const DEFAULT_TIME_BUDGET_MS = 2500;
/** Random orders to sample, and the ceiling on how long sampling may take. A cut-short batch still gives an honest ratio — the denominator is what actually ran. */
const DEFAULT_RANDOM_RUNS = 400;
const DEFAULT_SAMPLE_BUDGET_MS = 400;
const MIN_RANDOM_RUNS = 60;

const freezeOf = (item: QueueItem): number =>
  item.effects.find((e) => e.effectId === EFFECT_FREEZE)?.params[0] ?? 0;

function buildGrid(queues: QueueItem[][], groups: QueueGroup[]): { grid: Grid; kinds: QueueGroupKind[] } {
  const height = queues.reduce((h, lane) => Math.max(h, lane.length), 0);
  const groupAt = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const cell of group.cells) groupAt.set(`${cell.x}:${cell.y}`, index);
  });
  let id = 0;
  const grid: Grid = queues.map((lane, x) =>
    Array.from({ length: height }, (_, y) => {
      const item = lane[y];
      if (!item) return null;
      return { id: ++id, freeze: freezeOf(item), group: groupAt.get(`${x}:${y}`) ?? -1, ox: x, oy: y };
    }),
  );
  return { grid, kinds: groups.map((g) => g.kind) };
}

const cloneGrid = (grid: Grid): Grid => grid.map((col) => col.map((cell) => (cell ? { ...cell } : null)));


function cellsOfGroup(grid: Grid, group: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let x = 0; x < grid.length; x++) {
    for (let y = 0; y < grid[x].length; y++) {
      if (grid[x][y]?.group === group) out.push({ x, y });
    }
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * The same one-step-at-a-time settle nodeSim.advanceQueues() runs. A combined
 * block only moves when EVERY one of its cells can, and moves as one — which
 * is exactly what lets a combined block leave holes behind it.
 */
function advance(grid: Grid, kinds: QueueGroupKind[]): void {
  const cols = grid.length;
  const height = grid[0]?.length ?? 0;

  // Fast path: with no combined block LIVE on the board, every cell falls on
  // its own, so one compaction pass per lane settles it. Checked against the
  // board rather than the level, because a queue that starts with combined
  // blocks stops having any once they are picked — and the audit runs this
  // millions of times.
  let combinedLive = false;
  for (let x = 0; x < cols && !combinedLive; x++) {
    for (let y = 0; y < height; y++) {
      const cell = grid[x][y];
      if (cell && cell.group !== -1 && kinds[cell.group] === "combined") {
        combinedLive = true;
        break;
      }
    }
  }
  if (!combinedLive) {
    for (let x = 0; x < cols; x++) {
      const col = grid[x];
      let write = 0;
      for (let y = 0; y < height; y++) {
        const cell = col[y];
        if (!cell) continue;
        col[y] = null;
        col[write++] = cell;
      }
    }
    return;
  }

  for (let pass = 0; pass <= height; pass++) {
    // One scan per pass to group the live combined cells — the same shape
    // nodeSim.advanceQueues() uses. Rebuilding this per CELL instead was what
    // made the exhaustive walk crawl on levels that use combined blocks.
    const byGroup = new Map<number, { x: number; y: number }[]>();
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < height; y++) {
        const g = grid[x][y]?.group ?? -1;
        if (g === -1 || kinds[g] !== "combined") continue;
        const list = byGroup.get(g);
        if (list) list.push({ x, y });
        else byGroup.set(g, [{ x, y }]);
      }
    }
    for (const cells of byGroup.values()) cells.sort((a, b) => a.y - b.y || a.x - b.x);

    let moved = false;
    for (let y = 1; y < height; y++) {
      for (let x = 0; x < cols; x++) {
        const cell = grid[x][y];
        if (!cell) continue;
        const inst =
          cell.group !== -1 && kinds[cell.group] === "combined" ? byGroup.get(cell.group)! : [{ x, y }];
        if (inst[0].x !== x || inst[0].y !== y) continue; // enumerate an instance once, from its anchor
        let canMove = true;
        for (const c of inst) {
          if (c.y === 0) { canMove = false; break; }
          const above = grid[c.x][c.y - 1];
          if (above === null) continue;
          // A cell vacated by this same instance is not an obstacle.
          if (!inst.some((o) => o.x === c.x && o.y === c.y - 1)) { canMove = false; break; }
        }
        if (!canMove) continue;
        for (const c of inst) {
          grid[c.x][c.y - 1] = grid[c.x][c.y];
          grid[c.x][c.y] = null;
        }
        for (const c of inst) c.y--;
        moved = true;
      }
    }
    if (!moved) return;
  }
}

/**
 * The instance fronting lane x, or null when nothing there can be picked —
 * nodeSim.pickInstanceCells(). A combined block picks from its front cell even
 * with members still behind; a linked chain waits for all of them.
 */
function instanceAtFront(grid: Grid, kinds: QueueGroupKind[], x: number): { x: number; y: number }[] | null {
  const front = grid[x]?.[0];
  if (!front) return null;
  if (front.group === -1) return [{ x, y: 0 }];
  const cells = cellsOfGroup(grid, front.group);
  if (kinds[front.group] === "linked" && cells.some((c) => c.y !== 0)) return null;
  return cells;
}

/**
 * Every lane that can be picked right now, with the cells each pick would take.
 * `fronts` hands out the one shared {x, 0} for an ungrouped front pick — by far
 * the common case, and the exhaustive walk asks this question millions of times.
 */
function legalPicks(
  grid: Grid,
  kinds: QueueGroupKind[],
  fronts?: { x: number; y: number }[][],
): { lane: number; cells: { x: number; y: number }[] }[] {
  const out: { lane: number; cells: { x: number; y: number }[] }[] = [];
  for (let x = 0; x < grid.length; x++) {
    const front = grid[x]?.[0];
    if (!front) continue;
    if (front.freeze > 0) continue;
    if (front.group === -1) {
      out.push({ lane: x, cells: fronts ? fronts[x] : [{ x, y: 0 }] });
      continue;
    }
    const cells = instanceAtFront(grid, kinds, x);
    if (!cells) continue;
    if (cells.some((c) => (grid[c.x][c.y]?.freeze ?? 0) > 0)) continue;
    out.push({ lane: x, cells });
  }
  return out;
}

/** Applies a pick in place: thaw the side neighbours first, then clear and settle. */
function applyPick(grid: Grid, kinds: QueueGroupKind[], cells: { x: number; y: number }[]): void {
  for (const { x, y } of cells) {
    for (const nx of [x - 1, x + 1]) {
      const neighbour = grid[nx]?.[y];
      if (neighbour && neighbour.freeze > 0) neighbour.freeze--;
    }
  }
  for (const { x, y } of cells) grid[x][y] = null;
  advance(grid, kinds);
}

/** What one reversible pick changed: the columns it rearranged, and the ice it melted. */
interface Undo {
  columns: { x: number; cells: (Cell | null)[] }[];
  thawed: Cell[];
}

/**
 * The same pick, recorded so it can be taken back. The exhaustive walk visits
 * millions of states; cloning the board for each one was what made it slow
 * enough to need truncating, so it makes the move, recurses, and unmakes it.
 * Only whole columns are saved (a handful of reference copies), never the cells
 * themselves — the one mutation to a cell is the freeze decrement, listed in
 * `thawed`.
 */
function applyPickUndoable(grid: Grid, kinds: QueueGroupKind[], cells: { x: number; y: number }[]): Undo {
  const undo: Undo = { columns: [], thawed: [] };
  // Without combined blocks a pick only ever disturbs its own column(s); with
  // them, gravity can shift a block that reaches into any column, so save all.
  if (kinds.includes("combined")) {
    for (let x = 0; x < grid.length; x++) undo.columns.push({ x, cells: grid[x].slice() });
  } else {
    const lanes = new Set(cells.map((c) => c.x));
    for (const x of lanes) undo.columns.push({ x, cells: grid[x].slice() });
  }
  for (const { x, y } of cells) {
    for (const nx of [x - 1, x + 1]) {
      const neighbour = grid[nx]?.[y];
      if (neighbour && neighbour.freeze > 0) {
        neighbour.freeze--;
        undo.thawed.push(neighbour);
      }
    }
  }
  for (const { x, y } of cells) grid[x][y] = null;
  advance(grid, kinds);
  return undo;
}

function undoPick(grid: Grid, undo: Undo): void {
  for (const cell of undo.thawed) cell.freeze++;
  for (const saved of undo.columns) {
    const col = grid[saved.x];
    for (let y = 0; y < col.length; y++) col[y] = saved.cells[y];
  }
}

const remainingCells = (grid: Grid): number =>
  grid.reduce((n, col) => n + col.reduce((m, cell) => m + (cell ? 1 : 0), 0), 0);

function stuckCells(grid: Grid): { x: number; y: number; freeze: number }[] {
  const out: { x: number; y: number; freeze: number }[] = [];
  for (let x = 0; x < grid.length; x++) {
    for (let y = 0; y < grid[x].length; y++) {
      const cell = grid[x][y];
      if (cell) out.push({ x: cell.ox, y: cell.oy, freeze: cell.freeze });
    }
  }
  return out.sort((a, b) => a.x - b.x || a.y - b.y);
}

/**
 * How much ice a pick would actually break: the frozen cells sitting beside
 * the very cells it removes, at those same rows. Counting ANY ice in the
 * neighbouring lanes instead would mislead an ice-seeking player into
 * spending picks that thaw nothing.
 */
function thawGain(grid: Grid, cells: { x: number; y: number }[]): number {
  let count = 0;
  for (const { x, y } of cells) {
    for (const nx of [x - 1, x + 1]) {
      const neighbour = grid[nx]?.[y];
      if (neighbour && neighbour.freeze > 0) count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------- B: play ---

type Policy = (
  picks: { lane: number; cells: { x: number; y: number }[] }[],
  grid: Grid,
) => number;

function laneLength(grid: Grid, lane: number): number {
  return grid[lane].reduce((n, cell) => n + (cell ? 1 : 0), 0);
}

/** Deterministic play styles. Index into `picks`, never out of range. */
const POLICIES: { name: string; pick: Policy }[] = [
  { name: "Left to right", pick: () => 0 },
  { name: "Right to left", pick: (picks) => picks.length - 1 },
  {
    name: "Longest lane first",
    pick: (picks, grid) =>
      picks.reduce((best, p, i) => (laneLength(grid, p.lane) > laneLength(grid, picks[best].lane) ? i : best), 0),
  },
  {
    name: "Shortest lane first",
    pick: (picks, grid) =>
      picks.reduce((best, p, i) => (laneLength(grid, p.lane) < laneLength(grid, picks[best].lane) ? i : best), 0),
  },
  {
    // The attentive player: spend picks where they actually break ice.
    name: "Ice first",
    pick: (picks, grid) =>
      picks.reduce((best, p, i) => (thawGain(grid, p.cells) > thawGain(grid, picks[best].cells) ? i : best), 0),
  },
  {
    // The player who never goes out of their way to thaw anything.
    name: "Ice blind",
    pick: (picks, grid) =>
      picks.reduce((best, p, i) => (thawGain(grid, p.cells) < thawGain(grid, picks[best].cells) ? i : best), 0),
  },
];

/** Plays one policy to the end. Returns where it got and the board it was left with. */
function playOut(
  start: Grid,
  kinds: QueueGroupKind[],
  choose: Policy,
): { ok: boolean; picks: number; grid: Grid } {
  const grid = cloneGrid(start);
  let picks = 0;
  // Counted down rather than rescanned: a playthrough is the audit's inner
  // loop and remainingCells() over the whole board every step dominated it.
  let left = remainingCells(grid);
  for (let guard = 0; left > 0 && guard < 10000; guard++) {
    const options = legalPicks(grid, kinds);
    if (options.length === 0) return { ok: false, picks, grid };
    const chosen = options[Math.min(options.length - 1, Math.max(0, choose(options, grid)))];
    left -= chosen.cells.length;
    applyPick(grid, kinds, chosen.cells);
    picks++;
  }
  return { ok: left === 0, picks, grid };
}

function seededRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// -------------------------------------------------------------------- run ---

export interface ThawCheckOptions {
  maxStates?: number;
  timeBudgetMs?: number;
  randomRuns?: number;
  sampleBudgetMs?: number;
}

/**
 * Audits a queue for Freeze deadlocks. A queue with no Freeze anywhere is
 * answered without any work — every lane front is always pickable, so no order
 * can get stuck.
 */
export function checkQueueThaw(
  queues: QueueItem[][],
  groups: QueueGroup[] = [],
  opts: ThawCheckOptions = {},
): ThawReport {
  const started = performance.now();
  const maxStates = opts.maxStates ?? DEFAULT_MAX_STATES;
  const timeBudget = opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const wantedRuns = opts.randomRuns ?? DEFAULT_RANDOM_RUNS;
  const sampleBudget = opts.sampleBudgetMs ?? DEFAULT_SAMPLE_BUDGET_MS;

  const empty = (): ThawReport => ({
    verdict: "safe",
    message: "No frozen slots — nothing can deadlock.",
    stuck: [],
    culprits: new Set(),
    successStates: 0,
    deadEndStates: 0,
    statesExplored: 0,
    budgetHit: false,
    strategies: [],
    randomRuns: 0,
    randomStuck: 0,
    tightness: 0,
    singleSourceFrozen: [],
    trivial: true,
    elapsedMs: 0,
  });

  if (!queues.some((lane) => lane.some((item) => freezeOf(item) > 0))) return empty();

  const { grid: start, kinds } = buildGrid(queues, groups);
  advance(start, kinds); // settle authored misalignment, exactly as the sim does on load

  // ---- A: exhaustive walk of every reachable state ----
  // Depth-first with make/unmake: no board is ever copied, and each state is
  // keyed by one compact string (one UTF-16 char per slot). That is what lets
  // the walk finish outright on most levels instead of being truncated.
  const seen = new Set<string>();
  let states = 0;
  let successStates = 0;
  let deadEndStates = 0;
  let budgetHit = false;
  let tightness = Infinity;
  let bestDeadEnd: Grid | null = null;
  let bestDeadEndLeft = Infinity;
  let aborted = false;

  const cols = start.length;
  const height = start[0]?.length ?? 0;
  const codes = new Array<number>(cols * height);
  const fronts = Array.from({ length: cols }, (_, x) => [{ x, y: 0 }]);
  const keyFast = (grid: Grid): string => {
    let at = 0;
    for (let x = 0; x < cols; x++) {
      const col = grid[x];
      for (let y = 0; y < height; y++) {
        const cell = col[y];
        // 0 = empty; otherwise the cell's identity and its remaining ice, which
        // together are the whole state of a slot.
        codes[at++] = cell ? cell.id * 8 + (cell.freeze < 7 ? cell.freeze : 7) : 0;
      }
    }
    return String.fromCharCode.apply(null, codes);
  };

  const overBudget = (): boolean =>
    states >= maxStates || (states & 255) === 0 && performance.now() - started > timeBudget;

  const walk = (grid: Grid, left: number): void => {
    if (aborted) return;
    const key = keyFast(grid);
    if (seen.has(key)) return;
    seen.add(key);
    states++;
    if (overBudget()) {
      budgetHit = true;
      aborted = true;
      return;
    }
    if (left === 0) {
      successStates++;
      return;
    }
    const options = legalPicks(grid, kinds, fronts);
    if (options.length === 0) {
      deadEndStates++;
      if (left < bestDeadEndLeft) {
        bestDeadEndLeft = left;
        bestDeadEnd = cloneGrid(grid);
      }
      return;
    }
    tightness = Math.min(tightness, options.length);
    for (const option of options) {
      const undo = applyPickUndoable(grid, kinds, option.cells);
      walk(grid, left - option.cells.length);
      undoPick(grid, undo);
      if (aborted) return;
    }
  };

  walk(start, remainingCells(start));

  // ---- B: named play styles, then unplanned play ----
  const strategies: StrategyResult[] = POLICIES.map((policy) => {
    const run = playOut(start, kinds, policy.pick);
    if (!run.ok && !bestDeadEnd) bestDeadEnd = run.grid;
    return { name: policy.name, ok: run.ok, picks: run.picks };
  });

  let randomStuck = 0;
  let randomRuns = 0;
  const sampleStarted = performance.now();
  for (let seed = 1; seed <= wantedRuns; seed++) {
    if (randomRuns >= MIN_RANDOM_RUNS && performance.now() - sampleStarted > sampleBudget) break;
    const rng = seededRng(seed * 2654435761);
    const run = playOut(start, kinds, (picks) => Math.floor(rng() * picks.length));
    randomRuns++;
    if (!run.ok) {
      randomStuck++;
      if (!bestDeadEnd) bestDeadEnd = run.grid;
    }
  }

  // ---- C: metrics ----
  const singleSourceFrozen: { x: number; y: number; freeze: number }[] = [];
  for (let x = 0; x < start.length; x++) {
    for (let y = 0; y < start[x].length; y++) {
      const cell = start[x][y];
      if (!cell || cell.freeze <= 0) continue;
      const sides = [x - 1, x + 1].filter((nx) => start[nx] && laneLength(start, nx) > 0);
      if (sides.length <= 1) singleSourceFrozen.push({ x: cell.ox, y: cell.oy, freeze: cell.freeze });
    }
  }

  const stuck = bestDeadEnd ? stuckCells(bestDeadEnd) : [];
  const frozenStuck = stuck.filter((c) => c.freeze > 0);
  const culprits = new Set(frozenStuck.map((c) => `${c.x}:${c.y}`));
  const lanes = [...new Set(frozenStuck.map((c) => c.x + 1))];
  const stuckPct = randomRuns > 0 ? Math.round((randomStuck / randomRuns) * 100) : 0;
  const failedStrategies = strategies.filter((s) => !s.ok);

  const base = {
    stuck,
    culprits,
    successStates,
    deadEndStates,
    statesExplored: states,
    budgetHit,
    strategies,
    randomRuns,
    randomStuck,
    tightness: Number.isFinite(tightness) ? tightness : 0,
    singleSourceFrozen,
    trivial: false,
    elapsedMs: performance.now() - started,
  };

  // No way through at all — the hard error. Certain only when the exhaustive
  // pass actually finished; a truncated one can only say "found none yet".
  if (successStates === 0 && !strategies.some((s) => s.ok) && randomStuck === randomRuns) {
    return {
      ...base,
      verdict: budgetHit ? "unknown" : "deadlock",
      message: budgetHit
        ? `No working pick order found in ${states} states (search truncated) — likely a deadlock in queue ${lanes.join(", ") || "?"}.`
        : `Deadlock: no pick order thaws everything — ${stuck.length} slot(s) strand, frozen in queue ${lanes.join(", ") || "?"}.`,
    };
  }

  if (deadEndStates > 0 || randomStuck > 0 || failedStrategies.length > 0) {
    const how = failedStrategies.length
      ? ` ${failedStrategies.map((s) => s.name).join(", ")} get${failedStrategies.length === 1 ? "s" : ""} stuck.`
      : "";
    return {
      ...base,
      verdict: "risky",
      message:
        `Finishable, but ${stuckPct}% of unplanned pick orders jam (${randomStuck}/${randomRuns}).${how}` +
        (budgetHit ? " (state search truncated.)" : ""),
    };
  }

  return {
    ...base,
    verdict: budgetHit ? "unknown" : "safe",
    message: budgetHit
      ? `No dead end found in ${states} states, but the search was truncated — not proven safe.`
      : `Safe: every one of the ${states} reachable states leads to a finished queue.`,
  };
}
