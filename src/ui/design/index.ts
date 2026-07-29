// Design mode: one scrolling page, Customer → Grid → Queue top-to-bottom.
// Each section owns its own draft, history, unsaved badge and Save button.
// See docs/ToolDesign.md "Page Layout".

import { parseCustomers, parseGrid, parseQueues } from "../../core/parser.ts";
import type {
  CustomerConfig,
  ElementDef,
  GlobalDefs,
  GridCellConfig,
  ParamDef,
  QueueItem,
} from "../../core/types.ts";
import type { LevelData, MapData } from "../../data/mapLoader.ts";
import { toMapDef } from "../../data/mapLoader.ts";
import { validateMap } from "../../data/validate.ts";
import { button, el } from "../dom.ts";
import { cellIconEl, ingredientIconEl, statusIconEl } from "../icon.ts";
import type { Section } from "./section.ts";
import { createCustomerSection } from "./customerSection.ts";
import { createGridSection } from "./gridSection.ts";
import { createQueueSection } from "./queueSection.ts";
import { tableEditor } from "./tableEditor.ts";

export class DesignView {
  private root: HTMLElement;
  private map: MapData;
  private defs: GlobalDefs;
  private onChange: () => void;
  private level!: LevelData;

  private customers!: Section<CustomerConfig[]>;
  private grid!: Section<GridCellConfig[]>;
  private queues!: Section<QueueItem[][]>;
  private warningsEl = el("div", { class: "warnings" });

  constructor(root: HTMLElement, map: MapData, defs: GlobalDefs, onChange: () => void) {
    this.root = root;
    this.map = map;
    this.defs = defs;
    this.onChange = onChange;
    this.level = map.levels[0];
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
    this.queues.reset(parseQueues(next.queueString));
    this.refreshWarnings();
    this.build();
  }

  private build(): void {
    const parsedMap = toMapDef(this.map);
    const saved = () => {
      this.onChange();
      this.refreshWarnings();
    };

    // The queue's Recipe Pieces foldout reads the other two drafts, so their
    // commits re-render it.
    const refreshQueueReadout = () => this.queues?.render();

    this.customers = createCustomerSection({
      map: parsedMap,
      defs: this.defs,
      level: this.level,
      parse: () => parseCustomers(this.level.customerString),
      onSaved: saved,
      onCommit: refreshQueueReadout,
    });
    this.grid = createGridSection({
      map: parsedMap,
      defs: this.defs,
      level: this.level,
      parse: () => parseGrid(this.level.gridString),
      onSaved: saved,
      onCommit: refreshQueueReadout,
    });
    this.queues = createQueueSection({
      map: parsedMap,
      defs: this.defs,
      level: this.level,
      parse: () => parseQueues(this.level.queueString),
      currentCustomers: () => this.customers.draft,
      currentGrid: () => this.grid.draft,
      onSaved: saved,
    });

    this.root.replaceChildren(
      this.levelBar(),
      this.warningsEl,
      // Customer on top, grid in the middle, queues on the bottom.
      this.customers.element,
      this.grid.element,
      this.queues.element,
    );
    this.refreshWarnings();
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
      });
      return el("label", { class: "field small" }, [label, input]);
    };

    return el("div", { class: "level-bar" }, [
      el("label", { class: "field small" }, ["Level", picker]),
      metaField("Weather", this.level.weather, "text", (v) => (this.level.weather = v)),
      metaField("Tag", this.level.levelTag, "text", (v) => (this.level.levelTag = v)),
      metaField("Unlock", this.level.featureUnlock, "text", (v) => (this.level.featureUnlock = v)),
      metaField("Serve slots", this.level.serveableSlots, "number", (v) =>
        (this.level.serveableSlots = Math.max(1, Number(v) || 1)),
      ),
      metaField("Dirty stack", this.level.dirtyStackHeight, "number", (v) =>
        (this.level.dirtyStackHeight = Math.max(1, Number(v) || 1)),
      ),
      el("span", { class: "spacer" }),
      button("+ Level", () => this.addLevel()),
      button("🗑 Level", () => this.deleteLevel(), { class: "danger" }),
      button("Definitions…", () => this.openDefinitions()),
    ]);
  }

  private addLevel(): void {
    const id = Math.max(0, ...this.map.levels.map((l) => l.id)) + 1;
    this.map.levels.push({
      id,
      name: `${this.map.id}_${id}`,
      weather: "Normal",
      levelTag: "",
      featureUnlock: "",
      gridWidth: 5,
      gridHeight: 2,
      serveableSlots: 2,
      dirtyStackHeight: 5,
      shuffleDistance: 0,
      queueString: "0,1%0,1%0,1",
      gridString: ",,,,,,,,,",
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
        subEditor: (row) => el("div", { class: "def-sub" }, [ingredientIconEl(row.id, 64)]),
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
