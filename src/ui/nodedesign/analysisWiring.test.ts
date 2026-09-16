import { describe, expect, it } from "vitest";
import nodeCustomerSectionSrc from "./nodeCustomerSection.ts?raw";
import nodeDesignSrc from "./index.ts?raw";
import analysisFoldoutSrc from "./analysisFoldout.ts?raw";
import checkSolvableSrc from "../design/checkSolvable.ts?raw";
import levelPathSrc from "../levelpath/index.ts?raw";
import validateLevelSrc from "../levelpath/validateLevel.ts?raw";

describe("Design analysis controls", () => {
  it("keeps generation and analysis actions in the level config bar", () => {
    expect(nodeCustomerSectionSrc).not.toContain('button("✨ Auto Generate"');
    expect(nodeCustomerSectionSrc).not.toContain('button("📊 Estimate Difficulty"');
    expect(nodeCustomerSectionSrc).not.toContain('button("▶ Replay Estimate"');

    const auto = nodeDesignSrc.indexOf('button("✨ Auto Generate"');
    const estimate = nodeDesignSrc.indexOf('button("📊 Estimate Difficulty"');
    const solvable = nodeDesignSrc.indexOf('button("✓ Check Solvable"');
    const addLevel = nodeDesignSrc.indexOf('button("+ Level"');
    expect(auto).toBeGreaterThan(-1);
    expect(auto).toBeLessThan(estimate);
    expect(estimate).toBeLessThan(solvable);
    expect(solvable).toBeLessThan(addLevel);
  });

  it("keeps separate replays for estimate and solvability runs", () => {
    expect(nodeDesignSrc).not.toContain('button("▶ Replay Estimate"');
    expect(nodeDesignSrc).not.toContain('button("▶ Replay Solvable"');
    expect(analysisFoldoutSrc).toContain('button("▶ Replay"');
    expect(nodeDesignSrc).toContain("() => this.replayEstimate()");
    expect(nodeDesignSrc).toContain("() => this.replaySolvability()");
    expect(nodeDesignSrc).toContain('"Solvability Check Replay"');
  });

  it("renders independent page-level graph foldouts between warnings and the layout", () => {
    expect(analysisFoldoutSrc).toContain('kind === "solvability" ? "Check Solvable" : "Estimate Difficulty"');
    expect(nodeCustomerSectionSrc).not.toContain("occupancyChartEl(");

    const warnings = nodeDesignSrc.indexOf("this.warningsEl,");
    const foldouts = nodeDesignSrc.indexOf("this.analysisFoldouts(),");
    const layout = nodeDesignSrc.indexOf('this.layoutMode === "split"');
    expect(warnings).toBeGreaterThan(-1);
    expect(warnings).toBeLessThan(foldouts);
    expect(foldouts).toBeLessThan(layout);
  });

  it("treats customer timeout as a warning, not a solvability failure", () => {
    expect(checkSolvableSrc).toContain('informationMode: "omniscient"');
    expect(checkSolvableSrc).not.toContain("requireNoTimeout");
    expect(analysisFoldoutSrc).toContain("Solvability ignores customer patience");
  });
});

describe("Level Path validation", () => {
  it("uses the omniscient solvability checker instead of player estimation", () => {
    expect(validateLevelSrc).toContain("checkNodeSolvable(");
    expect(validateLevelSrc).not.toContain("estimateNodeDifficulty(");
    expect(levelPathSrc).toContain("solvabilityCacheKey(");
  });
});
