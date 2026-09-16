// Design mode on the node graph — the LEGACY page, driven by graph rules.
//
// Layout, class names and element sizes are copied 1-1 from design/index.ts:
// the same map settings bar, the same level bar with its layout toggle and
// Definitions button, the same `.design-stack` / `.design-split` modes, and the
// same three sections in the same order. Queue and grid grammars are unchanged,
// so `createQueueSection` and `createGridSection` come through VERBATIM,
// reading a projection of the graph into the `MapDef` shape they were written
// against (see data/nodeGraphToMapDef.ts).
//
// Only the customer section is forked, and inside it only one gesture differs:
// right-clicking a dish opens a menu that configures its nested composite and
// groups. Everything else a designer touches behaves identically.
//
// Legacy-compatible sections still read a MapDef projection. Difficulty
// estimation is deliberately graph-native, however: its replay is rendered by
// NodeSimulation, so estimation must use that exact engine as well or
// multi-input tool lanes can diverge from the popup.

import { button, el } from "../dom.ts";
import type { EstimateProgress, EstimateResult } from "../design/estimateDifficulty.ts";
import { solvabilityCacheKey } from "../design/checkSolvable.ts";
import { defaultScenario, resolveScenario } from "../design/estimateScenario.ts";
import type { EstimateScenario } from "../design/estimateScenario.ts";
import type {
  AnalysisWorkerKind,
  AnalysisWorkerOptions,
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
} from "../design/analysisWorker.ts";
import type { StatisticReport } from "../design/statisticsReport.ts";
import { STATISTIC_RUNS } from "../design/statisticsReport.ts";
import type { StatisticsWorkerRequest, StatisticsWorkerResponse } from "../design/statisticsWorker.ts";
import { openEstimateScenarioDialog } from "../design/estimateScenarioDialog.ts";
import { customerColor } from "../design/customerColors.ts";
import { createGridSection } from "../design/gridSection.ts";
import { createQueueSection, toCoordGroups } from "../design/queueSection.ts";
import { generateNodeQueueLanes, nodeDemandByRaw } from "./nodeQueueGenerate.ts";
import type { QueueDraft, QueueSectionDeps } from "../design/queueSection.ts";
import type { Section } from "../design/section.ts";
import { createNodeCustomerSection } from "./nodeCustomerSection.ts";
import {
  analysisFoldout,
  defaultAnalysisFoldoutUi,
  type AnalysisFoldoutUi,
} from "./analysisFoldout.ts";
import {
  openStatisticsModal,
  statisticsFoldout,
  type StatisticsFoldoutUi,
} from "./statisticsFoldout.ts";
import { openNodeGenerateDialog } from "./nodeGenerateDialog.ts";
import { openNodeEstimateReplay } from "../nodeplay/index.ts";
import { parseGrid, parseQueueGroups, parseQueues, serializeGrid, serializeQueues } from "../../core/parser.ts";
import { serializeNodeCustomers } from "../../core/nodeParser.ts";
import {
  cachedEstimate,
  cacheEstimate,
  levelSignature,
  scenarioSignature,
} from "../levelpath/validationCache.ts";
import type { NodeCustomerConfig } from "../../core/nodeParser.ts";
import type { NodeLevelConfig } from "../../core/nodeSim.ts";
import { toNodeLevelConfig } from "../../data/nodeLevel.ts";
import { buildIndex } from "../../core/nodeIndex.ts";
import { orderIdIndex, resolveOrder } from "../../core/nodeOrder.ts";
import type {
  CustomerConfig,
  GlobalDefs,
  GridCellConfig,
  PackingMode,
  ToolProcessBehavior,
} from "../../core/types.ts";
import { playPackingMode, playToolProcessBehavior } from "../nodeplay/preferences.ts";
import { TAGS, WEATHER } from "../../data/configLoader.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import { nodeAsMapDef } from "../../data/nodeGraphToMapDef.ts";
import type { ProjectedMap } from "../../data/nodeGraphToMapDef.ts";
import { validateNodeGraph } from "../../data/nodeGraphValidate.ts";
import { blankLevel, listNodeMaps, type NodeProjectState } from "../../data/nodeProject.ts";

type LayoutMode = "stack" | "split";

export class NodeDesignView {
  private root: HTMLElement;
  private project: NodeProjectState;
  private defs: GlobalDefs;
  private onChange: () => void;
  private onLevelChange?: (levelId: number) => void;
  private onMapChange?: (docId: string) => void;

  private projected: ProjectedMap;
  private level!: LevelData;

