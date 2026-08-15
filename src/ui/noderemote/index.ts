// "Remote Data" for the node-graph system.
//
// Same spreadsheet as the legacy tab, a DIFFERENT sheet tab and its own column
// mapping — see data/config/general/node-remote-sheet-columns.json. That
// separation is not cosmetic: node level strings speak the graph's id space and
// a bracket dish grammar the legacy tool cannot parse, so pointing both tabs at
// one sheet tab would let either system silently overwrite the other's data
// with strings it can't read back.
//
// Everything below the view is reused UNCHANGED — `fetchLevelProgressRows`,
// `batchUpdateCells` and `googleAuth` all take the tab name and column map as
// parameters, so only the view is forked. It is much smaller than the legacy
// one because the node level fields are the same seven strings.
//
// Fold state lives at module scope so it survives a mode switch, under a
// DISTINCT key prefix — the legacy view uses `map_config_…`, and sharing that
// namespace would make the two tabs fight over which levels are open.

import { requestAccessTokenInteractive } from "../../data/googleAuth.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import nodeColumnsJson from "../../data/config/general/node-remote-sheet-columns.json";
import type { NodeProjectState } from "../../data/nodeProject.ts";
import {
  columnLetter,
  fetchLevelProgressRows,
  letterToColumn,
  REMOTE_LEVEL_FIELDS,
  SheetAuthRequiredError,
  SheetPermissionError,
} from "../../data/sheetSource.ts";
import type { LevelSheetRow, RemoteSheetColumns } from "../../data/sheetSource.ts";
import { batchUpdateCells } from "../../data/sheetWrite.ts";
import type { CellUpdate } from "../../data/sheetWrite.ts";
import { button, el } from "../dom.ts";
import { showSheetPermissionDialog } from "../sheetPermissionDialog.ts";

type FieldKey = keyof RemoteSheetColumns;

const NODE_SHEET_COLUMNS: RemoteSheetColumns = nodeColumnsJson.columns;
const NODE_SHEET_DEFAULT_TAB: string = nodeColumnsJson.tabName;

/** Distinct from the legacy view's `map_config_…` prefix — see the header note. */
const foldKey = (levelId: number) => `node_lv_${levelId}`;
const openLevels = new Set<string>();

/** Survives this view being rebuilt on every mode switch. */
let cachedRows: Map<string, LevelSheetRow> | null = null;
let cachedTab = "";

export class NodeRemoteDataView {
  private root: HTMLElement;
  private project: NodeProjectState;
  private getSheetId: () => string;
  private setSheetId: (id: string) => void;
  private onLevelChanged: () => void;
  private onOpenInDesign: (levelId: number) => void;

  private tabName = NODE_SHEET_DEFAULT_TAB;
  private columns: RemoteSheetColumns = { ...NODE_SHEET_COLUMNS };
  private status = "Not loaded.";
  private busy = false;

  constructor(
    root: HTMLElement,
    project: NodeProjectState,
    getSheetId: () => string,
    setSheetId: (id: string) => void,
    onLevelChanged: () => void,
    onOpenInDesign: (levelId: number) => void,
  ) {
    this.root = root;
    this.project = project;
    this.getSheetId = getSheetId;
    this.setSheetId = setSheetId;
    this.onLevelChanged = onLevelChanged;
    this.onOpenInDesign = onOpenInDesign;
    this.render();
  }

  // ---------- data ----------

  private rowFor(level: LevelData): LevelSheetRow | undefined {
    // fetchLevelProgressRows keys by `${mapId}_lv_${levelId}`-style entries via
    // the Map/Level columns; the node dataset carries the same level ids.
    for (const [key, row] of cachedRows ?? []) {
      if (key.endsWith(`_lv_${level.id}`)) return row;
    }
    return undefined;
  }

  private async load(): Promise<void> {
    const sheetId = this.getSheetId().trim();
    if (!sheetId) {
      this.status = "Paste a spreadsheet ID first.";
      this.render();
      return;
    }
    this.busy = true;
    this.status = `Loading "${this.tabName}"…`;
    this.render();
    try {
      const token = await requestAccessTokenInteractive();
      cachedRows = await fetchLevelProgressRows(sheetId, token, this.tabName, this.columns);
      cachedTab = this.tabName;
      this.status = `Loaded ${cachedRows.size} row(s) from "${this.tabName}".`;
    } catch (err) {
      cachedRows = null;
      if (err instanceof SheetPermissionError) {
        showSheetPermissionDialog({ sheetId });
        this.status = `Permission denied: ${err.message}`;
      } else if (err instanceof SheetAuthRequiredError) {
        this.status = `Sign-in required: ${err.message}`;
      } else {
        this.status = `Load failed: ${(err as Error).message}`;
      }
    }
    this.busy = false;
    this.render();
  }

  private async writeFields(level: LevelData, keys: FieldKey[]): Promise<void> {
    const row = this.rowFor(level);
    if (!row) {
      this.status = `No sheet row for ${level.name} — load the tab first.`;
      this.render();
      return;
    }
    const updates: CellUpdate[] = keys.map((key) => ({
      row: row.rowNumber,
      col: this.columns[key],
      value: String((level as unknown as Record<string, unknown>)[key] ?? ""),
    }));
    this.busy = true;
    this.status = `Writing ${updates.length} cell(s)…`;
    this.render();
    try {
      // One batched request for the whole action, never one per cell — that is
      // what keeps a whole-level apply from tripping the API's rate limit.
      await batchUpdateCells(this.getSheetId().trim(), this.tabName, updates);
      for (const key of keys) {
        row.fields[key] = String((level as unknown as Record<string, unknown>)[key] ?? "");
      }
      this.status = `Wrote ${updates.length} cell(s) for ${level.name}.`;
    } catch (err) {
      this.status = `Write failed: ${(err as Error).message}`;
    }
    this.busy = false;
    this.render();
  }

