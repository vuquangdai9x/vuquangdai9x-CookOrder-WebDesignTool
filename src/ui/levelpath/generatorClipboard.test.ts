import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LevelData } from "../../data/mapLoader.ts";
import {
  canPasteAll,
  canPasteField,
  clearClipboard,
  clipboard,
  copyAll,
  copyField,
  pasteAll,
  pasteField,
} from "./generatorClipboard.ts";

// The module mirrors copies to the system clipboard best-effort; there is none
// under Vitest's node environment, and its absence must not break copy.
vi.stubGlobal("navigator", {});

function level(overrides: Partial<LevelData> = {}): LevelData {
  return {
    id: 1,
    name: "src",
    weather: "Normal",
    levelTag: "",
    featureUnlock: "",
    serveableSlots: 2,
    shuffleDistance: 0,
    queueString: "%%",
    gridString: "",
    customerString: "",
    ...overrides,
  };
}

beforeEach(() => clearClipboard());

describe("copying one field", () => {
  it("carries that field and only that field", () => {
    copyField(level({ ingredientWeights: "3:100", complexityCurve: "{}" }), "weights");
    expect(canPasteField("weights")).toBe(true);
    expect(canPasteField("complexity")).toBe(false);
  });

  it("pastes onto another level", () => {
    copyField(level({ ingredientWeights: "3:100" }), "weights");
    const target = level({ name: "dst" });
    expect(pasteField(target, "weights")).toBe(true);
    expect(target.ingredientWeights).toBe("3:100");
  });

  it("carries UNSET as unset, not as an empty string", () => {
    // Copying a blank field and pasting it should blank the target too — and
    // "" is not a value the pipeline understands, it checks for absence.
    copyField(level(), "weights");
    const target = level({ ingredientWeights: "3:100" });
    expect(pasteField(target, "weights")).toBe(true);
    expect(target.ingredientWeights).toBeUndefined();
  });

  it("does nothing when the clipboard holds a different field", () => {
    copyField(level({ shuffleCurve: "{}" }), "shuffle");
    const target = level();
    expect(pasteField(target, "weights")).toBe(false);
    expect(target.ingredientWeights).toBeUndefined();
  });

  it("remembers where it came from, for the menu label", () => {
    copyField(level({ name: "1_7", obstacleData: "boss=1" }), "obstacles");
    expect(clipboard()?.source).toBe("1_7");
  });
});

describe("copying a whole level", () => {
  const source = level({
    name: "full",
    ingredientWeights: "3:100",
    customerDishesSequence: "1;2",
    complexityCurve: "{a}",
    shuffleCurve: "{b}",
    obstacleData: "boss=1",
    randomSeed: 4242,
  });

  it("carries every generator field", () => {
    copyAll(source);
    const target = level({ name: "dst" });
    expect(pasteAll(target).sort()).toEqual(
      ["complexity", "dishes", "obstacles", "shuffle", "weights"].sort(),
    );
    expect(target.ingredientWeights).toBe("3:100");
    expect(target.customerDishesSequence).toBe("1;2");
    expect(target.complexityCurve).toBe("{a}");
    expect(target.shuffleCurve).toBe("{b}");
    expect(target.obstacleData).toBe("boss=1");
  });

  it("NEVER carries the seed", () => {
    // Pasting generator data means "make this level like that one". Carrying
    // the seed would instead make the two levels identical — the one thing a
    // seed exists to prevent happening by accident.
    copyAll(source);
    const target = level({ name: "dst", randomSeed: 7 });
    pasteAll(target);
    expect(target.randomSeed).toBe(7);
  });

  it("leaves fields the source did not set alone on the target", () => {
    copyAll(level({ ingredientWeights: "3:100" }));
    const target = level({ shuffleCurve: "keep-me" });
    pasteAll(target);
    expect(target.shuffleCurve).toBe("keep-me");
  });

  it("has nothing to paste from a level with no generator data", () => {
    copyAll(level());
    expect(canPasteAll()).toBe(false);
    expect(pasteAll(level())).toEqual([]);
  });

  it("starts empty", () => {
    expect(canPasteAll()).toBe(false);
    expect(clipboard()).toBeNull();
  });
});

describe("a single-field copy pasted onto a whole level", () => {
  it("applies just that field", () => {
    copyField(level({ obstacleData: "frozen=2" }), "obstacles");
    const target = level({ ingredientWeights: "keep" });
    expect(pasteAll(target)).toEqual(["obstacles"]);
    expect(target.obstacleData).toBe("frozen=2");
    expect(target.ingredientWeights).toBe("keep");
  });
});