  private customers!: Section<NodeCustomerConfig[]>;
  private grid!: Section<GridCellConfig[]>;
  private queues!: Section<QueueDraft>;
  private queueDeps!: QueueSectionDeps;
  /** Last Estimate Difficulty run for the OPEN level; cleared on any level switch. */
  private estimate: EstimateResult | null = null;
  /** Last omniscient Check Solvable run for the open level. */
  private solvability: EstimateResult | null = null;
  /** Last Level Statistics + MCP evaluation report for the open level. */
  private statistics: StatisticReport | null = null;
  /** The run currently visualized by the customer log/chart and queue overlay. */
  private analysis: EstimateResult | null = null;
  private analysisKind: "estimate" | "solvability" | null = null;
  private estimateFoldoutUi: AnalysisFoldoutUi = defaultAnalysisFoldoutUi();
  private solvabilityFoldoutUi: AnalysisFoldoutUi = defaultAnalysisFoldoutUi();
  private statisticsFoldoutUi: StatisticsFoldoutUi = { open: false };
  private estimateProgress: EstimateProgress | null = null;
  private solvabilityProgress: EstimateProgress | null = null;
  private statisticsProgress: EstimateProgress | null = null;
  private estimateWorker: Worker | null = null;
  private solvabilityWorker: Worker | null = null;
  private statisticsWorker: Worker | null = null;
  private estimateJobId = 0;
  private solvabilityJobId = 0;
  private statisticsJobId = 0;
  /**
   * Scoring scenario the modal opens with. Kept on the view rather than per
   * level: a designer tuning the solver wants the same scenario while they
   * click through levels, and it is a view setting, not level data.
   */
  private scenario: EstimateScenario = defaultScenario();
  private warningsEl = el("div", { class: "warnings" });
  private layoutMode: LayoutMode = "stack";

  constructor(
    root: HTMLElement,
    project: NodeProjectState,
    defs: GlobalDefs,
    onChange: () => void,
    initialLevelId?: number,
    onLevelChange?: (levelId: number) => void,
    onMapChange?: (docId: string) => void,
  ) {
    this.root = root;
    this.project = project;
    this.defs = defs;
    this.onChange = onChange;
    this.onLevelChange = onLevelChange;
    this.onMapChange = onMapChange;
    this.projected = nodeAsMapDef(project.doc, buildIndex(project.doc));
    this.level = project.levels.find((l) => l.id === initialLevelId) ?? project.levels[0];
    this.build();
  }

  get isDirty(): boolean {
    return this.customers.isDirty || this.grid.isDirty || this.queues.isDirty;
  }

  selectLevel(levelId: number): void {
    if (this.isDirty && !confirm("Unsaved changes will be lost. Switch level anyway?")) return;
    const next = this.project.levels.find((l) => l.id === levelId);
    if (!next) return;
    this.cancelAnalysisWorker("estimate");
    this.cancelAnalysisWorker("solvability");
    this.cancelStatisticsWorker();
    this.level = next;
    // An estimate belongs to ONE level's queue; carrying THIS one across would
    // colour tiles with numbers that mean nothing here. The new level may have
    // its own already, from a Validate or a generate run in Level Path — that
    // is what adoptCachedEstimate goes looking for, once the sections exist.
    this.estimate = null;
    this.solvability = null;
    this.statistics = null;
    this.analysis = null;
    this.analysisKind = null;
    this.build();
    this.onLevelChange?.(levelId);
  }

