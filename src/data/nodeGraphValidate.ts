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
import { buildLookup, slotIndex, traceOrderable } from "./nodeGraphResolve.ts";
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

/**
 * Which vertex kinds an id space may point at.
 *
 * Four spaces name exactly one kind. The COMPOSITE space is the exception: it
 * is the space a dish's outermost `{cN:…}` resolves through, so it names
 * whatever is ORDERABLE — and an orderable need not be a composite. A dish of
 * one item (plain fries) is an ingredient; a dish that is a free choice from a
 * set is a group. Pinning this space to composites alone would make those
 * un-orderable for no reason beyond the name of the space.
 */
const SPACE_KINDS: Record<IdSpace, VertexKindName[]> = {
  ingredient: ["ingredient"],
  composite: ["composite", "ingredient", "group"],
  group: ["group"],
  tool: ["tool"],
  dirty: ["dirty"],
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

  // Computed once: three checks need to know whether a broken node is one
  // anything actually asks for.
  const reached = reachableFromOrderables(lk);

  checkNamespace(doc, add);
  checkRefs(doc, lk, add);
  checkUniqueProducer(doc, reached, add);
  checkAcyclic(doc, lk, add);
  checkComposites(doc, lk, add);
  checkGroups(doc, reached, add);
  checkDirtyStacks(doc, add);
  checkProcessCapabilities(doc, add);
  checkSlotPoints(doc, add);
  checkTraceable(doc, lk, add);
  checkRebuildable(lk, add);
  checkIdTable(doc, lk, add);
  checkWarnings(doc, reached, add);

  return {
    errors: issues.filter((i) => i.severity === "error"),
    warnings: issues.filter((i) => i.severity === "warning"),
  };
}

type Add = (id: string, message: string, extra?: Partial<GraphIssue>) => void;

