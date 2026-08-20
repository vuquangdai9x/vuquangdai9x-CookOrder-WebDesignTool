// Layered layout for the node editor.
//
// A cooking graph is a dependency graph, so the only layout that reads well is
// left-to-right by DEPTH: pickups on the left, then the tool that processes
// them, then what that tool produces, then the groups and composites that
// assemble it, then what the customer leaves behind. Anything force-directed
// would scramble exactly the ordering a designer is trying to see.
//
// Pure and DOM-free so it can be tested; the view only consumes the positions.

import type { NodeGraphMap, VertexKindName } from "../../data/nodeGraphTypes.ts";

export interface LayoutPoint {
  x: number;
  y: number;
}

/** Keyed "kind:name", matching NodeGraphMap.layout. */
export type Layout = Record<string, LayoutPoint>;

export const layoutKey = (kind: VertexKindName, name: string) => `${kind}:${name}`;

export interface LayoutOptions {
  columnWidth?: number;
  rowHeight?: number;
  originX?: number;
  originY?: number;
}

/**
 * Depth of every vertex, as the longest path from a source. Longest — not
 * shortest — so a vertex always sits to the RIGHT of everything it depends on,
 * which is the property that makes the picture readable.
 *
 * Total on cyclic data: a vertex already being visited contributes depth 0
 * rather than recursing. INV-ACYCLIC reports the cycle separately; the editor
 * still has to draw something.
 */
export function computeDepths(doc: NodeGraphMap): Map<string, number> {
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const producerOf = new Map<string, { tool: string; inputs: string[] }>();
  for (const edge of doc.edges.process) {
    if (!producerOf.has(edge.to)) {
      producerOf.set(edge.to, { tool: edge.from, inputs: edge.inputs.map((i) => i.ingredient) });
    }
  }
  const optionsOf = new Map<string, string[]>();
  for (const edge of doc.edges.option) {
    optionsOf.set(edge.from, [...(optionsOf.get(edge.from) ?? []), edge.to]);
  }
  const membersOf = new Map<string, string[]>();
  for (const edge of [...doc.edges.base, ...doc.edges.topping]) {
    membersOf.set(edge.from, [...(membersOf.get(edge.from) ?? []), edge.to]);
  }
  const dirtySource = new Map<string, string>();
  for (const edge of doc.edges.leavesDirty) dirtySource.set(edge.to, edge.from);

  const kindOf = new Map<string, VertexKindName>();
  for (const kind of ["ingredient", "tool", "group", "composite", "dirty"] as VertexKindName[]) {
    for (const v of doc.vertices[kind]) kindOf.set(v.name, kind);
  }

  const of = (name: string): number => {
    const known = depth.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) return 0; // cycle — see the header note
    visiting.add(name);

    let value = 0;
    const kind = kindOf.get(name);
    if (kind === "ingredient") {
      const step = producerOf.get(name);
      // A produced ingredient sits one past its tool; a pickup is a source.
      if (step) value = 1 + of(step.tool);
    } else if (kind === "tool") {
      // A tool sits one past the latest of everything it consumes. Tools with
      // several recipes land after their deepest input, which is what keeps a
      // fryer to the right of the flour step that feeds it.
      for (const edge of doc.edges.process) {
        if (edge.from !== name) continue;
        for (const input of edge.inputs) value = Math.max(value, 1 + of(input.ingredient));
      }
      for (const edge of doc.edges.preservation) {
        if (edge.from === name) value = Math.max(value, 1 + of(edge.to));
      }
    } else if (kind === "group") {
      for (const option of optionsOf.get(name) ?? []) value = Math.max(value, 1 + of(option));
    } else if (kind === "composite") {
      for (const member of membersOf.get(name) ?? []) value = Math.max(value, 1 + of(member));
    } else if (kind === "dirty") {
      const source = dirtySource.get(name);
      value = source ? 1 + of(source) : 0;
    }

    visiting.delete(name);
    depth.set(name, value);
    return value;
  };

  for (const name of kindOf.keys()) of(name);
  return depth;
}

/**
 * Positions for every vertex. Within a column, vertices are ordered by kind
 * then name so the result is STABLE: running auto-layout twice on an unchanged
 * graph produces an identical diff, which matters because layout is persisted
 * in the document.
 */
export function autoLayout(doc: NodeGraphMap, options: LayoutOptions = {}): Layout {
  const columnWidth = options.columnWidth ?? 240;
  const rowHeight = options.rowHeight ?? 86;
  const originX = options.originX ?? 60;
  const originY = options.originY ?? 40;

  const depths = computeDepths(doc);
  const kinds: VertexKindName[] = ["ingredient", "tool", "group", "composite", "dirty"];

  const byColumn = new Map<number, { kind: VertexKindName; name: string }[]>();
  for (const kind of kinds) {
    for (const vertex of doc.vertices[kind]) {
      const column = depths.get(vertex.name) ?? 0;
      byColumn.set(column, [...(byColumn.get(column) ?? []), { kind, name: vertex.name }]);
    }
  }

  const layout: Layout = {};
  for (const [column, entries] of byColumn) {
    entries.sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.name.localeCompare(b.name));
    entries.forEach((entry, row) => {
      layout[layoutKey(entry.kind, entry.name)] = {
        x: originX + column * columnWidth,
        y: originY + row * rowHeight,
      };
    });
  }
  return layout;
}
