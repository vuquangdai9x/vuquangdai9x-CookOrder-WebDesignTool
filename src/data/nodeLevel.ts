// LevelData strings -> a runnable NodeLevelConfig.
//
// The node-graph mirror of mapLoader.ts's toLevelConfig(). Queue and grid
// strings keep their existing grammar and reuse core/parser.ts verbatim; only
// the customer string is parsed by the forked bracket grammar. The integers
// inside are DATA IDS — NodeSimulation resolves them through the map's id table
// when it binds, so nothing here needs the graph.

import { parseGrid, parseQueueGroups, parseQueues } from "../core/parser.ts";
import { parseNodeCustomers } from "../core/nodeParser.ts";
import type { NodeLevelConfig } from "../core/nodeSim.ts";
import type { LevelData } from "./mapLoader.ts";

export function toNodeLevelConfig(d: LevelData): NodeLevelConfig {
  return {
    id: d.id,
    name: d.name,
    weather: d.weather,
    levelTag: d.levelTag,
    featureUnlock: d.featureUnlock,
    shuffleDistance: d.shuffleDistance,
    serveableSlots: d.serveableSlots,
    queues: parseQueues(d.queueString),
    queueGroups: parseQueueGroups(d.queueString),
    grid: parseGrid(d.gridString),
    customers: parseNodeCustomers(d.customerString),
    ...(d.outOfSlotPolicy ? { outOfSlotPolicy: d.outOfSlotPolicy } : {}),
    ...(d.boosterCharges ? { boosterCharges: d.boosterCharges } : {}),
  };
}
