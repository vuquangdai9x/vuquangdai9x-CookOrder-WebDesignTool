import { describe, expect, it } from "vitest";
import { EFFECT_FREEZE } from "../../core/effects.ts";
import type { QueueItem } from "../../core/types.ts";
import { checkQueueThaw } from "./queueThawCheck.ts";

const plain = (id = 1): QueueItem => ({ kind: "ingredient", id, effects: [] });
const frozen = (n: number, id = 1): QueueItem => ({
  kind: "ingredient",
  id,
  effects: [{ effectId: EFFECT_FREEZE, params: [n] }],
});

describe("checkQueueThaw", () => {
  it("answers a freeze-free queue without doing any work at all", () => {
    const report = checkQueueThaw([[plain(), plain()], [plain()]]);
    expect(report.verdict).toBe("safe");
    expect(report.trivial).toBe(true);
    expect(report.statesExplored).toBe(0);
  });

  it("calls a queue safe when no reachable order can strand the player", () => {
    // Lane 2's front owes one side pick and lane 1 has nothing else to spend,
    // so every order thaws it.
    const report = checkQueueThaw([[plain()], [frozen(1)]]);
    expect(report.verdict).toBe("safe");
    expect(report.deadEndStates).toBe(0);
    expect(report.randomStuck).toBe(0);
  });

  it("flags a lone frozen slot with no lane beside it left to pick", () => {
    const report = checkQueueThaw([[plain(), frozen(1)]]);
    expect(report.verdict).toBe("deadlock");
    expect(report.stuck).toHaveLength(1);
    expect(report.message).toContain("queue 1");
    // The culprit is reported at its AUTHORED coordinates, for the panel to flag.
    expect([...report.culprits]).toEqual(["0:1"]);
  });

  it("flags two frozen fronts facing each other with nothing left to thaw them", () => {
    const report = checkQueueThaw([[plain(), frozen(1)], [frozen(2)]]);
    expect(report.verdict).toBe("deadlock");
    expect(report.successStates).toBe(0);
  });

  it("warns 'risky' when a queue is finishable but the wrong order strands it", () => {
    // Picking lane 2 first wastes its only pick on an unfrozen front and
    // strands lane 1's ice; picking lane 1's free item first solves it.
    const report = checkQueueThaw([[plain(), frozen(1)], [plain()]]);
    expect(report.verdict).toBe("risky");
    expect(report.successStates).toBeGreaterThan(0);
    expect(report.deadEndStates).toBeGreaterThan(0);
    expect(report.randomStuck).toBeGreaterThan(0);
    expect(report.randomStuck).toBeLessThan(report.randomRuns);
  });

  it("names which play styles fall into the hole", () => {
    const report = checkQueueThaw([[plain(), frozen(1)], [plain()]]);
    const byName = new Map(report.strategies.map((s) => [s.name, s.ok]));
    // The attentive player spends the free pick where it breaks ice.
    expect(byName.get("Ice first")).toBe(true);
    // Someone working right to left burns lane 2 first and jams.
    expect(byName.get("Right to left")).toBe(false);
    expect(report.message).toContain("Right to left");
  });

  it("does not thaw a frozen slot from its own lane, only from the sides", () => {
    // One lane, one free item in front of one frozen item: taking the free item
    // is a same-lane pick, which no longer breaks ice.
    expect(checkQueueThaw([[plain(), frozen(1)]]).verdict).toBe("deadlock");
    // The same pair with a neighbour lane to supply the side pick is finishable.
    expect(checkQueueThaw([[plain(), frozen(1)], [plain(), plain()]]).verdict).not.toBe("deadlock");
  });

  it("counts one side pick per frozen level, so a deeper freeze needs more neighbours", () => {
    expect(checkQueueThaw([[frozen(2)], [plain()]]).verdict).toBe("deadlock");
    expect(checkQueueThaw([[frozen(2)], [plain(), plain()]]).verdict).toBe("safe");
  });

  it("counts ice that only one lane can ever reach", () => {
    // Lane 1 is an edge lane, so its ice has a single possible thaw source.
    const report = checkQueueThaw([[frozen(2)], [plain(), plain()]]);
    expect(report.singleSourceFrozen).toEqual([{ x: 0, y: 0, freeze: 2 }]);
  });

  it("reports the tightest moment as the fewest legal picks it ever saw", () => {
    // Two lanes, one frozen front: the first move is forced.
    const report = checkQueueThaw([[plain(), plain()], [frozen(1)]]);
    expect(report.tightness).toBe(1);
  });

  it("keeps its answers when the exhaustive pass is truncated, and says so", () => {
    const lane = () => [plain(), plain(), plain(), plain(), plain(), frozen(1)];
    const report = checkQueueThaw([lane(), lane(), lane(), lane(), lane()], [], { maxStates: 3 });
    expect(report.budgetHit).toBe(true);
    expect(report.statesExplored).toBeLessThanOrEqual(3);
    // The playthroughs still ran in full, so there is still a usable verdict.
    expect(report.strategies.length).toBeGreaterThan(0);
    expect(report.message).toMatch(/truncated|jam/);
  });

  it("requires every member of a linked group to reach the front before it can be picked", () => {
    const queues = [[plain(), plain()], [plain()]];
    const linked = [{ kind: "linked" as const, cells: [{ x: 0, y: 1 }, { x: 1, y: 0 }] }];
    expect(checkQueueThaw(queues, linked).verdict).not.toBe("deadlock");
  });

  it("picks a combined block as one, from its front cell, even with members behind", () => {
    // The block spans (0,0)+(0,1) and clears in a single pick. Only its row-0
    // cell sits beside lane 2's frozen front, so the pair still delivers just
    // ONE thaw — enough for freeze 1, not for freeze 2.
    const combined = [{ kind: "combined" as const, cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }] }];
    expect(checkQueueThaw([[plain(), plain()], [frozen(1)]], combined).verdict).toBe("safe");
    expect(checkQueueThaw([[plain(), plain()], [frozen(2)]], combined).verdict).toBe("deadlock");
    // Ungrouped, the same two cells are two separate picks and thaw twice.
    expect(checkQueueThaw([[plain(), plain()], [frozen(2)]]).verdict).toBe("safe");
  });
});
