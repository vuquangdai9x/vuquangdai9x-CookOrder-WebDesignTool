import type { ConstraintValue, EvaluatedConstraint, MetricConstraint } from "./types.ts";

const scaleFor = (value: number): number => Math.max(1, Math.abs(value));

export function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1));
  return sorted[index];
}

export function proportionInterval(successes: number, total: number): [number, number] {
  if (total <= 0) return [0, 1];
  const p = successes / total;
  const margin = 1.96 * Math.sqrt((p * (1 - p)) / total);
  return [Math.max(0, p - margin), Math.min(1, p + margin)];
}

export function evaluateConstraint(constraint: MetricConstraint, actual: ConstraintValue | undefined, confidence?: number): EvaluatedConstraint {
  if (actual === undefined) return { constraintId: constraint.id, metric: constraint.metric, target: constraint.value, pass: false, normalizedGap: 1, priority: constraint.priority, weight: constraint.weight, ...(confidence !== undefined ? { confidence } : {}) };
  let pass = false;
  let normalizedGap = 1;
  if (typeof actual === "number" && typeof constraint.value === "number") {
    const target = constraint.value;
    if (constraint.operator === "=") { pass = actual === target; normalizedGap = Math.abs(actual - target) / scaleFor(target); }
    else if (constraint.operator === "!=") { pass = actual !== target; normalizedGap = pass ? 0 : 1; }
    else if (constraint.operator === "<") { pass = actual < target; normalizedGap = pass ? 0 : (actual - target + Number.EPSILON) / scaleFor(target); }
    else if (constraint.operator === "<=") { pass = actual <= target; normalizedGap = pass ? 0 : (actual - target) / scaleFor(target); }
    else if (constraint.operator === ">") { pass = actual > target; normalizedGap = pass ? 0 : (target - actual + Number.EPSILON) / scaleFor(target); }
    else if (constraint.operator === ">=") { pass = actual >= target; normalizedGap = pass ? 0 : (target - actual) / scaleFor(target); }
  } else if (constraint.operator === "between" && typeof actual === "number" && Array.isArray(constraint.value) && constraint.value.length === 2 && constraint.value.every((item) => typeof item === "number")) {
    const [min, max] = constraint.value as [number, number];
    pass = actual >= min && actual <= max;
    normalizedGap = pass ? 0 : actual < min ? (min - actual) / scaleFor(min) : (actual - max) / scaleFor(max);
  } else if (constraint.operator === "in" && Array.isArray(constraint.value)) {
    pass = constraint.value.includes(actual as never); normalizedGap = pass ? 0 : 1;
  } else if (constraint.operator === "=" || constraint.operator === "!=") {
    pass = constraint.operator === "=" ? actual === constraint.value : actual !== constraint.value;
    normalizedGap = pass ? 0 : 1;
  }
  return {
    constraintId: constraint.id,
    metric: constraint.metric,
    actual,
    target: constraint.value,
    pass,
    normalizedGap: Math.max(0, Math.min(10, normalizedGap)),
    priority: constraint.priority,
    weight: constraint.weight,
    ...(confidence !== undefined ? { confidence } : {}),
  };
}
