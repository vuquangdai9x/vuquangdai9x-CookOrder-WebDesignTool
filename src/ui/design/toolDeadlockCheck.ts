// Tool-and-slot deadlock check — the half of "can this level be played at all"
// that the queue-only ice audit (queueThawCheck.ts) cannot see.
//
// A pick has to land somewhere: a process slot, a preservation slot, or the
// grid. Tools with several inputs, and tools with preservation slots, can trap
// a level: fill a coffee machine's slots with cups and there is nowhere left to
// put the ground coffee the process needs, so the process can never run, the
// slots never free, and every pick that routes to that tool is refused forever.
// Under "block-pick" out-of-slot policy that means the queue stops dead.
//
// There is no shortcut model here — it drives the real NodeSimulation, because
// slot routing, preservation slots, chained processes and auto-serve are far
// too intertwined to re-implement faithfully. Each run is one full playthrough
// under a named pick policy, plus a batch of random orders, and a run counts as
// deadlocked when the simulation is still playing, still has ingredients queued,
// nothing is cooking, and no lane will accept a pick.

import { NodeSimulation } from "../../core/nodeSim.ts";
import type { NodeLevelConfig } from "../../core/nodeSim.ts";
import type { GraphIndex } from "../../core/nodeIndex.ts";

/**
 * What kind of jam a blocked run hit. "tool" is the one this check exists for:
 * a process or preservation slot that can never free up. "grid" is the board
 * filling with parked ingredients — also permanent, but a different authoring
 * problem, so the panel keeps them apart.
 */
export type BlockKind = "tool" | "grid" | "other";

export function classifyReason(reason: string): BlockKind {
  if (/is full|preservation slots are full/i.test(reason)) {
    return /grid has no space/i.test(reason) ? "grid" : "tool";
  }
  if (/free grid cell|grid/i.test(reason)) return "grid";
  return "other";
}

export interface ToolRunResult {
  name: string;
  /** The run ended without deadlocking (won, lost on time/space, or ran the queue dry). */
  ok: boolean;
  picks: number;
  /** Why the queue stopped, when it did — one line per blocked lane. */
  reasons: string[];
}

export interface ToolDeadlockReport {
  /** Named play styles, in order. */
  runs: ToolRunResult[];
  randomRuns: number;
  randomBlocked: number;
  /** Distinct blocking reasons seen across every blocked run, most common first. */
  reasonCounts: { reason: string; count: number; kind: BlockKind }[];
  /** Runs that jammed on a tool/preservation slot, and on grid space. */
  toolBlocked: number;
  gridBlocked: number;
  /** Slot-by-slot picture of the first deadlock found, for the panel. */
  toolSnapshot: { tool: string; slots: string[]; preservation: number }[];
  /** True when no run deadlocked. */
  clean: boolean;
  elapsedMs: number;
}

const MAX_PICKS = 4000;
const MAX_PAIR_DISHES = 5;

/** Drain flights and ready tool lanes, the same resting state the estimator uses. */
function settle(sim: NodeSimulation): void {
  for (let guard = 0; guard < 200 && sim.status === "playing"; guard++) {
    sim.completeAllFlights();
    const completion = sim.nextCompletionIn();
    if (completion === null) break;
    sim.tick(Math.max(0.01, completion));
  }
  sim.completeAllFlights();
}

/** Keep the serve window in step and let pending customers walk in. */
function syncWindow(sim: NodeSimulation): void {
  for (let guard = 0; guard < 8; guard++) {
    const upcoming = [...sim.active, ...sim.pending];
    sim.level.serveableSlots =
      upcoming.length >= 2 && upcoming[0].dishes.length + upcoming[1].dishes.length <= MAX_PAIR_DISHES ? 2 : 1;
    if (sim.status !== "playing") return;
    if (sim.active.length >= sim.level.serveableSlots || sim.pending.length === 0) return;
    const before = sim.active.length;
    sim.tick(0);
    if (sim.active.length === before) return;
  }
}

function queuedItems(sim: NodeSimulation): number {
  let n = 0;
  for (const col of sim.queueGrid) for (const cell of col) if (cell) n++;
  return n;
}

/** Why each lane that still holds something refuses to be picked. */
function blockingReasons(sim: NodeSimulation): string[] {
  const seen = new Set<string>();
  for (let x = 0; x < sim.columnCount; x++) {
    if (!sim.frontCell(x)) continue;
    const check = sim.canPick(x);
    if (check.ok) continue;
    seen.add(check.reason ?? "Blocked");
  }
  return [...seen];
}

function toolSnapshot(sim: NodeSimulation): { tool: string; slots: string[]; preservation: number }[] {
  return sim.tools.map((tool) => ({
    tool: tool.displayName || tool.name,
    slots: tool.slots.map((slot) => (slot.item ? sim.ingredientName(slot.item.ing) : "—")),
    preservation: tool.preservationSlotCount,
  }));
}

type Choose = (lanes: number[], sim: NodeSimulation) => number;

const laneDepth = (sim: NodeSimulation, lane: number): number => sim.remainingIn(lane);

