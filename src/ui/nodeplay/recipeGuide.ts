import type { GraphIndex } from "../../core/nodeIndex.ts";

export interface RecipeGuideRow {
  input: number;
  output: number;
}

/** Pickupable ingredient -> every distinct serveable result reachable from it. */
export function recipeGuideRows(ix: GraphIndex): RecipeGuideRow[] {
  const rows: RecipeGuideRow[] = [];
  for (let input = 0; input < ix.ingName.length; input++) {
    if (!ix.pickupable[input]) continue;
    const visited = new Set<number>([input]);
    const outputs = new Set<number>();
    const visit = (ingredient: number): void => {
      for (const step of ix.stepsForInput[ingredient] ?? []) {
        if (visited.has(step.out)) continue;
        visited.add(step.out);
        if (ix.servable[step.out]) outputs.add(step.out);
        visit(step.out);
      }
    };
    visit(input);
    for (const output of [...outputs].sort((a, b) => a - b)) rows.push({ input, output });
  }
  return rows;
}
