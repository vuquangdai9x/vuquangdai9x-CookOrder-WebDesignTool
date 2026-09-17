import type { GraphIndex } from "../../core/nodeIndex.ts";
import { parseNodeCustomers, serializeNodeCustomers } from "../../core/nodeParser.ts";
import { parseGrid, parseQueues, serializeQueues } from "../../core/parser.ts";
import type { IdIndex } from "../../data/nodeIdTable.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import type { ProjectedMap } from "../../data/nodeGraphToMapDef.ts";
import {
  materializeObstacleCoverage,
  type SharedGenerationProfileV2,
} from "../../generation/sharedGenerationProfile.ts";
import { finalizeSharedObstacles } from "../../generation/finalizeSharedObstacles.ts";
import {
  createCustomerPhaseData,
  createPickupPhaseData,
  createQueuePhaseData,
  decodeCustomerPhaseData,
  decodePickupPhaseData,
  decodeQueuePhaseData,
  encodeCustomerPhaseData,
  encodePickupPhaseData,
  encodeQueuePhaseData,
  levelProjectionHashes,
} from "../../data/generatorPersistence/index.ts";
import {
  appendManualPickupStep,
  artifactHash,
  confirmVector,
  createAuthoringContext,
  createPickupPlan,
  createVectorDraft,
  getPhaseReadiness,
  markArtifactStale,
  projectQueueArtifact,
  refreshPickupPlanArtifact,
  reviseVectorDraft,
  truncatePickupPlan,
  validateCustomerOrderArtifact,
  validatePickupPlan,
  validateQueueArtifact,
  validateQueueFirstLevel,
  type AuthoringContextArtifact,
  type CustomerGenerationVector,
  type CustomerGenerationVectorArtifact,
  type CustomerOrderArtifact,
  type PickupPlanArtifact,
  type PickupPlanningVector,
  type PickupPlanningVectorArtifact,
  type QueueArtifact,
  type QueueFirstPhase,
  type QueueGenerationVector,
  type QueueGenerationVectorArtifact,
  type GenerateQueuePhaseResult,
  type GenerateCustomersResult,
  type PickupSearchResult,
} from "../../generation/queue-first/index.ts";
import { button, el } from "../dom.ts";
import { showContextMenu } from "../contextMenu.ts";
import { createSharedProfileEditor } from "../generator/sharedProfileEditor.ts";
import {
  startBackgroundGeneration,
  type BackgroundGenerationTask,
} from "../generator/backgroundGeneration.ts";
import {
  createResizableGeneratorColumns,
  type GeneratorColumnWidths,
} from "../generator/resizableColumns.ts";
import { captureModalScrollState, restoreModalScrollState } from "../generator/modalScrollState.ts";
import { serializeObstacles } from "../levelpath/obstacles.ts";
import {
  createCustomerVectorVisualEditor,
  createPickupVectorVisualEditor,
  createQueueVectorVisualEditor,
} from "./vectorVisualEditor.ts";
import { createQueueArtifactCanvas } from "./queueArtifactCanvas.ts";
import { createPickupCanvas, queueArtifactAtPickupCursor } from "./pickupCanvas.ts";

export interface QueueFirstWorkspaceOptions {
  mapId: string;
  level: LevelData;
  ix: GraphIndex;
  ids: IdIndex;
  projected?: ProjectedMap;
  sharedProfile?: SharedGenerationProfileV2;
  onSharedProfileChanged?(profile: SharedGenerationProfileV2): void;
  onSwitchToCustomer?(): void;
  onChanged(): void;
  onClosed?(): void;
}

const emptyCoverage = (): QueueGenerationVector["combinedCoverageBySize"] => ({ 2: 0, 3: 0, 4: 0, 5: 0 });

function applySharedToQueueVector(
  values: QueueGenerationVector,
  shared: SharedGenerationProfileV2,
  ix: GraphIndex,
): void {
  values.seed = shared.seed ?? values.seed;
  values.sharedProfileHash = artifactHash(shared);
  values.ingredientWeights = {};
  values.amountRanges = {};
  ix.pickupable.forEach((enabled, index) => {
    if (!enabled) return;
    const name = ix.ingName[index];
    values.ingredientWeights[String(index)] = shared.ingredientWeightsByName[name] ?? 0;
    const range = shared.amountRangesByName[name];
    if (range) values.amountRanges![String(index)] = { ...range };
  });
  if (Object.keys(values.amountRanges).length === 0) delete values.amountRanges;
  values.obstacleCoverage.freeze = shared.obstacles.queue.frozen;
  values.obstacleCoverage.hidden = shared.obstacles.queue.hidden;
  values.obstacleCoverage.holdingKey = 0;
  delete values.holdingKeyColors;
  values.combinedCoverageBySize = { ...shared.obstacles.queue.combinedBySize };
  values.linkedCoverageBySize = { ...shared.obstacles.queue.linkedBySize };
}

function applySharedToCustomerVector(
  values: CustomerGenerationVector,
  shared: SharedGenerationProfileV2,
): void {
  values.seed = shared.seed ?? values.seed;
  values.sharedProfileHash = artifactHash(shared);
  values.dishTypeWeights = { ...shared.dishTypeWeightsByName };
}

function defaultQueueVector(ix: GraphIndex, level: LevelData, shared?: SharedGenerationProfileV2): QueueGenerationVector {
  const weights: Record<string, number> = {};
  const amountRanges: Record<string, { min: number; max: number }> = {};
  ix.pickupable.forEach((enabled, index) => {
    if (!enabled) return;
    const name = ix.ingName[index];
    weights[String(index)] = shared?.ingredientWeightsByName[name] ?? 100;
    const range = shared?.amountRangesByName[name];
    if (range) amountRanges[String(index)] = { ...range };
  });
  const existingUnits = level.queueString.trim() ? 20 : 0;
  return {
    seed: shared?.seed ?? level.randomSeed ?? 1,
    ...(shared ? { sharedProfileHash: artifactHash(shared) } : {}),
    laneCount: 4,
    targetPickupUnits: Math.max(1, existingUnits || 20),
    ingredientWeights: weights,
    ...(Object.keys(amountRanges).length ? { amountRanges } : {}),
    amountMode: "balanced",
    texture: { maximumIdenticalRun: 3 },
    obstacleCoverage: {
      freeze: shared?.obstacles.queue.frozen ?? 0,
      hidden: shared?.obstacles.queue.hidden ?? 0,
      // Lock and key is paired with the grid and materialized at final commit.
      holdingKey: 0,
    },
    combinedCoverageBySize: shared ? { ...shared.obstacles.queue.combinedBySize } : emptyCoverage(),
    linkedCoverageBySize: shared ? { ...shared.obstacles.queue.linkedBySize } : emptyCoverage(),
    feasibilityMode: "free",
    forceMove: 0.5,
  };
}

