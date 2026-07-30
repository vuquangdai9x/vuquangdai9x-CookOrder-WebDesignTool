import { describe, expect, it } from "vitest";
import {
  parseCustomers,
  parseGrid,
  parseQueues,
  serializeCustomers,
  serializeGrid,
  serializeQueues,
} from "./parser.ts";

describe("queue string", () => {
  const s = "0,1#4:5,0,1%0,0,1,0%1,7,1,7,7";

  it("round-trips", () => {
    expect(serializeQueues(parseQueues(s))).toBe(s);
  });

  it("parses effects with params", () => {
    const queues = parseQueues(s);
    expect(queues).toHaveLength(3);
    expect(queues[0][1]).toEqual({
      kind: "ingredient",
      id: 1,
      effects: [{ effectId: 4, params: [5] }],
    });
  });

  it("treats negative ids as sweeper objects", () => {
    expect(parseQueues("-1,0")[0][0].kind).toBe("sweeper");
  });
});

describe("grid string", () => {
  const s = ",,#4:1:1,,,,,#3#2:1,,";

  it("round-trips", () => {
    expect(serializeGrid(parseGrid(s))).toBe(s);
  });

  it("parses blank cells and multi-effect cells", () => {
    const grid = parseGrid(s);
    expect(grid).toHaveLength(10);
    expect(grid[0].effects).toEqual([]);
    expect(grid[2].effects).toEqual([{ effectId: 4, params: [1, 1] }]);
    expect(grid[7].effects).toEqual([
      { effectId: 3, params: [] },
      { effectId: 2, params: [1] },
    ]);
  });
});

describe("customer string", () => {
  // typeId ; waitTime ; weatherEff ; dishes [; staffAmount]. typeId comes from
  // the customer-types definition table (0 Customer, 1 Staff, extensible).
  const canonical =
    "0;0;0;1.0.6,0.1.2.5#4|0;60;1;0.1.2.3.6#5:4#2:1,1.0.5.2.3|0;50;0;1.0.5#5#4#7,0.1.2.3.6";

  it("round-trips canonical form", () => {
    expect(serializeCustomers(parseCustomers(canonical))).toBe(canonical);
  });

  it("round-trips a canonical staff entry (5th field, non-Customer typeId)", () => {
    const s = "1;0;0;;3";
    const [c] = parseCustomers(s);
    expect(c.typeId).toBe(1);
    expect(c.dishes).toEqual([]);
    expect(c.staffAmount).toBe(3);
    expect(serializeCustomers([c])).toBe(s);
  });

  it("accepts legacy digit-run dishes and normalizes to '.'-separated", () => {
    const legacy = "0;0;106,0125#4";
    const customers = parseCustomers(legacy);
    expect(customers[0].typeId).toBe(0);
    expect(customers[0].dishes[0].cookedIds).toEqual([1, 0, 6]);
    expect(customers[0].dishes[1]).toEqual({
      cookedIds: [0, 1, 2, 5],
      effects: [{ effectId: 4, params: [] }],
    });
    // Re-serializing a legacy string always yields canonical (typeId-first).
    expect(serializeCustomers(customers)).toBe("0;0;0;1.0.6,0.1.2.5#4");
  });

  it("accepts the legacy 3-field form and infers typeId from dish emptiness", () => {
    const [customer, staff] = parseCustomers("60;1;0.1|0;0;");
    expect(customer.typeId).toBe(0);
    expect(customer.waitTime).toBe(60);
    expect(customer.weatherEff).toBe(1);
    expect(customer.dishes).toEqual([{ cookedIds: [0, 1], effects: [] }]);
    expect(staff.typeId).toBe(1);
    expect(staff.dishes).toEqual([]);
  });

  it("accepts the legacy 4-field staff form (empty dishes + staffAmount)", () => {
    const [c] = parseCustomers("0;0;;3");
    expect(c.typeId).toBe(1);
    expect(c.dishes).toEqual([]);
    expect(c.staffAmount).toBe(3);
    expect(serializeCustomers([c])).toBe("1;0;0;;3");
  });

  it("rejects wrong param count", () => {
    expect(() => parseCustomers("0;0")).toThrow();
    expect(() => parseCustomers("0;0;0;1;2;3")).toThrow();
  });

  it("omits the 5th field entirely when staffAmount is unset", () => {
    const [c] = parseCustomers("0;0;0;0.1");
    expect(c.staffAmount).toBeUndefined();
    expect(serializeCustomers([c])).toBe("0;0;0;0.1");
  });
});
