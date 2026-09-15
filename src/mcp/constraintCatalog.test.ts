import { describe, expect, it } from "vitest";
import { constraintMetric, listConstraintMetrics } from "./constraintCatalog.ts";

describe("constraint catalog", () => {
  it("exposes production amount and queue-only deadlock metrics", () => {
    expect(constraintMetric("amount.atomicDestinationBlockRate")?.repairFamilies).toContain("amount-split");
    expect(constraintMetric("queue.pickingOrderStuckRate")?.description).toMatch(/grid state is excluded/i);
    expect(listConstraintMetrics("amount").every((metric) => metric.dimension === "amount")).toBe(true);
  });
});