  private applyFromSheet(level: LevelData, keys: FieldKey[]): void {
    const row = this.rowFor(level);
    if (!row) return;
    for (const key of keys) {
      const value = row.fields[key];
      if (value === undefined) continue;
      (level as unknown as Record<string, unknown>)[key] = value;
    }
    this.onLevelChanged();
  }

  // ---------- rendering ----------

  private render(): void {
    this.root.replaceChildren(this.controls(), this.columnMapper(), this.levelList());
  }

  private controls(): HTMLElement {
    const sheetField = el("input", {
      type: "text",
      value: this.getSheetId(),
      placeholder: "Spreadsheet ID",
    }) as HTMLInputElement;
    sheetField.addEventListener("change", () => this.setSheetId(sheetField.value.trim()));

    const tabField = el("input", { type: "text", value: this.tabName }) as HTMLInputElement;
    tabField.addEventListener("change", () => {
      this.tabName = tabField.value.trim() || NODE_SHEET_DEFAULT_TAB;
      this.render();
    });

    const loadBtn = button("⟳ Load", () => void this.load(), { class: "primary" });
    loadBtn.disabled = this.busy;

    return el("div", { class: "remote-controls" }, [
      el("label", { class: "inline-field" }, ["Sheet ID", sheetField]),
      el("label", { class: "inline-field" }, ["Tab", tabField]),
      loadBtn,
      el("span", { class: "remote-status" }, [this.status]),
      ...(cachedRows && cachedTab !== this.tabName
        ? [el("span", { class: "remote-status warn" }, [`(cache is from "${cachedTab}")`])]
        : []),
    ]);
  }

  /** Each field's column is overridable, in case the real sheet's layout shifts. */
  private columnMapper(): HTMLElement {
    const fields = REMOTE_LEVEL_FIELDS.map(({ label, key }) => {
      const input = el("input", {
        type: "text",
        value: columnLetter(this.columns[key]),
        size: "3",
      }) as HTMLInputElement;
      input.addEventListener("change", () => {
        const col = letterToColumn(input.value.trim());
        if (col === null) {
          input.value = columnLetter(this.columns[key]);
          return;
        }
        this.columns[key] = col;
      });
      return el("label", { class: "inline-field" }, [label, input]);
    });
    return el("details", { class: "remote-columns" }, [
      el("summary", {}, ["Column mapping"]),
      el("div", { class: "remote-column-grid" }, fields),
    ]);
  }

  private levelList(): HTMLElement {
    const list = el("div", { class: "remote-levels" });
    for (const level of this.project.levels) {
      list.append(this.levelRow(level));
    }
    return list;
  }

  private levelRow(level: LevelData): HTMLElement {
    const key = foldKey(level.id);
    const open = openLevels.has(key);
    const row = this.rowFor(level);

    const head = el("div", { class: "remote-level-head" }, [
      el("span", { class: `remote-caret${open ? " open" : ""}` }, [open ? "▾" : "▸"]),
      el("strong", {}, [level.name]),
      el("span", { class: "muted" }, [row ? `sheet row ${row.rowNumber}` : "no sheet row"]),
      button("✎ Open in Design", (e) => {
        e.stopPropagation();
        this.onOpenInDesign(level.id);
      }),
    ]);
    head.addEventListener("click", () => {
      if (open) openLevels.delete(key);
      else openLevels.add(key);
      this.render();
    });

    const wrap = el("div", { class: "remote-level" }, [head]);
    if (!open) return wrap;

    const body = el("div", { class: "remote-level-body" });
    const allKeys = REMOTE_LEVEL_FIELDS.map((f) => f.key);
    body.append(
      el("div", { class: "remote-level-actions" }, [
        button("← Apply sheet → tool", () => this.applyFromSheet(level, allKeys), {
          title: "Overwrite every tool field from the sheet",
        }),
        button("Apply tool → sheet →", () => void this.writeFields(level, allKeys), {
          title: "Write every tool field to the sheet",
        }),
      ]),
    );

    for (const { label, key: fieldKey } of REMOTE_LEVEL_FIELDS) {
      const sheetValue = row?.fields[fieldKey] ?? "";
      const toolValue = String((level as unknown as Record<string, unknown>)[fieldKey] ?? "");
      const same = sheetValue === toolValue;
      body.append(
        el("div", { class: `remote-field${same ? " same" : " differs"}` }, [
          el("span", { class: "remote-field-label" }, [label]),
          el("code", { class: "remote-field-value" }, [sheetValue || "—"]),
          el("div", { class: "remote-field-actions" }, [
            button("←", () => this.applyFromSheet(level, [fieldKey]), { title: "Sheet → tool" }),
            button("→", () => void this.writeFields(level, [fieldKey]), { title: "Tool → sheet" }),
          ]),
          el("code", { class: "remote-field-value" }, [toolValue || "—"]),
        ]),
      );
    }
    wrap.append(body);
    return wrap;
  }
}
