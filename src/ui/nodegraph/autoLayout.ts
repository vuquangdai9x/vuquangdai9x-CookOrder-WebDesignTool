// Deterministic layered layout for the node editor.
//
// The graph is semantic flow, not a generic network: ingredients feed tools,
// tools produce states, states merge into groups/composites, and orderables
// leave dirty objects. The layout therefore keeps dependency depth on X and
// spends its effort on Y: keep each orderable family in a lane, minimise wire
// crossings, align connected cards, and leave enough room for tall tool rows.
//
// Pure and DOM-free so it can be tested; the view supplies exact card heights.

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
  /** Minimum top-to-top distance. Tall cards still use their full height. */
  rowHeight?: number;
  /** Empty space between adjacent card boxes. */
  nodeGap?: number;
  /** Additional whitespace when adjacent nodes belong to different menu families. */
  familyGap?: number;
  originX?: number;
  originY?: number;
  /** Exact rendered card height; the editor supplies this from its row model. */
  nodeHeight?: (kind: VertexKindName, name: string) => number;
  /** Alternating ordering/alignment passes. */
  sweeps?: number;
}

interface FlowEdge {
  from: string;
  to: string;
}

interface LayoutNode {
  key: string;
  kind: VertexKindName;
  name: string;
  column: number;
  height: number;
  /** Fine order: variants within one requested-food family remain close. */
  lane: number;
  /** Coarse order: inserts the larger whitespace between food families. */
  family: number;
}

const KINDS: VertexKindName[] = ["ingredient", "tool", "group", "composite", "dirty"];
const KIND_ORDER = new Map(KINDS.map((kind, index) => [kind, index]));

/**
 * Visible flow edges, in the direction the editor draws them.
 * Stored assembly edges point from a composite/group to its member, but the
 * member is what FEEDS the assembly, so their visual direction is reversed.
 */
function flowEdges(doc: NodeGraphMap, known: Set<string>): FlowEdge[] {
  const result: FlowEdge[] = [];
  const add = (from: string, to: string) => {
    if (known.has(from) && known.has(to)) result.push({ from, to });
  };

  for (const edge of doc.edges.process) {
    for (const input of edge.inputs) add(input.ingredient, edge.from);
    add(edge.from, edge.to);
  }
  for (const edge of doc.edges.preservation) add(edge.to, edge.from);
  for (const edge of [...doc.edges.base, ...doc.edges.topping]) add(edge.to, edge.from);
  for (const edge of doc.edges.option) add(edge.to, edge.from);
  for (const edge of doc.edges.leavesDirty) add(edge.from, edge.to);
  return result;
}

/**
 * Column of every vertex, based on longest path from a source plus the editor's
 * semantic presentation constraints. Longest — not shortest — guarantees
 * every valid wire points right, even when a tool has both a raw input and a
 * deeper prepared input.
 *
 * Pickupables exclusively own column 0. Every other vertex starts at column 1
 * or later, so dead/source-like intermediate ingredients can never appear to
 * the left of the queue items. All orderable composites share the deepest
 * orderable column; dirty results remain one column to their right.
 *
 * Total on cyclic data: a vertex already being visited contributes depth 0.
 * INV-ACYCLIC reports the cycle separately; the editor still has to draw it.
 */
export function computeDepths(doc: NodeGraphMap): Map<string, number> {
  const known = new Set<string>();
  for (const kind of KINDS) for (const vertex of doc.vertices[kind]) known.add(vertex.name);
  const incoming = adjacency(flowEdges(doc, known), "incoming");
  const pickupables = new Set(doc.vertices.ingredient.filter((node) => node.pickupable).map((node) => node.name));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const of = (name: string): number => {
    const cached = depth.get(name);
    if (cached !== undefined) return cached;
    if (visiting.has(name)) return 0;
    visiting.add(name);
    // Pickupables are the visual queue/table at the extreme left. Even a
    // malformed produced-pickup edge must not drag one out of that column;
    // validation reports the semantic problem separately.
    if (pickupables.has(name)) {
      visiting.delete(name);
      depth.set(name, 0);
      return 0;
    }
    let value = pickupables.size > 0 ? 1 : 0;
    for (const predecessor of incoming.get(name) ?? []) value = Math.max(value, 1 + of(predecessor));
    visiting.delete(name);
    depth.set(name, value);
    return value;
  };

  for (const name of known) of(name);

  const orderables = doc.vertices.composite.filter((node) => node.orderable).map((node) => node.name);
  const orderableColumn = Math.max(0, ...orderables.map((name) => depth.get(name) ?? 0));
  for (const name of orderables) depth.set(name, orderableColumn);
  for (const edge of doc.edges.leavesDirty) {
    if (orderables.includes(edge.from)) depth.set(edge.to, Math.max(depth.get(edge.to) ?? 0, orderableColumn + 1));
  }
  return depth;
}

