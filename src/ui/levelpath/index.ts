// Level Path — the whole game's level progression on one page.
//
// Design mode answers "is THIS level right?". Nothing answered "does the
// difficulty go anywhere?", which is a question about a hundred levels at once,
// so this tab is built around comparison rather than editing depth: one
// foldout per map, one row per level, and every statistic coloured against its
// own range across every level on screen so a flat stretch or a spike is
// visible without reading a single number.
//
// Three consequences shape the code below.
//
// It spans EVERY map, not the open one. Each map's project is loaded and held
// here, and edits are written straight through to its own draft — there is no
// save button, because a table of a hundred rows with a dirty flag is a table
// where the designer eventually loses work.
//
// Statistics are computed up front, behind a blocking overlay, rather than per
// row on demand. A row that computes lazily is a row whose colour changes when
// you scroll past it, which defeats the entire point of the colouring.
//
// And the expensive operations — generate, validate — are chunked with a yield
// between levels, so the overlay actually paints and a batch over a whole map
// does not look like a hung tab.

import { button, el } from "../dom.ts";
import { showContextMenu } from "../contextMenu.ts";
import { hideBlockingOverlay, showBlockingOverlay } from "../loadingOverlay.ts";
import { iconEl } from "../icon.ts";
import { setIconMap } from "../icon.ts";
import Sortable from "sortablejs";
import { openCurveDialog, defaultCurve, parseCurve, serializeCurve } from "../design/curveEditor.ts";
import type { CurveState } from "../design/curveEditor.ts";
import { evaluateCurve } from "../design/curveEditor.ts";
import {
  DEFAULT_INGREDIENT_WEIGHT,
  openIngredientWeightsDialog,
  parseIngredientWeights,
  serializeIngredientWeights,
} from "../design/ingredientWeightEditor.ts";
import {
  DEFAULT_MAX_DISH_SLOTS,
  parseDishCountSequence,
  serializeDishCountSequence,
} from "../design/autoGenerate.ts";
import { defaultScenario } from "../design/estimateScenario.ts";
import type { EstimateScenario } from "../design/estimateScenario.ts";
import { makeScrubber } from "../scrubInput.ts";
import { currentTheme, THEME_CHANGE_EVENT } from "../theme.ts";
import { buildIndex } from "../../core/nodeIndex.ts";
import type { GraphIndex } from "../../core/nodeIndex.ts";
import type { GlobalDefs, Id } from "../../core/types.ts";
import { TAGS, WEATHER } from "../../data/configLoader.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import { buildIdIndex } from "../../data/nodeIdTable.ts";
import type { IdIndex } from "../../data/nodeIdTable.ts";
import { nodeAsMapDef } from "../../data/nodeGraphToMapDef.ts";
import type { ProjectedMap } from "../../data/nodeGraphToMapDef.ts";
import {
  blankLevel,
  clearNodeDraft,
  createNodeMap,
  listNodeMaps,
  loadNodeProject,
  NODE_ACTIVE_KEY,
  saveNodeProject,
} from "../../data/nodeProject.ts";
import type { NodeProjectState } from "../../data/nodeProject.ts";
import { buildColumns, widthVar } from "./columns.ts";
import type { ColumnDef } from "./columns.ts";
import {
  createConfigPanel,
  loadConfig,
  MIN_COLUMN_WIDTH,
  saveConfig,
} from "./config.ts";
import type { LevelPathConfig } from "./config.ts";
import {
  openBatchGenerateDialog,
  openDishSequenceDialog,
  openNewMapDialog,
  openObstacleBudgetDialog,
} from "./dialogs.ts";
import { obstacleSummary, parseObstacles, serializeObstacles } from "./obstacles.ts";
import {
  DEFAULT_SHUFFLE_MAX_Y,
  generateLevel,
  linearShuffleCurve,
  mintSeed,
  resolveConfig,
} from "./generateLevel.ts";
import type { GenerateLevelResult } from "./generateLevel.ts";
import {
  applyWeightRepair,
  ingredientDistribution,
  repairIngredientWeights,
  weightsFromDistribution,
} from "./weightRepair.ts";
import { openNodeGenerateDialog } from "../nodedesign/nodeGenerateDialog.ts";
import { parseNodeCustomers } from "../../core/nodeParser.ts";
import {
  cachedEstimate,
  cachedStatus,
  cacheEstimate,
  cacheStatus,
  forgetLevel,
  levelSignature,
  scenarioSignature,
} from "./validationCache.ts";
import { computeLevelStats } from "./levelStats.ts";
import type { LevelStats } from "./levelStats.ts";
import { defaultGradient, metricRange, normalizeMetric, paintMetricCell } from "./metricColor.ts";
import type { ColumnGradient, MetricRange } from "./metricColor.ts";
import { openGradientEditor } from "./gradientEditor.ts";
import { emptyStatus, validateLevel } from "./validateLevel.ts";
import type { LevelStatus } from "./validateLevel.ts";

/** Levels above which the up-front statistics pass gets a loading overlay. */
const OVERLAY_THRESHOLD = 40;

/**
 * Row tint per weather, by the weather row's `status` rather than its id —
 * the status is the gameplay effect ("Wet", "Hot"), which is what a designer is
 * actually scanning for, and it survives a weather being renamed.
 */
const WEATHER_HUE: Record<string, number> = {
  Wet: 205,
  Hot: 32,
  Cold: 188,
  Blowing: 272,
};

const weatherRow = (id: string) => WEATHER.find((w) => w.id === id);
const tagRow = (id: string) => TAGS.find((t) => t.id === id) as { id: string; name: string; emoji?: string } | undefined;

/** Yields to the browser so a pending overlay repaint actually happens. */
const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Whether a click landed on something the row does not own.
 *
 * Selection listens on the whole row, so this is what keeps "type in the note
 * field" from also meaning "select this level" — and what keeps a right-click
 * inside a text field showing the browser's cut/paste menu instead of the
 * level menu.
 */
function isRowControl(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  return !!node?.closest?.(
    "input, select, button, textarea, .lp-editable, .lp-tags, .lp-weights, .lp-curve",
  );
}

/** The four generator inputs a row can carry, clear and re-roll independently. */
type GeneratorField = "weights" | "dishes" | "complexity" | "shuffle";

const FIELD_LABEL: Record<GeneratorField, string> = {
  weights: "Ingredient weights",
  dishes: "Dish sequence",
  complexity: "Complexity curve",
  shuffle: "Shuffle curve",
};

/**
 * Read/write access to each generator field, in one table.
 *
 * `undefined` DELETES rather than writing an empty string, because the pipeline
 * asks `if (level.complexityCurve)` — an empty string would behave the same
 * today but is a second representation of "absent" waiting to disagree with the
 * first.
 */
const LEVEL_FIELD_OF: Record<GeneratorField, (level: LevelData, value: string | undefined) => void> = {
  weights: (level, value) => {
    if (value === undefined) delete level.ingredientWeights;
    else level.ingredientWeights = value;
  },
  dishes: (level, value) => {
    if (value === undefined) delete level.customerDishesSequence;
    else level.customerDishesSequence = value;
  },
  complexity: (level, value) => {
    if (value === undefined) delete level.complexityCurve;
    else level.complexityCurve = value;
  },
  shuffle: (level, value) => {
    if (value === undefined) delete level.shuffleCurve;
    else level.shuffleCurve = value;
  },
};

export interface LevelPathDeps {
  /** The live project for the open map. Held by reference so other tabs see the same edits. */
  project: NodeProjectState;
  defs: GlobalDefs;
  onOpenDesign(docId: string, levelId: number): void;
  onOpenPlay(docId: string, levelId: number): void;
  /** The open map's own data was reset or removed — the shell has to reload it. */
  onReloadShell(): void;
}

