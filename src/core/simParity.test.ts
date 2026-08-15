// Parity: the legacy Simulation and the graph-native NodeSimulation, driven by
// the SAME deterministic script over every authored Map 1 level, must agree
// step for step.
//
// This is the highest-value test in the node-graph work. The conformance suite
// proves each mechanic in isolation; this proves that twenty levels of real
// authored data — 15-lane queues, combined blocks, frozen slots, staff, dirty
// stacking, multi-yield chops, chained recipes — produce the same run.
//
// It runs against `legacyToGraph(map1)`, NOT `burger.json`. burger.json
// deliberately diverges from the runtime (chicken goes through a flour step
// that the runtime has never had), so parity against it would fail BY DESIGN
// and would be measuring the divergence rather than the port.

import { describe, expect, it } from "vitest";
import burgerJson from "../data/config/nodegraph/burger.json";
import { MAP1_DATA } from "../data/configLoader.ts";
import { toMapDef } from "../data/mapLoader.ts";
import type { NodeGraphMap } from "../data/nodeGraphTypes.ts";
import { legacyLevelToNode, legacyToGraph } from "./legacyToGraph.ts";
import { buildIndex } from "./nodeIndex.ts";
import type { GraphIndex } from "./nodeIndex.ts";
import { NodeSimulation } from "./nodeSim.ts";
import { Simulation } from "./sim.ts";
import { resolveCookedId } from "./types.ts";
import type { LevelConfig, MapDef } from "./types.ts";

const map1: MapDef = toMapDef(MAP1_DATA);
const doc = legacyToGraph(map1, map1.levels);
const ix: GraphIndex = buildIndex(doc);

/**
 * Levels holding a dish LEGACY CANNOT COMPLETE, and so cannot be compared.
 *
 * A cooked ingredient with a `baseId` list can only be served once one of those
 * ids is already in the dish. Level data exists where none of them ever is —
 * fried potato (13) topped with cheese sauce (16), whose `baseId` is the four
 * chicken cuts. The legacy sim stalls on those forever. The graph fixes it (the
 * inferred composite puts potato in the same base slot as the cuts), which is a
 * genuine behaviour change and therefore not parity.
 *
 * Computed rather than hard-coded, and asserted below, so the exclusion cannot
 * quietly grow to hide a real regression.
 */
function legacyImpossible(level: LevelConfig): boolean {
  return level.customers.some((customer) =>
    customer.dishes.some((dish) =>
      dish.cookedIds.some((id) => {
        const baseId = map1.cookedIngredients.find((c) => c.id === id)?.baseId;
        if (baseId === undefined) return false;
        const options = Array.isArray(baseId) ? baseId : [baseId];
        return !options.some((b) => dish.cookedIds.includes(b));
      }),
    ),
  );
}

/** One observation per step — what both sims must agree on. */
type Trace = string[];

const occupancyOf = (cells: { kind: string }[]) => cells.filter((c) => c.kind !== "empty").length;

const MAX_STEPS = 900;

/**
 * The shared script: pick the left-most lane whose front item leads to
 * something a waiting customer still needs; otherwise let the clock run. Both
 * sims see the same board, so both make the same choice — any difference in
 * the trace is a difference in the SIMULATION, not in the driver.
 */
function runLegacy(map: MapDef, level: LevelConfig): Trace {
  const sim = new Simulation(map, level);
  const trace: Trace = [];
  for (let step = 0; step < MAX_STEPS && sim.status === "playing"; step++) {
    sim.completeAllFlights();
    const needed = sim.neededCookedIds();
    let lane = -1;
    for (let i = 0; i < sim.columnCount; i++) {
      const front = sim.frontCell(i);
      if (!front || front.item.kind !== "ingredient") continue;
      const produces = resolveCookedId(map.tools, map.rawIngredients, front.item.id);
      if (!needed.has(produces)) continue;
      if (!sim.canPick(i).ok) continue;
      lane = i;
      break;
    }
    if (lane >= 0) sim.pick(lane);
    else sim.tick(0.5);
    trace.push(`${sim.status}|${sim.servedCount}|${occupancyOf(sim.grid)}|${sim.time.toFixed(3)}`);
  }
  trace.push(`END ${sim.status}|${sim.servedCount}|${sim.loseReason ?? "-"}|${sim.time.toFixed(3)}`);
  return trace;
}

function runNode(level: LevelConfig): Trace {
  const projected = legacyLevelToNode(doc, level);
  expect(projected.unplaced, `${level.name} projection`).toEqual([]);
  const sim = new NodeSimulation(ix, projected.level);
  expect(sim.issues, `${level.name} binding`).toEqual([]);
  const trace: Trace = [];
  for (let step = 0; step < MAX_STEPS && sim.status === "playing"; step++) {
    sim.completeAllFlights();
    const needed = sim.neededIngredients();
    let lane = -1;
    for (let i = 0; i < sim.columnCount; i++) {
      const front = sim.frontCell(i);
      if (!front || front.item.kind !== "ingredient" || front.ing < 0) continue;
      if (!needed.has(ix.terminalOutput[front.ing])) continue;
      if (!sim.canPick(i).ok) continue;
      lane = i;
      break;
    }
    if (lane >= 0) sim.pick(lane);
    else sim.tick(0.5);
    trace.push(`${sim.status}|${sim.servedCount}|${occupancyOf(sim.grid)}|${sim.time.toFixed(3)}`);
  }
  trace.push(`END ${sim.status}|${sim.servedCount}|${sim.loseReason ?? "-"}|${sim.time.toFixed(3)}`);
  return trace;
}

const comparable = map1.levels.filter((l) => !legacyImpossible(l));
const excluded = map1.levels.filter(legacyImpossible);

describe("Simulation vs NodeSimulation, over real Map 1 data", () => {
  it("has levels to compare, and excludes only the known-defective ones", () => {
    expect(comparable.length).toBeGreaterThan(15);
    // The three levels carrying a `13.16` dish (fried potato + cheese sauce).
    expect(excluded.map((l) => l.id).sort((a, b) => a - b)).toEqual([17, 18, 20]);
  });

  for (const level of comparable) {
    it(`agrees step for step on ${level.name}`, () => {
      expect(runNode(level)).toEqual(runLegacy(map1, level));
    });
  }
});

describe("the excluded levels, and why", () => {
  it("legacy stalls on them — it never loses, it just never finishes", () => {
    const legacy = new Simulation(map1, excluded[0]);
    legacy.runToEnd(0.5, 2000);
    expect(legacy.status).toBe("playing");
    expect(legacy.servedCount).toBe(0);
  });

  it("the parity adapter refuses the dish, exactly as the runtime effectively does", () => {
    // `legacyToGraph` is runtime-FAITHFUL, so fried potato stays out of the
    // chicken family and `13.16` spans two composites. Refusing to place it is
    // the honest answer: there is no runtime behaviour here to mirror.
    const projected = legacyLevelToNode(doc, excluded[0]);
    expect(projected.unplaced.length).toBeGreaterThan(0);
    expect(projected.unplaced[0].reason).toMatch(/must be one orderable/);
  });

  it("burger.json is where the dish becomes playable — by design, not by accident", () => {
    // The hand-authored graph folds `potato-fried` into fried-basket-bases, so
    // the sauce applies to it like any other base. That is a deliberate design
    // change, which is why it lives in the authored map and not in the adapter.
    const authored = buildIndex(burgerJson as unknown as NodeGraphMap);
    const bases = authored.slotsOfComposite[authored.compositeByName.get("fried-basket")!][0];
    expect(bases.options.map((o) => authored.ingName[o])).toContain("potato-fried");
  });
});
