// Invariant checks for a recipe-graph document.
//
// Sibling to data/validate.ts, not an extension of it: that one checks LEVEL
// data and returns a flat {levelName, message}, while this one checks GRAPH
// data and needs a severity plus a vertex/edge to highlight on the canvas.
//
// The rule list itself lives in config/nodegraph/schema.json — this module
// implements the checks and reads the id/severity/description from there, so
// the editor's issue list and the validator can't disagree about what a rule
// is called or how bad it is.
//
// Pure: no DOM. Every check must be total on malformed input — it runs after
// every mutation while a designer is mid-edit, so a half-wired graph has to
// produce issues, never an exception.

import { invariant } from "./nodeGraphSchema.ts";
import { buildLookup, slotIndex, slotsOf, traceOrderable } from "./nodeGraphResolve.ts";
import type { GraphLookup } from "./nodeGraphResolve.ts";
import { ID_SPACES, buildIdIndex, validateIdTable } from "./nodeIdTable.ts";
import type { IdSpace, NodeGraphMap, VertexKindName } from "./nodeGraphTypes.ts";

export interface GraphIssue {
  invariantId: string;
  severity: "error" | "warning";
  message: string;
  vertexKind?: VertexKindName;
  vertexName?: string;
  edge?: { kind: string; from: string; to: string };
}

export interface GraphValidation {
  errors: GraphIssue[];
  warnings: GraphIssue[];
}

/** Which vertex kind an id space must point at. */
const SPACE_KIND: Record<IdSpace, VertexKindName> = {
  ingredient: "ingredient",
  composite: "composite",
  group: "group",
  tool: "tool",
  dirty: "dirty",
};

export function validateNodeGraph(doc: NodeGraphMap): GraphValidation {
  const issues: GraphIssue[] = [];
  const lk = buildLookup(doc);

  const add = (
    invariantId: string,
    message: string,
    extra: Partial<GraphIssue> = {},
  ): void => {
    const def = invariant(invariantId);
    issues.push({
      invariantId,
      severity: def?.severity ?? "error",
      message,
      ...extra,
    });
  };

  checkNamespace(doc, add);
  checkRefs(doc, lk, add);
  checkUniqueProducer(doc, add);
  checkAcyclic(doc, lk, add);
  checkComposites(doc, lk, add);
  checkGroups(doc, add);
  checkIntermediates(doc, lk, add);
  checkTraceable(doc, lk, add);
  checkRebuildable(lk, add);
  checkIdTable(doc, lk, add);
  checkWarnings(doc, lk, add);

  return {
    errors: issues.filter((i) => i.severity === "error"),
    warnings: issues.filter((i) => i.severity === "warning"),
  };
}

type Add = (id: string, message: string, extra?: Partial<GraphIssue>) => void;

/** Base/topping/option edges resolve in ONE namespace, so a name may belong to only one kind. */
function checkNamespace(doc: NodeGraphMap, add: Add): void {
  const seen = new Map<string, VertexKindName>();
  for (const kind of ["ingredient", "tool", "group", "composite", "dirty"] as const) {
    for (const vertex of doc.vertices[kind]) {
      const prior = seen.get(vertex.name);
      if (prior) {
        add("INV-NAMESPACE", `"${vertex.name}" is declared as both a ${prior} and a ${kind}; references would be ambiguous.`, {
          vertexKind: kind,
          vertexName: vertex.name,
        });
      } else {
        seen.set(vertex.name, kind);
      }
    }
  }
}

function checkRefs(doc: NodeGraphMap, lk: GraphLookup, add: Add): void {
  const check = (name: string, expected: VertexKindName[], context: string, edge?: GraphIssue["edge"]): void => {
    const kind = lk.kindOf.get(name);
    if (!kind) {
      add("INV-REF", `${context} names "${name}", which is not declared in this map.`, { edge });
      return;
    }
    if (!expected.includes(kind)) {
      add("INV-REF", `${context} names "${name}", which is a ${kind}; expected ${expected.join(" or ")}.`, { edge });
    }
  };

  for (const e of doc.edges.process) {
    const edge = { kind: "process", from: e.from, to: e.to };
    check(e.from, ["tool"], "A process edge's source", edge);
    check(e.to, ["ingredient"], "A process edge's output", edge);
    for (const input of e.inputs) check(input, ["ingredient"], `Process ${e.from}->${e.to} input`, edge);
    for (const tool of e.chainTools ?? []) check(tool, ["tool"], `Process ${e.from}->${e.to} chainTool`, edge);
  }
  for (const kind of ["base", "topping"] as const) {
    for (const e of doc.edges[kind]) {
      const edge = { kind, from: e.from, to: e.to };
      check(e.from, ["composite"], `A ${kind} edge's source`, edge);
      check(e.to, ["ingredient", "group", "composite"], `A ${kind} edge's target`, edge);
    }
  }
  for (const e of doc.edges.option) {
    const edge = { kind: "option", from: e.from, to: e.to };
    check(e.from, ["group"], "An option edge's source", edge);
    check(e.to, ["ingredient", "group", "composite"], "An option edge's target", edge);
  }
  for (const e of doc.edges.leavesDirty) {
    const edge = { kind: "leavesDirty", from: e.from, to: e.to };
    check(e.from, ["composite"], "A leavesDirty edge's source", edge);
    check(e.to, ["dirty"], "A leavesDirty edge's target", edge);
  }
}