  private build(): void {
    if (!this.level) {
      this.root.replaceChildren(el("p", {}, ["This graph has no levels yet."]));
      return;
    }

    const saved = () => {
      this.onChange();
      this.refreshWarnings();
    };
    const invalidateAnalysis = () => {
      this.invalidateAnalysis();
    };
    // The queue's Recipe Pieces foldout reads the other two drafts, so their
    // commits re-render it.
    const refreshQueueReadout = () => this.queues?.render();

    this.queueDeps = {
      map: this.projected.map,
      defs: this.defs,
      level: this.level,
      parse: () => ({
        queues: parseQueues(this.level.queueString),
        groups: parseQueueGroups(this.level.queueString),
      }),
      // Recipe Pieces counts pieces against orders, so it needs the orders in
      // the flat shape it was written for. Resolving each bracket dish gives
      // exactly that, losing nothing the foldout reads.
      currentCustomers: () => this.flatCustomers(),
      currentGrid: () => this.grid.draft,
      onSaved: saved,
      currentEstimate: () => this.analysis,
      // The one part of the reused queue section that cannot come through
      // verbatim. `deps.map` is the lossy projection, where a multi-input
      // recipe has already collapsed to its first ingredient — generating from
      // it would queue ground coffee and never a cup. Supplying this covers
      // the section's own Auto Generate button. (The whole-level pipeline in
      // levelpath/generateLevel.ts calls the same generator directly.)
      generateLanes: (laneCount, shuffleRange, bagFill) =>
        generateNodeQueueLanes({
          ix: this.projected.ix,
          ids: orderIdIndex(this.projected.ix),
          customers: this.customers.draft,
          laneCount,
          shuffleRange,
          bagFill,
        }),
      recipeDemand: () =>
        nodeDemandByRaw(this.projected.ix, orderIdIndex(this.projected.ix), this.customers.draft),
      onCommit: invalidateAnalysis,
      // Retained for the legacy tool/grid deadlock checker. The current Design
      // button is picking-order-only, but this keeps the integration available
      // if the legacy analysis is exposed separately in the future.
      deadlockLevel: () => ({ ix: this.projected.ix, level: this.liveLevel() }),
      stackRange: (id) => {
        const name = orderIdIndex(this.projected.ix).byId.ingredient.get(id);
        const dense = name === undefined ? undefined : this.projected.ix.ingByName.get(name);
        return dense === undefined ? undefined : this.projected.ix.stackRange[dense];
      },
    };

    this.customers = createNodeCustomerSection({
      ix: this.projected.ix,
      projected: this.projected,
      defs: this.defs,
      level: this.level,
      onSaved: saved,
      onCommit: () => {
        invalidateAnalysis(); // any edit invalidates both solver runs and the pickup-order overlay
        refreshQueueReadout();
      },
      currentEstimate: () => this.analysis,
      onHoverCustomer: (index) => this.highlightCustomer(index),
    });

    this.grid = createGridSection({
      map: this.projected.map,
      defs: this.defs,
      level: this.level,
      parse: () => parseGrid(this.level.gridString),
      onSaved: saved,
      onCommit: () => {
        invalidateAnalysis();
        refreshQueueReadout();
      },
    });

    this.queues = createQueueSection(this.queueDeps);
    // NOTE: do not reassign this.queues.draft here. createQueueSection already
    // parses and tags the draft, and Section's history keeps that same tagged
    // snapshot as its saved baseline. Swapping in a second toQueueDraft() call
    // hands every item a FRESH _cid, so change tracking matched nothing and
    // painted the whole queue green-dashed 'added' on load and on level switch.
    this.grid.render();
    this.queues.render();

    this.renderLayout();
    this.refreshWarnings();
    this.adoptCachedEstimate();
  }

  /**
   * Show an estimate somebody else already paid for.
   *
   * Level Path validates and generates whole maps at a time, and each of those
   * runs produces exactly the estimate this view would compute for the same
   * level. Re-solving it on open would be seconds of work to arrive at the same
   * numbers — so if the cache holds one for these exact strings under this
   * exact scenario, adopt it.
   */
  private adoptCachedEstimate(): void {
    const cached = cachedEstimate(
      this.project.docId,
      this.level.id,
      this.liveSignature(),
      scenarioSignature(this.scenario, this.estimateBehavior()),
    );
    if (!cached) return;
    this.estimate = cached;
    this.analysis = cached;
    this.analysisKind = "estimate";
    this.customers.render();
    this.queues.render();
    this.renderLayout();
  }

  /**
   * The cache identity of what is on screen RIGHT NOW.
   *
   * Serialized from the live drafts rather than read off `this.level`, because
   * the drafts are what the estimator runs on — an unsaved queue edit has to
   * miss the cache, and it only does if the signature sees the edit.
   */
  private liveSignature(): string {
    const level = this.liveLevel();
    return levelSignature({
      customerString: serializeNodeCustomers(this.customers.draft),
      gridString: serializeGrid(this.grid.draft),
      queueString: serializeQueues(this.queues.draft.queues, toCoordGroups(this.queues.draft)),
      weather: this.level.weather,
      serveableSlots: level.serveableSlots,
      shuffleDistance: level.shuffleDistance,
      ...(level.outOfSlotPolicy ? { outOfSlotPolicy: level.outOfSlotPolicy } : {}),
      ...(level.boosterCharges ? { boosterCharges: level.boosterCharges } : {}),
    });
  }

  /** Rebuilds the wrapper around the three existing sections, keeping their drafts. */
  private renderLayout(): void {
    this.root.replaceChildren(
      this.levelBar(),
      this.warningsEl,
      this.analysisFoldouts(),
      this.layoutMode === "split" ? this.splitLayout() : this.stackLayout(),
    );
  }

  /** Page-level results stay between warnings and Grid in every layout mode. */
  private analysisFoldouts(): HTMLElement {
    return el("div", { class: "design-analysis-foldouts" }, [
      analysisFoldout(
        this.estimate,
        "estimate",
        this.estimateFoldoutUi,
        () => this.replayEstimate(),
        () => this.renderLayout(),
        this.estimateProgress,
      ),
      analysisFoldout(
        this.solvability,
        "solvability",
        this.solvabilityFoldoutUi,
        () => this.replaySolvability(),
        () => this.renderLayout(),
        this.solvabilityProgress,
      ),
      statisticsFoldout(
        this.statistics,
        this.defs,
        this.statisticsFoldoutUi,
        () => this.openStatistics(),
        () => this.renderLayout(),
        this.statisticsProgress,
      ),
    ]);
  }

