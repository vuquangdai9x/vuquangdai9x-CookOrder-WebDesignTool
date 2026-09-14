import { describe, expect, it } from "vitest";
import { isOldQueueString, migrateQueueString } from "./bagMigration.ts";

const lookup = { multipliers: { "2": 2, "5": 3 } };

describe("bag migration of old queue strings", () => {
  it("detects an old string only when it has ingredient slots and none carries an amount", () => {
    expect(isOldQueueString("2,0%5#1:2")).toBe(true);
    expect(isOldQueueString("2:2,0%5")).toBe(false);
    expect(isOldQueueString("%%")).toBe(false);
    expect(isOldQueueString("-1")).toBe(false);
  });

  it("stamps the former multiplier on matching slots, keeping effects and groups", () => {
    expect(migrateQueueString("2,0,5#1:2%-1,2$0-0,1-0$", lookup)).toBe("2:2,0,5:3#1:2%-1,2:2$0-0,1-0$");
  });

  it("leaves migrated or unmatched strings untouched", () => {
    expect(migrateQueueString("2:2,0", lookup)).toBe("2:2,0");
    expect(migrateQueueString("0,1", lookup)).toBe("0,1");
  });
});
