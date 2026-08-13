import { describe, expect, it } from "vitest";
import { parseLevelSnapshot } from "./levelSnapshot.ts";

// Column layout mirrors config/general/level-data-snapshot-schema.json:
// A=map B=level D=ingredientWeights E=customerDishesSequence F=complexityCurve
// G=shuffleCurve H=designNote I=weather J=tag P=customerString Q=gridString R=queueString
// startRow=4, so rows 1-3 (indices 0-2) are always title/category/header rows.
function row(fields: Partial<{
  map: string;
  level: string;
  ingredientWeights: string;
  customerDishesSequence: string;
  complexityCurve: string;
  shuffleCurve: string;
  designNote: string;
  weather: string;
  tag: string;
  customerString: string;
  gridString: string;
  queueString: string;
}>): string[] {
  const cells = new Array(18).fill("");
  cells[0] = fields.map ?? "";
  cells[1] = fields.level ?? "";
  cells[3] = fields.ingredientWeights ?? "";
  cells[4] = fields.customerDishesSequence ?? "";
  cells[5] = fields.complexityCurve ?? "";
  cells[6] = fields.shuffleCurve ?? "";
  cells[7] = fields.designNote ?? "";
  cells[8] = fields.weather ?? "";
  cells[9] = fields.tag ?? "";
  cells[15] = fields.customerString ?? "";
  cells[16] = fields.gridString ?? "";
  cells[17] = fields.queueString ?? "";
  return cells;
}

function csvEscape(v: string): string {
  return /["\n,]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function csv(dataRows: string[][]): string {
  const header = [["Title"], ["Category"], ["Header"]];
  return [...header, ...dataRows].map((r) => r.map(csvEscape).join(",")).join("\n");
}

describe("parseLevelSnapshot", () => {
  it("skips rows above startRow even if they look data-ready", () => {
    const bogus = row({ map: "burger", level: "1", customerString: "0;0;0;1" });
    const text = [bogus.join(","), bogus.join(","), bogus.join(",")].join("\n"); // only 3 rows, all before startRow=4
    const byMap = parseLevelSnapshot(text);
    expect(byMap.get("burger")).toBeUndefined();
  });

  it("skips a row whose Level column is not a positive integer", () => {
    const text = csv([
      row({ map: "burger", level: "", customerString: "0;0;0;1" }),
      row({ map: "burger", level: "abc", customerString: "0;0;0;1" }),
      row({ map: "burger", level: "0", customerString: "0;0;0;1" }),
      row({ map: "burger", level: "-1", customerString: "0;0;0;1" }),
    ]);
    expect(parseLevelSnapshot(text).get("burger")).toBeUndefined();
  });

  it("skips a row whose Map column doesn't match a known map", () => {
    const text = csv([row({ map: "pizza", level: "1", customerString: "0;0;0;1" })]);
    expect(parseLevelSnapshot(text).size).toBe(0);
  });

  it("resolves the Map column by numeric index as well as by string id", () => {
    const text = csv([
      row({ map: "2", level: "1", customerString: "0;0;0;1" }),
      row({ map: "DONUT", level: "2", customerString: "0;0;0;1" }),
    ]);
    const donut = parseLevelSnapshot(text).get("donut");
    expect(donut).toHaveLength(2);
    expect(donut?.map((l) => l.id)).toEqual([1, 2]);
  });

  it("skips a row whose Customers column is blank (not yet authored)", () => {
    const text = csv([
      row({ map: "burger", level: "1", customerString: "" }),
      row({ map: "burger", level: "2", customerString: "   " }),
    ]);
    expect(parseLevelSnapshot(text).get("burger")).toBeUndefined();
  });

  it("only sets the 4 generator fields + designNote when their cells are non-blank", () => {
    const text = csv([row({ map: "burger", level: "1", customerString: "0;0;0;1" })]);
    const [level] = parseLevelSnapshot(text).get("burger")!;
    expect(level.ingredientWeights).toBeUndefined();
    expect(level.customerDishesSequence).toBeUndefined();
    expect(level.complexityCurve).toBeUndefined();
    expect(level.shuffleCurve).toBeUndefined();
    expect(level.designNote).toBeUndefined();
  });

  it("captures all fields when populated and groups+sorts levels per map by level id", () => {
    const text = csv([
      row({
        map: "burger",
        level: "2",
        ingredientWeights: "0:100",
        customerDishesSequence: "1;2",
        complexityCurve: '{"a":1}',
        shuffleCurve: '{"b":2}',
        designNote: "note for level 2",
        weather: "Rainy",
        tag: "Hard",
        customerString: "0;0;0;1",
        gridString: ",,,",
        queueString: "0,1$",
      }),
      row({ map: "burger", level: "1", customerString: "0;0;0;2" }),
    ]);
    const levels = parseLevelSnapshot(text).get("burger")!;
    expect(levels.map((l) => l.id)).toEqual([1, 2]);

    const l2 = levels[1];
    expect(l2.name).toBe("burger_2");
    expect(l2.weather).toBe("Rainy");
    expect(l2.levelTag).toBe("Hard");
    expect(l2.ingredientWeights).toBe("0:100");
    expect(l2.customerDishesSequence).toBe("1;2");
    expect(l2.complexityCurve).toBe('{"a":1}');
    expect(l2.shuffleCurve).toBe('{"b":2}');
    expect(l2.designNote).toBe("note for level 2");
    expect(l2.queueString).toBe("0,1$");
    expect(l2.gridString).toBe(",,,");
  });

  it("defaults a blank Weather cell to Normal", () => {
    const text = csv([row({ map: "burger", level: "1", customerString: "0;0;0;1" })]);
    const [level] = parseLevelSnapshot(text).get("burger")!;
    expect(level.weather).toBe("Normal");
  });
});