  private setLayoutMode(mode: LayoutMode): void {
    if (this.layoutMode === mode) return;
    this.layoutMode = mode;
    this.renderLayout();
  }

  private stackLayout(): HTMLElement {
    return el("div", { class: "design-stack" }, [
      this.grid.element,
      this.customers.element,
      this.queues.element,
    ]);
  }

  private splitLayout(): HTMLElement {
    return el("div", { class: "design-split" }, [
      el("div", { class: "design-split-left" }, [this.customers.element]),
      el("div", { class: "design-split-right" }, [
        el("div", { class: "design-split-right-top" }, [this.grid.element]),
        el("div", { class: "design-split-right-bottom" }, [this.queues.element]),
      ]),
    ]);
  }

  private layoutToggle(): HTMLElement {
    return el("div", { class: "layout-toggle field small" }, [
      "Layout",
      el("div", { class: "toggle-group" }, [
        button("Current", () => this.setLayoutMode("stack"), {
          class: `small-btn${this.layoutMode === "stack" ? " active" : ""}`,
        }),
        button("Split", () => this.setLayoutMode("split"), {
          class: `small-btn${this.layoutMode === "split" ? " active" : ""}`,
          title: "Customers left (vertical list) — grid + queue stacked right",
        }),
      ]),
    ]);
  }

  /** Node customers in the legacy flat shape, for the sections that count ingredients. */
  private flatCustomers(): CustomerConfig[] {
    const ids = orderIdIndex(this.projected.ix);
    return this.customers.draft.map((customer) => ({
      typeId: customer.typeId,
      waitTime: customer.waitTime,
      weatherEff: customer.weatherEff,
      dishes: customer.dishes.map((dish) => {
        const { order } = resolveOrder(this.projected.ix, dish, ids);
        const cookedIds: number[] = [];
        for (const slot of order.slots) {
          const id = this.projected.dataIdOf.get(slot.ing);
          if (id !== undefined) cookedIds.push(id);
        }
        return { cookedIds, effects: dish.effects };
      }),
      ...(customer.staffAmount !== undefined ? { staffAmount: customer.staffAmount } : {}),
    }));
  }

  private levelBar(): HTMLElement {
    const mapPicker = el("select", { class: "map-picker" }) as HTMLSelectElement;
    for (const map of listNodeMaps()) {
      const opt = el("option", { value: map.id }, [map.name]);
      if (map.id === this.project.docId) (opt as HTMLOptionElement).selected = true;
      mapPicker.append(opt);
    }
    mapPicker.addEventListener("change", () => {
      if (mapPicker.value === this.project.docId) return;
      if (this.isDirty && !confirm("Unsaved changes will be lost. Switch map anyway?")) {
        mapPicker.value = this.project.docId;
        return;
      }
      this.onMapChange?.(mapPicker.value);
    });

    const picker = el("select", { class: "level-picker" }) as HTMLSelectElement;
    for (const l of this.project.levels) {
      const opt = el("option", { value: String(l.id) }, [
        `${l.name}${l.levelTag ? ` (${l.levelTag})` : ""}`,
      ]);
      if (l.id === this.level.id) (opt as HTMLOptionElement).selected = true;
      picker.append(opt);
    }
    picker.addEventListener("change", () => this.selectLevel(Number(picker.value)));

    // Dirty stack height is a graph-level property, edited in Map Process, and
    // Serve slots is superseded by the dynamic serve window — neither belongs
    // on the level bar any more. Both values are still read from the data.
    const metaField = (label: string, value: string | number, type: string, apply: (v: string) => void) => {
      const input = el("input", { value: String(value), type }) as HTMLInputElement;
      input.addEventListener("change", () => {
        apply(input.value);
        this.invalidateAnalysis();
        this.onChange();
      });
      return el("label", { class: "field small" }, [label, input]);
    };

    // The current value is kept as an extra option if it isn't a known one, so
    // unexpected data is never silently clobbered by picking a select option.
    const selectField = (
      label: string,
      options: { id: string; name: string }[],
      value: string,
      apply: (v: string) => void,
    ) => {
      const select = el("select", {}) as HTMLSelectElement;
      const known = options.some((o) => o.id === value);
      const all = known ? options : [{ id: value, name: `${value || "(blank)"} (unknown)` }, ...options];
      for (const o of all) {
        const opt = el("option", { value: o.id }, [o.name || "(blank)"]);
        if (o.id === value) (opt as HTMLOptionElement).selected = true;
        select.append(opt);
      }
      select.addEventListener("change", () => {
        apply(select.value);
        this.invalidateAnalysis();
        this.onChange();
      });
      return el("label", { class: "field small" }, [label, select]);
    };

    const autoGenerateButton = button("✨ Auto Generate", () => this.openGenerate(), {
      title: "Generate customers and queues from the level's generator settings",
    });
    const estimateButton = button("📊 Estimate Difficulty", () => this.runEstimate(), {
      title: "Simulate player-visible behavior and report difficulty, guessing, and grid pressure",
    });
    estimateButton.disabled = this.estimateProgress !== null;
    const solvabilityButton = button("✓ Check Solvable", () => this.runSolvability(), {
      title: "Check for a winning route with full knowledge of every customer and queue slot, including Hidden slots",
    });
    solvabilityButton.disabled = this.solvabilityProgress !== null;
    const statisticsButton = button("Statistic", () => this.runStatistics(), {
      title: "Compute Level Path statistics and the MCP tuning-profile evaluation metrics",
    });
    statisticsButton.disabled = this.statisticsProgress !== null;
    const actions = el("div", { class: "level-analysis-actions" }, [
      autoGenerateButton,
      estimateButton,
      solvabilityButton,
      statisticsButton,
      button("+ Level", () => this.addLevel()),
      button("🗑 Level", () => this.deleteLevel(), { class: "danger" }),
    ]);

    return el("div", { class: "level-bar" }, [
      el("label", { class: "field small" }, ["Map", mapPicker]),
      el("label", { class: "field small" }, ["Level", picker]),
      this.layoutToggle(),
      selectField(
        "Weather",
        WEATHER.map((w) => ({ id: w.id, name: w.id })),
        this.level.weather,
        (v) => (this.level.weather = v),
      ),
      selectField("Tag", TAGS, this.level.levelTag, (v) => (this.level.levelTag = v)),
      metaField("Unlock", this.level.featureUnlock, "text", (v) => (this.level.featureUnlock = v)),
      el("span", { class: "spacer" }),
      actions,
    ]);
  }

