// Who the generated customers ARE: which of them is a shipper or a boss, which
// of them carry a patience timer, and how long that timer gets.
//
// Split out of the pipeline because both halves are judgement calls the rest of
// the generator has no opinion about, and both are worth being able to test on
// their own — a wait time that is subtly too short does not fail loudly, it
// just makes a level unfair.

import type { NodeCustomerConfig } from "../../core/nodeParser.ts";
import type { CustomerRole } from "../nodedesign/nodeGenerate.ts";
import { getCustomerCatalog } from "../../data/customerCatalog.ts";
import type { CustomerCatalogEntry } from "../../data/customerCatalog.ts";
import type { ObstacleConfig } from "./obstacles.ts";

/** Dishes a shipper or boss orders — the "large amount" they exist to be. */
export const SPECIAL_DISH_MIN = 4;
export const SPECIAL_DISH_MAX = 5;

const randInt = (rand: () => number, min: number, max: number): number =>
  min + Math.floor(rand() * (max - min + 1));

export interface CustomerPlan {
  /** Dish count per customer, in arrival order. */
  dishCounts: number[];
  /** Role per customer, parallel to `dishCounts`. */
  roles: CustomerRole[];
}

/**
 * Turns a plain dish-count sequence into one with the requested specials in it.
 *
 * BOSSES GO LAST, always — a boss is the finale, and one arriving third would
 * be a difficulty spike in the middle of a curve the designer shaped elsewhere.
 * Shippers are scattered through the rest, but never into the tail the bosses
 * occupy, so the ending stays theirs.
 *
 * The sequence GROWS if it is too short to hold the specials: a config asking
 * for two bosses and a shipper needs at least three customers, and silently
 * dropping one would be a level that does not match its own obstacle string.
 */
export function planCustomers(
  dishCounts: number[],
  config: ObstacleConfig,
  rand: () => number,
): CustomerPlan {
  const bosses = Math.max(0, Math.round(config.customer.boss));
  const shippers = Math.max(0, Math.round(config.customer.shipper));
  const counts = [...dishCounts];
  while (counts.length < bosses + shippers) counts.push(1);

  const roles: CustomerRole[] = counts.map(() => "normal");

  for (let i = 0; i < bosses; i++) {
    const at = counts.length - 1 - i;
    roles[at] = "boss";
    counts[at] = randInt(rand, SPECIAL_DISH_MIN, SPECIAL_DISH_MAX);
  }

  // Shippers land anywhere the bosses have not claimed. Drawn without
  // replacement so asking for three shippers gets three, not "up to three".
  const open: number[] = [];
  for (let at = 0; at < counts.length - bosses; at++) open.push(at);
  for (let i = 0; i < shippers && open.length > 0; i++) {
    const pick = open.splice(Math.floor(rand() * open.length) % open.length, 1)[0];
    roles[pick] = "shipper";
    counts[pick] = randInt(rand, SPECIAL_DISH_MIN, SPECIAL_DISH_MAX);
  }

  return { dishCounts: counts, roles };
}

/**
 * Re-asserts "the boss arrives last" after generation, and returns roles that
 * line up with the customer list as it now stands.
 *
 * The generator does not hand back exactly the customers it was asked for: the
 * recipe-piece aligner APPENDS a repair customer when a tool's yield leaves a
 * spare piece nobody ordered, and that customer lands after the boss. So the
 * boss was last when it was planned and is not last by the time the level is
 * serialized — a rule that holds everywhere except in the levels that need
 * repairing, which is the worst kind of rule.
 *
 * Mutates `customers` in place, because it is the caller's array and every
 * later step (avatars, timers) indexes into it.
 */
export function moveBossesLast(
  customers: NodeCustomerConfig[],
  planned: CustomerRole[],
): CustomerRole[] {
  // Customers appended after planning have no planned role; they are ordinary.
  const roles: CustomerRole[] = customers.map((_, at) => planned[at] ?? "normal");
  if (!roles.includes("boss")) return roles;

  const rest: { customer: NodeCustomerConfig; role: CustomerRole }[] = [];
  const bosses: { customer: NodeCustomerConfig; role: CustomerRole }[] = [];
  customers.forEach((customer, at) => {
    (roles[at] === "boss" ? bosses : rest).push({ customer, role: roles[at] });
  });

  const ordered = [...rest, ...bosses];
  customers.length = 0;
  customers.push(...ordered.map((entry) => entry.customer));
  return ordered.map((entry) => entry.role);
}

const typeMatches = (entry: CustomerCatalogEntry, role: CustomerRole): boolean =>
  entry.type.trim().toLowerCase() === role;

/**
 * Pins a catalog avatar on every shipper and boss.
 *
 * Scoped to the map, like the rest of the avatar handling: a burger level must
 * not draw a sushi boss. A map with no catalog row of that type gets no avatar
 * and a warning rather than a wrong one — the level is still correct, it just
 * looks generic until someone adds the art.
 */
export function assignSpecialAvatars(
  customers: NodeCustomerConfig[],
  roles: CustomerRole[],
  mapId: string,
  rand: () => number,
  warn: (message: string) => void,
): void {
  const catalog = getCustomerCatalog().filter((entry) => entry.baseMap === mapId);
  const pools: Record<string, CustomerCatalogEntry[]> = {
    shipper: catalog.filter((entry) => typeMatches(entry, "shipper")),
    boss: catalog.filter((entry) => typeMatches(entry, "boss")),
  };
  const warned = new Set<string>();

  roles.forEach((role, at) => {
    if (role === "normal") return;
    const customer = customers[at];
    if (!customer) return;
    const pool = pools[role];
    if (!pool || pool.length === 0) {
      if (!warned.has(role)) {
        warned.add(role);
        warn(`No ${role} avatar in the customer catalog for map "${mapId}" — the ${role} has no pinned character.`);
      }
      return;
    }
    customer.customerIndex = pool[Math.floor(rand() * pool.length) % pool.length].index;
  });
}

/** Fixed patience assigned by auto-generation. */
export const WAIT_BASE_SECONDS = 60;

/**
 * Gives the first `config.customer.timed` ordering customers a fixed timer.
 * Arrival-order selection and duration are deliberately deterministic.
 */
export function assignWaitTimes(
  customers: NodeCustomerConfig[],
  config: ObstacleConfig,
): number {
  const wanted = Math.max(0, Math.round(config.customer.timed));
  if (wanted === 0) return 0;

  // Staff order nothing, so a patience timer on one has nothing to run out of.
  const eligible = customers.map((_, at) => at).filter((at) => customers[at].typeId !== 1);
  const chosen = eligible.slice(0, wanted);
  for (const at of chosen) {
    customers[at].waitTime = WAIT_BASE_SECONDS;
  }
  return chosen.length;
}
