import { describe, expect, it } from "vitest";
import {
  coverageFromLegacyCounts,
  emptySharedObstacleCoverage,
  materializeObstacleCoverage,
} from "./sharedGenerationProfile.ts";
import { emptyObstacles } from "../ui/levelpath/obstacles.ts";

describe("shared generator obstacle coverage", () => {
  it("materializes each category against its own basis and caps the grid at 50%", () => {
    const profile = emptySharedObstacleCoverage();
    profile.grid.blocked = 0.3;
    profile.grid.orderLock = 0.3;
    profile.grid.lockAndKey = 0.2;
    profile.queue.hidden = 0.25;
    profile.queue.combinedBySize[4] = 0.4;
    profile.customer.timed = 0.5;
    profile.customer.boss = 1;
    const result = materializeObstacleCoverage(profile, {
      gridCells: 20,
      queueSlots: 40,
      orderingCustomers: 6,
    });
    expect(result.config.grid.blocked).toBe(6);
    expect(result.config.grid.orderLock).toBe(4);
    expect(result.config.lockAndKey).toBe(0);
    expect(result.config.queue.hidden).toBe(10);
    expect(result.combinedGroupsBySize[4]).toBe(4);
    expect(result.config.customer.timed).toBe(3);
    expect(result.config.customer.boss).toBe(1);
    expect(result.warnings.join(" ")).toContain("50%");
  });

  it("does not invent a group-size distribution while migrating legacy counts", () => {
    const legacy = emptyObstacles();
    legacy.queue.combined = 2;
    const migrated = coverageFromLegacyCounts(legacy, {
      gridCells: 16,
      queueSlots: 20,
      orderingCustomers: 4,
    });
    expect(migrated.profile.queue.combinedBySize).toEqual({ 2: 0, 3: 0, 4: 0, 5: 0 });
    expect(migrated.warnings[0]).toContain("no recoverable size distribution");
  });

  it("handles missing preview bases without division errors", () => {
    const profile = emptySharedObstacleCoverage();
    profile.queue.hidden = 0.5;
    profile.customer.shipper = 0.5;
    const result = materializeObstacleCoverage(profile, { gridCells: 0, queueSlots: 0, orderingCustomers: 0 });
    expect(result.config.queue.hidden).toBe(0);
    expect(result.config.customer.shipper).toBe(0);
  });
});
