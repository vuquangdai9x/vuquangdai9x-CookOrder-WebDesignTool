import { describe, expect, it } from "vitest";
import { interpretLevelBrief } from "./brief.ts";

describe("interpretLevelBrief", () => {
  it("does not authorize obstacles from difficulty alone", () => {
    const result = interpretLevelBrief("Create a challenging level with a steady finish.");
    expect(result.difficultyProfile?.id).toBe("challenging");
    expect(result.authorizedMechanics).toEqual([]);
  });

  it("authorizes only mechanics explicitly named", () => {
    const result = interpretLevelBrief("Use linked slots and customer timers.");
    expect(result.authorizedMechanics).toEqual(["group:linked", "customer:timer"]);
    expect(result.authorizedMechanics).not.toContain("queue:freeze");
  });

  it("requests an extension for unsupported difficulty language", () => {
    const result = interpretLevelBrief("Difficulty: tense but forgiving in the middle");
    expect(result.needsProfileExtension?.phrase).toBe("tense but forgiving in the middle");
  });
});
