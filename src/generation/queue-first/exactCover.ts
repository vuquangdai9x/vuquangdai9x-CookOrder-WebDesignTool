import type { DishTemplate } from "./dishTemplateCatalog.ts";

export interface ExactCoverLimits {
  maximumExpandedStates: number;
  wallTimeMs: number;
  maximumItems: number;
}

export interface ExactCoverResult {
  exact: boolean;
  templates: DishTemplate[];
  expandedStates: number;
  exhausted: boolean;
  remaining: Record<string, number>;
}

const now = (): number => typeof performance === "undefined" ? Date.now() : performance.now();

function normalize(values: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(values)
    .map(([key, value]) => [key, Math.max(0, Math.trunc(value))] as const)
    .filter(([, value]) => value > 0)
    .sort(([a], [b]) => a.localeCompare(b)));
}

function fits(template: DishTemplate, remaining: Readonly<Record<string, number>>): boolean {
  return Object.entries(template.rawSignature).every(([key, value]) => value <= (remaining[key] ?? 0));
}

function subtract(
  remaining: Readonly<Record<string, number>>,
  signature: Readonly<Record<string, number>>,
): Record<string, number> {
  const next = { ...remaining };
  for (const [key, value] of Object.entries(signature)) {
    next[key] = (next[key] ?? 0) - value;
    if (next[key] === 0) delete next[key];
  }
  return next;
}

/** Exact multiset cover over raw pickup units, with deterministic scarcity-first branching. */
export function solveExactCover(
  supply: Readonly<Record<string, number>>,
  templates: readonly DishTemplate[],
  limits: ExactCoverLimits,
): ExactCoverResult {
  const start = normalize(supply);
  const usable = templates
    .filter((template) => Object.keys(template.rawSignature).length > 0 && fits(template, start))
    .slice()
    .sort((a, b) => b.dishTypeWeight - a.dishTypeWeight
      || b.complexity - a.complexity
      || a.id.localeCompare(b.id));
  const byIngredient = new Map<string, DishTemplate[]>();
  for (const template of usable) {
    for (const ingredient of Object.keys(template.rawSignature)) {
      const list = byIngredient.get(ingredient);
      if (list) list.push(template);
      else byIngredient.set(ingredient, [template]);
    }
  }
  const maxExpanded = Math.max(1, Math.trunc(limits.maximumExpandedStates));
  const maxItems = Math.max(0, Math.trunc(limits.maximumItems));
  const deadline = now() + Math.max(1, limits.wallTimeMs);
  const memo = new Set<string>();
  let expanded = 0;
  let exhausted = false;
  let best: { chosen: DishTemplate[]; remaining: Record<string, number>; distance: number } = {
    chosen: [],
    remaining: start,
    distance: Object.values(start).reduce((sum, value) => sum + value, 0),
  };

  const visit = (remaining: Record<string, number>, chosen: DishTemplate[]): DishTemplate[] | null => {
    if (Object.keys(remaining).length === 0) return chosen;
    if (chosen.length >= maxItems || expanded >= maxExpanded || now() >= deadline) {
      if (expanded >= maxExpanded || now() >= deadline) exhausted = true;
      return null;
    }
    const key = `${chosen.length}|${Object.entries(remaining).map(([id, amount]) => `${id}:${amount}`).join(",")}`;
    if (memo.has(key)) return null;
    memo.add(key);
    expanded++;
    const distance = Object.values(remaining).reduce((sum, value) => sum + value, 0);
    if (distance < best.distance) best = { chosen, remaining, distance };

    const ranked = Object.keys(remaining).map((ingredient) => ({
      ingredient,
      candidates: (byIngredient.get(ingredient) ?? []).filter((template) => fits(template, remaining)),
    })).sort((a, b) => {
      // Ingredients with no possible consumer prove infeasibility, but putting
      // them last lets the failure result still report the closest consumable remainder.
      if ((a.candidates.length === 0) !== (b.candidates.length === 0)) return a.candidates.length === 0 ? 1 : -1;
      return a.candidates.length - b.candidates.length
        || (remaining[a.ingredient] ?? 0) - (remaining[b.ingredient] ?? 0)
        || a.ingredient.localeCompare(b.ingredient);
    });
    const branch = ranked[0];
    if (!branch || branch.candidates.length === 0) return null;
    for (const template of branch.candidates) {
      if (!fits(template, remaining)) continue;
      const solved = visit(subtract(remaining, template.rawSignature), [...chosen, template]);
      if (solved) return solved;
      if (exhausted) return null;
    }
    return null;
  };

  const solved = visit(start, []);
  return solved
    ? { exact: true, templates: solved, expandedStates: expanded, exhausted: false, remaining: {} }
    : { exact: false, templates: best.chosen, expandedStates: expanded, exhausted, remaining: best.remaining };
}