/**
 * Positions every vertex once. Ordering is inferred from the orderables each
 * node eventually feeds; `_foodOrderableMap`, when present, keeps variants of
 * one requested food in the same coarse lane. Alternating barycentric sweeps
 * and deterministic adjacent swaps then reduce crossings without sacrificing
 * that family order.
 */
export function autoLayout(doc: NodeGraphMap, options: LayoutOptions = {}): Layout {
  const columnWidth = options.columnWidth ?? 300;
  const rowHeight = options.rowHeight ?? 96;
  const nodeGap = options.nodeGap ?? 28;
  const familyGap = options.familyGap ?? 180;
  const originX = options.originX ?? 60;
  const originY = options.originY ?? 40;
  const sweeps = Math.max(1, Math.floor(options.sweeps ?? 6));
  const heightOf = options.nodeHeight ?? (() => 64);

  const kindOf = new Map<string, VertexKindName>();
  for (const kind of KINDS) for (const vertex of doc.vertices[kind]) kindOf.set(vertex.name, kind);
  const known = new Set(kindOf.keys());
  const edges = flowEdges(doc, known);
  const incoming = adjacency(edges, "incoming");
  const outgoing = adjacency(edges, "outgoing");
  const depths = computeDepths(doc);
  const lanes = inferLanes(doc, outgoing, incoming);

  const columns = new Map<number, LayoutNode[]>();
  for (const kind of KINDS) {
    for (const vertex of doc.vertices[kind]) {
      const lane = lanes.get(vertex.name) ?? { lane: Number.POSITIVE_INFINITY, family: Number.POSITIVE_INFINITY };
      const node: LayoutNode = {
        key: layoutKey(kind, vertex.name),
        kind,
        name: vertex.name,
        column: depths.get(vertex.name) ?? 0,
        height: Math.max(1, heightOf(kind, vertex.name)),
        lane: lane.lane,
        family: lane.family,
      };
      columns.set(node.column, [...(columns.get(node.column) ?? []), node]);
    }
  }

  for (const entries of columns.values()) entries.sort(semanticCompare);
  minimiseCrossings(columns, edges, sweeps);

  const centers = initialCenters(columns, originY, rowHeight, nodeGap, familyGap);
  alignConnectedColumns(columns, incoming, outgoing, centers, originY, rowHeight, nodeGap, familyGap, sweeps);

  const layout: Layout = {};
  for (const [column, entries] of columns) {
    for (const node of entries) {
      layout[node.key] = {
        x: originX + column * columnWidth,
        y: round2((centers.get(node.key) ?? originY + node.height / 2) - node.height / 2),
      };
    }
  }
  return layout;
}

/** Straight-segment estimate used by tests and layout diagnostics. */
export function countLayoutCrossings(doc: NodeGraphMap, layout: Layout): number {
  const keyOf = new Map<string, string>();
  for (const kind of KINDS) for (const vertex of doc.vertices[kind]) keyOf.set(vertex.name, layoutKey(kind, vertex.name));
  const edges = flowEdges(doc, new Set(keyOf.keys()))
    .map((edge) => ({ from: keyOf.get(edge.from)!, to: keyOf.get(edge.to)! }))
    .filter((edge) => layout[edge.from] && layout[edge.to]);
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i];
      const b = edges[j];
      if (sharesEndpoint(a, b)) continue;
      if (segmentsCross(layout[a.from], layout[a.to], layout[b.from], layout[b.to])) crossings++;
    }
  }
  return crossings;
}

function adjacency(edges: FlowEdge[], direction: "incoming" | "outgoing"): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const edge of edges) {
    const key = direction === "incoming" ? edge.to : edge.from;
    const value = direction === "incoming" ? edge.from : edge.to;
    result.set(key, [...(result.get(key) ?? []), value]);
  }
  return result;
}

/**
 * Which orderable-family lane a node belongs to. Nodes shared by several
 * families receive their average lane, placing shared tools between consumers.
 */
