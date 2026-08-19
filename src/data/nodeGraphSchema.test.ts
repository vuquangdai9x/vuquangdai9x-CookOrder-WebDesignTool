import { describe, expect, it } from "vitest";
import burgerJson from "./config/nodegraph/maps/Graph-1-Burger.json";
import type { NodeGraphMap, VertexKindName } from "./nodeGraphTypes.ts";
import {
  EDGE_KIND_NAMES,
  NODE_GRAPH_SCHEMA,
  VERTEX_KIND_NAMES,
  edgeAllowed,
  edgeFields,
  invariant,
  vertexFields,
  vertexKind,
} from "./nodeGraphSchema.ts";

const burger = burgerJson as unknown as NodeGraphMap;

describe("schema shape", () => {
  it("declares the five vertex kinds and five edge kinds the runtime expects", () => {
    expect(VERTEX_KIND_NAMES).toEqual(["ingredient", "tool", "group", "composite", "dirty"]);
    expect(EDGE_KIND_NAMES).toEqual(["process", "base", "topping", "option", "leavesDirty"]);
  });

  it("caps process edges at one per target — the invariant that makes a backward trace deterministic", () => {
    expect(NODE_GRAPH_SCHEMA.edgeKinds.find((e) => e.kind === "process")?.maxIncomingPerTarget).toBe(1);
  });

  it("allows only one base, topping and dirty edge out of a composite", () => {
    for (const kind of ["base", "topping", "leavesDirty"] as const) {
      expect(NODE_GRAPH_SCHEMA.edgeKinds.find((e) => e.kind === kind)?.maxOutgoingPerSource).toBe(1);
    }
  });

  it("exposes a positive per-dirty-node maxStack in the generated inspector", () => {
    const field = vertexFields("dirty").find((candidate) => candidate.name === "maxStack");
    expect(field).toMatchObject({ type: "int", min: 1 });
  });

  it("carries every invariant the plan relies on, each with a severity", () => {
    const required = [
      "INV-REF",
      "INV-UNIQUE-PRODUCER",
      "INV-ACYCLIC",
      "INV-NAMESPACE",
      "INV-TRACEABLE",
      "INV-DIRTY-STACK",
      "INV-IDTABLE-UNIQUE",
      "INV-IDTABLE-RESOLVES",
      "INV-NO-RETIRED-IN-USE",
      "INV-ORDER-REBUILDABLE",
      "INV-DISH-SINGLE-ORDERABLE",
      "WARN-UNTABLED-NODE",
      "WARN-MULTI-INPUT",
    ];
    for (const id of required) {
      const inv = invariant(id);
      expect(inv, `missing invariant ${id}`).toBeDefined();
      expect(["error", "warning"]).toContain(inv!.severity);
    }
  });

  it("has no duplicate invariant ids", () => {
    const ids = NODE_GRAPH_SCHEMA.invariants.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("wiring matrix", () => {
  it("permits the connections burger.json actually uses", () => {
    expect(edgeAllowed("process", "tool", "ingredient")).toBe(true);
    expect(edgeAllowed("base", "composite", "group")).toBe(true);
    expect(edgeAllowed("base", "composite", "ingredient")).toBe(true);
    expect(edgeAllowed("topping", "composite", "ingredient")).toBe(true);
    expect(edgeAllowed("option", "group", "ingredient")).toBe(true);
    expect(edgeAllowed("leavesDirty", "composite", "dirty")).toBe(true);
  });

  it("rejects reversed and nonsensical connections", () => {
    expect(edgeAllowed("process", "ingredient", "tool")).toBe(false);
    expect(edgeAllowed("option", "composite", "ingredient")).toBe(false);
    expect(edgeAllowed("leavesDirty", "ingredient", "dirty")).toBe(false);
  });
});

/**
 * The drift guard. The editor builds its inspector from the schema's fields[],
 * while map data is typed by the interfaces in nodeGraphTypes.ts. If a field is
 * added to one and not the other, the inspector silently edits a property no
 * type knows about (or vice versa). Rather than reflect over TypeScript types —
 * which vanish at runtime — assert against burger.json, the document both sides
 * have to agree on.
 */
describe("schema <-> data drift", () => {
  /** Vertices as loose records, so the drift checks can enumerate keys generically. */
  const rows = (kind: VertexKindName): Record<string, unknown>[] =>
    burger.vertices[kind] as unknown as Record<string, unknown>[];

  it("every required field of every vertex kind is present on every vertex in burger.json", () => {
    for (const kind of VERTEX_KIND_NAMES) {
      const required = vertexFields(kind).filter((f) => f.required);
      for (const vertex of rows(kind)) {
        for (const field of required) {
          expect(
            vertex[field.name],
            `${kind} "${vertex.name}" is missing required field "${field.name}"`,
          ).not.toBeUndefined();
        }
      }
    }
  });

  it("every property used in burger.json's vertices is declared in the schema", () => {
    for (const kind of VERTEX_KIND_NAMES) {
      const declared = new Set(vertexFields(kind).map((f) => f.name));
      for (const vertex of rows(kind)) {
        for (const key of Object.keys(vertex)) {
          expect(declared.has(key), `${kind} "${vertex.name}" uses undeclared field "${key}"`).toBe(true);
        }
      }
    }
  });

  it("every property used in burger.json's edges is declared in the schema", () => {
    for (const kind of EDGE_KIND_NAMES) {
      const declared = new Set(["from", "to", ...edgeFields(kind).map((f) => f.name)]);
      for (const edge of burger.edges[kind] as unknown as Record<string, unknown>[]) {
        for (const key of Object.keys(edge)) {
          expect(declared.has(key), `${kind} edge uses undeclared field "${key}"`).toBe(true);
        }
      }
    }
  });

  it("unique-flagged fields really are unique within their kind", () => {
    for (const kind of VERTEX_KIND_NAMES) {
      for (const field of vertexFields(kind).filter((f) => f.unique)) {
        const values = rows(kind).map((v) => v[field.name]);
        expect(new Set(values).size, `${kind}.${field.name} has duplicates`).toBe(values.length);
      }
    }
  });

  it("vertex names are unique across ALL kinds — base/topping/option resolve in one namespace", () => {
    const seen = new Map<string, VertexKindName>();
    for (const kind of VERTEX_KIND_NAMES) {
      for (const vertex of burger.vertices[kind]) {
        expect(seen.has(vertex.name), `"${vertex.name}" is both a ${seen.get(vertex.name)} and a ${kind}`).toBe(false);
        seen.set(vertex.name, kind);
      }
    }
  });

  it("declares a widget for every field type any kind actually uses", () => {
    const known = new Set(NODE_GRAPH_SCHEMA.fieldTypes.map((t) => t.type));
    const used = [
      ...NODE_GRAPH_SCHEMA.mapFields,
      ...VERTEX_KIND_NAMES.flatMap(vertexFields),
      ...EDGE_KIND_NAMES.flatMap(edgeFields),
    ];
    for (const field of used) {
      expect(known.has(field.type), `field "${field.name}" uses undeclared type "${field.type}"`).toBe(true);
    }
  });

  it("exposes kind metadata the canvas renders with", () => {
    for (const kind of VERTEX_KIND_NAMES) {
      const def = vertexKind(kind)!;
      expect(def.label).toBeTruthy();
      expect(def.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
