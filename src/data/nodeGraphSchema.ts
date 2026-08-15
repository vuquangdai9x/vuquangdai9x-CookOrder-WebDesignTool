// Typed access to config/nodegraph/schema.json.
//
// The schema is the editor's source of truth: the creatable-vertex palette,
// the inspector's fields, the legal wiring matrix and the invariant list are
// all read from it at runtime rather than hardcoded. This module is the only
// place that casts the raw JSON into the interfaces in nodeGraphTypes.ts, plus
// the small lookups every consumer would otherwise re-derive.
//
// Kept separate from nodeGraphTypes.ts (a pure types leaf) because this one
// imports the JSON, and types must stay importable by modules that must not
// pull in config.

import schemaJson from "./config/nodegraph/schema.json";
import type {
  EdgeKindDef,
  EdgeKindName,
  FieldDef,
  InvariantDef,
  NodeGraphSchema,
  VertexKindDef,
  VertexKindName,
} from "./nodeGraphTypes.ts";

export const NODE_GRAPH_SCHEMA = schemaJson as unknown as NodeGraphSchema;

const vertexByKind = new Map<VertexKindName, VertexKindDef>(
  NODE_GRAPH_SCHEMA.vertexKinds.map((k) => [k.kind, k]),
);
const edgeByKind = new Map<EdgeKindName, EdgeKindDef>(
  NODE_GRAPH_SCHEMA.edgeKinds.map((k) => [k.kind, k]),
);
const invariantById = new Map<string, InvariantDef>(
  NODE_GRAPH_SCHEMA.invariants.map((i) => [i.id, i]),
);

export function vertexKind(kind: VertexKindName): VertexKindDef | undefined {
  return vertexByKind.get(kind);
}

export function edgeKind(kind: EdgeKindName): EdgeKindDef | undefined {
  return edgeByKind.get(kind);
}

export function invariant(id: string): InvariantDef | undefined {
  return invariantById.get(id);
}

export const VERTEX_KIND_NAMES: VertexKindName[] = NODE_GRAPH_SCHEMA.vertexKinds.map((k) => k.kind);
export const EDGE_KIND_NAMES: EdgeKindName[] = NODE_GRAPH_SCHEMA.edgeKinds.map((k) => k.kind);

/** Field definitions for a vertex kind — what the inspector renders and what CSV columns are emitted. */
export function vertexFields(kind: VertexKindName): FieldDef[] {
  return vertexByKind.get(kind)?.fields ?? [];
}

/** Field definitions carried by an edge kind (process's inputs/amount/duration/chainTools, option's maxQuantity). */
export function edgeFields(kind: EdgeKindName): FieldDef[] {
  return edgeByKind.get(kind)?.fields ?? [];
}

/**
 * May an edge of this kind run from `from` to `to`? The wiring guard the
 * canvas applies on drag-release, read straight off the schema so adding a
 * legal connection is a data edit.
 */
export function edgeAllowed(kind: EdgeKindName, from: VertexKindName, to: VertexKindName): boolean {
  const def = edgeByKind.get(kind);
  if (!def) return false;
  return def.from.includes(from) && def.to.includes(to);
}

/** The declared default for a field, or undefined when it has none. */
export function fieldDefault(field: FieldDef): string | number | boolean | undefined {
  return field.default;
}
