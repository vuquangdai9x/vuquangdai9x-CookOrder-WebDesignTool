import { describe, expect, it } from "vitest";
import { replayScoreStepIndex } from "./replayScoreStep.ts";

describe("estimate replay queue score step", () => {
  it("shows the upcoming recorded pick while the replay is idle", () => {
    expect(replayScoreStepIndex(0, false, 3)).toBe(0);
    expect(replayScoreStepIndex(1, false, 3)).toBe(1);
  });

  it("keeps showing the active pick while that step is animating", () => {
    expect(replayScoreStepIndex(1, true, 3)).toBe(0);
    expect(replayScoreStepIndex(3, true, 3)).toBe(2);
  });

  it("does not highlight a queue after the final state is reached", () => {
    expect(replayScoreStepIndex(3, false, 3)).toBeNull();
  });

  it("uses the recorded pick rather than deriving a lane from the maximum score", () => {
    const steps = [{ lane: 1, laneScores: [100, 20, 300] }];
    const index = replayScoreStepIndex(0, false, steps.length);
    expect(index).toBe(0);
    expect(steps[index!].lane).toBe(1);
    expect(steps[index!].lane).not.toBe(2); // lane 2 has the maximum score
  });
});
