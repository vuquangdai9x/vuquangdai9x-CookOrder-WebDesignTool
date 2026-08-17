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
// The projection is also what makes the difficulty estimator work unchanged.
// The plan expected to fork it for chain awareness; it turned out not to be
// necessary, because the projection collapses a multi-tool route into legacy's
// `chainTools` spelling — so the estimator already scores a raw chicken breast
// as producing a FRIED one (not the coated intermediate no dish wants) and
// still pays for both tool visits.

import { button, el } from "../dom.ts";
import { estimateDifficulty } from "../design/estimateDifficulty.ts";
import type { EstimateResult } from "../design/estimateDifficulty.ts";
import { createGridSection } from "../design/gridSection.ts";
import { createQueueSection, toQueueDraft } from "../design/queueSection.ts";
import { openAutoGenerateQueueDialog } from "../design/autoGenerateQueueDialog.ts";
import { generateNodeQueueLanes } from "./nodeQueueGenerate.ts";
import type { QueueDraft, QueueSectionDeps } from "../design/queueSection.ts";
import type { Section } from "../design/section.ts";
import { createNodeCustomerSection } from "./nodeCustomerSection.ts";
import { openNodeGenerateDialog } from "./nodeGenerateDialog.ts";
import { parseGrid, parseQueueGroups, parseQueues } from "../../core/parser.ts";
import type { NodeCustomerConfig } from "../../core/nodeParser.ts";
import { buildIndex } from "../../core/nodeIndex.ts";
import { orderIdIndex, resolveOrder } from "../../core/nodeOrder.ts";
import type { CustomerConfig, GlobalDefs, GridCellConfig } from "../../core/types.ts";
import { TAGS, WEATHER } from "../../data/configLoader.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import { nodeAsMapDef, nodeLevelAsLevelConfig } from "../../data/nodeGraphToMapDef.ts";
import type { ProjectedMap } from "../../data/nodeGraphToMapDef.ts";
import { validateNodeGraph } from "../../data/nodeGraphValidate.ts";
import type { NodeProjectState } from "../../data/nodeProject.ts";

type LayoutMode = "stack" | "split";

export class NodeDesignView {
  private root: HTMLElement;
  private project: NodeProjectState;
  private defs: GlobalDefs;
  private onChange: () => void;
  private onLevelChange?: (levelId: number) => void;

  private projected: ProjectedMap;
  private level!: LevelData;

  private customers!: Section<NodeCustomerConfig[]>;
  private grid!: Section<GridCellConfig[]>;
  private queues!: Section<QueueDraft>;
  private queueDeps!: QueueSectionDeps;
  /** Last Estimate Difficulty run for the OPEN level; cleared on any level switch. */
  private estimate: EstimateResult | null = null;
  private warningsEl = el("div", { class: "warnings" });
  private layoutMode: LayoutMode = "stack";

  constructor(
    root: HTMLElement,
    project: NodeProjectState,
    defs: GlobalDefs,
    onChange: () => void,
    initialLevelId?: number,
    onLevelChange?: (levelId: number) => void,
  ) {
    this.root = root;
    this.project = project;
    this.defs = defs;
    this.onChange = onChange;
    this.onLevelChange = onLevelChange;
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
    };

