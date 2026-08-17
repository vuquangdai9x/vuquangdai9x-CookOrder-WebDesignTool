import { describe, expect, it } from "vitest";
import burgerJson from "../../data/config/nodegraph/burger.json";
import type { NodeGraphMap } from "../../data/nodeGraphTypes.ts";
import { buildIndex } from "../../core/nodeIndex.ts";
import { orderIdIndex, resolveOrder } from "../../core/nodeOrder.ts";
import { serializeNodeCustomers, parseNodeCustomers } from "../../core/nodeParser.ts";
import { defaultCurve } from "../design/curveEditor.ts";
import { generateNodeCustomers } from "./nodeGenerate.ts";

const doc = burgerJson as unknown as NodeGraphMap;
const ix = buildIndex(doc);
const ids = orderIdIndex(ix);

/** Deterministic PRNG, so a failure is reproducible rather than a flake. */
function seeded(seed = 7): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const allWeights = () => {
  const weights = new Map<number, number>();
  for (let i = 0; i < ix.ingName.length; i++) if (ix.servable[i]) weights.set(i, 100);
  return weights;
};

const curve = defaultCurve(1, 5);

describe("generateNodeCustomers", () => {
  const customers = generateNodeCustomers(ix, ids, {
    dishCounts: Array(30).fill(0),
    weights: allWeights(),
    curve,
    random: seeded(),
  });

  it("emits one entry per requested customer", () => {
    expect(customers).toHaveLength(30);
  });

  /**
   * The property the whole generator exists for. Legacy generated a bag of
   * ingredients and hoped; this picks an orderable first and fills its slots,
   * so a malformed dish is not something it can produce.
   */
  it("produces only dishes that resolve with ZERO issues", () => {
    const problems: string[] = [];
    customers.forEach((customer, ci) => {
      customer.dishes.forEach((dish, di) => {
        for (const issue of resolveOrder(ix, dish, ids).issues) {
          problems.push(`c${ci} d${di}: ${issue.kind}`);
        }
      });
    });
    expect(problems).toEqual([]);
  });

  it("round-trips through the customer string grammar", () => {
    const text = serializeNodeCustomers(customers);
    expect(() => parseNodeCustomers(text)).not.toThrow();
    expect(serializeNodeCustomers(parseNodeCustomers(text))).toBe(text);
  });

  it("always fills the base slot — a dish without one can never be served", () => {
    for (const customer of customers) {
      for (const dish of customer.dishes) {
        const { order } = resolveOrder(ix, dish, ids);
        expect(order.slots.some((s) => s.gate === -1)).toBe(true);
      }
    }
  });

  it("never exceeds a slot's cap", () => {
    for (const customer of customers) {
      for (const dish of customer.dishes) {
        const { order } = resolveOrder(ix, dish, ids);
        const perSlot = new Map<number, number>();
        for (const slot of order.slots) perSlot.set(slot.slot, (perSlot.get(slot.slot) ?? 0) + 1);
        for (const [slotIndex, count] of perSlot) {
          const slot = ix.slotsOfComposite[order.orderable][slotIndex];
          const cap = slot.kind === "fixed" ? 1 : slot.maxQuantity < 0 ? Infinity : slot.maxQuantity;
          expect(count, `${ix.compositeName[order.orderable]} slot ${slotIndex}`).toBeLessThanOrEqual(cap);
        }
      }
    }
  });

  it("honours each option's own cap", () => {
    // The cap now lives on the slot's option edge, not on the ingredient —
    // one fact, one place. See Slot.optionMax.
    for (const customer of customers) {
      for (const dish of customer.dishes) {
        const { order } = resolveOrder(ix, dish, ids);
        const perSlotIng = new Map<string, number>();
        for (const slot of order.slots) {
          const key = `${slot.slot}:${slot.ing}`;
          perSlotIng.set(key, (perSlotIng.get(key) ?? 0) + 1);
        }
        for (const [key, count] of perSlotIng) {
          const [slotIndex, ing] = key.split(":").map(Number);
          const slot = ix.slotsOfComposite[order.orderable][slotIndex];
          const at = slot.options.indexOf(ing);
          const cap = at === -1 ? -1 : (slot.optionMax[at] ?? -1);
          if (cap > 0) expect(count, ix.ingName[ing]).toBeLessThanOrEqual(cap);
        }
      }
    }
  });

  it("emits a staff customer for a -1 entry, with no dishes", () => {
    const withStaff = generateNodeCustomers(ix, ids, {
      dishCounts: [1, -1, 1],
      weights: allWeights(),
      curve,
      random: seeded(3),
    });
    expect(withStaff[1]).toMatchObject({ typeId: 1, dishes: [], staffAmount: 1 });
  });

  it("is deterministic for a given seed", () => {
    const opts = { dishCounts: [2, 2, 2], weights: allWeights(), curve };
    const a = generateNodeCustomers(ix, ids, { ...opts, random: seeded(11) });
    const b = generateNodeCustomers(ix, ids, { ...opts, random: seeded(11) });
    expect(serializeNodeCustomers(a)).toBe(serializeNodeCustomers(b));
  });

  it("uses only ingredients the weights allow", () => {
    // Weight ONLY the burger's own options; nothing from soda or the basket.
    const burger = ix.compositeByName.get("burger")!;
    const allowed = new Set((ix.slotsOfComposite[burger] ?? []).flatMap((s) => s.options));
    const weights = new Map([...allowed].map((ing) => [ing, 100]));

    const only = generateNodeCustomers(ix, ids, {
      dishCounts: Array(15).fill(1),
      weights,
      curve,
      random: seeded(5),
    });
    for (const customer of only) {
      for (const dish of customer.dishes) {
        const { order } = resolveOrder(ix, dish, ids);
        expect(ix.compositeName[order.orderable]).toBe("burger");
        for (const slot of order.slots) expect(allowed.has(slot.ing)).toBe(true);
      }
    }
  });
});