function currentGridCapacity(level: LevelData, ix: GraphIndex): number {
  const total = Math.max(0, ix.doc.map.gridWidth * ix.doc.map.gridHeight);
  try {
    const cells = parseGrid(level.gridString);
    return Math.max(0, total - cells.slice(0, total).filter((cell) => cell.effects.length > 0).length);
  } catch {
    return total;
  }
}

const defaultPickupVector = (seed: number): PickupPlanningVector => ({
  seed,
  mode: "auto",
  completionPolicy: "allow-auto-suffix",
  targetWaveSize: 3,
  preferLaneBalance: 1,
  preferIngredientWaveAlignment: 1,
  penalizeAmountBurst: 1,
  search: { beamWidth: 32, maximumExpandedStates: 25_000, wallTimeMs: 2_000 },
});

const defaultCustomerVector = (seed: number, serveableSlots: number): CustomerGenerationVector => ({
  seed,
  mode: "auto",
  minCustomers: 1,
  maxCustomers: 20,
  minDishesPerCustomer: 1,
  maxDishesPerCustomer: 3,
  maxDishSlots: 5,
  serveableSlots: Math.max(1, serveableSlots),
  earlyInventoryWeight: 1,
  pickupToDemandDistanceWeight: 1,
  varietyWeight: 1,
  search: { beamWidth: 32, maximumCandidates: 200, maximumExpandedStates: 100_000, wallTimeMs: 3_000 },
});

function pretty(value: unknown): string { return JSON.stringify(value, null, 2); }

