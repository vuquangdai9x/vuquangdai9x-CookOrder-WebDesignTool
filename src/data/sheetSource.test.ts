import { describe, expect, it } from "vitest";
import { MAP1_DATA } from "./configLoader.ts";
import { columnLetter, importLevelsCsv, letterToColumn, levelsCsv, parseCsv } from "./sheetSource.ts";

describe("CSV export (level data only — no map/ingredient/tool definitions)", () => {
  it("writes one levels row per level with the canonical strings intact", () => {
    const csv = levelsCsv(MAP1_DATA);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(MAP1_DATA.levels.length + 1);
    expect(lines[0]).toContain("QueueString");
    expect(lines[0]).not.toContain("GridWidth");
    // A level with grid effects (commas + "#") survives the round trip through CSV quoting.
    const levelWithEffect = MAP1_DATA.levels.find((l) => l.gridString.includes("#"));
    expect(levelWithEffect).toBeDefined();
    const rowIndex = MAP1_DATA.levels.indexOf(levelWithEffect!) + 1; // +1 for header row
    const parsedRow = parseCsv(lines[rowIndex])[0];
    expect(parsedRow[8]).toBe(levelWithEffect!.gridString); // GridString column
  });

  it("does not contain any definition tables", () => {
    const csv = levelsCsv(MAP1_DATA);
    expect(csv).not.toContain("-- Raw Ingredients --");
    expect(csv).not.toContain("-- Cooking Tools --");
  });
});

describe("parseCsv", () => {
  it("splits plain rows on commas", () => {
    expect(parseCsv("a,b,c\r\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with embedded commas and escaped quotes", () => {
    const text = 'a,"b,c","d""e"\r\n1,2,3';
    expect(parseCsv(text)).toEqual([
      ["a", "b,c", 'd"e'],
      ["1", "2", "3"],
    ]);
  });

  it("tolerates a trailing newline without adding an empty row", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("CSV import", () => {
  it("round-trips every level through export then import", () => {
    const csv = levelsCsv(MAP1_DATA);
    const imported = importLevelsCsv(csv);
    expect(imported).toEqual(MAP1_DATA.levels);
  });

  it("restores optional OutOfSlotPolicy and BoosterCharges columns", () => {
    const csv = [
      "Level_ID,Name,Weather,LevelTag,FeatureUnlock,ShuffleDistance,ServeableSlots,QueueString,GridString,CustomerString,OutOfSlotPolicy,BoosterCharges",
      '1,test,Normal,,,0,2,"0,1",",,,,,,,,,",0;0;1,park-on-grid,3|3|2|3',
    ].join("\r\n");
    const [level] = importLevelsCsv(csv);
    expect(level.outOfSlotPolicy).toBe("park-on-grid");
    expect(level.boosterCharges).toEqual([3, 3, 2, 3]);
  });

  it("accepts a CSV with no header row", () => {
    const csv = '1,test,Normal,,,0,2,"0,1",",,,,,,,,,",0;0;1,,';
    const imported = importLevelsCsv(csv);
    expect(imported).toHaveLength(1);
    expect(imported[0].name).toBe("test");
  });

  it("throws a clear error on a missing/invalid Level_ID", () => {
    const csv = "Level_ID,Name\r\n,oops";
    expect(() => importLevelsCsv(csv)).toThrow(/Level_ID/);
  });

  it("throws on an empty file", () => {
    expect(() => importLevelsCsv("")).toThrow();
  });
});

describe("columnLetter / letterToColumn", () => {
  it("round-trips single and multi-letter columns", () => {
    for (const [index, letter] of [[0, "A"], [3, "D"], [17, "R"], [25, "Z"], [26, "AA"], [51, "AZ"]] as const) {
      expect(columnLetter(index)).toBe(letter);
      expect(letterToColumn(letter)).toBe(index);
    }
  });

  it("letterToColumn is case-insensitive and tolerates surrounding whitespace", () => {
    expect(letterToColumn(" d ")).toBe(3);
    expect(letterToColumn("r")).toBe(17);
  });

  it("letterToColumn returns -1 for non-letter or empty input", () => {
    expect(letterToColumn("")).toBe(-1);
    expect(letterToColumn("1")).toBe(-1);
    expect(letterToColumn("D1")).toBe(-1);
  });
});
