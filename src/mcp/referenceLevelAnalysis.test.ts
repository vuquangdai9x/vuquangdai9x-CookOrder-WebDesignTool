import { describe, expect, it } from "vitest";
import type { LevelData } from "../data/mapLoader.ts";
import { analyzeReferenceDataset, compareQueueToReferences } from "./referenceLevelAnalysis.ts";

const level = (id: number, queueString: string): LevelData => ({
  id,
  name: `Level ${id}`,
  weather: "Normal",
  levelTag: "Normal",
  featureUnlock: "",
  serveableSlots: 2,
  shuffleDistance: 0,
  queueString,
  gridString: ",,,,,,,,,",
  customerString: "customer",
});

describe("reference level analysis", () => {
  const dataset = {
    sourceFile: "LevelData-test.csv",
    sourceHash: "abc",
    levels: [
      level(1, "1,2,3%2,3,1"),
      level(2, "1:2,3,2%2,1,3"),
      level(3, "3,1,2:2%1,2,3"),
      level(20, "1,1,1%1,1,1"),
    ],
  };

  it("builds a progression-local style cohort and amount recommendation", () => {
    const analysis = analyzeReferenceDataset("test", dataset, { targetLevel: 2, cohortRadius: 2 });
    expect(analysis.cohort.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(analysis.recommendedTargets.amountStyle).toBe("balanced");
    expect(analysis.referenceProfileId).toMatch(/^reference-/);
    expect(analysis.envelope.sampleCount).toBe(3);
  });

  it("reports style fit separately from nearest sequence similarity", () => {
    const analysis = analyzeReferenceDataset("test", dataset, { levelMin: 1, levelMax: 3 });
    const comparison = compareQueueToReferences("1,2,3%2,3,1", dataset, analysis);
    expect(comparison.nearestReferenceLevelId).toBe(1);
    expect(comparison.nearestReferenceSimilarity).toBe(1);
    expect(comparison.referenceStyleDistance).toBeLessThan(0.5);
  });
});
