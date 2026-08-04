// Design mode: one scrolling page, Customer → Grid → Queue top-to-bottom.
// Each section owns its own draft, history, unsaved badge and Save button.
// See docs/ToolDesign.md "Page Layout".

import {
  parseCustomers,
  parseGrid,
  parseQueueGroups,
  parseQueues,
  serializeCustomers,
  serializeGrid,
  serializeQueues,
} from "../../core/parser.ts";
import type {
  CustomerConfig,
  ElementDef,
  GlobalDefs,
  GridCellConfig,
  ParamDef,
} from "../../core/types.ts";
import type { LevelData, MapData } from "../../data/mapLoader.ts";
import { toMapDef } from "../../data/mapLoader.ts";
import { TAGS, WEATHER } from "../../data/configLoader.ts";
import { validateMap } from "../../data/validate.ts";
import { writeRowToSheet } from "../../data/sheetWrite.ts";
import { button, el } from "../dom.ts";
import { cellIconEl, ingredientIconEl, statusIconEl } from "../icon.ts";
import type { Section } from "./section.ts";
import { createCustomerSection } from "./customerSection.ts";
import { createGridSection, resizeGridString } from "./gridSection.ts";
import { createQueueSection, toCoordGroups, toQueueDraft } from "./queueSection.ts";
import type { QueueDraft } from "./queueSection.ts";
import { tableEditor } from "./tableEditor.ts";

export class DesignView {
  private root: HTMLElement;
  private map: MapData;
  private defs: GlobalDefs;
  private onChange: () => void;
  /** Reports every level switch (picker, +Level, delete-then-fallback) so the app shell can carry the selection over into Play mode — see main.ts. */
  private onLevelChange?: (levelId: number) => void;
  private level!: LevelData;

  private customers!: Section<CustomerConfig[]>;
  private grid!: Section<GridCellConfig[]>;
  private queues!: Section<QueueDraft>;
  private warningsEl = el("div", { class: "warnings" });

  // ---------- combined "Write all to sheet" (level bar) ----------
  private levelWriteStatusEl: HTMLElement | null = null;
  private levelWriteSnapshot: {
    levelId: number;
    weather: string;
    tag: string;
    unlock: string;
    customer: string;
    grid: string;
    queue: string;
  } | null = null;
  private levelWriteError: string | null = null;
  private levelWriting = false;

  constructor(
    root: HTMLElement,
    map: MapData,
    defs: GlobalDefs,
    onChange: () => void,
    initialLevelId?: number,
    onLevelChange?: (levelId: number) => void,
  ) {
    this.root = root;
    this.map = map;
    this.defs = defs;
    this.onChange = onChange;
    this.onLevelChange = onLevelChange;
    this.level = map.levels.find((l) => l.id === initialLevelId) ?? map.levels[0];
    this.build();
  }

  /** True when any section has unsaved edits (drives the level-switch guard). */
  get isDirty(): boolean {
    return this.customers.isDirty || this.grid.isDirty || this.queues.isDirty;
  }

  selectLevel(levelId: number): void {
    if (this.isDirty && !confirm("Unsaved changes will be lost. Switch level anyway?")) return;
    const next = this.map.levels.find((l) => l.id === levelId);
    if (!next) return;
    this.level = next;
    this.customers.reset(parseCustomers(next.customerString));
    this.grid.reset(parseGrid(next.gridString));
    this.queues.reset(
      toQueueDraft({ queues: parseQueues(next.queueString), groups: parseQueueGroups(next.queueString) }),
    );
    // A different level's drafts have nothing to do with what was last
    // written to the sheet for the previous level.
    this.levelWriteSnapshot = null;
    this.levelWriteError = null;
    this.refreshWarnings();
    this.build();
    this.onLevelChange?.(levelId);
  }

