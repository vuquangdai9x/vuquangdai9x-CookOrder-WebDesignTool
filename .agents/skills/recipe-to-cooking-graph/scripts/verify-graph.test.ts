import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGraphJson } from "../../../../src/data/nodeGraphJson.ts";
import { traceAll } from "../../../../src/data/nodeGraphResolve.ts";
import type { NodeGraphMap, VertexKindName } from "../../../../src/data/nodeGraphTypes.ts";
import { validateNodeGraph } from "../../../../src/data/nodeGraphValidate.ts";

type FoodMap = Record<string, string[]>;
type Point = { x: number; y: number };
type Wire = { from: string; to: string };

const MUST_FIX_WARNINGS = new Set([
  "WARN-DEGENERATE-CHOICE",
  "WARN-EMPTY-TOOL",
  "WARN-ORPHAN-OUTPUT",
  "WARN-UNREACHED-COMPOSITE",
  "WARN-UNTABLED-NODE",
  "WARN-UNUSED-DEAD-NODE",
  "WARN-UNUSED-PICKUP",
]);

const requestedGraphFile = process.env.COOKING_GRAPH_FILE;
// The repository's ordinary `vitest run` discovers this helper too. Use a
// harmless legacy fixture for module setup and skip the suite unless the skill
// invocation explicitly supplies its target graph.
const graphFile = requestedGraphFile ?? "src/data/config/nodegraph/maps/Graph-1-Burger.json";

const absolute = resolve(process.cwd(), graphFile);
const raw = readFileSync(absolute, "utf8");
const parsed = parseGraphJson(raw);
if (!parsed.doc) throw new Error(parsed.issues.join("\n"));
const doc = parsed.doc;

const minPickups = numericEnv("COOKING_GRAPH_MIN_PICKUPS", 15);
const maxPickups = numericEnv("COOKING_GRAPH_MAX_PICKUPS", 35);
const exactTools = optionalCountEnv("COOKING_GRAPH_EXACT_TOOLS");
const minTools = optionalCountEnv("COOKING_GRAPH_MIN_TOOLS");
const maxTools = optionalCountEnv("COOKING_GRAPH_MAX_TOOLS");
const maxAssemblyDepth = numericEnv("COOKING_GRAPH_MAX_ASSEMBLY_DEPTH", 3);
const maxCrossingRatio = numericEnv("COOKING_GRAPH_MAX_CROSSING_RATIO", 0.05);
const allowedWarnings = new Set(csvEnv("COOKING_GRAPH_ALLOW_WARNINGS"));
const cleanServeOrderables = new Set(csvEnv("COOKING_GRAPH_ALLOW_CLEAN_SERVE"));
const allowedNonstandardNames = new Set(csvEnv("COOKING_GRAPH_ALLOW_NONSTANDARD_NAMES"));

const validation = validateNodeGraph(doc);
const pickupCount = doc.vertices.ingredient.filter((node) => node.pickupable).length;
const toolCount = doc.vertices.tool.length;
const namingIssues = validateNodeNames(doc, allowedNonstandardNames);
const visualAuditIssues = validateVisualAudit(doc);
const foodMap = readFoodMap(doc);
const orderables = doc.vertices.composite.filter((node) => node.orderable).map((node) => node.name);
const mappingIssues = validateFoodMap(foodMap, orderables);
const dirtyIssues = validateDirtyCoverage(doc, orderables, cleanServeOrderables);
const assemblyDepths = orderables.map((name) => ({ name, depth: assemblyDepth(doc, name) }));
const missingEmoji = renderedEmojiGaps(doc);
const layout = layoutReport(doc);
const traces = traceAll(doc);
const blockingWarnings = validation.warnings
  .filter((issue) => MUST_FIX_WARNINGS.has(issue.invariantId) && !allowedWarnings.has(issue.invariantId))
  .map((issue) => `${issue.invariantId}: ${issue.message}`);

const report = {
  file: graphFile,
  pickupCount,
  pickupRange: [minPickups, maxPickups],
  toolCount,
  recommendedToolRange: [4, 5],
  explicitToolConstraint: { exact: exactTools, min: minTools, max: maxTools },
  namingIssues,
  visualAuditIssues,
  foodOrderableMap: foodMap,
  orderables,
  assemblyDepths,
  maxAssemblyDepth: Math.max(0, ...assemblyDepths.map((item) => item.depth)),
  unreachable: traces.flatMap((trace) => trace.unreachable.map((node) => `${trace.orderable}:${node}`)),
  parseIssues: parsed.issues,
  errors: validation.errors.map((issue) => `${issue.invariantId}: ${issue.message}`),
  warnings: validation.warnings.map((issue) => `${issue.invariantId}: ${issue.message}`),
  blockingWarnings,
  mappingIssues,
  dirtyIssues,
  pickupCoverage: traces.map((trace) => ({ orderable: trace.orderable, pickupables: trace.leaves.length })),
  missingEmoji,
  layout: { ...layout, maxCrossingRatio },
};

