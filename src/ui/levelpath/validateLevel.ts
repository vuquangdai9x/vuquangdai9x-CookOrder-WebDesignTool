// "Is this level playable?", condensed to the handful of lines the Level Path
// table's Status column can show.
//
// Three audits, deliberately the SAME three the Design view offers, because a
// level that passes here and fails there (or vice versa) would make the table
// worse than useless:
//
//   solvable  — checkNodeSolvable: can an omniscient scoring solver win it
//   freeze    — checkQueueThaw: can the ice in the queue always be thawed
//   tools     — checkToolDeadlock: can a tool or preservation slot trap the run
//
// The audits are budgeted much tighter than the Design panels', since Validate
// All runs this across a whole map. A budget that runs out is reported as such
// rather than silently downgraded to a pass: "we did not find a problem in
// 400ms" and "there is no problem" are different claims, and only one of them
// is safe to act on.

import { checkNodeSolvable } from "../design/checkSolvable.ts";
import type { EstimateResult } from "../design/estimateDifficulty.ts";
import type { EstimateScenario } from "../design/estimateScenario.ts";
import { checkQueueThaw } from "../design/queueThawCheck.ts";
import { checkToolDeadlock } from "../design/toolDeadlockCheck.ts";
import { parseQueueGroups, parseQueues } from "../../core/parser.ts";
import type { GraphIndex } from "../../core/nodeIndex.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import { toNodeLevelConfig } from "../../data/nodeLevel.ts";
import { orderIdIndex } from "../../core/nodeOrder.ts";
import { queueItemAmount } from "../../core/parser.ts";
import type { QueueItem } from "../../core/types.ts";

/** Bag slots whose amount falls outside their ingredient's stackMin..stackMax. */
export function bagsOutsideStackRange(
  queues: QueueItem[][],
  ix: GraphIndex,
): { name: string; amount: number; min: number; max: number }[] {
  const ids = orderIdIndex(ix);
  const out: { name: string; amount: number; min: number; max: number }[] = [];
  for (const lane of queues) {
    for (const item of lane) {
      if (item.kind !== "ingredient") continue;
      const amount = queueItemAmount(item);
      if (amount < 2) continue;
      const name = ids.byId.ingredient.get(item.id);
      const dense = name === undefined ? undefined : ix.ingByName.get(name);
      if (dense === undefined) continue;
      const { min, max } = ix.stackRange[dense];
      if (amount < min || amount > max) {
        out.push({ name: ix.doc.vertices.ingredient[dense]?.displayName ?? name!, amount, min, max });
      }
    }
  }
  return out;
}

/** What the Status column shows for one level, newest run wins. */
export interface LevelStatus {
  /** No errors and no warnings — the row's green tick. */
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Omniscient run used by Validate; absent until validation has happened. */
  estimate?: EstimateResult | null;
  /** Wall-clock cost, so a designer can see which levels are expensive to audit. */
  elapsedMs?: number;
}

export const emptyStatus = (): LevelStatus => ({ ok: true, errors: [], warnings: [] });

export interface ValidateOptions {
  scenario?: EstimateScenario;
  /** Random deadlock runs; lowered from the Design panel's default for batch work. */
  deadlockRuns?: number;
  /** Wall-clock ceiling for each of the two sampling audits. */
  budgetMs?: number;
  /** Skip the tool/slot audit — the expensive one — when only playability matters. */
  skipDeadlock?: boolean;
  /** An omniscient solvability result already computed for this exact level. */
  solvability?: EstimateResult | null;
}

/**
 * Runs the three audits over ONE level and folds them into a status.
 *
 * Never throws: a level whose strings do not parse is exactly the level a
 * designer most needs a row for, and a thrown error would take the whole batch
 * down with it.
 */
