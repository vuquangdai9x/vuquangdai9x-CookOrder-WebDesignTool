import { parseNodeCustomers, serializeNodeCustomers } from "../core/nodeParser.ts";
import { parseGrid, parseQueueGroups, parseQueues, serializeQueues } from "../core/parser.ts";
import { CELL_COLOR_LOCK } from "../core/effects.ts";
import type { GraphIndex } from "../core/nodeIndex.ts";
import type { IdIndex } from "../data/nodeIdTable.ts";
import type { LevelData } from "../data/mapLoader.ts";
import {
  assignSpecialAvatars,
  assignWaitTimes,
} from "../ui/levelpath/customerRoles.ts";
import { emptyObstacles, placeQueueObstacles } from "../ui/levelpath/obstacles.ts";
import { seededRng } from "../ui/levelpath/generateLevel.ts";
import type { CustomerRole } from "../ui/nodedesign/nodeGenerate.ts";
import { materializeObstacleCoverage, type SharedObstacleCoverageProfile } from "./sharedGenerationProfile.ts";

export interface SharedObstacleFinalizationResult {
  customerString: string;
  queueString: string;
  gridString: string;
  warnings: string[];
}

/** Applies the shared Grid/Customer/lock-key profile after either strategy has produced canonical orders and queue. */
export function finalizeSharedObstacles(input: {
  level: LevelData;
  customerString: string;
  queueString: string;
  profile: SharedObstacleCoverageProfile;
  seed: number;
  ix: GraphIndex;
  ids: IdIndex;
}): SharedObstacleFinalizationResult {
  const warnings: string[] = [];
  const customers = parseNodeCustomers(input.customerString);
  const queues = parseQueues(input.queueString);
  const groups = parseQueueGroups(input.queueString);
  const orderingCustomers = customers.filter((customer) => customer.typeId !== 1).length;
  const queueSlots = queues.reduce((sum, lane) => sum + lane.length, 0);
  const materialized = materializeObstacleCoverage({
    ...input.profile,
    grid: { blocked: 0, orderLock: 0, ingredientLock: 0, lockAndKey: 0 },
  }, {
    gridCells: input.ix.doc.map.gridWidth * input.ix.doc.map.gridHeight,
    queueSlots,
    orderingCustomers,
  });
  warnings.push(...materialized.warnings);

  const roleBudget = materialized.config;
  assignWaitTimes(customers, roleBudget);
  const roles: CustomerRole[] = customers.map(() => "normal");
  const eligible = customers.map((customer, index) => ({ customer, index }))
    .filter(({ customer }) => customer.typeId !== 1 && customer.dishes.length >= 4)
    .map(({ index }) => index);
  const bossWanted = roleBudget.customer.boss;
  for (let count = 0; count < bossWanted && eligible.length > 0; count++) {
    roles[eligible.pop()!] = "boss";
  }
  const shipperWanted = roleBudget.customer.shipper;
  for (let count = 0; count < shipperWanted && eligible.length > 0; count++) {
    roles[eligible.shift()!] = "shipper";
  }
  const bossPlaced = roles.filter((role) => role === "boss").length;
  const shipperPlaced = roles.filter((role) => role === "shipper").length;
  if (bossPlaced < bossWanted) warnings.push(`Applied ${bossPlaced}/${bossWanted} bosses; no additional customer had 4–5 dishes.`);
  if (shipperPlaced < shipperWanted) warnings.push(`Applied ${shipperPlaced}/${shipperWanted} shippers; no additional customer had 4–5 dishes.`);
  assignSpecialAvatars(customers, roles, input.ix.doc.map.id, seededRng(input.seed ^ 0x85ebca6b), (message) => warnings.push(message));

  const random = seededRng(input.seed ^ 0x27d4eb2d);
  const lockColors = parseGrid(input.level.gridString).flatMap((cell) => cell.effects
    .filter((effect) => effect.effectId === CELL_COLOR_LOCK)
    .map((effect) => effect.params[0] ?? 0));

  // Freeze/hidden/groups already affected Queue-first pickup planning (and were
  // already placed by Customer-first). Finalization adds only the paired keys.
  const keyOnly = emptyObstacles();
  const keyed = placeQueueObstacles({
    queueString: input.queueString,
    config: keyOnly,
    lockColors,
    preserveUnkeyedLocks: true,
    rand: random,
  });
  warnings.push(...keyed.warnings);
  const keyedQueues = parseQueues(keyed.queueString);
  const queueString = serializeQueues(keyedQueues, groups);
  return {
    customerString: serializeNodeCustomers(customers),
    queueString,
    gridString: input.level.gridString,
    warnings,
  };
}
