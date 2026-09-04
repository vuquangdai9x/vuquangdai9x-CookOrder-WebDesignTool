import { describe, expect, it } from "vitest";
import { buildIndex } from "../../core/nodeIndex.ts";
import { NodeSimulation } from "../../core/nodeSim.ts";
import coffeeGraph from "../../data/config/nodegraph/maps/Graph-2-Coffee.json";
import coffeeLevelsCsv from "../../data/config/nodegraph/maps/LevelData-2-Coffee.csv?raw";
import burgerGraph from "../../data/config/nodegraph/maps/Graph-1-Burger.json";
import burgerLevelsCsv from "../../data/config/nodegraph/maps/LevelData-1-Burger.csv?raw";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import { toNodeLevelConfig } from "../../data/nodeLevel.ts";
import { importLevelsCsv } from "../../data/sheetSource.ts";
import { defaultScenario, resolveScenario } from "./estimateScenario.ts";
import {
  accumulateFailureKnowledge,
  applyFailureKnowledge,
  emptyFailureKnowledge,
  estimateNodeDifficulty,
} from "./nodeEstimateDifficulty.ts";

function replayPacedStep(sim: NodeSimulation, step: {
  lane: number;
  serveableSlots: number;
  waitBeforePickSeconds?: number;
  pickIntervalSeconds?: number;
}): boolean {
  if ((step.waitBeforePickSeconds ?? 0) > 0) sim.fastForward(step.waitBeforePickSeconds);
  sim.level.serveableSlots = step.serveableSlots;
  sim.tick(0);
  sim.completeAllFlights();
  if (!sim.pick(step.lane)) return false;
  sim.completeAllFlights();
  const interval = step.pickIntervalSeconds ?? 0;
  if (interval > 0 && sim.status === "playing") sim.tick(interval);
  sim.completeAllFlights();
  return true;
}

