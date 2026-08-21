import { describe, expect, it } from "vitest";
import burgerLevelsCsv from "./config/nodegraph/maps/LevelData-1-Burger.csv?raw";
import {
  columnLetter,
  importLevelsCsv,
  letterToColumn,
  levelsCsv,
  parseCsv,
  parseLevelProgressRows,
  REMOTE_SHEET_COLUMNS,
} from "./sheetSource.ts";

/** Committed graph-native level data — the CSV the app itself loads, not a derived fixture. */
const burgerLevels = { levels: importLevelsCsv(burgerLevelsCsv) };

describe("CSV export (level data only — no map/ingredient/tool definitions)", () => {
  it("writes one levels row per level with the canonical strings intact", () => {
    const csv = levelsCsv(burgerLevels);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(burgerLevels.levels.length + 1);
    expect(lines[0]).toContain("QueueString");
    expect(lines[0]).not.toContain("GridWidth");
    // A level with grid effects (commas + "#") survives the round trip through CSV quoting.
    const levelWithEffect = burgerLevels.levels.find((l) => l.gridString.includes("#"));
    expect(levelWithEffect).toBeDefined();
    const rowIndex = burgerLevels.levels.indexOf(levelWithEffect!) + 1; // +1 for header row
    const parsedRow = parseCsv(lines[rowIndex])[0];
    expect(parsedRow[8]).toBe(levelWithEffect!.gridString); // GridString column
  });

  it("does not contain any definition tables", () => {
    const csv = levelsCsv(burgerLevels);
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
    const csv = levelsCsv(burgerLevels);
    const imported = importLevelsCsv(csv);
    expect(imported).toEqual(burgerLevels.levels);
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

describe("MapLevelProgress row schema", () => {
  const dataRow = (map: string, level: string, suffix: string): string[] => {
    const row = new Array<string>(38).fill("");
    row[0] = map;
    row[1] = level;
    row[3] = `weights-${suffix}`;
    row[4] = `sequence-${suffix}`;
    row[5] = `complexity-${suffix}`;
    row[6] = `shuffle-${suffix}`;
    row[15] = `customers-${suffix}`;
    row[16] = `grid-${suffix}`;
    row[17] = `queues-${suffix}`;
    return row;
  };

  it("skips the three heading rows and preserves physical row numbers", () => {
    const rows = [
      ["Map Level Progress"],
      ["", "", "", "Design Config"],
      ["Map", "Level", "ID", "Ingredient Weights"],
      dataRow("1", "1", "burger"),
    ];
    const parsed = parseLevelProgressRows(rows, REMOTE_SHEET_COLUMNS, 4);
    expect(parsed.get("map_config_burger_lv_1")).toEqual({
      rowNumber: 4,
      mapId: "burger",
      level: 1,
      fields: {
        ingredientWeights: "weights-burger",
        customerDishesSequence: "sequence-burger",
        complexityCurve: "complexity-burger",
        shuffleCurve: "shuffle-burger",
        customerString: "customers-burger",
        gridString: "grid-burger",
        queueString: "queues-burger",
      },
    });
  });

  it("maps sheet indexes 2 and 3 onto the node graphs coffee and sushi", () => {
    const rows = [
      ["Map Level Progress"],
      ["", "", "", "Design Config"],
      ["Map", "Level", "ID", "Ingredient Weights"],
      ...new Array<string[]>(25).fill([]),
      dataRow("2", "1", "coffee"), // physical row 29
      ...new Array<string[]>(24).fill([]),
      dataRow("3", "1", "sushi"), // physical row 54
    ];
    const parsed = parseLevelProgressRows(rows, REMOTE_SHEET_COLUMNS, 4, {
      1: "burger",
      2: "coffee",
      3: "sushi",
    });
    expect(parsed.get("map_config_coffee_lv_1")?.rowNumber).toBe(29);
    expect(parsed.get("map_config_sushi_lv_1")?.rowNumber).toBe(54);
    expect(parsed.has("map_config_donut_lv_1")).toBe(false);
  });

  it("uses Map and Level cells instead of assuming contiguous map ranges", () => {
    const rows = [
      ["Map Level Progress"],
      ["", "", "", "Design Config"],
      ["Map", "Level", "ID", "Ingredient Weights"],
      dataRow("3", "42", "sushi-42"),
      dataRow("2", "7", "coffee-7"),
      dataRow("3", "3", "sushi-3"),
      dataRow("2", "120", "coffee-120"),
    ];
    const parsed = parseLevelProgressRows(rows, REMOTE_SHEET_COLUMNS, 4, { 2: "coffee", 3: "sushi" });
    expect([...parsed.values()].map((row) => [row.rowNumber, row.mapId, row.level])).toEqual([
      [4, "sushi", 42],
      [5, "coffee", 7],
      [6, "sushi", 3],
      [7, "coffee", 120],
    ]);
  });
});