/** One map's foldout: its project, the indices its rows are read through, and the derived data. */
interface MapEntry {
  docId: string;
  title: string;
  bundled: boolean;
  project: NodeProjectState;
  ix: GraphIndex;
  ids: IdIndex;
  projected: ProjectedMap;
  stats: Map<number, LevelStats>;
  status: Map<number, LevelStatus>;
  open: boolean;
  /** The foldout element, so one map can be re-rendered without touching the rest. */
  host: HTMLElement;
}

export class LevelPathView {
  private root: HTMLElement;
  private deps: LevelPathDeps;
  private config: LevelPathConfig;
  private columns: ColumnDef[];
  private entries: MapEntry[] = [];
  /** Column-width custom properties live here, shared by every map's table. */
  private surface = el("div", { class: "lp-surface" });
  private mapsHost = el("div", { class: "lp-maps" });
  /** Selected rows, keyed `docId:levelId`. Selection spans maps; the row menu acts on all of it. */
  private selected = new Set<string>();
  /** Anchor for shift-click range selection, or null when nothing is anchored yet. */
  private anchor: { docId: string; index: number } | null = null;
  private ranges = new Map<string, MetricRange>();
  /**
   * Scoring scenario the generate/validate runs use. A view setting, not level
   * data — the same reasoning as Design mode's copy.
   */
  private scenario: EstimateScenario = defaultScenario();
  /** Icon map the rest of the app installed, restored after a dialog borrows it. */
  private hostIconMap: ProjectedMap["map"] | null = null;

  constructor(root: HTMLElement, deps: LevelPathDeps) {
    this.root = root;
    this.deps = deps;
    this.config = loadConfig();
    this.columns = buildColumns(deps.defs);
    this.root.replaceChildren(el("p", { class: "muted" }, ["Computing level statistics…"]));
    // The statistic ramp is computed in JS, so the stylesheet's palette swap
    // cannot reach it — these inline colours have to be recomputed by hand when
    // the theme flips, or every number stays tuned for the theme it was painted
    // under. Registered on window and never removed: the view lives as long as
    // the tab is mounted, and re-mounting replaces the whole root anyway.
    window.addEventListener(THEME_CHANGE_EVENT, this.onThemeChange);
    void this.prepare();
  }

  private onThemeChange = (): void => this.repaintMetrics();

  /** Load every map and compute every statistic BEFORE the table exists. See the header comment. */
  private async prepare(): Promise<void> {
    const maps = listNodeMaps();
    const heavy = maps.length > 2;
    if (heavy) {
      showBlockingOverlay("Loading maps…");
      await breathe();
    }

    this.entries = [];
    for (const map of maps) {
      // The open map must be the LIVE object, not a second copy of it — two
      // copies would silently diverge the moment either tab wrote to one.
      const project =
        map.id === this.deps.project.docId ? this.deps.project : loadNodeProject(map.id);
      const ix = buildIndex(project.doc);
      this.entries.push({
        docId: map.id,
        title: map.name,
        bundled: map.bundled,
        project,
        ix,
        ids: buildIdIndex(project.doc.idTable),
        projected: nodeAsMapDef(project.doc, ix),
        stats: new Map(),
        status: new Map(),
        open: this.config.openMaps.includes(map.id),
        host: el("section", { class: "lp-map" }),
      });
    }

    const total = this.entries.reduce((n, entry) => n + entry.project.levels.length, 0);
    if (total > OVERLAY_THRESHOLD && !heavy) {
      showBlockingOverlay("Computing level statistics…");
      await breathe();
    }

    let done = 0;
    for (const entry of this.entries) {
      let repaired = false;
      for (const level of entry.project.levels) {
        // Old levels carry weight records that contradict their own customers —
        // ingredients the level demonstrably orders, recorded as disabled. That
        // combination cannot have produced this level, so the record is stale
        // and gets rebuilt from what the customers actually ask for. See
        // weightRepair.ts for why this is the ONLY disagreement that counts.
        const repair = repairIngredientWeights(level, entry.ix, entry.ids);
        const note = repair ? applyWeightRepair(level, repair) : null;
        if (note) repaired = true;

        entry.stats.set(level.id, computeLevelStats(level, entry.ix, entry.ids));
        const status = this.initialStatus(entry, level);
        if (note) {
          // Reported, not silent: this edited the designer's data, and a repair
          // nobody is told about is indistinguishable from corruption.
          status.warnings.push(note);
          status.ok = false;
        }
        entry.status.set(level.id, status);

        done++;
        // Yield periodically so the overlay repaints and the tab stays
        // interruptible on a project with hundreds of levels.
        if (done % 50 === 0) {
          showBlockingOverlay(`Computing level statistics… ${done}/${total}`);
          await breathe();
        }
      }
      if (repaired) this.persist(entry);
    }

    hideBlockingOverlay();
    this.refreshRanges();
    this.render();
  }

  /**
   * The status a row starts with, before any Validate run: only what the cheap
   * statistics pass already knows. Anything costing a simulation waits for an
   * explicit Validate, so opening the tab never costs minutes.
   */
  private initialStatus(entry: MapEntry, level: LevelData): LevelStatus {
    const stats = entry.stats.get(level.id);
    const status = emptyStatus();
    if (!stats) return status;
    for (const error of stats.parseErrors) status.errors.push(error);
    if (stats.numCustomers === 0) status.warnings.push("No customers yet.");
    else if (stats.numQueueItems === 0) status.warnings.push("Queue is empty.");
    status.ok = status.errors.length === 0 && status.warnings.length === 0;
    return status;
  }

  // ---------- derived data ----------

  /** Re-normalizes every statistic column against every level currently loaded. */
  private refreshRanges(): void {
    this.ranges.clear();
    for (const column of this.columns) {
      if (!column.metric) continue;
      const values: number[] = [];
      for (const entry of this.entries) {
        for (const level of entry.project.levels) {
          const stats = entry.stats.get(level.id);
          if (stats) values.push(column.metric(stats));
        }
      }
      this.ranges.set(column.id, metricRange(values));
    }
  }

  private visibleColumns(): ColumnDef[] {
    return this.columns.filter((column) => {
      if (column.group === "info") return this.config.showInfo;
      if (column.group === "generator") return this.config.showGenerator;
      if (column.group === "statistic") return this.config.showStatistic;
      return true;
    });
  }

  private widthOf(column: ColumnDef): number {
    return this.config.widths[column.id] ?? column.width;
  }

  /** Publishes every visible column's scaled width as a custom property on the shared surface. */
  private applyWidths(): void {
    for (const column of this.columns) {
      this.surface.style.setProperty(
        widthVar(column.id),
        `${Math.round(this.widthOf(column) * this.config.widthScale)}px`,
      );
    }
  }

  // ---------- persistence ----------

  private persist(entry: MapEntry): void {
    saveNodeProject(entry.project);
    // saveNodeProject also stamps the ACTIVE map pointer, which is right when
    // the app switches maps and wrong here: this tab writes to maps the app is
    // not showing, and letting one of those steal the pointer would reopen the
    // tool on a map the designer never navigated to.
    if (entry.docId !== this.deps.project.docId) {
      try {
        localStorage.setItem(NODE_ACTIVE_KEY, this.deps.project.docId);
      } catch {
        // Storage is unavailable; the draft write above already warned.
      }
    }
  }

  private saveView(): void {
    this.config.openMaps = this.entries.filter((entry) => entry.open).map((entry) => entry.docId);
    saveConfig(this.config);
  }

