// Everything the graph-native simulation needs, precomputed once per document.
//
// Legacy sim.ts calls `map.cookedIngredients.find(...)` and
// `findToolRecipe(tools, id)` INSIDE the settle() fixpoint — a linear scan per
// serve attempt. Here every hot lookup is an array index, keyed by a dense
// ingredient/tool number interned at build time. That is not just tidier: it is
// strictly less work per tick than the model it replaces.
//
// Layering note: this lives in core/ but imports from data/nodeGraph*. That
// edge is safe and deliberate — the data/ node-graph modules import nothing
// from core/, so there is no cycle, and the alternative (putting the
// simulation's index under data/) would misplace it worse.

import { buildLookup, slotIndex, slotsOf } from "../data/nodeGraphResolve.ts";
import type { GraphLookup, Slot } from "../data/nodeGraphResolve.ts";
import type { NodeGraphMap, ToolVertex } from "../data/nodeGraphTypes.ts";

/** One consumed ingredient and the tool slot point it enters, in dense indices. */
export interface StepInput {
  ing: number;
  /** Index into the tool's slotConfigs. */
  point: number;
}

/** One recipe, with the tool's default duration already folded in. */
export interface ProcessStep {
  /** Dense tool index. */
  tool: number;
  /**
   * Every ingredient consumed, with its slot point. A recipe with more than one
   * runs only when ALL of their points hold an item in the same lane — see
   * `NodeSimulation.laneReady`.
   */
  inputs: StepInput[];
  /** Dense ingredient index produced. */
  out: number;
  amount: number;
  /** edge.duration ?? tool.cookingTime — resolved here so the sim never re-derives it. */
  duration: number;
  /** Extra tools visited in order, producing no intermediate item. */
  chainTools: number[];
}

/**
 * A tool's slot points flattened into addressable positions.
 *
 * The sim keeps ONE flat array of slots per tool — unchanged from when a tool
 * was just `numSlots` — and this says what each flat index means. Flat order is
 * point-major: every lane of point 0, then every lane of point 1. A job holds
 * the same LANE across every point it needs, which is what makes "which cup
 * pairs with which coffee" a fact rather than a guess.
 */
export interface ToolSlotLayout {
  points: { name: string; lanes: number }[];
  /** Per flat slot index, which point and lane it is. */
  flat: { point: number; lane: number }[];
  /** Widest point — the number of jobs the tool can hold when every point is that wide. */
  laneCount: number;
}

/** Flatten a tool's slotConfigs into per-slot addresses. */
export function toolSlotLayout(tool: ToolVertex): ToolSlotLayout {
  const points = (tool.slotConfigs ?? []).map((c) => ({
    name: c.name || "Slot",
    lanes: Math.max(1, Math.floor(c.slot) || 1),
  }));
  // A tool with no configured points still needs one, or nothing could ever
  // cook there and the failure would show up as a silent stall.
  if (points.length === 0) points.push({ name: "Slot", lanes: 1 });

  const flat: { point: number; lane: number }[] = [];
  points.forEach((p, point) => {
    for (let lane = 0; lane < p.lanes; lane++) flat.push({ point, lane });
  });
  return { points, flat, laneCount: Math.max(...points.map((p) => p.lanes)) };
}

/** The flat slot index for a point/lane pair, or -1 when that lane does not exist. */
export function flatSlot(layout: ToolSlotLayout, point: number, lane: number): number {
  return layout.flat.findIndex((s) => s.point === point && s.lane === lane);
}

/** Which slot point an ingredient enters for a given step; -1 when the step does not take it. */
export function inputPoint(step: ProcessStep, ing: number): number {
  return step.inputs.find((i) => i.ing === ing)?.point ?? -1;
}

/** A resolved choice point of an orderable, in dense indices. */
export interface IndexedSlot {
  kind: "fixed" | "group";
  /** Dense group index, or -1 for a fixed slot. */
  group: number;
  /** Dense group indices from outermost bracket to this slot's bracket. */
  groupPath: number[];
  options: number[];
  /** Per-option cap, parallel to `options`; -1 = unlimited. See Slot.optionMax. */
  optionMax: number[];
  maxQuantity: number;
  minQuantity: number;
  isBase: boolean;
}

export interface GraphIndex {
  doc: NodeGraphMap;
  lookup: GraphLookup;

  // --- interning ---
  ingName: string[];
  ingByName: Map<string, number>;
  toolName: string[];
  toolByName: Map<string, number>;
  groupName: string[];
  groupByName: Map<string, number>;
  compositeName: string[];
  compositeByName: Map<string, number>;
  dirtyName: string[];
  dirtyByName: Map<string, number>;