/** At most one tool may produce an ingredient — what makes a backward trace deterministic. */
function checkUniqueProducer(doc: NodeGraphMap, add: Add): void {
  const producers = new Map<string, string[]>();
  for (const e of doc.edges.process) {
    const list = producers.get(e.to) ?? [];
    list.push(e.from);
    producers.set(e.to, list);
  }
  for (const [ingredient, tools] of producers) {
    if (tools.length > 1) {
      add(
        "INV-UNIQUE-PRODUCER",
        `"${ingredient}" is produced by ${tools.length} tools (${tools.join(", ")}); a backward trace would be ambiguous.`,
        { vertexKind: "ingredient", vertexName: ingredient },
      );
    }
  }
  for (const ingredient of doc.vertices.ingredient) {
    if (producers.has(ingredient.name) || ingredient.pickupable) continue;
    add(
      "INV-UNIQUE-PRODUCER",
      `"${ingredient.name}" is not pickupable and no tool produces it — nothing can ever obtain it.`,
      { vertexKind: "ingredient", vertexName: ingredient.name },
    );
  }
}

function checkAcyclic(doc: NodeGraphMap, lk: GraphLookup, add: Add): void {
  const next = new Map<string, string[]>();
  const push = (from: string, to: string): void => {
    const list = next.get(from) ?? [];
    list.push(to);
    next.set(from, list);
  };
  // Production flows output -> input (backward walk direction).
  for (const e of doc.edges.process) for (const input of e.inputs) push(e.to, input);
  for (const e of doc.edges.base) push(e.from, e.to);
  for (const e of doc.edges.topping) push(e.from, e.to);
  for (const e of doc.edges.option) push(e.from, e.to);

  const state = new Map<string, 0 | 1 | 2>(); // unvisited / on-stack / done
  const reported = new Set<string>();
  const visit = (node: string): void => {
    if (state.get(node) === 2) return;
    if (state.get(node) === 1) {
      if (!reported.has(node)) {
        reported.add(node);
        add("INV-ACYCLIC", `"${node}" is part of a cycle; a trace through it would never terminate.`, {
          vertexKind: lk.kindOf.get(node),
          vertexName: node,
        });
      }
      return;
    }
    state.set(node, 1);
    for (const child of next.get(node) ?? []) visit(child);
    state.set(node, 2);
  };
  for (const node of next.keys()) visit(node);
}

function checkComposites(doc: NodeGraphMap, lk: GraphLookup, add: Add): void {
  const baseCount = new Map<string, number>();
  for (const e of doc.edges.base) baseCount.set(e.from, (baseCount.get(e.from) ?? 0) + 1);
  const toppingCount = new Map<string, number>();
  for (const e of doc.edges.topping) toppingCount.set(e.from, (toppingCount.get(e.from) ?? 0) + 1);
  const dirtyCount = new Map<string, number>();
  for (const e of doc.edges.leavesDirty) dirtyCount.set(e.from, (dirtyCount.get(e.from) ?? 0) + 1);

  for (const composite of doc.vertices.composite) {
    const bases = baseCount.get(composite.name) ?? 0;
    if (bases === 0) {
      add("INV-BASE-REQUIRED", `Composite "${composite.name}" has no base — nothing to build the dish on.`, {
        vertexKind: "composite",
        vertexName: composite.name,
      });
    } else if (bases > 1) {
      add("INV-BASE-REQUIRED", `Composite "${composite.name}" has ${bases} base edges; exactly one is allowed.`, {
        vertexKind: "composite",
        vertexName: composite.name,
      });
    }
    // Requiring a topping slot that does not exist makes every order of this
    // composite unfillable — a mistake worth catching at authoring time, not
    // when a generated customer never gets served.
    if (composite.toppingRequired && (toppingCount.get(composite.name) ?? 0) === 0) {
      add(
        "INV-TOPPING-REQUIRED",
        `Composite "${composite.name}" requires a topping but has no topping edge — no order of it could ever be filled.`,
        { vertexKind: "composite", vertexName: composite.name },
      );
    }
    for (const [label, count] of [
      ["topping", toppingCount.get(composite.name) ?? 0],
      ["leavesDirty", dirtyCount.get(composite.name) ?? 0],
    ] as const) {
      if (count > 1) {
        add("INV-REF", `Composite "${composite.name}" has ${count} ${label} edges; at most one is allowed.`, {
          vertexKind: "composite",
          vertexName: composite.name,
        });
      }
    }
  }
  void lk;
}

