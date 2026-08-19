import { describe, expect, it } from "vitest";

import type { LevelData } from "./mapLoader.ts";
import { idTablesAreReorders, migrateLevelsForIdTableReorder } from "./nodeIdMigration.ts";
import type { IdTable } from "./nodeGraphTypes.ts";

const before: IdTable = {
  ingredient: ["rice", "salmon", "nori"],
  composite: ["nigiri", "roll"],
  group: ["fish", "filling"],
  tool: ["knife"],
  dirty: [],
};

const after: IdTable = {
  ingredient: ["nori", "rice", "salmon"],
  composite: ["roll", "nigiri"],
  group: ["filling", "fish"],
  tool: ["knife"],
  dirty: [],
};

function level(overrides: Partial<LevelData> = {}): LevelData {
  return {
    id: 7,
    name: "Sushi 7",
    weather: "",
    levelTag: "",
    featureUnlock: "",
    serveableSlots: 1,
    shuffleDistance: 0,
    queueString: "0#4:5,-1,2%1$0-0,0-1$",
    gridString: "",
    customerString: "0;30;0;{c0:0.{g0:1.2}},{c1:{g1:2}.0}#4:8;2",
    ...overrides,
  };
}

describe("ID-table level migration", () => {
  it("remaps queue and recursive customer IDs without touching other numbers", () => {
    const input = level();
    const result = migrateLevelsForIdTableReorder([input], before, after);

    expect(result.levels[0].queueString).toBe("1#4:5,-1,0%2$0-0,0-1$");
    expect(result.levels[0].customerString).toBe(
      "0;30;0;{c1:1.{g1:2.0}},{c0:{g0:0}.1}#4:8;2",
    );
    expect(result).toMatchObject({
      changedLevels: 1,
      changedQueueReferences: 3,
      changedCustomerReferences: 9,
    });
    expect(input.queueString).toBe("0#4:5,-1,2%1$0-0,0-1$");

    const undone = migrateLevelsForIdTableReorder(result.levels, after, before);
    expect(undone.levels[0].queueString).toBe(input.queueString);
    expect(undone.levels[0].customerString).toBe(input.customerString);
  });

  it("recognizes only pure reorders", () => {
    expect(idTablesAreReorders(before, after)).toBe(true);
    expect(idTablesAreReorders(before, { ...after, ingredient: ["nori", "rice"] })).toBe(false);
  });

  it("aborts atomically and names a malformed level", () => {
    expect(() => migrateLevelsForIdTableReorder([level({ customerString: "broken" })], before, after)).toThrow(
      'Cannot migrate level "Sushi 7" (id 7)',
    );
  });
});
