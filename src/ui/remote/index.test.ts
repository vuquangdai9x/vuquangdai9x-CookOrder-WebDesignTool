import { describe, expect, it } from "vitest";
import { diffChars } from "./index.ts";

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