  /** Recompute one level's statistics after it changed, and renormalize the colour ramps. */
  private restat(entry: MapEntry, level: LevelData): void {
    entry.stats.set(level.id, computeLevelStats(level, entry.ix, entry.ids));
    this.refreshRanges();
  }

  // ---------- rendering ----------

  private render(): void {
    const configPanel = createConfigPanel({
      config: this.config,
      onStructuralChange: () => this.render(),
      onScaleChange: () => {
        this.applyWidths();
        this.repaintMetrics();
      },
      onCommit: () => this.saveView(),
    });

    this.mapsHost = el("div", { class: "lp-maps" });
    this.surface = el("div", { class: "lp-surface" }, [this.mapsHost, this.newMapBar()]);
    this.applyWidths();
    for (const entry of this.entries) {
      entry.host = el("section", { class: "lp-map" });
      this.renderMap(entry);
      this.mapsHost.append(entry.host);
    }
    this.root.replaceChildren(configPanel, this.surface);
  }

  private newMapBar(): HTMLElement {
    return el("div", { class: "lp-new-map" }, [
      button("＋ Map", () => this.promptNewMap(), {
        class: "lp-new-map-btn",
        title: "Create a new map process graph, with a starting set of blank levels",
      }),
    ]);
  }

  private promptNewMap(): void {
    openNewMapDialog(10, (name, levels) => {
      const created = createNodeMap(name);
      for (let n = created.levels.length; n < levels; n++) {
        created.levels.push({
          ...blankLevel(created.doc, n + 1),
          name: `${created.doc.map.id}_${n + 1}`,
        });
      }
      saveNodeProject(created);
      // createNodeMap/saveNodeProject both claim the active-map pointer; the
      // app is still showing another map, so hand it back.
      try {
        localStorage.setItem(NODE_ACTIVE_KEY, this.deps.project.docId);
      } catch {
        // Nothing to do — the draft itself was written.
      }
      void this.prepare();
    });
  }

  /**
   * Rebuilds one map's foldout, PUTTING THE SCROLL BACK.
   *
   * Ripping the table out of the document and hanging a new one in its place
   * loses both the table's own scroll offsets and — because the page briefly
   * gets shorter — the window's. A designer editing level 60 would be thrown
   * back to level 1 by every keystroke's worth of work, which made the table
   * unusable for exactly the long maps it exists for.
   */
  private renderMap(entry: MapEntry): void {
    const previous = entry.host.querySelector<HTMLElement>(".lp-table");
    const scroll = previous ? { top: previous.scrollTop, left: previous.scrollLeft } : null;
    const pageY = window.scrollY;

    entry.host.replaceChildren(this.mapHeader(entry));
    entry.host.classList.toggle("open", entry.open);
    if (entry.open) {
      const table = this.table(entry);
      entry.host.append(table);
      if (scroll) {
        table.scrollTop = scroll.top;
        table.scrollLeft = scroll.left;
      }
    }
    if (window.scrollY !== pageY) window.scrollTo(window.scrollX, pageY);
  }

  /**
   * Rebuilds ONE row in place — the right granularity for editing a field.
   *
   * Most edits change one row and nothing else, and rebuilding the whole map
   * for them is both slower and the thing that disturbs scroll in the first
   * place. Falls back to the whole map when the row is not on screen (its map
   * is folded, or the level list itself changed underneath).
   */
  private refreshRow(entry: MapEntry, level: LevelData): void {
    const index = entry.project.levels.indexOf(level);
    const existing = entry.host.querySelector<HTMLElement>(`.lp-row[data-level="${level.id}"]`);
    if (index < 0 || !existing) {
      this.renderMap(entry);
      return;
    }
    existing.replaceWith(this.row(entry, level, index, this.visibleColumns()));
  }