function checkGroups(doc: NodeGraphMap, add: Add): void {
  const optionCount = new Map<string, number>();
  for (const e of doc.edges.option) optionCount.set(e.from, (optionCount.get(e.from) ?? 0) + 1);
  for (const group of doc.vertices.group) {
    const count = optionCount.get(group.name) ?? 0;
    if (count === 0) {
      add("INV-GROUP-NONEMPTY", `Group "${group.name}" has no options — nothing can fill it.`, {
        vertexKind: "group",
        vertexName: group.name,
      });
    } else if (count === 1 && (group.maxQuantity ?? -1) === 1) {
      // One option and room for exactly one pick: the designer wrote a choice
      // that has nothing to choose between.
      add("WARN-DEGENERATE-CHOICE", `Group "${group.name}" offers one option and allows one pick, so it is not a choice.`, {
        vertexKind: "group",
        vertexName: group.name,
      });
    }
  }
}

/**
 * An ingredient that is neither servable nor pickupable only ever sits between
 * two tools. Producing several at once would leave part of a batch forwarded
 * and part stranded, so v1 requires amount 1. Multi-input recipes are likewise
 * kept in the data but flagged as beyond what the v1 sim reads.
 */
function checkIntermediates(doc: NodeGraphMap, lk: GraphLookup, add: Add): void {
  for (const e of doc.edges.process) {
    const target = doc.vertices.ingredient.find((i) => i.name === e.to);
    const isIntermediate = target && !target.servable && !target.pickupable;
    if (isIntermediate && e.amount !== 1) {
      add(
        "INV-INTERMEDIATE-AMOUNT",
        `Process ${e.from}->${e.to} yields ${e.amount}, but "${e.to}" is a non-servable intermediate; only 1 is supported.`,
        { edge: { kind: "process", from: e.from, to: e.to } },
      );
    }
    if (e.inputs.length > 1) {
      add(
        "WARN-MULTI-INPUT",
        `Process ${e.from}->${e.to} declares ${e.inputs.length} inputs; the simulation reads only the first.`,
        { edge: { kind: "process", from: e.from, to: e.to } },
      );
    }
  }
  void lk;
}

function checkTraceable(doc: NodeGraphMap, lk: GraphLookup, add: Add): void {
  for (const orderable of lk.orderables) {
    const trace = traceOrderable(lk, orderable);
    for (const dead of trace.unreachable) {
      add(
        "INV-TRACEABLE",
        `Orderable "${orderable}" needs "${dead}", which is not pickupable and nothing produces it.`,
        { vertexKind: "composite", vertexName: orderable },
      );
    }
    if (trace.variantCount === null) {
      add(
        "WARN-UNBOUNDED",
        `Orderable "${orderable}" has unbounded concrete variants — a MULTIPLE group on its path is uncapped.`,
        { vertexKind: "composite", vertexName: orderable },
      );
    }
  }
  // Anything reachable as a slot option must be servable, or it can never fill a dish.
  for (const orderable of lk.orderables) {
    for (const slot of slotsOf(lk, orderable)) {
      for (const option of slot.options) {
        if (!lk.servable.has(option)) {
          add(
            "INV-SERVABLE",
            `"${option}" can fill a slot of "${orderable}" but is not marked servable.`,
            { vertexKind: "ingredient", vertexName: option },
          );
        }
      }
    }
  }
  void doc;
}

/**
 * The condition that makes a legacy flat dish re-bracketable: every servable
 * ingredient must map to exactly one slot. C1 is two slots of one composite,
 * C2 is slots of two different orderables — both make the bracket structure
 * unrecoverable from a bare multiset.
 *
 * Nesting depth is deliberately NOT checked: nested composites flatten into
 * the slot list cleanly, so depth is not the hazard. Slot ambiguity is.
 */
