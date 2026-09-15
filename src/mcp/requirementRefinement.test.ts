import { describe, expect, it } from "vitest";
import { productionBehaviorEvidence } from "./productionBehavior.ts";

describe("production behavior contract", () => {
  it("is fixed to the real-game defaults", () => {
    expect(productionBehaviorEvidence()).toEqual({
      packingMode: "unpacked-raw",
      toolProcessBehavior: "auto",
      outOfSlotPolicy: "park-on-grid",
      semanticsVersion: "2026-09-15-default-v1",
    });
  });
});
