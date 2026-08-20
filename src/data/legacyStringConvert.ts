// Converts one legacy Design string into the current node-graph id space.
//
// This deliberately does not assume that an id-table row kept its original
// number. Graph ids are positional and designers may reorder them, so legacy
// definitions are matched to graph vertices by stable metadata first; the
// target id is then read from the graph's current id table.

import { parseCustomers, parseQueueGroups, parseQueues, serializeQueues } from "../core/parser.ts";
import { serializeNodeCustomers } from "../core/nodeParser.ts";
import type { NodeCustomerConfig } from "../core/nodeParser.ts";
import type { MapDef } from "../core/types.ts";
import { buildIdIndex } from "./nodeIdTable.ts";
import { buildRecogniser, recogniseDish } from "./nodeGraphMigrate.ts";
import type { IngredientVertex, NodeGraphMap } from "./nodeGraphTypes.ts";

type LegacyIngredient = {
  id: number;
  name: string;
  code?: string;
  localImage?: string;
  imageURL?: string;
  fileId?: string;
};

const normalized = (value: string | undefined): string =>
  (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Match definitions without depending on either side's numeric id. Asset and
 * game-code fields are stable across renames; display name is the fallback.
 */
function matchingVertices(
  source: LegacyIngredient,
  vertices: IngredientVertex[],
  pickupOnly: boolean,
): IngredientVertex[] {
  const candidates = pickupOnly ? vertices.filter((v) => v.pickupable) : vertices;
  const exact = (key: "code" | "localImage" | "imageURL" | "fileId") => {
    const value = source[key];
    return value ? candidates.filter((v) => v[key] === value) : [];
  };

  for (const key of ["code", "localImage", "imageURL", "fileId"] as const) {
    const matches = exact(key);
    if (matches.length > 0) return matches;
  }

  const wanted = normalized(source.name);
  return wanted ? candidates.filter((v) => normalized(v.displayName) === wanted) : [];
}

function idMap(
  definitions: LegacyIngredient[],
  target: NodeGraphMap,
  pickupOnly: boolean,
): Map<number, number> {
  const ids = buildIdIndex(target.idTable).byNode.ingredient;
  const result = new Map<number, number>();
  for (const definition of definitions) {
    const matches = matchingVertices(definition, target.vertices.ingredient, pickupOnly)
      .filter((vertex) => ids.has(vertex.name));
    if (matches.length !== 1) continue;
    result.set(definition.id, ids.get(matches[0].name)!);
  }
  return result;
}

function assertSameMap(legacyMap: MapDef, target: NodeGraphMap): void {
  const sameId = normalized(String(legacyMap.id)) === normalized(target.map.id);
  const sameName = normalized(legacyMap.name) === normalized(target.map.name);
  if (!sameId && !sameName) {
    throw new Error(
      `Cannot convert ${legacyMap.name} data into the active ${target.map.name} graph. Open the matching graph first.`,
    );
  }
}

function unmappedError(kind: "raw" | "cooked", ids: number[]): Error {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  return new Error(
    `No unique ${kind}-ingredient match in the current graph for legacy ID${unique.length === 1 ? "" : "s"} ${unique.join(", ")}.`,
  );
}

/** Convert a legacy ingredient-queue string using the target graph's current positional ids. */
export function convertLegacyIngredientQueueString(
  legacyString: string,
  legacyMap: MapDef,
  target: NodeGraphMap,
): string {
  assertSameMap(legacyMap, target);
  const rawIds = idMap(legacyMap.rawIngredients, target, true);
  const missing: number[] = [];
  const queues = parseQueues(legacyString).map((lane) =>
    lane.map((item) => {
      if (item.kind !== "ingredient") return item;
      const id = rawIds.get(item.id);
      if (id === undefined) {
        missing.push(item.id);
        return item;
      }
      return { ...item, id };
    }),
  );
  if (missing.length > 0) throw unmappedError("raw", missing);
  return serializeQueues(queues, parseQueueGroups(legacyString));
}

/**
 * Convert flat legacy customer dishes into bracketed node dishes, remapping
 * every cooked ingredient through the graph's current positional id table.
 */
export function convertLegacyCustomerString(
  legacyString: string,
  legacyMap: MapDef,
  target: NodeGraphMap,
): string {
  assertSameMap(legacyMap, target);
  const cookedIds = idMap(legacyMap.cookedIngredients, target, false);
  const recogniser = buildRecogniser(target);
  const missing: number[] = [];
  const failures: string[] = [];

  const customers: NodeCustomerConfig[] = parseCustomers(legacyString).map((customer, customerIndex) => {
    const dishes = customer.dishes.flatMap((dish, dishIndex) => {
      const mapped = dish.cookedIds.flatMap((legacyId) => {
        const id = cookedIds.get(legacyId);
        if (id === undefined) {
          missing.push(legacyId);
          return [];
        }
        return [id];
      });
      if (mapped.length !== dish.cookedIds.length) return [];
      const result = recogniseDish(recogniser, mapped);
      if ("error" in result) {
        failures.push(`customer ${customerIndex + 1}, dish ${dishIndex + 1}: ${result.error}`);
        return [];
      }
      return [{ ...result.dish, effects: dish.effects }];
    });
    return {
      typeId: customer.typeId,
      waitTime: customer.waitTime,
      weatherEff: customer.weatherEff,
      dishes,
      ...(customer.staffAmount !== undefined ? { staffAmount: customer.staffAmount } : {}),
    };
  });

  if (missing.length > 0) throw unmappedError("cooked", missing);
  if (failures.length > 0) throw new Error(`Could not rebuild ${failures.join("; ")}.`);
  return serializeNodeCustomers(customers);
}