function inferLanes(
  doc: NodeGraphMap,
  outgoing: Map<string, string[]>,
  incoming: Map<string, string[]>,
): Map<string, { lane: number; family: number }> {
  const orderables = doc.vertices.composite.filter((node) => node.orderable).map((node) => node.name);
  const roots = orderableRanks(doc, orderables);
  const orderableSet = new Set(orderables);
  const memo = new Map<string, Set<string>>();

  const reachableRoots = (name: string, visiting = new Set<string>()): Set<string> => {
    if (orderableSet.has(name)) return new Set([name]);
    const cached = memo.get(name);
    if (cached) return cached;
    if (visiting.has(name)) return new Set();
    const next = new Set(visiting).add(name);
    const found = new Set<string>();
    for (const consumer of outgoing.get(name) ?? []) {
      for (const root of reachableRoots(consumer, next)) found.add(root);
    }
    memo.set(name, found);
    return found;
  };

  const result = new Map<string, { lane: number; family: number }>();
  const allNames = KINDS.flatMap((kind) => doc.vertices[kind].map((node) => node.name));
  const fallbackFamily = Math.max(-1, ...[...roots.values()].map((rank) => rank.family)) + 1;
  let orphan = 0;
  for (const name of allNames) {
    let reached = [...reachableRoots(name)];
    // Dirty objects sit after an orderable, so their family is found upstream.
    if (reached.length === 0) reached = (incoming.get(name) ?? []).filter((source) => orderableSet.has(source));
    const ranks = reached.map((root) => roots.get(root)).filter((rank): rank is { lane: number; family: number } => !!rank);
    if (ranks.length === 0) {
      result.set(name, { lane: fallbackFamily + orphan / 1000, family: fallbackFamily });
      orphan++;
    } else {
      result.set(name, {
        lane: mean(ranks.map((rank) => rank.lane)),
        family: mean(ranks.map((rank) => rank.family)),
      });
    }
  }
  return result;
}

function orderableRanks(doc: NodeGraphMap, orderables: string[]): Map<string, { lane: number; family: number }> {
  const result = new Map<string, { lane: number; family: number }>();
  const metadata = (doc as unknown as Record<string, unknown>)._foodOrderableMap;
  let family = 0;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    for (const value of Object.values(metadata as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const variants = value.filter((name): name is string => typeof name === "string" && orderables.includes(name));
      variants.forEach((name, index) => {
        if (!result.has(name)) result.set(name, { family, lane: family + index / Math.max(2, variants.length + 1) });
      });
      if (variants.length > 0) family++;
    }
  }
  for (const name of orderables) {
    if (!result.has(name)) {
      result.set(name, { lane: family, family });
      family++;
    }
  }
  return result;
}

function semanticCompare(a: LayoutNode, b: LayoutNode): number {
  return finiteCompare(a.lane, b.lane) ||
    (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0) ||
    a.name.localeCompare(b.name);
}

function finiteCompare(a: number, b: number): number {
  if (a === b) return 0;
  if (!Number.isFinite(a)) return 1;
  if (!Number.isFinite(b)) return -1;
  return a - b;
}

function minimiseCrossings(columns: Map<number, LayoutNode[]>, edges: FlowEdge[], sweeps: number): void {
  const orderedColumns = [...columns.keys()].sort((a, b) => a - b);
  const incoming = adjacency(edges, "incoming");
  const outgoing = adjacency(edges, "outgoing");

  for (let pass = 0; pass < sweeps; pass++) {
    barycentricSweep(columns, orderedColumns, incoming);
    barycentricSweep(columns, [...orderedColumns].reverse(), outgoing);
  }

  // Barycentric sorting is fast and gets close. Adjacent swaps optimise the
  // actual whole-graph crossing count and make the remaining decision exact.
  for (let pass = 0; pass < Math.max(2, Math.ceil(sweeps / 2)); pass++) {
    let changed = false;
    for (const column of orderedColumns) {
      const entries = columns.get(column)!;
      for (let i = 0; i + 1 < entries.length; i++) {
        // Families are coarse lanes, not merely a starting hint. Optimise
        // freely inside one lane, but never interleave two menu families.
        if (familyBucket(entries[i].family) !== familyBucket(entries[i + 1].family)) continue;
        const before = orderObjective(columns, edges);
        [entries[i], entries[i + 1]] = [entries[i + 1], entries[i]];
        const after = orderObjective(columns, edges);
        if (after.crossings < before.crossings || (after.crossings === before.crossings && after.span < before.span)) {
          changed = true;
        } else {
          [entries[i], entries[i + 1]] = [entries[i + 1], entries[i]];
        }
      }
    }
    if (!changed) break;
  }
}