  private addLevel(): void {
    const nextId = this.project.levels.reduce((n, l) => Math.max(n, l.id), 0) + 1;
    this.project.levels.push({
      ...blankLevel(this.project.doc, nextId),
      name: `${this.project.doc.map.id}_${nextId}`,
    });
    this.onChange();
    this.selectLevel(nextId);
  }

  private deleteLevel(): void {
    if (this.project.levels.length <= 1) return;
    if (!confirm(`Delete level "${this.level.name}"?`)) return;
    const at = this.project.levels.findIndex((l) => l.id === this.level.id);
    this.project.levels.splice(at, 1);
    this.onChange();
    this.selectLevel(this.project.levels[Math.max(0, at - 1)].id);
  }

  /** Ask for the scoring scenario first, then estimate with it. */
  private runEstimate(): void {
    openEstimateScenarioDialog({
      scenario: this.scenario,
      onRun: (scenario, behavior) => {
        this.scenario = scenario;
        this.runEstimateWith(scenario, behavior);
      },
    });
  }

  /** The open level with every section's live draft folded in, not its saved strings. */
  private liveLevel(): NodeLevelConfig {
    const level = toNodeLevelConfig(this.level);
    level.customers = this.customers.draft;
    level.grid = this.grid.draft;
    level.queues = this.queues.draft.queues;
    level.queueGroups = toCoordGroups(this.queues.draft);
    return level;
  }

  /** Canonical live strings for statistics that intentionally inspect authored text. */
  private liveLevelData(): LevelData {
    return {
      ...this.level,
      customerString: serializeNodeCustomers(this.customers.draft),
      gridString: serializeGrid(this.grid.draft),
      queueString: serializeQueues(this.queues.draft.queues, toCoordGroups(this.queues.draft)),
    };
  }

  /** Estimate with the same graph-native engine used by Play and replay. */
  private runEstimateWith(
    scenario: EstimateScenario,
    behavior: { packingMode: PackingMode; toolProcessBehavior: ToolProcessBehavior },
  ): void {
    const level = this.liveLevel();
    const signature = this.liveSignature();
    const scenarioKey = scenarioSignature(scenario, behavior);
    // Same level, same scenario, same answer — and Level Path may already
    // have run it. Only actually solve on a miss.
    const cached = cachedEstimate(this.project.docId, this.level.id, signature, scenarioKey);
    if (cached) {
      this.estimate = cached;
      this.analysis = cached;
      this.analysisKind = "estimate";
      this.customers.render();
      this.queues.render();
      this.renderLayout();
      return;
    }
    this.startAnalysisWorker("estimate", level, { scenario, ...behavior }, signature, scenarioKey);
  }

