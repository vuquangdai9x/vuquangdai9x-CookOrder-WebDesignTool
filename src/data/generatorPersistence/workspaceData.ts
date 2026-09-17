import { parseNodeCustomers } from "../../core/nodeParser.ts";
import { parseQueueGroups, parseQueues } from "../../core/parser.ts";
import type { GraphIndex } from "../../core/nodeIndex.ts";
import type { IdIndex } from "../nodeIdTable.ts";
import type { LevelData } from "../mapLoader.ts";
import type { ProjectedMap } from "../nodeGraphToMapDef.ts";
import {
  coverageFromLegacyCounts,
  defaultSharedGenerationProfile,
  type GenerationStrategy,
  type SharedGenerationProfileV2,
} from "../../generation/sharedGenerationProfile.ts";
import { parseObstacles } from "../../ui/levelpath/obstacles.ts";
import { parseWeightSet, serializeWeightSet, type WeightSet } from "../../ui/design/ingredientWeightEditor.ts";
import { decodeGeneratorPayload, encodeGeneratorPayload, withPayloadHash } from "./codec.ts";
import { decodeCustomerGeneratorData, customerGeneratorDataFromLevel } from "./customerGeneratorData.ts";

export interface CustomerFirstWorkspaceDraftV2 {
  customerDishesSequence?: string;
  complexityCurve?: string;
  shuffleCurve?: string;
  bagFill?: "min" | "random" | "max";
  /** @deprecated Recovered into shared.dishTypeWeightsByName when reading older gw2 payloads. */
  dishTypeWeightsByName?: Record<string, number>;
}

export interface GeneratorWorkspaceEnvelopeV2 {
  schemaVersion: 2;
  kind: "generator-workspace";
  activeStrategy: GenerationStrategy;
  shared: SharedGenerationProfileV2;
  customerFirst: CustomerFirstWorkspaceDraftV2;
  queueFirst: {
    queuePhaseHash?: string;
    pickupPhaseHash?: string;
    customerPhaseHash?: string;
  };
  migrationWarnings: string[];
  /** Kept only when an old absolute budget could not be converted without guessing. */
  unresolvedLegacyObstacleData?: string;
  contentHash: string;
}

const safe = <T>(read: () => T, fallback: T): T => {
  try { return read(); } catch { return fallback; }
};

function ingredientNameForDataId(projected: ProjectedMap, ix: GraphIndex, dataId: number): string | undefined {
  const dense = projected.denseOf.get(dataId);
  return dense === undefined ? undefined : ix.ingName[dense];
}

function actualGroupSizes(level: LevelData): {
  combined: Partial<Record<2 | 3 | 4 | 5, number>>;
  linked: Partial<Record<2 | 3 | 4 | 5, number>>;
} {
  const out = { combined: {}, linked: {} } as {
    combined: Partial<Record<2 | 3 | 4 | 5, number>>;
    linked: Partial<Record<2 | 3 | 4 | 5, number>>;
  };
  for (const group of safe(() => parseQueueGroups(level.queueString), [])) {
    const size = group.cells.length;
    if (size < 2 || size > 5) continue;
    const bucket = out[group.kind];
    bucket[size as 2 | 3 | 4 | 5] = (bucket[size as 2 | 3 | 4 | 5] ?? 0) + 1;
  }
  return out;
}

