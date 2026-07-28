import { describe, expect, it } from "vitest";
import { MAP1_DATA } from "./initialData.ts";
import { definitionsCsv, levelsCsv } from "./sheetSource.ts";

describe("CSV export (the tool's save path)", () => {
  it("writes one levels row per level with the canonical strings intact", () => {
    const csv = levelsCsv(MAP1_DATA);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(MAP1_DATA.levels.length + 1);
    expect(lines[0]).toContain("QueueString");
    // Level 1_11's ColorLock grid survives the round trip through CSV quoting.
    const l11 = lines[11];
    expect(l11).toContain('",,#4:1:1,,,,,#4:4:1,,"');
  });

  it("writes the definition tables", () => {
    const csv = definitionsCsv(MAP1_DATA);
    expect(csv).toContain("-- Raw Ingredients --");
    expect(csv).toContain("burger_bun_raw");
    expect(csv).toContain("-- Cook Mappings --");
  });
});