  private build(): void {
    const parsedMap = toMapDef(this.map);
    const saved = () => {
      this.onChange();
      this.refreshWarnings();
    };

    // The queue's Recipe Pieces foldout reads the other two drafts, so their
    // commits re-render it. Every section's commits also keep the level
    // bar's combined write-status readout (does this draft still match what
    // was last written?) current.
    const refreshQueueReadout = () => this.queues?.render();
    const refreshLevelWrite = () => this.refreshLevelWriteStatus();

    this.customers = createCustomerSection({
      map: parsedMap,
      defs: this.defs,
      level: this.level,
      parse: () => parseCustomers(this.level.customerString),
      onSaved: saved,
      onCommit: () => {
        refreshQueueReadout();
        refreshLevelWrite();
      },
    });
    this.grid = createGridSection({
      map: parsedMap,
      defs: this.defs,
      level: this.level,
      parse: () => parseGrid(this.level.gridString),
      onSaved: saved,
      onCommit: () => {
        refreshQueueReadout();
        refreshLevelWrite();
      },
    });
    this.queues = createQueueSection({
      map: parsedMap,
      defs: this.defs,
      level: this.level,
      parse: () => ({
        queues: parseQueues(this.level.queueString),
        groups: parseQueueGroups(this.level.queueString),
      }),
      currentCustomers: () => this.customers.draft,
      currentGrid: () => this.grid.draft,
      onSaved: saved,
      onCommit: refreshLevelWrite,
    });

    this.root.replaceChildren(
      this.mapSettingsBar(),
      this.levelBar(),
      this.warningsEl,
      // Customer on top, grid in the middle, queues on the bottom.
      this.customers.element,
      this.grid.element,
      this.queues.element,
    );
    this.refreshWarnings();
  }

  /**
   * Grid Cols/Rows and dirty-stack height are fixed per map, not per level —
   * one edit here applies to every level at once (see docs request: "no need
   * to config for each level").
   */
  private mapSettingsBar(): HTMLElement {
    const dimField = (
      label: string,
      value: number,
      apply: (v: number) => void,
    ) => {
      const input = el("input", {
        type: "number",
        value: String(value),
        min: "1",
      }) as HTMLInputElement;
      input.addEventListener("change", () => {
        apply(Math.max(1, Number(input.value) || 1));
        for (const level of this.map.levels) {
          level.gridString = resizeGridString(
            level.gridString,
            this.map.gridWidth,
            this.map.gridHeight,
          );
        }
        this.onChange();
        this.build(); // grid section must re-parse every level's resized string
      });
      return el("label", { class: "field small" }, [label, input]);
    };

    const stackInput = el("input", {
      type: "number",
      value: String(this.map.dirtyStackHeight),
      min: "1",
    }) as HTMLInputElement;
    stackInput.addEventListener("change", () => {
      this.map.dirtyStackHeight = Math.max(1, Number(stackInput.value) || 1);
      this.onChange();
    });

    const visibleRowsInput = el("input", {
      type: "number",
      value: String(this.map.visibleRows),
      min: "1",
    }) as HTMLInputElement;
    visibleRowsInput.title = "Queue rows Play mode shows: 1 interactable front row + the rest as preview.";
    visibleRowsInput.addEventListener("change", () => {
      this.map.visibleRows = Math.max(1, Number(visibleRowsInput.value) || 1);
      this.onChange();
    });

    return el("div", { class: "level-bar map-settings" }, [
      el("strong", { class: "map-settings-label" }, [`Map: ${this.map.name}`]),
      dimField("Grid Cols", this.map.gridWidth, (v) => (this.map.gridWidth = v)),
      dimField("Grid Rows", this.map.gridHeight, (v) => (this.map.gridHeight = v)),
      el("label", { class: "field small" }, ["Dirty stack", stackInput]),
      el("label", { class: "field small" }, ["Visible rows", visibleRowsInput]),
      el("small", { class: "muted" }, ["Applies to every level in this map"]),
    ]);
  }

