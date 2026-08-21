// Customer strings for the node-graph system.
//
// This is the ONE grammar fork from core/parser.ts. Queue, grid and
// queue-group strings keep their existing syntax and are re-exported from
// there unchanged — only dishes change shape, because a dish now states the
// composite and group each item sits in rather than leaving it to be inferred.
//
//   customers := customer ( "|" customer )*
//   customer  := typeId ";" waitTime ";" weatherEff ";" dishes [ ";" staffAmount ]
//   dishes    := dish ( "," dish )*
//   dish      := node [ "#" effectId [ ":" param ]* ]
//   node      := "{" kind id ":" members "}"     // kind: c = composite, g = group
//   members   := member ( "." member )*
//   member    := ingredientId | node             // a bare number is an ingredient
//
//   {c0:17.{g0:18.18.19}}          burger: bun, 2 patty, 1 tomato
//   {c1:24.8}                      soda with ice (two fixed slots, no group)
//   {c2:{g1:26}.{g2:14}}           fried chicken: wing, chili sauce
//   {c3:13}                        plain fries
//   {c0:17.{g0:18}}#4              a dish carrying effect 4
//
// Quantity is repetition (`18.18` = two patties), matching the existing
// "."-separated convention. The c/g prefix is what makes a nested bracket
// unambiguous: nesting can be a group OR another composite, and without the
// prefix those collide (composite and group ids live in separate spaces and
// may both be 0).
//
// Every integer here is a DATA ID, resolved to a node name through the map's
// id table — see data/nodeIdTable.ts. This module is deliberately purely
// syntactic and knows nothing about the graph, so it is testable standalone;
// binding ids to vertices happens in nodeOrder.ts.
//
// Same contract as core/parser.ts: serialize(parse(s)) === s for canonical
// strings, and parse(serialize(x)) is deep-equal to x.

import type { EffectInstance } from "./types.ts";

export { parseGrid, parseQueueGroups, parseQueues, serializeGrid, serializeQueues, SWEEPER_ID } from "./parser.ts";

/** A composite or group bracket. */
export interface DishNode {
  kind: "composite" | "group";
  /** Data id within that kind's own id space. */
  id: number;
  members: DishMember[];
}

/** A bare ingredient id inside a bracket. */
export interface DishIngredient {
  kind: "ingredient";
  id: number;
}

export type DishMember = DishIngredient | DishNode;

export interface NodeDish {
  /** Always a composite — a dish's outermost bracket names what is being ordered. */
  root: DishNode;
  effects: EffectInstance[];
}

export interface NodeCustomerConfig {
  typeId: number;
  waitTime: number;
  weatherEff: number;
  dishes: NodeDish[];
  staffAmount?: number;
  /** Row index into the customer catalog (data/customerCatalog.ts) this arrival's avatar/identity is pinned to; unset = random. */
  customerIndex?: number;
}

function fail(message: string, context: string): never {
  throw new Error(`${message} in "${context}"`);
}

function parseIntStrict(s: string, context: string): number {
  const n = Number(s);
  if (s === "" || !Number.isInteger(n)) fail(`Invalid integer "${s}"`, context);
  return n;
}

// ---------- effects (same "#id:param" convention as core/parser.ts) ----------
// Duplicated rather than exported from there, because the surrounding grammar
// is forked anyway and the legacy parser is deliberately left untouched.

function splitEffects(token: string): { base: string; effects: EffectInstance[] } {
  const parts = token.split("#");
  return {
    base: parts[0],
    effects: parts.slice(1).map((e) => {
      const nums = e.split(":");
      return {
        effectId: parseIntStrict(nums[0], token),
        params: nums.slice(1).map((p) => parseIntStrict(p, token)),
      };
    }),
  };
}

function serializeEffects(effects: EffectInstance[]): string {
  return effects.map((e) => "#" + [e.effectId, ...e.params].join(":")).join("");
}

// ---------- the bracket tree ----------

interface Cursor {
  i: number;
}