describe("toppingRequired", () => {
  /** The fried basket, with its sauce slot made mandatory. */
  const required = (): NodeGraphMap => {
    const clone = structuredClone(doc);
    clone.vertices.composite = clone.vertices.composite.map((c) =>
      c.name === "fried-basket" ? { ...c, toppingRequired: true } : { ...c, orderable: false },
    );
    return clone;
  };

  it("makes a base-only dish an ISSUE rather than a silent stall", () => {
    const ix2 = buildIndex(required());
    const ids2 = orderIdIndex(ix2);
    // {c2:{g1:112}} — a fried basket holding only potato, no sauce.
    const { issues } = resolveOrder(ix2, parseNodeCustomers("0;0;0;{c2:{g1:29}}")[0].dishes[0], ids2);
    expect(issues.map((i) => i.kind)).toContain("missing-topping");
  });

  it("is satisfied by any non-base slot being filled", () => {
    const ix2 = buildIndex(required());
    const ids2 = orderIdIndex(ix2);
    const { issues } = resolveOrder(
      ix2,
      parseNodeCustomers("0;0;0;{c2:{g1:29}.{g2:16}}")[0].dishes[0],
      ids2,
    );
    expect(issues).toEqual([]);
  });

  it("makes the generator fill the topping rather than leave it empty", () => {
    const ix2 = buildIndex(required());
    const ids2 = orderIdIndex(ix2);
    const weights = new Map<number, number>();
    for (let i = 0; i < ix2.ingName.length; i++) if (ix2.servable[i]) weights.set(i, 100);

    const generated = generateNodeCustomers(ix2, ids2, {
      dishCounts: Array(20).fill(1),
      weights,
      curve,
      random: seeded(13),
    });
    for (const customer of generated) {
      for (const dish of customer.dishes) {
        expect(resolveOrder(ix2, dish, ids2).issues).toEqual([]);
      }
    }
  });
});