function barycentricSweep(
  columns: Map<number, LayoutNode[]>,
  columnOrder: number[],
  neighbors: Map<string, string[]>,
): void {
  const positions = normalizedPositions(columns);
  const finiteLanes = [...columns.values()].flat().filter((node) => Number.isFinite(node.lane)).map((node) => node.lane);
  const maxLane = Math.max(1, ...finiteLanes);
  for (const column of columnOrder) {
    const entries = columns.get(column)!;
    const prior = new Map(entries.map((node, index) => [node.key, index]));
    const score = (node: LayoutNode): number => {
      const values = (neighbors.get(node.name) ?? [])
        .map((name) => positions.get(name))
        .filter((value): value is number => value !== undefined);
      const lane = Number.isFinite(node.lane) ? node.lane / maxLane : 1;
      return values.length ? mean(values) * 0.82 + lane * 0.18 : lane;
    };
    entries.sort((a, b) =>
      familyBucket(a.family) - familyBucket(b.family) ||
      score(a) - score(b) ||
      (prior.get(a.key) ?? 0) - (prior.get(b.key) ?? 0) ||
      semanticCompare(a, b),
    );
    // Later columns in this sweep should see the order just established.
    const denominator = Math.max(1, entries.length - 1);
    entries.forEach((node, index) => positions.set(node.name, index / denominator));
  }
}

function normalizedPositions(columns: Map<number, LayoutNode[]>): Map<string, number> {
  const result = new Map<string, number>();
  for (const entries of columns.values()) {
    const denominator = Math.max(1, entries.length - 1);
    entries.forEach((node, index) => result.set(node.name, index / denominator));
  }
  return result;
}

function orderObjective(columns: Map<number, LayoutNode[]>, edges: FlowEdge[]): { crossings: number; span: number } {
  const point = new Map<string, LayoutPoint>();
  for (const [column, entries] of columns) {
    const denominator = Math.max(1, entries.length - 1);
    entries.forEach((node, index) => point.set(node.name, { x: column, y: index / denominator }));
  }
  let crossings = 0;
  let span = 0;
  for (const edge of edges) {
    const from = point.get(edge.from);
    const to = point.get(edge.to);
    if (from && to) span += Math.abs(to.y - from.y);
  }
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i];
      const b = edges[j];
      if (sharesEndpoint(a, b)) continue;
      const a1 = point.get(a.from);
      const a2 = point.get(a.to);
      const b1 = point.get(b.from);
      const b2 = point.get(b.to);
      if (a1 && a2 && b1 && b2 && segmentsCross(a1, a2, b1, b2)) crossings++;
    }
  }
  return { crossings, span };
}

function initialCenters(
  columns: Map<number, LayoutNode[]>,
  originY: number,
  rowHeight: number,
  nodeGap: number,
  familyGap: number,
): Map<string, number> {
  const centers = new Map<string, number>();
  for (const entries of columns.values()) {
    let top = originY;
    entries.forEach((node, index) => {
      if (index > 0) {
        const previous = entries[index - 1];
        top = Math.max(
          top,
          (centers.get(previous.key) ?? originY) +
            previous.height / 2 +
            separation(previous, node, rowHeight, nodeGap, familyGap),
        );
      }
      centers.set(node.key, top + node.height / 2);
    });
  }
  return centers;
}