    this.customers = createNodeCustomerSection({
      ix: this.projected.ix,
      projected: this.projected,
      defs: this.defs,
      level: this.level,
      onSaved: saved,
      onCommit: () => {
        this.estimate = null; // any edit invalidates the pickup-order overlay
        refreshQueueReadout();
      },
      onEstimate: () => this.runEstimate(),
      currentEstimate: () => this.estimate,
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
            this.autoGenerateQueue(true);
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
    this.queues.draft = toQueueDraft(this.queueDeps.parse());
    this.grid.render();
    this.queues.render();

    this.renderLayout();
    this.refreshWarnings();
  }

  /** Rebuilds the wrapper around the three existing sections, keeping their drafts. */
  /**
   * Queue auto-generation, routed through the NODE generator.
   *
   * Legacy's runs off the projected MapDef, where a multi-input recipe has
   * already collapsed to its first input — so it would queue ground coffee and
   * no cups, and every coffee machine would sit half-filled forever. This walks
   * the graph instead; see nodeQueueGenerate.ts.
   *
   * The dialog itself is legacy's, unchanged: the shuffle controls and the
   * curve cache mean the same thing in both modes, and forking them would only
   * create two places for "shuffle range 3" to drift apart.
   */
  private autoGenerateQueue(skipOverwriteConfirm = false): void {
    if (!skipOverwriteConfirm && !confirm("Auto-generate overwrites every lane. Continue?")) return;
    openAutoGenerateQueueDialog({
      level: this.level,
      onGenerate: (shuffleRange) => {
        const before = this.queues.draft.queues.reduce((n, q) => n + q.length, 0);
        const lanes = generateNodeQueueLanes({
          ix: this.projected.ix,
          ids: orderIdIndex(this.projected.ix),
          customers: this.customers.draft,
          laneCount: Math.max(1, this.queues.draft.queues.length),
          shuffleRange,
        });
        const after = lanes.reduce((n, l) => n + l.length, 0);
        // Rebuilt through toQueueDraft so every item gets the `_cid` identity
        // the section tracks drags and groups by. Authored groups do not
        // survive a full regeneration.
        this.queues.draft = toQueueDraft({
          queues: lanes.map((lane) => lane.map((id) => ({ kind: "ingredient", id, effects: [] }))),
          groups: [],
        });
        this.queues.commit("Auto-generate queue", after, before);
        this.onChange();
      },
    });
  }

  private renderLayout(): void {
    this.root.replaceChildren(
      this.mapSettingsBar(),
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
      this.customers.element,
      this.grid.element,
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

  private mapSettingsBar(): HTMLElement {
    const doc = this.project.doc;
    const stackInput = el("input", {
      type: "number",
      value: String(doc.map.dirtyStackHeight),
      min: "1",
    }) as HTMLInputElement;
    stackInput.addEventListener("change", () => {
      doc.map.dirtyStackHeight = Math.max(1, Number(stackInput.value) || 1);
      this.onChange();
    });

    return el("div", { class: "level-bar map-settings" }, [
      el("strong", { class: "map-settings-label" }, [`Map: ${doc.map.name}`]),
      el("label", { class: "field small" }, ["Dirty stack", stackInput]),
      el("small", { class: "muted" }, ["Applies to every level in this map"]),
    ]);
  }

  private levelBar(): HTMLElement {
    const picker = el("select", { class: "level-picker" }) as HTMLSelectElement;
    for (const l of this.project.levels) {
      const opt = el("option", { value: String(l.id) }, [
        `${l.name}${l.levelTag ? ` (${l.levelTag})` : ""}`,
      ]);
      if (l.id === this.level.id) (opt as HTMLOptionElement).selected = true;
      picker.append(opt);
    }
    picker.addEventListener("change", () => this.selectLevel(Number(picker.value)));

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
      metaField("Serve slots", this.level.serveableSlots, "number", (v) => {
        this.level.serveableSlots = Math.max(1, Number(v) || 1);
      }),
      el("span", { class: "spacer" }),
      button("+ Level", () => this.addLevel()),
      button("🗑 Level", () => this.deleteLevel(), { class: "danger" }),
    ]);
  }

  private addLevel(): void {
    const nextId = this.project.levels.reduce((n, l) => Math.max(n, l.id), 0) + 1;
    const template = this.level;
    this.project.levels.push({
      ...structuredClone(template),
      id: nextId,
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

  /**
   * The estimator runs on the PROJECTION, not the graph — an approximation in
   * exactly one respect: intermediates are collapsed into a chainTools hop
   * rather than modelled as separate items. Tool cost, yields and gates all
   * survive, which is what the score depends on.
   */
  private runEstimate(): void {
    const level = nodeLevelAsLevelConfig(this.projected, this.level);
    // The estimator reads live drafts, not the saved strings.
    level.customers = this.flatCustomers();
    level.grid = this.grid.draft;
    level.queues = this.queues.draft.queues;
    try {
      this.estimate = estimateDifficulty(this.projected.map, structuredClone(level));
    } catch (err) {
      this.estimate = null;
      console.error("Estimate Difficulty failed", err);
      alert(`Estimate Difficulty failed: ${(err as Error).message}`);
      return;
    }
    this.customers.render();
    this.queues.render();
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
