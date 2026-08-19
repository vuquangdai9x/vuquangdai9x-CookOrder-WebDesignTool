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

  it("routes BOTH entry points through the section, not a private copy", () => {
    // The chained call from the customer generator goes through the same
    // startQueueAutoGenerate the button uses, so there is one path to keep
    // right rather than two that can drift.
    expect(nodeDesignSrc).toContain("startQueueAutoGenerate(this.queues, this.queueDeps, true)");
    expect(nodeDesignSrc).not.toContain("private autoGenerateQueue");
  });
});