function checkDirtyStacks(doc: NodeGraphMap, add: Add): void {
  for (const dirty of doc.vertices.dirty) {
    if (dirty.maxStack === undefined) continue;
    if (!Number.isInteger(dirty.maxStack) || dirty.maxStack < 1) {
      add("INV-DIRTY-STACK", `Dirty object "${dirty.name}" has maxStack ${dirty.maxStack}; it must be a positive integer.`, {
        vertexKind: "dirty",
        vertexName: dirty.name,
      });
    }
  }
}

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
    for (const input of e.inputs) {
      check(input.ingredient, ["ingredient"], `Process ${e.from}->${e.to} input`, edge);
    }
    for (const tool of e.chainTools ?? []) check(tool, ["tool"], `Process ${e.from}->${e.to} chainTool`, edge);
  }
  for (const e of doc.edges.preservation) {
    const edge = { kind: "preservation", from: e.from, to: e.to };
    check(e.from, ["tool"], "A preservation edge's source", edge);
    check(e.to, ["ingredient", "group"], "A preservation edge's target", edge);
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

/**
 * Everything an orderable can eventually reach, walking base/topping/option
 * edges down and production edges backwards.
 *
 * Shared by the warning pass and by the "nothing can obtain this" checks,
 * because whether a broken node MATTERS depends entirely on whether anything
 * asks for it — see checkUniqueProducer.
 */
function reachableFromOrderables(lk: GraphLookup): Set<string> {
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
        edge.inputs.forEach((i) => walk(i.ingredient));
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
  return reached;
}

/** At most one tool may produce an ingredient — what makes a backward trace deterministic. */
function checkUniqueProducer(doc: NodeGraphMap, reached: Set<string>, add: Add): void {
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
    // Unobtainable AND unwanted is not a broken graph, it is a leftover — art
    // that was drawn, a route that was planned and never wired, a node kept for
    // later. Nothing can reach it, so nothing can break on it, and reporting it
    // as an ERROR meant a map with an honest scrap of unfinished work looked
    // exactly as alarming as one with a genuinely impossible dish.
    if (!reached.has(ingredient.name)) {
      add(
        "WARN-UNUSED-DEAD-NODE",
        `"${ingredient.name}" cannot be obtained, but nothing orders it either — an unused leftover.`,
        { vertexKind: "ingredient", vertexName: ingredient.name },
      );
      continue;
    }
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
  for (const e of doc.edges.process) for (const input of e.inputs) push(e.to, input.ingredient);
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

function checkGroups(doc: NodeGraphMap, reached: Set<string>, add: Add): void {
  const optionCount = new Map<string, number>();
  for (const e of doc.edges.option) optionCount.set(e.from, (optionCount.get(e.from) ?? 0) + 1);
  for (const group of doc.vertices.group) {
    const count = optionCount.get(group.name) ?? 0;
    const min = group.minQuantity ?? 0;
    const max = group.maxQuantity ?? -1;
    if (min < 0 || (max >= 0 && min > max)) {
      add(
        "INV-GROUP-QUANTITY",
        `Group "${group.name}" has minQuantity ${min} and maxQuantity ${max}; the minimum must be non-negative and no greater than a finite maximum.`,
        { vertexKind: "group", vertexName: group.name },
      );
    }
    if (count === 0) {
      // Same reasoning as the unobtainable-ingredient case above: an empty
      // group no orderable reaches cannot stop anything from being made.
      add(
        reached.has(group.name) ? "INV-GROUP-NONEMPTY" : "WARN-UNUSED-DEAD-NODE",
        reached.has(group.name)
          ? `Group "${group.name}" has no options — nothing can fill it.`
          : `Group "${group.name}" has no options, but nothing reaches it either — an unused leftover.`,
        { vertexKind: "group", vertexName: group.name },
      );
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

/** Process features which remain informational rather than graph errors. */
function checkProcessCapabilities(doc: NodeGraphMap, add: Add): void {
  for (const e of doc.edges.process) {
    if (e.inputs.length > 1) {
      add(
        "WARN-MULTI-INPUT",
        `Process ${e.from}->${e.to} declares ${e.inputs.length} inputs; the simulation reads only the first.`,
        { edge: { kind: "process", from: e.from, to: e.to } },
      );
    }
  }
}

/**
 * The three slot-point rules. All of them fail SILENTLY at runtime if unchecked
 * — a recipe that simply never runs, or a pickup routed to the wrong place —
 * which is exactly the class of bug that is expensive to find by playing.
 */
function checkSlotPoints(doc: NodeGraphMap, add: Add): void {
  const toolOf = new Map(doc.vertices.tool.map((t) => [t.name, t]));
  const preservationCount = new Map<string, number>();
  for (const edge of doc.edges.preservation) {
    preservationCount.set(edge.from, (preservationCount.get(edge.from) ?? 0) + 1);
  }
  for (const tool of doc.vertices.tool) {
    const slots = tool.preservationSlots ?? 0;
    const edges = preservationCount.get(tool.name) ?? 0;
    if (!Number.isInteger(slots) || slots < 0) {
      add("INV-REF", `Tool "${tool.name}" has preservationSlots ${slots}; it must be a non-negative integer.`, {
        vertexKind: "tool",
        vertexName: tool.name,
      });
    }
    if (slots > 0 && edges === 0) {
      add("INV-REF", `Tool "${tool.name}" has preservation slots but no ingredient or group is wired to them.`, {
        vertexKind: "tool",
        vertexName: tool.name,
      });
    }
    if (edges > 0 && slots <= 0) {
      add("INV-REF", `Tool "${tool.name}" has a preservation edge but preservationSlots is zero.`, {
        vertexKind: "tool",
        vertexName: tool.name,
      });
    }
    if (edges > 1) {
      add("INV-REF", `Tool "${tool.name}" has ${edges} preservation edges; at most one is allowed.`, {
        vertexKind: "tool",
        vertexName: tool.name,
      });
    }
  }

  // INV-INPUT-SLOT-STABLE is per (tool, ingredient): dispatch routes an
  // incoming pickup by ingredient alone, so the point must not depend on which
  // recipe of that tool happens to be consulted.
  const pointOf = new Map<string, { point: number; via: string }>();

  for (const edge of doc.edges.process) {
    const tool = toolOf.get(edge.from);
    if (!tool) continue; // INV-REF reports the missing tool
    const points = tool.slotConfigs ?? [];
    const where = { kind: "process" as const, from: edge.from, to: edge.to };

    for (const input of edge.inputs) {
      if (input.slot < 0 || input.slot >= points.length) {
        add(
          "INV-INPUT-SLOT-RANGE",
          `Recipe ${edge.from} → ${edge.to}: "${input.ingredient}" is assigned to slot ${input.slot}, but ${edge.from} has ${points.length} slot point(s). It can never be filled, so this recipe would never run.`,
          { edge: where },
        );
        continue;
      }
      const key = `${edge.from} ${input.ingredient}`;
      const seen = pointOf.get(key);
      if (seen && seen.point !== input.slot) {
        add(
          "INV-INPUT-SLOT-STABLE",
          `"${input.ingredient}" enters ${edge.from} at slot ${seen.point} in the ${seen.via} recipe but slot ${input.slot} in the ${edge.to} recipe. A pickup is routed by ingredient, so its destination must not depend on which recipe is consulted.`,
          { edge: where },
        );
      } else if (!seen) {
        pointOf.set(key, { point: input.slot, via: edge.to });
      }
    }

    // WARN-UNEVEN-LANES: a job holds the same lane across every point it needs,
    // so a point wider than its partners has lanes that can be filled and never
    // paired — the machine looks busy while nothing completes.
    const used = [...new Set(edge.inputs.map((i) => i.slot))].filter((p) => points[p]);
    if (used.length > 1) {
      const lanes = used.map((p) => Math.max(1, points[p].slot));
      if (Math.min(...lanes) !== Math.max(...lanes)) {
        add(
          "WARN-UNEVEN-LANES",
          `Recipe ${edge.from} → ${edge.to} spans slot points with different lane counts (${used.map((p) => `${points[p].name}=${points[p].slot}`).join(", ")}). Only ${Math.min(...lanes)} job(s) can ever pair up; the extra lanes fill but never complete.`,
          { edge: where },
        );
      }
    }
  }
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
  void doc;
}

/**
 * One ingredient must not be offered by two slots of the SAME composite.
 *
 * `resolveOrder` maps ingredient -> slot per composite, last write winning, so
 * a dish that authored the item into slot 0 silently resolves into slot 1 —
 * carrying a gate that will never open. Measured, not assumed: putting
 * cheese-sauce into both the fried basket's base group and its sauce group
 * makes `{c2:{g1:16}}` resolve to `slot 1, gate 0` instead of the base slot.
 *
 * Sharing across two DIFFERENT orderables is deliberately allowed, and used to
 * be flagged here as "C2". The bracket format names the composite, so lookup
 * is scoped to it: a sauce offered by both a fried basket and a fried potato
 * resolves correctly in each, with the right slot, gate and dirty object. C2
 * only ever constrained the flat-list recogniser used by the legacy migration,
 * which is retired — keeping it would forbid a shared sauce for no live reason.
 *
 * Nesting depth is deliberately NOT checked: nested composites flatten into
 * the slot list cleanly, so depth is not the hazard. Slot ambiguity is.
 */
function checkRebuildable(lk: GraphLookup, add: Add): void {
  const { ambiguousWithinComposite } = slotIndex(lk);
  for (const [ingredient, places] of ambiguousWithinComposite) {
    const detail = places.map((p) => `${p.orderable} slot ${p.slot}`).join(", ");
    add(
      "INV-ORDER-REBUILDABLE",
      `"${ingredient}" can fill two slots of one composite: ${detail}. A dish naming it would resolve into the wrong slot.`,
      { vertexKind: "ingredient", vertexName: ingredient },
    );
  }
}

function checkIdTable(doc: NodeGraphMap, lk: GraphLookup, add: Add): void {
  for (const issue of validateIdTable(doc.idTable)) {
    add("INV-IDTABLE-UNIQUE", `${issue.space}: ${issue.message}`);
  }
  for (const space of ID_SPACES) {
    // The id is the row's index — see nodeIdTable.ts's header.
    (doc.idTable[space] ?? []).forEach((node, id) => {
      if (!node) return; // validateIdTable reports an empty row
      const kind = lk.kindOf.get(node);
      if (!kind) {
        add(
          "INV-IDTABLE-RESOLVES",
          `Id ${id} in the ${space} space names "${node}", which is not declared in this map.`,
        );
      } else if (!SPACE_KINDS[space].includes(kind)) {
        add(
          "INV-IDTABLE-RESOLVES",
          `Id ${id} in the ${space} space names "${node}", which is a ${kind} — this space accepts ${SPACE_KINDS[space].join(", ")}.`,
        );
      }
    });
  }
  // Anything level data may reference needs an id, or it is unreachable from level data.
  const ix = buildIdIndex(doc.idTable);
  const needsId: [IdSpace, string][] = [
    ...doc.vertices.ingredient.filter((i) => i.pickupable || lk.servable.has(i.name)).map((i) => ["ingredient", i.name] as [IdSpace, string]),
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

function checkWarnings(doc: NodeGraphMap, reached: Set<string>, add: Add): void {
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