describe("estimateNodeDifficulty", () => {
  const ix = buildIndex(coffeeGraph as unknown as NodeGraphMap);
  const coffeeLevel = (id = 5) => {
    const data = importLevelsCsv(coffeeLevelsCsv).find((level) => level.id === id)!;
    return toNodeLevelConfig(data);
  };

  it("retries alternate strategies across the higher Map 1 levels", () => {
    const burgerIx = buildIndex(burgerGraph as unknown as NodeGraphMap);
    const levels = importLevelsCsv(burgerLevelsCsv)
      .filter((level) => level.id >= 6 && level.id <= 15)
      .map(toNodeLevelConfig);
    const results = levels.map((level) => estimateNodeDifficulty(burgerIx, level));
    const solved = results.filter((result) => result.solvable).length;
    const audit = results.map((result, index) =>
      `L${levels[index].id}:${result.solvable ? "win" : result.loseReason ?? "stuck"}@${result.strategyName}`,
    ).join(", ");
    expect(solved, audit).toBeGreaterThanOrEqual(Math.ceil(levels.length * 0.7));
    expect(results.every((result) => (result.attemptCount ?? 0) <= 11)).toBe(true);
    expect(results.some((result) => (result.attemptCount ?? 1) > 1)).toBe(true);
    for (const result of results) {
      if (result.solvable) {
        expect(result.learnedFromFailures).toBe((result.attemptCount ?? 1) - 1);
        expect(result.failureKnowledge?.failureCount).toBe((result.attemptCount ?? 1) - 1);
      } else {
        expect(result.failureKnowledge?.failureCount).toBe(result.attemptCount);
      }
    }
    const noRetry = estimateNodeDifficulty(burgerIx, levels.find((level) => level.id === 12)!, {
      maxRetries: 0,
    });
    expect(noRetry.attemptCount).toBe(1);
    expect(noRetry.learnedFromFailures).toBe(0);
  });

  it("solves Map 1 Level 20 with adaptive pacing and reports timeout warnings", () => {
    const burgerIx = buildIndex(burgerGraph as unknown as NodeGraphMap);
    const level = toNodeLevelConfig(importLevelsCsv(burgerLevelsCsv).find((value) => value.id === 20)!);
    const result = estimateNodeDifficulty(burgerIx, level);

    expect(result.solvable, result.reason).toBe(true);
    expect(result.servedCount).toBe(result.totalCustomers);
    expect(result.loseReason).not.toBe("customer-timeout");
  });

  it("keeps customer timeouts as exact warnings instead of failed attempts", () => {
    const burgerIx = buildIndex(burgerGraph as unknown as NodeGraphMap);
    const level = toNodeLevelConfig(importLevelsCsv(burgerLevelsCsv).find((value) => value.id === 20)!);
    for (const customer of level.customers) customer.waitTime = 0.01;
    const result = estimateNodeDifficulty(burgerIx, level);

    expect(result.solvable, result.reason).toBe(true);
    expect(result.loseReason).not.toBe("customer-timeout");
    expect(result.timedOutCustomers.length).toBeGreaterThan(0);
    expect(result.timedOutCustomers).toEqual([...new Set(result.timedOutCustomers)].sort((a, b) => a - b));
  });

  it("turns an earlier failure into bounded tuning for the next attempt", () => {
    const scenario = defaultScenario();
    const base = resolveScenario(scenario);
    const failure = {
      solvable: false,
      loseReason: "grid-overflow" as const,
      totalPicks: 4,
      servedCount: 0,
      totalCustomers: 2,
      byCid: new Map(),
      perCustomer: [{
        index: 0,
        gridOccupied: 4,
        gridWaste: 2,
        picks: 4,
        detours: 2,
        randomPicks: 1,
        bestPicks: 1,
      }],
      occupancyHistory: [{
        occupied: 8,
        dirty: 1,
        score: 0,
        random: true,
        pickedNames: ["test"],
        completesCustomers: [],
        customerIndex: 0,
      }],
      gridCapacity: 8,
      replaySteps: [],
      pickIntervalSeconds: 0.1,
      peakConcurrentWork: 6,
      timedOutCustomers: [],
    };

    const knowledge = accumulateFailureKnowledge(emptyFailureKnowledge(), failure);
    const learned = applyFailureKnowledge(base, knowledge);

    expect(knowledge.failureCount).toBe(1);
    expect(knowledge.gridPressure).toBeGreaterThan(0);
    expect(knowledge.pacingPressure).toBeGreaterThan(0);
    expect(learned.detourPenaltyTight).toBeGreaterThan(base.detourPenaltyTight);
    expect(learned.scoreBlockedTight).toBeLessThan(base.scoreBlockedTight);
    expect(learned.previewConfidence).toBeLessThan(base.previewConfidence);
    expect(learned.pickIntervalSeconds).toBeGreaterThan(base.pickIntervalSeconds);
  });

  it("does not learn failure pressure from a customer-timeout result", () => {
    const timedOut = {
      solvable: false,
      loseReason: "customer-timeout" as const,
      totalPicks: 1,
      servedCount: 0,
      totalCustomers: 1,
      byCid: new Map(),
      perCustomer: [],
      occupancyHistory: [],
      gridCapacity: 8,
      replaySteps: [],
      timedOutCustomers: [1],
    };

    expect(accumulateFailureKnowledge(emptyFailureKnowledge(), timedOut)).toEqual(emptyFailureKnowledge());
  });

  it("records the same grid occupancy that replay reconstructs for Map 2 Level 5", () => {
    const level = coffeeLevel();
    const estimate = estimateNodeDifficulty(ix, structuredClone(level));
    const replay = new NodeSimulation(ix, structuredClone(level), { instantFlights: true });

    expect(estimate.replaySteps.length).toBeGreaterThan(32);
    expect(estimate.solvable).toBe(true);
    expect(estimate.servedCount).toBe(estimate.totalCustomers);
    expect(Math.max(...estimate.occupancyHistory.map((sample) => sample.occupied))).toBeLessThan(
      estimate.gridCapacity,
    );
    // The original regression reported a full grid here. The graph-native path must retain space,
    // while the replay assertions below remain the authoritative per-step check.
    expect(estimate.occupancyHistory[31].occupied).toBeLessThan(estimate.gridCapacity);
    estimate.replaySteps.forEach((step, index) => {
      expect(replayPacedStep(replay, step), `pick ${index + 1}`).toBe(true);
      const occupied = replay.grid.filter((cell) => cell.kind !== "empty").length;
      expect(occupied, `grid occupancy after step ${index + 1}`).toBe(
        estimate.occupancyHistory[index].occupied,
      );
    });
  });

  it("scores every raw input of a multi-input process that produces a composite base", () => {
    const level = coffeeLevel();
    level.queues = [
      [{ kind: "ingredient", id: 9, effects: [] }], // coffee bean
      [{ kind: "ingredient", id: 8, effects: [] }], // teacup
      [{ kind: "ingredient", id: 10, effects: [] }], // milk (blocked until the hot-coffee base)
    ];
    level.queueGroups = [];
    level.customers = [{
      typeId: 0,
      waitTime: 0,
      weatherEff: 0,
      dishes: [{
        root: {
          kind: "composite",
          id: 3,
          members: [
            { kind: "ingredient", id: 24 },
            { kind: "ingredient", id: 10 },
          ],
        },
        effects: [],
      }],
    }];

    const estimate = estimateNodeDifficulty(ix, level);
    const [bean, teacup, blockedMilk] = estimate.replaySteps[0].laneScores as number[];
    expect(bean).toBeGreaterThan(blockedMilk);
    expect(teacup).toBeGreaterThan(blockedMilk);
    expect(estimate.replaySteps.slice(0, 2).map((step) => step.lane)).toEqual([0, 1]);
    expect(estimate.solvable).toBe(true);
    expect(estimate.pickIntervalSeconds).toBe(1);
    expect(estimate.replaySteps.every((step) => step.pickIntervalSeconds === 1)).toBe(true);
    expect(estimate.peakConcurrentWork).toBeGreaterThan(0);
  });

  it("scores composite-only demand from the next three customer previews", () => {
    const level = coffeeLevel();
    level.serveableSlots = 1;
    level.queues = [
      [{ kind: "ingredient", id: 9, effects: [] }], // coffee bean: useful to previewed hot coffee
      [{ kind: "ingredient", id: 11, effects: [] }], // ice: not part of hot coffee
    ];
    level.queueGroups = [];
    level.customers = [
      {
        typeId: 0,
        waitTime: 0,
        weatherEff: 0,
        // Active donut demand intentionally has no matching queue item.
        dishes: [{
          root: { kind: "composite", id: 0, members: [{ kind: "ingredient", id: 0 }] },
          effects: [],
        }],
      },
      {
        typeId: 0,
        waitTime: 0,
        weatherEff: 0,
        // The UI reveals only "hot coffee" (c3), not this exact combination.
        dishes: [{
          root: { kind: "composite", id: 3, members: [{ kind: "ingredient", id: 24 }] },
          effects: [],
        }],
      },
    ];

    const estimate = estimateNodeDifficulty(ix, level, { rng: () => 0 });
    const [bean, ice] = estimate.replaySteps[0].laneScores as number[];
    expect(bean).toBeGreaterThan(0);
    expect(bean).toBeGreaterThan(ice);
  });

  it("treats a hidden row as revealed once the Hidden slot toggle is off", () => {
    // Lane 0 hides the coffee bean behind a milk that cannot be placed until
    // the hot-coffee base exists, so only lookahead can see the bean's worth.
    const build = () => {
      const level = coffeeLevel();
      level.queues = [
        [
          { kind: "ingredient", id: 10, effects: [] },
          { kind: "ingredient", id: 9, effects: [{ effectId: 2, params: [] }] },
        ],
        [{ kind: "ingredient", id: 8, effects: [] }],
      ];
      level.queueGroups = [];
      level.customers = [{
        typeId: 0,
        waitTime: 0,
        weatherEff: 0,
        dishes: [{
          root: {
            kind: "composite",
            id: 3,
            members: [
              { kind: "ingredient", id: 24 },
              { kind: "ingredient", id: 10 },
            ],
          },
          effects: [],
        }],
      }];
      return level;
    };

    const hiddenOn = defaultScenario();
    hiddenOn.hiddenStatus = true;
    const hiddenOff = defaultScenario();

    const respected = estimateNodeDifficulty(ix, build(), { scenario: hiddenOn });
    const revealed = estimateNodeDifficulty(ix, build(), { scenario: hiddenOff });
    expect(revealed.replaySteps[0].laneScores[0]!).toBeGreaterThan(
      respected.replaySteps[0].laneScores[0]!,
    );
    // Default scenario must reproduce a run with no scenario at all.
    const untouched = estimateNodeDifficulty(ix, build());
    expect(revealed.replaySteps.map((step) => step.lane)).toEqual(
      untouched.replaySteps.map((step) => step.lane),
    );
  });

  it("drops lookahead entirely when the row decay field is disabled", () => {
    const scenario = defaultScenario();
    scenario.fields.rowDecay.enabled = false;
    const flat = estimateNodeDifficulty(ix, coffeeLevel(), { scenario });
    const normal = estimateNodeDifficulty(ix, coffeeLevel());
    expect(flat.replaySteps.map((step) => step.lane)).not.toEqual(
      normal.replaySteps.map((step) => step.lane),
    );
  });

  it("reaches a resting state after Map 2 Level 5 replay step 8", () => {
    const level = coffeeLevel();
    const estimate = estimateNodeDifficulty(ix, structuredClone(level));
    const replay = new NodeSimulation(ix, structuredClone(level), { instantFlights: false });

    expect(estimate.replaySteps.length).toBeGreaterThanOrEqual(8);
    for (let index = 0; index < 8; index++) {
      const step = estimate.replaySteps[index];
      expect(replayPacedStep(replay, step), `pick ${index + 1}`).toBe(true);
    }
    expect(replay.status).not.toBe("lost");
  });
});