  // --- production, replacing findToolRecipe / resolveCookedId ---
  /** The one process edge producing this ingredient; null = pickupable leaf. */
  producerOf: (ProcessStep | null)[];
  /** The process edge consuming this ingredient; null = nothing takes it further. */
  recipeForInput: (ProcessStep | null)[];
  /**
   * Every recipe a tool owns, by dense tool index.
   *
   * `recipeForInput` cannot answer "what is this lane making?" on a multi-input
   * tool: ground coffee is the first input of BOTH the hot and the cool drink,
   * so it names neither until the cup beside it says which. Resolution is by the
   * whole set of items present in a lane — see `stepForLane`.
   */
  stepsOfTool: ProcessStep[][];
  /** Slot points per tool, resolved once: `slotConfigs`, flattened into lanes. */
  toolSlots: ToolSlotLayout[];
  /**
   * Following recipeForInput until the output is servable or nothing consumes
   * it. What a pickup ACTUALLY becomes — the estimator must score against this,
   * not one hop, or a chicken breast scores as producing a coated breast that
   * no dish wants.
   */
  terminalOutput: number[];
  /** Product of `amount` along that whole chain — real pieces per pickup. */
  terminalYield: number[];
  /** Tool visits along it. A chainTools route is one step (nothing lands mid-chain). */
  chainDepth: number[];
  /** Forward-reachable set per ingredient, including itself. */
  reachableOutputs: Uint8Array[];

  // --- assembly ---
  orderables: number[];
  slotsOfComposite: IndexedSlot[][];
  /** Ingredient -> {orderable, slot}, or undefined when ambiguous/unused. */
  slotOf: (({ orderable: number; slot: number }) | undefined)[];
  /**
   * EVERY slot an ingredient may fill, across all orderables. `slotOf` holds
   * only the first — enough when one representative will do, but a shared
   * ingredient (one sauce offered by two composites) genuinely has several,
   * and a caller that unions over them gets the whole truth.
   */
  placesOf: ({ orderable: number; slot: number }[])[];
  /** Composite -> dirty index, or -1 for the generic dirty dish. */
  dirtyOf: number[];

  // --- per-ingredient scalars, hoisted out of .find() ---
  usageNum: Int32Array;
  servable: Uint8Array;
  pickupable: Uint8Array;
}

function intern(names: string[]): Map<string, number> {
  return new Map(names.map((n, i) => [n, i]));
}