  private openGenerate(): void {
    openNodeGenerateDialog({
      ix: this.projected.ix,
      ids: orderIdIndex(this.projected.ix),
      projected: this.projected,
      level: this.level,
      currentCustomers: () => this.customers.draft,
      scenario: this.scenario,
      // Generation replaces customer and queue data as one verified unit.
      onGenerated: (result) => {
        this.cancelAnalysisWorker("estimate");
        this.cancelAnalysisWorker("solvability");
        this.cancelStatisticsWorker();
        this.estimate = result.estimate;
        this.solvability = null;
        this.statistics = null;
        this.analysis = result.estimate;
        this.analysisKind = result.estimate ? "estimate" : null;
        if (result.ok && result.estimate) {
          cacheEstimate(
            this.project.docId,
            this.level.id,
            levelSignature(this.level),
            scenarioSignature(this.scenario),
            result.estimate,
          );
        }
        this.build();
        this.onChange();
        this.refreshWarnings();
      },
    });
  }

  /** Run supply proof + complete-state search; timeouts are warnings only. */
  private runSolvability(): void {
    const level = this.liveLevel();
    const signature = this.liveSignature();
    const behavior = this.estimateBehavior();
    const scenarioKey = solvabilityCacheKey(scenarioSignature(this.scenario, behavior));
    const cached = cachedEstimate(this.project.docId, this.level.id, signature, scenarioKey);
    if (cached) {
      this.solvability = cached;
      this.analysis = cached;
      this.analysisKind = "solvability";
      this.customers.render();
      this.queues.render();
      this.renderLayout();
      return;
    }
    this.startAnalysisWorker(
      "solvability",
      level,
      { scenario: this.scenario, ...behavior },
      signature,
      scenarioKey,
    );
  }

  /** Run Level Path counts and MCP's tuning-profile metrics without blocking the editor. */
  private runStatistics(): void {
    this.cancelStatisticsWorker();
    const level = this.liveLevel();
    const levelData = this.liveLevelData();
    const signature = this.liveSignature();
    const levelId = this.level.id;
    const jobId = this.statisticsJobId;
    const totalItems = level.queues.reduce((sum, lane) => sum + lane.length, 0);
    this.statisticsProgress = {
      run: 1,
      runTotal: STATISTIC_RUNS,
      pickedItems: 0,
      totalItems,
      percentage: totalItems === 0 ? 100 : 0,
    };
    let worker: Worker;
    try {
      worker = new Worker(new URL("../design/statisticsWorker.ts", import.meta.url), { type: "module" });
    } catch (err) {
      this.failStatisticsWorker(err instanceof Error ? err.message : String(err));
      return;
    }
    this.statisticsWorker = worker;
    this.renderLayout();
    const isCurrent = (): boolean => this.statisticsJobId === jobId && this.statisticsWorker === worker;
    worker.onmessage = (event: MessageEvent<StatisticsWorkerResponse>) => {
      if (!isCurrent()) return;
      const message = event.data;
      if (message.type === "progress") {
        this.statisticsProgress = message.progress;
        this.paintAnalysisProgress("statistics", message.progress);
        return;
      }
      worker.terminate();
      this.statisticsWorker = null;
      this.statisticsProgress = null;
      if (message.type === "error") {
        this.failStatisticsWorker(message.error, false);
        return;
      }
      if (this.level.id !== levelId || this.liveSignature() !== signature) {
        this.renderLayout();
        return;
      }
      this.statistics = message.result;
      this.statisticsFoldoutUi.open = true;
      this.renderLayout();
      this.openStatistics();
    };
    worker.onerror = (event) => {
      if (!isCurrent()) return;
      worker.terminate();
      this.failStatisticsWorker(event.message || "worker crashed");
    };
    const request: StatisticsWorkerRequest = {
      graph: this.project.doc,
      level: structuredClone(level),
      levelData,
      referenceLevels: structuredClone(this.project.levels),
      runs: STATISTIC_RUNS,
    };
    try {
      worker.postMessage(request);
    } catch (err) {
      worker.terminate();
      this.failStatisticsWorker(err instanceof Error ? err.message : String(err));
    }
  }

  private openStatistics(): void {
    if (this.statistics) openStatisticsModal(this.statistics, this.defs);
  }