  private mapHeader(entry: MapEntry): HTMLElement {
    const doc = entry.project.doc;
    const pickable = doc.vertices.ingredient.filter((v) => v.pickupable).length;
    const orderable = doc.vertices.composite.filter((v) => v.orderable).length;

    const stat = (label: string, value: number, title: string) =>
      el("span", { class: "lp-map-stat", title }, [el("b", {}, [String(value)]), ` ${label}`]);

    const head = el("div", { class: "lp-map-head" }, [
      el("span", { class: "lp-fold-marker" }, [entry.open ? "▾" : "▸"]),
      el("h2", {}, [entry.title]),
      el("div", { class: "lp-map-stats" }, [
        stat("pickable", pickable, "Ingredients a queue can hand the player"),
        stat("orderable", orderable, "Composites a customer may order"),
        stat("tools", doc.vertices.tool.length, "Cooking tools in this graph"),
        stat("levels", entry.project.levels.length, "Levels in this map"),
      ]),
      el("span", { class: "spacer" }),
      this.mapActions(entry),
    ]);

    // The whole header folds, but the action buttons inside it must not — a
    // click on Delete that also toggles the foldout reads as the page jumping
    // away from the thing being clicked.
    head.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest(".lp-map-actions")) return;
      entry.open = !entry.open;
      this.saveView();
      this.renderMap(entry);
    });
    return head;
  }

  private mapActions(entry: MapEntry): HTMLElement {
    let armed = false;
    const deleteBtn = button("🗑 Delete map", () => {
      if (!armed) {
        armed = true;
        deleteBtn.textContent = "🗑 Click again to delete";
        deleteBtn.classList.add("active");
        // Disarm on its own, so an armed button left alone cannot be triggered
        // by a stray click minutes later.
        setTimeout(() => {
          armed = false;
          deleteBtn.textContent = "🗑 Delete map";
          deleteBtn.classList.remove("active");
        }, 5000);
        return;
      }
      this.deleteMap(entry);
    }, { class: "small-btn danger" });

    return el("div", { class: "lp-map-actions" }, [
      button("✨ Batch generate", () => this.promptBatchGenerate(entry), {
        class: "small-btn",
        title: "Generate a range of levels, creating any that do not exist yet",
      }),
      button("🚦 Validate all", () => void this.validateAll(entry), {
        class: "small-btn",
        title: "Estimate, freeze audit and deadlock audit over every level in this map",
      }),
      deleteBtn,
    ]);
  }

  private deleteMap(entry: MapEntry): void {
    const bundled = entry.bundled;
    const message = bundled
      ? `"${entry.title}" ships with the tool, so deleting it discards every local edit and restores the bundled graph. Continue?`
      : `Delete "${entry.title}" and every level in it? This cannot be undone.`;
    if (!confirm(message)) return;

    clearNodeDraft(entry.docId);
    if (entry.docId === this.deps.project.docId) {
      // The app is showing this map; its in-memory copy no longer matches
      // storage, so the shell has to reload rather than this tab patching it.
      this.deps.onReloadShell();
      return;
    }
    void this.prepare();
  }

  // ---------- the table ----------

  private table(entry: MapEntry): HTMLElement {
    const columns = this.visibleColumns();
    const header = el("div", { class: "lp-row lp-head-row" });
    for (const column of columns) header.append(this.headerCell(column));

    const body = el("div", { class: "lp-body" });
    entry.project.levels.forEach((level, index) => {
      body.append(this.row(entry, level, index, columns));
    });

    // The add-row deliberately sits INSIDE the scrolling table rather than
    // under it: on a map of sixty levels, a button below the table is a button
    // you have to scroll the whole list to reach, and "add a level" is a thing
    // you do from wherever you happen to be.
    body.append(this.addLevelRow(entry));

    Sortable.create(body, {
      animation: 120,
      draggable: ".lp-row",
      handle: ".lp-cell-index",
      onEnd: (evt) => {
        if (evt.oldIndex === undefined || evt.newIndex === undefined) return;
        if (evt.oldIndex === evt.newIndex) return;
        const [moved] = entry.project.levels.splice(evt.oldIndex, 1);
        entry.project.levels.splice(Math.min(evt.newIndex, entry.project.levels.length), 0, moved);
        this.persist(entry);
        this.renderMap(entry);
      },
    });

    return el("div", { class: "lp-table" }, [header, body]);
  }

  /** The trailing "+ Add Level" row. Not `.lp-row`, so Sortable will not drag it. */
  private addLevelRow(entry: MapEntry): HTMLElement {
    const add = button("＋ Add Level", () => this.addLevel(entry), {
      class: "lp-add-level-btn",
      title: "Append a blank level to this map",
    });
    return el("div", { class: "lp-add-row" }, [add]);
  }

  private addLevel(entry: MapEntry): void {
    const levels = entry.project.levels;
    const nextId = levels.reduce((n, l) => Math.max(n, l.id), 0) + 1;
    const level: LevelData = {
      ...blankLevel(entry.project.doc, nextId),
      name: `${entry.project.doc.map.id}_${levels.length + 1}`,
    };
    levels.push(level);
    entry.stats.set(level.id, computeLevelStats(level, entry.ix, entry.ids));
    entry.status.set(level.id, this.initialStatus(entry, level));
    this.persist(entry);
    this.refreshRanges();
    this.renderMap(entry);
  }

  /**
   * Strips every generator input, INCLUDING the seed.
   *
   * The seed is the point: clearing the curves but keeping the seed would
   * rebuild the same level from the same draws, which is the opposite of what
   * "start this level over" means. The level's own strings are left alone —
   * this resets how the level would be GENERATED, not what it currently is.
   */
  private clearGeneratorData(targets: { entry: MapEntry; level: LevelData }[]): void {
    if (targets.length > 1) {
      const names = targets.slice(0, 6).map((t) => t.level.name).join(", ");
      const more = targets.length > 6 ? `, +${targets.length - 6} more` : "";
      if (!confirm(`Clear the generator data (weights, sequence, curves, obstacles and seed) of ${targets.length} levels?

${names}${more}`)) {
        return;
      }
    }
    const touched = new Set<MapEntry>();
    for (const { entry, level } of targets) {
      delete level.ingredientWeights;
      delete level.customerDishesSequence;
      delete level.complexityCurve;
      delete level.shuffleCurve;
      delete level.obstacleData;
      delete level.randomSeed;
      touched.add(entry);
    }
    for (const entry of touched) {
      this.persist(entry);
      this.renderMap(entry);
    }
  }

  private headerCell(column: ColumnDef): HTMLElement {
    const cell = el("div", { class: `lp-cell lp-head lp-cell-${column.id}` }, [column.label]);
    cell.style.flex = `0 0 var(${widthVar(column.id)})`;
    if (column.title) cell.title = column.title;

    const grip = el("div", { class: "lp-resize", title: "Drag to resize this column" });
    grip.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      grip.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = this.widthOf(column);
      const onMove = (move: PointerEvent) => {
        // The stored width is the UNSCALED base, so dividing by the scale keeps
        // the grip under the cursor at any zoom.
        const delta = (move.clientX - startX) / Math.max(0.01, this.config.widthScale);
        this.config.widths[column.id] = Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + delta));
        this.applyWidths();
      };
      const onUp = () => {
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        this.saveView();
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
    });
    cell.append(grip);

    // Only a statistic column HAS a colour scale, so only those offer the
    // editor; the rest keep the browser's own menu rather than opening one that
    // could not do anything.
    if (column.metric) {
      cell.addEventListener("contextmenu", (event) =>
        openGradientEditor(event, {
          title: column.title ?? column.label,
          gradient: this.gradientOf(column),
          onChange: (next) => {
            this.config.gradients[column.id] = next;
            this.repaintColumn(column);
          },
          onCommit: () => this.saveView(),
        }),
      );
    }
    return cell;
  }

  private row(entry: MapEntry, level: LevelData, index: number, columns: ColumnDef[]): HTMLElement {
    const row = el("div", { class: "lp-row" });
    row.dataset.level = String(level.id);
    if (this.selected.has(this.key(entry, level))) row.classList.add("selected");
    this.tintRow(row, level);

    for (const column of columns) {
      const cell = el("div", { class: `lp-cell lp-cell-${column.id}` });
      cell.style.flex = `0 0 var(${widthVar(column.id)})`;
      cell.append(...this.cellContent(entry, level, index, column));
      if (column.metric) this.paintCell(cell, column, entry, level);
      row.append(cell);
    }

    // Selection and the row menu live on the ROW, not on the index cell.
    // Anywhere the row is not offering its own control is fair game — a
    // designer aiming at "this level" aims at the row, and making them find the
    // one cell that listens is a rule nothing on screen tells them about.
    row.addEventListener("click", (event) => {
      if (isRowControl(event.target)) return;
      this.onSelectClick(entry, index, event);
    });
    row.addEventListener("contextmenu", (event) => {
      // A field keeps its native menu (cut/paste/undo) — replacing that would
      // cost more than the row menu gains.
      if (isRowControl(event.target)) return;
      this.openRowMenu(entry, level, index, event);
    });
    return row;
  }

  private tintRow(row: HTMLElement, level: LevelData): void {
    const status = weatherRow(level.weather)?.status ?? "None";
    const hue = this.config.visualizeWeather ? WEATHER_HUE[status] : undefined;
    const tint = hue === undefined ? "" : `hsla(${hue}, 55%, 45%, 0.14)`;
    row.style.background = tint;
    // The frozen index cell has to paint its own opaque background or the
    // columns scrolling under it show through — so it needs the row's tint as a
    // value it can layer, not just as the row's background.
    row.style.setProperty("--lp-row-tint", tint || "transparent");
  }

  private key(entry: MapEntry, level: LevelData): string {
    return `${entry.docId}:${level.id}`;
  }

  /** A column's stored ramp, or the auto-assigned one for its position. */
  private gradientOf(column: ColumnDef): ColumnGradient {
    const stored = this.config.gradients[column.id];
    if (stored) return stored;
    // Position among the METRIC columns, so inserting a non-statistic column
    // does not reshuffle every colour a designer has learned.
    const index = this.columns.filter((c) => c.metric).findIndex((c) => c.id === column.id);
    return defaultGradient(Math.max(0, index), this.config.baseHue);
  }

  private paintCell(cell: HTMLElement, column: ColumnDef, entry: MapEntry, level: LevelData): void {
    const stats = entry.stats.get(level.id);
    if (!stats || !column.metric) return;
    const range = this.ranges.get(column.id) ?? { min: 0, max: 0 };
    paintMetricCell(
      cell,
      normalizeMetric(column.metric(stats), range),
      this.config.statVisualize,
      this.config.textIntensity,
      this.config.fillIntensity,
      this.gradientOf(column),
      currentTheme(),
    );
  }

  /** Recolours ONE column — what the gradient editor drives while a hue slider is dragged. */
  private repaintColumn(column: ColumnDef): void {
    if (!column.metric) return;
    for (const entry of this.entries) {
      if (!entry.open) continue;
      for (const level of entry.project.levels) {
        const cell = entry.host.querySelector<HTMLElement>(
          `.lp-row[data-level="${level.id}"] .lp-cell-${column.id}`,
        );
        if (cell) this.paintCell(cell, column, entry, level);
      }
    }
  }

  /** Recolours every statistic cell in place — what the intensity scrubbers drive. */
  private repaintMetrics(): void {
    for (const entry of this.entries) {
      if (!entry.open) continue;
      for (const level of entry.project.levels) {
        const row = entry.host.querySelector<HTMLElement>(`.lp-row[data-level="${level.id}"]`);
        if (!row) continue;
        for (const column of this.columns) {
          if (!column.metric) continue;
          const cell = row.querySelector<HTMLElement>(`.lp-cell-${column.id}`);
          if (cell) this.paintCell(cell, column, entry, level);
        }
      }
    }
  }

  // ---------- cells ----------

  private cellContent(
    entry: MapEntry,
    level: LevelData,
    index: number,
    column: ColumnDef,
  ): (Node | string)[] {
    switch (column.group) {
      case "info":
        return this.infoCell(entry, level, index, column);
      case "generator":
        return this.generatorCell(entry, level, column);
      case "statistic": {
        const stats = entry.stats.get(level.id);
        return [String(stats && column.metric ? column.metric(stats) : 0)];
      }
      case "action":
        return [this.actionCell(entry, level)];
      default:
        return [this.statusCell(entry, level)];
    }
  }

  private infoCell(
    entry: MapEntry,
    level: LevelData,
    index: number,
    column: ColumnDef,
  ): (Node | string)[] {
    switch (column.id) {
      case "index":
        return [this.indexCell(level, index)];
      case "weather":
        return [
          this.select(
            WEATHER.map((w) => ({ id: w.id, name: `${w.emoji ?? ""} ${w.id}`.trim() })),
            level.weather,
            (value) => {
              level.weather = value;
              this.persist(entry);
              // Weather changes the row's emoji and its tint, and nothing else
              // on the page — so only the row is rebuilt.
              this.refreshRow(entry, level);
            },
          ),
        ];
      case "tag":
        return [
          this.select(
            TAGS.map((t) => {
              const emoji = (t as { emoji?: string }).emoji;
              return { id: t.id, name: `${emoji ?? ""} ${t.name}`.trim() };
            }),
            level.levelTag,
            (value) => {
              level.levelTag = value;
              this.persist(entry);
              this.refreshRow(entry, level);
            },
          ),
        ];
      case "unlock":
        return [
          this.text(level.featureUnlock, "e.g. egg_fried", (value) => {
            level.featureUnlock = value;
            this.persist(entry);
          }),
        ];
      default:
        return [
          this.text(level.designNote ?? "", "note…", (value) => {
            level.designNote = value;
            this.persist(entry);
          }),
        ];
    }
  }

  /**
   * `#3 🌧 💀` — and the drag handle.
   *
   * Selection and the row menu are the ROW's, not this cell's; all this owns is
   * the grip Sortable drags by.
   */
  private indexCell(level: LevelData, index: number): HTMLElement {
    const weather = weatherRow(level.weather);
    const tag = tagRow(level.levelTag);
    const label = [
      `#${index + 1}`,
      level.weather && level.weather !== "Normal" ? weather?.emoji ?? "" : "",
      level.levelTag ? tag?.emoji ?? "" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return el("div", { class: "lp-index", title: `${level.name} (id ${level.id})` }, [label]);
  }

  private generatorCell(entry: MapEntry, level: LevelData, column: ColumnDef): (Node | string)[] {
    switch (column.id) {
      case "weights":
        return [this.withFieldMenu(this.weightsCell(entry, level), entry, level, "weights")];
      case "dishes":
        return [this.withFieldMenu(this.dishSequenceCell(entry, level), entry, level, "dishes")];
      case "obstacles":
        return [this.obstacleCell(entry, level)];
      case "complexity":
        return [
          this.withFieldMenu(
            this.curveCell(
              level.complexityCurve
                ? parseCurve(level.complexityCurve, defaultCurve(1, DEFAULT_MAX_DISH_SLOTS))
                : defaultCurve(1, DEFAULT_MAX_DISH_SLOTS),
              `Complexity curve — ${level.name}`,
              (curve) => this.setField(entry, level, "complexity", serializeCurve(curve)),
              () => this.clearField(entry, level, "complexity"),
              level.complexityCurve === undefined || level.complexityCurve === "",
            ),
            entry,
            level,
            "complexity",
          ),
        ];
      case "shuffle":
        return [
          this.withFieldMenu(
            this.curveCell(
              level.shuffleCurve
                ? parseCurve(level.shuffleCurve, linearShuffleCurve(DEFAULT_SHUFFLE_MAX_Y))
                : linearShuffleCurve(DEFAULT_SHUFFLE_MAX_Y),
              `Shuffle curve — ${level.name}`,
              (curve) => this.setField(entry, level, "shuffle", serializeCurve(curve)),
              () => this.clearField(entry, level, "shuffle"),
              level.shuffleCurve === undefined || level.shuffleCurve === "",
            ),
            entry,
            level,
            "shuffle",
          ),
        ];
      default:
        return [this.seedCell(entry, level)];
    }
  }

  // ---------- generator fields: set, clear, reroll ----------

  /**
   * A generator field can legitimately be ABSENT, and absent is not the same as
   * empty: it means "the generator decides this one". Clearing a field is
   * therefore a real authoring act, not a delete — it hands the decision back.
   */
  private setField(entry: MapEntry, level: LevelData, field: GeneratorField, value: string): void {
    LEVEL_FIELD_OF[field](level, value);
    this.persist(entry);
    this.refreshRow(entry, level);
  }

  private clearField(entry: MapEntry, level: LevelData, field: GeneratorField): void {
    LEVEL_FIELD_OF[field](level, undefined);
    this.persist(entry);
    this.refreshRow(entry, level);
  }

  /**
   * Re-roll one field from the level's seed — minting one first if the level
   * has none, since "regenerate from the seed" needs a seed to be an answer
   * rather than a coin flip.
   *
   * Goes through the pipeline's own `resolveConfig` rather than calling the
   * random helpers directly, so a field rolled here is byte-identical to what a
   * full generate would have rolled for the same seed. Re-implementing the
   * draws per cell is how the two would drift.
   */
  private rerollField(entry: MapEntry, level: LevelData, field: GeneratorField): void {
    if (level.randomSeed === undefined) level.randomSeed = mintSeed();
    const rolled = resolveConfig(
      level,
      { ix: entry.ix, ids: entry.ids, projected: entry.projected },
      level.randomSeed,
      true,
      this.config.bounds,
    );
    const value =
      field === "weights" ? serializeIngredientWeights(rolled.weights)
      : field === "dishes" ? serializeDishCountSequence(rolled.dishCounts)
      : field === "complexity" ? serializeCurve(rolled.complexity)
      : serializeCurve(rolled.baseShuffle);
    this.setField(entry, level, field, value);
  }

  /** Right-click on any generator cell: clear it, or roll it again. */
  private withFieldMenu(
    cell: HTMLElement,
    entry: MapEntry,
    level: LevelData,
    field: GeneratorField,
  ): HTMLElement {
    cell.addEventListener("contextmenu", (event) => {
      const items = [
        {
          label: "🎲 Regenerate from seed",
          onSelect: () => this.rerollField(entry, level, field),
        },
        {
          label: "✕ Clear",
          danger: true,
          onSelect: () => this.clearField(entry, level, field),
        },
      ];
      if (field === "weights") {
        // Only the weights have a second source of truth to be restored FROM —
        // the customer string says what the level actually orders.
        items.unshift({
          label: "↻ Rebuild from customers",
          onSelect: () => this.rebuildWeights(entry, level),
        });
      }
      showContextMenu(event, items, { title: `${FIELD_LABEL[field]} — ${level.name}` });
    });
    return cell;
  }

  private rebuildWeights(entry: MapEntry, level: LevelData): void {
    const counts = ingredientDistribution(level, entry.ix, entry.ids);
    if (counts.size === 0) {
      alert("This level has no readable customer orders to rebuild the weights from.");
      return;
    }
    level.ingredientWeights = serializeIngredientWeights(weightsFromDistribution(counts));
    this.persist(entry);
    this.refreshRow(entry, level);
  }

  /** Ingredient weights as icon+number tags that wrap to the column's width. */
  private weightsCell(entry: MapEntry, level: LevelData): HTMLElement {
    const weights = parseIngredientWeights(level.ingredientWeights ?? "");
    const wrap = el("div", { class: "lp-weights", title: "Click to edit the generator's ingredient weights" });

    if (weights.size === 0) {
      wrap.append(el("span", { class: "lp-blank" }, ["— not set —"]));
    } else {
      for (const [dataId, weight] of [...weights].sort((a, b) => b[1] - a[1])) {
        const def = entry.projected.map.cookedIngredients.find((c) => c.id === dataId);
        const tag = el("span", { class: "lp-weight-tag" }, [
          iconEl(
            def
              ? {
                  name: def.name,
                  emoji: def.icon,
                  fileId: def.fileId,
                  localImage: def.localImage,
                  imageURL: def.imageURL,
                }
              : undefined,
            { size: 18, className: "icon-ingredient" },
          ),
          el("span", {}, [String(weight)]),
        ]);
        tag.title = `${def?.name ?? `id ${dataId}`} — weight ${weight}`;
        wrap.append(tag);
      }
    }

    wrap.addEventListener("click", () => {
      const initial =
        weights.size > 0
          ? weights
          : new Map<Id, number>(
              entry.projected.map.cookedIngredients.map((c) => [c.id, DEFAULT_INGREDIENT_WEIGHT]),
            );
      // The weight grid resolves its icons through the global icon map, which
      // belongs to whichever map the app has open — borrow it for the map this
      // row belongs to. Icons are baked into elements at creation, so restoring
      // it right after the (synchronous) build leaves the dialog correct.
      this.borrowIconMap(entry, () =>
        openIngredientWeightsDialog(entry.projected.map, initial, (next) => {
          this.setField(entry, level, "weights", serializeIngredientWeights(next));
        }),
      );
    });
    return wrap;
  }

  private borrowIconMap(entry: MapEntry, build: () => void): void {
    this.hostIconMap ??= this.entries.find((e) => e.docId === this.deps.project.docId)?.projected.map ?? null;
    setIconMap(entry.projected.map);
    try {
      build();
    } finally {
      if (this.hostIconMap) setIconMap(this.hostIconMap);
    }
  }

  /**
   * The dish sequence as one tag per customer, wrapping to the column's width.
   *
   * It used to print the raw `0;0;1;2` string, which is unreadable past about
   * four customers and hides the two values that are not counts at all: -1 is a
   * Staff customer and 0 is "let the curve decide". Tags give each customer its
   * own box, so the shape of a level ("three light, then two heavy") is
   * visible, and the two special values get their own letter and colour instead
   * of looking like arithmetic.
   */
  private dishSequenceCell(entry: MapEntry, level: LevelData): HTMLElement {
    const raw = level.customerDishesSequence ?? "";
    const counts = parseDishCountSequence(raw);
    const wrap = el("div", { class: "lp-tags", title: "Click to edit the dish count per customer" });

    if (counts.length === 0) {
      wrap.append(el("span", { class: "lp-blank" }, ["— not set —"]));
    } else {
      counts.forEach((count, at) => {
        const kind = count === -1 ? " staff" : count === 0 ? " auto" : "";
        const tag = el("span", { class: `lp-count-tag${kind}` }, [
          count === -1 ? "S" : count === 0 ? "A" : String(count),
        ]);
        tag.title =
          count === -1
            ? `Customer ${at + 1} — Staff (clears a dirty stack, orders nothing)`
            : count === 0
              ? `Customer ${at + 1} — Auto (the complexity curve picks the dish count)`
              : `Customer ${at + 1} — ${count} dish(es)`;
        wrap.append(tag);
      });
    }

    wrap.addEventListener("click", () => {
      openDishSequenceDialog(
        level.name,
        counts,
        (next) => this.setField(entry, level, "dishes", serializeDishCountSequence(next)),
        () => this.clearField(entry, level, "dishes"),
      );
    });
    return wrap;
  }

  /**
   * The obstacle budget as icon+count tags.
   *
   * Not part of the clear/reroll menu the other generator cells share: an
   * obstacle budget is AUTHORED, never rolled, so "regenerate this from the
   * seed" would be an offer the pipeline cannot honour.
   */
  private obstacleCell(entry: MapEntry, level: LevelData): HTMLElement {
    const config = parseObstacles(level.obstacleData);
    const wrap = el("div", { class: "lp-tags", title: "Click to edit this level's obstacle budget" });
    const summary = obstacleSummary(config);

    if (summary.length === 0) {
      wrap.append(el("span", { class: "lp-blank" }, ["— none —"]));
    } else {
      for (const item of summary) {
        const tag = el("span", { class: "lp-count-tag obstacle" }, [`${item.icon}${item.count}`]);
        tag.title = `${item.label}: ${item.count}`;
        wrap.append(tag);
      }
    }

    wrap.addEventListener("click", () => {
      openObstacleBudgetDialog(level.name, config, (next) => {
        level.obstacleData = serializeObstacles(next);
        this.persist(entry);
        this.refreshRow(entry, level);
      });
    });
    return wrap;
  }

  private curveCell(
    curve: CurveState,
    title: string,
    onApply: (curve: CurveState) => void,
    onClear: () => void,
    unset: boolean,
  ): HTMLElement {
    const node = el("div", { class: `lp-curve${unset ? " unset" : ""}`, title: `${title} — click to edit` }, [
      curveThumb(curve),
    ]);
    node.addEventListener("click", () => openCurveDialog(title, curve, onApply, onClear));
    return node;
  }

  private seedCell(entry: MapEntry, level: LevelData): HTMLElement {
    const input = el("input", {
      type: "number",
      min: "0",
      step: "1",
      placeholder: "auto",
      value: level.randomSeed === undefined ? "" : String(level.randomSeed),
    }) as HTMLInputElement;
    input.title =
      "Pinned seed — drag left/right to walk through seeds, or type one. " +
      "Blank lets the generator pick one and write it back; a pinned seed is never replaced silently.";
    // Scrubbing a seed is how a designer shops for a level: drag, regenerate,
    // look, drag again. `allowEmpty` is what keeps clearing the field meaning
    // "let the generator pick" rather than "pin it to 0".
    makeScrubber(
      input,
      { min: 0, max: 0xffffffff, decimals: 0, allowEmpty: true },
      (value) => (level.randomSeed = value >>> 0),
      (value) => {
        if (value === null) delete level.randomSeed;
        else level.randomSeed = value >>> 0;
        this.persist(entry);
      },
    );
    return input;
  }

  private actionCell(entry: MapEntry, level: LevelData): HTMLElement {
    return el("div", { class: "lp-actions" }, [
      button("✨", () => this.openGenerateDialog(entry, level), {
        class: "small-btn",
        title: "Generate — opens the same dialog Design mode uses",
      }),
      button("✎", () => this.deps.onOpenDesign(entry.docId, level.id), {
        class: "small-btn",
        title: "Open in Design mode",
      }),
      button("🚦", () => void this.validateLevels([{ entry, level }]), {
        class: "small-btn",
        title: "Validate — playable, difficulty estimate and deadlock audit",
      }),
      button("▶", () => this.deps.onOpenPlay(entry.docId, level.id), {
        class: "small-btn",
        title: "Open in Play mode",
      }),
    ]);
  }

  private statusCell(entry: MapEntry, level: LevelData): HTMLElement {
    const status = entry.status.get(level.id) ?? emptyStatus();
    const list = el("div", { class: "lp-status" });
    if (status.errors.length === 0 && status.warnings.length === 0) {
      list.append(el("div", { class: "lp-status-ok" }, ["✓ ok"]));
    }
    for (const error of status.errors) list.append(el("div", { class: "lp-status-error" }, [`⛔ ${error}`]));
    for (const warning of status.warnings) list.append(el("div", { class: "lp-status-warn" }, [`⚠ ${warning}`]));
    if (status.estimate?.solvable) {
      list.append(
        el("div", { class: "lp-status-note" }, [
          `${status.estimate.totalPicks} picks · ${status.estimate.servedCount}/${status.estimate.totalCustomers} served`,
        ]),
      );
    }
    return list;
  }

  // ---------- small field helpers ----------

  private select(
    options: { id: string; name: string }[],
    value: string,
    apply: (value: string) => void,
  ): HTMLSelectElement {
    const select = el("select", {}) as HTMLSelectElement;
    // An unrecognised stored value is kept as its own option rather than
    // silently snapping to the first one — that snap is a data edit nobody asked for.
    const all = options.some((o) => o.id === value)
      ? options
      : [{ id: value, name: `${value || "(blank)"} (unknown)` }, ...options];
    for (const option of all) {
      const node = el("option", { value: option.id }, [option.name || "(blank)"]) as HTMLOptionElement;
      node.selected = option.id === value;
      select.append(node);
    }
    select.addEventListener("change", () => apply(select.value));
    return select;
  }

  private text(value: string, placeholder: string, apply: (value: string) => void): HTMLInputElement {
    const input = el("input", { type: "text", placeholder, value }) as HTMLInputElement;
    input.addEventListener("change", () => apply(input.value));
    return input;
  }

  // ---------- selection ----------

  private onSelectClick(entry: MapEntry, index: number, event: MouseEvent): void {
    const levels = entry.project.levels;
    if (event.shiftKey && this.anchor && this.anchor.docId === entry.docId) {
      const from = Math.min(this.anchor.index, index);
      const to = Math.max(this.anchor.index, index);
      for (let at = from; at <= to; at++) this.selected.add(this.key(entry, levels[at]));
    } else if (event.ctrlKey || event.metaKey) {
      const key = this.key(entry, levels[index]);
      if (!this.selected.delete(key)) this.selected.add(key);
      this.anchor = { docId: entry.docId, index };
    } else {
      this.selected.clear();
      this.selected.add(this.key(entry, levels[index]));
      this.anchor = { docId: entry.docId, index };
    }
    this.refreshSelectionClasses();
  }

  private refreshSelectionClasses(): void {
    for (const entry of this.entries) {
      for (const level of entry.project.levels) {
        const row = entry.host.querySelector<HTMLElement>(`.lp-row[data-level="${level.id}"]`);
        row?.classList.toggle("selected", this.selected.has(this.key(entry, level)));
      }
    }
  }

  /** Every selected level, or just the clicked one when it is not part of the selection. */
  private selectionOr(entry: MapEntry, level: LevelData): { entry: MapEntry; level: LevelData }[] {
    if (!this.selected.has(this.key(entry, level))) return [{ entry, level }];
    const out: { entry: MapEntry; level: LevelData }[] = [];
    for (const candidate of this.entries) {
      for (const candidateLevel of candidate.project.levels) {
        if (this.selected.has(this.key(candidate, candidateLevel))) {
          out.push({ entry: candidate, level: candidateLevel });
        }
      }
    }
    return out;
  }

  // ---------- row menu ----------

  private openRowMenu(entry: MapEntry, level: LevelData, index: number, event: MouseEvent): void {
    const targets = this.selectionOr(entry, level);
    const single = targets.length === 1;
    const levels = entry.project.levels;

    showContextMenu(
      event,
      [
        {
          label: "▲ Move up",
          disabled: !single || index === 0,
          onSelect: () => this.moveLevel(entry, index, index - 1),
        },
        {
          label: "▼ Move down",
          disabled: !single || index >= levels.length - 1,
          onSelect: () => this.moveLevel(entry, index, index + 1),
        },
        {
          label: "⧉ Duplicate",
          disabled: !single,
          separator: true,
          onSelect: () => this.duplicateLevel(entry, index),
        },
        {
          label: "✎ Go to Design",
          separator: true,
          onSelect: () => this.deps.onOpenDesign(entry.docId, level.id),
        },
        {
          label: "▶ Go to Play",
          onSelect: () => this.deps.onOpenPlay(entry.docId, level.id),
        },
        {
          label: `✨ Generate${single ? "" : ` (${targets.length})`}`,
          separator: true,
          onSelect: () =>
            single
              ? this.openGenerateDialog(entry, level)
              : void this.generateLevels(targets),
        },
        {
          label: `🚦 Validate${single ? "" : ` (${targets.length})`}`,
          onSelect: () => void this.validateLevels(targets),
        },
        {
          label: `🧹 Clear generator data${single ? "" : ` (${targets.length})`}`,
          separator: true,
          onSelect: () => this.clearGeneratorData(targets),
        },
        {
          label: `🗑 Delete${single ? "" : ` (${targets.length})`}`,
          danger: true,
          onSelect: () => this.deleteLevels(targets),
        },
      ],
      { title: `#${index + 1} · ${level.name}` },
    );
  }

  private moveLevel(entry: MapEntry, from: number, to: number): void {
    const levels = entry.project.levels;
    if (to < 0 || to >= levels.length) return;
    const [moved] = levels.splice(from, 1);
    levels.splice(to, 0, moved);
    this.persist(entry);
    this.renderMap(entry);
  }

  private duplicateLevel(entry: MapEntry, index: number): void {
    const levels = entry.project.levels;
    const source = levels[index];
    const nextId = levels.reduce((n, l) => Math.max(n, l.id), 0) + 1;
    const copy: LevelData = { ...structuredClone(source), id: nextId, name: `${source.name}_copy` };
    levels.splice(index + 1, 0, copy);
    entry.stats.set(copy.id, computeLevelStats(copy, entry.ix, entry.ids));
    entry.status.set(copy.id, this.initialStatus(entry, copy));
    this.persist(entry);
    this.refreshRanges();
    this.renderMap(entry);
  }

  private deleteLevels(targets: { entry: MapEntry; level: LevelData }[]): void {
    const names = targets.map((t) => t.level.name).join(", ");
    if (!confirm(`Delete ${targets.length} level(s)? (${names})`)) return;
    const touched = new Set<MapEntry>();
    for (const { entry, level } of targets) {
      const at = entry.project.levels.findIndex((l) => l.id === level.id);
      // A map must never end up with zero levels — every other view assumes one
      // exists (see nodeProject.blankLevel).
      if (at === -1 || entry.project.levels.length <= 1) continue;
      entry.project.levels.splice(at, 1);
      entry.stats.delete(level.id);
      entry.status.delete(level.id);
      // The id can be handed to a different level later, and a cached verdict
      // keyed on it would then describe the wrong one.
      forgetLevel(entry.docId, level.id);
      this.selected.delete(this.key(entry, level));
      touched.add(entry);
    }
    for (const entry of touched) {
      this.persist(entry);
      this.renderMap(entry);
    }
    this.refreshRanges();
  }

  // ---------- generate / validate ----------

  private promptBatchGenerate(entry: MapEntry): void {
    openBatchGenerateDialog(entry.title, entry.project.levels.length, (range) => {
      const targets: { entry: MapEntry; level: LevelData }[] = [];
      for (let position = range.from; position <= range.to; position++) {
        let level = entry.project.levels[position - 1];
        if (!level) {
          const nextId = entry.project.levels.reduce((n, l) => Math.max(n, l.id), 0) + 1;
          level = { ...blankLevel(entry.project.doc, nextId), name: `${entry.project.doc.map.id}_${position}` };
          entry.project.levels.push(level);
        }
        targets.push({ entry, level });
      }
      this.persist(entry);
      // The dialog's own Generate button IS the confirmation for this path, so
      // the batch run does not ask a second time.
      void this.generateLevels(targets, range.reroll, true);
    });
  }

  /**
   * One level: the same dialog Design mode opens.
   *
   * A single Generate is a considered act — the designer wants to see the
   * weights and curves it will run with, and usually to change one of them
   * first. Only a MULTI-level run skips the dialog, because there is no one set
   * of inputs to show for forty levels that each carry their own.
   */
  private openGenerateDialog(entry: MapEntry, level: LevelData): void {
    this.borrowIconMap(entry, () =>
      openNodeGenerateDialog({
        ix: entry.ix,
        ids: entry.ids,
        projected: entry.projected,
        level,
        currentCustomers: () => {
          try {
            return parseNodeCustomers(level.customerString);
          } catch {
            // A level whose customers cannot be read is exactly one worth
            // regenerating; the dialog only uses this to seed its dish counts
            // and to decide whether to warn about overwriting.
            return [];
          }
        },
        scenario: this.scenario,
        onGenerated: (result) => {
          this.applyGenerated(entry, level, result);
          this.persist(entry);
          this.renderMap(entry);
        },
      }),
    );
  }

  /** Fold one pipeline result into the row's status, statistics and the shared cache. */
  private applyGenerated(entry: MapEntry, level: LevelData, result: GenerateLevelResult): void {
    // The pipeline reports its own compromises (a lowered shuffle ceiling, an
    // unplaceable spare piece) as warnings, so the row shows them without this
    // having to re-derive anything it already knows.
    entry.status.set(level.id, {
      ok: result.ok && result.warnings.length === 0,
      errors: [...result.errors],
      warnings: [...result.warnings],
      estimate: result.estimate,
    });
    // The verifying estimate was computed against exactly the strings that were
    // just written, so Design mode can open this level with its difficulty bar
    // already filled in rather than re-solving it.
    if (result.ok && result.estimate) {
      cacheEstimate(
        entry.docId,
        level.id,
        levelSignature(level),
        scenarioSignature(this.scenario),
        result.estimate,
      );
    }
    this.restat(entry, level);
  }

  /**
   * Runs the pipeline over a list of levels, one at a time with a yield in
   * between so the overlay stays live. Each level's outcome lands in its own
   * Status cell rather than in one alert — a batch of forty is exactly the case
   * where a modal per failure is unusable.
   */
  private async generateLevels(
    targets: { entry: MapEntry; level: LevelData }[],
    reroll = false,
    preconfirmed = false,
  ): Promise<void> {
    if (targets.length === 0) return;
    // Generating overwrites a level's customers and queue outright, and a
    // multi-level run has no dialog standing between the click and that. Ask.
    if (!preconfirmed && targets.length > 1) {
      const names = targets.slice(0, 6).map((t) => t.level.name).join(", ");
      const more = targets.length > 6 ? `, +${targets.length - 6} more` : "";
      if (!confirm(`Regenerate ${targets.length} levels? This replaces their customers and queues.\n\n${names}${more}`)) {
        return;
      }
    }

    showBlockingOverlay(`Generating ${targets.length} level(s)…`);
    await breathe();

    const touched = new Set<MapEntry>();
    let done = 0;
    for (const { entry, level } of targets) {
      showBlockingOverlay(`Generating ${++done}/${targets.length} — ${level.name}`);
      await breathe();

      const result = generateLevel(
        level,
        { ix: entry.ix, ids: entry.ids, projected: entry.projected, scenario: this.scenario },
        { rerollConfig: reroll, bounds: this.config.bounds },
      );
      this.applyGenerated(entry, level, result);
      touched.add(entry);
    }

    for (const entry of touched) {
      this.persist(entry);
      this.renderMap(entry);
    }
    hideBlockingOverlay();
  }

  private async validateAll(entry: MapEntry): Promise<void> {
    await this.validateLevels(entry.project.levels.map((level) => ({ entry, level })));
  }

  private async validateLevels(targets: { entry: MapEntry; level: LevelData }[]): Promise<void> {
    if (targets.length === 0) return;
    showBlockingOverlay(`Validating ${targets.length} level(s)…`);
    await breathe();

    const scenarioKey = scenarioSignature(this.scenario);
    const touched = new Set<MapEntry>();
    let done = 0;
    for (const { entry, level } of targets) {
      showBlockingOverlay(`Validating ${++done}/${targets.length} — ${level.name}`);
      await breathe();

      const signature = levelSignature(level);
      // A level nobody has touched since its last Validate has the same answer
      // it had then — including one Design mode may have produced. Re-running
      // the three audits to reprint the same verdict is the single biggest
      // avoidable cost in a Validate All over a whole map.
      const cached = cachedStatus(entry.docId, level.id, signature, scenarioKey);
      const status =
        cached ??
        validateLevel(level, entry.ix, {
          scenario: this.scenario,
          // Reuse whatever solve already exists for this exact level, whether
          // it came from a generate run here or an estimate in Design mode.
          estimate: cachedEstimate(entry.docId, level.id, signature, scenarioKey),
        });
      if (!cached) cacheStatus(entry.docId, level.id, signature, scenarioKey, status);
      entry.status.set(level.id, status);
      touched.add(entry);
    }

    for (const entry of touched) this.renderMap(entry);
    hideBlockingOverlay();
  }
}

