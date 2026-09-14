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
import { estimateNodeDifficulty } from "../ui/design/nodeEstimateDifficulty.ts";
import { checkQueueThaw } from "../ui/design/queueThawCheck.ts";
import { checkToolDeadlock } from "../ui/design/toolDeadlockCheck.ts";
import { addToSlot, membersOf, removeFromSlot, slotCapacity, swapInSlot, unmetSlotBase } from "../ui/nodedesign/nodeDishEdit.ts";
import { nodeDemandByRaw } from "../ui/nodedesign/nodeQueueGenerate.ts";
import { interpretLevelBrief } from "./brief.ts";
import { RepositoryAdapter, type AuthoringResources } from "./repository.ts";
import { SessionStore } from "./sessionStore.ts";
import type {
  AuthoringStrategy,
  ConstraintProgress,
  DraftCustomer,
  DraftDish,
  DraftQueueGroup,
  DraftQueueSlot,
  MechanicAuthorization,
  MutationResult,
  SessionDraft,
  SessionRecord,
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

export class LevelAuthoringService {
  readonly repository: RepositoryAdapter;
  readonly store: SessionStore;

  constructor(root = process.cwd(), outputRoot?: string) {
    this.repository = new RepositoryAdapter(root);
    this.store = new SessionStore(root, outputRoot);
  }

  async readAuthoringContext(mapId: string): Promise<JsonRecord> {
    return this.repository.readAuthoringContext(mapId);
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

  interpretLevelBrief(mapId: string, brief: string): JsonRecord {
    return { mapId, ...interpretLevelBrief(brief) };
  }

  async startLevelSession(args: { mapId: string; contextToken: string; brief: string; metadata?: Partial<SessionDraft["level"]>; sessionId?: string }): Promise<JsonRecord> {
    const resources = await this.repository.load(args.mapId);
    if (resources.contextToken !== args.contextToken) throw new Error("The context_token is stale. Read the authoring context again before starting.");
    const interpretation = interpretLevelBrief(args.brief);
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
        ...(args.metadata?.outOfSlotPolicy ? { outOfSlotPolicy: args.metadata.outOfSlotPolicy } : {}),
        ...(args.metadata?.boosterCharges ? { boosterCharges: args.metadata.boosterCharges } : {}),
      },
      customers: [], lanes: [], groups: [], grid,
    };
    const session: SessionRecord = {
      schemaVersion: 1, id, mapId: resources.doc.map.id, contextToken: resources.contextToken,
      originalBrief: args.brief, interpretation, authorizedMechanics: [...interpretation.authorizedMechanics],
      strategyHistory: [], revision: 0, createdAt, updatedAt: createdAt, cycleCount: 0,
      idCounters: { customer: 0, dish: 0, lane: 0, slot: 0, group: 0 }, draft,
      history: [{ revision: 0, draft: clone(draft), label: "session-start", at: createdAt }],
      validationHistory: [], playtestHistory: [],
    };
    await this.store.create(session);
    return { started: true, sessionId: id, revision: 0, authorizedMechanics: session.authorizedMechanics, constraintProgress: this.constraintProgress(session, resources) };
  }

  async getSession(sessionId: string): Promise<SessionRecord> { return this.store.load(sessionId); }

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
    return this.mutate(sessionId, expectedRevision, "amend_session_requirements", { mechanics, approvalNote }, (session) => {
      for (const mechanic of mechanics) if (!session.authorizedMechanics.includes(mechanic)) session.authorizedMechanics.push(mechanic);
      return mechanics;
    });
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
      this.assertCustomerAuthorized(session, resources, input);
      const customer: DraftCustomer = {
        id: this.nextId(session, "customer"), typeId: input.typeId, waitTime: input.waitTime,
        weatherEff: input.weatherEff, dishes: [],
        ...(input.staffAmount !== undefined ? { staffAmount: input.staffAmount } : {}),
        ...(input.customerIndex !== undefined ? { customerIndex: input.customerIndex } : {}),
      };
      const position = input.position === undefined ? session.draft.customers.length : Math.max(0, Math.min(input.position, session.draft.customers.length));
      session.draft.customers.splice(position, 0, customer);
      return [customer];
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
      const ix = buildIndex(resources.doc);
      const ids = buildIdIndex(resources.doc.idTable);
      const dense = ix.compositeByName.get(composite);
      const dataId = dense === undefined ? Number(composite) : ids.byNode.composite.get(composite);
      const name = dataId === undefined ? undefined : ids.byId.composite.get(dataId);
      if (dataId === undefined || !name || ix.compositeByName.get(name) === undefined) throw new Error(`Unknown composite "${composite}".`);
      const dish: DraftDish = { id: this.nextId(session, "dish"), composite: name, root: { kind: "composite", id: dataId, members: [] }, effects: [] };
      this.customer(session, customerId).dishes.push(dish);
      return [dish];
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
      const dish = this.dish(session, dishId);
      const ix = buildIndex(resources.doc); const ids = buildIdIndex(resources.doc.idTable);
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
      return [dish];
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
      const lane = { id: this.nextId(session, "lane"), slots: [] };
      session.draft.lanes.splice(position === undefined ? session.draft.lanes.length : Math.max(0, Math.min(position, session.draft.lanes.length)), 0, lane);
      return [lane];
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
      const lane = this.lane(session, input.laneId); const ids = buildIdIndex(resources.doc.idTable); const ix = buildIndex(resources.doc);
      const dense = ix.ingByName.get(input.ingredient); const name = dense === undefined ? ids.byId.ingredient.get(Number(input.ingredient)) : input.ingredient;
      const dataId = name === undefined ? undefined : ids.byNode.ingredient.get(name); const actualDense = name === undefined ? undefined : ix.ingByName.get(name);
      if (name === undefined || dataId === undefined || actualDense === undefined || !ix.pickupable[actualDense]) throw new Error(`"${input.ingredient}" is not a pickupable graph ingredient.`);
      const resolvedName = name;
      const count = Math.max(1, Math.min(100, Math.floor(input.count ?? 1))); const added = [];
      // `count` = how many SLOTS to add; `amount` = pieces in each (a bag).
      const amount = Math.max(1, Math.min(100, Math.floor(input.amount ?? 1)));
      for (let offset = 0; offset < count; offset++) {
        const slot: DraftQueueSlot = { id: this.nextId(session, "slot"), ingredientId: dataId, ingredient: resolvedName, effects: [], provisional: Boolean(input.provisional), ...(amount > 1 ? { amount } : {}) };
        lane.slots.splice(Math.max(0, Math.min(input.position + offset, lane.slots.length)), 0, slot); added.push(slot);
      }
      return added;
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

  /** Sets a slot's bag size; 1 makes it a plain slot again. */
  async setQueueSlotAmount(sessionId: string, expectedRevision: number, slotId: string, amount: number): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "set_queue_slot_amount", { slotId, amount }, (session) => {
      const slot = this.slot(session, slotId);
      const n = Math.max(1, Math.min(100, Math.floor(amount)));
      if (n > 1) slot.amount = n; else delete slot.amount;
      return [slot];
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
      const mechanic = QUEUE_MECHANIC[effect.effectId]; if (!mechanic) throw new Error(`Unknown queue effect id ${effect.effectId}.`); this.assertAuthorized(session, mechanic);
      this.validateEffect(resources.queueEffects, effect); const slot = this.slot(session, slotId); const at = slot.effects.findIndex((item) => item.effectId === effect.effectId);
      if (at >= 0) slot.effects[at] = effect; else slot.effects.push(effect); return [slot];
    });
  }

  async removeQueueSlotEffect(sessionId: string, expectedRevision: number, slotId: string, effectId: number): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "remove_queue_slot_effect", { slotId, effectId }, (session) => {
      const slot = this.slot(session, slotId); slot.effects = slot.effects.filter((effect) => effect.effectId !== effectId); return [slot];
    });
  }

  async setGridCellEffect(sessionId: string, expectedRevision: number, x: number, y: number, effect: EffectInstance): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "set_grid_cell_effect", { x, y, effect }, (session, resources) => {
      const mechanic = GRID_MECHANIC[effect.effectId]; if (!mechanic) throw new Error(`Unknown grid effect id ${effect.effectId}.`); this.assertAuthorized(session, mechanic);
      this.validateEffect(resources.gridEffects, effect); const cell = this.cell(session, resources.doc, x, y); const at = cell.effects.findIndex((item) => item.effectId === effect.effectId);
      if (at >= 0) cell.effects[at] = effect; else cell.effects.push(effect); return [cell];
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
    const level = toNodeLevel(session.draft, resources);
    const thaw = checkQueueThaw(level.queues, level.queueGroups, { timeBudgetMs: 400, sampleBudgetMs: 200 });
    if (thaw.verdict !== "safe") findings.push({ severity: thaw.verdict === "deadlock" ? "error" : "warning", code: "QUEUE_THAW", message: thaw.message, repair: "Move a thaw-enabling pickup earlier or reduce the blocking freeze count." });
    const tools = checkToolDeadlock(buildIndex(resources.doc), level, { randomRuns: 20, budgetMs: 600 });
    if (!tools.clean) findings.push({ severity: "error", code: "TOOL_DEADLOCK", message: `${tools.toolBlocked} tool-blocked and ${tools.gridBlocked} grid-blocked sampled runs.`, repair: "Increase reachable working capacity or reorder inputs so occupied tools can drain." });
    const result = { revision: session.revision, valid: !findings.some((item) => item.severity === "error"), findings, thaw: this.jsonSafe(thaw), toolDeadlock: this.jsonSafe(tools), constraintProgress: this.constraintProgress(session, resources) };
    session.validationHistory.push({ revision: session.revision, kind: "full", result, at: now() }); await this.store.save(session); return result;
  }

  async estimateDifficulty(sessionId: string): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId); const estimate = estimateNodeDifficulty(buildIndex(resources.doc), toNodeLevel(session.draft, resources), { maxRetries: 2 });
    const metrics = this.estimateMetrics(estimate); const profile = session.interpretation.difficultyProfile;
    const thresholdResults = profile ? Object.entries(profile.thresholds).map(([metric, threshold]) => {
      const value = metrics[metric] as number | undefined; return { metric, value, ...threshold, pass: value !== undefined && (threshold.min === undefined || value >= threshold.min) && (threshold.max === undefined || value <= threshold.max) };
    }) : [];
    const result = { revision: session.revision, metrics, thresholdResults, estimate: this.jsonSafe(estimate) };
    session.validationHistory.push({ revision: session.revision, kind: "estimate", result, at: now() }); await this.store.save(session); return result;
  }

  async playtestInstant(sessionId: string): Promise<JsonRecord> {
    const { session, resources } = await this.sessionResources(sessionId); const estimate = estimateNodeDifficulty(buildIndex(resources.doc), toNodeLevel(session.draft, resources), { maxRetries: 4 });
    if (session.cycleCount >= 20) throw new Error("The session has reached the 20-cycle authoring limit. Report the remaining blocker instead of continuing to loop.");
    const result = {
      revision: session.revision, win: estimate.solvable && estimate.servedCount === estimate.totalCustomers && estimate.timedOutCustomers.length === 0,
      loseReason: estimate.loseReason ?? null, reason: estimate.reason,
      gameplayDurationSeconds: estimate.gameplayDurationSeconds ?? 0, picks: estimate.totalPicks,
      servedCustomers: estimate.servedCount, totalCustomers: estimate.totalCustomers, timedOutCustomers: estimate.timedOutCustomers,
      laneDecisions: estimate.replaySteps, occupancyHistory: estimate.occupancyHistory,
      peakConcurrentWork: estimate.peakConcurrentWork ?? 0, replaySteps: estimate.replaySteps,
      lastPlayableState: estimate.solvable ? undefined : { failureCustomers: estimate.failureCustomers, failureKnowledge: estimate.failureKnowledge },
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
    const session = await this.store.load(sessionId); const fundamental = Boolean(validation.valid && playtest.win && playtest.servedCustomers === playtest.totalCustomers && (playtest.timedOutCustomers as number[]).length === 0);
    if (!fundamental) return { finalized: false, revision: session.revision, validation, estimate, playtest, reason: "Fundamental validity requirements were not met; no valid CSV was finalized." };
    const thresholdMisses = (estimate.thresholdResults as Array<{ pass: boolean }>).filter((item) => !item.pass);
    const checkpoint = await this.checkpointLevel(sessionId, thresholdMisses.length ? "closest" : "valid");
    return { finalized: true, label: thresholdMisses.length ? "closest" : "valid", deviations: thresholdMisses, checkpoint, validation, estimate, playtest };
  }

  async restoreRevision(sessionId: string, expectedRevision: number, revision: number): Promise<MutationResult> {
    return this.mutate(sessionId, expectedRevision, "restore_revision", { revision }, (session) => {
      const snapshot = session.history.find((item) => item.revision === revision); if (!snapshot) throw new Error(`Revision ${revision} is not in session history.`);
      session.draft = clone(snapshot.draft); return [session.draft];
    });
  }

  async undo(sessionId: string, expectedRevision: number): Promise<MutationResult> {
    const session = await this.store.load(sessionId); const prior = [...session.history].reverse().find((item) => item.revision < session.revision);
    if (!prior) throw new Error("There is no earlier revision to restore."); return this.restoreRevision(sessionId, expectedRevision, prior.revision);
  }

  private async mutate(sessionId: string, expectedRevision: number, action: string, input: unknown, change: (session: SessionRecord, resources: AuthoringResources) => unknown[]): Promise<MutationResult> {
    const { session, resources } = await this.sessionResources(sessionId);
    if (session.revision !== expectedRevision) throw new Error(`Revision conflict: expected ${expectedRevision}, current revision is ${session.revision}.`);
    const beforeSupply = this.supplyDemand(session, resources); const beforeDraft = clone(session.draft); const changedObjects = change(session, resources);
    session.revision++; session.updatedAt = now(); session.history.push({ revision: session.revision, draft: clone(session.draft), label: action, at: session.updatedAt });
    const findings = this.fastFindings(session, resources); const afterSupply = this.supplyDemand(session, resources);
    await this.store.save(session); await this.store.appendAction(session.id, { at: session.updatedAt, revision: session.revision, action, input, beforeDraft, changedObjects, findings });
    return { sessionId, revision: session.revision, changedObjects, constraintProgress: this.constraintProgress(session, resources), supplyDemandChanges: { before: beforeSupply, after: afterSupply }, findings };
  }

  private async sessionResources(sessionId: string): Promise<{ session: SessionRecord; resources: AuthoringResources }> {
    const session = await this.store.load(sessionId); const resources = await this.repository.load(session.mapId);
    if (resources.contextToken !== session.contextToken) throw new Error("The map graph/rules/catalog changed after this session started. Start a new session from fresh authoring context.");
    return { session, resources };
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
    for (const lane of session.draft.lanes) for (const slot of lane.slots) have.set(slot.ingredientId, (have.get(slot.ingredientId) ?? 0) + 1);
    const allIds = new Set([...demand.keys(), ...have.keys()]);
    const ingredients = [...allIds].sort((a, b) => a - b).map((dataId) => {
      const raw = demand.get(dataId); const needUnits = raw?.need ?? 0; const usablePerPickup = Math.max(1, raw?.amount ?? 1) * Math.max(1, raw?.usageNum ?? 1);
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
        yield: raw?.amount ?? 1, reusableUseMultiplier: raw?.usageNum ?? 1,
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
    const supply = this.supplyDemand(session, resources); for (const missing of supply.missing as Array<{ ingredient: string; howMany: number }>) findings.push({ severity: "error", code: "MISSING_SUPPLY", message: `Missing ${missing.howMany} pickup(s) of ${missing.ingredient}.`, repair: `Add ${missing.howMany} pickup(s) of ${missing.ingredient}.` });
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
