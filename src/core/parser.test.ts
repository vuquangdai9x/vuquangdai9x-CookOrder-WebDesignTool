import { describe, expect, it } from "vitest";
import {
  parseCustomers,
  parseGrid,
  parseQueueGroups,
  parseQueues,
  serializeCustomers,
  serializeGrid,
  serializeQueues,
} from "./parser.ts";

describe("queue string", () => {
  const s = "0,1#4:5,0,1%0,0,1,0%1,7,1,7,7";

  it("round-trips three explicitly empty queues", () => {
    expect(parseQueues("%%")).toEqual([[], [], []]);
    expect(serializeQueues(parseQueues("%%"))).toBe("%%");
  });

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

  it("round-trips a param-less status as a bare '#2', with no trailing colon", () => {
    // The Hidden status (EFFECT_HIDDEN = 2) declares no paramDefs, so it must
    // serialize as "#2" and never "#2:0" — the latter would re-parse as a
    // one-param effect and break mapLoader's byte-exact round-trip assertion.
    const s = "5#2,0";
    expect(parseQueues(s)[0][0].effects).toEqual([{ effectId: 2, params: [] }]);
    expect(serializeQueues(parseQueues(s))).toBe(s);
  });

  it("round-trips a param-less status alongside a param-bearing one on the same item", () => {
    const s = "5#2#1:3";
    expect(parseQueues(s)[0][0].effects).toEqual([
      { effectId: 2, params: [] },
      { effectId: 1, params: [3] },
    ]);
    expect(serializeQueues(parseQueues(s))).toBe(s);
  });
});

describe("queue groups", () => {
  const grouped = "0,1,0%0,0,1%1,7,1$0-0,1-0;0-2,0-3$1-1,2-1";

  it("round-trips a group-bearing string", () => {
    const queues = parseQueues(grouped);
    const groups = parseQueueGroups(grouped);
    expect(serializeQueues(queues, groups)).toBe(grouped);
  });

  it("parses combined groups (first section) then linked groups (second section)", () => {
    const groups = parseQueueGroups(grouped);
    expect(groups).toEqual([
      { kind: "combined", cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
      { kind: "combined", cells: [{ x: 0, y: 2 }, { x: 0, y: 3 }] },
      { kind: "linked", cells: [{ x: 1, y: 1 }, { x: 2, y: 1 }] },
    ]);
  });

  it("parses the queue data identically to a group-less string", () => {
    const plain = "0,1,0%0,0,1%1,7,1";
    expect(parseQueues(grouped)).toEqual(parseQueues(plain));
  });

  it("a group-less string round-trips byte-identically (no '$' is ever emitted)", () => {
    const s = "0,1#4:5,0,1%0,0,1,0%1,7,1,7,7";
    expect(serializeQueues(parseQueues(s), parseQueueGroups(s))).toBe(s);
    expect(parseQueueGroups(s)).toEqual([]);
  });

  it("round-trips one-sided group sections", () => {
    const combinedOnly = "0,1$0-0,1-0$";
    expect(serializeQueues(parseQueues(combinedOnly), parseQueueGroups(combinedOnly))).toBe(combinedOnly);

    const linkedOnly = "0,1$$0-0,1-0";
    expect(serializeQueues(parseQueues(linkedOnly), parseQueueGroups(linkedOnly))).toBe(linkedOnly);
  });

  it("normalizes present-but-empty group sections away", () => {
    expect(serializeQueues(parseQueues("0,1$$"), parseQueueGroups("0,1$$"))).toBe("0,1");
    expect(serializeQueues(parseQueues("0,1$"), parseQueueGroups("0,1$"))).toBe("0,1");
  });

  it("throws on malformed cell coordinates", () => {
    expect(() => parseQueueGroups("0,1$-1-2$")).toThrow();
    expect(() => parseQueueGroups("0,1$1-2-3$")).toThrow();
    expect(() => parseQueueGroups("0,1$1-$")).toThrow();
    expect(() => parseQueueGroups("0,1$1$")).toThrow();
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

  it("no longer accepts the legacy digit-run dish format — a dot-free run is always one id", () => {
    // Dropped entirely: once ids run past 9, a dot-free digit run is
    // genuinely ambiguous between "one multi-digit id" and "one id per
    // character". Only "." separates ids now, full stop.
    const [customer] = parseCustomers("0;0;0;106,0125#4");
    expect(customer.dishes[0].cookedIds).toEqual([106]);
    expect(customer.dishes[1]).toEqual({
      cookedIds: [125],
      effects: [{ effectId: 4, params: [] }],
    });
  });

  it("round-trips a dish with a single multi-digit cooked id (regression: used to collide with the legacy digit-run reading)", () => {
    // A lone id >= 10 (e.g. map1's Fried Potato, cooked id 13) needs no "."
    // — split(".") on a dot-free string just returns that whole string as
    // the one id, unambiguously, now that there's no competing reading.
    const s = "0;0;0;13";
    const customers = parseCustomers(s);
    expect(customers[0].dishes[0].cookedIds).toEqual([13]);
    expect(serializeCustomers(customers)).toBe(s);
  });

  it("keeps a solo single-digit dish exactly as before", () => {
    const s = "0;0;0;7";
    const customers = parseCustomers(s);
    expect(customers[0].dishes[0].cookedIds).toEqual([7]);
    expect(serializeCustomers(customers)).toBe(s);
  });

  it("still round-trips a multi-id dish that happens to include ids >= 10", () => {
    const s = "0;0;0;12.14";
    const customers = parseCustomers(s);
    expect(customers[0].dishes[0].cookedIds).toEqual([12, 14]);
    expect(serializeCustomers(customers)).toBe(s);
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
