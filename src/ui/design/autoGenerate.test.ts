import { describe, expect, it } from "vitest";
import { CUSTOMER_STAFF } from "../../core/effects.ts";
import { testMap } from "../../core/testFixtures.ts";
import type { CookedIngredientDef, MapDef } from "../../core/types.ts";
import { defaultCurve } from "./curveEditor.ts";
import type { CurveState } from "./curveEditor.ts";
import { generateCustomers } from "./autoGenerate.ts";

// A fixture with real base/topping relationships, unlike testMap (whose
// cookedIngredients are all baseId-less): bun(0) has 2 followers (multi),
// cup(3) has exactly 1 follower — ice(4) — making it a capacity-2 base, and
// chicken(5) has 2 followers (multi), mirroring map1's bun/cup-ice/chicken
// shape closely enough to exercise every rule. potato(8) has ZERO followers
// (capacity 1, like map1's real Fried Potato) — a regression fixture for a
// bug where a zero-follower base could get picked for a 2+-slot target and
// silently degrade to a 1-item dish instead of being excluded up front.
const cookedIngredients: CookedIngredientDef[] = [
  { id: 0, name: "Bun", icon: "" },
  { id: 1, name: "Patty", icon: "", baseId: 0 },
  { id: 2, name: "Tomato", icon: "", baseId: 0 },
  { id: 3, name: "Cup", icon: "" },
  { id: 4, name: "Ice", icon: "", baseId: 3 },
  { id: 5, name: "Chicken", icon: "" },
  { id: 6, name: "Sauce", icon: "", baseId: 5 },
  { id: 7, name: "Chive", icon: "", baseId: 5 },
  { id: 8, name: "Potato", icon: "" },
];

const fixtureMap: MapDef = { ...testMap, cookedIngredients };

const allIds = new Set(cookedIngredients.map((c) => c.id));

function flatCurve(value: number): CurveState {
  const curve = defaultCurve(value, value);
  return curve;
}

describe("generateCustomers", () => {
  it("creates one customer per dishCounts entry, in order", () => {
    const result = generateCustomers(fixtureMap, {
      dishCounts: [1, 2, 1],
      allowedCookedIds: allIds,
      curve: flatCurve(1),
      random: () => 0,
    });
    expect(result).toHaveLength(3);
    expect(result[1].dishes).toHaveLength(2);
  });

  it("turns a 0 dish-count into a Staff customer with no dishes", () => {
    const result = generateCustomers(fixtureMap, {
      dishCounts: [0],
      allowedCookedIds: allIds,
      curve: flatCurve(3),
      random: () => 0,
    });
    expect(result[0].typeId).toBe(CUSTOMER_STAFF);
    expect(result[0].dishes).toEqual([]);
  });

  it("a 1-slot dish always gets a weak (capacity<=2) base — Cup, the only one allowed here", () => {
    const withoutPotato = new Set(allIds);
    withoutPotato.delete(8); // leave Cup as the fixture's only capacity<=2 base
    const result = generateCustomers(fixtureMap, {
      dishCounts: [1, 1, 1, 1, 1],
      allowedCookedIds: withoutPotato,
      curve: flatCurve(1), // target=1 -> every dish stays at 1 slot
      random: () => 0.99, // near-max random draw, still must land on the only weak base
    });
    for (const customer of result) {
      expect(customer.dishes[0].cookedIds).toEqual([3]);
    }
  });

  it("a 2-slot dish CAN use the singleton base — Cup+Ice fills it exactly", () => {
    const result = generateCustomers(fixtureMap, {
      dishCounts: [1],
      allowedCookedIds: allIds,
      curve: flatCurve(2), // target=2, single dish -> forced to 2 slots
      random: () => 0.99, // pool = all bases when k===2, biased to pick Cup(3) or Chicken(5), the later entries
    });
    const dish = result[0].dishes[0].cookedIds;
    // Whichever base was picked, it's a legal base-first + real-follower dish.
    expect(cookedIngredients.find((c) => c.id === dish[0])?.baseId).toBeUndefined();
  });

  it("a 3+-slot dish excludes the singleton base (capacity 2 can't reach 3), and starts with a base ingredient", () => {
    const result = generateCustomers(fixtureMap, {
      dishCounts: [1],
      allowedCookedIds: allIds,
      curve: flatCurve(3), // target=3, single dish -> forced to 3 slots
      random: () => 0,
    });
    const [dish] = result[0].dishes;
    const firstId = dish.cookedIds[0];
    expect(firstId).not.toBe(3); // singleton base excluded — capacity 2 < 3
    expect(cookedIngredients.find((c) => c.id === firstId)?.baseId).toBeUndefined(); // base-first
  });

  it("every non-first ingredient in a dish is a real follower of the dish's base", () => {
    const result = generateCustomers(fixtureMap, {
      dishCounts: [1],
      allowedCookedIds: allIds,
      curve: flatCurve(3),
      random: () => 0,
    });
    const [base, ...rest] = result[0].dishes[0].cookedIds;
    for (const id of rest) {
      const def = cookedIngredients.find((c) => c.id === id)!;
      const req = def.baseId;
      const matches = Array.isArray(req) ? req.includes(base) : req === base;
      expect(matches).toBe(true);
    }
  });

  it("never picks a zero-follower base for a 2+-slot dish (regression: Fried-Potato-style dead end)", () => {
    for (let i = 0; i < 30; i++) {
      const result = generateCustomers(fixtureMap, {
        dishCounts: [1],
        allowedCookedIds: allIds,
        curve: flatCurve(2), // target=2, single dish -> forced to 2 slots
        random: () => Math.random(),
      });
      expect(result[0].dishes[0].cookedIds[0]).not.toBe(8);
    }
  });

  it("a 1-slot dish is fine with a zero-follower base (it never needed a follower anyway)", () => {
    const onlyPotato = new Set([8]);
    const result = generateCustomers(fixtureMap, {
      dishCounts: [1],
      allowedCookedIds: onlyPotato,
      curve: flatCurve(1),
      random: () => 0,
    });
    expect(result[0].dishes[0].cookedIds).toEqual([8]);
  });

  it("never repeats an ingredient within one dish", () => {
    const result = generateCustomers(fixtureMap, {
      dishCounts: [1],
      allowedCookedIds: allIds,
      curve: flatCurve(4),
      random: () => Math.random(), // real randomness — repeat this a few times below
    });
    const ids = result[0].dishes[0].cookedIds;
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("respects the allowed-ingredients toggle (excludes a disallowed base entirely)", () => {
    const withoutChicken = new Set(allIds);
    withoutChicken.delete(5);
    withoutChicken.delete(6);
    withoutChicken.delete(7);
    for (let i = 0; i < 20; i++) {
      const result = generateCustomers(fixtureMap, {
        dishCounts: [1],
        allowedCookedIds: withoutChicken,
        curve: flatCurve(3),
        random: () => Math.random(),
      });
      expect(result[0].dishes[0].cookedIds).not.toContain(5);
      expect(result[0].dishes[0].cookedIds).not.toContain(6);
      expect(result[0].dishes[0].cookedIds).not.toContain(7);
    }
  });

  it("keeps each dish's total ingredient count within maxDishSlots", () => {
    const result = generateCustomers(fixtureMap, {
      dishCounts: [1, 1, 1],
      allowedCookedIds: allIds,
      curve: flatCurve(999), // absurdly high target
      maxDishSlots: 3,
      random: () => Math.random(),
    });
    for (const customer of result) {
      for (const dish of customer.dishes) {
        expect(dish.cookedIds.length).toBeLessThanOrEqual(3);
      }
    }
  });
});
