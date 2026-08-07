import { describe, expect, it } from "vitest";
import { MAP1_DATA } from "./configLoader.ts";
import { definitionsCsv, levelsCsv } from "./sheetSource.ts";

describe("CSV export (the tool's save path)", () => {
  it("writes one levels row per level with the canonical strings intact", () => {
    const csv = levelsCsv(MAP1_DATA);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(MAP1_DATA.levels.length + 1);
    expect(lines[0]).toContain("QueueString");
    // Level 1_3's grid effects survive the round trip through CSV quoting.
    const l3 = lines[3];
    expect(l3).toContain('",,,,,#1,,,,#1"');
  });

  it("writes the definition tables", () => {
    const csv = definitionsCsv(MAP1_DATA);
    expect(csv).toContain("-- Raw Ingredients --");
    expect(csv).toContain("burger_bun_raw");
    expect(csv).toContain("-- Cooking Tools --");
    // Recipes round-trip in the "in>out xN" shorthand the table editor parses.
    expect(csv).toContain("0>0x1; 2>2x2");
  });
});
