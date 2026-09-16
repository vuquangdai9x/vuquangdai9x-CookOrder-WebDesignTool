import { randomUUID } from "node:crypto";
import type { NodeLevelConfig } from "../core/nodeSim.ts";
import { buildIndex } from "../core/nodeIndex.ts";
import { orderIdIndex, resolveOrder } from "../core/nodeOrder.ts";
import { serializeGrid, serializeQueues } from "../core/parser.ts";
import { serializeNodeCustomers, type NodeCustomerConfig } from "../core/nodeParser.ts";
import type { EffectInstance, QueueGroup, QueueItem } from "../core/types.ts";
import { buildIdIndex } from "../data/nodeIdTable.ts";
import { validateNodeGraph } from "../data/nodeGraphValidate.ts";
import type { NodeGraphMap } from "../data/nodeGraphTypes.ts";
import type { LevelData } from "../data/mapLoader.ts";
import { estimateNodeDifficulty } from "../ui/design/nodeEstimateDifficulty.ts";
import { checkQueueThaw } from "../ui/design/queueThawCheck.ts";
import { checkToolDeadlock } from "../ui/design/toolDeadlockCheck.ts";
import { addToSlot, membersOf, removeFromSlot, slotCapacity, swapInSlot, unmetSlotBase } from "../ui/nodedesign/nodeDishEdit.ts";
import { nodeDemandByRaw } from "../ui/nodedesign/nodeQueueGenerate.ts";
import { interpretLevelBrief } from "./brief.ts";
import { analyzeAmounts, planAmountCompression, planAmountRepairs, type AmountPlanStyle } from "./amountPlanner.ts";
import { activateCandidate, ensureCandidateState, syncActiveCandidate } from "./candidateService.ts";
import { evaluateConstraint, percentile, proportionInterval } from "./constraintEvaluation.ts";
import { constraintMetric, listConstraintMetrics } from "./constraintCatalog.ts";
import { PRODUCTION_BEHAVIOR, PRODUCTION_BEHAVIOR_SEMANTICS_VERSION, productionBehaviorEvidence } from "./productionBehavior.ts";
import { planCustomerDishSkeleton, planQueueSupply, type MissingPickupDemand, type QueueAmountStyle, type QueueLayoutArchetype } from "./generationService.ts";
import { RepositoryAdapter, type AuthoringResources, type ReferenceLevelDataset } from "./repository.ts";
import { analyzeDraftQueueTexture, queueLanesFromDraft, queueSequenceSimilarity } from "./queueTexture.ts";
import { analyzeReferenceDataset, compareQueueToReferences, type ReferenceLevelAnalysis, type ReferenceLevelSelector } from "./referenceLevelAnalysis.ts";
import { confirmRequirements, createRequirementToken, listRequirementDimensions, refineRequirements, type RefineRequirementInput } from "./requirementRefinement.ts";
import { SessionStore } from "./sessionStore.ts";
import { rankExperiments, repairFamilyForMetric } from "./mutationExperiment.ts";
import { batchProgress, planBatchMembers } from "./batchService.ts";
import type {
  AuthoringStrategy,
  ConstraintProgress,
  DraftCustomer,
  DraftDish,
  DraftQueueGroup,
  DraftQueueSlot,
  DeadlockReportRecord,
  EvaluationRecord,
  EvaluationSeedSet,
  MechanicAuthorization,
  MetricConstraint,
  LevelBatchRecord,
  LevelBatchSpec,
  MutationExperimentRecord,
  MutationResult,
  ProposalAction,
  ProposalRecord,
  RefinedLevelRequirements,
  SearchObservationRecord,
  SessionDraft,
  SessionRecord,
  SnapshotScore,
  ValidationFinding,
} from "./types.ts";

type JsonRecord = Record<string, unknown>;

const QUEUE_MECHANIC: Record<number, MechanicAuthorization> = {
  1: "queue:freeze",
  2: "queue:hidden",
  3: "queue:holding-key",
};
const GRID_MECHANIC: Record<number, MechanicAuthorization> = {
  1: "grid:blocked",
  2: "grid:order-lock",
  3: "grid:ingredient-slot",
  4: "grid:color-lock",
};

const now = (): string => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);

function seededRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function derivedSeeds(baseSeed: number, count: number): number[] {
  const random = seededRng(baseSeed);
  return Array.from({ length: count }, () => Math.max(1, Math.floor(random() * 0xffffffff)));
}