export function buildIndex(doc: NodeGraphMap): GraphIndex {
  const lookup = buildLookup(doc);

  const ingName = doc.vertices.ingredient.map((v) => v.name);
  const toolName = doc.vertices.tool.map((v) => v.name);
  const groupName = doc.vertices.group.map((v) => v.name);
  const compositeName = doc.vertices.composite.map((v) => v.name);
  const dirtyName = doc.vertices.dirty.map((v) => v.name);

  const ingByName = intern(ingName);
  const toolByName = intern(toolName);
  const groupByName = intern(groupName);
  const compositeByName = intern(compositeName);
  const dirtyByName = intern(dirtyName);

  const n = ingName.length;
  const usageNum = new Int32Array(n);
  const servable = new Uint8Array(n);
  const pickupable = new Uint8Array(n);
  doc.vertices.ingredient.forEach((v, i) => {
    usageNum[i] = v.usageNum ?? 1;
    servable[i] = v.servable ? 1 : 0;
    pickupable[i] = v.pickupable ? 1 : 0;
  });

  const producerOf: (ProcessStep | null)[] = new Array(n).fill(null);
  const recipeForInput: (ProcessStep | null)[] = new Array(n).fill(null);
  // Every recipe a tool owns. A multi-input tool needs this to work out WHICH
  // of its recipes a partly-filled lane is heading for: a coffee machine holds
  // ground coffee for both the hot and the cool drink, so the coffee alone does
  // not name the job — the cup or teacup beside it does.
  const stepsOfTool: ProcessStep[][] = doc.vertices.tool.map(() => []);

  for (const edge of doc.edges.process) {
    const tool = toolByName.get(edge.from);
    const out = ingByName.get(edge.to);
    if (tool === undefined || out === undefined) continue; // INV-REF reports it
    const inputs = edge.inputs
      .map((input) => {
        const ing = ingByName.get(input.ingredient);
        return ing === undefined ? null : { ing, point: input.slot ?? 0 };
      })
      .filter((i): i is StepInput => i !== null);
    const step: ProcessStep = {
      tool,
      inputs,
      out,
      amount: edge.amount,
      duration: edge.duration ?? doc.vertices.tool[tool].cookingTime,
      chainTools: (edge.chainTools ?? [])
        .map((name) => toolByName.get(name))
        .filter((i): i is number => i !== undefined),
    };
    // First writer wins; a second producer is an INV-UNIQUE-PRODUCER error.
    if (producerOf[out] === null) producerOf[out] = step;
    for (const input of inputs) {
      if (recipeForInput[input.ing] === null) recipeForInput[input.ing] = step;
      stepsOfTool[tool].push(step);
    }
  }
  // Deduplicated: a step is pushed once per input above.
  for (let t = 0; t < stepsOfTool.length; t++) stepsOfTool[t] = [...new Set(stepsOfTool[t])];

  // Follow recipeForInput until the output is servable (it lands on the grid)
  // or nothing consumes it. Memoized, with a visiting guard so cyclic data
  // returns rather than looping — this must stay total on invalid input.
  const terminalOutput = new Array<number>(n).fill(-1);
  const terminalYield = new Array<number>(n).fill(1);
  const chainDepth = new Array<number>(n).fill(0);
  const resolved = new Uint8Array(n);

  const resolveTerminal = (i: number, visiting: Set<number>): void => {
    if (resolved[i] || visiting.has(i)) {
      if (!resolved[i]) {
        terminalOutput[i] = i;
        terminalYield[i] = 1;
        chainDepth[i] = 0;
        resolved[i] = 1;
      }
      return;
    }
    const step = recipeForInput[i];
    if (!step || servable[i]) {
      terminalOutput[i] = i;
      terminalYield[i] = 1;
      chainDepth[i] = 0;
      resolved[i] = 1;
      return;
    }
    visiting.add(i);
    resolveTerminal(step.out, visiting);
    visiting.delete(i);
    terminalOutput[i] = terminalOutput[step.out];
    terminalYield[i] = step.amount * terminalYield[step.out];
    chainDepth[i] = 1 + chainDepth[step.out];
    resolved[i] = 1;
  };
  for (let i = 0; i < n; i++) resolveTerminal(i, new Set());

  // Forward reachability, memoized. Bitset per ingredient: 35 ingredients is
  // 5 bytes each, so this is free at any realistic map size.
  const words = Math.ceil(n / 8);
  const reachableOutputs: Uint8Array[] = new Array(n);
  const reachDone = new Uint8Array(n);
  const computeReach = (i: number, visiting: Set<number>): Uint8Array => {
    if (reachDone[i]) return reachableOutputs[i];
    const bits = new Uint8Array(words);
    bits[i >> 3] |= 1 << (i & 7);
    if (!visiting.has(i)) {
      visiting.add(i);
      const step = recipeForInput[i];
      if (step) {
        const downstream = computeReach(step.out, visiting);
        for (let w = 0; w < words; w++) bits[w] |= downstream[w];
      }
      visiting.delete(i);
    }
    reachableOutputs[i] = bits;
    reachDone[i] = 1;
    return bits;
  };
  for (let i = 0; i < n; i++) computeReach(i, new Set());

  // Assembly: slot trees per composite, in dense indices.
  const toIndexed = (slot: Slot): IndexedSlot => {
    const options: number[] = [];
    const optionMax: number[] = [];
    slot.options.forEach((name, at) => {
      const dense = ingByName.get(name);
      if (dense === undefined) return; // INV-REF reports the dangling name
      options.push(dense);
      optionMax.push(slot.optionMax[at] ?? -1);
    });
    return {
      kind: slot.kind,
      group: slot.group === null ? -1 : (groupByName.get(slot.group) ?? -1),
      groupPath: slot.groupPath.map((name) => groupByName.get(name) ?? -1).filter((group) => group >= 0),
      options,
      optionMax,
      maxQuantity: slot.maxQuantity,
      minQuantity: slot.minQuantity,
      isBase: slot.isBase,
    };
  };
  const slotsOfComposite = compositeName.map((name) => slotsOf(lookup, name).map(toIndexed));

  const { placesOf: placesOfName } = slotIndex(lookup);
  const slotOf: (({ orderable: number; slot: number }) | undefined)[] = new Array(n).fill(undefined);
  const placesOf: ({ orderable: number; slot: number }[])[] = Array.from({ length: n }, () => []);
  for (const [ingredient, places] of placesOfName) {
    const i = ingByName.get(ingredient);
    if (i === undefined) continue;
    for (const place of places) {
      const c = compositeByName.get(place.orderable);
      if (c === undefined) continue;
      placesOf[i].push({ orderable: c, slot: place.slot });
    }
    slotOf[i] = placesOf[i][0];
  }

  const dirtyOf = compositeName.map((name) => {
    const target = lookup.dirtyOf.get(name);
    return target === undefined ? -1 : (dirtyByName.get(target) ?? -1);
  });

  const orderables = doc.vertices.composite
    .map((c, i) => (c.orderable ? i : -1))
    .filter((i) => i !== -1);

  return {
    doc,
    lookup,
    ingName,
    ingByName,
    toolName,
    toolByName,
    groupName,
    groupByName,
    compositeName,
    compositeByName,
    dirtyName,
    dirtyByName,
    producerOf,
    recipeForInput,
    stepsOfTool,
    toolSlots: doc.vertices.tool.map(toolSlotLayout),
    terminalOutput,
    terminalYield,
    chainDepth,
    reachableOutputs,
    orderables,
    slotsOfComposite,
    slotOf,
    placesOf,
    dirtyOf,
    usageNum,
    servable,
    pickupable,
  };
}

/** True when `to` is forward-reachable from `from` (including from === to). */
export function reaches(ix: GraphIndex, from: number, to: number): boolean {
  const bits = ix.reachableOutputs[from];
  return bits !== undefined && (bits[to >> 3] & (1 << (to & 7))) !== 0;
}

/** True when anything in `demand` is forward-reachable from `ing` — the "is this pick wanted" test. */
export function reachesAny(ix: GraphIndex, ing: number, demand: Uint8Array): boolean {
  const bits = ix.reachableOutputs[ing];
  if (!bits) return false;
  for (let w = 0; w < bits.length; w++) if ((bits[w] & demand[w]) !== 0) return true;
  return false;
}
