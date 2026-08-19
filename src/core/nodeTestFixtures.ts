// Test-only graph surgery.
//
// The two spellings of a two-tool route — one `chainTools` edge vs two `process`
// edges through a real intermediate vertex — are NOT interchangeable, and several
// tests exist precisely to pin down how each behaves. Those tests used to reach
// into `burger.json` and use whichever route happened to be spelled which way.
//
// That coupled them to a DESIGNER'S DATA. Re-authoring a route in the editor is
// an ordinary thing to do, and it should not break a test about the engine. So
// the fixtures below derive the spelling they need instead of assuming it.

import type { NodeGraphMap, ProcessEdge } from "../data/nodeGraphTypes.ts";

/**
 * Collapse `a -tool1-> intermediate -tool2-> b` into the single-edge
 * `a -tool1[chainTools: tool2]-> b` spelling, dropping the intermediate vertex.
 *
 * Yield multiplies along the collapsed chain, matching `terminalYield`.
 * Throws rather than returning a half-edited graph — a fixture that silently
 * did nothing would make the test it feeds pass for the wrong reason.
 */
export function collapseToChainTools(doc: NodeGraphMap, intermediate: string): NodeGraphMap {
  const clone = structuredClone(doc);
  const produces = clone.edges.process.find((e) => e.to === intermediate);
  const consumes = clone.edges.process.find((e) => e.inputs.some((i) => i.ingredient === intermediate));
  if (!produces || !consumes) {
    throw new Error(`"${intermediate}" is not a two-edge intermediate in this graph`);
  }

  const merged: ProcessEdge = {
    ...produces,
    to: consumes.to,
    amount: (produces.amount ?? 1) * (consumes.amount ?? 1),
    chainTools: [...(produces.chainTools ?? []), consumes.from, ...(consumes.chainTools ?? [])],
  };

  clone.edges.process = clone.edges.process
    .filter((e) => e !== produces && e !== consumes)
    .concat(merged);
  clone.vertices.ingredient = clone.vertices.ingredient.filter((v) => v.name !== intermediate);
  return clone;
}

/**
 * The inverse: split a `chainTools` edge into real `process` edges through named
 * intermediate vertices, one per hop. Present so a test can state the same route
 * both ways and compare, rather than hand-authoring two graphs that drift apart.
 */
export function expandChainTools(doc: NodeGraphMap, output: string): NodeGraphMap {
  const clone = structuredClone(doc);
  const index = clone.edges.process.findIndex((e) => e.to === output && (e.chainTools ?? []).length > 0);
  if (index === -1) throw new Error(`no chainTools edge produces "${output}"`);

  const original = clone.edges.process[index];
  const hops = [original.from, ...(original.chainTools ?? [])];
  const template = clone.vertices.ingredient.find((v) => v.name === output);

  const built: ProcessEdge[] = [];
  let input = original.inputs[0].ingredient;
  for (let hop = 0; hop < hops.length; hop++) {
    const last = hop === hops.length - 1;
    const to = last ? output : `${output}__hop${hop}`;
    if (!last) {
      // A non-servable, non-pickupable intermediate: exactly what auto-forwarding
      // keys off. Cloning the output's own vertex keeps unrelated fields honest.
      clone.vertices.ingredient.push({
        ...(template ?? { name: to, displayName: to }),
        name: to,
        displayName: to,
        pickupable: false,
      });
    }
    built.push({
      from: hops[hop],
      to,
      inputs: [{ ingredient: input, slot: 0 }],
      // All the yield rides on the final hop, so `terminalYield` is preserved.
      amount: last ? (original.amount ?? 1) : 1,
      ...(original.duration !== undefined && last ? { duration: original.duration } : {}),
    });
    input = to;
  }

  clone.edges.process.splice(index, 1, ...built);
  return clone;
}

/** The chainTools spelling of whatever `burger.json` currently says about potato. */
export function chainedPotato(doc: NodeGraphMap): NodeGraphMap {
  return hasIntermediate(doc, "potato_sliced") ? collapseToChainTools(doc, "potato_sliced") : doc;
}

function hasIntermediate(doc: NodeGraphMap, name: string): boolean {
  return doc.edges.process.some((e) => e.to === name);
}
