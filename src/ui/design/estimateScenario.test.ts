import { describe, expect, it } from "vitest";
import { SCENARIO_FIELDS, defaultScenario, resolveScenario } from "./estimateScenario.ts";

describe("estimateScenario", () => {
  it("resolves the defaults to the constants the solver used to hard-code", () => {
    const cfg = resolveScenario();
    expect(cfg.scoreBase).toBe(1000);
    expect(cfg.scoreReady).toBe(850);
    expect(cfg.scoreBlocked).toBe(260);
    expect(cfg.scoreBlockedTight).toBe(60);
    expect(cfg.scoreSweeper).toBe(500);
    expect(cfg.scoreSweeperUrgent).toBe(1400);
    expect(cfg.rowDecay).toBe(0.5);
    expect(cfg.maxIterations).toBe(5000);
    expect(cfg.maxPairDishes).toBe(5);
    expect(cfg.rngSeed).toBe(0x5eed);
    expect(cfg.hiddenStatus).toBe(false);
    expect(cfg.dynamicServeWindow).toBe(true);
  });

  it("substitutes each field's off value when its toggle is unticked", () => {
    const scenario = defaultScenario();
    for (const spec of SCENARIO_FIELDS) scenario.fields[spec.key].enabled = false;
    const cfg = resolveScenario(scenario);
    for (const spec of SCENARIO_FIELDS) {
      expect(cfg[spec.key], spec.key).toBe(spec.off);
      expect(cfg.enabled[spec.key], spec.key).toBe(false);
    }
  });

  it("fills gaps from a partial scenario rather than yielding undefined", () => {
    const partial = { hiddenStatus: true, fields: { scoreBase: { enabled: true, value: 5 } } };
    const cfg = resolveScenario(partial as never);
    expect(cfg.hiddenStatus).toBe(true);
    expect(cfg.scoreBase).toBe(5);
    expect(cfg.scoreReady).toBe(850);
    expect(cfg.dynamicServeWindow).toBe(true);
  });
});
