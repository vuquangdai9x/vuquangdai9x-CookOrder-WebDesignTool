import type { MutationExperimentRecord } from "./types.ts";

export function repairFamilyForMetric(metric: string): string {
  if (metric.startsWith("amount.")) return "amount";
  if (metric.startsWith("queue.")) return "queue-order";
  if (metric.startsWith("grid.")) return "capacity";
  if (metric.startsWith("customers.") || metric.startsWith("content.")) return "demand";
  if (metric.startsWith("experience.") || metric.startsWith("pacing.")) return "pacing";
  if (metric.startsWith("mechanics.")) return "mechanic-placement";
  return "fundamental";
}

export function rankExperiments(experiments: MutationExperimentRecord[]): MutationExperimentRecord[] {
  return [...experiments].sort((a, b) =>
    Number(b.after.passed) - Number(a.after.passed)
    || a.after.hardFailures.length - b.after.hardFailures.length
    || a.after.weightedGap - b.after.weightedGap
    || (b.before.weightedGap - b.after.weightedGap) - (a.before.weightedGap - a.after.weightedGap)
    || a.id.localeCompare(b.id));
}
