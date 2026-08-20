/**
 * Selects the estimator step whose queue scores belong on the replay board.
 *
 * `completedStepCount` points at the next recorded pick while the replay is
 * idle. During animation it has already been incremented, so the active pick
 * is the preceding step. A completed replay has no upcoming queue to mark.
 */
export function replayScoreStepIndex(
  completedStepCount: number,
  busy: boolean,
  totalSteps: number,
): number | null {
  const candidate = busy ? completedStepCount - 1 : completedStepCount;
  return candidate >= 0 && candidate < totalSteps ? candidate : null;
}