export function workspaceEnvelopeFromLevel(
  level: LevelData,
  ix: GraphIndex,
  ids: IdIndex,
  projected: ProjectedMap,
): GeneratorWorkspaceEnvelopeV2 {
  if (level.customerGeneratorData?.startsWith("gw2_")) return decodeGeneratorWorkspaceData(level.customerGeneratorData);

  const pickupableNames = ix.ingName.filter((_, index) => ix.pickupable[index] === 1);
  const dishTypeNames = ix.orderables.map((dense) => ix.compositeName[dense]).filter((name): name is string => !!name);
  const shared = defaultSharedGenerationProfile(pickupableNames, dishTypeNames);
  shared.seed = level.randomSeed;
  const weights = parseWeightSet(level.ingredientWeights ?? "");
  for (const [dataId, weight] of weights.ingredients) {
    const name = ingredientNameForDataId(projected, ix, dataId);
    if (name) shared.ingredientWeightsByName[name] = weight;
  }
  for (const [dataId, range] of weights.amountRanges) {
    const name = ingredientNameForDataId(projected, ix, dataId);
    if (name) shared.amountRangesByName[name] = { ...range };
  }

  const queueSlots = safe(() => parseQueues(level.queueString).reduce((sum, lane) => sum + lane.length, 0), 0);
  const orderingCustomers = safe(() => parseNodeCustomers(level.customerString).filter((customer) => customer.typeId !== 1).length, 0);
  const obstacleMigration = coverageFromLegacyCounts(parseObstacles(level.obstacleData), {
    gridCells: ix.doc.map.gridWidth * ix.doc.map.gridHeight,
    queueSlots,
    orderingCustomers,
  }, actualGroupSizes(level));
  shared.obstacles = obstacleMigration.profile;

  const legacyCustomer = level.customerGeneratorData?.startsWith("cg1_")
    ? decodeCustomerGeneratorData(level.customerGeneratorData)
    : customerGeneratorDataFromLevel(level);
  const dishTypeWeightsByName: Record<string, number> = {};
  if (weights.composites.size > 0) {
    for (const name of dishTypeNames) {
      const dataId = ids.byNode.composite.get(name);
      if (dataId !== undefined) dishTypeWeightsByName[name] = weights.composites.get(dataId) ?? 0;
    }
  }
  if (Object.keys(dishTypeWeightsByName).length) shared.dishTypeWeightsByName = dishTypeWeightsByName;
  const migrationWarnings = [...obstacleMigration.warnings];
  return withPayloadHash({
    schemaVersion: 2 as const,
    kind: "generator-workspace" as const,
    activeStrategy: "customer-first" as const,
    shared,
    customerFirst: {
      customerDishesSequence: legacyCustomer.customerDishesSequence,
      complexityCurve: legacyCustomer.complexityCurve,
      shuffleCurve: legacyCustomer.shuffleCurve,
      bagFill: legacyCustomer.bagFill,
    },
    queueFirst: {},
    migrationWarnings,
    ...(migrationWarnings.length && level.obstacleData ? { unresolvedLegacyObstacleData: level.obstacleData } : {}),
  });
}

export function encodeGeneratorWorkspaceData(data: GeneratorWorkspaceEnvelopeV2): string {
  return encodeGeneratorPayload(refreshGeneratorWorkspaceData(data));
}

export function decodeGeneratorWorkspaceData(source: string): GeneratorWorkspaceEnvelopeV2 {
  return refreshGeneratorWorkspaceData(decodeGeneratorPayload<GeneratorWorkspaceEnvelopeV2>(source, "generator-workspace"));
}

export function refreshGeneratorWorkspaceData(data: GeneratorWorkspaceEnvelopeV2): GeneratorWorkspaceEnvelopeV2 {
  const { contentHash: _old, ...content } = data;
  const legacyDishWeights = content.customerFirst.dishTypeWeightsByName ?? {};
  const { dishTypeWeightsByName: _legacy, ...customerFirst } = content.customerFirst;
  return withPayloadHash({
    ...content,
    shared: {
      ...content.shared,
      dishTypeWeightsByName: {
        ...legacyDishWeights,
        ...(content.shared.dishTypeWeightsByName ?? {}),
      },
    },
    customerFirst,
  });
}

export function applyWorkspaceEnvelopeToLevel(
  level: LevelData,
  data: GeneratorWorkspaceEnvelopeV2,
  ix: GraphIndex,
  ids: IdIndex,
  projected: ProjectedMap,
): GeneratorWorkspaceEnvelopeV2 {
  const refreshed = refreshGeneratorWorkspaceData(data);
  const weights: WeightSet = { ingredients: new Map(), composites: new Map(), amountRanges: new Map() };
  for (const cooked of projected.map.cookedIngredients) {
    const name = ingredientNameForDataId(projected, ix, cooked.id);
    if (!name) continue;
    weights.ingredients.set(cooked.id, refreshed.shared.ingredientWeightsByName[name] ?? 0);
    const range = refreshed.shared.amountRangesByName[name];
    if (range) weights.amountRanges.set(cooked.id, { ...range });
  }
  for (const [name, weight] of Object.entries(refreshed.shared.dishTypeWeightsByName)) {
    const dataId = ids.byNode.composite.get(name);
    if (dataId !== undefined) weights.composites.set(dataId, weight);
  }
  level.ingredientWeights = serializeWeightSet(weights);
  if (refreshed.shared.seed === undefined) delete level.randomSeed;
  else level.randomSeed = refreshed.shared.seed;
  level.customerDishesSequence = refreshed.customerFirst.customerDishesSequence;
  level.complexityCurve = refreshed.customerFirst.complexityCurve;
  level.shuffleCurve = refreshed.customerFirst.shuffleCurve;
  level.bagFill = refreshed.customerFirst.bagFill;
  level.customerGeneratorData = encodeGeneratorPayload(refreshed);
  return refreshed;
}