export function validateLevel(
  level: LevelData,
  ix: GraphIndex,
  opts: ValidateOptions = {},
): LevelStatus {
  const started = performance.now();
  const errors: string[] = [];
  const warnings: string[] = [];
  let estimate: EstimateResult | null = null;

  let config;
  try {
    config = toNodeLevelConfig(level);
  } catch (err) {
    return {
      ok: false,
      errors: [`Level strings could not be read: ${(err as Error).message}`],
      warnings: [],
      estimate: null,
      elapsedMs: performance.now() - started,
    };
  }

  if (config.customers.length === 0) warnings.push("No customers — nothing to serve.");
  if (config.queues.every((lane) => lane.length === 0)) warnings.push("Every queue lane is empty.");

  // ---- bag sizes vs. the graph's stack range (soft: designers may exceed it) ----
  const outside = bagsOutsideStackRange(config.queues, ix);
  if (outside.length > 0) {
    warnings.push(
      `${outside.length} bag(s) outside the ingredient's stack range: ` +
        outside.slice(0, 4).map((o) => `${o.name} ×${o.amount} (${o.min}–${o.max})`).join(", ") +
        (outside.length > 4 ? ", …" : "") + ".",
    );
  }

  // ---- playable ----
  try {
    estimate =
      opts.solvability ??
      checkNodeSolvable(ix, structuredClone(config), {
        ...(opts.scenario ? { scenario: opts.scenario } : {}),
      });
    if (!estimate.solvable) {
      errors.push(`Unwinnable: ${estimate.reason ?? estimate.loseReason ?? "the solver ran out of moves"}.`);
    } else if (estimate.servedCount < estimate.totalCustomers) {
      warnings.push(`Only ${estimate.servedCount}/${estimate.totalCustomers} customers served.`);
    }
    const timedOutCustomers = estimate.timedOutCustomers ?? [];
    if (timedOutCustomers.length > 0) {
      warnings.push(
        `Customer${timedOutCustomers.length === 1 ? "" : "s"} ` +
        `${timedOutCustomers.join(", ")} timed out during the solvability check.`,
      );
    }
  } catch (err) {
    errors.push(`Estimate failed: ${(err as Error).message}`);
  }

  // ---- freeze deadlock ----
  try {
    const thaw = checkQueueThaw(parseQueues(level.queueString), parseQueueGroups(level.queueString), {
      timeBudgetMs: opts.budgetMs ?? 400,
      sampleBudgetMs: opts.budgetMs ?? 400,
    });
    if (thaw.verdict === "deadlock") errors.push(`Freeze deadlock: ${thaw.message}`);
    else if (thaw.verdict === "risky") warnings.push(`Freeze risk: ${thaw.message}`);
    else if (thaw.verdict === "unknown") warnings.push(`Freeze audit inconclusive: ${thaw.message}`);
  } catch (err) {
    warnings.push(`Freeze audit failed: ${(err as Error).message}`);
  }

  // ---- tool/slot deadlock ----
  if (!opts.skipDeadlock) {
    try {
      const tools = checkToolDeadlock(ix, structuredClone(config), {
        randomRuns: opts.deadlockRuns ?? 12,
        budgetMs: opts.budgetMs ?? 400,
      });
      if (!tools.clean) {
        const top = tools.reasonCounts[0];
        // Counted from the REASON, not from toolBlocked + gridBlocked: a run
        // can jam for a reason that is neither (classifyReason's "other"), and
        // summing the two classified buckets then reported "Deadlock in 0
        // run(s)" — a sentence that says a jam happened zero times.
        const line = `Deadlock in ${top?.count ?? 1} run(s): ${top?.reason ?? "a slot never freed up"}`;
        if (tools.toolBlocked > 0) errors.push(line);
        else warnings.push(line);
      }
    } catch (err) {
      warnings.push(`Deadlock audit failed: ${(err as Error).message}`);
    }
  }

  return {
    ok: errors.length === 0 && warnings.length === 0,
    errors,
    warnings,
    estimate,
    elapsedMs: performance.now() - started,
  };
}
