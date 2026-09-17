export interface QuotaAllocation {
  quotas: Record<string, number>;
  normalizedWeights: Record<string, number>;
}

/** Exact integer quotas using Hamilton's largest-remainder method. */
export function allocateLargestRemainder(
  weights: Readonly<Record<string, number>>,
  total: number,
): QuotaAllocation {
  if (!Number.isInteger(total) || total < 1) throw new Error("targetPickupUnits must be a positive integer.");
  const entries = Object.entries(weights)
    .filter(([, weight]) => Number.isFinite(weight) && weight > 0)
    .sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b));
  if (entries.length === 0) throw new Error("At least one positive ingredient weight is required.");
  const weightTotal = entries.reduce((sum, [, weight]) => sum + weight, 0);
  const rows = entries.map(([ingredient, weight]) => {
    const exact = total * weight / weightTotal;
    return { ingredient, exact, floor: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = total - rows.reduce((sum, row) => sum + row.floor, 0);
  const byRemainder = [...rows].sort(
    (a, b) => b.remainder - a.remainder
      || Number(a.ingredient) - Number(b.ingredient)
      || a.ingredient.localeCompare(b.ingredient),
  );
  for (let i = 0; i < left; i++) byRemainder[i % byRemainder.length].floor++;
  left = total - rows.reduce((sum, row) => sum + row.floor, 0);
  if (left !== 0) throw new Error("Quota allocation failed to preserve the requested total.");
  return {
    quotas: Object.fromEntries(rows.map((row) => [row.ingredient, row.floor])),
    normalizedWeights: Object.fromEntries(entries.map(([id, weight]) => [id, weight / weightTotal])),
  };
}

