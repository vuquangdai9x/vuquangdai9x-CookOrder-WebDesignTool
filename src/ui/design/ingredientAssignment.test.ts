import { describe, expect, it } from "vitest";
import { CUSTOMER_STAFF } from "../../core/effects.ts";
import { testMap } from "../../core/testFixtures.ts";
import type { CustomerConfig, QueueItem } from "../../core/types.ts";
import { cidOf, tagNew } from "./changeTracking.ts";
import { computeIngredientAssignment, customerColor } from "./ingredientAssignment.ts";

// testMap's tools: raw0->cooked0 (x1), raw1->cooked1 (x1), raw2 has no
// recipe (goes straight through as cooked2), raw3->cooked3 (x2, amount
// ignored by this module).

function ingredient(id: number): QueueItem {
  return tagNew({ kind: "ingredient", id, effects: [] });
}

function customer(dishCookedIds: number[][], typeId = 0): CustomerConfig {
  return {
    typeId,
    waitTime: 0,
    weatherEff: 0,
    dishes: dishCookedIds.map((cookedIds) => ({ cookedIds, effects: [] })),
  };
}

describe("customerColor", () => {
  it("never repeats between consecutive indices", () => {
    for (let i = 0; i < 20; i++) expect(customerColor(i)).not.toBe(customerColor(i + 1));
  });
});

describe("computeIngredientAssignment", () => {
  it("assigns the front-most matching item to the first customer that needs it", () => {
    const a = ingredient(0);
    const b = ingredient(0);
    const queues = [[a, b]]; // one lane, a in front (row 0), b behind (row 1)
    const customers = [customer([[0]]), customer([[0]])];

    const result = computeIngredientAssignment(testMap, customers, queues);
    expect(result.get(cidOf(a)!)).toBe(customerColor(0));
    expect(result.get(cidOf(b)!)).toBe(customerColor(1));
  });

  it("walks breadth-first across lanes (row 0 everywhere before row 1)", () => {
    const laneAFront = ingredient(0);
    const laneBFront = ingredient(0);
    const laneABack = ingredient(0);
    const queues = [
      [laneAFront, laneABack],
      [laneBFront],
    ];
    // Three customers each wanting one cooked0 — BFS order should be
    // laneAFront, laneBFront (both row 0), then laneABack (row 1).
    const customers = [customer([[0]]), customer([[0]]), customer([[0]])];

    const result = computeIngredientAssignment(testMap, customers, queues);
    expect(result.get(cidOf(laneAFront)!)).toBe(customerColor(0));
    expect(result.get(cidOf(laneBFront)!)).toBe(customerColor(1));
    expect(result.get(cidOf(laneABack)!)).toBe(customerColor(2));
  });

  it("dequeues a claimed item so a later customer never reuses it", () => {
    const only = ingredient(0);
    const queues = [[only]];
    const customers = [customer([[0]]), customer([[0]])];

    const result = computeIngredientAssignment(testMap, customers, queues);
    expect(result.get(cidOf(only)!)).toBe(customerColor(0));
    expect(result.size).toBe(1); // second customer's demand goes unmatched, not double-assigned
  });

  it("leaves an unmatched demand (queue doesn't have the ingredient) uncolored", () => {
    const queues: QueueItem[][] = [[]];
    const customers = [customer([[0]])];

    const result = computeIngredientAssignment(testMap, customers, queues);
    expect(result.size).toBe(0);
  });

  it("skips staff customers but still reserves their color-index slot", () => {
    const a = ingredient(0);
    const b = ingredient(0);
    const queues = [[a, b]];
    const customers = [customer([[0]]), customer([], CUSTOMER_STAFF), customer([[0]])];

    const result = computeIngredientAssignment(testMap, customers, queues);
    expect(result.get(cidOf(a)!)).toBe(customerColor(0));
    // Staff (index 1) claims nothing; the next order-taking customer is at
    // index 2, not index 1 — its color reflects its own list position.
    expect(result.get(cidOf(b)!)).toBe(customerColor(2));
  });

  it("resolves a raw item through its tool recipe before matching (raw1 -> cooked1)", () => {
    const raw1 = ingredient(1);
    const queues = [[raw1]];
    const customers = [customer([[1]])];

    const result = computeIngredientAssignment(testMap, customers, queues);
    expect(result.get(cidOf(raw1)!)).toBe(customerColor(0));
  });
});