/** Recursive descent over one `{kind id : members}` bracket. */
function parseNode(s: string, cur: Cursor, context: string): DishNode {
  if (s[cur.i] !== "{") fail(`Expected "{" at position ${cur.i}`, context);
  cur.i++;

  const kindChar = s[cur.i];
  if (kindChar !== "c" && kindChar !== "g") {
    fail(`Expected "c" or "g" after "{" at position ${cur.i}`, context);
  }
  cur.i++;

  const idStart = cur.i;
  while (cur.i < s.length && s[cur.i] >= "0" && s[cur.i] <= "9") cur.i++;
  if (cur.i === idStart) fail(`Expected an id after "${kindChar}" at position ${idStart}`, context);
  const id = parseIntStrict(s.slice(idStart, cur.i), context);

  if (s[cur.i] !== ":") fail(`Expected ":" after "${kindChar}${id}"`, context);
  cur.i++;

  const members: DishMember[] = [];
  for (;;) {
    if (s[cur.i] === "{") {
      members.push(parseNode(s, cur, context));
    } else {
      const start = cur.i;
      while (cur.i < s.length && s[cur.i] >= "0" && s[cur.i] <= "9") cur.i++;
      if (cur.i === start) fail(`Expected an ingredient id or "{" at position ${start}`, context);
      members.push({ kind: "ingredient", id: parseIntStrict(s.slice(start, cur.i), context) });
    }
    if (s[cur.i] === ".") {
      cur.i++;
      continue;
    }
    break;
  }

  if (s[cur.i] !== "}") fail(`Expected "}" or "." at position ${cur.i}`, context);
  cur.i++;

  return { kind: kindChar === "c" ? "composite" : "group", id, members };
}

export function parseDish(dishStr: string): NodeDish {
  const { base, effects } = splitEffects(dishStr);
  const cur: Cursor = { i: 0 };
  const root = parseNode(base, cur, dishStr);
  if (cur.i !== base.length) fail(`Unexpected trailing "${base.slice(cur.i)}"`, dishStr);
  if (root.kind !== "composite") {
    fail(`A dish's outermost bracket must be a composite ("{c...}"), got a group`, dishStr);
  }
  return { root, effects };
}

export function serializeDish(dish: NodeDish): string {
  return serializeNode(dish.root) + serializeEffects(dish.effects);
}

function serializeNode(node: DishNode): string {
  const prefix = node.kind === "composite" ? "c" : "g";
  const members = node.members
    .map((m) => (m.kind === "ingredient" ? String(m.id) : serializeNode(m)))
    .join(".");
  return `{${prefix}${node.id}:${members}}`;
}

// ---------- customers ----------

export function parseNodeCustomers(s: string): NodeCustomerConfig[] {
  if (s.trim() === "") return [];
  return s.split("|").map((custStr) => {
    const parts = custStr.split(";");
    if (parts.length !== 4 && parts.length !== 5 && parts.length !== 6) {
      fail(`Customer must have 4, 5 or 6 ";"-separated params, got ${parts.length}`, custStr);
    }
    // Field 5 (staffAmount) may be blank when only field 6 (customerIndex) is
    // set — the same "blank field between two ;" convention a staff customer's
    // empty dish list already uses.
    const staffAmount =
      parts.length >= 5 && parts[4] !== "" ? parseIntStrict(parts[4], custStr) : undefined;
    const customerIndex =
      parts.length === 6 && parts[5] !== "" ? parseIntStrict(parts[5], custStr) : undefined;
    return {
      typeId: parseIntStrict(parts[0], custStr),
      waitTime: parseIntStrict(parts[1], custStr),
      weatherEff: parseIntStrict(parts[2], custStr),
      // A staff customer orders nothing, so an empty dishes field is legal.
      dishes: parts[3] === "" ? [] : parts[3].split(",").map(parseDish),
      ...(staffAmount !== undefined ? { staffAmount } : {}),
      ...(customerIndex !== undefined ? { customerIndex } : {}),
    };
  });
}

export function serializeNodeCustomers(customers: NodeCustomerConfig[]): string {
  return customers
    .map((c) => {
      const base: (string | number)[] = [
        c.typeId,
        c.waitTime,
        c.weatherEff,
        c.dishes.map(serializeDish).join(","),
      ];
      if (c.customerIndex !== undefined) {
        base.push(c.staffAmount ?? "", c.customerIndex);
      } else if (c.staffAmount !== undefined) {
        base.push(c.staffAmount);
      }
      return base.join(";");
    })
    .join("|");
}

// ---------- walking a parsed dish ----------

/** Every ingredient id in a dish, in traversal order, duplicates preserved. */
export function dishIngredientIds(dish: NodeDish): number[] {
  const out: number[] = [];
  const walk = (node: DishNode): void => {
    for (const member of node.members) {
      if (member.kind === "ingredient") out.push(member.id);
      else walk(member);
    }
  };
  walk(dish.root);
  return out;
}

/** Every bracket in a dish, outermost first. */
export function dishNodes(dish: NodeDish): DishNode[] {
  const out: DishNode[] = [];
  const walk = (node: DishNode): void => {
    out.push(node);
    for (const member of node.members) if (member.kind !== "ingredient") walk(member);
  };
  walk(dish.root);
  return out;
}
