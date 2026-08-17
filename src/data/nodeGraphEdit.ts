// Pure graph edits — document in, document out, no DOM.
//
// The editor view is the only caller today, but these are the operations whose
// CORRECTNESS matters independently of any pointer gesture, so they live where
// a test can reach them. A permutation bug here does not look like a bug: the
// graph still validates, the picture still renders, and only the order a tool
// dispatches its recipes in has quietly changed.

import type { NodeGraphMap } from "./nodeGraphTypes.ts";

/**
 * Move one of a tool's process edges, addressed by its position AMONG THAT
 * TOOL'S edges rather than by its index in the flat array.
 *
 * `edges.process` is one array shared by every tool, so a tool's recipes are
 * scattered through it. Splicing in the flat array would drag unrelated tools'
 * recipes past one another; this permutes only the slots the named tool already
 * occupies, leaving every other entry at exactly the index it had.
 *
 * Order is not cosmetic — `advanceTools` walks a tool's processes in this
 * order, so it decides which recipe claims a free slot first.
 *
 * Returns a new document; the input is never mutated. Out-of-range positions
 * return the document unchanged rather than throwing: the caller is a drag
 * gesture, and a drag that ends somewhere unexpected should do nothing.
 */
export function reorderToolProcesses(
  doc: NodeGraphMap,
  tool: string,
  from: number,
  to: number,
): NodeGraphMap {
  const slots: number[] = [];
  doc.edges.process.forEach((edge, index) => {
    if (edge.from === tool) slots.push(index);
  });
  if (from === to || from < 0 || to < 0 || from >= slots.length || to >= slots.length) return doc;

  const next = structuredClone(doc);
  const mine = slots.map((index) => next.edges.process[index]);
  const [moved] = mine.splice(from, 1);
  mine.splice(to, 0, moved);
  slots.forEach((index, at) => {
    next.edges.process[index] = mine[at];
  });
  return next;
}