function oneLineCsv(values: Array<string | number>): string {
  return values.map((value) => {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(",");
}

function mechanicsForDraft(draft: SessionDraft, resources: AuthoringResources): Set<MechanicAuthorization> {
  const found = new Set<MechanicAuthorization>();
  for (const lane of draft.lanes) for (const slot of lane.slots) for (const effect of slot.effects) {
    const mechanic = QUEUE_MECHANIC[effect.effectId]; if (mechanic) found.add(mechanic);
  }
  for (const cell of draft.grid) for (const effect of cell.effects) {
    const mechanic = GRID_MECHANIC[effect.effectId]; if (mechanic) found.add(mechanic);
  }
  draft.groups.forEach((group) => found.add(`group:${group.kind}` as MechanicAuthorization));
  for (const customer of draft.customers) {
    if (customer.waitTime > 0) found.add("customer:timer");
    if (customer.typeId === 1) found.add("customer:staff");
    const avatar = resources.customers.find((entry) => entry.index === customer.customerIndex);
    const role = avatar?.type.trim().toLowerCase();
    if (role === "boss") found.add("customer:boss");
    if (role === "shipper") found.add("customer:shipper");
    if (customer.dishes.some((dish) => dish.effects.length > 0)) found.add("dish:effect");
  }
  return found;
}

function mechanicCount(draft: SessionDraft, resources: AuthoringResources, mechanic: MechanicAuthorization): number {
  if (mechanic.startsWith("queue:")) {
    const id = Number(Object.entries(QUEUE_MECHANIC).find(([, value]) => value === mechanic)?.[0] ?? -1);
    return draft.lanes.flatMap((lane) => lane.slots).filter((slot) => slot.effects.some((effect) => effect.effectId === id)).length;
  }
  if (mechanic.startsWith("grid:")) {
    const id = Number(Object.entries(GRID_MECHANIC).find(([, value]) => value === mechanic)?.[0] ?? -1);
    return draft.grid.filter((cell) => cell.effects.some((effect) => effect.effectId === id)).length;
  }
  if (mechanic.startsWith("group:")) return draft.groups.filter((group) => `group:${group.kind}` === mechanic).length;
  if (mechanic === "customer:timer") return draft.customers.filter((customer) => customer.waitTime > 0).length;
  if (mechanic === "customer:staff") return draft.customers.filter((customer) => customer.typeId === 1).length;
  if (mechanic === "dish:effect") return draft.customers.flatMap((customer) => customer.dishes).filter((dish) => dish.effects.length > 0).length;
  const role = mechanic.split(":")[1];
  return draft.customers.filter((customer) => resources.customers.find((entry) => entry.index === customer.customerIndex)?.type.trim().toLowerCase() === role).length;
}

function groupCoordinates(draft: SessionDraft, group: DraftQueueGroup): Array<{ x: number; y: number; slotId: string }> {
  const coordinates: Array<{ x: number; y: number; slotId: string }> = [];
  draft.lanes.forEach((lane, x) => lane.slots.forEach((slot, y) => {
    if (group.slotIds.includes(slot.id)) coordinates.push({ x, y, slotId: slot.id });
  }));
  return coordinates;
}

function toNodeCustomers(draft: SessionDraft, resources: AuthoringResources): NodeCustomerConfig[] {
  const bossIndices = new Set(resources.customers.filter((entry) => entry.type.trim().toLowerCase() === "boss").map((entry) => entry.index));
  return draft.customers.map((customer) => ({
    typeId: customer.typeId,
    waitTime: customer.waitTime,
    weatherEff: customer.weatherEff,
    dishes: customer.dishes.map((dish) => ({ root: clone(dish.root), effects: clone(dish.effects) })),
    ...(customer.staffAmount !== undefined ? { staffAmount: customer.staffAmount } : {}),
    ...(customer.customerIndex !== undefined ? { customerIndex: customer.customerIndex } : {}),
    ...(customer.customerIndex !== undefined && bossIndices.has(customer.customerIndex) ? { isBoss: true } : {}),
  }));
}

function toQueueGroups(draft: SessionDraft): QueueGroup[] {
  return draft.groups.map((group) => ({ kind: group.kind, cells: groupCoordinates(draft, group).map(({ x, y }) => ({ x, y })) }));
}

function toNodeLevel(draft: SessionDraft, resources: AuthoringResources): NodeLevelConfig {
  return {
    ...draft.level,
    queues: draft.lanes.map((lane) => lane.slots.map((slot): QueueItem => ({
      kind: "ingredient",
      id: slot.ingredientId,
      effects: clone(slot.effects),
      ...((slot.amount ?? 1) > 1 ? { amount: Math.floor(slot.amount!) } : {}),
    }))),
    queueGroups: toQueueGroups(draft),
    grid: draft.grid.map((cell) => ({ effects: clone(cell.effects) })),
    customers: toNodeCustomers(draft, resources),
  };
}

function serializeDraft(draft: SessionDraft, resources: AuthoringResources): { queueString: string; gridString: string; customerString: string } {
  const level = toNodeLevel(draft, resources);
  return {
    queueString: serializeQueues(level.queues, level.queueGroups),
    gridString: serializeGrid(level.grid),
    customerString: serializeNodeCustomers(level.customers),
  };
}

/** Browser-ready level data for a validated MCP draft. Publishing code shares this exact serializer. */
export function sessionDraftToLevelData(draft: SessionDraft, resources: AuthoringResources): LevelData {
  return { ...draft.level, ...serializeDraft(draft, resources) };
}

function retokenRequirements(requirements: RefinedLevelRequirements): RefinedLevelRequirements {
  const { requirementToken: _oldToken, ...withoutToken } = requirements;
  void _oldToken;
  return { ...withoutToken, requirementToken: createRequirementToken(withoutToken) };
}

function validateMetricConstraint(value: MetricConstraint): void {
  const metric = constraintMetric(value.metric);
  if (!metric) throw new Error(`Unknown constraint metric "${value.metric}". Call list_constraint_metrics first.`);
  if (!metric.operators.includes(value.operator)) throw new Error(`Operator "${value.operator}" is not valid for metric "${value.metric}".`);
  if (!value.id.trim()) throw new Error("Constraint id must not be empty.");
  if (!Number.isFinite(value.weight) || value.weight <= 0) throw new Error(`Constraint "${value.id}" must have a positive finite weight.`);
  if (value.operator === "between" && (!Array.isArray(value.value) || value.value.length !== 2 || value.value.some((item) => typeof item !== "number"))) {
    throw new Error(`Constraint "${value.id}" requires a numeric [minimum, maximum] value for operator between.`);
  }
}

export class LevelAuthoringService {
  readonly repository: RepositoryAdapter;
  readonly store: SessionStore;

  constructor(root = process.cwd(), outputRoot?: string) {
    this.repository = new RepositoryAdapter(root);
    this.store = new SessionStore(root, outputRoot);
  }

  async readAuthoringContext(mapId: string): Promise<JsonRecord> {
    return { ...(await this.repository.readAuthoringContext(mapId)), productionBehavior: productionBehaviorEvidence() };
  }

  async analyzeReferenceLevels(mapId: string, selector: ReferenceLevelSelector = {}): Promise<JsonRecord> {
    const dataset = await this.repository.loadReferenceLevels(mapId);
    return analyzeReferenceDataset(mapId, dataset, selector) as unknown as JsonRecord;
  }

  async analyzeQueueTexture(sessionId: string, candidateId?: string, selector: ReferenceLevelSelector = {}): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId);
    ensureCandidateState(session); syncActiveCandidate(session);
    const candidate = session.candidates?.[candidateId ?? session.activeCandidateId ?? ""];
    if (!candidate) throw new Error(`Unknown candidate "${candidateId}".`);
    const targetLevel = selector.targetLevel ?? candidate.draft.level.id;
    const dataset = await this.repository.loadReferenceLevels(session.mapId);
    const reference = analyzeReferenceDataset(session.mapId, dataset, { ...selector, targetLevel });
    const metrics = analyzeDraftQueueTexture(candidate.draft);
    const comparison = compareQueueToReferences(serializeDraft(candidate.draft, resources).queueString, dataset, reference);
    const targets = reference.recommendedTargets;
    return {
      sessionId,
      candidateId: candidate.id,
      revision: candidate.revision,
      targetLevel,
      metrics,
      reference: {
        referenceProfileId: reference.referenceProfileId,
        sourceFile: reference.sourceFile,
        cohortLevelIds: reference.cohort.map((row) => row.id),
        envelope: reference.envelope,
        recommendedTargets: targets,
        warnings: reference.warnings,
      },
      comparison,
      qualityChecks: {
        amountSlotRatio: metrics.amountSlotRatio >= targets.amountSlotRatio[0] && metrics.amountSlotRatio <= targets.amountSlotRatio[1],
        compactedUnitRatio: metrics.compactedUnitRatio >= targets.compactedUnitRatio[0] && metrics.compactedUnitRatio <= targets.compactedUnitRatio[1],
        adjacentDuplicateRatio: metrics.adjacentDuplicateRatio <= targets.maximumAdjacentDuplicateRatio,
        maxIdenticalRun: metrics.maxIdenticalRun <= targets.maximumIdenticalRun,
        crossLaneCloneRatio: metrics.crossLaneCloneRatio <= targets.maximumCrossLaneCloneRatio,
        transitionEntropy: metrics.transitionEntropy >= targets.minimumTransitionEntropy,
        repeatedNgramRatio: metrics.repeatedNgramRatio <= targets.maximumRepeatedNgramRatio,
        localIngredientDominance: metrics.localIngredientDominance <= targets.maximumLocalIngredientDominance,
        referenceStyleDistance: comparison.referenceStyleDistance <= targets.maximumReferenceStyleDistance,
        originality: comparison.nearestReferenceSimilarity <= targets.maximumNearestReferenceSimilarity,
      },
    };
  }

  compareLevelToReferences(sessionId: string, candidateId?: string, selector: ReferenceLevelSelector = {}): Promise<JsonRecord> {
    return this.analyzeQueueTexture(sessionId, candidateId, selector);
  }

  async inspectOrderable(mapId: string, composite: string): Promise<JsonRecord> {
    const resources = await this.repository.load(mapId);
    const context = await this.repository.readAuthoringContext(mapId);
    const orderables = (context.graph as JsonRecord).orderables as JsonRecord[];
    const found = orderables.find((item) => String(item.name).toLowerCase() === composite.toLowerCase() || String(item.dataId) === composite);
    if (!found) throw new Error(`Orderable "${composite}" was not found on map "${mapId}".`);
    return { contextToken: resources.contextToken, orderable: found };
  }

  async traceIngredient(mapId: string, ingredient: string): Promise<JsonRecord> {
    const resources = await this.repository.load(mapId);
    const ix = buildIndex(resources.doc);
    const ids = buildIdIndex(resources.doc.idTable);
    const dense = ix.ingByName.get(ingredient) ?? ids.byId.ingredient.get(Number(ingredient));
    const ingredientIndex = typeof dense === "number" ? dense : dense ? ix.ingByName.get(dense) : undefined;
    if (ingredientIndex === undefined) throw new Error(`Ingredient "${ingredient}" was not found.`);
    const seen = new Set<number>();
    const steps: unknown[] = [];
    const walk = (current: number): void => {
      if (seen.has(current)) { steps.push({ cycleAt: ix.ingName[current] }); return; }
      seen.add(current);
      const producer = ix.producerOf[current];
      if (!producer) { steps.push({ pickupable: ix.ingName[current], dataId: ids.byNode.ingredient.get(ix.ingName[current]) }); return; }
      steps.push({
        output: ix.ingName[current], tool: ix.toolName[producer.tool], duration: producer.duration,
        amount: producer.amount, chainTools: producer.chainTools.map((tool) => ix.toolName[tool]),
        inputs: producer.inputs.map((input) => ix.ingName[input.ing]),
      });
      producer.inputs.forEach((input) => walk(input.ing));
    };
    walk(ingredientIndex);
    return { ingredient: ix.ingName[ingredientIndex], dataId: ids.byNode.ingredient.get(ix.ingName[ingredientIndex]), steps, contextToken: resources.contextToken };
  }

  async listCustomerAvatars(mapId: string, role?: string): Promise<JsonRecord> {
    const resources = await this.repository.load(mapId);
    const avatars = resources.customers.filter((entry) => entry.mapIndex === resources.mapIndex && (!role || entry.type.toLowerCase() === role.toLowerCase()));
    return { avatars, contextToken: resources.contextToken };
  }

  async explainEffect(mapId: string, scope: "queue" | "grid", effect: string): Promise<JsonRecord> {
    const resources = await this.repository.load(mapId);
    const definitions = scope === "queue" ? resources.queueEffects : resources.gridEffects;
    const definition = definitions.find((item) => item.name.toLowerCase() === effect.toLowerCase() || String(item.id) === effect);
    if (!definition) throw new Error(`Unknown ${scope} effect "${effect}".`);
    return { scope, definition, authorizationRequired: true, contextToken: resources.contextToken };
  }

  explainCustomerRules(): JsonRecord {
    return {
      activeCustomers: "At most two ordering customers may be active, further limited by the six-unit order-zone width.",
      previews: "The next three arrivals show composite identity only, not exact pieces.",
      bosses: "A boss is exclusive while active and acts as a preview barrier; its catalog identity is not silently reordered.",
      ordinaryDefault: "No timers, staff, bosses, or shippers unless the brief or an approved amendment authorizes them.",
    };
  }

  async listRequirementDimensions(mapId: string): Promise<JsonRecord> {
    const resources = await this.repository.load(mapId);
    const dataset = await this.repository.loadReferenceLevels(mapId);
    const reference = analyzeReferenceDataset(mapId, dataset);
    return {
      ...listRequirementDimensions(resources),
      referenceLearning: {
        requiredBeforeAuthoring: true,
        referenceProfileId: reference.referenceProfileId,
        sourceFile: reference.sourceFile,
        availableLevelCount: reference.availableLevelCount,
        recommendedTargets: reference.recommendedTargets,
        warnings: reference.warnings,
      },
    };
  }

  listConstraintMetrics(dimension?: string): JsonRecord {
    return { metrics: listConstraintMetrics(dimension), dimension: dimension ?? null };
  }

  async refineLevelRequirements(mapId: string, input: RefineRequirementInput): Promise<RefinedLevelRequirements> {
    const resources = await this.repository.load(mapId);
    const targetLevel = typeof input.answers?.levelId === "number" ? input.answers.levelId : undefined;
    const dataset = await this.repository.loadReferenceLevels(mapId);
    const reference = analyzeReferenceDataset(mapId, dataset, { ...(targetLevel !== undefined ? { targetLevel } : {}) });
    const requirements = refineRequirements(resources, {
      ...input,
      referenceProfile: {
        id: reference.referenceProfileId,
        sourceFile: reference.sourceFile,
        cohortLevelIds: reference.cohort.map((row) => row.id),
        recommendedTargets: reference.recommendedTargets,
      },
    });
    await this.store.saveRequirements(requirements);
    return requirements;
  }

  async confirmLevelRequirements(requirementToken: string, confirmationNote: string, edits?: { answers?: Record<string, unknown> }): Promise<RefinedLevelRequirements> {
    let current = await this.store.loadRequirements(requirementToken);
    const resources = await this.repository.load(current.mapId);
    if (resources.contextToken !== current.contextToken) throw new Error("The map graph/rules/catalog changed after refinement. Refine the requirements again.");
    if (edits?.answers) {
      const targetLevel = typeof edits.answers.levelId === "number"
        ? edits.answers.levelId
        : (current.dimensions.output as { levelId?: number | null } | undefined)?.levelId ?? undefined;
      const dataset = await this.repository.loadReferenceLevels(current.mapId);
      const reference = analyzeReferenceDataset(current.mapId, dataset, { ...(targetLevel !== undefined ? { targetLevel } : {}) });
      current = refineRequirements(resources, {
        brief: current.originalBrief,
        mode: current.mode,
        answers: edits.answers,
        batchSpec: current.dimensions.batch as Record<string, unknown> | undefined,
        referenceProfile: {
          id: reference.referenceProfileId,
          sourceFile: reference.sourceFile,
          cohortLevelIds: reference.cohort.map((row) => row.id),
          recommendedTargets: reference.recommendedTargets,
        },
      });
    }
    const confirmed = confirmRequirements(current, confirmationNote);
    await this.store.saveRequirements(confirmed);
    return confirmed;
  }

  getRefinedRequirements(requirementToken: string): Promise<RefinedLevelRequirements> {
    return this.store.loadRequirements(requirementToken);
  }

  async interpretLevelBrief(mapId: string, brief: string): Promise<JsonRecord> {
    const legacy = interpretLevelBrief(brief);
    const refinement = await this.refineLevelRequirements(mapId, { brief });
    return { mapId, ...legacy, refinement };
  }

  async startLevelSession(args: { mapId: string; contextToken?: string; brief?: string; requirementToken?: string; metadata?: Partial<SessionDraft["level"]>; sessionId?: string }): Promise<JsonRecord> {
    const resources = await this.repository.load(args.mapId);
    let requirements: RefinedLevelRequirements | undefined;
    if (args.requirementToken) {
      requirements = await this.store.loadRequirements(args.requirementToken);
      if (requirements.mapId !== resources.doc.map.id) throw new Error(`Requirement token belongs to map "${requirements.mapId}", not "${resources.doc.map.id}".`);
      if (requirements.contextToken !== resources.contextToken) throw new Error("The requirement token is stale. Refine the requirements against the current map.");
      if (requirements.confirmationStatus === "draft" || requirements.unresolved.length) throw new Error("Interactive requirements must be confirmed before starting. Call confirm_level_requirements, or explicitly refine with skip_confirmation.");
    } else if (!args.contextToken || resources.contextToken !== args.contextToken) {
      throw new Error("The context_token is stale. Read the authoring context again before starting.");
    }
    if (args.contextToken && resources.contextToken !== args.contextToken) throw new Error("The context_token is stale. Read the authoring context again before starting.");
    const brief = requirements?.originalBrief ?? args.brief;
    if (!brief?.trim()) throw new Error("Provide either a confirmed requirement_token or a non-empty brief.");
    const interpretation = interpretLevelBrief(brief);
    if (interpretation.needsProfileExtension) return { started: false, needsProfileExtension: interpretation.needsProfileExtension };
    const id = args.sessionId ?? `level-${randomUUID().slice(0, 8)}`;
    const createdAt = now();
    const grid = Array.from({ length: resources.doc.map.gridWidth * resources.doc.map.gridHeight }, (_, at) => ({
      id: `grid-${at + 1}`,
      x: at % resources.doc.map.gridWidth,
      y: Math.floor(at / resources.doc.map.gridWidth),
      effects: [],
    }));
    const draft: SessionDraft = {
      level: {
        id: args.metadata?.id ?? 1,
        name: args.metadata?.name ?? "MCP working draft",
        weather: args.metadata?.weather ?? "Normal",
        levelTag: args.metadata?.levelTag ?? "",
        featureUnlock: args.metadata?.featureUnlock ?? "",
        shuffleDistance: args.metadata?.shuffleDistance ?? 0,
        serveableSlots: args.metadata?.serveableSlots ?? 2,
        outOfSlotPolicy: PRODUCTION_BEHAVIOR.outOfSlotPolicy,
        ...(args.metadata?.boosterCharges ? { boosterCharges: args.metadata.boosterCharges } : {}),
      },
      customers: [], lanes: [], groups: [], grid,
    };
    const session: SessionRecord = {
      schemaVersion: 1, id, mapId: resources.doc.map.id, contextToken: resources.contextToken,
      originalBrief: brief, ...(requirements ? { requirements } : {}), interpretation,
      authorizedMechanics: [...(requirements?.authorizedMechanics ?? interpretation.authorizedMechanics)],
      strategyHistory: [], revision: 0, createdAt, updatedAt: createdAt, cycleCount: 0,
      idCounters: { customer: 0, dish: 0, lane: 0, slot: 0, group: 0 }, draft,
      history: [{ revision: 0, draft: clone(draft), ...(requirements ? { requirements: clone(requirements) } : {}), label: "session-start", at: createdAt }],
      validationHistory: [], playtestHistory: [],
    };
    await this.store.create(session);
    const findings: ValidationFinding[] = args.metadata?.outOfSlotPolicy === "block-pick"
      ? [{ severity: "warning", code: "BEHAVIOR_NORMALIZED", message: "outOfSlotPolicy=block-pick was ignored; production evaluation always parks raw items on the grid." }]
      : [];
    return { started: true, sessionId: id, revision: 0, authorizedMechanics: session.authorizedMechanics, constraintProgress: this.constraintProgress(session, resources), findings, productionBehavior: productionBehaviorEvidence() };
  }

  async getSession(sessionId: string): Promise<SessionRecord> { return this.store.load(sessionId); }

  async listLevelCandidates(sessionId: string): Promise<JsonRecord> {
    const session = ensureCandidateState(await this.store.load(sessionId));
    return {
      sessionId,
      activeCandidateId: session.activeCandidateId,
      candidates: Object.values(session.candidates ?? {}).map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        parentId: candidate.parentId ?? null,
        basedOnRevision: candidate.basedOnRevision ?? null,
        revision: candidate.revision,
        status: candidate.status,
        latestEvaluationId: candidate.latestEvaluationId ?? null,
        shape: { customers: candidate.draft.customers.length, lanes: candidate.draft.lanes.length, slots: candidate.draft.lanes.reduce((sum, lane) => sum + lane.slots.length, 0) },
      })),
    };
  }

  async createLevelCandidate(sessionId: string, expectedRevision: number, input: { name: string; fromCandidateId?: string; fromRevision?: number }): Promise<JsonRecord> {
    const session = ensureCandidateState(await this.store.load(sessionId));
    if (session.revision !== expectedRevision) throw new Error(`Revision conflict: expected ${expectedRevision}, current active revision is ${session.revision}.`);
    syncActiveCandidate(session);
    const source = session.candidates?.[input.fromCandidateId ?? session.activeCandidateId ?? ""];
    if (!source) throw new Error(`Unknown source candidate "${input.fromCandidateId}".`);
    const sourceRevision = input.fromRevision ?? source.revision;
    const snapshot = source.history.find((item) => item.revision === sourceRevision);
    if (!snapshot) throw new Error(`Revision ${sourceRevision} is not available on candidate "${source.id}".`);
    const id = `candidate-${randomUUID().slice(0, 8)}`;
    const createdAt = now();
    const candidate = {
      id,
      name: input.name.trim() || "Candidate",
      parentId: source.id,
      basedOnRevision: sourceRevision,
      revision: 0,
      draft: clone(snapshot.draft),
      history: [{ revision: 0, draft: clone(snapshot.draft), ...(snapshot.requirements ? { requirements: clone(snapshot.requirements) } : {}), label: `branched-from:${source.id}@${sourceRevision}`, at: createdAt }],
      idCounters: clone(source.idCounters),
      validationHistory: [],
      playtestHistory: [],
      cycleCount: 0,
      status: "kept" as const,
    };
    session.candidates![id] = candidate;
    session.updatedAt = createdAt;
    await this.store.save(session);
    await this.store.appendAction(sessionId, { at: createdAt, action: "create_level_candidate", candidateId: id, sourceCandidateId: source.id, sourceRevision });
    return { sessionId, candidate, activeCandidateId: session.activeCandidateId };
  }

  async selectLevelCandidate(sessionId: string, expectedRevision: number, candidateId: string): Promise<JsonRecord> {
    const session = ensureCandidateState(await this.store.load(sessionId));
    if (session.revision !== expectedRevision) throw new Error(`Revision conflict: expected ${expectedRevision}, current active revision is ${session.revision}.`);
    const candidate = activateCandidate(session, candidateId);
    session.updatedAt = now();
    await this.store.save(session);
    await this.store.appendAction(sessionId, { at: session.updatedAt, action: "select_level_candidate", candidateId, revision: candidate.revision });
    return { sessionId, candidateId, revision: candidate.revision, draft: clone(candidate.draft) };
  }

  async renameLevelCandidate(sessionId: string, expectedRevision: number, candidateId: string, name: string): Promise<JsonRecord> {
    const session = ensureCandidateState(await this.store.load(sessionId));
    if (session.revision !== expectedRevision) throw new Error(`Revision conflict: expected ${expectedRevision}, current active revision is ${session.revision}.`);
    const candidate = session.candidates?.[candidateId];
    if (!candidate) throw new Error(`Unknown candidate "${candidateId}".`);
    if (!name.trim()) throw new Error("Candidate name must not be empty.");
    candidate.name = name.trim(); session.updatedAt = now();
    await this.store.save(session);
    return { sessionId, candidateId, name: candidate.name };
  }

  async rejectLevelCandidate(sessionId: string, expectedRevision: number, candidateId: string): Promise<JsonRecord> {
    const session = ensureCandidateState(await this.store.load(sessionId));
    if (session.revision !== expectedRevision) throw new Error(`Revision conflict: expected ${expectedRevision}, current active revision is ${session.revision}.`);
    if (candidateId === session.activeCandidateId) throw new Error("Select another candidate before rejecting the active candidate.");
    const candidate = session.candidates?.[candidateId];
    if (!candidate) throw new Error(`Unknown candidate "${candidateId}".`);
    candidate.status = "rejected"; session.updatedAt = now();
    await this.store.save(session);
    return { sessionId, candidateId, status: candidate.status };
  }

  async checkpointCandidate(sessionId: string, candidateId: string, label: string): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId);
    const candidate = session.candidates?.[candidateId];
    if (!candidate) throw new Error(`Unknown candidate "${candidateId}".`);
    const candidateSession = { ...session, draft: clone(candidate.draft), revision: candidate.revision };
    const findings = this.fastFindings(candidateSession, resources);
    const serial = serializeDraft(candidate.draft, resources);
    const report = { label, candidateId, revision: candidate.revision, valid: !findings.some((finding) => finding.severity === "error"), findings, productionBehavior: productionBehaviorEvidence() };
    const files: Record<string, string> = { "draft.json": `${JSON.stringify(candidate.draft, null, 2)}\n`, "report.json": `${JSON.stringify(report, null, 2)}\n` };
    if (report.valid) files["level.csv"] = this.levelCsv(candidateSession, serial);
    const paths = await this.store.writeCandidateVersion(sessionId, candidateId, candidate.revision, files);
    return { sessionId, candidateId, revision: candidate.revision, serializable: report.valid, paths, report };
  }

  async restoreCandidateRevision(sessionId: string, expectedRevision: number, candidateId: string, revision: number): Promise<MutationResult> {
    const session = await this.store.load(sessionId);
    if (session.activeCandidateId !== candidateId) throw new Error("Select the candidate before restoring one of its revisions.");
    return this.restoreRevision(sessionId, expectedRevision, revision);
  }

  async createEvaluationSeedSet(sessionId: string, input: { name?: string; seeds?: number[]; count?: number; baseSeed?: number }): Promise<JsonRecord> {
    const session = ensureCandidateState(await this.store.load(sessionId));
    const count = Math.max(1, Math.min(200, Math.floor(input.count ?? input.seeds?.length ?? 10)));
    const seeds = input.seeds?.length
      ? input.seeds.slice(0, 200).map((seed) => Math.max(1, Math.floor(seed) >>> 0))
      : derivedSeeds(Math.floor(input.baseSeed ?? 0x5eed), count);
    const seedSet: EvaluationSeedSet = { id: `seedset-${randomUUID().slice(0, 8)}`, name: input.name?.trim() || `Seeds ${Object.keys(session.seedSets ?? {}).length + 1}`, seeds, createdAt: now() };
    session.seedSets![seedSet.id] = seedSet;
    const artifactPath = await this.store.writeSeedSet(sessionId, seedSet);
    await this.store.save(session);
    return { sessionId, seedSet, artifactPath };
  }

  async listEvaluationSeedSets(sessionId: string): Promise<JsonRecord> {
    const session = ensureCandidateState(await this.store.load(sessionId));
    return { sessionId, seedSets: Object.values(session.seedSets ?? {}) };
  }

  async evaluateLevel(sessionId: string, input: { candidateId?: string; constraintIds?: string[]; seedSetId?: string; runs?: number; profile?: "fast-shape" | "tuning" | "final" | "custom" }): Promise<EvaluationRecord> {
    const { session, resources } = await this.sessionResources(sessionId);
    ensureCandidateState(session); syncActiveCandidate(session);
    const candidate = session.candidates?.[input.candidateId ?? session.activeCandidateId ?? ""];
    if (!candidate) throw new Error(`Unknown candidate "${input.candidateId}".`);
    const profile = input.profile ?? "tuning";
    const defaultRuns = profile === "fast-shape" ? 3 : profile === "final" ? 50 : 10;
    const requestedRuns = Math.max(1, Math.min(200, Math.floor(input.runs ?? defaultRuns)));
    let seedSet = input.seedSetId ? session.seedSets?.[input.seedSetId] : undefined;
    if (input.seedSetId && !seedSet) throw new Error(`Unknown seed set "${input.seedSetId}".`);
    if (!seedSet) {
      const seedBase = Number.parseInt(createRequirementToken({
        schemaVersion: 1, mapId: session.mapId, mode: "create", originalBrief: `${session.id}:${candidate.id}:${candidate.revision}`,
        assumptions: [], dimensions: {}, constraints: [], authorizedMechanics: [], unresolved: [], confirmationStatus: "skipped", contextToken: session.contextToken,
      }).slice(0, 8), 16);
      seedSet = { id: `seedset-${randomUUID().slice(0, 8)}`, name: `Auto ${candidate.name} r${candidate.revision}`, seeds: derivedSeeds(seedBase, requestedRuns), createdAt: now() };
      session.seedSets![seedSet.id] = seedSet;
      await this.store.writeSeedSet(sessionId, seedSet);
    }
    const seeds = Array.from({ length: requestedRuns }, (_, index) => seedSet!.seeds[index % seedSet!.seeds.length]);
    const candidateSession: SessionRecord = { ...session, draft: clone(candidate.draft), revision: candidate.revision };
    const findings = this.fastFindings(candidateSession, resources);
    const graph = validateNodeGraph(resources.doc);
    graph.errors.forEach((issue) => findings.push({ severity: "error", code: issue.invariantId, message: issue.message }));
    const level = { ...toNodeLevel(candidate.draft, resources), outOfSlotPolicy: PRODUCTION_BEHAVIOR.outOfSlotPolicy };
    const thaw = checkQueueThaw(level.queues, level.queueGroups, { timeBudgetMs: profile === "final" ? 1200 : 400, sampleBudgetMs: profile === "final" ? 800 : 200 });
    if (thaw.verdict === "deadlock") findings.push({ severity: "error", code: "QUEUE_THAW", message: thaw.message });
    const legacy = checkToolDeadlock(buildIndex(resources.doc), level, { randomRuns: profile === "final" ? 60 : 10, budgetMs: profile === "final" ? 1800 : 500, packingMode: PRODUCTION_BEHAVIOR.packingMode, toolProcessBehavior: PRODUCTION_BEHAVIOR.toolProcessBehavior });
    if (legacy.toolBlocked > 0) findings.push({ severity: "error", code: "TOOL_DEADLOCK", message: `${legacy.toolBlocked} legacy diagnostic runs jammed in tool slots.` });
    const estimates = seeds.map((seed) => estimateNodeDifficulty(buildIndex(resources.doc), level, {
      rng: seededRng(seed), maxRetries: profile === "fast-shape" ? 0 : profile === "final" ? 4 : 2,
      packingMode: PRODUCTION_BEHAVIOR.packingMode, toolProcessBehavior: PRODUCTION_BEHAVIOR.toolProcessBehavior,
    }));
    const wins = estimates.filter((estimate) => estimate.solvable && estimate.servedCount === estimate.totalCustomers && estimate.timedOutCustomers.length === 0).length;
    const durations = estimates.map((estimate) => estimate.gameplayDurationSeconds ?? 0);
    const totalPicks = estimates.reduce((sum, estimate) => sum + estimate.totalPicks, 0);
    const randomPicks = estimates.reduce((sum, estimate) => sum + estimate.occupancyHistory.filter((sample) => sample.random).length, 0);
    const detours = estimates.reduce((sum, estimate) => sum + estimate.perCustomer.reduce((subtotal, customer) => subtotal + customer.detours, 0), 0);
    const peakOccupied = Math.max(0, ...estimates.flatMap((estimate) => estimate.occupancyHistory.map((sample) => sample.occupied)));
    const totalUnits = candidate.draft.lanes.flatMap((lane) => lane.slots).reduce((sum, slot) => sum + Math.max(1, slot.amount ?? 1), 0);
    const amountSlots = candidate.draft.lanes.flatMap((lane) => lane.slots).filter((slot) => (slot.amount ?? 1) > 1);
    const amountUnits = amountSlots.reduce((sum, slot) => sum + (slot.amount ?? 1), 0);
    const amounts = candidate.draft.lanes.flatMap((lane) => lane.slots).map((slot) => Math.max(1, slot.amount ?? 1));
    const laneDepths = candidate.draft.lanes.map((lane) => lane.slots.length);
    const supply = this.supplyDemand(candidateSession, resources);
    const supplyRows = (supply.ingredients as Array<{ missing: number; surplus: number }> | undefined) ?? [];
    const exactSupply = supplyRows.every((row) => row.missing === 0 && row.surplus === 0) && !candidate.draft.lanes.some((lane) => lane.slots.some((slot) => slot.provisional));
    const texture = analyzeDraftQueueTexture(candidate.draft);
    const referenceDataset = await this.repository.loadReferenceLevels(session.mapId);
    const reference = analyzeReferenceDataset(session.mapId, referenceDataset, { targetLevel: candidate.draft.level.id });
    const referenceComparison = compareQueueToReferences(serializeDraft(candidate.draft, resources).queueString, referenceDataset, reference);
    const metrics: EvaluationRecord["metrics"] = {
      "fundamental.structuralErrors": findings.filter((finding) => finding.severity === "error").length,
      "fundamental.exactSupply": exactSupply,
      "fundamental.solverVictory": wins === estimates.length,
      "experience.winRate": wins / estimates.length,
      "experience.durationP50": percentile(durations, 0.5),
      "experience.durationP90": percentile(durations, 0.9),
      "experience.randomPickRatio": totalPicks ? randomPicks / totalPicks : 0,
      "experience.detourRatio": totalPicks ? detours / totalPicks : 0,
      "queue.laneCount": candidate.draft.lanes.length,
      "queue.maxDepth": Math.max(0, ...laneDepths),
      "queue.laneBalance": laneDepths.length && Math.max(...laneDepths) > 0 ? 1 - (Math.max(...laneDepths) - Math.min(...laneDepths)) / Math.max(...laneDepths) : 1,
      "queue.pickingOrderStuckRate": thaw.verdict === "deadlock" ? 1 : 0,
      "queue.deadlockReasonDistribution": Object.fromEntries(thaw.reasonCounts.map((row) => [row.reason, row.count])),
      "queue.adjacentDuplicateRatio": texture.adjacentDuplicateRatio,
      "queue.maxIdenticalRun": texture.maxIdenticalRun,
      "queue.crossLaneCloneRatio": texture.crossLaneCloneRatio,
      "queue.transitionEntropy": texture.transitionEntropy,
      "queue.repeatedNgramRatio": texture.repeatedNgramRatio,
      "queue.localIngredientDominance": texture.localIngredientDominance,
      "queue.referenceStyleDistance": referenceComparison.referenceStyleDistance,
      "queue.nearestReferenceSimilarity": referenceComparison.nearestReferenceSimilarity,
      "amount.compactedUnitRatio": totalUnits ? amountUnits / totalUnits : 0,
      "amount.amountSlotRatio": amounts.length ? amountSlots.length / amounts.length : 0,
      "amount.maxAmount": Math.max(1, ...amounts),
      "amount.expandedItemCount": totalUnits,
      "amount.maxDestinationDemand": Math.max(1, ...amounts),
      "amount.maxGridLandingBurst": Math.max(0, ...amounts.map((amount) => amount - 1)),
      "amount.atomicDestinationBlockRate": legacy.randomRuns ? legacy.gridBlocked / (legacy.randomRuns + legacy.runs.length) : 0,
      "grid.usableCells": candidate.draft.grid.filter((cell) => !cell.effects.some((effect) => effect.effectId === 1)).length,
      "grid.peakOccupancy": resources.doc.map.gridWidth * resources.doc.map.gridHeight ? peakOccupied / (resources.doc.map.gridWidth * resources.doc.map.gridHeight) : 0,
      "customers.count": candidate.draft.customers.length,
      "customers.dishCount": candidate.draft.customers.reduce((sum, customer) => sum + customer.dishes.length, 0),
      "content.distinctComposites": new Set(candidate.draft.customers.flatMap((customer) => customer.dishes.map((dish) => dish.composite))).size,
      "pacing.peakConcurrentWork": Math.max(0, ...estimates.map((estimate) => estimate.peakConcurrentWork ?? 0)),
      "mechanics.authorizedCount": session.authorizedMechanics.length,
    };
    const confidenceIntervals = { "experience.winRate": proportionInterval(wins, estimates.length) };
    const selectedConstraints = (session.requirements?.constraints ?? []).filter((constraint) => !input.constraintIds || input.constraintIds.includes(constraint.id));
    const evaluated = selectedConstraints.map((constraint) => evaluateConstraint(constraint, metrics[constraint.metric], constraint.minimumRuns ? Math.min(1, estimates.length / constraint.minimumRuns) : undefined));
    const totalWeight = evaluated.reduce((sum, item) => sum + item.weight, 0);
    const failReasons: Record<string, number> = {};
    estimates.filter((estimate) => !estimate.solvable).forEach((estimate) => { const reason = estimate.loseReason ?? estimate.reason ?? "unsolved"; failReasons[reason] = (failReasons[reason] ?? 0) + 1; });
    const evaluation: EvaluationRecord = {
      id: `evaluation-${randomUUID().slice(0, 8)}`,
      sessionId,
      candidateId: candidate.id,
      revision: candidate.revision,
      contextToken: session.contextToken,
      behaviorSemanticsVersion: PRODUCTION_BEHAVIOR_SEMANTICS_VERSION,
      seedSetId: seedSet.id,
      seeds,
      runs: estimates.length,
      profile,
      createdAt: now(),
      metrics,
      confidenceIntervals,
      constraints: evaluated,
      hardFailures: findings.filter((finding) => finding.severity === "error"),
      failReasons,
      weightedGap: totalWeight ? evaluated.reduce((sum, item) => sum + item.normalizedGap * item.weight, 0) / totalWeight : 0,
      passed: !findings.some((finding) => finding.severity === "error") && evaluated.filter((item) => item.priority === "hard").every((item) => item.pass),
    };
    evaluation.artifactPath = await this.store.writeEvaluation(sessionId, evaluation);
    session.evaluations![evaluation.id] = evaluation;
    candidate.latestEvaluationId = evaluation.id;
    await this.store.save(session);
    return clone(evaluation);
  }

  async getEvaluation(sessionId: string, evaluationId: string): Promise<EvaluationRecord> {
    const session = ensureCandidateState(await this.store.load(sessionId));
    const evaluation = session.evaluations?.[evaluationId];
    if (!evaluation) throw new Error(`Unknown evaluation "${evaluationId}".`);
    return clone(evaluation);
  }

  async compareLevelCandidates(sessionId: string, candidateIds?: string[]): Promise<JsonRecord> {
    const session = ensureCandidateState(await this.store.load(sessionId));
    const candidates = (candidateIds ?? Object.keys(session.candidates ?? {})).map((id) => {
      const candidate = session.candidates?.[id];
      if (!candidate) throw new Error(`Unknown candidate "${id}".`);
      const evaluation = candidate.latestEvaluationId ? session.evaluations?.[candidate.latestEvaluationId] : undefined;
      return { id, name: candidate.name, revision: candidate.revision, status: candidate.status, evaluationId: evaluation?.id ?? null, seedSetId: evaluation?.seedSetId ?? null, passed: evaluation?.passed ?? false, weightedGap: evaluation?.weightedGap ?? null, hardFailureCount: evaluation?.hardFailures.length ?? null };
    });
    const comparable = candidates.filter((candidate) => candidate.weightedGap !== null);
    const seedSetIds = new Set(comparable.map((candidate) => candidate.seedSetId));
    const ranked = [...comparable].sort((a, b) => Number(b.passed) - Number(a.passed) || (a.weightedGap ?? Infinity) - (b.weightedGap ?? Infinity));
    return { sessionId, candidates, ranked, recommendedCandidateId: ranked[0]?.id ?? null, commonSeedSet: seedSetIds.size <= 1, warning: seedSetIds.size > 1 ? "Latest evaluations do not share one seed set; evaluate them on identical seeds before selecting." : null };
  }

  async simulateLevelBatch(sessionId: string, input: { candidateId?: string; seedSetId?: string; seeds?: number[]; runs?: number }): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId);
    ensureCandidateState(session); syncActiveCandidate(session);
    const candidate = session.candidates?.[input.candidateId ?? session.activeCandidateId ?? ""];
    if (!candidate) throw new Error(`Unknown candidate "${input.candidateId}".`);
    const seedSet = input.seedSetId ? session.seedSets?.[input.seedSetId] : undefined;
    if (input.seedSetId && !seedSet) throw new Error(`Unknown seed set "${input.seedSetId}".`);
    const runCount = Math.max(1, Math.min(200, Math.floor(input.runs ?? input.seeds?.length ?? seedSet?.seeds.length ?? 10)));
    const sourceSeeds = input.seeds?.length ? input.seeds : seedSet?.seeds ?? derivedSeeds(0x51a71, runCount);
    const seeds = Array.from({ length: runCount }, (_, index) => Math.max(1, Math.floor(sourceSeeds[index % sourceSeeds.length])));
    const referenceDataset = await this.repository.loadReferenceLevels(session.mapId);
    const reference = analyzeReferenceDataset(session.mapId, referenceDataset, { targetLevel: candidate.draft.level.id });
    const score = this.scoreDraftSnapshot(session, resources, candidate.draft, seeds, { dataset: referenceDataset, analysis: reference });
    return { sessionId, candidateId: candidate.id, revision: candidate.revision, seeds, runs: seeds.length, score, productionBehavior: productionBehaviorEvidence() };
  }

  async analyzeQueuePacing(sessionId: string, candidateId?: string): Promise<JsonRecord> {
    const { session } = await this.sessionResources(sessionId);
    ensureCandidateState(session); syncActiveCandidate(session);
    const candidate = session.candidates?.[candidateId ?? session.activeCandidateId ?? ""];
    if (!candidate) throw new Error(`Unknown candidate "${candidateId}".`);
    const depths = candidate.draft.lanes.map((lane, index) => ({ laneId: lane.id, queue: index + 1, authoredDepth: lane.slots.length, expandedUnits: lane.slots.reduce((sum, slot) => sum + Math.max(1, slot.amount ?? 1), 0) }));
    const maximum = Math.max(0, ...depths.map((lane) => lane.authoredDepth));
    const minimum = depths.length ? Math.min(...depths.map((lane) => lane.authoredDepth)) : 0;
    return {
      sessionId, candidateId: candidate.id, revision: candidate.revision, lanes: depths,
      summary: { laneCount: depths.length, maxDepth: maximum, minDepth: minimum, depthSpread: maximum - minimum, visibleRows: Math.min(maximum, 4), customerCount: candidate.draft.customers.length },
      recommendations: maximum - minimum > 2 ? ["Redistribute later queue slots toward shorter lanes before adding effects."] : [],
    };
  }

  async diagnoseConstraintGaps(sessionId: string, input: { candidateId?: string; evaluationId?: string }): Promise<JsonRecord> {
    const session = ensureCandidateState(await this.store.load(sessionId)); syncActiveCandidate(session);
    const candidate = session.candidates?.[input.candidateId ?? session.activeCandidateId ?? ""];
    if (!candidate) throw new Error(`Unknown candidate "${input.candidateId}".`);
    const evaluation = input.evaluationId ? session.evaluations?.[input.evaluationId] : candidate.latestEvaluationId ? session.evaluations?.[candidate.latestEvaluationId] : undefined;
    if (!evaluation) throw new Error("No evaluation is available for this candidate revision. Run evaluate_level first.");
    if (evaluation.candidateId !== candidate.id) throw new Error(`Evaluation "${evaluation.id}" belongs to candidate "${evaluation.candidateId}".`);
    const gaps = evaluation.constraints.filter((item) => !item.pass).sort((a, b) => Number(b.priority === "hard") - Number(a.priority === "hard") || b.normalizedGap * b.weight - a.normalizedGap * a.weight).map((item) => ({ ...item, repairFamily: repairFamilyForMetric(item.metric) }));
    return { sessionId, candidateId: candidate.id, revision: candidate.revision, evaluationId: evaluation.id, stale: evaluation.revision !== candidate.revision, hardFailures: evaluation.hardFailures, gaps, largestGaps: gaps.slice(0, 5) };
  }

  async evaluateMutationBatch(sessionId: string, input: { expectedRevision: number; candidateId?: string; name?: string; proposalId?: string; actions?: ProposalAction[]; seedSetId?: string; seeds?: number[]; runs?: number }): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId);
    ensureCandidateState(session); syncActiveCandidate(session);
    const candidate = session.candidates?.[input.candidateId ?? session.activeCandidateId ?? ""];
    if (!candidate) throw new Error(`Unknown candidate "${input.candidateId}".`);
    if (candidate.revision !== input.expectedRevision) throw new Error(`Revision conflict: expected ${input.expectedRevision}, current candidate revision is ${candidate.revision}.`);
    const proposal = input.proposalId ? session.proposals?.[input.proposalId] : undefined;
    if (input.proposalId && !proposal) throw new Error(`Unknown proposal "${input.proposalId}".`);
    if (proposal && (proposal.candidateId !== candidate.id || proposal.baseRevision !== candidate.revision || proposal.status !== "pending")) throw new Error("The proposal is stale, applied, discarded, or belongs to another candidate.");
    const actions = clone(input.actions?.length ? input.actions : proposal?.actions ?? []);
    if (!actions.length) throw new Error("A mutation experiment requires at least one action or a non-empty proposal.");
    const seedSet = input.seedSetId ? session.seedSets?.[input.seedSetId] : undefined;
    if (input.seedSetId && !seedSet) throw new Error(`Unknown seed set "${input.seedSetId}".`);
    const runCount = Math.max(1, Math.min(50, Math.floor(input.runs ?? input.seeds?.length ?? seedSet?.seeds.length ?? 3)));
    const sourceSeeds = input.seeds?.length ? input.seeds : seedSet?.seeds ?? derivedSeeds(0xe11a, runCount);
    const seeds = Array.from({ length: runCount }, (_, index) => Math.max(1, Math.floor(sourceSeeds[index % sourceSeeds.length])));
    const virtual: SessionRecord = { ...session, revision: candidate.revision, draft: clone(candidate.draft), history: clone(candidate.history), idCounters: clone(candidate.idCounters) };
    const referenceDataset = await this.repository.loadReferenceLevels(session.mapId);
    const reference = analyzeReferenceDataset(session.mapId, referenceDataset, { targetLevel: candidate.draft.level.id });
    const referenceEvidence = { dataset: referenceDataset, analysis: reference };
    const before = this.scoreDraftSnapshot(session, resources, candidate.draft, seeds, referenceEvidence);
    this.executeProposalActionsInSession(virtual, resources, actions);
    const after = this.scoreDraftSnapshot(session, resources, virtual.draft, seeds, referenceEvidence);
    const experiment: MutationExperimentRecord = {
      id: `experiment-${randomUUID().slice(0, 8)}`,
      name: input.name?.trim() || proposal?.name || `Mutation experiment ${Object.keys(session.experiments ?? {}).length + 1}`,
      candidateId: candidate.id,
      baseRevision: candidate.revision,
      ...(proposal ? { proposalId: proposal.id } : {}),
      actions,
      seeds,
      before,
      after,
      status: "evaluated",
      createdAt: now(),
    };
    experiment.artifactPath = `experiments/${experiment.id}.json`;
    session.experiments![experiment.id] = experiment;
    await this.store.writeExperiment(sessionId, experiment); await this.store.save(session);
    return { sessionId, candidateId: candidate.id, revision: candidate.revision, experiment: clone(experiment), delta: { weightedGap: after.weightedGap - before.weightedGap, hardFailures: after.hardFailures.length - before.hardFailures.length }, candidateMutated: false };
  }

  async rankMutationCandidates(sessionId: string, experimentIds?: string[]): Promise<JsonRecord> {
    const session = ensureCandidateState(await this.store.load(sessionId));
    const experiments = (experimentIds?.length ? experimentIds.map((id) => {
      const experiment = session.experiments?.[id]; if (!experiment) throw new Error(`Unknown experiment "${id}".`); return experiment;
    }) : Object.values(session.experiments ?? {})).filter((item) => item.status === "evaluated");
    const ranked = rankExperiments(experiments);
    const seedSignatures = new Set(ranked.map((item) => item.seeds.join(",")));
    return { sessionId, ranked: ranked.map((item) => ({ id: item.id, name: item.name, candidateId: item.candidateId, baseRevision: item.baseRevision, passed: item.after.passed, hardFailures: item.after.hardFailures.length, weightedGap: item.after.weightedGap, improvement: item.before.weightedGap - item.after.weightedGap })), recommendedExperimentId: ranked[0]?.id ?? null, commonSeeds: seedSignatures.size <= 1, warning: seedSignatures.size > 1 ? "Experiments used different seeds; rerun them on one seed set before applying a winner." : null };
  }

  async getMutationExperiment(sessionId: string, experimentId: string): Promise<JsonRecord> {
    const session = ensureCandidateState(await this.store.load(sessionId)); const experiment = session.experiments?.[experimentId];
    if (!experiment) throw new Error(`Unknown experiment "${experimentId}".`);
    const candidate = session.candidates?.[experiment.candidateId];
    return { sessionId, experiment: clone(experiment), expired: !candidate || candidate.revision !== experiment.baseRevision, expiryReason: !candidate ? "Candidate no longer exists." : candidate.revision !== experiment.baseRevision ? `Candidate revision advanced from ${experiment.baseRevision} to ${candidate.revision}.` : null };
  }

  async applyMutationBatch(sessionId: string, expectedRevision: number, experimentId: string): Promise<MutationResult> {
    const session = ensureCandidateState(await this.store.load(sessionId)); const experiment = session.experiments?.[experimentId];
    if (!experiment) throw new Error(`Unknown experiment "${experimentId}".`);
    if (experiment.status !== "evaluated") throw new Error(`Experiment "${experimentId}" is already ${experiment.status}.`);
    if (session.activeCandidateId !== experiment.candidateId) throw new Error(`Select candidate "${experiment.candidateId}" before applying this experiment.`);
    if (expectedRevision !== experiment.baseRevision || session.revision !== experiment.baseRevision) throw new Error(`Experiment expired: based on revision ${experiment.baseRevision}, current revision is ${session.revision}.`);
    const result = await this.mutate(sessionId, expectedRevision, "apply_mutation_batch", { experimentId, actions: experiment.actions }, (draftSession, resources) => this.executeProposalActionsInSession(draftSession, resources, experiment.actions));
    const updated = await this.store.load(sessionId); const applied = updated.experiments?.[experimentId];
    if (!applied) throw new Error("Experiment state was lost during apply.");
    applied.status = "applied"; applied.appliedRevision = result.revision;
    await this.store.writeExperiment(sessionId, applied); await this.store.save(updated);
    return result;
  }

  async recordSearchObservation(sessionId: string, input: { expectedRevision: number; candidateId?: string; hypothesis: string; beforeEvidence?: string; afterEvidence?: string; disposition: SearchObservationRecord["disposition"]; notes?: string }): Promise<JsonRecord> {
    const session = ensureCandidateState(await this.store.load(sessionId)); syncActiveCandidate(session);
    const candidate = session.candidates?.[input.candidateId ?? session.activeCandidateId ?? ""];
    if (!candidate) throw new Error(`Unknown candidate "${input.candidateId}".`);
    if (candidate.revision !== input.expectedRevision) throw new Error(`Revision conflict: expected ${input.expectedRevision}, current candidate revision is ${candidate.revision}.`);
    const observation: SearchObservationRecord = { id: `observation-${randomUUID().slice(0, 8)}`, candidateId: candidate.id, revision: candidate.revision, hypothesis: input.hypothesis.trim(), ...(input.beforeEvidence ? { beforeEvidence: input.beforeEvidence } : {}), ...(input.afterEvidence ? { afterEvidence: input.afterEvidence } : {}), disposition: input.disposition, ...(input.notes ? { notes: input.notes } : {}), createdAt: now() };
    if (!observation.hypothesis) throw new Error("A search observation requires a hypothesis.");
    session.searchObservations!.push(observation);
    if (session.searchObservations!.length > 200) session.searchObservations = session.searchObservations!.slice(-200);
    const artifactPath = await this.store.appendSearchObservation(sessionId, observation); await this.store.save(session);
    return { sessionId, candidateId: candidate.id, revision: candidate.revision, observation, artifactPath };
  }

  async suggestLevelMutations(sessionId: string, candidateId?: string): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId); ensureCandidateState(session); syncActiveCandidate(session);
    const candidate = session.candidates?.[candidateId ?? session.activeCandidateId ?? ""];
    if (!candidate) throw new Error(`Unknown candidate "${candidateId}".`);
    const candidateSession: SessionRecord = { ...session, draft: clone(candidate.draft), revision: candidate.revision };
    const supply = this.supplyDemand(candidateSession, resources); const amount = analyzeAmounts(buildIndex(resources.doc), candidate.draft);
    const suggestions: unknown[] = [];
    if (!candidate.draft.customers.length) suggestions.push({ family: "skeleton", tool: "propose_level_skeleton", arguments: { session_id: sessionId, candidate_id: candidate.id }, rationale: "The candidate has no customer demand." });
    else if ((supply.missing as unknown[]).length) suggestions.push({ family: "supply", tool: "propose_queue_plan", arguments: { session_id: sessionId, candidate_id: candidate.id }, rationale: "Add exact missing pickup supply from current dish demand." });
    if (amount.slots.some((slot) => !slot.withinStackRange || !slot.capacitySafeOnEmptyGrid)) suggestions.push({ family: "amount", tool: "propose_repair_mutations", arguments: { session_id: sessionId, candidate_id: candidate.id, family: "amount" }, rationale: "Split unsafe atomic amount releases without changing supply." });
    const evaluation = candidate.latestEvaluationId ? session.evaluations?.[candidate.latestEvaluationId] : undefined;
    for (const gap of evaluation?.constraints.filter((item) => !item.pass).slice(0, 5) ?? []) suggestions.push({ family: repairFamilyForMetric(gap.metric), constraintId: gap.constraintId, metric: gap.metric, normalizedGap: gap.normalizedGap, rationale: `Repair the measured ${gap.metric} gap before adding unrelated mechanics.` });
    return { sessionId, candidateId: candidate.id, revision: candidate.revision, suggestions, priorObservations: session.searchObservations!.filter((item) => item.candidateId === candidate.id).slice(-10) };
  }

  async runSearchStep(sessionId: string, input: { expectedRevision: number; candidateId?: string; seedSetId?: string; runs?: number; maxExperiments?: number; budgetMs?: number }): Promise<JsonRecord> {
    const startedAt = Date.now();
    const budgetMs = Math.max(100, Math.min(30_000, Math.floor(input.budgetMs ?? 5_000)));
    const maxExperiments = Math.max(1, Math.min(10, Math.floor(input.maxExperiments ?? 3)));
    let { session, resources } = await this.sessionResources(sessionId); ensureCandidateState(session); syncActiveCandidate(session);
    const candidate = session.candidates?.[input.candidateId ?? session.activeCandidateId ?? ""];
    if (!candidate) throw new Error(`Unknown candidate "${input.candidateId}".`);
    if (candidate.revision !== input.expectedRevision) throw new Error(`Revision conflict: expected ${input.expectedRevision}, current candidate revision is ${candidate.revision}.`);
    const evaluatedProposalIds = new Set(Object.values(session.experiments ?? {}).filter((item) => item.candidateId === candidate.id && item.baseRevision === candidate.revision).map((item) => item.proposalId).filter((id): id is string => Boolean(id)));
    let pending = Object.values(session.proposals ?? {}).filter((proposal) => proposal.candidateId === candidate.id && proposal.baseRevision === candidate.revision && proposal.status === "pending" && proposal.actions.length > 0 && !evaluatedProposalIds.has(proposal.id));
    if (!pending.length) {
      const candidateSession: SessionRecord = { ...session, draft: clone(candidate.draft), revision: candidate.revision };
      const missing = (this.supplyDemand(candidateSession, resources).missing as unknown[]).length;
      const unsafeAmount = analyzeAmounts(buildIndex(resources.doc), candidate.draft).slots.some((slot) => !slot.withinStackRange || !slot.capacitySafeOnEmptyGrid);
      if (!candidate.draft.customers.length) await this.proposeLevelSkeleton(sessionId, { candidateId: candidate.id, seed: candidate.revision + 1 });
      else if (missing) await this.proposeQueuePlan(sessionId, { candidateId: candidate.id, amountStyle: "balanced" });
      else if (unsafeAmount) await this.proposeRepairMutations(sessionId, { candidateId: candidate.id, family: "amount" });
      else await this.proposeAmountPlan(sessionId, { candidateId: candidate.id, styles: ["conservative", "balanced", "aggressive"] });
      ({ session, resources } = await this.sessionResources(sessionId));
      pending = Object.values(session.proposals ?? {}).filter((proposal) => proposal.candidateId === candidate.id && proposal.baseRevision === candidate.revision && proposal.status === "pending" && proposal.actions.length > 0 && !evaluatedProposalIds.has(proposal.id));
    }
    const experiments: MutationExperimentRecord[] = [];
    for (const proposal of pending.slice(0, maxExperiments)) {
      if (Date.now() - startedAt >= budgetMs) break;
      const result = await this.evaluateMutationBatch(sessionId, { expectedRevision: candidate.revision, candidateId: candidate.id, proposalId: proposal.id, seedSetId: input.seedSetId, runs: input.runs ?? 3 });
      experiments.push(result.experiment as unknown as MutationExperimentRecord);
    }
    const ranking = experiments.length ? await this.rankMutationCandidates(sessionId, experiments.map((item) => item.id)) : { ranked: [], recommendedExperimentId: null };
    return { sessionId, candidateId: candidate.id, revision: candidate.revision, evaluatedExperiments: experiments.map((item) => item.id), ranking, exhaustedBudget: Date.now() - startedAt >= budgetMs, elapsedMs: Date.now() - startedAt, candidateMutated: false };
  }

  async runCandidateSearch(sessionId: string, input: { expectedRevision: number; candidateId?: string; seedSetId?: string; runs?: number; maxIterations?: number; maxExperimentsPerStep?: number; budgetMs?: number }): Promise<JsonRecord> {
    const startedAt = Date.now();
    const budgetMs = Math.max(100, Math.min(120_000, Math.floor(input.budgetMs ?? 15_000)));
    const maxIterations = Math.max(1, Math.min(20, Math.floor(input.maxIterations ?? 3)));
    const steps: unknown[] = [];
    for (let iteration = 0; iteration < maxIterations && Date.now() - startedAt < budgetMs; iteration++) {
      const remaining = Math.max(100, budgetMs - (Date.now() - startedAt));
      const step = await this.runSearchStep(sessionId, { expectedRevision: input.expectedRevision, candidateId: input.candidateId, seedSetId: input.seedSetId, runs: input.runs, maxExperiments: input.maxExperimentsPerStep, budgetMs: remaining });
      steps.push(step);
      if (!(step.evaluatedExperiments as string[]).length) break;
    }
    const session = ensureCandidateState(await this.store.load(sessionId));
    const candidateId = input.candidateId ?? session.activeCandidateId!;
    const experiments = Object.values(session.experiments ?? {}).filter((item) => item.candidateId === candidateId && item.baseRevision === input.expectedRevision && item.status === "evaluated");
    const ranked = rankExperiments(experiments);
    return { sessionId, candidateId, revision: input.expectedRevision, iterations: steps.length, steps, recommendedExperimentId: ranked[0]?.id ?? null, evaluatedExperimentCount: experiments.length, exhaustedBudget: Date.now() - startedAt >= budgetMs, elapsedMs: Date.now() - startedAt, candidateMutated: false };
  }

  async startLevelBatch(mapId: string, contextToken: string, spec: LevelBatchSpec, seed?: number): Promise<JsonRecord> {
    const resources = await this.repository.load(mapId);
    if (resources.contextToken !== contextToken) throw new Error("The supplied context token is stale. Read authoring context again before starting the batch.");
    if (!Number.isInteger(spec.levelCount) || spec.levelCount < 1 || spec.levelCount > 100) throw new Error("batch_spec.levelCount must be an integer from 1 to 100.");
    if (spec.authorizedMechanics?.some((mechanic) => !mechanic)) throw new Error("Every scheduled mechanic must be explicitly named in batch_spec.authorizedMechanics.");
    const batch: LevelBatchRecord = { id: `batch-${randomUUID().slice(0, 8)}`, mapId, contextToken, seed: Math.max(1, Math.floor(seed ?? 0x6a09e667)), spec: clone(spec), status: "created", members: [], createdAt: now(), updatedAt: now() };
    await this.store.saveBatch(batch);
    return { batchId: batch.id, status: batch.status, spec: batch.spec, productionBehavior: productionBehaviorEvidence(), nextAction: { tool: "plan_level_batch", arguments: { batch_id: batch.id } } };
  }

  async planLevelBatch(batchId: string): Promise<JsonRecord> {
    const batch = await this.store.loadBatch(batchId);
    if (batch.status === "cancelled" || batch.status === "finalized") throw new Error(`Batch "${batchId}" is ${batch.status}.`);
    if (!batch.members.length) batch.members = planBatchMembers(batch);
    batch.status = "planned"; batch.updatedAt = now(); await this.store.saveBatch(batch);
    return { batchId, status: batch.status, members: batch.members, progress: batchProgress(batch), productionBehavior: productionBehaviorEvidence() };
  }

  async runLevelBatchStep(batchId: string, input: { maxLevels?: number; budgetMs?: number }): Promise<JsonRecord> {
    let batch = await this.store.loadBatch(batchId);
    if (batch.status === "created") { await this.planLevelBatch(batchId); batch = await this.store.loadBatch(batchId); }
    if (batch.status === "cancelled" || batch.status === "finalized") throw new Error(`Batch "${batchId}" is ${batch.status}.`);
    const startedAt = Date.now(); const budgetMs = Math.max(250, Math.min(300_000, Math.floor(input.budgetMs ?? 30_000))); const maxLevels = Math.max(1, Math.min(10, Math.floor(input.maxLevels ?? 1)));
    batch.status = "running"; batch.updatedAt = now(); await this.store.saveBatch(batch);
    let attempted = 0;
    for (const member of batch.members) {
      if (attempted >= maxLevels || Date.now() - startedAt >= budgetMs) break;
      if (!(["planned", "running"] as string[]).includes(member.status)) continue;
      attempted++; member.status = "running"; batch.updatedAt = now(); await this.store.saveBatch(batch);
      try {
        let session: SessionRecord | undefined;
        try { session = await this.getSession(member.sessionId); } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (!session) {
          const brief = `${member.difficulty} batch level with ${member.customerCount} customers, ${member.laneCount} queue lanes, and ${member.amountStyle} amount utilization.`;
          const requirements = await this.refineLevelRequirements(batch.mapId, { brief, mode: "batch", skipConfirmation: true, batchSpec: clone(batch.spec) as unknown as Record<string, unknown>, answers: { difficultyProfile: member.difficulty, customerCount: member.customerCount, queueLaneCount: member.laneCount, amountUtilization: member.amountStyle, validationProfile: batch.spec.validationProfile ?? "fast-shape" } });
          await this.startLevelSession({ mapId: batch.mapId, requirementToken: requirements.requirementToken, sessionId: member.sessionId, metadata: { name: `${batch.spec.outputPrefix ?? "Batch"} ${member.index + 1}` } });
          session = await this.getSession(member.sessionId);
          if (batch.spec.authorizedMechanics?.length) {
            await this.amendSessionRequirements(member.sessionId, session.revision, batch.spec.authorizedMechanics, "Explicitly authorized by the confirmed batch specification.");
            session = await this.getSession(member.sessionId);
          }
        }
        if (session.draft.customers.length === 0) {
          const skeleton = await this.proposeLevelSkeleton(member.sessionId, { customerCount: member.customerCount, dishesPerCustomer: member.dishesPerCustomer, laneCount: member.laneCount, amountStyle: member.amountStyle, seed: member.seed, layoutArchetype: member.layoutArchetype });
          await this.applyProposal(member.sessionId, String((skeleton.proposal as ProposalRecord).id));
          session = await this.getSession(member.sessionId);
        }
        const evaluation = await this.evaluateLevel(member.sessionId, { runs: Math.max(1, Math.min(50, batch.spec.runsPerLevel ?? 3)), profile: batch.spec.validationProfile ?? "fast-shape" });
        member.evaluationId = evaluation.id;
        if (evaluation.passed) {
          const finalized = await this.finalizeLevel(member.sessionId);
          member.finalized = Boolean(finalized.finalized);
          member.status = member.finalized ? "valid" : "invalid";
          const paths = (finalized.checkpoint as { paths?: Record<string, string> } | undefined)?.paths;
          if (paths) member.artifactRefs = Object.values(paths);
        } else { member.finalized = false; member.status = "invalid"; }
      } catch (error) { member.status = "error"; member.error = error instanceof Error ? error.message : String(error); }
      batch.updatedAt = now(); await this.store.saveBatch(batch);
    }
    if (batch.members.every((member) => ["valid", "invalid", "error"].includes(member.status))) batch.status = "complete";
    else batch.status = "running";
    batch.updatedAt = now(); await this.store.saveBatch(batch);
    return { batchId, status: batch.status, attempted, progress: batchProgress(batch), exhaustedBudget: Date.now() - startedAt >= budgetMs, elapsedMs: Date.now() - startedAt, members: batch.members };
  }

  async getLevelBatchStatus(batchId: string): Promise<JsonRecord> {
    const batch = await this.store.loadBatch(batchId);
    return { batchId, mapId: batch.mapId, status: batch.status, progress: batchProgress(batch), members: batch.members, productionBehavior: productionBehaviorEvidence() };
  }

  async compareBatchNovelty(batchId: string): Promise<JsonRecord> {
    const batch = await this.store.loadBatch(batchId);
    const levels = await Promise.all(batch.members
      .filter((member) => member.status === "valid" || member.status === "running")
      .map(async (member) => {
        const session = ensureCandidateState(await this.store.load(member.sessionId));
        return { index: member.index, sessionId: member.sessionId, lanes: queueLanesFromDraft(session.draft), texture: analyzeDraftQueueTexture(session.draft) };
      }));
    const pairs: Array<{ leftIndex: number; rightIndex: number; similarity: number }> = [];
    for (let left = 0; left < levels.length; left++) {
      for (let right = left + 1; right < levels.length; right++) {
        pairs.push({ leftIndex: levels[left].index, rightIndex: levels[right].index, similarity: queueSequenceSimilarity(levels[left].lanes, levels[right].lanes) });
      }
    }
    pairs.sort((left, right) => right.similarity - left.similarity);
    return {
      batchId,
      levelCount: levels.length,
      pairs,
      maximumPairwiseSimilarity: pairs[0]?.similarity ?? 0,
      averagePairwiseSimilarity: pairs.length ? pairs.reduce((sum, pair) => sum + pair.similarity, 0) / pairs.length : 0,
      warnings: pairs.filter((pair) => pair.similarity > 0.65).map((pair) => `Levels ${pair.leftIndex} and ${pair.rightIndex} reuse more than 65% of their queue trigrams.`),
      instruction: "Regenerate the higher-cost member of an over-similar pair with another queue archetype and seed, then re-evaluate it independently.",
    };
  }

  async finalizeLevelBatch(batchId: string): Promise<JsonRecord> {
    const batch = await this.store.loadBatch(batchId);
    if (batch.members.some((member) => member.status === "planned" || member.status === "running")) throw new Error("The batch still has unprocessed levels. Continue run_level_batch_step before finalizing.");
    if (batch.status === "cancelled") throw new Error(`Batch "${batchId}" is cancelled.`);
    batch.status = "finalized"; batch.updatedAt = now(); await this.store.saveBatch(batch);
    const exported = batch.members.filter((member) => member.status === "valid" && member.finalized).map((member) => ({ index: member.index, sessionId: member.sessionId, evaluationId: member.evaluationId, artifactRefs: member.artifactRefs ?? [] }));
    return { batchId, status: batch.status, exported, excluded: batch.members.length - exported.length, note: "Only individually evaluated and finalized levels are exported." };
  }

  async cancelLevelBatch(batchId: string): Promise<JsonRecord> {
    const batch = await this.store.loadBatch(batchId);
    if (batch.status === "finalized") throw new Error(`Batch "${batchId}" is already finalized.`);
    batch.status = "cancelled"; batch.updatedAt = now(); await this.store.saveBatch(batch);
    return { batchId, status: batch.status, progress: batchProgress(batch) };
  }

  async validatePickingDeadlocks(sessionId: string, input: { candidateId?: string; fullCheck?: boolean }): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId);
    ensureCandidateState(session); syncActiveCandidate(session);
    const candidate = session.candidates?.[input.candidateId ?? session.activeCandidateId ?? ""];
    if (!candidate) throw new Error(`Unknown candidate "${input.candidateId}".`);
    const fullCheck = Boolean(input.fullCheck);
    const level = toNodeLevel(candidate.draft, resources);
    const report = checkQueueThaw(level.queues, level.queueGroups, fullCheck
      ? { maxStates: 5_000_000, timeBudgetMs: 10_000, randomRuns: 5_000, sampleBudgetMs: 3_000, maxCases: 50 }
      : { maxStates: 1_000_000, timeBudgetMs: 2_500, randomRuns: 400, sampleBudgetMs: 400, maxCases: 10 });
    const stuckRate = report.randomRuns ? report.randomStuck / report.randomRuns : report.verdict === "deadlock" ? 1 : 0;
    const critical = stuckRate === 0 && report.verdict === "safe"
      ? { level: "none", assessment: "No sampled or exhaustive picking-order deadlock was found." }
      : stuckRate <= 0.05
        ? { level: "low", assessment: "A small share of pick orders can stick; this may be acceptable but should be intentional." }
        : stuckRate <= 0.2
          ? { level: "medium", assessment: "The stuck share is noticeable and may make the level feel unfair." }
          : { level: "high", assessment: "A large share of pick orders stick; players are likely to perceive the queue as unfair." };
    const recommendationCells = report.deadlockCases[0]?.state.flatMap((lane) => lane.filter((cell): cell is NonNullable<typeof cell> => Boolean(cell))).slice(0, 5) ?? [];
    const recommendations = recommendationCells.map((cell) => `Change or move the ingredient in queue ${cell.sourceX + 1}, line ${cell.sourceY + 1} to open a distinct picking path.`);
    const reportId = `deadlock-${randomUUID().slice(0, 8)}`;
    const safeReport = this.jsonSafe({
      reportId,
      candidateId: candidate.id,
      revision: candidate.revision,
      fullCheck,
      queueOnly: true,
      report,
    });
    const artifactPath = await this.store.writeDeadlockReport(sessionId, reportId, safeReport);
    const record: DeadlockReportRecord = { id: reportId, candidateId: candidate.id, revision: candidate.revision, fullCheck, createdAt: now(), verdict: report.verdict, stuckRate, storedCaseCount: report.deadlockCases.length, artifactPath };
    session.deadlockReports![reportId] = record;
    await this.store.save(session);
    return {
      sessionId,
      candidateId: candidate.id,
      revision: candidate.revision,
      reportId,
      conclusion: {
        verdict: report.verdict,
        stuckPercent: Math.round(stuckRate * 10_000) / 100,
        reasonDistribution: report.reasonCounts.map((reason) => ({ reason: reason.reason, count: reason.count, percent: report.randomStuck ? Math.round((reason.count / report.randomStuck) * 10_000) / 100 : 0 })),
        critical,
        recommendations,
        sampledRuns: report.randomRuns,
        storedCases: report.deadlockCases.length,
        caseLimit: fullCheck ? 50 : 10,
        exhaustiveBudgetHit: report.budgetHit,
      },
      artifactPath,
      note: "This diagnostic checks picking order only. Grid, tool, supply, and timeout state are excluded.",
    };
  }

  async getDeadlockCases(sessionId: string, reportId: string): Promise<JsonRecord> {
    const session = ensureCandidateState(await this.store.load(sessionId));
    const metadata = session.deadlockReports?.[reportId];
    if (!metadata) throw new Error(`Unknown deadlock report "${reportId}".`);
    const stored = await this.store.readDeadlockReport(sessionId, reportId) as { report?: { deadlockCases?: unknown[] } };
    return { sessionId, ...metadata, cases: stored.report?.deadlockCases ?? [], queueOnly: true };
  }

  async analyzeAmountUtilization(sessionId: string, candidateId?: string): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId);
    ensureCandidateState(session); syncActiveCandidate(session);
    const candidate = session.candidates?.[candidateId ?? session.activeCandidateId ?? ""];
    if (!candidate) throw new Error(`Unknown candidate "${candidateId}".`);
    const ix = buildIndex(resources.doc);
    const analysis = analyzeAmounts(ix, candidate.draft);
    const candidateSession: SessionRecord = { ...session, draft: clone(candidate.draft), revision: candidate.revision };
    const supply = this.supplyDemand(candidateSession, resources);
    const provenance = new Map(((supply.ingredients as Array<{ ingredient: string; customersAndDishes: unknown[] }> | undefined) ?? []).map((item) => [item.ingredient, item.customersAndDishes]));
    const slots = analysis.slots.map((slot) => ({ ...slot, demandProvenance: provenance.get(slot.ingredient) ?? [] }));
    const latestEvaluation = candidate.latestEvaluationId ? session.evaluations?.[candidate.latestEvaluationId] : undefined;
    return {
      sessionId,
      candidateId: candidate.id,
      revision: candidate.revision,
      productionBehavior: productionBehaviorEvidence(),
      summary: analysis.summary,
      slots,
      warnings: analysis.warnings,
      measuredEvidence: latestEvaluation?.revision === candidate.revision ? {
        evaluationId: latestEvaluation.id,
        atomicDestinationBlockRate: latestEvaluation.metrics["amount.atomicDestinationBlockRate"] ?? null,
        peakOccupancy: latestEvaluation.metrics["grid.peakOccupancy"] ?? null,
      } : null,
      repairTargets: slots.filter((slot) => !slot.withinStackRange || !slot.capacitySafeOnEmptyGrid).map((slot) => ({ slotId: slot.slotId, queue: slot.queue, line: slot.line, actions: ["split_queue_slot", "move_queue_slot"] })),
    };
  }

  async proposeAmountPlan(sessionId: string, input: { candidateId?: string; styles?: AmountPlanStyle[] }): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId);
    ensureCandidateState(session); syncActiveCandidate(session);
    const candidate = session.candidates?.[input.candidateId ?? session.activeCandidateId ?? ""];
    if (!candidate) throw new Error(`Unknown candidate "${input.candidateId}".`);
    const styles = [...new Set(input.styles?.length ? input.styles : ["conservative", "balanced", "aggressive"])] as AmountPlanStyle[];
    const ix = buildIndex(resources.doc);
    const before = analyzeAmounts(ix, candidate.draft);
    const proposals: ProposalRecord[] = [];
    for (const style of styles) {
      const plan = planAmountCompression(ix, candidate.draft, style);
      const deterministicSeed = Number.parseInt(createRequirementToken({
        schemaVersion: 1, mapId: session.mapId, mode: "create", originalBrief: `${session.id}:${candidate.id}:${candidate.revision}:amount:${style}`,
        assumptions: [], dimensions: {}, constraints: [], authorizedMechanics: [], unresolved: [], confirmationStatus: "skipped", contextToken: session.contextToken,
      }).slice(0, 8), 16);
      const proposal: ProposalRecord = {
        id: `proposal-${randomUUID().slice(0, 8)}`,
        kind: "amount-plan",
        name: `${style[0].toUpperCase()}${style.slice(1)} amount compression`,
        candidateId: candidate.id,
        baseRevision: candidate.revision,
        deterministicSeed,
        actions: plan.actions,
        expectedSupplyDelta: {},
        expectedMetricDirections: {
          "amount.compactedUnitRatio": plan.actions.length ? "increase" : "unchanged",
          "amount.amountSlotRatio": plan.actions.length ? "increase" : "unchanged",
          "queue.maxDepth": plan.actions.length ? "decrease" : "unchanged",
          "fundamental.exactSupply": "unchanged",
        },
        authorizationRequirements: [],
        warnings: [
          ...plan.warnings,
          "Capacity checks use the empty-grid upper bound; run evaluate_level after apply to measure actual pick-time destination blocking.",
        ],
        status: "pending",
        createdAt: now(),
        artifactPath: `proposals/proposal-pending.json`,
      };
      proposal.artifactPath = `proposals/${proposal.id}.json`;
      session.proposals![proposal.id] = proposal;
      await this.store.writeProposal(sessionId, proposal);
      proposals.push(clone(proposal));
    }
    await this.store.save(session);
    return {
      sessionId,
      candidateId: candidate.id,
      revision: candidate.revision,
      before: before.summary,
      proposals,
      note: "These proposals only merge consecutive ungrouped, effect-free matching slots. They preserve exact supply and do not claim reusable-object savings.",
    };
  }

  async proposeQueuePlan(sessionId: string, input: { candidateId?: string; laneCount?: number; amountStyle?: QueueAmountStyle; seed?: number; layoutArchetype?: QueueLayoutArchetype }): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId);
    ensureCandidateState(session); syncActiveCandidate(session);
    const candidate = session.candidates?.[input.candidateId ?? session.activeCandidateId ?? ""];
    if (!candidate) throw new Error(`Unknown candidate "${input.candidateId}".`);
    const candidateSession: SessionRecord = { ...session, draft: clone(candidate.draft), revision: candidate.revision };
    const supply = this.supplyDemand(candidateSession, resources);
    const missing = (supply.missing as MissingPickupDemand[] | undefined) ?? [];
    const amountStyle = input.amountStyle ?? "balanced";
    const laneCount = input.laneCount ?? Math.max(1, candidate.draft.lanes.length);
    const layoutArchetype = input.layoutArchetype ?? "staggered-braid";
    const deterministicSeed = input.seed === undefined ? Number.parseInt(createRequirementToken({
      schemaVersion: 1, mapId: session.mapId, mode: "create", originalBrief: `${session.id}:${candidate.id}:${candidate.revision}:queue:${laneCount}:${amountStyle}:${layoutArchetype}`,
      assumptions: [], dimensions: {}, constraints: [], authorizedMechanics: [], unresolved: [], confirmationStatus: "skipped", contextToken: session.contextToken,
    }).slice(0, 8), 16) : Math.max(0, Math.floor(input.seed)) >>> 0;
    const plan = planQueueSupply(buildIndex(resources.doc), candidate.draft, missing, {
      laneCount,
      amountStyle,
      startingLaneCounter: candidate.idCounters.lane,
      startingSlotCounter: candidate.idCounters.slot,
      deterministicSeed,
      layoutArchetype,
    });
    const proposal: ProposalRecord = {
      id: `proposal-${randomUUID().slice(0, 8)}`,
      kind: "queue-plan",
      name: `${layoutArchetype} ${amountStyle} exact-supply queue plan`,
      candidateId: candidate.id,
      baseRevision: candidate.revision,
      deterministicSeed,
      actions: plan.actions,
      expectedSupplyDelta: plan.expectedSupplyDelta,
      expectedMetricDirections: {
        "fundamental.exactSupply": missing.length ? "increase" : "unchanged",
        "queue.laneCount": plan.plannedLaneIds.length > candidate.draft.lanes.length ? "increase" : "unchanged",
        "queue.adjacentDuplicateRatio": "decrease",
        "queue.crossLaneCloneRatio": "decrease",
        "queue.transitionEntropy": "increase",
        "amount.amountSlotRatio": amountStyle === "single-unit" ? "unchanged" : "increase",
      },
      authorizationRequirements: [],
      warnings: plan.warnings,
      status: "pending",
      createdAt: now(),
    };
    proposal.artifactPath = `proposals/${proposal.id}.json`;
    session.proposals![proposal.id] = proposal;
    await this.store.writeProposal(sessionId, proposal); await this.store.save(session);
    return {
      sessionId,
      candidateId: candidate.id,
      revision: candidate.revision,
      proposal: clone(proposal),
      missingDemand: missing,
      plannedLaneIds: plan.plannedLaneIds,
      plannedSlotIds: plan.plannedSlotIds,
      layoutArchetype: plan.layoutArchetype,
      deterministicSeed: plan.deterministicSeed,
      plannedTexture: plan.plannedTexture,
      productionBehavior: productionBehaviorEvidence(),
    };
  }

  async proposeQueueVariants(sessionId: string, input: {
    candidateId?: string;
    laneCount?: number;
    amountStyle?: QueueAmountStyle;
    seeds?: number[];
    archetypes?: QueueLayoutArchetype[];
    candidateCount?: number;
  }): Promise<JsonRecord> {
    const count = Math.max(1, Math.min(12, Math.floor(input.candidateCount ?? 6)));
    const archetypes = [...new Set(input.archetypes?.length ? input.archetypes : ["staggered-braid", "wave-echo", "asymmetric-lanes"])] as QueueLayoutArchetype[];
    const seeds = input.seeds?.length ? input.seeds : derivedSeeds(0xc0ffee, Math.max(2, Math.ceil(count / archetypes.length)));
    const proposals: unknown[] = [];
    for (let index = 0; index < count; index++) {
      const result = await this.proposeQueuePlan(sessionId, {
        candidateId: input.candidateId,
        laneCount: input.laneCount,
        amountStyle: input.amountStyle ?? "balanced",
        layoutArchetype: archetypes[index % archetypes.length],
        seed: seeds[Math.floor(index / archetypes.length) % seeds.length],
      });
      proposals.push({
        proposal: result.proposal,
        layoutArchetype: result.layoutArchetype,
        deterministicSeed: result.deterministicSeed,
        plannedTexture: result.plannedTexture,
      });
    }
    return {
      sessionId,
      candidateId: input.candidateId ?? null,
      proposals,
      comparisonInstruction: "Evaluate every proposal on one shared simulation seed set; rank hard validity first, then reference-guided texture targets and gameplay evidence.",
    };
  }

  proposeCustomerPlan(sessionId: string, input: { candidateId?: string; customerCount?: number; seed?: number }): Promise<JsonRecord> {
    return this.proposeSkeletonPart(sessionId, "customer-plan", input);
  }

  proposeDishPlan(sessionId: string, input: { candidateId?: string; dishesPerCustomer?: number; composites?: string[]; seed?: number }): Promise<JsonRecord> {
    return this.proposeSkeletonPart(sessionId, "dish-plan", input);
  }

  proposeLevelSkeleton(sessionId: string, input: { candidateId?: string; customerCount?: number; dishesPerCustomer?: number; composites?: string[]; laneCount?: number; amountStyle?: QueueAmountStyle; seed?: number; layoutArchetype?: QueueLayoutArchetype }): Promise<JsonRecord> {
    return this.proposeSkeletonPart(sessionId, "skeleton", input);
  }

  async proposeRepairMutations(sessionId: string, input: { candidateId?: string; family?: "amount" }): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId);
    ensureCandidateState(session); syncActiveCandidate(session);
    const candidate = session.candidates?.[input.candidateId ?? session.activeCandidateId ?? ""];
    if (!candidate) throw new Error(`Unknown candidate "${input.candidateId}".`);
    const repair = planAmountRepairs(buildIndex(resources.doc), candidate.draft, candidate.idCounters.slot);
    const proposal: ProposalRecord = {
      id: `proposal-${randomUUID().slice(0, 8)}`,
      kind: "repair",
      name: "Repair unsafe atomic amount releases",
      candidateId: candidate.id,
      baseRevision: candidate.revision,
      deterministicSeed: 0,
      actions: repair.actions,
      expectedSupplyDelta: {},
      expectedMetricDirections: {
        "amount.maxAmount": repair.actions.length ? "decrease" : "unchanged",
        "amount.atomicDestinationBlockRate": repair.actions.length ? "decrease" : "unchanged",
        "amount.expandedItemCount": "unchanged",
        "fundamental.exactSupply": "unchanged",
      },
      authorizationRequirements: [],
      warnings: repair.warnings,
      status: "pending",
      createdAt: now(),
    };
    proposal.artifactPath = `proposals/${proposal.id}.json`;
    session.proposals![proposal.id] = proposal;
    await this.store.writeProposal(sessionId, proposal); await this.store.save(session);
    return { sessionId, candidateId: candidate.id, revision: candidate.revision, proposal: clone(proposal), repairedSlotIds: repair.repairedSlotIds };
  }

  async proposeGridPlan(sessionId: string, input: { candidateId?: string; placements: Array<{ x: number; y: number; effect: EffectInstance }> }): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId); ensureCandidateState(session); syncActiveCandidate(session);
    const candidate = session.candidates?.[input.candidateId ?? session.activeCandidateId ?? ""];
    if (!candidate) throw new Error(`Unknown candidate "${input.candidateId}".`);
    const virtual: SessionRecord = { ...session, revision: candidate.revision, draft: clone(candidate.draft), idCounters: clone(candidate.idCounters) };
    const requirements = new Set<MechanicAuthorization>();
    const actions: ProposalAction[] = input.placements.map((placement) => {
      const mechanic = GRID_MECHANIC[placement.effect.effectId]; if (!mechanic) throw new Error(`Unknown grid effect id ${placement.effect.effectId}.`);
      requirements.add(mechanic); this.validateEffect(resources.gridEffects, placement.effect);
      const cell = this.cell(virtual, resources.doc, placement.x, placement.y);
      return { tool: "set_grid_cell_effect" as const, arguments: clone(placement), expectedResult: { cellId: cell.id } };
    });
    const missing = [...requirements].filter((mechanic) => !session.authorizedMechanics.includes(mechanic));
    const proposal: ProposalRecord = { id: `proposal-${randomUUID().slice(0, 8)}`, kind: "grid-plan", name: "Authorized grid-effect plan", candidateId: candidate.id, baseRevision: candidate.revision, deterministicSeed: 0, actions, expectedSupplyDelta: {}, expectedMetricDirections: { "grid.usableCells": actions.some((action) => action.tool === "set_grid_cell_effect" && action.arguments.effect.effectId === 1) ? "decrease" : "unchanged" }, authorizationRequirements: [...requirements], warnings: missing.length ? [`Blocked until these mechanics are explicitly authorized: ${missing.join(", ")}.`] : [], status: "pending", createdAt: now() };
    proposal.artifactPath = `proposals/${proposal.id}.json`; session.proposals![proposal.id] = proposal; await this.store.writeProposal(sessionId, proposal); await this.store.save(session);
    return { sessionId, candidateId: candidate.id, revision: candidate.revision, proposal: clone(proposal), blocked: missing.length > 0, missingAuthorization: missing };
  }

  async proposeEffectPlan(sessionId: string, input: { candidateId?: string; placements: Array<{ slotId: string; effect: EffectInstance }> }): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId); ensureCandidateState(session); syncActiveCandidate(session);
    const candidate = session.candidates?.[input.candidateId ?? session.activeCandidateId ?? ""];
    if (!candidate) throw new Error(`Unknown candidate "${input.candidateId}".`);
    const virtual: SessionRecord = { ...session, revision: candidate.revision, draft: clone(candidate.draft), idCounters: clone(candidate.idCounters) };
    const requirements = new Set<MechanicAuthorization>();
    const actions: ProposalAction[] = input.placements.map((placement) => {
      const mechanic = QUEUE_MECHANIC[placement.effect.effectId]; if (!mechanic) throw new Error(`Unknown queue effect id ${placement.effect.effectId}.`);
      requirements.add(mechanic); this.validateEffect(resources.queueEffects, placement.effect); this.slot(virtual, placement.slotId);
      return { tool: "set_queue_slot_effect" as const, arguments: clone(placement), expectedResult: { slotId: placement.slotId } };
    });
    const missing = [...requirements].filter((mechanic) => !session.authorizedMechanics.includes(mechanic));
    const proposal: ProposalRecord = { id: `proposal-${randomUUID().slice(0, 8)}`, kind: "effect-plan", name: "Authorized queue-effect plan", candidateId: candidate.id, baseRevision: candidate.revision, deterministicSeed: 0, actions, expectedSupplyDelta: {}, expectedMetricDirections: { "queue.pickingOrderStuckRate": "increase" }, authorizationRequirements: [...requirements], warnings: missing.length ? [`Blocked until these mechanics are explicitly authorized: ${missing.join(", ")}.`] : ["Re-run the queue-only picking-order audit after applying effects."], status: "pending", createdAt: now() };
    proposal.artifactPath = `proposals/${proposal.id}.json`; session.proposals![proposal.id] = proposal; await this.store.writeProposal(sessionId, proposal); await this.store.save(session);
    return { sessionId, candidateId: candidate.id, revision: candidate.revision, proposal: clone(proposal), blocked: missing.length > 0, missingAuthorization: missing };
  }

  async getProposal(sessionId: string, proposalId: string): Promise<JsonRecord> {
    const session = ensureCandidateState(await this.store.load(sessionId));
    const proposal = session.proposals?.[proposalId];
    if (!proposal) throw new Error(`Unknown proposal "${proposalId}".`);
    const current = session.candidates?.[proposal.candidateId];
    const expiryReason = proposal.status === "pending" && (!current || current.revision !== proposal.baseRevision)
      ? !current ? "Candidate no longer exists." : `Candidate revision advanced from ${proposal.baseRevision} to ${current.revision}.`
      : proposal.status === "pending" && session.activeCandidateId !== proposal.candidateId ? "Select the proposal candidate before applying." : null;
    return { sessionId, proposal: clone(proposal), expired: Boolean(expiryReason), expiryReason };
  }

  async discardProposal(sessionId: string, proposalId: string): Promise<JsonRecord> {
    const session = ensureCandidateState(await this.store.load(sessionId));
    const proposal = session.proposals?.[proposalId];
    if (!proposal) throw new Error(`Unknown proposal "${proposalId}".`);
    if (proposal.status !== "pending") throw new Error(`Proposal "${proposalId}" is already ${proposal.status}.`);
    proposal.status = "discarded"; proposal.discardedAt = now(); session.updatedAt = proposal.discardedAt;
    await this.store.writeProposal(sessionId, proposal); await this.store.save(session);
    return { sessionId, proposalId, status: proposal.status };
  }

  async applyProposal(sessionId: string, proposalId: string): Promise<MutationResult> {
    const session = ensureCandidateState(await this.store.load(sessionId));
    const proposal = session.proposals?.[proposalId];
    if (!proposal) throw new Error(`Unknown proposal "${proposalId}".`);
    if (proposal.status !== "pending") throw new Error(`Proposal "${proposalId}" is already ${proposal.status}.`);
    const missingAuthorization = proposal.authorizationRequirements.filter((mechanic) => !session.authorizedMechanics.includes(mechanic));
    if (missingAuthorization.length) throw new Error(`Proposal requires explicit authorization for: ${missingAuthorization.join(", ")}. Amend session requirements first.`);
    if (session.activeCandidateId !== proposal.candidateId) throw new Error(`Select candidate "${proposal.candidateId}" before applying this proposal.`);
    if (session.revision !== proposal.baseRevision) throw new Error(`Proposal expired: based on revision ${proposal.baseRevision}, current revision is ${session.revision}. Regenerate it.`);
    if (!proposal.actions.length) throw new Error(`Proposal "${proposalId}" has no actions to apply.`);
    const result = await this.mutate(sessionId, proposal.baseRevision, "apply_proposal", { proposalId, actions: proposal.actions }, (draftSession, resources) => {
      return this.executeProposalActionsInSession(draftSession, resources, proposal.actions);
    });
    const updated = await this.store.load(sessionId);
    const applied = updated.proposals?.[proposalId];
    if (!applied) throw new Error("Proposal state was lost during apply.");
    applied.status = "applied"; applied.appliedRevision = result.revision;
    await this.store.writeProposal(sessionId, applied); await this.store.save(updated);
    return result;
  }

  async getAuthoringStatus(sessionId: string): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId);
    const currentCandidate = session.candidates?.[session.activeCandidateId ?? ""];
    const latestEvaluation = currentCandidate?.latestEvaluationId ? session.evaluations?.[currentCandidate.latestEvaluationId] : undefined;
    const findings = this.fastFindings(session, resources);
    const supply = this.supplyDemand(session, resources);
    const rows = (supply.ingredients as Array<{ missing?: number; surplus?: number }> | undefined) ?? [];
    const hasSupplyGap = rows.some((row) => (row.missing ?? 0) > 0 || (row.surplus ?? 0) > 0);
    const currentEvaluation = latestEvaluation?.revision === session.revision ? latestEvaluation : undefined;
    const phase = !session.strategy ? "strategy"
      : session.draft.customers.length === 0 || session.draft.lanes.length === 0 ? "skeleton"
      : hasSupplyGap ? "supply"
      : findings.some((finding) => finding.severity === "error") ? "tuning"
      : currentEvaluation?.passed ? "complete"
      : currentEvaluation ? "tuning"
      : "final-verification";
    const nextActions = phase === "strategy"
      ? [{ tool: "plan_authoring_strategy", arguments: { session_id: sessionId }, rationale: "Choose an authoring route from the confirmed constraints.", mutation: false }]
      : phase === "skeleton"
        ? [{ tool: "propose_level_skeleton", arguments: { session_id: sessionId, candidate_id: session.activeCandidateId }, rationale: "Inspect a composed ordinary customer, dish, and exact-supply queue skeleton.", mutation: false }]
        : phase === "supply"
          ? [{ tool: "propose_queue_plan", arguments: { session_id: sessionId, candidate_id: session.activeCandidateId }, rationale: "Repair exact pickup supply with an inspectable queue proposal.", mutation: false }]
          : phase === "tuning"
            ? [{ tool: "suggest_level_mutations", arguments: { session_id: sessionId, candidate_id: session.activeCandidateId }, rationale: "Use measured gaps and prior observations to choose one repair family.", mutation: false }, { tool: "run_search_step", arguments: { session_id: sessionId, expected_revision: session.revision, candidate_id: session.activeCandidateId }, rationale: "Evaluate a bounded repair set without changing the candidate.", mutation: false }]
            : phase === "complete"
              ? [{ tool: "finalize_level", arguments: { session_id: sessionId }, rationale: "Current evaluation passes; run final validation and export the session artifact.", mutation: false }]
              : [{ tool: "evaluate_level", arguments: { session_id: sessionId, candidate_id: session.activeCandidateId, profile: "tuning" }, rationale: "Measure the candidate against confirmed constraints with persisted evidence.", mutation: false }];
    return {
      sessionId,
      revision: session.revision,
      activeCandidate: currentCandidate ? { id: currentCandidate.id, name: currentCandidate.name, revision: currentCandidate.revision, status: currentCandidate.status } : null,
      phase,
      requirements: session.requirements ?? null,
      hardBlockers: findings.filter((finding) => finding.severity === "error"),
      constraintProgress: this.constraintProgress(session, resources),
      largestGaps: (currentEvaluation?.constraints ?? []).filter((item) => !item.pass).sort((a, b) => b.normalizedGap - a.normalizedGap).slice(0, 5).map((item) => ({ ...item, repairFamily: repairFamilyForMetric(item.metric) })),
      staleEvidence: [
        ...session.validationHistory.filter((entry) => entry.revision !== session.revision).map((entry) => `${entry.kind}@r${entry.revision}`),
        ...Object.values(session.evaluations ?? {}).filter((evaluation) => evaluation.candidateId === session.activeCandidateId && evaluation.revision !== session.revision).map((evaluation) => evaluation.id),
        ...Object.values(session.deadlockReports ?? {}).filter((report) => report.candidateId === session.activeCandidateId && report.revision !== session.revision).map((report) => report.id),
      ],
      nextActions,
      recentSearchObservations: session.searchObservations?.filter((item) => item.candidateId === session.activeCandidateId).slice(-5) ?? [],
      pendingExperiments: Object.values(session.experiments ?? {}).filter((item) => item.candidateId === session.activeCandidateId && item.baseRevision === session.revision && item.status === "evaluated").map((item) => ({ id: item.id, name: item.name, passed: item.after.passed, weightedGap: item.after.weightedGap })),
      productionBehavior: productionBehaviorEvidence(),
      iterationBudget: { used: session.cycleCount, maximum: 20 },
    };
  }

  async planAuthoringStrategy(sessionId: string): Promise<JsonRecord> {
    const session = await this.store.load(sessionId);
    const brief = session.originalBrief.toLowerCase();
    const authorized = new Set(session.authorizedMechanics);
    let strategy: AuthoringStrategy = "difficulty-first-hybrid";
    const rationale: string[] = [];
    if ([...authorized].some((item) => item.startsWith("grid:") || item.startsWith("queue:") || item.startsWith("customer:"))) {
      strategy = "board-mechanic-first"; rationale.push("The brief explicitly authorizes a special mechanic whose reachability constrains later demand.");
    } else if (authorized.has("group:combined") || authorized.has("group:linked") || /\b(queue|lane|layout|cluster|coverage|ratio)\b/.test(brief)) {
      strategy = "queue-layout-first"; rationale.push("Queue structure is the most constrained subsystem.");
    } else if (/\b(recipe|dish|ingredient|customer|avatar|progression|serving)\b/.test(brief)) {
      strategy = "demand-first"; rationale.push("Demand and serving flow dominate the brief.");
    } else rationale.push("The brief is primarily experiential, so an ordinary skeleton should be measured before adding structure.");
    return { recommendation: strategy, rationale, advisory: true, obstacleFreeDefault: true };
  }

  async setAuthoringStrategy(sessionId: string, expectedRevision: number, strategy: AuthoringStrategy, rationale: string, evidence: string[] = []): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "set_authoring_strategy", { strategy, rationale, evidence }, (session) => {
      session.strategy = strategy;
      session.strategyHistory.push({ revision: session.revision + 1, strategy, rationale, evidence, at: now() });
      return [session.strategyHistory.at(-1)];
    });
  }

  async amendSessionRequirements(sessionId: string, expectedRevision: number, mechanics: MechanicAuthorization[], approvalNote: string): Promise<MutationResult> {
    if (!approvalNote.trim()) throw new Error("An approval note is required when authorizing a new mechanic.");
    const result = await this.mutate(sessionId, expectedRevision, "amend_session_requirements", { mechanics, approvalNote }, (session) => {
      for (const mechanic of mechanics) if (!session.authorizedMechanics.includes(mechanic)) session.authorizedMechanics.push(mechanic);
      if (session.requirements) {
        for (const mechanic of mechanics) if (!session.requirements.authorizedMechanics.includes(mechanic)) session.requirements.authorizedMechanics.push(mechanic);
        session.requirements.confirmationNote = `${session.requirements.confirmationNote ?? ""}\nMechanic amendment: ${approvalNote}`.trim();
        session.requirements = retokenRequirements(session.requirements);
      }
      return mechanics;
    });
    const updated = await this.store.load(sessionId);
    if (updated.requirements) {
      await this.store.saveRequirements(updated.requirements);
      result.requirementToken = updated.requirements.requirementToken;
    }
    return result;
  }

  async setLevelConstraints(sessionId: string, expectedRevision: number, input: { add?: MetricConstraint[]; update?: Array<{ id: string; patch: Partial<Omit<MetricConstraint, "id">> }>; remove?: string[] }): Promise<MutationResult> {
    const result = await this.mutate(sessionId, expectedRevision, "set_level_constraints", input, (session) => {
      if (!session.requirements) throw new Error("This legacy session has no refined requirement set. Start a guided session to amend measurable constraints.");
      const constraints = session.requirements.constraints;
      const changed: MetricConstraint[] = [];
      for (const item of input.add ?? []) {
        if (constraints.some((constraint) => constraint.id === item.id)) throw new Error(`Constraint id "${item.id}" already exists.`);
        validateMetricConstraint(item);
        constraints.push(clone(item)); changed.push(clone(item));
      }
      for (const change of input.update ?? []) {
        const at = constraints.findIndex((constraint) => constraint.id === change.id);
        if (at < 0) throw new Error(`Unknown constraint id "${change.id}".`);
        const updated = { ...constraints[at], ...clone(change.patch), id: change.id };
        validateMetricConstraint(updated);
        constraints[at] = updated; changed.push(clone(updated));
      }
      for (const id of input.remove ?? []) {
        const at = constraints.findIndex((constraint) => constraint.id === id);
        if (at < 0) throw new Error(`Unknown constraint id "${id}".`);
        changed.push(...constraints.splice(at, 1));
      }
      session.requirements = retokenRequirements(session.requirements);
      return changed;
    });
    const updated = await this.store.load(sessionId);
    if (!updated.requirements) throw new Error("Requirement state was lost after constraint mutation.");
    await this.store.saveRequirements(updated.requirements);
    result.requirementToken = updated.requirements.requirementToken;
    return result;
  }

  proposeObstacleOptions(sessionId: string): Promise<JsonRecord> {
    return this.store.load(sessionId).then((session) => ({
      sessionId,
      readOnly: true,
      options: [
        { mechanic: "queue:hidden", impact: "Raises uncertainty and lane-planning pressure.", risk: "Can turn required choices into guessing." },
        { mechanic: "queue:freeze", impact: "Adds ordering and thaw-path pressure.", risk: "May deadlock without reachable thaw picks." },
        { mechanic: "grid:order-lock", impact: "Reduces early board capacity, then releases it by progress.", risk: "Can overflow before enough orders complete." },
      ].filter((option) => !session.authorizedMechanics.includes(option.mechanic as MechanicAuthorization)),
      requiresUserApproval: true,
    }));
  }

  async setLevelProperties(sessionId: string, expectedRevision: number, properties: Partial<SessionDraft["level"]>): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "set_level_properties", properties, (session) => {
      if (properties.serveableSlots !== undefined && (properties.serveableSlots < 1 || properties.serveableSlots > 2)) {
        throw new Error("serveableSlots must be 1 or 2.");
      }
      session.draft.level = { ...session.draft.level, ...properties };
      return [session.draft.level];
    });
  }

  async addCustomer(sessionId: string, expectedRevision: number, input: Omit<DraftCustomer, "id" | "dishes"> & { position?: number }): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "add_customer", input, (session, resources) => {
      return [this.addCustomerInSession(session, resources, input)];
    });
  }

  async updateCustomer(sessionId: string, expectedRevision: number, customerId: string, update: Partial<Omit<DraftCustomer, "id" | "dishes">>): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "update_customer", { customerId, update }, (session, resources) => {
      const customer = this.customer(session, customerId);
      this.assertCustomerAuthorized(session, resources, { ...customer, ...update });
      Object.assign(customer, update);
      return [customer];
    });
  }

  setCustomerAvatar(sessionId: string, expectedRevision: number, customerId: string, customerIndex: number): Promise<MutationResult> {
    return this.updateCustomer(sessionId, expectedRevision, customerId, { customerIndex });
  }

  async moveCustomer(sessionId: string, expectedRevision: number, customerId: string, position: number): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "move_customer", { customerId, position }, (session) => {
      const from = session.draft.customers.findIndex((item) => item.id === customerId);
      if (from < 0) throw new Error(`Unknown customer "${customerId}".`);
      const [customer] = session.draft.customers.splice(from, 1);
      session.draft.customers.splice(Math.max(0, Math.min(position, session.draft.customers.length)), 0, customer);
      return [customer];
    });
  }

  async removeCustomer(sessionId: string, expectedRevision: number, customerId: string): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "remove_customer", { customerId }, (session) => {
      const at = session.draft.customers.findIndex((item) => item.id === customerId);
      if (at < 0) throw new Error(`Unknown customer "${customerId}".`);
      return session.draft.customers.splice(at, 1);
    });
  }

  async addDish(sessionId: string, expectedRevision: number, customerId: string, composite: string): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "add_dish", { customerId, composite }, (session, resources) => {
      return [this.addDishInSession(session, resources, customerId, composite)];
    });
  }

  async getValidDishPieces(sessionId: string, selector: { dishId?: string; composite?: string }): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId);
    const ix = buildIndex(resources.doc);
    const ids = buildIdIndex(resources.doc.idTable);
    const dish = selector.dishId ? this.dish(session, selector.dishId) : undefined;
    const composite = dish?.composite ?? selector.composite;
    if (!composite) throw new Error("Provide dishId or composite.");
    const orderable = ix.compositeByName.get(composite);
    if (orderable === undefined) throw new Error(`Unknown composite "${composite}".`);
    const root = dish?.root ?? { kind: "composite" as const, id: ids.byNode.composite.get(composite) ?? -1, members: [] };
    return {
      dishId: dish?.id,
      composite,
      slots: (ix.slotsOfComposite[orderable] ?? []).map((slot, slotIndex) => ({
        slotIndex,
        kind: slot.kind,
        group: slot.group < 0 ? undefined : ix.groupName[slot.group],
        groupPath: slot.groupPath.map((group) => ix.groupName[group]),
        minQuantity: slot.minQuantity,
        maxQuantity: slotCapacity(slot),
        isBase: slot.isBase,
        missingPrerequisiteBase: unmetSlotBase(ix, ids, root, orderable, slotIndex) < 0
          ? undefined : ix.compositeName[unmetSlotBase(ix, ids, root, orderable, slotIndex)],
        selected: membersOf(ix, ids, root, orderable, slotIndex).map((ingredient) => ix.ingName[ingredient]),
        options: slot.options.map((ingredient, optionIndex) => ({
          name: ix.ingName[ingredient], dataId: ids.byNode.ingredient.get(ix.ingName[ingredient]), maxQuantity: slot.optionMax[optionIndex],
        })),
      })),
    };
  }

  async addDishPiece(sessionId: string, expectedRevision: number, dishId: string, slotIndex: number, ingredient: string): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "add_dish_piece", { dishId, slotIndex, ingredient }, (session, resources) => {
      return [this.addDishPieceInSession(session, resources, dishId, slotIndex, ingredient)];
    });
  }

  async replaceDishPiece(sessionId: string, expectedRevision: number, dishId: string, slotIndex: number, occurrence: number, ingredient: string): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "replace_dish_piece", { dishId, slotIndex, occurrence, ingredient }, (session, resources) => {
      const dish = this.dish(session, dishId); const ix = buildIndex(resources.doc); const ids = buildIdIndex(resources.doc.idTable);
      const orderable = ix.compositeByName.get(dish.composite); const dense = ix.ingByName.get(ingredient);
      if (orderable === undefined || dense === undefined || !ix.slotsOfComposite[orderable]?.[slotIndex]?.options.includes(dense)) throw new Error("The replacement is not valid for this dish slot.");
      swapInSlot(ix, ids, dish.root, orderable, slotIndex, occurrence, dense); return [dish];
    });
  }

  async removeDishPiece(sessionId: string, expectedRevision: number, dishId: string, slotIndex: number, occurrence: number): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "remove_dish_piece", { dishId, slotIndex, occurrence }, (session, resources) => {
      const dish = this.dish(session, dishId); const ix = buildIndex(resources.doc); const ids = buildIdIndex(resources.doc.idTable);
      const orderable = ix.compositeByName.get(dish.composite); if (orderable === undefined) throw new Error("Unknown dish composite.");
      removeFromSlot(ix, ids, dish.root, orderable, slotIndex, occurrence); return [dish];
    });
  }

  async removeDish(sessionId: string, expectedRevision: number, dishId: string): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "remove_dish", { dishId }, (session) => {
      for (const customer of session.draft.customers) {
        const at = customer.dishes.findIndex((dish) => dish.id === dishId);
        if (at >= 0) return customer.dishes.splice(at, 1);
      }
      throw new Error(`Unknown dish "${dishId}".`);
    });
  }

  async setDishEffect(sessionId: string, expectedRevision: number, dishId: string, effect: EffectInstance): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "set_dish_effect", { dishId, effect }, (session) => {
      this.assertAuthorized(session, "dish:effect"); const dish = this.dish(session, dishId);
      const at = dish.effects.findIndex((item) => item.effectId === effect.effectId); if (at >= 0) dish.effects[at] = effect; else dish.effects.push(effect); return [dish];
    });
  }

  async removeDishEffect(sessionId: string, expectedRevision: number, dishId: string, effectId: number): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "remove_dish_effect", { dishId, effectId }, (session) => {
      const dish = this.dish(session, dishId); dish.effects = dish.effects.filter((effect) => effect.effectId !== effectId); return [dish];
    });
  }

  async addQueueLane(sessionId: string, expectedRevision: number, position?: number): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "add_queue_lane", { position }, (session) => {
      return [this.addQueueLaneInSession(session, position)];
    });
  }

  async removeQueueLane(sessionId: string, expectedRevision: number, laneId: string): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "remove_queue_lane", { laneId }, (session) => {
      const at = session.draft.lanes.findIndex((lane) => lane.id === laneId); if (at < 0) throw new Error(`Unknown lane "${laneId}".`);
      const removed = session.draft.lanes.splice(at, 1);
      const removedSlots = new Set(removed[0].slots.map((slot) => slot.id));
      session.draft.groups = session.draft.groups.map((group) => ({ ...group, slotIds: group.slotIds.filter((id) => !removedSlots.has(id)) })).filter((group) => group.slotIds.length > 1);
      return removed;
    });
  }

  async moveQueueLane(sessionId: string, expectedRevision: number, laneId: string, position: number): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "move_queue_lane", { laneId, position }, (session) => {
      const at = session.draft.lanes.findIndex((lane) => lane.id === laneId); if (at < 0) throw new Error(`Unknown lane "${laneId}".`);
      const [lane] = session.draft.lanes.splice(at, 1); session.draft.lanes.splice(Math.max(0, Math.min(position, session.draft.lanes.length)), 0, lane); return [lane];
    });
  }

  async addQueueIngredient(sessionId: string, expectedRevision: number, input: { laneId: string; position: number; ingredient: string; count?: number; amount?: number; provisional?: boolean }): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "add_queue_ingredient", input, (session, resources) => {
      return this.addQueueIngredientInSession(session, resources, input);
    });
  }

  async replaceQueueIngredient(sessionId: string, expectedRevision: number, slotId: string, ingredient: string, provisional?: boolean): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "replace_queue_ingredient", { slotId, ingredient, provisional }, (session, resources) => {
      const slot = this.slot(session, slotId); const ids = buildIdIndex(resources.doc.idTable); const ix = buildIndex(resources.doc);
      const dense = ix.ingByName.get(ingredient); const name = dense === undefined ? ids.byId.ingredient.get(Number(ingredient)) : ingredient;
      const dataId = name === undefined ? undefined : ids.byNode.ingredient.get(name); const actualDense = name === undefined ? undefined : ix.ingByName.get(name);
      if (name === undefined || dataId === undefined || actualDense === undefined || !ix.pickupable[actualDense]) throw new Error(`"${ingredient}" is not pickupable.`);
      slot.ingredient = name; slot.ingredientId = dataId; if (provisional !== undefined) slot.provisional = provisional; return [slot];
    });
  }

  /** Sets one slot's atomic release count; 1 makes it a single-unit slot. */
  async setQueueSlotAmount(sessionId: string, expectedRevision: number, slotId: string, amount: number): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "set_queue_slot_amount", { slotId, amount }, (session) => {
      const slot = this.slot(session, slotId);
      const n = Math.max(1, Math.floor(amount));
      if (n > 1) slot.amount = n; else delete slot.amount;
      return [slot];
    });
  }

  /** Splits one atomic release in place; the original keeps effects/groups and the remainder is a plain ungrouped slot. */
  async splitQueueSlot(sessionId: string, expectedRevision: number, slotId: string, keepAmount: number): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "split_queue_slot", { slotId, keepAmount }, (session) => {
      return this.splitQueueSlotInSession(session, slotId, keepAmount);
    });
  }

  /** Merges same-ingredient slots into the first id, matching the queue tile menu. */
  async mergeQueueSlots(sessionId: string, expectedRevision: number, slotIds: string[]): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "merge_queue_slots", { slotIds }, (session) => {
      return this.mergeQueueSlotsInSession(session, slotIds);
    });
  }

  async removeQueueSlot(sessionId: string, expectedRevision: number, slotId: string): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "remove_queue_slot", { slotId }, (session) => {
      for (const lane of session.draft.lanes) {
        const at = lane.slots.findIndex((slot) => slot.id === slotId); if (at < 0) continue;
        const removed = lane.slots.splice(at, 1); session.draft.groups.forEach((group) => { group.slotIds = group.slotIds.filter((id) => id !== slotId); });
        session.draft.groups = session.draft.groups.filter((group) => group.slotIds.length > 1); return removed;
      }
      throw new Error(`Unknown queue slot "${slotId}".`);
    });
  }

  async moveQueueSlot(sessionId: string, expectedRevision: number, slotId: string, laneId: string, position: number): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "move_queue_slot", { slotId, laneId, position }, (session) => {
      let moving; for (const lane of session.draft.lanes) { const at = lane.slots.findIndex((slot) => slot.id === slotId); if (at >= 0) [moving] = lane.slots.splice(at, 1); }
      if (!moving) throw new Error(`Unknown queue slot "${slotId}".`); const target = this.lane(session, laneId);
      target.slots.splice(Math.max(0, Math.min(position, target.slots.length)), 0, moving); return [moving];
    });
  }

  async createQueueGroup(sessionId: string, expectedRevision: number, kind: "combined" | "linked", slotIds: string[]): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "create_queue_group", { kind, slotIds }, (session) => {
      this.assertAuthorized(session, `group:${kind}` as MechanicAuthorization); if (slotIds.length < 2) throw new Error("A queue group requires at least two slots.");
      slotIds.forEach((id) => this.slot(session, id)); const group = { id: this.nextId(session, "group"), kind, slotIds: [...new Set(slotIds)] };
      session.draft.groups.push(group); return [group];
    });
  }

  async updateQueueGroup(sessionId: string, expectedRevision: number, groupId: string, update: { kind?: "combined" | "linked"; slotIds?: string[] }): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "update_queue_group", { groupId, update }, (session) => {
      const group = this.group(session, groupId); const kind = update.kind ?? group.kind; this.assertAuthorized(session, `group:${kind}` as MechanicAuthorization);
      if (update.slotIds) { if (update.slotIds.length < 2) throw new Error("A queue group requires at least two slots."); update.slotIds.forEach((id) => this.slot(session, id)); }
      Object.assign(group, update, update.slotIds ? { slotIds: [...new Set(update.slotIds)] } : {}); return [group];
    });
  }

  async removeQueueGroup(sessionId: string, expectedRevision: number, groupId: string): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "remove_queue_group", { groupId }, (session) => {
      const at = session.draft.groups.findIndex((group) => group.id === groupId); if (at < 0) throw new Error(`Unknown group "${groupId}".`); return session.draft.groups.splice(at, 1);
    });
  }

  async setQueueSlotEffect(sessionId: string, expectedRevision: number, slotId: string, effect: EffectInstance): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "set_queue_slot_effect", { slotId, effect }, (session, resources) => {
      return [this.setQueueSlotEffectInSession(session, resources, slotId, effect)];
    });
  }

  async removeQueueSlotEffect(sessionId: string, expectedRevision: number, slotId: string, effectId: number): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "remove_queue_slot_effect", { slotId, effectId }, (session) => {
      const slot = this.slot(session, slotId); slot.effects = slot.effects.filter((effect) => effect.effectId !== effectId); return [slot];
    });
  }

  async setGridCellEffect(sessionId: string, expectedRevision: number, x: number, y: number, effect: EffectInstance): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "set_grid_cell_effect", { x, y, effect }, (session, resources) => {
      return [this.setGridCellEffectInSession(session, resources, x, y, effect)];
    });
  }

  async clearGridCellEffect(sessionId: string, expectedRevision: number, x: number, y: number, effectId?: number): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "clear_grid_cell_effect", { x, y, effectId }, (session, resources) => {
      const cell = this.cell(session, resources.doc, x, y); cell.effects = effectId === undefined ? [] : cell.effects.filter((effect) => effect.effectId !== effectId); return [cell];
    });
  }

  async moveGridCellEffect(sessionId: string, expectedRevision: number, from: { x: number; y: number }, to: { x: number; y: number }, effectId: number): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "move_grid_cell_effect", { from, to, effectId }, (session, resources) => {
      const source = this.cell(session, resources.doc, from.x, from.y); const target = this.cell(session, resources.doc, to.x, to.y);
      const at = source.effects.findIndex((effect) => effect.effectId === effectId); if (at < 0) throw new Error("The source cell does not contain that effect.");
      const [effect] = source.effects.splice(at, 1); target.effects = target.effects.filter((item) => item.effectId !== effectId); target.effects.push(effect); return [source, target];
    });
  }

  async getSupplyDemand(sessionId: string): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId);
    return this.supplyDemand(session, resources);
  }

  async validateDraft(sessionId: string): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId);
    const findings = this.fastFindings(session, resources);
    const result = { revision: session.revision, valid: !findings.some((item) => item.severity === "error"), findings, constraintProgress: this.constraintProgress(session, resources), supplyDemand: this.supplyDemand(session, resources) };
    session.validationHistory.push({ revision: session.revision, kind: "draft", result, at: now() }); await this.store.save(session); return result;
  }

  async validateLevel(sessionId: string): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId); const findings = this.fastFindings(session, resources);
    const graph = validateNodeGraph(resources.doc);
    graph.errors.forEach((issue) => findings.push({ severity: "error", code: issue.invariantId, message: issue.message }));
    graph.warnings.forEach((issue) => findings.push({ severity: "warning", code: issue.invariantId, message: issue.message }));
    const level = { ...toNodeLevel(session.draft, resources), outOfSlotPolicy: PRODUCTION_BEHAVIOR.outOfSlotPolicy };
    const thaw = checkQueueThaw(level.queues, level.queueGroups, { timeBudgetMs: 400, sampleBudgetMs: 200 });
    if (thaw.verdict !== "safe") findings.push({ severity: thaw.verdict === "deadlock" ? "error" : "warning", code: "QUEUE_THAW", message: thaw.message, repair: "Move a thaw-enabling pickup earlier or reduce the blocking freeze count." });
    const tools = checkToolDeadlock(buildIndex(resources.doc), level, { randomRuns: 20, budgetMs: 600, packingMode: PRODUCTION_BEHAVIOR.packingMode, toolProcessBehavior: PRODUCTION_BEHAVIOR.toolProcessBehavior });
    if (tools.toolBlocked > 0) findings.push({ severity: "error", code: "TOOL_DEADLOCK", message: `${tools.toolBlocked} sampled runs jammed in tool or preservation slots.`, repair: "Reorder inputs so occupied tools and preservation slots can drain." });
    if (tools.gridBlocked > 0) findings.push({ severity: "warning", code: "GRID_CAPACITY_BLOCK", message: `${tools.gridBlocked} sampled runs exhausted grid destinations. This is capacity evidence, not a picking-order deadlock.`, repair: "Split or move atomic amount releases, or free usable grid capacity." });
    const result = { revision: session.revision, valid: !findings.some((item) => item.severity === "error"), findings, thaw: this.jsonSafe(thaw), toolDeadlock: this.jsonSafe(tools), legacyToolGridDiagnostic: this.jsonSafe(tools), productionBehavior: productionBehaviorEvidence(), constraintProgress: this.constraintProgress(session, resources) };
    session.validationHistory.push({ revision: session.revision, kind: "full", result, at: now() }); await this.store.save(session); return result;
  }

  async estimateDifficulty(sessionId: string): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId); const estimate = estimateNodeDifficulty(buildIndex(resources.doc), toNodeLevel(session.draft, resources), { maxRetries: 2, packingMode: PRODUCTION_BEHAVIOR.packingMode, toolProcessBehavior: PRODUCTION_BEHAVIOR.toolProcessBehavior });
    const metrics = this.estimateMetrics(estimate); const profile = session.interpretation.difficultyProfile;
    const thresholdResults = profile ? Object.entries(profile.thresholds).map(([metric, threshold]) => {
      const value = metrics[metric] as number | undefined; return { metric, value, ...threshold, pass: value !== undefined && (threshold.min === undefined || value >= threshold.min) && (threshold.max === undefined || value <= threshold.max) };
    }) : [];
    const result = { revision: session.revision, metrics, thresholdResults, estimate: this.jsonSafe(estimate), productionBehavior: productionBehaviorEvidence() };
    session.validationHistory.push({ revision: session.revision, kind: "estimate", result, at: now() }); await this.store.save(session); return result;
  }

  async playtestInstant(sessionId: string): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId); const estimate = estimateNodeDifficulty(buildIndex(resources.doc), toNodeLevel(session.draft, resources), { maxRetries: 4, packingMode: PRODUCTION_BEHAVIOR.packingMode, toolProcessBehavior: PRODUCTION_BEHAVIOR.toolProcessBehavior });
    if (session.cycleCount >= 20) throw new Error("The session has reached the 20-cycle authoring limit. Report the remaining blocker instead of continuing to loop.");
    const result = {
      revision: session.revision, win: estimate.solvable && estimate.servedCount === estimate.totalCustomers && estimate.timedOutCustomers.length === 0,
      loseReason: estimate.loseReason ?? null, reason: estimate.reason,
      gameplayDurationSeconds: estimate.gameplayDurationSeconds ?? 0, picks: estimate.totalPicks,
      servedCustomers: estimate.servedCount, totalCustomers: estimate.totalCustomers, timedOutCustomers: estimate.timedOutCustomers,
      laneDecisions: estimate.replaySteps, occupancyHistory: estimate.occupancyHistory,
      peakConcurrentWork: estimate.peakConcurrentWork ?? 0, replaySteps: estimate.replaySteps,
      lastPlayableState: estimate.solvable ? undefined : { failureCustomers: estimate.failureCustomers, failureKnowledge: estimate.failureKnowledge },
      productionBehavior: productionBehaviorEvidence(),
    };
    session.playtestHistory.push({ revision: session.revision, result, at: now() }); session.cycleCount++; await this.store.save(session); return result;
  }

  async checkpointLevel(sessionId: string, label: string): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId); const validation = await this.validateDraft(sessionId);
    const serial = serializeDraft(session.draft, resources); const report = { label, revision: session.revision, validation, constraintProgress: this.constraintProgress(session, resources) };
    const files: Record<string, string> = { "draft.json": `${JSON.stringify(session.draft, null, 2)}\n`, "report.json": `${JSON.stringify(report, null, 2)}\n` };
    if (validation.valid) files["level.csv"] = this.levelCsv(session, serial);
    const paths = await this.store.writeVersion(session.id, session.revision, files);
    await this.store.appendIndex(oneLineCsv([session.id, session.revision, label, validation.valid ? "serializable" : "draft-only", now()]) + "\r\n");
    return { revision: session.revision, serializable: validation.valid, paths, report };
  }

  async finalizeLevel(sessionId: string): Promise<JsonRecord> {
    const validation = await this.validateLevel(sessionId); const estimate = await this.estimateDifficulty(sessionId); const playtest = await this.playtestInstant(sessionId);
    const session = ensureCandidateState(await this.store.load(sessionId)); const candidate = session.candidates?.[session.activeCandidateId ?? ""];
    const evaluation = candidate?.latestEvaluationId ? session.evaluations?.[candidate.latestEvaluationId] : undefined;
    if (session.requirements && (!evaluation || evaluation.revision !== session.revision)) return { finalized: false, revision: session.revision, validation, estimate, playtest, reason: "Guided finalization requires a current evaluate_level result for this exact candidate revision." };
    if (session.requirements && evaluation && !evaluation.passed) return { finalized: false, revision: session.revision, validation, estimate, playtest, evaluationId: evaluation.id, reason: "The current unified evaluation still has a fundamental or hard-constraint failure." };
    let queueQuality: JsonRecord | undefined;
    if (session.requirements?.constraints.some((constraint) => constraint.dimension === "queueTexture")) {
      queueQuality = await this.analyzeQueueTexture(sessionId, candidate?.id);
      const metrics = queueQuality.metrics as Record<string, number>;
      const reference = queueQuality.reference as { envelope: { adjacentDuplicateRatio: { p90: number }; crossLaneCloneRatio: { p90: number } }; recommendedTargets: { amountSlotRatio: [number, number]; maximumAdjacentDuplicateRatio: number; maximumCrossLaneCloneRatio: number; maximumIdenticalRun: number } };
      const comparison = queueQuality.comparison as { referenceStyleDistance: number };
      const amountDimension = session.requirements.dimensions.amount as { utilization?: unknown } | undefined;
      const explicitSingleUnit = amountDimension?.utilization === 0
        || amountDimension?.utilization === "none"
        || amountDimension?.utilization === "single-unit";
      const severe: string[] = [];
      if (!explicitSingleUnit && reference.recommendedTargets.amountSlotRatio[0] > 0 && metrics.amountSlotRatio === 0) severe.push("no queue amount is used despite an amount-using reference cohort");
      if (metrics.adjacentDuplicateRatio > Math.max(reference.envelope.adjacentDuplicateRatio.p90, reference.recommendedTargets.maximumAdjacentDuplicateRatio * 1.5)) severe.push("adjacent ingredient repetition is far outside the reference envelope");
      if (metrics.crossLaneCloneRatio > Math.max(reference.envelope.crossLaneCloneRatio.p90, reference.recommendedTargets.maximumCrossLaneCloneRatio * 1.5)) severe.push("cross-lane mirroring is far outside the reference envelope");
      if (metrics.maxIdenticalRun > reference.recommendedTargets.maximumIdenticalRun + 2) severe.push("an identical ingredient run is substantially longer than the reference cohort");
      if (comparison.referenceStyleDistance > 0.7) severe.push("the queue texture is a strong shipped-style outlier");
      if (severe.length) return { finalized: false, revision: session.revision, validation, estimate, playtest, evaluationId: evaluation?.id, queueQuality, reason: `Reference-guided quality gate failed: ${severe.join("; ")}. Generate and compare new queue variants, or explicitly confirm a single-unit/tutorial exception.` };
    }
    const fundamental = Boolean(validation.valid && playtest.win && playtest.servedCustomers === playtest.totalCustomers && (playtest.timedOutCustomers as number[]).length === 0);
    if (!fundamental) return { finalized: false, revision: session.revision, validation, estimate, playtest, reason: "Fundamental validity requirements were not met; no valid CSV was finalized." };
    const thresholdMisses = (estimate.thresholdResults as Array<{ pass: boolean }>).filter((item) => !item.pass);
    const checkpoint = await this.checkpointLevel(sessionId, thresholdMisses.length ? "closest" : "valid");
    const label = thresholdMisses.length ? "closest" : "valid";
    const finalizedSession = ensureCandidateState(await this.store.load(sessionId));
    const finalizedCandidate = finalizedSession.candidates?.[finalizedSession.activeCandidateId ?? ""];
    finalizedSession.finalization = {
      candidateId: finalizedCandidate?.id ?? "candidate-main",
      revision: finalizedSession.revision,
      label,
      at: now(),
      ...(evaluation ? { evaluationId: evaluation.id } : {}),
    };
    if (finalizedCandidate) finalizedCandidate.status = "finalized";
    await this.store.save(finalizedSession);
    return { finalized: true, label, deviations: thresholdMisses, checkpoint, validation, estimate, playtest, ...(queueQuality ? { queueQuality } : {}) };
  }

  async restoreRevision(sessionId: string, expectedRevision: number, revision: number): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "restore_revision", { revision }, (session) => {
      const snapshot = session.history.find((item) => item.revision === revision); if (!snapshot) throw new Error(`Revision ${revision} is not in session history.`);
      session.draft = clone(snapshot.draft);
      if (snapshot.requirements) session.requirements = clone(snapshot.requirements);
      return [session.draft];
    });
  }

  async undo(sessionId: string, expectedRevision: number): Promise<MutationResult> {
    const session = await this.store.load(sessionId); const prior = [...session.history].reverse().find((item) => item.revision < session.revision);
    if (!prior) throw new Error("There is no earlier revision to restore."); return this.restoreRevision(sessionId, expectedRevision, prior.revision);
  }

  private async mutate(sessionId: string, expectedRevision: number, action: string, input: unknown, change: (session: SessionRecord, resources: AuthoringResources) => unknown[]): Promise<MutationResult> {
    const { session, resources } = await this.sessionResources(sessionId);
    if (session.revision !== expectedRevision) throw new Error(`Revision conflict: expected ${expectedRevision}, current revision is ${session.revision}.`);
    const candidateId = session.activeCandidateId;
    const candidate = candidateId ? session.candidates?.[candidateId] : undefined;
    const invalidatedEvidence = candidate?.latestEvaluationId ? [candidate.latestEvaluationId] : [];
    const invalidatedEvaluation = invalidatedEvidence.length ? session.evaluations?.[invalidatedEvidence[0]] : undefined;
    const beforeSupply = this.supplyDemand(session, resources); const beforeDraft = clone(session.draft); const changedObjects = change(session, resources);
    session.revision++; session.updatedAt = now(); session.history.push({ revision: session.revision, draft: clone(session.draft), ...(session.requirements ? { requirements: clone(session.requirements) } : {}), label: action, at: session.updatedAt });
    delete session.finalization;
    if (candidate) {
      delete candidate.latestEvaluationId;
      candidate.status = "active";
    }
    const findings = this.fastFindings(session, resources); const afterSupply = this.supplyDemand(session, resources);
    await this.store.save(session); await this.store.appendAction(session.id, { at: session.updatedAt, revision: session.revision, action, input, beforeDraft, changedObjects, findings });
    return {
      sessionId,
      ...(candidateId ? { candidateId } : {}),
      revision: session.revision,
      changedObjects,
      constraintProgress: this.constraintProgress(session, resources),
      supplyDemandChanges: { before: beforeSupply, after: afterSupply },
      findings,
      invalidatedEvidence,
      largestGaps: (invalidatedEvaluation?.constraints ?? []).filter((item) => !item.pass).sort((a, b) => b.normalizedGap - a.normalizedGap).slice(0, 3).map((item) => ({ constraintId: item.constraintId, metric: item.metric, normalizedGap: item.normalizedGap })),
      nextActions: [{ tool: "get_authoring_status", arguments: { session_id: sessionId }, rationale: "Refresh guidance and evidence gaps after the mutation.", mutation: false }],
    };
  }

  private async sessionResources(sessionId: string): Promise<{ session: SessionRecord; resources: AuthoringResources }> {
    const session = await this.store.load(sessionId); const resources = await this.repository.load(session.mapId);
    if (resources.contextToken !== session.contextToken) throw new Error("The map graph/rules/catalog changed after this session started. Start a new session from fresh authoring context.");
    return { session, resources };
  }

  private async proposeSkeletonPart(
    sessionId: string,
    kind: "customer-plan" | "dish-plan" | "skeleton",
    input: { candidateId?: string; customerCount?: number; dishesPerCustomer?: number; composites?: string[]; laneCount?: number; amountStyle?: QueueAmountStyle; seed?: number; layoutArchetype?: QueueLayoutArchetype },
  ): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId);
    ensureCandidateState(session); syncActiveCandidate(session);
    const candidate = session.candidates?.[input.candidateId ?? session.activeCandidateId ?? ""];
    if (!candidate) throw new Error(`Unknown candidate "${input.candidateId}".`);
    if (kind === "dish-plan" && candidate.draft.customers.length === 0) throw new Error("A dish proposal needs at least one existing customer. Apply a customer plan first or use propose_level_skeleton.");
    const customerDimensions = session.requirements?.dimensions.customersOrders as { customerCount?: number | null; dishCount?: number | null } | undefined;
    const queueDimensions = session.requirements?.dimensions.queue as { laneCount?: number | null } | undefined;
    const contentDimensions = session.requirements?.dimensions.content as { dishNames?: unknown } | undefined;
    const amountDimensions = session.requirements?.dimensions.amount as { utilization?: unknown } | undefined;
    const requirementCustomerCount = customerDimensions?.customerCount ?? undefined;
    const customerCount = kind === "dish-plan"
      ? candidate.draft.customers.length
      : Math.max(1, Math.floor(input.customerCount ?? requirementCustomerCount ?? Math.max(2, candidate.draft.customers.length)));
    const requirementDishCount = customerDimensions?.dishCount ?? undefined;
    const dishesPerCustomer = Math.max(1, Math.floor(input.dishesPerCustomer ?? (requirementDishCount ? Math.ceil(requirementDishCount / customerCount) : 1)));
    const requirementComposites = Array.isArray(contentDimensions?.dishNames) ? contentDimensions.dishNames.filter((item): item is string => typeof item === "string") : [];
    const composites = input.composites?.length ? input.composites : requirementComposites;
    const seed = Math.max(0, Math.floor(input.seed ?? Number.parseInt(createRequirementToken({
      schemaVersion: 1, mapId: session.mapId, mode: "create", originalBrief: `${session.id}:${candidate.id}:${candidate.revision}:${kind}`,
      assumptions: [], dimensions: {}, constraints: [], authorizedMechanics: [], unresolved: [], confirmationStatus: "skipped", contextToken: session.contextToken,
    }).slice(0, 8), 16)));
    const planned = planCustomerDishSkeleton(buildIndex(resources.doc), buildIdIndex(resources.doc.idTable), candidate.draft, {
      customerCount,
      dishesPerCustomer,
      composites,
      startingCustomerCounter: candidate.idCounters.customer,
      startingDishCounter: candidate.idCounters.dish,
      deterministicSeed: seed,
    });
    let actions = planned.actions;
    if (kind === "customer-plan") actions = actions.filter((action) => action.tool === "add_customer");
    if (kind === "dish-plan") actions = actions.filter((action) => action.tool === "add_dish" || action.tool === "add_dish_piece");
    const warnings = [...planned.warnings];
    let expectedSupplyDelta: Record<string, number> = {};
    let queueSummary: Record<string, unknown> | undefined;
    if (kind === "skeleton") {
      const virtual: SessionRecord = {
        ...session,
        revision: candidate.revision,
        draft: clone(candidate.draft),
        history: clone(candidate.history),
        idCounters: clone(candidate.idCounters),
      };
      this.executeProposalActionsInSession(virtual, resources, actions);
      const missing = (this.supplyDemand(virtual, resources).missing as MissingPickupDemand[] | undefined) ?? [];
      const inferredAmountStyle: QueueAmountStyle = input.amountStyle ?? (amountDimensions?.utilization === 0 || amountDimensions?.utilization === "none" || amountDimensions?.utilization === "single-unit" ? "single-unit" : "balanced");
      const layoutArchetype = input.layoutArchetype ?? "staggered-braid";
      const queuePlan = planQueueSupply(buildIndex(resources.doc), virtual.draft, missing, {
        laneCount: input.laneCount ?? queueDimensions?.laneCount ?? Math.max(1, virtual.draft.lanes.length),
        amountStyle: inferredAmountStyle,
        startingLaneCounter: virtual.idCounters.lane,
        startingSlotCounter: virtual.idCounters.slot,
        deterministicSeed: seed,
        layoutArchetype,
      });
      actions = [...actions, ...queuePlan.actions];
      warnings.push(...queuePlan.warnings);
      expectedSupplyDelta = queuePlan.expectedSupplyDelta;
      queueSummary = { amountStyle: inferredAmountStyle, layoutArchetype, plannedLaneIds: queuePlan.plannedLaneIds, plannedSlotIds: queuePlan.plannedSlotIds, plannedTexture: queuePlan.plannedTexture, missingDemand: missing };
    }
    const proposal: ProposalRecord = {
      id: `proposal-${randomUUID().slice(0, 8)}`,
      kind,
      name: kind === "customer-plan" ? "Ordinary customer plan" : kind === "dish-plan" ? "Graph-valid dish plan" : "Ordinary level skeleton",
      candidateId: candidate.id,
      baseRevision: candidate.revision,
      deterministicSeed: seed,
      actions,
      expectedSupplyDelta,
      expectedMetricDirections: {
        "customers.count": actions.some((action) => action.tool === "add_customer") ? "increase" : "unchanged",
        "customers.dishCount": actions.some((action) => action.tool === "add_dish") ? "increase" : "unchanged",
        "fundamental.exactSupply": kind === "skeleton" && Object.keys(expectedSupplyDelta).length ? "increase" : "unchanged",
      },
      authorizationRequirements: [],
      warnings,
      status: "pending",
      createdAt: now(),
    };
    proposal.artifactPath = `proposals/${proposal.id}.json`;
    session.proposals![proposal.id] = proposal;
    await this.store.writeProposal(sessionId, proposal); await this.store.save(session);
    return {
      sessionId,
      candidateId: candidate.id,
      revision: candidate.revision,
      proposal: clone(proposal),
      plannedCustomerIds: planned.plannedCustomerIds,
      plannedDishIds: planned.plannedDishIds,
      selectedComposites: planned.selectedComposites,
      ...(queueSummary ? { queuePlan: queueSummary } : {}),
      productionBehavior: productionBehaviorEvidence(),
    };
  }

  private nextId(session: SessionRecord, kind: keyof SessionRecord["idCounters"]): string {
    session.idCounters[kind]++; return `${kind}-${session.idCounters[kind]}`;
  }

  private customer(session: SessionRecord, id: string): DraftCustomer {
    const customer = session.draft.customers.find((item) => item.id === id); if (!customer) throw new Error(`Unknown customer "${id}".`); return customer;
  }

  private dish(session: SessionRecord, id: string): DraftDish {
    for (const customer of session.draft.customers) { const dish = customer.dishes.find((item) => item.id === id); if (dish) return dish; }
    throw new Error(`Unknown dish "${id}".`);
  }

  private lane(session: SessionRecord, id: string) {
    const lane = session.draft.lanes.find((item) => item.id === id); if (!lane) throw new Error(`Unknown queue lane "${id}".`); return lane;
  }

  private slot(session: SessionRecord, id: string) {
    for (const lane of session.draft.lanes) { const slot = lane.slots.find((item) => item.id === id); if (slot) return slot; }
    throw new Error(`Unknown queue slot "${id}".`);
  }

  private addCustomerInSession(session: SessionRecord, resources: AuthoringResources, input: Omit<DraftCustomer, "id" | "dishes"> & { position?: number }): DraftCustomer {
    this.assertCustomerAuthorized(session, resources, input);
    const customer: DraftCustomer = {
      id: this.nextId(session, "customer"), typeId: input.typeId, waitTime: input.waitTime,
      weatherEff: input.weatherEff, dishes: [],
      ...(input.staffAmount !== undefined ? { staffAmount: input.staffAmount } : {}),
      ...(input.customerIndex !== undefined ? { customerIndex: input.customerIndex } : {}),
    };
    const position = input.position === undefined ? session.draft.customers.length : Math.max(0, Math.min(input.position, session.draft.customers.length));
    session.draft.customers.splice(position, 0, customer);
    return customer;
  }

  private addDishInSession(session: SessionRecord, resources: AuthoringResources, customerId: string, composite: string): DraftDish {
    const ix = buildIndex(resources.doc); const ids = buildIdIndex(resources.doc.idTable);
    const dense = ix.compositeByName.get(composite);
    const dataId = dense === undefined ? Number(composite) : ids.byNode.composite.get(composite);
    const name = dataId === undefined ? undefined : ids.byId.composite.get(dataId);
    if (dataId === undefined || !name || ix.compositeByName.get(name) === undefined) throw new Error(`Unknown composite "${composite}".`);
    const dish: DraftDish = { id: this.nextId(session, "dish"), composite: name, root: { kind: "composite", id: dataId, members: [] }, effects: [] };
    this.customer(session, customerId).dishes.push(dish);
    return dish;
  }

  private addDishPieceInSession(session: SessionRecord, resources: AuthoringResources, dishId: string, slotIndex: number, ingredient: string): DraftDish {
    const dish = this.dish(session, dishId); const ix = buildIndex(resources.doc); const ids = buildIdIndex(resources.doc.idTable);
    const orderable = ix.compositeByName.get(dish.composite);
    const dense = ix.ingByName.get(ingredient) ?? (ids.byId.ingredient.get(Number(ingredient)) ? ix.ingByName.get(ids.byId.ingredient.get(Number(ingredient))!) : undefined);
    if (orderable === undefined || dense === undefined) throw new Error("Unknown dish composite or ingredient.");
    const slot = ix.slotsOfComposite[orderable]?.[slotIndex];
    if (!slot?.options.includes(dense)) throw new Error(`Ingredient "${ingredient}" is not valid for slot ${slotIndex}.`);
    const missing = unmetSlotBase(ix, ids, dish.root, orderable, slotIndex);
    if (missing >= 0) throw new Error(`Add a valid base for "${ix.compositeName[missing]}" before this piece.`);
    const before = JSON.stringify(dish.root);
    addToSlot(ix, ids, dish.root, orderable, slotIndex, dense);
    if (JSON.stringify(dish.root) === before) throw new Error("The piece could not be added because the slot is full or structurally invalid.");
    return dish;
  }

  private executeProposalActionsInSession(session: SessionRecord, resources: AuthoringResources, actions: ProposalRecord["actions"]): unknown[] {
    const changed: unknown[] = [];
    for (const action of actions) {
      if (action.tool === "merge_queue_slots") changed.push(...this.mergeQueueSlotsInSession(session, action.arguments.slotIds));
      else if (action.tool === "split_queue_slot") {
        const split = this.splitQueueSlotInSession(session, action.arguments.slotId, action.arguments.keepAmount);
        if (split[1].id !== action.expectedResult.remainderSlotId) throw new Error(`Proposal expected remainder id "${action.expectedResult.remainderSlotId}" but generated "${split[1].id}".`);
        changed.push(...split);
      } else if (action.tool === "add_queue_lane") {
        const lane = this.addQueueLaneInSession(session, action.arguments.position);
        if (lane.id !== action.expectedResult.laneId) throw new Error(`Proposal expected lane id "${action.expectedResult.laneId}" but generated "${lane.id}".`);
        changed.push(lane);
      } else if (action.tool === "add_queue_ingredient") {
        const slots = this.addQueueIngredientInSession(session, resources, action.arguments);
        const actualIds = slots.map((slot) => slot.id);
        if (actualIds.join("|") !== action.expectedResult.slotIds.join("|")) throw new Error(`Proposal expected slot ids "${action.expectedResult.slotIds.join(",")}" but generated "${actualIds.join(",")}".`);
        const expandedUnits = slots.reduce((sum, slot) => sum + Math.max(1, Math.floor(slot.amount ?? 1)), 0);
        if (expandedUnits !== action.expectedResult.expandedUnits) throw new Error(`Proposal expected ${action.expectedResult.expandedUnits} expanded units but generated ${expandedUnits}.`);
        changed.push(...slots);
      } else if (action.tool === "add_customer") {
        const customer = this.addCustomerInSession(session, resources, action.arguments);
        if (customer.id !== action.expectedResult.customerId) throw new Error(`Proposal expected customer id "${action.expectedResult.customerId}" but generated "${customer.id}".`);
        changed.push(customer);
      } else if (action.tool === "add_dish") {
        const dish = this.addDishInSession(session, resources, action.arguments.customerId, action.arguments.composite);
        if (dish.id !== action.expectedResult.dishId) throw new Error(`Proposal expected dish id "${action.expectedResult.dishId}" but generated "${dish.id}".`);
        changed.push(dish);
      } else if (action.tool === "add_dish_piece") {
        const dish = this.addDishPieceInSession(session, resources, action.arguments.dishId, action.arguments.slotIndex, action.arguments.ingredient);
        const ix = buildIndex(resources.doc); const ids = buildIdIndex(resources.doc.idTable); const orderable = ix.compositeByName.get(dish.composite);
        const selectedCount = orderable === undefined ? 0 : membersOf(ix, ids, dish.root, orderable, action.arguments.slotIndex).length;
        if (selectedCount !== action.expectedResult.selectedCount) throw new Error(`Proposal expected ${action.expectedResult.selectedCount} selected piece(s) in ${dish.id} slot ${action.arguments.slotIndex}, got ${selectedCount}.`);
        changed.push(dish);
      } else if (action.tool === "set_queue_slot_effect") {
        const slot = this.setQueueSlotEffectInSession(session, resources, action.arguments.slotId, action.arguments.effect);
        if (slot.id !== action.expectedResult.slotId) throw new Error(`Proposal expected queue slot "${action.expectedResult.slotId}" but changed "${slot.id}".`);
        changed.push(slot);
      } else if (action.tool === "set_grid_cell_effect") {
        const cell = this.setGridCellEffectInSession(session, resources, action.arguments.x, action.arguments.y, action.arguments.effect);
        if (cell.id !== action.expectedResult.cellId) throw new Error(`Proposal expected grid cell "${action.expectedResult.cellId}" but changed "${cell.id}".`);
        changed.push(cell);
      }
    }
    return changed;
  }

  private addQueueLaneInSession(session: SessionRecord, position?: number) {
    const lane = { id: this.nextId(session, "lane"), slots: [] as DraftQueueSlot[] };
    session.draft.lanes.splice(position === undefined ? session.draft.lanes.length : Math.max(0, Math.min(position, session.draft.lanes.length)), 0, lane);
    return lane;
  }

  private setQueueSlotEffectInSession(session: SessionRecord, resources: AuthoringResources, slotId: string, effect: EffectInstance): DraftQueueSlot {
    const mechanic = QUEUE_MECHANIC[effect.effectId]; if (!mechanic) throw new Error(`Unknown queue effect id ${effect.effectId}.`); this.assertAuthorized(session, mechanic);
    this.validateEffect(resources.queueEffects, effect); const slot = this.slot(session, slotId); const at = slot.effects.findIndex((item) => item.effectId === effect.effectId);
    if (at >= 0) slot.effects[at] = effect; else slot.effects.push(effect);
    return slot;
  }

  private setGridCellEffectInSession(session: SessionRecord, resources: AuthoringResources, x: number, y: number, effect: EffectInstance) {
    const mechanic = GRID_MECHANIC[effect.effectId]; if (!mechanic) throw new Error(`Unknown grid effect id ${effect.effectId}.`); this.assertAuthorized(session, mechanic);
    this.validateEffect(resources.gridEffects, effect); const cell = this.cell(session, resources.doc, x, y); const at = cell.effects.findIndex((item) => item.effectId === effect.effectId);
    if (at >= 0) cell.effects[at] = effect; else cell.effects.push(effect);
    return cell;
  }

  private addQueueIngredientInSession(session: SessionRecord, resources: AuthoringResources, input: { laneId: string; position: number; ingredient: string; count?: number; amount?: number; provisional?: boolean }): DraftQueueSlot[] {
    const lane = this.lane(session, input.laneId); const ids = buildIdIndex(resources.doc.idTable); const ix = buildIndex(resources.doc);
    const dense = ix.ingByName.get(input.ingredient); const name = dense === undefined ? ids.byId.ingredient.get(Number(input.ingredient)) : input.ingredient;
    const dataId = name === undefined ? undefined : ids.byNode.ingredient.get(name); const actualDense = name === undefined ? undefined : ix.ingByName.get(name);
    if (name === undefined || dataId === undefined || actualDense === undefined || !ix.pickupable[actualDense]) throw new Error(`"${input.ingredient}" is not a pickupable graph ingredient.`);
    const count = Math.max(1, Math.min(100, Math.floor(input.count ?? 1))); const added: DraftQueueSlot[] = [];
    // `count` = authored queue slots; `amount` = independent one-use units
    // released atomically by each slot under production behavior.
    const amount = Math.max(1, Math.floor(input.amount ?? 1));
    for (let offset = 0; offset < count; offset++) {
      const slot: DraftQueueSlot = { id: this.nextId(session, "slot"), ingredientId: dataId, ingredient: name, effects: [], provisional: Boolean(input.provisional), ...(amount > 1 ? { amount } : {}) };
      lane.slots.splice(Math.max(0, Math.min(input.position + offset, lane.slots.length)), 0, slot); added.push(slot);
    }
    return added;
  }

  private mergeQueueSlotsInSession(session: SessionRecord, slotIds: string[]): DraftQueueSlot[] {
    const unique = [...new Set(slotIds)];
    if (unique.length < 2) throw new Error("Merging amounts requires at least two different queue slots.");
    const slots = unique.map((id) => this.slot(session, id));
    const first = slots[0];
    if (slots.some((slot) => slot.ingredientId !== first.ingredientId)) throw new Error("Only slots containing the same ingredient can be merged.");
    first.amount = slots.reduce((sum, slot) => sum + Math.max(1, Math.floor(slot.amount ?? 1)), 0);
    const removedIds = new Set(unique.slice(1));
    for (const lane of session.draft.lanes) lane.slots = lane.slots.filter((slot) => !removedIds.has(slot.id));
    session.draft.groups = session.draft.groups.filter((group) => !group.slotIds.some((id) => removedIds.has(id)));
    return [first, ...slots.slice(1)];
  }

  private splitQueueSlotInSession(session: SessionRecord, slotId: string, keepAmount: number): [DraftQueueSlot, DraftQueueSlot] {
    for (const lane of session.draft.lanes) {
      const at = lane.slots.findIndex((slot) => slot.id === slotId);
      if (at < 0) continue;
      const slot = lane.slots[at];
      const total = Math.max(1, Math.floor(slot.amount ?? 1));
      const keep = Math.floor(keepAmount);
      if (total < 2) throw new Error(`Queue slot "${slotId}" has no amount to split.`);
      if (keep < 1 || keep >= total) throw new Error(`keep_amount must be between 1 and ${total - 1}.`);
      if (keep > 1) slot.amount = keep; else delete slot.amount;
      const remainder = total - keep;
      const rest: DraftQueueSlot = { id: this.nextId(session, "slot"), ingredientId: slot.ingredientId, ingredient: slot.ingredient, effects: [], provisional: slot.provisional, ...(remainder > 1 ? { amount: remainder } : {}) };
      lane.slots.splice(at + 1, 0, rest);
      return [slot, rest];
    }
    throw new Error(`Unknown queue slot "${slotId}".`);
  }

  private group(session: SessionRecord, id: string) {
    const group = session.draft.groups.find((item) => item.id === id); if (!group) throw new Error(`Unknown queue group "${id}".`); return group;
  }

  private cell(session: SessionRecord, doc: NodeGraphMap, x: number, y: number) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= doc.map.gridWidth || y >= doc.map.gridHeight) throw new Error(`Grid coordinate (${x},${y}) is out of range.`);
    return session.draft.grid[y * doc.map.gridWidth + x];
  }

  private assertAuthorized(session: SessionRecord, mechanic: MechanicAuthorization): void {
    if (!session.authorizedMechanics.includes(mechanic)) throw new Error(`Mechanic "${mechanic}" is not authorized by the brief or an approved requirement amendment.`);
  }

  private assertCustomerAuthorized(session: SessionRecord, resources: AuthoringResources, input: { typeId: number; waitTime: number; customerIndex?: number }): void {
    if (input.waitTime > 0) this.assertAuthorized(session, "customer:timer");
    if (input.typeId === 1) this.assertAuthorized(session, "customer:staff");
    if (input.customerIndex !== undefined) {
      const avatar = resources.customers.find((entry) => entry.index === input.customerIndex); if (!avatar) throw new Error(`Unknown customer catalog index ${input.customerIndex}.`);
      if (avatar.mapIndex !== resources.mapIndex) throw new Error(`Customer catalog index ${input.customerIndex} is not compatible with map "${resources.doc.map.id}".`);
      const role = avatar.type.trim().toLowerCase(); if (role === "boss") this.assertAuthorized(session, "customer:boss"); if (role === "shipper") this.assertAuthorized(session, "customer:shipper");
    }
  }

  private validateEffect(definitions: AuthoringResources["queueEffects"], effect: EffectInstance): void {
    const definition = definitions.find((item) => item.id === effect.effectId); if (!definition) throw new Error(`Unknown effect id ${effect.effectId}.`);
    if (effect.params.length !== definition.paramDefs.length) throw new Error(`${definition.name} requires ${definition.paramDefs.length} parameter(s), received ${effect.params.length}.`);
    if (effect.params.some((param) => !Number.isFinite(param))) throw new Error("Effect parameters must be finite numbers.");
  }

  private supplyDemand(session: SessionRecord, resources: AuthoringResources): JsonRecord {
    const ix = buildIndex(resources.doc); const ids = buildIdIndex(resources.doc.idTable); const customers = toNodeCustomers(session.draft, resources);
    const demand = nodeDemandByRaw(ix, ids, customers); const have = new Map<number, number>();
    for (const lane of session.draft.lanes) {
      for (const slot of lane.slots) {
        have.set(slot.ingredientId, (have.get(slot.ingredientId) ?? 0) + Math.max(1, Math.floor(slot.amount ?? 1)));
      }
    }
    const allIds = new Set([...demand.keys(), ...have.keys()]);
    const ingredients = [...allIds].sort((a, b) => a - b).map((dataId) => {
      const raw = demand.get(dataId); const needUnits = raw?.need ?? 0; const usablePerPickup = Math.max(1, raw?.amount ?? 1);
      const pickupNeed = Math.ceil(needUnits / usablePerPickup); const pickupHave = have.get(dataId) ?? 0; const name = ids.byId.ingredient.get(dataId) ?? `ingredient-${dataId}`;
      const dense = ix.ingByName.get(name); const customersProducingDemand: unknown[] = [];
      session.draft.customers.forEach((customer, customerIndex) => customer.dishes.forEach((dish) => {
        const single: NodeCustomerConfig = { typeId: 0, waitTime: 0, weatherEff: 0, dishes: [{ root: dish.root, effects: dish.effects }] };
        if ((nodeDemandByRaw(ix, ids, [single]).get(dataId)?.need ?? 0) > 0) customersProducingDemand.push({ customerId: customer.id, customerNumber: customerIndex + 1, dishId: dish.id });
      }));
      const chain: unknown[] = []; let current = dense; const seen = new Set<number>();
      while (current !== undefined && !seen.has(current)) { seen.add(current); const step = ix.recipeForInput[current]; if (!step) break; chain.push({ tool: ix.toolName[step.tool], output: ix.ingName[step.out], duration: step.duration, yield: step.amount }); current = step.out; }
      const haveUsableUnits = pickupHave * usablePerPickup;
      return {
        ingredient: name, dataId, rawPickupRequired: pickupNeed, toolChain: chain,
        yield: raw?.amount ?? 1,
        have: haveUsableUnits, need: needUnits,
        surplus: Math.max(0, haveUsableUnits - needUnits), missing: Math.max(0, needUnits - haveUsableUnits),
        pickupHave, pickupNeed,
        minimumPickupAdditions: Math.max(0, Math.ceil((needUnits - haveUsableUnits) / usablePerPickup)),
        maximumPickupRemovals: Math.max(0, Math.floor((haveUsableUnits - needUnits) / usablePerPickup)),
        customersAndDishes: customersProducingDemand,
      };
    });
    const missing = ingredients.filter((item) => item.minimumPickupAdditions > 0).map((item) => ({ ingredient: item.ingredient, dataId: item.dataId, howMany: item.minimumPickupAdditions, missingUsableUnits: item.missing }));
    const keySupply = new Map<number, number>(); const keyDemand = new Map<number, number>();
    session.draft.lanes.flatMap((lane) => lane.slots).flatMap((slot) => slot.effects).filter((effect) => effect.effectId === 3).forEach((effect) => keySupply.set(effect.params[0], (keySupply.get(effect.params[0]) ?? 0) + 1));
    session.draft.grid.flatMap((cell) => cell.effects).filter((effect) => effect.effectId === 4).forEach((effect) => keyDemand.set(effect.params[0], (keyDemand.get(effect.params[0]) ?? 0) + Math.max(1, effect.params[1] ?? 1)));
    return { ingredients, missing, keyBalance: [...new Set([...keySupply.keys(), ...keyDemand.keys()])].map((colorId) => ({ colorId, have: keySupply.get(colorId) ?? 0, need: keyDemand.get(colorId) ?? 0 })) };
  }

  private fastFindings(session: SessionRecord, resources: AuthoringResources): ValidationFinding[] {
    const findings: ValidationFinding[] = []; const ix = buildIndex(resources.doc); const ids = orderIdIndex(ix); const allowed = new Set(session.authorizedMechanics);
    if (session.draft.customers.length === 0) findings.push({ severity: "error", code: "NO_CUSTOMERS", message: "The level has no customers." });
    if (session.draft.lanes.length === 0) findings.push({ severity: "error", code: "NO_QUEUE_LANES", message: "The level has no queue lanes." });
    for (const mechanic of mechanicsForDraft(session.draft, resources)) if (!allowed.has(mechanic)) findings.push({ severity: "error", code: "UNAUTHORIZED_MECHANIC", message: `${mechanic} is present but not authorized.`, repair: "Remove it, or obtain explicit user approval and amend the session requirements." });
    session.draft.customers.forEach((customer) => {
      if (customer.typeId === 0 && customer.dishes.length === 0) findings.push({ severity: "error", code: "CUSTOMER_NO_DISH", message: `${customer.id} has no dish.`, objectIds: [customer.id] });
      customer.dishes.forEach((dish) => {
        const result = resolveOrder(ix, { root: dish.root, effects: dish.effects }, ids); result.issues.forEach((issue) => findings.push({ severity: "error", code: `DISH_${issue.kind.toUpperCase().replaceAll("-", "_")}`, message: `${dish.id}: ${JSON.stringify(issue)}`, objectIds: [dish.id], repair: "Inspect valid dish pieces and repair the named slot or prerequisite." }));
        if (result.order.slots.length === 0) findings.push({ severity: "error", code: "DISH_EMPTY", message: `${dish.id} has no valid pieces.`, objectIds: [dish.id] });
      });
    });
    const occupied = new Map<string, string>();
    session.draft.groups.forEach((group) => {
      const coords = groupCoordinates(session.draft, group); if (coords.length !== group.slotIds.length) findings.push({ severity: "error", code: "GROUP_MISSING_SLOT", message: `${group.id} references a missing queue slot.`, objectIds: [group.id] });
      coords.forEach((coord) => { const prior = occupied.get(coord.slotId); if (prior) findings.push({ severity: "error", code: "GROUP_OVERLAP", message: `${coord.slotId} belongs to both ${prior} and ${group.id}.`, objectIds: [prior, group.id, coord.slotId] }); else occupied.set(coord.slotId, group.id); });
      if (group.kind === "combined" && coords.length > 0) {
        const reached = new Set<string>([`${coords[0].x}:${coords[0].y}`]); let changed = true;
        while (changed) { changed = false; for (const coord of coords) if (!reached.has(`${coord.x}:${coord.y}`) && [...reached].some((key) => { const [x, y] = key.split(":").map(Number); return Math.abs(x - coord.x) + Math.abs(y - coord.y) === 1; })) { reached.add(`${coord.x}:${coord.y}`); changed = true; } }
        if (reached.size !== coords.length) findings.push({ severity: "error", code: "COMBINED_NOT_CONNECTED", message: `${group.id} is not four-connected.`, objectIds: [group.id] });
      }
      const ingredients = new Set(coords.map((coord) => this.slot(session, coord.slotId).ingredient));
      if (ingredients.size > 1) findings.push({ severity: "warning", code: "GROUP_MIXED_INGREDIENTS", message: `${group.id} contains different ingredients.`, objectIds: [group.id] });
    });
    const supply = this.supplyDemand(session, resources); for (const missing of supply.missing as Array<{ ingredient: string; howMany: number }>) findings.push({ severity: "error", code: "MISSING_SUPPLY", message: `Missing ${missing.howMany} piece(s) of ${missing.ingredient}.`, repair: `Add ${missing.howMany} pickup unit(s) as individual slots or legal atomic amount releases.` });
    for (const balance of supply.keyBalance as Array<{ colorId: number; have: number; need: number }>) if (balance.have < balance.need) findings.push({ severity: "error", code: "MISSING_KEYS", message: `Color ${balance.colorId} needs ${balance.need} keys but only ${balance.have} are supplied.`, repair: "Add matching HoldingKey ingredients earlier or reduce ColorLock key demand." });
    if (session.draft.lanes.flatMap((lane) => lane.slots).some((slot) => slot.provisional)) findings.push({ severity: "warning", code: "PROVISIONAL_SUPPLY", message: "Some queue ingredients are still marked provisional.", repair: "Reconcile them against demand and clear the provisional marker before finalization." });
    return findings;
  }

  private constraintProgress(session: SessionRecord, resources: AuthoringResources): ConstraintProgress {
    const present = mechanicsForDraft(session.draft, resources); const constraints = clone(session.interpretation.constraints).map((constraint) => {
      if (constraint.unit && ([...present, ...session.authorizedMechanics] as string[]).includes(constraint.unit)) {
        const actual = mechanicCount(session.draft, resources, constraint.unit as MechanicAuthorization);
        const met = constraint.target !== undefined ? actual === constraint.target : constraint.min !== undefined || constraint.max !== undefined
          ? actual >= (constraint.min ?? 0) && actual <= (constraint.max ?? Infinity) : actual > 0;
        return { ...constraint, status: met ? "met" as const : "pending" as const, actual };
      }
      if (constraint.unit === "customers") { const actual = session.draft.customers.length; const met = constraint.target !== undefined ? actual === constraint.target : actual >= (constraint.min ?? 0) && actual <= (constraint.max ?? Infinity); return { ...constraint, status: met ? "met" as const : "pending" as const, actual }; }
      if (constraint.unit === "queue lanes") { const actual = session.draft.lanes.length; const met = constraint.target !== undefined ? actual === constraint.target : actual >= (constraint.min ?? 0) && actual <= (constraint.max ?? Infinity); return { ...constraint, status: met ? "met" as const : "pending" as const, actual }; }
      if (constraint.kind === "ratio") {
        const total = session.draft.lanes.reduce((sum, lane) => sum + lane.slots.length, 0);
        const groupKind = /combined/i.test(constraint.source) ? "combined" : /linked/i.test(constraint.source) ? "linked" : undefined;
        if (groupKind && total > 0) {
          const grouped = new Set(session.draft.groups.filter((group) => group.kind === groupKind).flatMap((group) => group.slotIds)).size;
          const actual = grouped / total * 100; return { ...constraint, status: Math.abs(actual - (constraint.target ?? actual)) < 0.0001 ? "met" as const : "pending" as const, actual };
        }
      }
      return { ...constraint, status: constraint.kind === "qualitative" || constraint.kind === "ratio" ? "unresolved" as const : constraint.status };
    });
    return { constraints, met: constraints.filter((item) => item.status === "met").length, total: constraints.length, unresolved: constraints.filter((item) => item.status === "unresolved").length };
  }

  private scoreDraftSnapshot(
    session: SessionRecord,
    resources: AuthoringResources,
    draft: SessionDraft,
    seeds: number[],
    reference?: { dataset: ReferenceLevelDataset; analysis: ReferenceLevelAnalysis },
  ): SnapshotScore {
    const snapshotSession: SessionRecord = { ...session, draft: clone(draft) };
    const findings = this.fastFindings(snapshotSession, resources);
    const graph = validateNodeGraph(resources.doc);
    graph.errors.forEach((issue) => findings.push({ severity: "error", code: issue.invariantId, message: issue.message }));
    const level = { ...toNodeLevel(draft, resources), outOfSlotPolicy: PRODUCTION_BEHAVIOR.outOfSlotPolicy };
    const thaw = checkQueueThaw(level.queues, level.queueGroups, { timeBudgetMs: 250, sampleBudgetMs: 100, randomRuns: 100, maxCases: 3 });
    if (thaw.verdict === "deadlock") findings.push({ severity: "error", code: "QUEUE_THAW", message: thaw.message });
    const estimates = seeds.map((seed) => estimateNodeDifficulty(buildIndex(resources.doc), level, {
      rng: seededRng(seed), maxRetries: 1,
      packingMode: PRODUCTION_BEHAVIOR.packingMode, toolProcessBehavior: PRODUCTION_BEHAVIOR.toolProcessBehavior,
    }));
    const wins = estimates.filter((estimate) => estimate.solvable && estimate.servedCount === estimate.totalCustomers && estimate.timedOutCustomers.length === 0).length;
    const durations = estimates.map((estimate) => estimate.gameplayDurationSeconds ?? 0);
    const totalPicks = estimates.reduce((sum, estimate) => sum + estimate.totalPicks, 0);
    const randomPicks = estimates.reduce((sum, estimate) => sum + estimate.occupancyHistory.filter((sample) => sample.random).length, 0);
    const detours = estimates.reduce((sum, estimate) => sum + estimate.perCustomer.reduce((subtotal, customer) => subtotal + customer.detours, 0), 0);
    const peakOccupied = Math.max(0, ...estimates.flatMap((estimate) => estimate.occupancyHistory.map((sample) => sample.occupied)));
    const slots = draft.lanes.flatMap((lane) => lane.slots);
    const amounts = slots.map((slot) => Math.max(1, slot.amount ?? 1));
    const totalUnits = amounts.reduce((sum, amount) => sum + amount, 0);
    const amountSlots = slots.filter((slot) => (slot.amount ?? 1) > 1);
    const amountUnits = amountSlots.reduce((sum, slot) => sum + Math.max(1, slot.amount ?? 1), 0);
    const laneDepths = draft.lanes.map((lane) => lane.slots.length);
    const supply = this.supplyDemand(snapshotSession, resources);
    const supplyRows = (supply.ingredients as Array<{ missing: number; surplus: number }> | undefined) ?? [];
    const exactSupply = supplyRows.every((row) => row.missing === 0 && row.surplus === 0) && !slots.some((slot) => slot.provisional);
    const amountAnalysis = analyzeAmounts(buildIndex(resources.doc), draft);
    const texture = analyzeDraftQueueTexture(draft);
    const referenceComparison = reference
      ? compareQueueToReferences(serializeDraft(draft, resources).queueString, reference.dataset, reference.analysis)
      : { referenceStyleDistance: 1, nearestReferenceSimilarity: 0 };
    const metrics: SnapshotScore["metrics"] = {
      "fundamental.structuralErrors": findings.filter((finding) => finding.severity === "error").length,
      "fundamental.exactSupply": exactSupply,
      "fundamental.solverVictory": wins === estimates.length,
      "experience.winRate": estimates.length ? wins / estimates.length : 0,
      "experience.durationP50": percentile(durations, 0.5),
      "experience.durationP90": percentile(durations, 0.9),
      "experience.randomPickRatio": totalPicks ? randomPicks / totalPicks : 0,
      "experience.detourRatio": totalPicks ? detours / totalPicks : 0,
      "queue.laneCount": draft.lanes.length,
      "queue.maxDepth": Math.max(0, ...laneDepths),
      "queue.laneBalance": laneDepths.length && Math.max(...laneDepths) > 0 ? 1 - (Math.max(...laneDepths) - Math.min(...laneDepths)) / Math.max(...laneDepths) : 1,
      "queue.pickingOrderStuckRate": thaw.verdict === "deadlock" ? 1 : 0,
      "queue.deadlockReasonDistribution": Object.fromEntries(thaw.reasonCounts.map((row) => [row.reason, row.count])),
      "queue.adjacentDuplicateRatio": texture.adjacentDuplicateRatio,
      "queue.maxIdenticalRun": texture.maxIdenticalRun,
      "queue.crossLaneCloneRatio": texture.crossLaneCloneRatio,
      "queue.transitionEntropy": texture.transitionEntropy,
      "queue.repeatedNgramRatio": texture.repeatedNgramRatio,
      "queue.localIngredientDominance": texture.localIngredientDominance,
      "queue.referenceStyleDistance": referenceComparison.referenceStyleDistance,
      "queue.nearestReferenceSimilarity": referenceComparison.nearestReferenceSimilarity,
      "amount.compactedUnitRatio": totalUnits ? amountUnits / totalUnits : 0,
      "amount.amountSlotRatio": slots.length ? amountSlots.length / slots.length : 0,
      "amount.maxAmount": Math.max(1, ...amounts),
      "amount.expandedItemCount": totalUnits,
      "amount.maxDestinationDemand": Math.max(1, ...amounts),
      "amount.maxGridLandingBurst": Math.max(0, ...amounts.map((amount) => amount - 1)),
      "amount.atomicDestinationBlockRate": amountAnalysis.slots.length ? amountAnalysis.slots.filter((slot) => !slot.capacitySafeOnEmptyGrid).length / amountAnalysis.slots.length : 0,
      "grid.usableCells": draft.grid.filter((cell) => !cell.effects.some((effect) => effect.effectId === 1)).length,
      "grid.peakOccupancy": resources.doc.map.gridWidth * resources.doc.map.gridHeight ? peakOccupied / (resources.doc.map.gridWidth * resources.doc.map.gridHeight) : 0,
      "customers.count": draft.customers.length,
      "customers.dishCount": draft.customers.reduce((sum, customer) => sum + customer.dishes.length, 0),
      "content.distinctComposites": new Set(draft.customers.flatMap((customer) => customer.dishes.map((dish) => dish.composite))).size,
      "pacing.peakConcurrentWork": Math.max(0, ...estimates.map((estimate) => estimate.peakConcurrentWork ?? 0)),
      "mechanics.authorizedCount": session.authorizedMechanics.length,
    };
    const constraints = (session.requirements?.constraints ?? []).map((constraint) => evaluateConstraint(constraint, metrics[constraint.metric], constraint.minimumRuns ? Math.min(1, estimates.length / constraint.minimumRuns) : undefined));
    const totalWeight = constraints.reduce((sum, item) => sum + item.weight, 0);
    const hardFailures = findings.filter((finding) => finding.severity === "error");
    return {
      metrics,
      constraints,
      hardFailures,
      weightedGap: totalWeight ? constraints.reduce((sum, item) => sum + item.normalizedGap * item.weight, 0) / totalWeight : hardFailures.length,
      passed: hardFailures.length === 0 && constraints.filter((item) => item.priority === "hard").every((item) => item.pass),
    };
  }

  private estimateMetrics(estimate: ReturnType<typeof estimateNodeDifficulty>): JsonRecord {
    const peakOccupancy = Math.max(0, ...estimate.occupancyHistory.map((sample) => sample.occupied)); const randomPicks = estimate.occupancyHistory.filter((sample) => sample.random).length;
    const detours = estimate.perCustomer.reduce((sum, customer) => sum + Math.max(0, customer.picks - customer.bestPicks), 0);
    return { durationSeconds: estimate.gameplayDurationSeconds ?? 0, picks: estimate.totalPicks, randomPicks, randomPickRatio: estimate.totalPicks ? randomPicks / estimate.totalPicks : 0, detours, detourRatio: estimate.totalPicks ? detours / estimate.totalPicks : 0, peakOccupancy, occupancyRatio: estimate.gridCapacity ? peakOccupancy / estimate.gridCapacity : 0, peakConcurrentWork: estimate.peakConcurrentWork ?? 0, timeouts: estimate.timedOutCustomers.length, served: estimate.servedCount, totalCustomers: estimate.totalCustomers };
  }

  private jsonSafe(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value, (_key, item: unknown) => item instanceof Map ? Object.fromEntries(item) : item instanceof Set ? [...item] : item));
  }

  private levelCsv(session: SessionRecord, serial: { queueString: string; gridString: string; customerString: string }): string {
    const header = oneLineCsv(["Level_ID", "Name", "Weather", "LevelTag", "FeatureUnlock", "ShuffleDistance", "ServeableSlots", "QueueString", "GridString", "CustomerString", "OutOfSlotPolicy", "BoosterCharges"]);
    const level = session.draft.level; const row = oneLineCsv([level.id, level.name, level.weather, level.levelTag, level.featureUnlock, level.shuffleDistance, level.serveableSlots, serial.queueString, serial.gridString, serial.customerString, level.outOfSlotPolicy ?? "", (level.boosterCharges ?? []).join("|")]);
    return `${header}\r\n${row}\r\n`;
  }
}
