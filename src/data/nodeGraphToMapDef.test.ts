import { describe, expect, it } from "vitest";
import burgerJson from "./config/nodegraph/burger.json";
import { MAP1_DATA } from "./configLoader.ts";
import { migrateMap } from "./nodeGraphMigrate.ts";
import { nodeAsMapDef, nodeLevelAsLevelConfig } from "./nodeGraphToMapDef.ts";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";
import type { LevelData } from "./mapLoader.ts";
import { buildIdIndex } from "./nodeIdTable.ts";
import { parseQueues } from "../core/parser.ts";
import { estimateDifficulty } from "../ui/design/estimateDifficulty.ts";

const doc = burgerJson as unknown as NodeGraphMap;
const projected = nodeAsMapDef(doc);
const ids = buildIdIndex(doc.idTable);
const migrated = migrateMap(MAP1_DATA, doc);

const dataId = (node: string): number => {
  const id = ids.byNode.ingredient.get(node);
  if (id === undefined) throw new Error(`no id for ${node}`);
  return id;
};
const cooked = (node: string) => projected.map.cookedIngredients.find((c) => c.id === dataId(node))!;
const toolNamed = (name: string) => projected.map.tools.find((t) => t.name === name)!;

describe("the projection carries what the Design sections read", () => {
  it("splits the one ingredient space back into pickupables and servables", () => {
    expect(projected.map.rawIngredients.some((r) => r.id === dataId("bun"))).toBe(true);
    expect(projected.map.cookedIngredients.some((c) => c.id === dataId("bun-sliced"))).toBe(true);
    // A dual-role item appears in BOTH, under one id — the whole point of the
    // merge legacy handled with mirrored numbering.
    expect(projected.map.rawIngredients.some((r) => r.id === dataId("ice"))).toBe(true);
    expect(projected.map.cookedIngredients.some((c) => c.id === dataId("ice"))).toBe(true);
  });

  it("keeps usageNum and limitPerDish", () => {
    expect(cooked("cheese-sauce").usageNum).toBe(3);
    expect(cooked("bun-sliced").limit).toBe(1);
    expect(cooked("patty-cooked").limit).toBeUndefined();
  });

  it("gives a topping the base-slot hint its dish editor shows", () => {
    expect(cooked("patty-cooked").baseId).toBe(dataId("bun-sliced"));
    // A shared sauce lists every base its composite offers.
    expect(cooked("cheese-sauce").baseId).toEqual(
      expect.arrayContaining([dataId("potato-fried"), dataId("chicken-wing-fried")]),
    );
    // A base itself has no requirement.
    expect(cooked("bun-sliced").baseId).toBeUndefined();
  });

  it("reports a pickup's numSlices as its WHOLE-CHAIN yield", () => {
    const raw = (node: string) => projected.map.rawIngredients.find((r) => r.id === dataId(node))!;
    expect(raw("tomato").numSlices).toBe(2);
    expect(raw("potato").numSlices).toBe(2);
    expect(raw("chicken-breast").numSlices).toBe(1);
  });
});

/**
 * The single most consequential property of the projection, and the reason the
 * estimator did not need forking: a multi-tool route collapses into legacy's
 * `chainTools` spelling. One hop would have the estimator score a chicken
 * breast as producing a COATED breast, which no dish wants — score 0, chicken
 * never picked, level silently unsolvable-looking.
 */
describe("multi-tool routes collapse into chainTools", () => {
  it("routes a chicken breast from flour, through the fryer, to the FRIED piece", () => {
    const recipe = toolNamed("Flour").recipes.find((r) => r.in === dataId("chicken-breast"))!;
    expect(recipe.out).toBe(dataId("chicken-breast-fried"));
    expect(recipe.amount).toBe(1);
    expect(recipe.chainTools).toEqual([ids.byNode.tool.get("fryer")]);
  });

  it("never leaves a coated intermediate as a recipe OUTPUT", () => {
    // The intermediate keeps an id — it is a real vertex — but it is not
    // servable, so no projected recipe may end there. Every recipe output has
    // to be something a dish can actually ask for.
    const coated = dataId("chicken-breast-flour-coated");
    for (const tool of projected.map.tools) {
      for (const recipe of tool.recipes) {
        expect(recipe.out, `${tool.name} produces a non-servable output`).not.toBe(coated);
        expect(
          projected.map.cookedIngredients.some((c) => c.id === recipe.out),
          `${tool.name} -> ${recipe.out}`,
        ).toBe(true);
      }
    }
  });

  it("keeps potato's already-chained route intact", () => {
    const recipe = toolNamed("Cutting Board").recipes.find((r) => r.in === dataId("potato"))!;
    expect(recipe.out).toBe(dataId("potato-fried"));
    expect(recipe.amount).toBe(2);
    expect(recipe.chainTools).toEqual([ids.byNode.tool.get("fryer")]);
  });

  it("leaves a one-tool route with no chainTools at all", () => {
    const recipe = toolNamed("Griddle").recipes.find((r) => r.in === dataId("patty"))!;
    expect(recipe.chainTools).toBeUndefined();
  });
});

