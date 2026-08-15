// Design mode on the node graph — the legacy page, driven by graph rules.
//
// The reuse claim was tested rather than assumed, and it mostly held. Queue and
// grid grammars are unchanged, so `createQueueSection` and `createGridSection`
// come through VERBATIM, reading a projection of the graph into the `MapDef`
// shape they were written against (see data/nodeGraphToMapDef.ts). Only the
// customer section is forked, because the bracket dish format genuinely turns a
// flat chip list into a tree editor.
//
// The projection is also what makes the difficulty estimator work unchanged.
// The plan expected to fork it for chain awareness; it turned out not to be
// necessary, because the projection collapses a multi-tool route into legacy's
// `chainTools` spelling — so the estimator already scores a raw chicken breast
// as producing a FRIED one (not the coated intermediate no dish wants) and
// still pays for both tool visits. That removes the single largest risk the
// plan carried, and it removes ~700 lines of forked solver with it.

import { button, el } from "../dom.ts";
import { estimateDifficulty } from "../design/estimateDifficulty.ts";
import type { EstimateResult } from "../design/estimateDifficulty.ts";
import { createGridSection } from "../design/gridSection.ts";
import { createQueueSection, toQueueDraft } from "../design/queueSection.ts";
import type { QueueDraft, QueueSectionDeps } from "../design/queueSection.ts";
import type { Section } from "../design/section.ts";
import { createNodeCustomerSection } from "./nodeCustomerSection.ts";
import { openNodeGenerateDialog } from "./nodeGenerateDialog.ts";
import { occupancyChartEl } from "../design/occupancyChart.ts";
import type { ChartVisibility } from "../design/occupancyChart.ts";
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
  /** Legend toggles for the occupancy chart; kept across re-renders of the chart. */
  private chartVisibility: ChartVisibility = { scoredTint: true, randomTint: true, completeLines: true };
  private warningsEl = el("div", { class: "warnings" });
  private chartEl = el("div", { class: "node-estimate-chart" });

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
    // An estimate is a property of ONE level's queue; carrying it across would
    // colour tiles with numbers that mean nothing here.
    this.estimate = null;
    this.onLevelChange?.(levelId);
    this.build();
  }

  private build(): void {
    if (!this.level) {
      this.root.replaceChildren(el("p", {}, ["This graph has no levels yet."]));
      return;
    }

    const commit = () => {
      this.estimate = null; // any edit invalidates the pickup-order overlay
      this.refreshWarnings();
    };
    const saved = () => {
      this.onChange();
      this.refreshWarnings();
    };

    this.customers = createNodeCustomerSection({
      ix: this.projected.ix,
      defs: this.defs,
      level: this.level,
      dataIdOf: this.projected.dataIdOf,
      onSaved: saved,
      onCommit: commit,
      currentEstimate: () => this.estimate,
      onAutoGenerate: () =>
        openNodeGenerateDialog({
          ix: this.projected.ix,
          ids: orderIdIndex(this.projected.ix),
          projected: this.projected,
          level: this.level,
          currentCustomers: () => this.customers.draft,
          onGenerate: (customers) => {
            this.customers.draft = customers;
            this.customers.commit("Auto Generate customers", customers.length, 0);
          },
        }),
    });

    this.grid = createGridSection({
      map: this.projected.map,
      defs: this.defs,
      level: this.level,
      parse: () => parseGrid(this.level.gridString),
      onSaved: saved,
      onCommit: commit,
    });

    this.queueDeps = {
      map: this.projected.map,
      defs: this.defs,
      level: this.level,
      parse: () => ({
        queues: parseQueues(this.level.queueString),
        groups: parseQueueGroups(this.level.queueString),
      }),
      // The Recipe Pieces foldout counts pieces against orders, so it needs the
      // orders in the flat shape it was written for. Resolving each bracket
      // dish gives exactly that, with no information the foldout uses lost.
      currentCustomers: () => this.flatCustomers(),
      currentGrid: () => this.grid.draft,
      onSaved: saved,
      onCommit: commit,
      currentEstimate: () => this.estimate,
    };
    this.queues = createQueueSection(this.queueDeps);
    this.queues.draft = toQueueDraft(this.queueDeps.parse());

    // `Section` builds its header in the constructor but leaves the body to
    // the caller's first render — the same contract the legacy DesignView
    // honours. Skipping it leaves an empty section that looks like a data bug.
    this.customers.render();
    this.grid.render();
    this.queues.render();

    this.root.replaceChildren(
      this.levelBar(),
      this.warningsEl,
      this.chartEl,
      this.customers.element,
      this.grid.element,
      this.queues.element,
    );
    this.refreshWarnings();
    this.renderChart();
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
    const picker = el("select", {}) as HTMLSelectElement;
    for (const level of this.project.levels) {
      picker.append(el("option", { value: String(level.id) }, [level.name]));
    }
    picker.value = String(this.level.id);
    picker.addEventListener("change", () => this.selectLevel(Number(picker.value)));

    const dropdown = (
      label: string,
      options: string[],
      value: string,
      onSet: (v: string) => void,
    ): HTMLElement => {
      const select = el("select", {}) as HTMLSelectElement;
      for (const option of options) select.append(el("option", { value: option }, [option]));
      select.value = value;
      select.addEventListener("change", () => {
        onSet(select.value);
        this.onChange();
      });
      return el("label", { class: "inline-field" }, [label, select]);
    };

    const numberField = (label: string, value: number, onSet: (n: number) => void): HTMLElement => {
      const input = el("input", { type: "number", value: String(value) }) as HTMLInputElement;
      input.addEventListener("change", () => {
        onSet(Number(input.value) || 0);
        this.onChange();
      });
      return el("label", { class: "inline-field" }, [label, input]);
    };

    return el("div", { class: "level-bar" }, [
      el("strong", {}, ["Level"]),
      picker,
      dropdown("weather", WEATHER.map((w) => w.id), this.level.weather, (v) => (this.level.weather = v)),
      dropdown("tag", TAGS.map((t) => t.id), this.level.levelTag, (v) => (this.level.levelTag = v)),
      numberField("serve slots", this.level.serveableSlots, (n) => (this.level.serveableSlots = n)),
      numberField("shuffle", this.level.shuffleDistance, (n) => (this.level.shuffleDistance = n)),
      button("📊 Estimate Difficulty", () => this.runEstimate(), {
        title: "Run the greedy solver over this level",
      }),
    ]);
  }

  /**
   * The estimator runs on the PROJECTION, not the graph — so what it reports is
   * an approximation in exactly one respect: intermediates are collapsed into a
   * chainTools hop rather than modelled as real items. The tool cost, the
   * yields and the gates all survive, which is what the score depends on.
   */
  private runEstimate(): void {
    const level = nodeLevelAsLevelConfig(this.projected, this.level);
    try {
      this.estimate = estimateDifficulty(this.projected.map, level);
    } catch (err) {
      this.estimate = null;
      console.error(err);
      alert(`Estimate failed: ${(err as Error).message}`);
      return;
    }
    this.build();
  }

  /**
   * The occupancy chart, imported from the legacy Design mode UNCHANGED. It
   * reads `EstimateResult`, and the node estimator produces exactly that type,
   * so the whole visualisation — tints, dirty line, per-customer markers,
   * legend toggles — comes across for free.
   */
  private renderChart(): void {
    if (!this.estimate) {
      this.chartEl.replaceChildren();
      return;
    }
    this.chartEl.replaceChildren(
      occupancyChartEl(
        this.estimate.occupancyHistory,
        this.estimate.gridCapacity,
        this.chartVisibility,
        (key) => {
          this.chartVisibility = { ...this.chartVisibility, [key]: !this.chartVisibility[key] };
          this.renderChart();
        },
      ),
    );
  }

  private refreshWarnings(): void {
    const rows: string[] = [];
    const { errors } = validateNodeGraph(this.project.doc);
    for (const issue of errors.slice(0, 6)) rows.push(`Graph: ${issue.invariantId} — ${issue.message}`);
    if (errors.length > 6) rows.push(`…and ${errors.length - 6} more graph errors`);

    if (this.estimate) {
      rows.push(
        `Estimate: ${this.estimate.solvable ? "solvable" : "not solvable"}, ` +
          `${this.estimate.servedCount}/${this.estimate.totalCustomers} served, ` +
          `${this.estimate.totalPicks} picks` +
          (this.estimate.reason ? ` — ${this.estimate.reason}` : ""),
      );
    }

    this.warningsEl.replaceChildren(
      ...(rows.length === 0
        ? [el("span", { class: "muted" }, ["Graph valid · no level warnings."])]
        : rows.map((r) => el("div", {}, [r]))),
    );
  }
}