  /** Execute an analysis away from the UI thread and stream its real queue progress into the header. */
  private startAnalysisWorker(
    kind: AnalysisWorkerKind,
    level: NodeLevelConfig,
    opts: AnalysisWorkerOptions,
    signature: string,
    scenarioKey: string,
  ): void {
    this.cancelAnalysisWorker(kind);
    const totalItems = level.queues.reduce((sum, lane) => sum + lane.length, 0);
    const runTotal = kind === "solvability"
      ? 2
      : Math.min(10, Math.max(0, Math.floor(resolveScenario(opts.scenario).retryCount))) + 1;
    const initialProgress: EstimateProgress = {
      run: 1,
      runTotal,
      pickedItems: 0,
      totalItems,
      percentage: totalItems === 0 ? 100 : 0,
    };
    const levelId = this.level.id;
    const jobId = kind === "estimate" ? this.estimateJobId : this.solvabilityJobId;
    let worker: Worker;
    try {
      worker = new Worker(new URL("../design/analysisWorker.ts", import.meta.url), { type: "module" });
    } catch (err) {
      this.failAnalysisWorker(kind, err instanceof Error ? err.message : String(err));
      return;
    }
    if (kind === "estimate") {
      this.estimateWorker = worker;
      this.estimateProgress = initialProgress;
    } else {
      this.solvabilityWorker = worker;
      this.solvabilityProgress = initialProgress;
    }
    this.renderLayout();

    const isCurrent = (): boolean => kind === "estimate"
      ? this.estimateJobId === jobId && this.estimateWorker === worker
      : this.solvabilityJobId === jobId && this.solvabilityWorker === worker;
    worker.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
      if (!isCurrent()) return;
      const message = event.data;
      if (message.type === "progress") {
        if (kind === "estimate") this.estimateProgress = message.progress;
        else this.solvabilityProgress = message.progress;
        this.paintAnalysisProgress(kind, message.progress);
        return;
      }
      worker.terminate();
      if (kind === "estimate") {
        this.estimateWorker = null;
        this.estimateProgress = null;
      } else {
        this.solvabilityWorker = null;
        this.solvabilityProgress = null;
      }
      if (message.type === "error") {
        this.failAnalysisWorker(kind, message.error, false);
        return;
      }
      // Edits and level switches invalidate work already in flight. Never let
      // an old worker overwrite the new level's graph or pickup overlay.
      if (this.level.id !== levelId || this.liveSignature() !== signature) {
        this.renderLayout();
        return;
      }
      cacheEstimate(this.project.docId, levelId, signature, scenarioKey, message.result);
      if (kind === "estimate") this.estimate = message.result;
      else this.solvability = message.result;
      this.analysis = message.result;
      this.analysisKind = kind;
      this.customers.render();
      this.queues.render();
      this.renderLayout();
    };
    worker.onerror = (event) => {
      if (!isCurrent()) return;
      worker.terminate();
      this.failAnalysisWorker(kind, event.message || "worker crashed");
    };
    const request: AnalysisWorkerRequest = {
      kind,
      graph: this.project.doc,
      level: structuredClone(level),
      opts,
    };
    try {
      worker.postMessage(request);
    } catch (err) {
      worker.terminate();
      this.failAnalysisWorker(kind, err instanceof Error ? err.message : String(err));
    }
  }

  private paintAnalysisProgress(kind: AnalysisWorkerKind | "statistics", progress: EstimateProgress): void {
    const section = this.root.querySelector<HTMLElement>(
      `.design-analysis-foldout[data-analysis-kind="${kind}"]`,
    );
    const bar = section?.querySelector<HTMLElement>(".analysis-running");
    const label = section?.querySelector<HTMLElement>(".analysis-progress-label");
    if (!bar || !label) return;
    const percentage = Math.round(progress.percentage);
    bar.style.setProperty("--analysis-progress", `${progress.percentage}%`);
    bar.setAttribute("aria-valuenow", String(percentage));
    label.textContent = `${percentage}% · run ${progress.run}/${progress.runTotal} · ` +
      `${progress.pickedItems}/${progress.totalItems} queue items`;
  }

  private failAnalysisWorker(kind: AnalysisWorkerKind, error: string, terminate = true): void {
    if (kind === "estimate") {
      if (terminate) this.estimateWorker?.terminate();
      this.estimateWorker = null;
      this.estimateProgress = null;
      this.estimate = null;
      if (this.analysisKind === "estimate") {
        this.analysis = null;
        this.analysisKind = null;
      }
    } else {
      if (terminate) this.solvabilityWorker?.terminate();
      this.solvabilityWorker = null;
      this.solvabilityProgress = null;
      this.solvability = null;
      if (this.analysisKind === "solvability") {
        this.analysis = null;
        this.analysisKind = null;
      }
    }
    this.customers.render();
    this.queues.render();
    this.renderLayout();
    const label = kind === "estimate" ? "Estimate Difficulty" : "Check Solvable";
    console.error(`${label} failed`, error);
    alert(`${label} failed: ${error}`);
  }

  private cancelAnalysisWorker(kind: AnalysisWorkerKind): void {
    if (kind === "estimate") {
      this.estimateWorker?.terminate();
      this.estimateWorker = null;
      this.estimateProgress = null;
      this.estimateJobId++;
    } else {
      this.solvabilityWorker?.terminate();
      this.solvabilityWorker = null;
      this.solvabilityProgress = null;
      this.solvabilityJobId++;
    }
  }

  private failStatisticsWorker(error: string, terminate = true): void {
    if (terminate) this.statisticsWorker?.terminate();
    this.statisticsWorker = null;
    this.statisticsProgress = null;
    this.statistics = null;
    this.renderLayout();
    console.error("Statistic failed", error);
    alert(`Statistic failed: ${error}`);
  }

  private cancelStatisticsWorker(): void {
    this.statisticsWorker?.terminate();
    this.statisticsWorker = null;
    this.statisticsProgress = null;
    this.statisticsJobId++;
  }

  private replayEstimate(): void {
    if (!this.estimate) return;
    openNodeEstimateReplay(this.project, this.level.id, this.estimate.replaySteps, {
      packingMode: this.estimate.packingMode ?? playPackingMode(),
      toolProcessBehavior: this.estimate.toolProcessBehavior ?? playToolProcessBehavior(),
    });
  }

  private replaySolvability(): void {
    if (!this.solvability) return;
    openNodeEstimateReplay(this.project, this.level.id, this.solvability.replaySteps, {
      packingMode: this.solvability.packingMode ?? playPackingMode(),
      toolProcessBehavior: this.solvability.toolProcessBehavior ?? playToolProcessBehavior(),
    }, "Solvability Check Replay");
  }

  private estimateBehavior(): { packingMode: PackingMode; toolProcessBehavior: ToolProcessBehavior } {
    return {
      packingMode: playPackingMode(),
      toolProcessBehavior: playToolProcessBehavior(),
    };
  }

  private invalidateAnalysis(): void {
    const hadAnalysis = this.analysis !== null || this.estimate !== null || this.solvability !== null ||
      this.statistics !== null || this.estimateProgress !== null || this.solvabilityProgress !== null ||
      this.statisticsProgress !== null;
    this.cancelAnalysisWorker("estimate");
    this.cancelAnalysisWorker("solvability");
    this.cancelStatisticsWorker();
    this.estimate = null;
    this.solvability = null;
    this.statistics = null;
    this.analysis = null;
    this.analysisKind = null;
    // Section.commit() renders before firing onCommit, so clear the just-drawn
    // result bar and pickup overlay once more after invalidation.
    if (hadAnalysis) {
      this.customers?.render();
      this.queues?.render();
      this.renderLayout();
      return;
    }
  }

  /**
   * Hover feedback for one customer: their queue tiles and their points on the
   * estimate chart light up together. Driven by direct class toggles rather
   * than a re-render — the queue body is expensive to rebuild, and a rebuild
   * mid-hover would drop the cursor's own target out from under it.
   */
  private highlightCustomer(index: number | null): void {
    const cids = new Set<string>();
    if (index !== null && this.analysis) {
      for (const [cid, slot] of this.analysis.byCid) {
        if (slot.customerIndex === index) cids.add(cid);
      }
    }
    const on = index !== null && cids.size > 0;
    const queueRoot = this.queues?.element;
    if (queueRoot) {
      queueRoot.classList.toggle("customer-focus", on);
      if (on) queueRoot.style.setProperty("--focus-color", customerColor(index!));
      queueRoot.querySelectorAll<HTMLElement>(".queue-tile").forEach((tile) => {
        const cid = tile.dataset.cid;
        tile.classList.toggle("customer-hit", !!cid && cids.has(cid));
      });
    }
    // Both page-level charts carry the owning customer on each point (see
    // occupancyChart.ts), so hover feedback applies to either open foldout.
    this.root.querySelectorAll<HTMLElement>(".occupancy-chart").forEach((chart) => {
      chart.classList.toggle("customer-focus", index !== null);
      if (index !== null) chart.style.setProperty("--focus-color", customerColor(index));
      chart.querySelectorAll<SVGElement>(".occupancy-point").forEach((point) => {
        const owner = point.dataset.customer;
        point.classList.toggle("customer-hit", index !== null && owner === String(index));
      });
    });
  }

  /** Same bar, same `.ok` styling as legacy — sourced from the graph's invariants. */
  private refreshWarnings(): void {
    const { errors } = validateNodeGraph(this.project.doc);
    this.warningsEl.replaceChildren();
    this.warningsEl.classList.toggle("ok", errors.length === 0);
    if (errors.length === 0) {
      this.warningsEl.append("✓ No warnings for this level");
      return;
    }
    this.warningsEl.append(el("strong", {}, [`⚠ ${errors.length} graph error(s)`]));
    for (const issue of errors) {
      this.warningsEl.append(el("div", {}, [`${issue.invariantId} — ${issue.message}`]));
    }
  }
}