describe("nodeLevelAsLevelConfig", () => {
  const level = nodeLevelAsLevelConfig(projected, migrated.levels[0]);

  it("flattens each bracket dish to the data ids it resolves to", () => {
    expect(level.customers[0].dishes[0].cookedIds).toEqual([
      dataId("bun-sliced"),
      dataId("patty-cooked"),
    ]);
  });

  it("carries the level's own geometry and settings across", () => {
    expect(level.queues.length).toBeGreaterThan(0);
    expect(level.grid).toHaveLength(projected.map.gridWidth * projected.map.gridHeight);
    expect(level.serveableSlots).toBe(migrated.levels[0].serveableSlots);
  });
});

/**
 * The Phase 8 gate, stated as the plan states it: **Estimate Difficulty picks
 * chicken.** Write this test first and it fails loudly; without it, a one-hop
 * projection fails SILENTLY — the level simply reads as unsolvable.
 */
describe("the difficulty estimator, on node data", () => {
  const CUTS = ["chicken-breast", "chicken-wing", "chicken-thigh", "chicken-nugget"].map(dataId);

  it("has to use a SYNTHETIC level, because Map 1 never queues chicken", () => {
    // Worth pinning: the gate cannot be tested on authored data at all. Raw
    // ids 9-12 appear in no Map 1 queue, so a test that only ran real levels
    // would pass while proving nothing about the chain.
    const queued = migrated.levels.flatMap((data) =>
      parseQueues(data.queueString).flatMap((lane) => lane.map((item) => item.id)),
    );
    expect(CUTS.filter((id) => queued.includes(id))).toEqual([]);
  });

  /** A level built to make the solver choose chicken, since no authored one does. */
  const syntheticChicken: LevelData = {
    id: 900,
    name: "synthetic-chicken",
    weather: "Normal",
    levelTag: "",
    featureUnlock: "",
    serveableSlots: 2,
    shuffleDistance: 0,
    queueString: `${CUTS[0]},${CUTS[1]}%${CUTS[2]},${CUTS[3]}`,
    gridString: ",,,,,,,,,",
    customerString:
      `0;0;0;{c2:{g1:${dataId("chicken-breast-fried")}}}` +
      `|0;0;0;{c2:{g1:${dataId("chicken-wing-fried")}}}` +
      `|0;0;0;{c2:{g1:${dataId("chicken-thigh-fried")}}}` +
      `|0;0;0;{c2:{g1:${dataId("chicken-nugget-fried")}}}`,
  };

  it("picks chicken, rather than scoring it at zero and ignoring it", () => {
    const level = nodeLevelAsLevelConfig(projected, syntheticChicken);
    expect(level.customers[0].dishes[0].cookedIds).toEqual([dataId("chicken-breast-fried")]);

    const result = estimateDifficulty(projected.map, level);
    expect(result.totalPicks).toBeGreaterThan(0);
    const picked = result.occupancyHistory.flatMap((sample) => sample.pickedNames);
    expect(picked.filter((name) => /chick/i.test(name)).length).toBeGreaterThan(0);
  });

  it("and solves that level, which one-hop scoring could not", () => {
    const result = estimateDifficulty(projected.map, nodeLevelAsLevelConfig(projected, syntheticChicken));
    expect(result.servedCount).toBe(4);
    expect(result.solvable).toBe(true);
  });

  it("runs to a real verdict on every migrated level, never throwing", () => {
    for (const data of migrated.levels) {
      const level = nodeLevelAsLevelConfig(projected, data);
      expect(() => estimateDifficulty(projected.map, level), data.name).not.toThrow();
    }
  });
});
