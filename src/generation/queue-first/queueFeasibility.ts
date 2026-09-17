import type { PickupPlanStep, QueueArtifact, QueueFeasibilityWitness } from "./contracts.ts";
import { appendPickupAction, replayPickupSteps } from "./pickupState.ts";

interface Analysis {
  viable: boolean;
  suffix: PickupPlanStep[];
  branchTotal: number;
  branchStates: number;
  minimumBranching: number;
  maximumBranching: number;
}

export interface QueueFeasibilityResult {
  ok: boolean;
  reason?: string;
  witness?: QueueFeasibilityWitness;
}

/**
 * Proves a queue against two design constraints at once:
 * - every reachable pickup burst must fit the current playable grid capacity;
 * - forceMove=0 requires all choices to retain a completion, while forceMove=1
 *   requires one completion. Intermediate values require that fraction of the
 *   choices at every reachable state to remain winnable.
 */
export function analyzeQueueFeasibility(
  queue: QueueArtifact,
  gridCapacity: number,
  forceMove: number,
  limits: { maximumExpandedStates?: number; wallTimeMs?: number } = {},
): QueueFeasibilityResult {
  const capacity = Math.max(0, Math.trunc(gridCapacity));
  const force = Math.max(0, Math.min(1, forceMove));
  const maximumExpandedStates = Math.max(1, Math.trunc(limits.maximumExpandedStates ?? 50_000));
  const deadline = (typeof performance === "undefined" ? Date.now() : performance.now()) + Math.max(1, limits.wallTimeMs ?? 2_500);
  const memo = new Map<string, Analysis>();
  let exploredStates = 0;
  let budgetExceeded = false;

  const slotById = new Map(queue.lanes.flatMap((lane) => lane.slots.map((slot) => [slot.id, slot] as const)));
  const groupedIds = new Set(queue.groups.flatMap((group) => group.slotIds));
  const pickupBursts = [
    ...queue.groups.map((group) => ({
      label: `${group.kind} group ${group.id}`,
      amount: group.slotIds.reduce((sum, id) => sum + (slotById.get(id)?.amount ?? 0), 0),
    })),
    ...queue.lanes.flatMap((lane) => lane.slots
      .filter((slot) => !groupedIds.has(slot.id))
      .map((slot) => ({ label: `slot ${slot.id}`, amount: slot.amount }))),
  ];
  const oversizedBurst = pickupBursts.find((burst) => burst.amount > capacity);
  if (oversizedBurst) {
    return {
      ok: false,
      reason: `${oversizedBurst.label} releases ${oversizedBurst.amount} items, exceeding the grid capacity of ${capacity}.`,
    };
  }

  const visit = (steps: PickupPlanStep[]): Analysis => {
    const replay = replayPickupSteps(queue, steps);
    const cached = memo.get(replay.stateHash);
    if (cached) return cached;
    const now = typeof performance === "undefined" ? Date.now() : performance.now();
    if (++exploredStates > maximumExpandedStates || now >= deadline) {
      budgetExceeded = true;
      return { viable: false, suffix: [], branchTotal: 0, branchStates: 0, minimumBranching: 0, maximumBranching: 0 };
    }
    if (!replay.valid) {
      return { viable: false, suffix: [], branchTotal: 0, branchStates: 0, minimumBranching: 0, maximumBranching: 0 };
    }
    if (replay.remaining === 0) {
      const complete = { viable: true, suffix: [], branchTotal: 0, branchStates: 0, minimumBranching: Number.POSITIVE_INFINITY, maximumBranching: 0 };
      memo.set(replay.stateHash, complete);
      return complete;
    }
    const actions = replay.legalActions;
    if (actions.length === 0) {
      const dead = { viable: false, suffix: [], branchTotal: 0, branchStates: 1, minimumBranching: 0, maximumBranching: 0 };
      memo.set(replay.stateHash, dead);
      return dead;
    }
    const children: Array<{ step: PickupPlanStep; analysis: Analysis }> = [];
    const requiredWinners = Math.max(1, Math.ceil(actions.length * (1 - force)));
    let winningCount = 0;
    for (const action of actions) {
      const appended = appendPickupAction(queue, steps, action.id);
      if (!appended.step) continue;
      const child = { step: appended.step, analysis: visit([...steps, appended.step]) };
      children.push(child);
      if (child.analysis.viable) winningCount++;
      if (winningCount >= requiredWinners || winningCount + actions.length - children.length < requiredWinners) break;
    }
    const winning = children.filter((child) => child.analysis.viable);
    const viable = winning.length >= requiredWinners;
    const preferred = winning.sort((a, b) => {
      const aBranch = a.analysis.branchStates ? a.analysis.branchTotal / a.analysis.branchStates : 0;
      const bBranch = b.analysis.branchStates ? b.analysis.branchTotal / b.analysis.branchStates : 0;
      return force >= 0.5 ? aBranch - bBranch : bBranch - aBranch;
    })[0];
    const childStats = children.reduce((stats, child) => ({
      total: stats.total + child.analysis.branchTotal,
      states: stats.states + child.analysis.branchStates,
      min: Math.min(stats.min, child.analysis.minimumBranching),
      max: Math.max(stats.max, child.analysis.maximumBranching),
    }), { total: 0, states: 0, min: Number.POSITIVE_INFINITY, max: 0 });
    const result: Analysis = {
      viable,
      suffix: viable && preferred ? [preferred.step, ...preferred.analysis.suffix] : [],
      branchTotal: actions.length + childStats.total,
      branchStates: 1 + childStats.states,
      minimumBranching: Math.min(actions.length, childStats.min),
      maximumBranching: Math.max(actions.length, childStats.max),
    };
    memo.set(replay.stateHash, result);
    return result;
  };

  const analysis = visit([]);
  if (budgetExceeded) return { ok: false, reason: `Feasibility proof exceeded ${maximumExpandedStates} states or its time budget.` };
  if (!analysis.viable) return { ok: false, reason: `Queue does not meet the force-move requirement (${Math.round(force * 100)}%).` };
  return {
    ok: true,
    witness: {
      gridCapacity: capacity,
      forceMove: force,
      requiredWinningChoiceRatio: 1 - force,
      exploredStates,
      minimumBranching: Number.isFinite(analysis.minimumBranching) ? analysis.minimumBranching : 0,
      maximumBranching: analysis.maximumBranching,
      averageBranching: analysis.branchStates === 0 ? 0 : analysis.branchTotal / analysis.branchStates,
      capacitySafe: true,
      witnessSteps: analysis.suffix,
    },
  };
}