const recipeGraphSuite = requestedGraphFile ? describe : describe.skip;
recipeGraphSuite(`recipe graph: ${graphFile}`, () => {
  it("prints the authoring report", () => {
    console.log(JSON.stringify(report, null, 2));
  });

  it("parses without repair and passes authoritative validation", () => {
    expect(parsed.issues).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.unreachable).toEqual([]);
  });

  it("has no dead or structurally suspicious warning by default", () => {
    expect(blockingWarnings).toEqual([]);
  });

  it("stays within the requested pickup budget", () => {
    expect(pickupCount).toBeGreaterThanOrEqual(minPickups);
    expect(pickupCount).toBeLessThanOrEqual(maxPickups);
  });

  it("uses stable semantic node names", () => {
    expect(namingIssues).toEqual([]);
  });

  it("records a completed gameplay visual audit", () => {
    expect(visualAuditIssues).toEqual([]);
  });

  it("honors an explicit user tool-count constraint", () => {
    if (exactTools !== undefined) {
      expect(toolCount).toBe(exactTools);
      return;
    }
    if (minTools !== undefined) expect(toolCount).toBeGreaterThanOrEqual(minTools);
    if (maxTools !== undefined) expect(toolCount).toBeLessThanOrEqual(maxTools);
  });

  it("maps every orderable to exactly one requested food", () => {
    expect(mappingIssues).toEqual([]);
  });

  it("gives every orderable exactly one dirty result unless explicitly exempted", () => {
    expect(dirtyIssues).toEqual([]);
  });

  it("keeps assembly nesting within the requested depth", () => {
    for (const entry of assemblyDepths) expect(entry.depth, entry.name).toBeLessThanOrEqual(maxAssemblyDepth);
  });

  it("renders an emoji for every node", () => {
    expect(missingEmoji).toEqual([]);
  });

  it("lays out every node in left-to-right flow", () => {
    expect(layout.missing).toEqual([]);
    expect(layout.leftward).toEqual([]);
    expect(layout.crossingRatio).toBeLessThanOrEqual(maxCrossingRatio);
  });
});

function numericEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric.`);
  return value;
}

function optionalCountEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

function csvEnv(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function readFoodMap(graph: NodeGraphMap): FoodMap {
  const rawMap = (graph as unknown as Record<string, unknown>)._foodOrderableMap;
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) return {};
  return Object.fromEntries(
    Object.entries(rawMap as Record<string, unknown>).map(([food, value]) => [
      food,
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
    ]),
  );
}

function validateFoodMap(foodMap: FoodMap, orderables: string[]): string[] {
  const issues: string[] = [];
  if (Object.keys(foodMap).length === 0) issues.push("_foodOrderableMap is missing or empty");
  const mapped = new Map<string, string>();
  for (const [food, names] of Object.entries(foodMap)) {
    if (!food.trim()) issues.push("food map has an empty key");
    if (names.length === 0) issues.push(`food '${food}' maps to no orderable`);
    for (const name of names) {
      if (!orderables.includes(name)) issues.push(`food '${food}' names non-orderable '${name}'`);
      const prior = mapped.get(name);
      if (prior) issues.push(`orderable '${name}' is mapped by both '${prior}' and '${food}'`);
      else mapped.set(name, food);
    }
  }
  for (const name of orderables) if (!mapped.has(name)) issues.push(`orderable '${name}' is not mapped to a food`);
  return issues;
}

function validateDirtyCoverage(graph: NodeGraphMap, orderables: string[], exempt: Set<string>): string[] {
  const issues: string[] = [];
  for (const name of exempt) if (!orderables.includes(name)) issues.push(`clean-serve exemption names non-orderable '${name}'`);
  for (const name of orderables) {
    if (exempt.has(name)) continue;
    const outputs = graph.edges.leavesDirty.filter((edge) => edge.from === name);
    if (outputs.length !== 1) issues.push(`orderable '${name}' has ${outputs.length} leavesDirty edges; expected exactly 1`);
  }
  return issues;
}

function validateNodeNames(graph: NodeGraphMap, exempt: Set<string>): string[] {
  const issues: string[] = [];
  const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const genericCounter = /^(?:ingredient|tool|group|composite|dirty|node)-?\d+$/;
  for (const kind of ["ingredient", "tool", "group", "composite", "dirty"] as const) {
    for (const node of graph.vertices[kind]) {
      if (exempt.has(node.name)) continue;
      if (!kebab.test(node.name)) issues.push(`${kind} '${node.name}' is not lowercase ASCII kebab-case`);
      if (genericCounter.test(node.name)) issues.push(`${kind} '${node.name}' is a generated counter, not a semantic name`);
      if (kind === "dirty" && !node.name.startsWith("dirty-")) issues.push(`dirty '${node.name}' must start with 'dirty-'`);
    }
  }
  for (const name of exempt) {
    const exists = (["ingredient", "tool", "group", "composite", "dirty"] as const)
      .some((kind) => graph.vertices[kind].some((node) => node.name === name));
    if (!exists) issues.push(`nonstandard-name exemption names missing node '${name}'`);
  }
  return issues;
}

function validateVisualAudit(graph: NodeGraphMap): string[] {
  const raw = (graph as unknown as Record<string, unknown>)._visualAudit;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["_visualAudit is missing or not an object"];
  const audit = raw as Record<string, unknown>;
  const selectionSets = stringArray(audit.selectionSetsReviewed);
  const combinationPreviews = stringArray(audit.combinationPreviewsReviewed);
  const issues: string[] = [];
  if (selectionSets.length === 0) issues.push("_visualAudit.selectionSetsReviewed must name the reviewed pickup/choice sets");
  if (combinationPreviews.length === 0) issues.push("_visualAudit.combinationPreviewsReviewed must name reviewed dish combinations");
  if (audit.result !== "pass") issues.push("_visualAudit.result must be 'pass' after manual gameplay-scale review");
  return issues;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function assemblyDepth(graph: NodeGraphMap, root: string): number {
  const kind = new Map<string, VertexKindName>();
  for (const vertexKind of ["ingredient", "tool", "group", "composite", "dirty"] as const) {
    for (const node of graph.vertices[vertexKind]) kind.set(node.name, vertexKind);
  }
  const children = new Map<string, string[]>();
  const add = (from: string, to: string) => children.set(from, [...(children.get(from) ?? []), to]);
  for (const edge of [...graph.edges.base, ...graph.edges.topping, ...graph.edges.option]) add(edge.from, edge.to);

  const walk = (name: string, visiting: Set<string>): number => {
    if (visiting.has(name) || kind.get(name) === "ingredient") return 0;
    const next = new Set(visiting).add(name);
    const descendants = children.get(name) ?? [];
    const own = kind.get(name) === "group" || kind.get(name) === "composite" ? 1 : 0;
    return own + Math.max(0, ...descendants.map((child) => walk(child, next)));
  };
  return walk(root, new Set());
}

function renderedEmojiGaps(graph: NodeGraphMap): string[] {
  const gaps: string[] = [];
  for (const node of graph.vertices.ingredient) if (!node.emoji?.trim()) gaps.push(`ingredient:${node.name}`);
  for (const node of graph.vertices.tool) if (!node.emoji?.trim()) gaps.push(`tool:${node.name}`);
  for (const node of graph.vertices.composite) if (!node.emoji?.trim()) gaps.push(`composite:${node.name}`);
  for (const node of graph.vertices.dirty) if (!node.emoji?.trim()) gaps.push(`dirty:${node.name}`);
  // Group cards intentionally render the editor's built-in puzzle-piece emoji.
  return gaps;
}

function layoutReport(graph: NodeGraphMap): {
  missing: string[];
  leftward: string[];
  wireCount: number;
  eligibleCrossingPairs: number;
  crossings: number;
  crossingRatio: number;
} {
  const keys = new Set<string>();
  const byName = new Map<string, string>();
  for (const kind of ["ingredient", "tool", "group", "composite", "dirty"] as const) {
    for (const node of graph.vertices[kind]) {
      const key = `${kind}:${node.name}`;
      keys.add(key);
      byName.set(node.name, key);
    }
  }
  const layout = graph.layout ?? {};
  const missing = [...keys].filter((key) => !validPoint(layout[key]));
  const wires: Wire[] = [];
  const add = (fromName: string, toName: string) => {
    const from = byName.get(fromName);
    const to = byName.get(toName);
    if (from && to) wires.push({ from, to });
  };
  for (const edge of graph.edges.process) {
    for (const input of edge.inputs) add(input.ingredient, edge.from);
    add(edge.from, edge.to);
  }
  for (const edge of graph.edges.preservation) add(edge.to, edge.from);
  for (const edge of [...graph.edges.base, ...graph.edges.topping]) add(edge.to, edge.from);
  for (const edge of graph.edges.option) add(edge.to, edge.from);
  for (const edge of graph.edges.leavesDirty) add(edge.from, edge.to);

  const live = wires.filter((wire) => validPoint(layout[wire.from]) && validPoint(layout[wire.to]));
  const leftward = live
    .filter((wire) => layout[wire.from].x >= layout[wire.to].x)
    .map((wire) => `${wire.from} -> ${wire.to}`);
  let crossings = 0;
  let eligibleCrossingPairs = 0;
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) continue;
      eligibleCrossingPairs++;
      if (segmentsCross(layout[a.from], layout[a.to], layout[b.from], layout[b.to])) crossings++;
    }
  }
  return {
    missing,
    leftward,
    wireCount: live.length,
    eligibleCrossingPairs,
    crossings,
    crossingRatio: eligibleCrossingPairs ? Number((crossings / eligibleCrossingPairs).toFixed(3)) : 0,
  };
}

function validPoint(value: Point | undefined): value is Point {
  return !!value && Number.isFinite(value.x) && Number.isFinite(value.y);
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const direction = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = direction(a, b, c);
  const abD = direction(a, b, d);
  const cdA = direction(c, d, a);
  const cdB = direction(c, d, b);
  return abC * abD < 0 && cdA * cdB < 0;
}
