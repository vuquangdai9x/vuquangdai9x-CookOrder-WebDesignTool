import { describe, expect, it } from "vitest";
import { diffChars, levelSyncStatus, remoteLevelIds } from "./index.ts";
import type { LevelData } from "../../data/mapLoader.ts";

/** Reconstructs newStr from the segments, and reconstructs which chars were "changed". */
function apply(segments: { text: string; changed: boolean }[]) {
  return {
    text: segments.map((s) => s.text).join(""),
    changedMask: segments.flatMap((s) => Array(s.text.length).fill(s.changed)),
  };
}

describe("diffChars", () => {
  it("marks nothing changed when the strings are identical", () => {
    const segs = diffChars("abc", "abc");
    expect(apply(segs)).toEqual({ text: "abc", changedMask: [false, false, false] });
  });

  it("always reconstructs newStr exactly, regardless of oldStr", () => {
    const cases: [string, string][] = [
      ["", ""],
      ["", "abc"],
      ["abc", ""],
      ["abc", "abd"],
      ["0;0;0;1.0|0;0;0;7", "0;0;0;1.0.2|0;0;0;7"],
      ["hello world", "world hello"],
    ];
    for (const [oldStr, newStr] of cases) {
      expect(apply(diffChars(oldStr, newStr)).text).toBe(newStr);
    }
  });

  it("flags an inserted character as changed, leaves the rest unmarked", () => {
    const segs = diffChars("ac", "abc");
    expect(apply(segs)).toEqual({ text: "abc", changedMask: [false, true, false] });
  });

  it("flags a changed character (substitution) as changed", () => {
    const segs = diffChars("abc", "abx");
    const { text, changedMask } = apply(segs);
    expect(text).toBe("abx");
    expect(changedMask).toEqual([false, false, true]);
  });

  it("flags every character as changed when the strings share nothing", () => {
    const segs = diffChars("123", "xyz");
    expect(apply(segs)).toEqual({ text: "xyz", changedMask: [true, true, true] });
  });

  it("marks nothing changed when newStr is a pure deletion from oldStr", () => {
    const segs = diffChars("abcdef", "ace");
    expect(apply(segs)).toEqual({ text: "ace", changedMask: [false, false, false] });
  });

  it("detects a single renumbered id inside an otherwise-identical level string", () => {
    // Mirrors the real use case: map1's cooked-id renumber changed "9.14" to "10.16".
    const sheet = "0;0;0;9.14|0;0;0;1.0.3";
    const tool = "0;0;0;10.16|0;0;0;1.0.3";
    const { text } = apply(diffChars(sheet, tool));
    expect(text).toBe(tool);
  });
});

describe("levelSyncStatus", () => {
  const level = {
    ingredientWeights: "1,2",
    customerDishesSequence: "0,0,0",
    complexityCurve: "1",
    shuffleCurve: "0",
    customerString: "customer",
    gridString: "grid",
    queueString: "queue",
  } as LevelData;
  const matching = {
    rowNumber: 4,
    mapId: "burger",
    level: 1,
    fields: {
      ingredientWeights: "1,2",
      customerDishesSequence: "0,0,0",
      complexityCurve: "1",
      shuffleCurve: "0",
      customerString: "customer",
      gridString: "grid",
      queueString: "queue",
    },
  };

  it("is Local until sheet data is loaded", () => {
    expect(levelSyncStatus(false, matching, level)).toBe("Local");
  });

  it("is Synced only when every remote field is identical", () => {
    expect(levelSyncStatus(true, matching, level)).toBe("Synced");
  });

  it("is Edited for a missing or differing sheet row", () => {
    expect(levelSyncStatus(true, null, level)).toBe("Edited");
    expect(levelSyncStatus(true, { ...matching, fields: { ...matching.fields, queueString: "changed" } }, level)).toBe("Edited");
  });
});

describe("remoteLevelIds", () => {
  it("derives sparse and reordered level ids from each row's Map and Level cells", () => {
    const rows = [
      { rowNumber: 4, mapId: "sushi", level: 42, fields: {} },
      { rowNumber: 5, mapId: "coffee", level: 7, fields: {} },
      { rowNumber: 6, mapId: "sushi", level: 3, fields: {} },
      { rowNumber: 7, mapId: "coffee", level: 120, fields: {} },
    ];
    expect(remoteLevelIds("coffee", [1], rows)).toEqual([1, 7, 120]);
    expect(remoteLevelIds("sushi", [], rows)).toEqual([3, 42]);
  });
});
