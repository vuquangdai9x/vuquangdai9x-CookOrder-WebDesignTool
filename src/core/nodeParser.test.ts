import { describe, expect, it } from "vitest";
import {
  dishIngredientIds,
  dishNodes,
  parseDish,
  parseNodeCustomers,
  serializeDish,
  serializeNodeCustomers,
} from "./nodeParser.ts";

/** The worked examples from the plan, which the format has to keep supporting. */
const EXAMPLES: [string, string][] = [
  ["burger: bun + 2 patty + 1 tomato", "{c0:17.{g0:18.18.19}}"],
  ["soda with ice — two fixed slots, no group", "{c1:24.8}"],
  ["fried chicken: wing with chili", "{c2:{g1:26}.{g2:14}}"],
  ["plain fries — one fixed slot", "{c3:13}"],
  ["burger carrying effect 4", "{c0:17.{g0:18}}#4"],
];

describe("dish round-trip", () => {
  for (const [label, str] of EXAMPLES) {
    it(`round-trips ${label}`, () => {
      expect(serializeDish(parseDish(str))).toBe(str);
    });
  }

  it("parses the burger example into the right tree", () => {
    const dish = parseDish("{c0:17.{g0:18.18.19}}");
    expect(dish.root).toEqual({
      kind: "composite",
      id: 0,
      members: [
        { kind: "ingredient", id: 17 },
        {
          kind: "group",
          id: 0,
          members: [
            { kind: "ingredient", id: 18 },
            { kind: "ingredient", id: 18 },
            { kind: "ingredient", id: 19 },
          ],
        },
      ],
    });
    expect(dish.effects).toEqual([]);
  });

  it("keeps quantity as repetition", () => {
    expect(dishIngredientIds(parseDish("{c0:17.{g0:18.18.19}}"))).toEqual([17, 18, 18, 19]);
  });

  it("distinguishes composite id 0 from group id 0 by the c/g prefix", () => {
    const dish = parseDish("{c0:{g0:5}}");
    expect(dish.root.kind).toBe("composite");
    expect(dish.root.id).toBe(0);
    expect((dish.root.members[0] as { kind: string; id: number }).kind).toBe("group");
    expect((dish.root.members[0] as { kind: string; id: number }).id).toBe(0);
  });

  it("carries dish effects with params", () => {
    const dish = parseDish("{c0:17}#4:1:2");
    expect(dish.effects).toEqual([{ effectId: 4, params: [1, 2] }]);
    expect(serializeDish(dish)).toBe("{c0:17}#4:1:2");
  });

  it("handles multi-digit ids", () => {
    expect(dishIngredientIds(parseDish("{c12:117.{g34:234}}"))).toEqual([117, 234]);
    expect(serializeDish(parseDish("{c12:117.{g34:234}}"))).toBe("{c12:117.{g34:234}}");
  });

  it("enumerates nested brackets outermost first", () => {
    const nodes = dishNodes(parseDish("{c2:{g1:26}.{g2:14}}"));
    expect(nodes.map((n) => `${n.kind[0]}${n.id}`)).toEqual(["c2", "g1", "g2"]);
  });
});

describe("dish — malformed input is rejected, not guessed at", () => {
  const bad: [string, string, RegExp][] = [
    ["unbalanced open bracket", "{c0:17", /Expected "\}" or "\."/],
    ["unbalanced close bracket", "{c0:17}}", /trailing/],
    ["missing kind prefix", "{0:17}", /Expected "c" or "g"/],
    ["unknown kind prefix", "{x0:17}", /Expected "c" or "g"/],
    ["missing id", "{c:17}", /Expected an id/],
    ["missing colon", "{c0 17}", /Expected ":"/],
    ["empty members", "{c0:}", /Expected an ingredient id or "\{"/],
    ["trailing separator", "{c0:17.}", /Expected an ingredient id or "\{"/],
    ["bare ingredient with no bracket", "17", /Expected "\{"/],
    ["group as the outermost bracket", "{g0:17}", /outermost bracket must be a composite/],
  ];
  for (const [label, str, pattern] of bad) {
    it(`rejects ${label}`, () => {
      expect(() => parseDish(str)).toThrow(pattern);
    });
  }
});