const POLICIES: { name: string; choose: Choose }[] = [
  { name: "Left to right", choose: () => 0 },
  { name: "Right to left", choose: (lanes) => lanes.length - 1 },
  {
    name: "Longest lane first",
    choose: (lanes, sim) =>
      lanes.reduce((best, lane, i) => (laneDepth(sim, lane) > laneDepth(sim, lanes[best]) ? i : best), 0),
  },
  {
    name: "Shortest lane first",
    choose: (lanes, sim) =>
      lanes.reduce((best, lane, i) => (laneDepth(sim, lane) < laneDepth(sim, lanes[best]) ? i : best), 0),
  },
];

function seededRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface RunOutcome {
  blocked: boolean;
  picks: number;
  reasons: string[];
  sim: NodeSimulation;
}

/**
 * One playthrough. "Blocked" is deliberately narrow: the level is still live,
 * ingredients are still queued, nothing is in flight or cooking, and no lane
 * accepts a pick — a state a player can never get out of. Losing on patience or
 * a full grid is a difficulty problem, not a deadlock, and does not count.
 */
function playOnce(ix: GraphIndex, level: NodeLevelConfig, choose: Choose): RunOutcome {
  const sim = new NodeSimulation(ix, structuredClone(level), {
    outOfSlotPolicy: level.outOfSlotPolicy ?? "block-pick",
    instantFlights: true,
  });
  settle(sim);
  syncWindow(sim);

  let picks = 0;
  for (let guard = 0; guard < MAX_PICKS; guard++) {
    if (sim.status !== "playing") return { blocked: false, picks, reasons: [], sim };

    const lanes: number[] = [];
    for (let x = 0; x < sim.columnCount; x++) if (sim.canPick(x).ok) lanes.push(x);

    if (lanes.length === 0) {
      // Nothing pickable: either something is still cooking (fast-forward and
      // look again), or this is as far as the level goes.
      if (sim.fastForward() !== 0) {
        syncWindow(sim);
        continue;
      }
      if (queuedItems(sim) === 0) return { blocked: false, picks, reasons: [], sim };
      return { blocked: true, picks, reasons: blockingReasons(sim), sim };
    }

    const index = Math.min(lanes.length - 1, Math.max(0, choose(lanes, sim)));
    if (!sim.pick(lanes[index])) return { blocked: true, picks, reasons: blockingReasons(sim), sim };
    picks++;
    settle(sim);
    syncWindow(sim);
  }
  return { blocked: false, picks, reasons: [], sim };
}

export interface ToolDeadlockOptions {
  randomRuns?: number;
  /** Sampling stops once this much time has gone; the counts stay honest. */
  budgetMs?: number;
}

export function checkToolDeadlock(
  ix: GraphIndex,
  level: NodeLevelConfig,
  opts: ToolDeadlockOptions = {},
): ToolDeadlockReport {
  const started = performance.now();
  const wantedRuns = opts.randomRuns ?? 60;
  const budget = opts.budgetMs ?? 1500;

  const reasonCounts = new Map<string, number>();
  let firstBlocked: RunOutcome | null = null;
  let toolBlocked = 0;
  let gridBlocked = 0;
  const note = (outcome: RunOutcome) => {
    if (!outcome.blocked) return;
    const kinds = new Set(outcome.reasons.map(classifyReason));
    if (kinds.has("tool")) toolBlocked++;
    else if (kinds.has("grid")) gridBlocked++;
    // A tool jam is the more specific diagnosis, so keep the first one of those
    // for the slot snapshot rather than whichever run stalled first.
    if (!firstBlocked || (kinds.has("tool") && !firstBlocked.reasons.some((r) => classifyReason(r) === "tool"))) {
      firstBlocked = outcome;
    }
    for (const reason of outcome.reasons) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  };

  const runs: ToolRunResult[] = POLICIES.map((policy) => {
    const outcome = playOnce(ix, level, policy.choose);
    note(outcome);
    return { name: policy.name, ok: !outcome.blocked, picks: outcome.picks, reasons: outcome.reasons };
  });

  let randomRuns = 0;
  let randomBlocked = 0;
  for (let seed = 1; seed <= wantedRuns; seed++) {
    if (randomRuns > 0 && performance.now() - started > budget) break;
    const rng = seededRng(seed * 2654435761);
    const outcome = playOnce(ix, level, (lanes) => Math.floor(rng() * lanes.length));
    randomRuns++;
    if (outcome.blocked) randomBlocked++;
    note(outcome);
  }

  return {
    runs,
    randomRuns,
    randomBlocked,
    reasonCounts: [...reasonCounts]
      .map(([reason, count]) => ({ reason, count, kind: classifyReason(reason) }))
      .sort((a, b) => b.count - a.count),
    toolBlocked,
    gridBlocked,
    toolSnapshot: firstBlocked ? toolSnapshot((firstBlocked as RunOutcome).sim) : [],
    clean: !firstBlocked,
    elapsedMs: performance.now() - started,
  };
}