function alignConnectedColumns(
  columns: Map<number, LayoutNode[]>,
  incoming: Map<string, string[]>,
  outgoing: Map<string, string[]>,
  centers: Map<string, number>,
  originY: number,
  rowHeight: number,
  nodeGap: number,
  familyGap: number,
  sweeps: number,
): void {
  const keyOf = new Map<string, string>();
  const nodeOf = new Map<string, LayoutNode>();
  for (const entries of columns.values()) {
    for (const node of entries) {
      keyOf.set(node.name, node.key);
      nodeOf.set(node.name, node);
    }
  }
  const ordered = [...columns.keys()].sort((a, b) => a - b);
  const anchors = new Map(centers);

  const sweep = (columnOrder: number[], neighbors: Map<string, string[]>) => {
    for (const column of columnOrder) {
      const entries = columns.get(column)!;
      const desired = entries.map((node) => {
        // Groups should sit at the middle of their option items. Tools should
        // sit at the middle of all ingredient states they consume/produce.
        // For ordinary nodes, retain the directional sweep behavior.
        const connectedNames = node.kind === "group"
          ? (incoming.get(node.name) ?? [])
          : node.kind === "tool"
            ? [...new Set([...(incoming.get(node.name) ?? []), ...(outgoing.get(node.name) ?? [])])]
            : (neighbors.get(node.name) ?? []);
        const connectedCenter = clusterCenter(connectedNames, keyOf, nodeOf, centers);
        const anchor = anchors.get(node.key) ?? originY + node.height / 2;
        if (connectedCenter === undefined) return anchor;
        return node.kind === "group" || node.kind === "tool"
          ? connectedCenter
          : connectedCenter * 0.65 + anchor * 0.35;
      });
      const packed = packCenters(entries, desired, originY, rowHeight, nodeGap, familyGap);
      entries.forEach((node, index) => centers.set(node.key, packed[index]));
    }
  };

  for (let pass = 0; pass < sweeps; pass++) {
    sweep(ordered, incoming);
    sweep([...ordered].reverse(), outgoing);
  }

  // The last directional sweep may subsequently move an ingredient column
  // that an earlier tool/group already followed. Finish with one hub-only
  // pass after ordinary nodes have settled. Packing still protects cards in a
  // shared hub column from overlap, so centering remains a best fit there.
  for (const column of ordered) {
    const entries = columns.get(column)!;
    const desired = entries.map((node) => {
      if (node.kind !== "group" && node.kind !== "tool") return centers.get(node.key) ?? originY + node.height / 2;
      const connectedNames = node.kind === "group"
        ? (incoming.get(node.name) ?? [])
        : [...new Set([...(incoming.get(node.name) ?? []), ...(outgoing.get(node.name) ?? [])])];
      return clusterCenter(connectedNames, keyOf, nodeOf, centers) ?? centers.get(node.key) ?? originY + node.height / 2;
    });
    const packed = packCenters(entries, desired, originY, rowHeight, nodeGap, familyGap);
    entries.forEach((node, index) => centers.set(node.key, packed[index]));
  }

  // Alignment is relative: dense downstream columns may pull every graph node
  // downward together. Remove that meaningless global drift so the first card
  // still begins at the requested origin.
  const nodes = [...columns.values()].flat();
  const minTop = Math.min(...nodes.map((node) => (centers.get(node.key) ?? originY) - node.height / 2));
  const shift = originY - minTop;
  for (const node of nodes) centers.set(node.key, (centers.get(node.key) ?? originY) + shift);
}

/** Center of the complete rendered span, not merely the mean of item centers. */
function clusterCenter(
  names: string[],
  keyOf: Map<string, string>,
  nodeOf: Map<string, LayoutNode>,
  centers: Map<string, number>,
): number | undefined {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const name of names) {
    const key = keyOf.get(name);
    const node = nodeOf.get(name);
    const center = key ? centers.get(key) : undefined;
    if (!node || center === undefined) continue;
    top = Math.min(top, center - node.height / 2);
    bottom = Math.max(bottom, center + node.height / 2);
  }
  return Number.isFinite(top) && Number.isFinite(bottom) ? (top + bottom) / 2 : undefined;
}

function packCenters(
  entries: LayoutNode[],
  desired: number[],
  originY: number,
  rowHeight: number,
  nodeGap: number,
  familyGap: number,
): number[] {
  if (entries.length === 0) return [];
  const centers = [...desired];
  for (let i = 1; i < entries.length; i++) {
    centers[i] = Math.max(centers[i], centers[i - 1] + separation(entries[i - 1], entries[i], rowHeight, nodeGap, familyGap));
  }
  for (let i = entries.length - 2; i >= 0; i--) {
    centers[i] = Math.min(centers[i], centers[i + 1] - separation(entries[i], entries[i + 1], rowHeight, nodeGap, familyGap));
  }
  const firstTop = centers[0] - entries[0].height / 2;
  if (firstTop < originY) {
    const shift = originY - firstTop;
    for (let i = 0; i < centers.length; i++) centers[i] += shift;
  }
  for (let i = 1; i < entries.length; i++) {
    centers[i] = Math.max(centers[i], centers[i - 1] + separation(entries[i - 1], entries[i], rowHeight, nodeGap, familyGap));
  }
  return centers;
}

function separation(a: LayoutNode, b: LayoutNode, rowHeight: number, nodeGap: number, familyGap: number): number {
  const boxes = (a.height + b.height) / 2 + nodeGap;
  const differentFamily = familyBucket(a.family) !== familyBucket(b.family);
  return Math.max(rowHeight, boxes) + (differentFamily ? familyGap : 0);
}

function familyBucket(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : Number.MAX_SAFE_INTEGER;
}

function sharesEndpoint(a: FlowEdge, b: FlowEdge): boolean {
  return a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to;
}

function segmentsCross(a: LayoutPoint, b: LayoutPoint, c: LayoutPoint, d: LayoutPoint): boolean {
  const direction = (p: LayoutPoint, q: LayoutPoint, r: LayoutPoint) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = direction(a, b, c);
  const abD = direction(a, b, d);
  const cdA = direction(c, d, a);
  const cdB = direction(c, d, b);
  return abC * abD < 0 && cdA * cdB < 0;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
