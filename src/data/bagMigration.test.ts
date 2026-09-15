import { describe, expect, it } from "vitest";
import {
  isOldQueueString,
  isOldUsageQueueString,
  migrateQueueString,
  migrateQueueStringPasses,
  migrateUsageQueueString,
  usageBagMigrationLookup,
} from "./bagMigration.ts";
import burgerJson from "./config/nodegraph/maps/Graph-1-Burger.json";
import coffeeJson from "./config/nodegraph/maps/Graph-2-Coffee.json";

const lookup = { multipliers: { "2": 2, "5": 3 } };

describe("bag migration of old queue strings", () => {
  it("detects an old string only when it has ingredient slots and none carries an amount", () => {
    expect(isOldQueueString("2,0%5#1:2")).toBe(true);
    expect(isOldQueueString("2:2,0%5")).toBe(false);
    expect(isOldQueueString("%%")).toBe(false);
    expect(isOldQueueString("-1")).toBe(false);
  });

  it("stamps the former multiplier on matching slots, keeping effects and groups", () => {
    expect(migrateQueueString("2,0,5#1:2%-1,2$0-0,1-0$", lookup)).toBe("2:2,0,5:3#1:2%-1,2:2$0-0,1-0$");
  });

  it("leaves migrated or unmatched strings untouched", () => {
    expect(migrateQueueString("2:2,0", lookup)).toBe("2:2,0");
    expect(migrateQueueString("0,1", lookup)).toBe("0,1");
  });
});

describe("second-pass usageNum bag migration", () => {
  const usageLookup = { multipliers: { "14": 2, "16": 2 } };

  it("detects old levels from matching slots only, after pass-one amounts exist", () => {
    expect(isOldUsageQueueString("2:2,14,16#1:2", usageLookup)).toBe(true);
    expect(isOldUsageQueueString("14:0,16:1", usageLookup)).toBe(true);
    expect(isOldUsageQueueString("2:2,14:2,16", usageLookup)).toBe(false);
    expect(isOldUsageQueueString("2:2,5", usageLookup)).toBe(false);
  });

  it("stamps former usageNum amounts while preserving pass-one bags, effects and groups", () => {
    expect(migrateUsageQueueString("2:3,14,16#1:2$0-1,0-2$", usageLookup)).toBe(
      "2:3,14:2,16:2#1:2$0-1,0-2$",
    );
  });

  it("skips the whole level when matching slots contain mixed migration state", () => {
    expect(migrateUsageQueueString("14:2,16", usageLookup)).toBe("14:2,16");
  });

  it("runs after, and independently from, the process-output pass", () => {
    expect(migrateQueueStringPasses("2,14,16", lookup, usageLookup)).toBe("2:2,14:2,16:2");
  });

  it("ships the scanned Map 1 and 2 lookup dictionaries", () => {
    expect(usageBagMigrationLookup(1)?.multipliers).toEqual({ "14": 2, "16": 2 });
    expect(usageBagMigrationLookup(2)?.multipliers).toEqual({
      "3": 2,
      "4": 2,
      "5": 2,
      "6": 2,
      "10": 2,
    });
  });

  it("removes usageNum from every shipped Map 1 and 2 ingredient", () => {
    for (const graph of [burgerJson, coffeeJson]) {
      expect(graph.vertices.ingredient.every((ingredient) => !("usageNum" in ingredient))).toBe(true);
    }
  });

  it("marks exactly the scanned former multi-use ingredients as multipleUsage", () => {
    const marked = (graph: typeof burgerJson | typeof coffeeJson) => graph.vertices.ingredient
      .filter((ingredient) => "multipleUsage" in ingredient && ingredient.multipleUsage)
      .map((ingredient) => ingredient.name)
      .sort();
    expect(marked(burgerJson)).toEqual(["cheese-sauce", "chili-bowl"]);
    expect(marked(coffeeJson)).toEqual([
      "glaze-blue",
      "glaze-choco",
      "glaze-strawberry",
      "glaze-vanilla",
      "milk",
    ]);
  });
});
