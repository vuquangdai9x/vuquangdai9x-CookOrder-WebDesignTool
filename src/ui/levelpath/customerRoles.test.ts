import { describe, expect, it } from "vitest";
import type { NodeCustomerConfig } from "../../core/nodeParser.ts";
import { seededRng } from "./generateLevel.ts";
import {
  assignWaitTimes,
  moveBossesLast,
  planCustomers,
  SPECIAL_DISH_MAX,
  SPECIAL_DISH_MIN,
  WAIT_BASE_SECONDS,
  WAIT_PER_SLOT_SECONDS,
} from "./customerRoles.ts";
import { emptyObstacles, setObstacleValue } from "./obstacles.ts";
import type { ObstacleConfig } from "./obstacles.ts";

const config = (overrides: Partial<Record<string, number>>): ObstacleConfig => {
  const c = emptyObstacles();
  for (const [key, value] of Object.entries(overrides)) {
    setObstacleValue(c, key as never, value as number);
  }
  return c;
};

const customer = (dishes = 1, typeId = 0): NodeCustomerConfig => ({
  typeId,
  waitTime: 0,
  weatherEff: 0,
  dishes: new Array(dishes).fill(null).map(() => ({ root: { kind: "composite", id: 0, members: [] }, effects: [] })),
});

describe("planCustomers", () => {
  it("puts every boss at the very end", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const plan = planCustomers([1, 1, 1, 1, 1, 1], config({ boss: 2, shipper: 1 }), seededRng(seed));
      const bosses = plan.roles.map((r, i) => (r === "boss" ? i : -1)).filter((i) => i >= 0);
      // A boss arriving third is a difficulty spike in the middle of a curve
      // the designer shaped elsewhere.
      expect(bosses).toEqual([plan.roles.length - 2, plan.roles.length - 1]);
    }
  });

  it("gives specials a large order", () => {
    const plan = planCustomers([1, 1, 1, 1, 1], config({ boss: 1, shipper: 2 }), seededRng(3));
    plan.roles.forEach((role, at) => {
      if (role === "normal") return;
      expect(plan.dishCounts[at]).toBeGreaterThanOrEqual(SPECIAL_DISH_MIN);
      expect(plan.dishCounts[at]).toBeLessThanOrEqual(SPECIAL_DISH_MAX);
    });
  });

  it("places every shipper it was asked for, never twice on one customer", () => {
    const plan = planCustomers([1, 1, 1, 1, 1, 1], config({ shipper: 3 }), seededRng(8));
    expect(plan.roles.filter((r) => r === "shipper")).toHaveLength(3);
  });

  it("never puts a shipper in the tail the bosses own", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const plan = planCustomers([1, 1, 1, 1, 1], config({ boss: 1, shipper: 3 }), seededRng(seed));
      expect(plan.roles[plan.roles.length - 1]).toBe("boss");
    }
  });

  it("grows the sequence when it is too short to hold the specials", () => {
    // Silently dropping one would be a level that does not match its own
    // obstacle string.
    const plan = planCustomers([1], config({ boss: 2, shipper: 2 }), seededRng(2));
    expect(plan.roles).toHaveLength(4);
    expect(plan.roles.filter((r) => r === "boss")).toHaveLength(2);
    expect(plan.roles.filter((r) => r === "shipper")).toHaveLength(2);
  });

  it("leaves a plain sequence exactly as it was", () => {
    const plan = planCustomers([2, 0, -1], emptyObstacles(), seededRng(1));
    expect(plan.dishCounts).toEqual([2, 0, -1]);
    expect(plan.roles).toEqual(["normal", "normal", "normal"]);
  });
});

describe("moveBossesLast", () => {
  it("puts the boss back at the end after a repair customer is appended", () => {
    // The recipe-piece aligner appends customers AFTER planning, which is how a
    // boss stopped being last in exactly the levels that needed repairing.
    const boss = customer(4);
    const repair = customer(1);
    const customers = [customer(1), boss, repair];
    const roles = moveBossesLast(customers, ["normal", "boss"]);

    expect(customers[customers.length - 1]).toBe(boss);
    expect(roles[roles.length - 1]).toBe("boss");
    expect(roles).toHaveLength(customers.length);
  });

  it("keeps everyone else in their original order", () => {
    const a = customer(1);
    const b = customer(2);
    const boss = customer(4);
    const customers = [a, boss, b];
    moveBossesLast(customers, ["normal", "boss", "normal"]);
    expect(customers).toEqual([a, b, boss]);
  });

  it("holds several bosses together at the end, in their own order", () => {
    const first = customer(4);
    const second = customer(5);
    const customers = [first, customer(1), second];
    const roles = moveBossesLast(customers, ["boss", "normal", "boss"]);
    expect(customers.slice(-2)).toEqual([first, second]);
    expect(roles.slice(-2)).toEqual(["boss", "boss"]);
  });

  it("does nothing when there is no boss", () => {
    const customers = [customer(1), customer(2)];
    const before = [...customers];
    expect(moveBossesLast(customers, ["normal", "normal"])).toEqual(["normal", "normal"]);
    expect(customers).toEqual(before);
  });
});

describe("assignWaitTimes", () => {
  const slotsOf = (c: NodeCustomerConfig) => c.dishes.length * 2;

  it("times exactly the requested number of customers", () => {
    const customers = [customer(1), customer(2), customer(1), customer(3)];
    const timed = assignWaitTimes(customers, config({ timed: 2 }), slotsOf, seededRng(4));
    expect(timed).toBe(2);
    expect(customers.filter((c) => c.waitTime > 0)).toHaveLength(2);
  });

  it("scales the timer with how much the customer actually ordered", () => {
    const small = customer(1);
    const big = customer(4);
    assignWaitTimes([small, big], config({ timed: 2 }), slotsOf, seededRng(4));
    expect(big.waitTime).toBeGreaterThan(small.waitTime);
    expect(small.waitTime).toBe(WAIT_BASE_SECONDS + WAIT_PER_SLOT_SECONDS * 2);
  });

  it("never times a Staff customer, who orders nothing to run out of time on", () => {
    const staff = customer(0, 1);
    const normal = customer(1);
    assignWaitTimes([staff, normal], config({ timed: 5 }), slotsOf, seededRng(1));
    expect(staff.waitTime).toBe(0);
    expect(normal.waitTime).toBeGreaterThan(0);
  });

  it("relaxes every timer when the pipeline escalates", () => {
    // This is the recovery path for "the level is unwinnable because the timers
    // were too tight" — without it the retry ladder could only fix the queue.
    const tight = customer(2);
    const loose = customer(2);
    assignWaitTimes([tight], config({ timed: 1 }), slotsOf, seededRng(1), 1);
    assignWaitTimes([loose], config({ timed: 1 }), slotsOf, seededRng(1), 2);
    expect(loose.waitTime).toBeGreaterThan(tight.waitTime);
  });

  it("does nothing at all when no timer was asked for", () => {
    const customers = [customer(1), customer(2)];
    expect(assignWaitTimes(customers, emptyObstacles(), slotsOf, seededRng(1))).toBe(0);
    expect(customers.every((c) => c.waitTime === 0)).toBe(true);
  });
});