function checkRebuildable(lk: GraphLookup, add: Add): void {
  const { ambiguous } = slotIndex(lk);
  for (const [ingredient, places] of ambiguous) {
    const orderables = new Set(places.map((p) => p.orderable));
    const detail = places.map((p) => `${p.orderable} slot ${p.slot}`).join(", ");
    const which = orderables.size > 1 ? "two orderables (C2)" : "two slots of one composite (C1)";
    add(
      "INV-ORDER-REBUILDABLE",
      `"${ingredient}" can fill ${which}: ${detail}. A dish naming it would be ambiguous.`,
      { vertexKind: "ingredient", vertexName: ingredient },
    );
  }
}

function checkIdTable(doc: NodeGraphMap, lk: GraphLookup, add: Add): void {
  for (const issue of validateIdTable(doc.idTable)) {
    add("INV-IDTABLE-UNIQUE", `${issue.space}: ${issue.message}`);
  }
  for (const space of ID_SPACES) {
    for (const entry of doc.idTable[space] ?? []) {
      if (entry.node === null || entry.node === undefined) continue;
      const kind = lk.kindOf.get(entry.node);
      if (!kind) {
        add(
          "INV-IDTABLE-RESOLVES",
          `Id ${entry.id} in the ${space} space names "${entry.node}", which is not declared in this map.`,
        );
      } else if (kind !== SPACE_KIND[space]) {
        add(
          "INV-IDTABLE-RESOLVES",
          `Id ${entry.id} in the ${space} space names "${entry.node}", which is a ${kind}.`,
        );
      }
    }
  }
  // Anything level data may reference needs an id, or it is unreachable from level data.
  const ix = buildIdIndex(doc.idTable);
  const needsId: [IdSpace, string][] = [
    ...doc.vertices.ingredient.filter((i) => i.pickupable || i.servable).map((i) => ["ingredient", i.name] as [IdSpace, string]),
    ...doc.vertices.composite.filter((c) => c.orderable).map((c) => ["composite", c.name] as [IdSpace, string]),
  ];
  for (const [space, name] of needsId) {
    if (ix.byNode[space].get(name) === undefined) {
      add("WARN-UNTABLED-NODE", `${space} "${name}" has no id-table entry, so level data cannot reference it.`, {
        vertexName: name,
      });
    }
  }
}

function checkWarnings(doc: NodeGraphMap, lk: GraphLookup, add: Add): void {
  // Everything reachable from any orderable, following production and assembly.
  const reached = new Set<string>();
  const walk = (node: string): void => {
    if (reached.has(node)) return;
    reached.add(node);
    const kind = lk.kindOf.get(node);
    if (kind === "ingredient") {
      const edge = lk.producerOf.get(node);
      if (edge) {
        reached.add(edge.from);
        for (const tool of edge.chainTools ?? []) reached.add(tool);
        edge.inputs.forEach(walk);
      }
      return;
    }
    if (kind === "group") {
      for (const opt of lk.optionsOf.get(node) ?? []) walk(opt.to);
      return;
    }
    if (kind === "composite") {
      const base = lk.baseOf.get(node);
      if (base) walk(base);
      const topping = lk.toppingOf.get(node);
      if (topping) walk(topping);
      const dirty = lk.dirtyOf.get(node);
      if (dirty) reached.add(dirty);
    }
  };
  for (const orderable of lk.orderables) walk(orderable);

  for (const e of doc.edges.process) {
    if (!reached.has(e.to)) {
      add("WARN-ORPHAN-OUTPUT", `"${e.to}" is produced by ${e.from} but no orderable ever needs it.`, {
        vertexKind: "ingredient",
        vertexName: e.to,
      });
    }
  }
  for (const ingredient of doc.vertices.ingredient) {
    if (ingredient.pickupable && !reached.has(ingredient.name)) {
      add("WARN-UNUSED-PICKUP", `Pickupable "${ingredient.name}" is never needed by any orderable.`, {
        vertexKind: "ingredient",
        vertexName: ingredient.name,
      });
    }
  }
  for (const composite of doc.vertices.composite) {
    if (!reached.has(composite.name)) {
      add("WARN-UNREACHED-COMPOSITE", `Composite "${composite.name}" is not reachable from any orderable.`, {
        vertexKind: "composite",
        vertexName: composite.name,
      });
    }
  }
  const producing = new Set(doc.edges.process.map((e) => e.from));
  for (const tool of doc.vertices.tool) {
    if (!producing.has(tool.name)) {
      add("WARN-EMPTY-TOOL", `Tool "${tool.name}" has no recipes.`, {
        vertexKind: "tool",
        vertexName: tool.name,
      });
    }
  }
}
