// Which generator the queue section's Auto Generate button actually calls.
//
// This is a WIRING test, and it reads source text rather than running code —
// unusual, and worth justifying. The bug it exists to prevent was not in any
// function: `nodePickupSequence` was correct and unit-tested, but node Design
// reuses the LEGACY queue section, whose own "✨ Auto Generate" button went
// straight to `generateQueueLanes`. Only the chained call from the customer
// generator had been rerouted. So the queue kept coming out with one input per
// recipe — ground coffee and no cups — while every unit test passed.
//
// Exercising the button for real needs a rendered section, and this suite runs
// without jsdom. The seam is one call site and one deps key; asserting on those
// two lines is cheap and would have caught it. If the section ever grows a
// proper injection point, delete this in favour of driving it.

import { describe, expect, it } from "vitest";
import queueSectionSrc from "../design/queueSection.ts?raw";
import nodeDesignSrc from "./index.ts?raw";
import generateLevelSrc from "../levelpath/generateLevel.ts?raw";
import generateDialogSrc from "./nodeGenerateDialog.ts?raw";

describe("the queue section's generator is swappable", () => {
  it("runAutoGenerate prefers deps.generateLanes over the legacy generator", () => {
    expect(queueSectionSrc).toContain("deps.generateLanes");
    // The legacy path must still be there — omitting generateLanes has to leave
    // legacy Design behaving exactly as before.
    expect(queueSectionSrc).toContain("generateQueueLanes({");
  });

  it("declares generateLanes as optional, so legacy Design needs no change", () => {
    expect(queueSectionSrc).toMatch(/generateLanes\?\(/);
  });
});

describe("node Design supplies its own generator", () => {
  it("passes generateLanes in the queue deps", () => {
    // In queueDeps, not the customer section's — a wrong-object placement
    // typechecks against neither, but this pins the intent.
    expect(nodeDesignSrc).toMatch(/generateLanes:\s*\(laneCount, shuffleRange\)/);
    expect(nodeDesignSrc).toContain("generateNodeQueueLanes({");
  });

  it("supplies graph-aware Recipe Pieces demand", () => {
    expect(queueSectionSrc).toMatch(/recipeDemand\?\(\)/);
    expect(nodeDesignSrc).toContain("recipeDemand: () =>");
    expect(nodeDesignSrc).toContain("nodeDemandByRaw(");
  });

  it("has no private copy of the section's generate path", () => {
    expect(nodeDesignSrc).not.toContain("private autoGenerateQueue");
  });
});

// The second entry point used to be a chained call into the queue section's own
// Auto Generate. It is now the whole-level pipeline, which builds the queue
// itself so it can verify the customers and their queue TOGETHER — a level is
// winnable or not as one thing, and two independently-successful halves were
// exactly how an unwinnable level got produced.
//
// The invariant that mattered has not changed: whichever path builds the queue
// for generated customers must be the graph-aware one, not the legacy
// one-input-per-recipe generator. Only the seam it lives on has moved.
describe("Auto Generate builds the whole level through the shared pipeline", () => {
  it("Design's dialog runs the pipeline rather than customers alone", () => {
    // Matched loosely on purpose: this pins WHICH function the dialog calls,
    // not how the call happens to be wrapped.
    expect(generateDialogSrc).toMatch(/generateLevel\(\s*deps\.level,/);
    expect(generateDialogSrc).not.toContain("startQueueAutoGenerate");
  });

  it("the pipeline queues with the graph-aware generator", () => {
    expect(generateLevelSrc).toContain("generateNodeQueueLanes({");
    expect(generateLevelSrc).not.toContain("generateQueueLanes({");
  });

  it("the pipeline verifies each build with the estimator before accepting it", () => {
    expect(generateLevelSrc).toContain("estimateNodeDifficulty(");
    expect(generateLevelSrc).toContain("estimate.solvable");
  });
});