describe("customers", () => {
  const TWO_CUSTOMERS = "0;60;1;{c0:17.{g0:18.18.19}},{c1:24.8}|0;45;0;{c2:{g1:26}.{g2:14}}";

  it("round-trips a two-customer string byte for byte", () => {
    expect(serializeNodeCustomers(parseNodeCustomers(TWO_CUSTOMERS))).toBe(TWO_CUSTOMERS);
  });

  it("parses the fields and both dishes of the first customer", () => {
    const [first, second] = parseNodeCustomers(TWO_CUSTOMERS);
    expect(first).toMatchObject({ typeId: 0, waitTime: 60, weatherEff: 1 });
    expect(first.dishes).toHaveLength(2);
    expect(first.dishes[0].root.id).toBe(0);
    expect(first.dishes[1].root.id).toBe(1);
    expect(second.dishes).toHaveLength(1);
    expect(second.dishes[0].root.id).toBe(2);
  });

  it("round-trips a staff customer, which orders nothing", () => {
    const staff = "1;0;0;;3";
    const parsed = parseNodeCustomers(staff);
    expect(parsed[0]).toEqual({ typeId: 1, waitTime: 0, weatherEff: 0, dishes: [], staffAmount: 3 });
    expect(serializeNodeCustomers(parsed)).toBe(staff);
  });

  it("omits staffAmount when it was absent, so round-trip stays byte-exact", () => {
    const s = "0;30;0;{c3:13}";
    expect(parseNodeCustomers(s)[0].staffAmount).toBeUndefined();
    expect(serializeNodeCustomers(parseNodeCustomers(s))).toBe(s);
  });

  it("treats an empty string as no customers", () => {
    expect(parseNodeCustomers("")).toEqual([]);
    expect(parseNodeCustomers("   ")).toEqual([]);
  });

  it("rejects a customer with the wrong number of fields", () => {
    expect(() => parseNodeCustomers("0;60;{c0:17}")).toThrow(/4, 5 or 6/);
    expect(() => parseNodeCustomers("0;1;2;{c0:17};3;4;5")).toThrow(/4, 5 or 6/);
  });

  it("parses a customerIndex in the optional 6th field", () => {
    const s = "0;0;0;{c0:17};;7";
    const [parsed] = parseNodeCustomers(s);
    expect(parsed.customerIndex).toBe(7);
    expect(parsed.staffAmount).toBeUndefined();
    expect(serializeNodeCustomers([parsed])).toBe(s);
  });

  it("carries both staffAmount and customerIndex together", () => {
    const s = "1;0;0;;3;7";
    const [parsed] = parseNodeCustomers(s);
    expect(parsed).toEqual({ typeId: 1, waitTime: 0, weatherEff: 0, dishes: [], staffAmount: 3, customerIndex: 7 });
    expect(serializeNodeCustomers([parsed])).toBe(s);
  });

  it("omits customerIndex when it was absent, so round-trip stays byte-exact", () => {
    const s = "0;30;0;{c3:13}";
    expect(parseNodeCustomers(s)[0].customerIndex).toBeUndefined();
    expect(serializeNodeCustomers(parseNodeCustomers(s))).toBe(s);
  });

  it("rejects a non-integer field rather than coercing it", () => {
    expect(() => parseNodeCustomers("0;abc;0;{c0:17}")).toThrow(/Invalid integer/);
  });

  it("does NOT accept the legacy flat dish format", () => {
    // The old grammar wrote dishes as bare dot-separated ids. Silently
    // accepting them would let un-migrated data through into the new system.
    expect(() => parseNodeCustomers("0;0;0;1.0")).toThrow();
  });
});