// ---------- the read-only curve thumbnail ----------

const THUMB_W = 96;
const THUMB_H = 34;

/**
 * A tiny read-only plot of a curve, sampled rather than drawn from the Bezier
 * control points: the cell is 96px wide, so 24 samples is already smoother than
 * the pixels can show, and sampling means this cannot drift from what
 * `evaluateCurve` — the thing the generator actually reads — returns.
 */
function curveThumb(curve: CurveState): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${THUMB_W} ${THUMB_H}`);
  svg.setAttribute("class", "lp-curve-svg");
  svg.setAttribute("preserveAspectRatio", "none");

  const { minX, maxX, minY, maxY } = curve.range;
  const spanY = maxY - minY || 1;
  const samples = 24;
  const points: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const y = evaluateCurve(curve, minX + t * (maxX - minX));
    const py = THUMB_H - ((y - minY) / spanY) * THUMB_H;
    points.push(`${(t * THUMB_W).toFixed(1)},${py.toFixed(1)}`);
  }

  const path = document.createElementNS(ns, "polyline");
  path.setAttribute("points", points.join(" "));
  path.setAttribute("class", "lp-curve-line");
  svg.append(path);

  const label = document.createElementNS(ns, "text");
  label.setAttribute("x", "2");
  label.setAttribute("y", "10");
  label.setAttribute("class", "lp-curve-label");
  label.textContent = `${minY}–${maxY}`;
  svg.append(label);
  return svg;
}