export function openQueueFirstWorkspace(options: QueueFirstWorkspaceOptions): void {
  let sharedProfile = options.sharedProfile ? structuredClone(options.sharedProfile) : undefined;
  const graphHash = artifactHash(options.ix.doc);
  const currentContext: AuthoringContextArtifact = createAuthoringContext({
    mapId: options.mapId,
    graphHash,
    referenceProfileId: "current-level",
    authorizedMechanics: ["freeze", "hidden", "holdingKey"],
    constraints: { gridCapacity: currentGridCapacity(options.level, options.ix) },
  });
  let context = currentContext;
  let queueVector: QueueGenerationVectorArtifact = createVectorDraft({
    kind: "queue-vector",
    values: defaultQueueVector(options.ix, options.level, sharedProfile),
    context,
  });
  let pickupVector: PickupPlanningVectorArtifact = createVectorDraft({
    kind: "pickup-vector",
    values: defaultPickupVector(queueVector.values.seed),
    context,
  });
  let customerVector: CustomerGenerationVectorArtifact = createVectorDraft({
    kind: "customer-vector",
    values: defaultCustomerVector(queueVector.values.seed, options.level.serveableSlots),
    context,
  });
  if (sharedProfile) {
    const values = structuredClone(customerVector.values);
    applySharedToCustomerVector(values, sharedProfile);
    customerVector = createVectorDraft({ kind: "customer-vector", values, context });
  }
  let queue: QueueArtifact | undefined;
  let pickup: PickupPlanArtifact | undefined;
  let customers: CustomerOrderArtifact | undefined;
  let vectorDrafts: {
    queue: QueueGenerationVector;
    pickup: PickupPlanningVector;
    customers: CustomerGenerationVector;
  } = {
    queue: structuredClone(queueVector.values),
    pickup: structuredClone(pickupVector.values),
    customers: structuredClone(customerVector.values),
  };
  const editorModes: Record<QueueFirstPhase, "visual" | "json"> = {
    queue: "visual",
    pickup: "visual",
    customers: "visual",
  };
  const loadWarnings: string[] = [];
  let notice: { tone: "ok" | "warning" | "error"; message: string } | undefined;
  const notify = (message: string, tone: "ok" | "warning" | "error" = "error"): void => {
    notice = { tone, message };
  };
  interface WorkspaceSnapshot {
    context: AuthoringContextArtifact;
    queueVector: QueueGenerationVectorArtifact;
    pickupVector: PickupPlanningVectorArtifact;
    customerVector: CustomerGenerationVectorArtifact;
    queue?: QueueArtifact;
    pickup?: PickupPlanArtifact;
    customers?: CustomerOrderArtifact;
  }
  const undoStack: WorkspaceSnapshot[] = [];
  const redoStack: WorkspaceSnapshot[] = [];
  const capture = (): WorkspaceSnapshot => structuredClone({
    context, queueVector, pickupVector, customerVector, queue, pickup, customers,
  });
  const restore = (snapshot: WorkspaceSnapshot): void => {
    ({ context, queueVector, pickupVector, customerVector, queue, pickup, customers } = structuredClone(snapshot));
    vectorDrafts = {
      queue: structuredClone(queueVector.values),
      pickup: structuredClone(pickupVector.values),
      customers: structuredClone(customerVector.values),
    };
    if (sharedProfile) applySharedToQueueVector(vectorDrafts.queue, sharedProfile, options.ix);
    if (sharedProfile) applySharedToCustomerVector(vectorDrafts.customers, sharedProfile);
  };
  const checkpoint = (): void => {
    undoStack.push(capture());
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  };

  try {
    if (options.level.queuePhaseData) {
      const data = decodeQueuePhaseData(options.level.queuePhaseData);
      context = data.context;
      queueVector = data.vector;
      queue = data.artifact;
      if (context.contentHash !== currentContext.contentHash) {
        context = currentContext;
        queueVector = createVectorDraft({ kind: "queue-vector", values: queueVector.values, context });
        if (queue) queue = markArtifactStale(queue);
        loadWarnings.push("Saved Queue phase uses a different graph, map, or grid capacity and was restored as stale.");
      }
    }
    if (options.level.pickupPhaseData) {
      const data = decodePickupPhaseData(options.level.pickupPhaseData);
      pickupVector = data.vector;
      pickup = data.artifact;
      if (context.status === "stale" || data.queueHash !== queue?.contentHash) {
        pickupVector = markArtifactStale(pickupVector);
        if (pickup) pickup = markArtifactStale(pickup);
      }
    }
    if (options.level.customerPhaseData) {
      const data = decodeCustomerPhaseData(options.level.customerPhaseData);
      customerVector = data.vector;
      customers = data.artifact;
      if (context.status === "stale" || data.queueHash !== queue?.contentHash || data.pickupPlanHash !== pickup?.contentHash) {
        customerVector = markArtifactStale(customerVector);
        if (customers) customers = markArtifactStale(customers);
      }
    }
  } catch (error) {
    loadWarnings.push(error instanceof Error ? error.message : String(error));
  }
  vectorDrafts = {
    queue: structuredClone(queueVector.values),
    pickup: structuredClone(pickupVector.values),
    customers: structuredClone(customerVector.values),
  };
  if (sharedProfile) {
    applySharedToQueueVector(vectorDrafts.queue, sharedProfile, options.ix);
    applySharedToCustomerVector(vectorDrafts.customers, sharedProfile);
    if (pretty(vectorDrafts.queue) !== pretty(queueVector.values)) {
      queueVector = reviseVectorDraft(queueVector, vectorDrafts.queue);
    }
    if (pretty(vectorDrafts.customers) !== pretty(customerVector.values)) {
      customerVector = reviseVectorDraft(customerVector, vectorDrafts.customers);
    }
  }

  let phase: QueueFirstPhase = "queue";
  let reviewMode = false;
  let draftSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let pickupCursor = pickup?.steps.length ?? 0;
  let customerTimelineCursor = pickup?.steps.length ?? 0;
  let queueSelection = new Set<string>();
  const foldoutState = new Map<string, boolean>();
  const columnWidths: GeneratorColumnWidths = {};
  let generationTask: BackgroundGenerationTask<unknown> | undefined;
  let generationProgress: { percentage: number; description: string } | undefined;
  let lastRenderedView: string | undefined;
  const overlay = el("div", { class: "overlay-panel queue-first-overlay" });
  const shell = el("div", { class: "queue-first-workspace" });
  overlay.append(shell);
  const close = () => {
    generationTask?.cancel();
    overlay.remove();
    options.onClosed?.();
  };

  const persist = (which: QueueFirstPhase): void => {
    const projection = levelProjectionHashes(options.level);
    if (which === "queue") {
      options.level.queuePhaseData = encodeQueuePhaseData(createQueuePhaseData({ context, vector: queueVector, artifact: queue, levelProjectionHashes: projection }));
    } else if (which === "pickup") {
      options.level.pickupPhaseData = encodePickupPhaseData(createPickupPhaseData({
        vector: pickupVector,
        artifact: pickup,
        queueHash: queue?.contentHash ?? "",
        levelProjectionHashes: projection,
      }));
    } else {
      options.level.customerPhaseData = encodeCustomerPhaseData(createCustomerPhaseData({
        vector: customerVector,
        artifact: customers,
        queueHash: queue?.contentHash ?? "",
        pickupPlanHash: pickup?.contentHash ?? "",
        levelProjectionHashes: projection,
      }));
    }
    options.onChanged();
  };

  const readiness = (which: QueueFirstPhase) => getPhaseReadiness({
    phase: which,
    context,
    vector: which === "queue" ? queueVector : which === "pickup" ? pickupVector : customerVector,
    queue,
    pickupPlan: pickup,
  });

  const renderQueueCanvas = (): HTMLElement => {
    if (!queue) return el("p", { class: "muted" }, ["No Queue artifact yet."]);
    return createQueueArtifactCanvas({
      artifact: queue,
      ix: options.ix,
      selected: queueSelection,
      onSelectionChange: (next) => { queueSelection = next; },
      onChange: (next, description) => {
        checkpoint();
        const previousHash = queue?.contentHash;
        const validation = validateQueueArtifact(next, queueVector, context, options.ix);
        queue = {
          ...next,
          status: validation.valid ? "valid" : "invalid",
          warnings: validation.warnings,
          diagnostics: {
            ...next.diagnostics,
            structuralVerdict: validation.structuralVerdict,
            structuralMessage: validation.structuralMessage,
          },
        };
        if (previousHash !== queue.contentHash) {
          if (pickup) pickup = markArtifactStale(pickup);
          if (customers) customers = markArtifactStale(customers);
        }
        notify(validation.errors.length ? validation.errors.join("\n") : description, validation.errors.length ? "warning" : "ok");
        persist("queue");
        render();
      },
    });
  };

  const renderArtifact = (): HTMLElement => {
    const artifact = phase === "queue" ? queue : phase === "pickup" ? pickup : customers;
    const status = artifact?.status ?? "missing";
    const hash = artifact?.contentHash ?? "—";
    const children: (Node | string)[] = [
      el("h3", {}, ["Artifact / issues"]),
      el("p", {}, [`Status: ${status}`]),
      el("code", { class: "qf-hash" }, [hash]),
    ];
    const ready = readiness(phase);
    if (!ready.ready) children.push(el("ul", {}, ready.issues.map((issue) => el("li", {}, [issue.message]))));
    if (artifact?.warnings.length) children.push(el("ul", {}, artifact.warnings.map((warning) => el("li", {}, [warning]))));
    if (phase === "pickup" && pickup) {
      children.push(el("h4", {}, ["Pickup route"]));
      children.push(el("p", {}, [`${pickup.steps.length} actions · ${pickup.completion} · ${pickup.mode}`]));
    }
    if (phase === "customers" && customers) {
      children.push(el("h4", {}, ["Customers following pickup path"]));
      children.push(el("div", { class: "qf-customers" }, customers.customers.map((customer, index) =>
        el("div", { class: "qf-customer" }, [`Customer ${index + 1} · ${customer.dishes.length} dish(es)`]),
      )));
      children.push(el("p", {}, [`Unallocated: ${pretty(customers.diagnostics.unconsumedSupply)} · Missing: ${pretty(customers.diagnostics.missingSupply)}`]));
    }
    return el("aside", { class: "qf-artifact" }, children);
  };

  const renderCustomerCanvas = (): HTMLElement => {
    if (!queue || !pickup) return el("p", { class: "muted" }, ["Complete Queue and Pickup phases to unlock customer allocation."]);
    const maxCursor = pickup.steps.length;
    customerTimelineCursor = Math.max(0, Math.min(customerTimelineCursor, maxCursor));
    const slider = el("input", {
      type: "range",
      min: "0",
      max: String(maxCursor),
      value: String(customerTimelineCursor),
      "aria-label": "Customer phase timeline position",
      title: "Preview the grid, customers, and remaining queues at a pickup step.",
    }) as HTMLInputElement;
    slider.addEventListener("input", () => {
      customerTimelineCursor = Number(slider.value);
      render();
    });
    const customerList = el("div", { class: "customer-cards qf-phase3-customer-list" }, (customers?.customers ?? []).map((customer, index) =>
      el("div", { class: "customer-card", title: "Customer editing behavior will be connected in the next iteration." }, [
        el("span", { class: "cust-index" }, [String(index + 1)]),
        el("strong", {}, [customer.typeId === 1 ? "Staff" : `Customer ${index + 1}`]),
        el("span", { class: "muted" }, [`${customer.dishes.length} dish${customer.dishes.length === 1 ? "" : "es"}`]),
      ]),
    ));
    if (!customers?.customers.length) customerList.append(el("div", { class: "qf-empty-card" }, ["Generate customers to populate this horizontal editor strip."]));
    let gridCells: ReturnType<typeof parseGrid> = [];
    try { gridCells = parseGrid(options.level.gridString); } catch { gridCells = []; }
    const gridWidth = Math.max(1, options.ix.doc.map.gridWidth);
    const grid = el("div", { class: "qf-phase3-grid", style: `--grid-width:${gridWidth}` }, gridCells.map((cell, index) =>
      el("div", { class: `qf-phase3-grid-cell${cell.effects.length ? " occupied" : ""}`, title: `Grid ${index + 1}${cell.effects.length ? ` · effects ${cell.effects.map((item) => item.effectId).join(", ")}` : ""}` }, [
        cell.effects.length ? cell.effects.map((item) => `#${item.effectId}`).join(" ") : "",
      ]),
    ));
    const queueState = queueArtifactAtPickupCursor(queue, pickup, customerTimelineCursor);
    const queuePreview = createQueueArtifactCanvas({
      artifact: queueState.artifact,
      ix: options.ix,
      selected: new Set(),
      readOnly: true,
      freezeBySlot: queueState.freezeBySlot,
    });
    return el("div", { class: "qf-phase3-layout" }, [
      el("div", { class: "qf-phase3-header" }, [
        el("div", {}, [el("h4", {}, ["Customers"]), el("p", { class: "muted" }, ["Layout shell only — editing and timeline-driven customer behavior are deferred to the next pass."])]),
      ]),
      customerList,
      el("div", { class: "qf-phase3-timeline" }, [
        el("span", {}, [`Pickup step ${customerTimelineCursor}/${maxCursor}`]),
        slider,
      ]),
      el("div", { class: "qf-phase3-state" }, [
        el("section", {}, [el("h4", {}, ["Grid"]), grid]),
        el("section", {}, [el("h4", {}, [`Ingredient queues · ${queueState.remaining} slots remain`]), queuePreview]),
      ]),
    ]);
  };

  const startTask = async <T,>(
    task: BackgroundGenerationTask<T>,
    apply: (result: T) => void,
  ): Promise<void> => {
    generationTask = task as BackgroundGenerationTask<unknown>;
    generationProgress = { percentage: 0, description: "Starting background generation…" };
    render();
    try {
      const result = await task.promise;
      apply(result);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        notify(error instanceof Error ? error.message : String(error));
      }
    } finally {
      generationTask = undefined;
      generationProgress = undefined;
      render();
    }
  };

  const progress = (percentage: number, description: string): void => {
    generationProgress = { percentage: Math.max(0, Math.min(100, percentage)), description };
    render();
  };

  const freshPickupPlan = (): PickupPlanArtifact | undefined => {
    if (!queue) return undefined;
    if (pickup && pickup.queueHash === queue.contentHash && pickup.vectorHash === pickupVector.contentHash) return pickup;
    const created = createPickupPlan(context, pickupVector, queue);
    if (!created.started) {
      notify(created.readinessIssues.map((issue) => issue.message).join("\n"));
      return undefined;
    }
    return created.artifact;
  };

  const autoCompletePickup = (): void => {
    if (!queue || generationTask) return;
    let plan = freshPickupPlan();
    if (!plan) { render(); return; }
    checkpoint();
    const cursor = Math.max(0, Math.min(pickupCursor, plan.steps.length));
    if (cursor < plan.steps.length) {
      const truncated = truncatePickupPlan(plan, queue, plan.contentHash, cursor);
      if (truncated.error) { notify(truncated.error); render(); return; }
      plan = truncated.artifact;
    }
    plan = refreshPickupPlanArtifact({
      ...plan,
      mode: plan.steps.length ? "manual-with-auto-suffix" : "auto",
    });
    const previousHash = pickup?.contentHash;
    void startTask<PickupSearchResult>(startBackgroundGeneration<PickupSearchResult>({
      kind: "pickup",
      source: plan,
      queue,
      vector: pickupVector,
    }, progress), (result) => {
      pickup = result.artifact;
      pickupCursor = pickup.steps.length;
      customerTimelineCursor = pickupCursor;
      if (customers && previousHash !== pickup.contentHash) customers = markArtifactStale(customers);
      if (!result.complete) notify(result.reason ?? "Pickup search returned a partial route.", "warning");
      else notify("Pickup route generated in the background.", "ok");
      persist("pickup");
    });
  };

  const startManualPickup = (): void => {
    if (!queue || generationTask) return;
    let plan = freshPickupPlan();
    if (!plan) { render(); return; }
    checkpoint();
    if (pickupCursor < plan.steps.length) {
      const truncated = truncatePickupPlan(plan, queue, plan.contentHash, pickupCursor);
      if (truncated.error) { notify(truncated.error); render(); return; }
      plan = truncated.artifact;
    }
    pickup = refreshPickupPlanArtifact({ ...plan, mode: "manual" });
    pickupCursor = pickup.steps.length;
    persist("pickup");
    render();
  };

  const appendManualPick = (actionId: string): void => {
    if (!queue || !pickup || generationTask) return;
    checkpoint();
    let plan = pickup;
    if (pickupCursor < plan.steps.length) {
      const truncated = truncatePickupPlan(plan, queue, plan.contentHash, pickupCursor);
      if (truncated.error) { notify(truncated.error); render(); return; }
      plan = truncated.artifact;
    }
    plan = refreshPickupPlanArtifact({ ...plan, mode: "manual" });
    const result = appendManualPickupStep(plan, queue, plan.contentHash, actionId);
    if (result.error) notify(result.error);
    else {
      pickup = result.artifact;
      pickupCursor = pickup.steps.length;
      customerTimelineCursor = pickupCursor;
      if (customers) customers = markArtifactStale(customers);
      persist("pickup");
    }
    render();
  };

  const runPhase = (): void => {
    if (generationTask) return;
    if (phase === "queue") {
      checkpoint();
      const previousHash = queue?.contentHash;
      void startTask<GenerateQueuePhaseResult>(startBackgroundGeneration<GenerateQueuePhaseResult>({
        kind: "queue",
        context,
        vector: queueVector,
        doc: options.ix.doc,
      }, progress), (result) => {
        if (!result.started) notify([...result.readinessIssues.map((issue) => issue.message), ...result.errors].join("\n"));
        else {
          queue = result.artifact;
          queueSelection.clear();
          if (previousHash && previousHash !== queue.contentHash) {
            if (pickup) pickup = markArtifactStale(pickup);
            if (customers) customers = markArtifactStale(customers);
          }
          const witness = queue.diagnostics.feasibility?.witnessSteps;
          if (!result.errors.length && witness) {
            const nextPickupValues = { ...pickupVector.values, seed: queue.seed, mode: "auto" as const };
            pickupVector = confirmVector(reviseVectorDraft(pickupVector, nextPickupValues), "queue-feasibility");
            const created = createPickupPlan(context, pickupVector, queue);
            if (created.started) {
              let plan = created.artifact;
              let witnessError: string | undefined;
              for (const step of witness) {
                const appended = appendManualPickupStep(plan, queue, plan.contentHash, step.actionId);
                plan = appended.artifact;
                if (appended.error) { witnessError = appended.error; break; }
              }
              pickup = refreshPickupPlanArtifact({ ...plan, mode: "auto" });
              pickupCursor = pickup.steps.length;
              customerTimelineCursor = pickupCursor;
              if (customers) customers = markArtifactStale(customers);
              persist("pickup");
              if (witnessError) notify(`Queue is valid, but its verified timeline could not be restored: ${witnessError}`, "warning");
              else notify("Queue and verified pickup timeline generated in the background.", "ok");
            }
          } else if (result.errors.length) notify(result.errors.join("\n"), "warning");
          else notify("Queue artifact generated in the background.", "ok");
          persist("queue");
        }
      });
      return;
    }
    if (phase === "pickup") {
      autoCompletePickup();
      return;
    }
    if (!queue || !pickup) {
      notify("A valid Queue and complete Pickup plan are required.");
      render();
      return;
    }
    checkpoint();
    const sourceQueue = queue;
    const sourcePickup = pickup;
    void startTask<GenerateCustomersResult>(startBackgroundGeneration<GenerateCustomersResult>({
      kind: "customers",
      context,
      vector: customerVector,
      queue: sourceQueue,
      pickup: sourcePickup,
      doc: options.ix.doc,
      existing: customers,
    }, progress), (result) => {
      if (!result.started) notify(result.readinessIssues.map((issue) => issue.message).join("\n"));
      else if (!result.ok) {
        customers = result.draft;
        notify(`${result.failure.kind}\n${result.failure.blockingRecipeRules.join("\n")}`);
      } else {
        customers = result.artifact;
        notify("Customer artifact generated in the background.", "ok");
      }
      persist("customers");
    });
  };

  const validatePhase = (): void => {
    let errors: string[] = [];
    if (phase === "queue" && queue) errors = validateQueueArtifact(queue, queueVector, context, options.ix).errors;
    else if (phase === "pickup" && pickup && queue) errors = validatePickupPlan(pickup, queue).errors;
    else if (phase === "customers" && customers && queue && pickup) {
      errors = validateCustomerOrderArtifact(customers, customerVector, queue, pickup, { ix: options.ix, ids: options.ids }).errors;
    } else errors = ["The current phase has no artifact to validate."];
    notify(errors.length ? errors.join("\n") : "Phase is valid.", errors.length ? "error" : "ok");
    render();
  };

  const applyArtifact = (): void => {
    if (phase === "queue" && queue?.status === "valid") {
      const projected = projectQueueArtifact(queue);
      options.level.queueString = serializeQueues(projected.queues, projected.groups);
    } else if (phase === "customers" && customers?.status === "valid") {
      options.level.customerString = serializeNodeCustomers(customers.customers);
    } else {
      notify("Only a valid Queue or Customer artifact can be applied to the playable level.");
      render();
      return;
    }
    options.onChanged();
    persist(phase);
    notify("Applied to the playable level. Other phases were not changed.", "ok");
    render();
  };

  const commitCompleteLevel = (): void => {
    if (!queue || !pickup || !customers) {
      notify("Complete all three phases before committing the level.");
      render();
      return;
    }
    const result = validateQueueFirstLevel({
      context,
      queueVector,
      queue,
      pickupVector,
      pickupPlan: pickup,
      customerVector,
      customers,
      env: { ix: options.ix, ids: options.ids },
    });
    if (!result.valid || !result.canonical) {
      notify(result.errors.join("\n"));
      render();
      return;
    }
    const finalized = sharedProfile
      ? finalizeSharedObstacles({
          level: options.level,
          customerString: result.canonical.customerString,
          queueString: result.canonical.queueString,
          profile: sharedProfile.obstacles,
          seed: sharedProfile.seed ?? queueVector.values.seed,
          ix: options.ix,
          ids: options.ids,
        })
      : undefined;
    options.level.queueString = finalized?.queueString ?? result.canonical.queueString;
    options.level.customerString = finalized?.customerString ?? result.canonical.customerString;
    if (finalized && sharedProfile) {
      options.level.gridString = finalized.gridString;
      options.level.obstacleData = serializeObstacles(materializeObstacleCoverage(sharedProfile.obstacles, {
        gridCells: options.ix.doc.map.gridWidth * options.ix.doc.map.gridHeight,
        queueSlots: parseQueues(finalized.queueString).reduce((sum, lane) => sum + lane.length, 0),
        orderingCustomers: parseNodeCustomers(finalized.customerString).filter((customer) => customer.typeId !== 1).length,
      }).config);
    }
    persist("queue");
    persist("pickup");
    persist("customers");
    options.onChanged();
    const warnings = [...result.warnings, ...(finalized?.warnings ?? [])];
    notify(warnings.length ? `Committed with warnings:\n${warnings.join("\n")}` : "Validated Queue-First level committed.", warnings.length ? "warning" : "ok");
    render();
  };

  const render = (): void => {
    const viewKey = reviewMode ? "review" : phase;
    const scrollPositions = lastRenderedView === viewKey
      ? captureModalScrollState(shell)
      : [];
    const vector = phase === "queue" ? queueVector : phase === "pickup" ? pickupVector : customerVector;
    const editable = vectorDrafts[phase];
    const textarea = el("textarea", { class: "qf-vector-json", rows: "20" }, [pretty(editable)]) as HTMLTextAreaElement;
    const scheduleAutosave = (): void => {
      if (draftSaveTimer) clearTimeout(draftSaveTimer);
      const savedPhase = phase;
      const saved = structuredClone(editable);
      draftSaveTimer = setTimeout(() => {
        draftSaveTimer = undefined;
        if (savedPhase === "queue") {
          const previousHash = queueVector.contentHash;
          queueVector = reviseVectorDraft(queueVector, saved as QueueGenerationVector);
          if (previousHash !== queueVector.contentHash) {
            if (queue) queue = markArtifactStale(queue);
            if (pickup) pickup = markArtifactStale(pickup);
            if (customers) customers = markArtifactStale(customers);
          }
        } else if (savedPhase === "pickup") {
          const previousHash = pickupVector.contentHash;
          pickupVector = reviseVectorDraft(pickupVector, saved as PickupPlanningVector);
          if (previousHash !== pickupVector.contentHash) {
            if (pickup) pickup = markArtifactStale(pickup);
            if (customers) customers = markArtifactStale(customers);
          }
        } else {
          const previousHash = customerVector.contentHash;
          customerVector = reviseVectorDraft(customerVector, saved as CustomerGenerationVector);
          if (previousHash !== customerVector.contentHash && customers) customers = markArtifactStale(customers);
        }
        persist(savedPhase);
        const active = document.activeElement as HTMLElement | null;
        if (active && shell.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) {
          active.addEventListener("blur", () => requestAnimationFrame(() => render()), { once: true });
        } else {
          render();
        }
      }, 250);
    };
    const syncTextarea = () => {
      textarea.value = pretty(editable);
      textarea.classList.remove("invalid");
      scheduleAutosave();
    };
    const visual = phase === "queue"
      ? createQueueVectorVisualEditor(editable as QueueGenerationVector, options.ix, syncTextarea, {
          includeShared: !(sharedProfile && options.projected),
          foldoutState,
          statePrefix: "queue:",
        })
      : phase === "pickup"
        ? createPickupVectorVisualEditor(editable as PickupPlanningVector, syncTextarea, { foldoutState, statePrefix: "pickup:" })
        : createCustomerVectorVisualEditor(editable as CustomerGenerationVector, syncTextarea, { foldoutState, statePrefix: "customers:" });
    const sharedPanel = phase === "queue" && sharedProfile && options.projected
      ? createSharedProfileEditor({
          profile: sharedProfile,
          ix: options.ix,
          ids: options.ids,
          projected: options.projected,
          basis: {
            gridCells: options.ix.doc.map.gridWidth * options.ix.doc.map.gridHeight,
            queueSlots: queue
              ? queue.lanes.reduce((sum, lane) => sum + lane.slots.length, 0)
              : (() => { try { return parseQueues(options.level.queueString).reduce((sum, lane) => sum + lane.length, 0); } catch { return 0; } })(),
            orderingCustomers: customers
              ? customers.customers.filter((customer) => customer.typeId !== 1).length
              : (() => { try { return parseNodeCustomers(options.level.customerString).filter((customer) => customer.typeId !== 1).length; } catch { return 0; } })(),
          },
          impactText: "Queue-first uses ingredient weights to create supply and dish-type weights as soft guidance when solving customers. Zero-weight dishes are excluded. Queue effects and groups are placed before pickup planning; grid/customer coverage is applied at final commit.",
          foldoutState,
          statePrefix: "shared:",
          mode: editorModes[phase],
          showModeToggle: false,
          onChange: (next) => {
            sharedProfile = next;
            applySharedToQueueVector(editable as QueueGenerationVector, next, options.ix);
            applySharedToCustomerVector(vectorDrafts.customers, next);
            const previousCustomerHash = customerVector.contentHash;
            customerVector = reviseVectorDraft(customerVector, structuredClone(vectorDrafts.customers));
            if (previousCustomerHash !== customerVector.contentHash && customers) customers = markArtifactStale(customers);
            options.onSharedProfileChanged?.(next);
            syncTextarea();
          },
        })
      : undefined;
    const visualPanel = el("div", { class: "qf-vector-mode-panel" }, [visual]);
    const jsonError = el("p", { class: "inline-error", role: "alert" });
    const jsonPanel = el("div", { class: "qf-vector-mode-panel" }, [
      el("p", { class: "muted qf-editor-help" }, ["Advanced editor. Valid JSON stays synchronized with Visual mode."]),
      textarea,
      jsonError,
    ]);
    const visualButton = button("Visual", () => switchEditorMode("visual"), { class: editorModes[phase] === "visual" ? "selected" : "" });
    const jsonButton = button("JSON", () => switchEditorMode("json"), { class: editorModes[phase] === "json" ? "selected" : "" });
    function applyEditorMode(): void {
      visualPanel.hidden = editorModes[phase] !== "visual";
      jsonPanel.hidden = editorModes[phase] !== "json";
      visualButton.classList.toggle("selected", editorModes[phase] === "visual");
      jsonButton.classList.toggle("selected", editorModes[phase] === "json");
    }
    const storeDraft = (draft: QueueGenerationVector | PickupPlanningVector | CustomerGenerationVector): void => {
      if (phase === "queue") vectorDrafts.queue = draft as QueueGenerationVector;
      else if (phase === "pickup") vectorDrafts.pickup = draft as PickupPlanningVector;
      else vectorDrafts.customers = draft as CustomerGenerationVector;
    };
    function parseJsonDraft(showError: boolean): boolean {
      try {
        storeDraft(JSON.parse(textarea.value) as typeof editable);
        textarea.classList.remove("invalid");
        jsonError.textContent = "";
        scheduleAutosave();
        return true;
      } catch (error) {
        textarea.classList.add("invalid");
        jsonError.textContent = `Invalid vector JSON: ${error instanceof Error ? error.message : String(error)}`;
        if (showError) notify(jsonError.textContent);
        return false;
      }
    }
    function switchEditorMode(next: "visual" | "json"): void {
      if (next === editorModes[phase]) return;
      if (editorModes[phase] === "json") {
        const invalidSharedJson = shell.querySelector<HTMLTextAreaElement>(".shared-profile-editor .qf-vector-json.invalid");
        if (invalidSharedJson) {
          invalidSharedJson.focus();
          notify("Fix the invalid shared-profile JSON before returning to Visual mode.");
          return;
        }
        if (!parseJsonDraft(true)) return;
      }
      editorModes[phase] = next;
      render();
    }
    textarea.addEventListener("input", () => { parseJsonDraft(false); });
    applyEditorMode();
    const setDraft = (recordHistory = true): boolean => {
      try {
        const parsed = editorModes[phase] === "json"
          ? JSON.parse(textarea.value) as typeof vector.values
          : structuredClone(vectorDrafts[phase]) as typeof vector.values;
        storeDraft(structuredClone(parsed) as typeof editable);
        if (recordHistory) checkpoint();
        if (phase === "queue") {
          const previousHash = queueVector.contentHash;
          queueVector = reviseVectorDraft(queueVector, parsed as QueueGenerationVector);
          if (previousHash !== queueVector.contentHash) {
            if (queue) queue = markArtifactStale(queue);
            if (pickup) pickup = markArtifactStale(pickup);
            if (customers) customers = markArtifactStale(customers);
          }
        } else if (phase === "pickup") {
          const previousHash = pickupVector.contentHash;
          pickupVector = reviseVectorDraft(pickupVector, parsed as PickupPlanningVector);
          if (previousHash !== pickupVector.contentHash) {
            if (pickup) pickup = markArtifactStale(pickup);
            if (customers) customers = markArtifactStale(customers);
          }
        } else {
          const previousHash = customerVector.contentHash;
          customerVector = reviseVectorDraft(customerVector, parsed as CustomerGenerationVector);
          if (previousHash !== customerVector.contentHash && customers) customers = markArtifactStale(customers);
        }
        return true;
      } catch (error) {
        notify(`Invalid vector JSON: ${error instanceof Error ? error.message : String(error)}`);
        render();
        return false;
      }
    };
    const confirm = () => {
      if (draftSaveTimer) {
        clearTimeout(draftSaveTimer);
        draftSaveTimer = undefined;
      }
      if (!setDraft()) return;
      if (phase === "queue") queueVector = confirmVector(queueVector, "designer");
      else if (phase === "pickup") pickupVector = confirmVector(pickupVector, "designer");
      else customerVector = confirmVector(customerVector, "designer");
      persist(phase);
      render();
    };
    const stateOf = (which: QueueFirstPhase): string => {
      const artifact = which === "queue" ? queue : which === "pickup" ? pickup : customers;
      if (!artifact) return readiness(which).ready ? "ready" : "blocked";
      if (which === "queue" && (queue!.vectorHash !== queueVector.contentHash || queue!.contextHash !== context.contentHash)) return "changed";
      if (which === "pickup" && (pickup!.vectorHash !== pickupVector.contentHash || pickup!.queueHash !== queue?.contentHash)) return "changed";
      if (which === "customers" && (customers!.vectorHash !== customerVector.contentHash || customers!.queueHash !== queue?.contentHash || customers!.pickupPlanHash !== pickup?.contentHash)) return "changed";
      return artifact.status;
    };
    const undoButton = button("Undo", () => {
      const previous = undoStack.pop();
      if (!previous) return;
      redoStack.push(capture());
      restore(previous);
      render();
    });
    undoButton.disabled = undoStack.length === 0;
    const redoButton = button("Redo", () => {
      const next = redoStack.pop();
      if (!next) return;
      undoStack.push(capture());
      restore(next);
      render();
    });
    redoButton.disabled = redoStack.length === 0;
    const vectorConfirmed = vector.status === "valid";
    const phaseComplete = vectorConfirmed && (phase === "queue"
      ? queue?.status === "valid" && queue.vectorHash === queueVector.contentHash && queue.contextHash === context.contentHash
      : phase === "pickup"
        ? pickup?.completion === "complete" && pickup.status === "valid" && pickup.vectorHash === pickupVector.contentHash && pickup.queueHash === queue?.contentHash
        : customers?.status === "valid" && customers.vectorHash === customerVector.contentHash && customers.queueHash === queue?.contentHash && customers.pickupPlanHash === pickup?.contentHash);
    const currentArtifact = phase === "queue" ? queue : phase === "pickup" ? pickup : customers;
    const generateLabel = currentArtifact
      ? `Re-generate ${phase === "queue" ? "Queue" : phase === "pickup" ? "Pickup" : "Customers"}`
      : `Generate ${phase === "queue" ? "Queue" : phase === "pickup" ? "Pickup" : "Customers"}`;
    const primaryAction = reviewMode
      ? button("Commit to Level", commitCompleteLevel, { class: "primary" })
      : phaseComplete
        ? button(phase === "customers" ? "Review" : `Continue to ${phase === "queue" ? "Pickup" : "Customers"}`, () => {
            if (phase === "queue") phase = "pickup";
            else if (phase === "pickup") phase = "customers";
            else reviewMode = true;
            render();
          }, { class: "primary" })
        : vectorConfirmed
          ? button(generateLabel, runPhase, { class: "primary" })
          : button("Confirm Settings", confirm, { class: "primary" });
    primaryAction.disabled = !!generationTask;
    const moreButton = button("More ▾", (event) => {
      showContextMenu(event, [
        { label: "Validate current phase", onSelect: validatePhase },
        { label: "Save phase snapshot", onSelect: () => { persist(phase); render(); } },
        { label: "Apply current artifact to level", onSelect: applyArtifact },
      ], { title: "Advanced phase actions" });
    });
    const configPanel = el("section", { class: "qf-vector" }, [
      ...(reviewMode ? [
        el("h3", {}, ["Ready to commit"]),
        el("p", { class: "muted" }, ["Review validates all phase hashes and materializes shared Grid, Queue, and Customer obstacle coverage into the playable level."]),
      ] : [el("div", { class: "qf-vector-head" }, [
        el("div", {}, [el("h3", {}, ["Vector inspector"]), el("small", {}, [`${vector.status} · ${vector.contentHash}`])]),
      ]), ...(sharedPanel ? [sharedPanel] : []), visualPanel, jsonPanel]),
    ]);
    const contentPanel = el("section", { class: "qf-canvas" }, [
      el("h3", {}, [reviewMode ? "Complete-level review" : phase === "customers" ? "Pickup-synchronized customer path" : "Queue / pickup canvas"]),
      reviewMode
        ? el("div", { class: "generator-metric-grid" }, [
            el("div", { class: "generator-metric" }, [el("strong", {}, [queue?.status ?? "missing"]), el("span", {}, ["Queue"])]),
            el("div", { class: "generator-metric" }, [el("strong", {}, [pickup?.completion ?? "missing"]), el("span", {}, ["Pickup"])]),
            el("div", { class: "generator-metric" }, [el("strong", {}, [customers?.status ?? "missing"]), el("span", {}, ["Customers"])]),
          ])
        : phase === "customers"
          ? renderCustomerCanvas()
          : phase === "pickup" && queue
            ? createPickupCanvas({
                queue,
                pickup,
                cursor: pickupCursor,
                ix: options.ix,
                onStartManual: startManualPickup,
                onCursor: (cursor) => { pickupCursor = cursor; render(); },
                onPick: appendManualPick,
                onAutoComplete: autoCompletePickup,
              })
            : renderQueueCanvas(),
    ]);
    const main = createResizableGeneratorColumns({
      config: configPanel,
      content: contentPanel,
      issues: renderArtifact(),
      widths: columnWidths,
    });
    shell.replaceChildren(
      el("header", { class: "qf-head" }, [
        el("div", {}, [el("h2", {}, ["Level Generator"]), el("small", {}, [`${options.mapId} · Level ${options.level.id} · graph ${graphHash.slice(0, 8)}`])]),
        ...(options.onSwitchToCustomer ? [el("div", { class: "generator-strategy-switch", role: "tablist", "aria-label": "Generation strategy" }, [
          button("Customers → Queue", () => { overlay.remove(); options.onSwitchToCustomer?.(); }),
          button("Queue → Pickup → Customers", () => {}, { class: "selected", "aria-current": "page" }),
        ])] : []),
        el("div", { class: "generator-head-status" }, [el("span", { class: "status-chip" }, ["Local draft"]), button("✕ Close", close)]),
      ]),
      ...(loadWarnings.length ? [el("div", { class: "warnings" }, loadWarnings)] : []),
      el("nav", { class: "qf-rail" }, [
        ...(["queue", "pickup", "customers"] as QueueFirstPhase[]).map((which, index) =>
          button(`${index + 1} ${which === "customers" ? "Customers" : which[0].toUpperCase() + which.slice(1)} [${stateOf(which)}]`, () => { phase = which; reviewMode = false; render(); }, { class: !reviewMode && which === phase ? "selected" : "" }),
        ),
        button("4 Review", () => { reviewMode = true; render(); }, { class: reviewMode ? "selected" : "" }),
        el("span", { class: "spacer" }),
        el("div", { class: "qf-editor-tabs generator-global-editor-mode", role: "tablist", "aria-label": "Configuration editor mode" }, [visualButton, jsonButton]),
      ]),
      ...(generationProgress ? [el("div", {
        class: "generator-background-status",
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": String(Math.round(generationProgress.percentage)),
        style: `--generator-progress:${generationProgress.percentage}%`,
      }, [
        el("div", { class: "generator-progress-fill" }),
        el("span", { class: "generator-progress-label" }, [generationProgress.description]),
        el("strong", {}, [`${Math.round(generationProgress.percentage)}%`]),
      ])] : []),
      ...(notice ? [el("div", { class: `generator-inline-status ${notice.tone}`, role: notice.tone === "error" ? "alert" : "status" }, [notice.message])] : []),
      main,
      el("footer", { class: "qf-actions" }, [
        undoButton,
        redoButton,
        moreButton,
        el("span", { class: "spacer" }),
        primaryAction,
      ]),
    );
    restoreModalScrollState(shell, scrollPositions);
    lastRenderedView = viewKey;
  };

  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  document.body.append(overlay);
  render();
}
