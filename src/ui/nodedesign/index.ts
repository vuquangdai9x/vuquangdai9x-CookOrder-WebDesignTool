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
import type { EstimateResult } from "../design/estimateDifficulty.ts";
import { estimateNodeDifficulty } from "../design/nodeEstimateDifficulty.ts";
import { defaultScenario } from "../design/estimateScenario.ts";
import type { EstimateScenario } from "../design/estimateScenario.ts";
import { openEstimateScenarioDialog } from "../design/estimateScenarioDialog.ts";
import { customerColor } from "../design/customerColors.ts";
import { createGridSection } from "../design/gridSection.ts";
import { createQueueSection, startQueueAutoGenerate, toCoordGroups } from "../design/queueSection.ts";
import { generateNodeQueueLanes, nodeDemandByRaw } from "./nodeQueueGenerate.ts";
import type { QueueDraft, QueueSectionDeps } from "../design/queueSection.ts";
import type { Section } from "../design/section.ts";
import { createNodeCustomerSection } from "./nodeCustomerSection.ts";
import { openNodeGenerateDialog } from "./nodeGenerateDialog.ts";
import { openNodeEstimateReplay } from "../nodeplay/index.ts";
import { parseGrid, parseQueueGroups, parseQueues } from "../../core/parser.ts";
import type { NodeCustomerConfig } from "../../core/nodeParser.ts";
import type { NodeLevelConfig } from "../../core/nodeSim.ts";
import { toNodeLevelConfig } from "../../data/nodeLevel.ts";
import { buildIndex } from "../../core/nodeIndex.ts";
import { orderIdIndex, resolveOrder } from "../../core/nodeOrder.ts";
import type { CustomerConfig, GlobalDefs, GridCellConfig } from "../../core/types.ts";
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
    this.level = next;
    // An estimate belongs to ONE level's queue; carrying it across would
    // colour tiles with numbers that mean nothing here.
    this.estimate = null;
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
      currentEstimate: () => this.estimate,
      // The one part of the reused queue section that cannot come through
      // verbatim. `deps.map` is the lossy projection, where a multi-input
      // recipe has already collapsed to its first ingredient — generating from
      // it would queue ground coffee and never a cup. Supplying this covers
      // BOTH entry points: the section's own Auto Generate button and the
      // chain from the customer generator.
      generateLanes: (laneCount, shuffleRange) =>
        generateNodeQueueLanes({
          ix: this.projected.ix,
          ids: orderIdIndex(this.projected.ix),
          customers: this.customers.draft,
          laneCount,
          shuffleRange,
        }),
      recipeDemand: () =>
        nodeDemandByRaw(this.projected.ix, orderIdIndex(this.projected.ix), this.customers.draft),
      // The tool/slot half of the deadlock audit runs the real simulation, so
      // it needs the whole level — built from the LIVE drafts, exactly as
      // runEstimate does, not from the last-saved strings.
      deadlockLevel: () => ({ ix: this.projected.ix, level: this.liveLevel() }),
    };

    this.customers = createNodeCustomerSection({
      ix: this.projected.ix,
      projected: this.projected,
      defs: this.defs,
      level: this.level,
      onSaved: saved,
      onCommit: () => {
        this.estimate = null; // any edit invalidates the pickup-order overlay
        this.refreshReplayButton();
        refreshQueueReadout();
      },
      onEstimate: () => this.runEstimate(),
      onReplayEstimate: () => {
        if (this.estimate) openNodeEstimateReplay(this.project, this.level.id, this.estimate.replaySteps);
      },
      currentEstimate: () => this.estimate,
      onHoverCustomer: (index) => this.highlightCustomer(index),
      onAutoGenerate: () =>
        openNodeGenerateDialog({
          ix: this.projected.ix,
          ids: orderIdIndex(this.projected.ix),
          projected: this.projected,
          level: this.level,
          currentCustomers: () => this.customers.draft,
          onGenerate: (customers) => {
            const removed = this.customers.draft.length;
            this.customers.draft = customers;
            this.customers.commit("Auto-generate customers", customers.length, removed);
            saved();
            // Chain into the queue's own Auto Generate, exactly as legacy does,
            // so regenerating customers doesn't leave the queue out of sync.
            startQueueAutoGenerate(this.queues, this.queueDeps, true);
          },
        }),
    });

    this.grid = createGridSection({
      map: this.projected.map,
      defs: this.defs,
      level: this.level,
      parse: () => parseGrid(this.level.gridString),
      onSaved: saved,
      onCommit: refreshQueueReadout,
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
  }

  /** Rebuilds the wrapper around the three existing sections, keeping their drafts. */
  private renderLayout(): void {
    this.root.replaceChildren(
      this.levelBar(),
      this.warningsEl,
      this.layoutMode === "split" ? this.splitLayout() : this.stackLayout(),
    );
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
        this.onChange();
      });
      return el("label", { class: "field small" }, [label, select]);
    };

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
      button("+ Level", () => this.addLevel()),
      button("🗑 Level", () => this.deleteLevel(), { class: "danger" }),
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
      onRun: (scenario) => {
        this.scenario = scenario;
        this.runEstimateWith(scenario);
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

  /** Estimate with the same graph-native engine used by Play and replay. */
  private runEstimateWith(scenario: EstimateScenario): void {
    const level = this.liveLevel();
    try {
      this.estimate = estimateNodeDifficulty(this.projected.ix, structuredClone(level), { scenario });
    } catch (err) {
      this.estimate = null;
      this.refreshReplayButton();
      console.error("Estimate Difficulty failed", err);
      alert(`Estimate Difficulty failed: ${(err as Error).message}`);
      return;
    }
    this.customers.render();
    this.queues.render();
    this.refreshReplayButton();
  }

  /**
   * Hover feedback for one customer: their queue tiles and their points on the
   * estimate chart light up together. Driven by direct class toggles rather
   * than a re-render — the queue body is expensive to rebuild, and a rebuild
   * mid-hover would drop the cursor's own target out from under it.
   */
  private highlightCustomer(index: number | null): void {
    const cids = new Set<string>();
    if (index !== null && this.estimate) {
      for (const [cid, slot] of this.estimate.byCid) {
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
    // The chart lives in the customers section, and its points carry the owning
    // customer directly (see occupancyChart.ts).
    const chart = this.customers?.element.querySelector<HTMLElement>(".occupancy-chart");
    if (chart) {
      chart.classList.toggle("customer-focus", index !== null);
      if (index !== null) chart.style.setProperty("--focus-color", customerColor(index));
      chart.querySelectorAll<SVGElement>(".occupancy-point").forEach((point) => {
        const owner = point.dataset.customer;
        point.classList.toggle("customer-hit", index !== null && owner === String(index));
      });
    }
  }

  /** Section headers persist while their bodies re-render, so update this control explicitly. */
  private refreshReplayButton(): void {
    const replay = this.root.querySelector<HTMLButtonElement>(".estimate-replay-btn");
    if (replay) replay.disabled = !(this.estimate?.replaySteps.length);
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