  private levelBar(): HTMLElement {
    const picker = el("select", { class: "level-picker" }) as HTMLSelectElement;
    for (const l of this.map.levels) {
      const opt = el("option", { value: String(l.id) }, [
        `${l.name}${l.levelTag ? ` (${l.levelTag})` : ""}`,
      ]);
      if (l.id === this.level.id) (opt as HTMLOptionElement).selected = true;
      picker.append(opt);
    }
    picker.addEventListener("change", () => this.selectLevel(Number(picker.value)));

    const metaField = (
      label: string,
      value: string | number,
      type: string,
      apply: (v: string) => void,
    ) => {
      const input = el("input", { value: String(value), type }) as HTMLInputElement;
      input.addEventListener("change", () => {
        apply(input.value);
        this.onChange();
        this.refreshLevelWriteStatus();
      });
      return el("label", { class: "field small" }, [label, input]);
    };

    // Weather/Tag are fixed enums loaded from general/weather.json and
    // general/tags.json; the current value is added as an extra option if
    // it's somehow not one of the known ones, so old/unexpected data never
    // gets silently clobbered by picking a select option.
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
        this.refreshLevelWriteStatus();
      });
      return el("label", { class: "field small" }, [label, select]);
    };

    this.levelWriteStatusEl = el("span", { class: "write-status" });
    this.refreshLevelWriteStatus();

    return el("div", { class: "level-bar" }, [
      el("label", { class: "field small" }, ["Level", picker]),
      selectField("Weather", WEATHER.map((w) => ({ id: w.id, name: w.id })), this.level.weather, (v) => (this.level.weather = v)),
      selectField("Tag", TAGS, this.level.levelTag, (v) => (this.level.levelTag = v)),
      metaField("Unlock", this.level.featureUnlock, "text", (v) => (this.level.featureUnlock = v)),
      metaField("Serve slots", this.level.serveableSlots, "number", (v) =>
        (this.level.serveableSlots = Math.max(1, Number(v) || 1)),
      ),
      el("span", { class: "spacer" }),
      this.levelWriteStatusEl,
      button("⇪ Write all to sheet", () => void this.writeLevelAll(), {
        title: "Write this level's customer/grid/queue strings to the sheet in one row",
      }),
      button("+ Level", () => this.addLevel()),
      button("🗑 Level", () => this.deleteLevel(), { class: "danger" }),
      button("Definitions…", () => this.openDefinitions()),
    ]);
  }

  /** Writes all three sections' live drafts to the sheet together, in one row. */
  private async writeLevelAll(): Promise<void> {
    if (this.levelWriting) return;
    this.levelWriting = true;
    this.levelWriteError = null;
    this.refreshLevelWriteStatus();
    try {
      const customer = serializeCustomers(this.customers.draft);
      const grid = serializeGrid(this.grid.draft);
      const queue = serializeQueues(this.queues.draft.queues, toCoordGroups(this.queues.draft));
      await writeRowToSheet(
        {
          mapIndex: this.map.id,
          levelIndex: this.level.id,
          weather: this.level.weather,
          tag: this.level.levelTag,
          unlock: this.level.featureUnlock,
        },
        { customerSequence: customer, grid, ingredientQueue: queue },
      );
      this.levelWriteSnapshot = {
        levelId: this.level.id,
        weather: this.level.weather,
        tag: this.level.levelTag,
        unlock: this.level.featureUnlock,
        customer,
        grid,
        queue,
      };
    } catch (err) {
      console.error(err);
      this.levelWriteError = (err as Error).message;
    } finally {
      this.levelWriting = false;
      this.refreshLevelWriteStatus();
    }
  }

  private refreshLevelWriteStatus(): void {
    const statusEl = this.levelWriteStatusEl;
    if (!statusEl) return;
    if (this.levelWriting) {
      statusEl.textContent = "⏳ Writing…";
      statusEl.className = "write-status pending";
      return;
    }
    if (this.levelWriteError) {
      statusEl.textContent = `✗ ${this.levelWriteError}`;
      statusEl.className = "write-status failed";
      statusEl.title = this.levelWriteError;
      return;
    }
    const snap = this.levelWriteSnapshot;
    statusEl.removeAttribute("title");
    if (!snap || snap.levelId !== this.level.id) {
      statusEl.textContent = "";
      statusEl.className = "write-status";
      return;
    }
    const upToDate =
      snap.weather === this.level.weather &&
      snap.tag === this.level.levelTag &&
      snap.unlock === this.level.featureUnlock &&
      snap.customer === serializeCustomers(this.customers.draft) &&
      snap.grid === serializeGrid(this.grid.draft) &&
      snap.queue === serializeQueues(this.queues.draft.queues, toCoordGroups(this.queues.draft));
    statusEl.textContent = upToDate ? "✓ Level written" : "● Changed since write";
    statusEl.className = `write-status ${upToDate ? "ok" : "stale"}`;
  }

  private addLevel(): void {
    const id = Math.max(0, ...this.map.levels.map((l) => l.id)) + 1;
    const blankGrid = Array(this.map.gridWidth * this.map.gridHeight).fill("").join(",");
    this.map.levels.push({
      id,
      name: `${this.map.id}_${id}`,
      weather: "Normal",
      levelTag: "",
      featureUnlock: "",
      serveableSlots: 2,
      shuffleDistance: 0,
      queueString: "0,1%0,1%0,1",
      gridString: blankGrid,
      customerString: "0;0;0.1",
    });
    this.onChange();
    this.selectLevel(id);
  }

  private deleteLevel(): void {
    if (this.map.levels.length <= 1) return;
    if (!confirm(`Delete level ${this.level.name}?`)) return;
    this.map.levels.splice(this.map.levels.indexOf(this.level), 1);
    this.onChange();
    this.selectLevel(this.map.levels[0].id);
  }

  private refreshWarnings(): void {
    const warnings = validateMap(this.map).filter((w) => w.levelName === this.level.name);
    this.warningsEl.replaceChildren();
    this.warningsEl.classList.toggle("ok", warnings.length === 0);
    if (warnings.length === 0) {
      this.warningsEl.append("✓ No warnings for this level");
      return;
    }
    this.warningsEl.append(el("strong", {}, [`⚠ ${warnings.length} warning(s)`]));
    for (const w of warnings) this.warningsEl.append(el("div", {}, [w.message]));
  }

  /**
   * "Enabled" checkbox for a raw/cooked ingredient row: unticking adds its id
   * to the given disabled-id list on the map. Play mode strips disabled ids
   * from queues/orders before the level starts; Design mode (here) keeps
   * showing and editing the row normally either way.
   */
  private enabledToggle(id: number, disabledIds: number[]): HTMLElement {
    const checkbox = el("input", { type: "checkbox" }) as HTMLInputElement;
    checkbox.checked = !disabledIds.includes(id);
    checkbox.title = "Unchecked = skipped by Play mode (queues and orders)";
    checkbox.addEventListener("change", () => {
      const at = disabledIds.indexOf(id);
      if (checkbox.checked && at !== -1) disabledIds.splice(at, 1);
      else if (!checkbox.checked && at === -1) disabledIds.push(id);
      this.onChange();
    });
    return el("label", { class: "enabled-toggle" }, [checkbox, "Enabled"]);
  }

  // ---------- definitions overlay ----------

  private openDefinitions(): void {
    const panel = el("div", { class: "definitions-panel" });
    const close = () => overlay.remove();
    const overlay = el("div", { class: "overlay-panel" }, [
      el("div", { class: "definitions-head" }, [
        el("h2", {}, ["Definitions"]),
        button("✕ Close", close, { class: "primary" }),
      ]),
      panel,
    ]);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    const touch = () => this.onChange();
    const defTable = (title: string, rows: ElementDef[], iconFor: (id: number) => HTMLElement) =>
      tableEditor<ElementDef>({
        title,
        rows,
        columns: [
          { key: "id", label: "ID", type: "number", width: "4rem", get: (r) => String(r.id), set: (r, v) => (r.id = Number(v)) },
          { key: "icon", label: "Icon", width: "4rem", get: () => "", set: () => {} },
          { key: "name", label: "Name", get: (r) => r.name, set: (r, v) => (r.name = v) },
          { key: "description", label: "Description", get: (r) => r.description, set: (r, v) => (r.description = v) },
        ],
        makeRow: (rows) => ({
          id: Math.max(-1, ...rows.map((r) => r.id)) + 1,
          name: "New",
          icon: "",
          description: "",
          paramDefs: [],
        }),
        onChange: touch,
        subEditor: (row, changed) =>
          el("div", { class: "def-sub" }, [iconFor(row.id), paramDefEditor(row.paramDefs, changed)]),
      });

    panel.append(
      defTable("Effects (ingredient statuses)", this.defs.effects, (id) => statusIconEl(id, 64)),
      defTable("Grid cell types", this.defs.cellTypes, (id) => cellIconEl(id, 64)),
      defTable("Customer types", this.defs.customerTypes, () => el("span", {}, [""])),
      tableEditor({
        title: `Raw ingredients — ${this.map.name}`,
        rows: this.map.rawIngredients,
        columns: [
          { key: "id", label: "ID", type: "number", width: "4rem", get: (r) => String(r.id), set: (r, v) => (r.id = Number(v)) },
          { key: "name", label: "Name", get: (r) => r.name, set: (r, v) => (r.name = v) },
          { key: "code", label: "Code", get: (r) => r.code, set: (r, v) => (r.code = v) },
          { key: "price", label: "Price", type: "number", width: "5rem", get: (r) => String(r.price), set: (r, v) => (r.price = Number(v)) },
          { key: "numSlices", label: "Slices", type: "number", width: "5rem", get: (r) => String(r.numSlices), set: (r, v) => (r.numSlices = Number(v)) },
        ],
        makeRow: (rows) => ({
          id: Math.max(-1, ...rows.map((r) => r.id)) + 1,
          name: "New",
          icon: "",
          code: "",
          price: 0,
          numSlices: 1,
        }),
        onChange: touch,
        subEditor: (row) =>
          el("div", { class: "def-sub" }, [
            ingredientIconEl(row.id, 64),
            this.enabledToggle(row.id, this.map.disabledRawIds),
          ]),
      }),
      tableEditor({
        title: `Cooked ingredients — ${this.map.name}`,
        rows: this.map.cookedIngredients,
        columns: [
          { key: "id", label: "ID", type: "number", width: "4rem", get: (r) => String(r.id), set: (r, v) => (r.id = Number(v)) },
          { key: "name", label: "Name", get: (r) => r.name, set: (r, v) => (r.name = v) },
          { key: "icon", label: "Emoji", width: "5rem", get: (r) => r.icon, set: (r, v) => (r.icon = v) },
        ],
        makeRow: (rows) => ({
          id: Math.max(-1, ...rows.map((r) => r.id)) + 1,
          name: "New",
          icon: "",
        }),
        onChange: touch,
        subEditor: (row) =>
          el("div", { class: "def-sub" }, [this.enabledToggle(row.id, this.map.disabledCookedIds)]),
      }),
      tableEditor({
        title: `Cooking tools — ${this.map.name}`,
        rows: this.map.tools,
        columns: [
          { key: "id", label: "ID", type: "number", width: "4rem", get: (r) => String(r.id), set: (r, v) => (r.id = Number(v)) },
          { key: "name", label: "Name", get: (r) => r.name, set: (r, v) => (r.name = v) },
          { key: "icon", label: "Emoji", width: "5rem", get: (r) => r.icon ?? "", set: (r, v) => (r.icon = v) },
          { key: "numSlots", label: "Slots", type: "number", width: "5rem", get: (r) => String(r.numSlots), set: (r, v) => (r.numSlots = Math.max(1, Number(v) || 1)) },
          { key: "cookingTime", label: "Time s", type: "number", width: "5rem", get: (r) => String(r.cookingTime), set: (r, v) => (r.cookingTime = Number(v)) },
          {
            key: "recipes",
            label: "Recipes (in>out xN, ; separated)",
            get: (r) => r.recipes.map((x) => `${x.in}>${x.out}x${x.amount}`).join("; "),
            set: (r, v) => {
              r.recipes = v
                .split(";")
                .map((part) => part.trim())
                .filter(Boolean)
                .map((part) => {
                  const m = /^(\d+)\s*>\s*(\d+)\s*x\s*(\d+)$/.exec(part);
                  return m
                    ? { in: Number(m[1]), out: Number(m[2]), amount: Number(m[3]) }
                    : null;
                })
                .filter((x): x is { in: number; out: number; amount: number } => x !== null);
            },
          },
        ],
        makeRow: (rows) => ({
          id: Math.max(-1, ...rows.map((r) => r.id)) + 1,
          name: "New tool",
          icon: "🍳",
          numSlots: 1,
          cookingTime: 1,
          recipes: [],
        }),
        onChange: touch,
      }),
    );
    document.body.append(overlay);
  }
}

function paramDefEditor(paramDefs: ParamDef[], changed: () => void): HTMLElement {
  const wrap = el("div", { class: "param-defs" }, [el("small", {}, ["Params: "])]);
  paramDefs.forEach((p, i) => {
    wrap.append(
      el("span", { class: "chip" }, [`${p.name}:${p.dataType}`]),
      button("✕", () => {
        paramDefs.splice(i, 1);
        changed();
      }, { class: "icon-btn" }),
    );
  });
  wrap.append(
    button("+ param", () => {
      const name = prompt("Param name", "value");
      if (!name) return;
      const dataType = (prompt("Data type (int/float/string/bool)", "int") ??
        "int") as ParamDef["dataType"];
      paramDefs.push({ name, dataType });
      changed();
    }, { class: "small-btn" }),
  );
  return wrap;
}
