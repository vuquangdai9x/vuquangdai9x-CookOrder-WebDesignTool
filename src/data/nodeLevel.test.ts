import { describe, expect, it } from "vitest";
import { getCustomerCatalog } from "./customerCatalog.ts";
import type { LevelData } from "./mapLoader.ts";
import { toNodeLevelConfig } from "./nodeLevel.ts";

describe("node level runtime customer identity", () => {
  it("marks a pinned Type=Boss catalog customer without changing the level string", () => {
    const boss = getCustomerCatalog().find((entry) => entry.type.trim().toLowerCase() === "boss");
    expect(boss).toBeDefined();
    const level = {
      id: 1,
      name: "boss test",
      weather: "Normal",
      levelTag: "",
      featureUnlock: "",
      shuffleDistance: 0,
      serveableSlots: 3,
      queueString: "0",
      gridString: ",,,,,,,,,",
      customerString: `0;0;0;{c0:0};;${boss!.index}`,
    } as LevelData;

    const converted = toNodeLevelConfig(level);

    expect(converted.customers[0].isBoss).toBe(true);
    expect(level.customerString).toBe(`0;0;0;{c0:0};;${boss!.index}`);
  });
});
