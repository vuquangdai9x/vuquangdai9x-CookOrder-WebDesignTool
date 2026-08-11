// "Remote Data" mode: a side-by-side sheet/tool diff view for level data,
// backed by a "MapLevelProgress"-style tab — one row per level, one column
// per field (see data/config/general/remote-sheet-columns.json for the exact
// tab name + column layout, and data/sheetSource.ts's fetchLevelProgressRows
// for how a row is matched to a map/level). Global config blocks and
// per-map definition tables (tool/recipe_piece/etc.) are NOT shown here —
// this tab is scoped to level content only.
//
// Every read hits the network at most once per explicit "Load" — the whole
// tab is fetched in a single request and cached (module-level, so it survives
// this view being torn down and rebuilt on every mode switch), and every
// other action (a field's Apply, a level's Apply, "Apply All") reads from
// that cache instead of re-fetching. Writes for one action (a level's 7
// fields, or every level in "Apply All") go out as a single batched request
// — see data/sheetWrite.ts's batchUpdateCells — so a bulk action never turns
// into one HTTP request per cell. This is what keeps the tab from tripping
// the Sheets API's per-minute rate limit ("Too Many Requests").
//
// Each level renders as two columns — sheet data (left) and tool data
// (right) — one read-only field per REMOTE_LEVEL_FIELDS entry, each with its
// own hover-revealed Apply button that pushes just that one field across.
// Whole-level "Apply Sheet"/"Apply Tool" buttons push all 7 at once. Both
// maps and individual levels fold out (collapsed by default); fold state is
// module-level so it survives switching to Design/Play and back.

import type { LevelSheetRow, RemoteSheetColumns } from "../../data/sheetSource.ts";
import {
  columnLetter,
  fetchLevelProgressRows,
  letterToColumn,
  REMOTE_LEVEL_FIELDS,
  REMOTE_SHEET_COLUMNS,
  REMOTE_SHEET_DEFAULT_TAB,
  SheetAuthRequiredError,
  SheetPermissionError,
} from "../../data/sheetSource.ts";
import { REMOTE_KEYS } from "../../data/configLoader.ts";
import type { LevelData, MapData } from "../../data/mapLoader.ts";
import { requestAccessTokenInteractive } from "../../data/googleAuth.ts";
import { batchUpdateCells } from "../../data/sheetWrite.ts";
import type { CellUpdate } from "../../data/sheetWrite.ts";
import { showSheetPermissionDialog } from "../sheetPermissionDialog.ts";
import { button, el } from "../dom.ts";

interface LevelEntry {
  key: string;
  mapId: string;
  levelIndex: number;
}

interface Group {
  title: string;
  entries: LevelEntry[];
}

function buildGroups(): Group[] {
  return REMOTE_KEYS.maps.map((m) => ({
    title: m.mapId,
    entries: Array.from({ length: m.numLevels }, (_, i) => ({
      key: `map_config_${m.mapId}_lv_${i + 1}`,
      mapId: m.mapId,
      levelIndex: i + 1,
    })),
  }));
}

type RowStatus = "idle" | "loading" | "error";
type FieldKey = (typeof REMOTE_LEVEL_FIELDS)[number]["key"];

/**
 * Module-level so it survives RemoteDataView being recreated on every
 * main.ts render() (mode switch, sheet reload, etc.) — the whole reason we
 * cache is to avoid a fresh fetch per action; losing it on every tab switch
 * would defeat that. Keyed by sheetId+tabName so switching either invalidates
 * it correctly.
 */
let rowsCache: { cacheKey: string; rows: Map<string, LevelSheetRow> } | null = null;
/** Same reasoning: fold state and the tab/column overrides outlive this view's own lifetime. */
const openGroups = new Set<string>();
const openLevels = new Set<string>();
let tabName = REMOTE_SHEET_DEFAULT_TAB;
/** Which column (0-based) each of the 7 fields is read from/written to — starts at the JSON defaults, editable per-field from the page header (letters, e.g. "D"). */
const columnOverrides: RemoteSheetColumns = { ...REMOTE_SHEET_COLUMNS };
/** 1-indexed sheet row data starts at — the real MapLevelProgress sheet has 3 title/category/header rows before level 1's row. */
let startRow = 4;

/**
 * Character-level diff of `newStr` against `oldStr` via an LCS backtrack —
 * returns `newStr` split into segments, each flagged as "changed" (not part
 * of the common subsequence with `oldStr`, i.e. inserted or altered) or not.
 * O(n*m) time/space; level strings are a few hundred chars at most, so this
 * stays cheap. Deleted (old-only) characters don't appear — this only
 * renders newStr's own text.
 */
export function diffChars(oldStr: string, newStr: string): { text: string; changed: boolean }[] {
  const n = oldStr.length;
  const m = newStr.length;
  // Guard against a pathological paste — this is a display aid, not correctness-critical.
  if (n > 4000 || m > 4000) return [{ text: newStr, changed: true }];

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldStr[i] === newStr[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const segments: { text: string; changed: boolean }[] = [];
  const push = (ch: string, changed: boolean) => {
    const last = segments[segments.length - 1];
    if (last && last.changed === changed) last.text += ch;
    else segments.push({ text: ch, changed });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldStr[i] === newStr[j]) {
      push(newStr[j], false);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++; // oldStr[i] was deleted — doesn't appear in newStr's own text
    } else {
      push(newStr[j], true);
      j++;
    }
  }
  while (j < m) {
    push(newStr[j], true);
    j++;
  }
  return segments;
}

export class RemoteDataView {
  private root: HTMLElement;
  private map: MapData;
  private getSheetId: () => string;
  private setSheetId: (id: string) => void;
  private onLevelChanged: () => void;
  private onOpenInDesign: (levelId: number) => void;
  private groups: Group[];
  private refreshRowByKey = new Map<string, () => void>();
  private setRowStatusByKey = new Map<string, (status: RowStatus, error?: string) => void>();
  private groupStatusByTitle = new Map<string, HTMLElement>();
  private pageStatusEl!: HTMLElement;

  constructor(
    root: HTMLElement,
    map: MapData,
    getSheetId: () => string,
    setSheetId: (id: string) => void,
    onLevelChanged: () => void,
    onOpenInDesign: (levelId: number) => void,
  ) {
    this.root = root;
    this.map = map;
    this.getSheetId = getSheetId;
    this.setSheetId = setSheetId;
    this.onLevelChanged = onLevelChanged;
    this.onOpenInDesign = onOpenInDesign;
    this.groups = buildGroups();
    this.build();
  }

  private isLive(entry: LevelEntry): boolean {
    return entry.mapId === this.map.name && this.map.levels.some((l) => l.id === entry.levelIndex);
  }

  private level(entry: LevelEntry): LevelData | undefined {
    return this.map.levels.find((l) => l.id === entry.levelIndex);
  }

  private toolField(entry: LevelEntry, key: FieldKey): string | null {
    if (!this.isLive(entry)) return null;
    return (this.level(entry) as unknown as Record<string, string>)[key] ?? "";
  }

  private setToolField(entry: LevelEntry, key: FieldKey, value: string): void {
    const level = this.level(entry);
    if (!level) return;
    (level as unknown as Record<string, string>)[key] = value;
  }

  private cacheKeyNow(): string {
    return `${this.getSheetId()}::${tabName}::${startRow}::${JSON.stringify(columnOverrides)}`;
  }

  /** The cache, but only if it's actually for the currently-configured sheet+tab — otherwise `null` (not stale data). */
  private currentRows(): Map<string, LevelSheetRow> | null {
    return rowsCache && rowsCache.cacheKey === this.cacheKeyNow() ? rowsCache.rows : null;
  }

  /** Reuses the cache unless `forceRefresh` — the single choke point every read goes through, so a fetch only ever happens once per explicit reload. */
  private async ensureRows(forceRefresh: boolean): Promise<Map<string, LevelSheetRow> | null> {
    if (!forceRefresh) {
      const cached = this.currentRows();
      if (cached) return cached;
    }
    const sheetId = this.getSheetId();
    if (!sheetId.trim()) {
      alert("Paste a spreadsheet ID first.");
      return null;
    }
    const key = this.cacheKeyNow();
    const result = await this.withToken(async () => {
      const token = await requestAccessTokenInteractive();
      return fetchLevelProgressRows(sheetId, token, tabName, columnOverrides, startRow);
    });
    if (result === null) return null;
    rowsCache = { cacheKey: key, rows: result };
    return result;
  }

  private build(): void {
    const page = el("div", { class: "remote-page" });

    this.pageStatusEl = el("span", { class: "remote-status" }, []);
    const sheetIdInput = el("input", {
      type: "text",
      value: this.getSheetId(),
      placeholder: "Paste a spreadsheet ID…",
      class: "sheet-id-input",
    }) as HTMLInputElement;
    sheetIdInput.addEventListener("change", () => {
      this.setSheetId(sheetIdInput.value.trim());
      sheetIdInput.value = this.getSheetId();
    });
    const tabNameInput = el("input", { type: "text", value: tabName, class: "sheet-id-input" }) as HTMLInputElement;
    tabNameInput.addEventListener("change", () => {
      tabName = tabNameInput.value.trim() || REMOTE_SHEET_DEFAULT_TAB;
      tabNameInput.value = tabName;
    });
    const startRowInput = el("input", {
      type: "number",
      min: "1",
      value: String(startRow),
      class: "sheet-id-input column-letter-input",
    }) as HTMLInputElement;
    startRowInput.addEventListener("change", () => {
      startRow = Math.max(1, Number(startRowInput.value) || 1);
      startRowInput.value = String(startRow);
    });

    // One column-letter override per field, defaulting to remote-sheet-columns.json's
    // values — lets a designer point at the real sheet's actual layout without a code change.
    const columnFields = REMOTE_LEVEL_FIELDS.map((f) => {
      const input = el("input", {
        type: "text",
        value: columnLetter(columnOverrides[f.key]),
        class: "sheet-id-input column-letter-input",
      }) as HTMLInputElement;
      input.addEventListener("change", () => {
        const col = letterToColumn(input.value);
        if (col >= 0) columnOverrides[f.key] = col;
        input.value = columnLetter(columnOverrides[f.key]); // normalize case / revert if invalid
      });
      return el("label", { class: "field small" }, [f.label, input]);
    });

    page.append(
      el("div", { class: "remote-page-actions" }, [
        el("h2", {}, ["Remote Data"]),
        el("p", { class: "remote-hint" }, [
          "One row per level, one column per field — column letters and the start row below default from remote-sheet-columns.json but are editable here if the real sheet's layout differs. Only ",
          this.map.name,
          "'s levels have live tool data to compare against. Hover a field to apply just that one; each map and level folds out on click.",
        ]),
        el("div", { class: "remote-sheet-config" }, [
          el("label", { class: "field small" }, ["Sheet ID", sheetIdInput]),
          el("label", { class: "field small" }, ["Sheet (tab) name", tabNameInput]),
          el("label", { class: "field small" }, ["Start row", startRowInput]),
          ...columnFields,
        ]),
        el("div", { class: "remote-buttons" }, [
          button("⬇ Load All from sheet", () => void this.runAll("load"), { class: "full-btn" }),
          button("→ Apply All sheet data", () => void this.runAll("sheet-to-tool"), { class: "full-btn" }),
          button("← Apply All tool data", () => void this.runAll("tool-to-sheet"), { class: "full-btn" }),
          this.pageStatusEl,
        ]),
      ]),
    );

    for (const group of this.groups) page.append(this.groupEl(group));
    this.root.replaceChildren(page);
  }

  private groupEl(group: Group): HTMLElement {
    const statusEl = el("span", { class: "remote-status" }, []);
    this.groupStatusByTitle.set(group.title, statusEl);

    const open = openGroups.has(group.title);
    const rows = el("div", { class: "remote-rows" }, group.entries.map((entry) => this.rowEl(entry)));
    rows.style.display = open ? "" : "none";

    const caret = el("span", { class: "foldout-caret" }, [open ? "▾" : "▸"]);
    const toggle = () => {
      const next = !openGroups.has(group.title);
      if (next) openGroups.add(group.title);
      else openGroups.delete(group.title);
      caret.textContent = next ? "▾" : "▸";
      rows.style.display = next ? "" : "none";
    };

    const header = el("div", { class: "remote-group-header foldable-header" }, [
      caret,
      el("h3", {}, [group.title]),
      button("⬇ Load All", () => void this.runAll("load", group), {}),
      button("→ Apply sheet data", () => void this.runAll("sheet-to-tool", group), {}),
      button("← Apply tool data", () => void this.runAll("tool-to-sheet", group), {}),
      statusEl,
    ]);
    // The header itself toggles the fold — except clicks on one of its own
    // action buttons, which must reach their own handler instead.
    header.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      toggle();
    });
    return el("div", { class: "remote-group" }, [header, rows]);
  }

  private rowEl(entry: LevelEntry): HTMLElement {
    const live = this.isLive(entry);
    const statusEl = el("span", { class: "remote-status" }, []);

    const loadBtn = button("⬇ Load", () => void this.loadRow(entry), {
      class: "small-btn",
      title: "Re-fetch the whole sheet and refresh this level (and every other open one)",
    });
    const openBtn = button("✏ Open in Design", () => this.onOpenInDesign(entry.levelIndex), {
      class: "small-btn",
      title: "Switch to Design mode and select this level",
    }) as HTMLButtonElement;
    openBtn.disabled = !live;
    const applySheetBtn = button("→ Apply Sheet", () => void this.applyLevelSheetToTool(entry), {
      class: "small-btn",
      title: "Apply every sheet field to this level's live draft",
    }) as HTMLButtonElement;
    const applyToolBtn = button("← Apply Tool", () => void this.applyLevelToolToSheet(entry), {
      class: "small-btn",
      title: "Write every field from this level's live draft to the sheet, in one request",
    }) as HTMLButtonElement;

    const sheetFields = REMOTE_LEVEL_FIELDS.map((f) => this.fieldEl(f.label, "sheet", () => this.applyFieldSheetToTool(entry, f.key)));
    const toolFields = REMOTE_LEVEL_FIELDS.map((f) => this.fieldEl(f.label, "tool", () => void this.applyFieldToolToSheet(entry, f.key)));

    const refresh = () => {
      const row = this.currentRows()?.get(entry.key) ?? null;

      REMOTE_LEVEL_FIELDS.forEach((f, i) => {
        const sf = sheetFields[i];
        sf.box.classList.toggle("remote-box-empty", row === null);
        sf.box.textContent = row ? row.fields[f.key] || "(empty)" : "(not loaded)";
        sf.applyBtn.disabled = row === null || !live;

        const tf = toolFields[i];
        const toolVal = this.toolField(entry, f.key);
        tf.box.classList.remove("remote-box-empty", "remote-box-diff");
        if (toolVal === null) {
          tf.box.classList.add("remote-box-empty");
          tf.box.textContent = "(not this map)";
        } else {
          const sheetVal = row?.fields[f.key];
          if (sheetVal === undefined || sheetVal === toolVal) {
            tf.box.textContent = toolVal || "(empty)";
          } else {
            tf.box.classList.add("remote-box-diff");
            tf.box.replaceChildren(
              ...diffChars(sheetVal, toolVal).map((seg) =>
                seg.changed ? el("span", { class: "remote-diff-changed" }, [seg.text]) : seg.text,
              ),
            );
          }
        }
        tf.applyBtn.disabled = toolVal === null;
      });

      applySheetBtn.disabled = !live;
      applyToolBtn.disabled = !live;
    };
    refresh();
    this.refreshRowByKey.set(entry.key, refresh);

    const open = openLevels.has(entry.key);
    const body = el("div", { class: "remote-row-columns" }, [
      el("div", { class: "remote-col" }, [
        el("div", { class: "remote-col-label" }, ["Sheet data"]),
        ...sheetFields.map((f) => f.element),
      ]),
      el("div", { class: "remote-col" }, [
        el("div", { class: "remote-col-label" }, ["Tool data"]),
        ...toolFields.map((f) => f.element),
      ]),
    ]);
    body.style.display = open ? "" : "none";

    const caret = el("span", { class: "foldout-caret" }, [open ? "▾" : "▸"]);
    const toggle = () => {
      const next = !openLevels.has(entry.key);
      if (next) openLevels.add(entry.key);
      else openLevels.delete(entry.key);
      caret.textContent = next ? "▾" : "▸";
      body.style.display = next ? "" : "none";
    };

    const rowLabel = el("div", { class: "remote-row-label foldable-header" }, [
      caret,
      el("code", {}, [entry.key]),
      live ? el("span", { class: "remote-live-badge" }, ["live level"]) : "",
      el("span", { class: "spacer" }, []),
      openBtn,
      loadBtn,
      applySheetBtn,
      applyToolBtn,
      statusEl,
    ]);
    // Same click-anywhere-but-a-button toggle as the group header — see groupEl.
    rowLabel.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      toggle();
    });

    const row = el("div", { class: `remote-row${live ? " live" : ""}` }, [rowLabel, body]);

    this.setRowStatusByKey.set(entry.key, (status, error) => {
      statusEl.textContent = status === "loading" ? "…" : status === "error" ? "⚠" : "";
      statusEl.title = error ?? "";
      row.classList.toggle("remote-row-error", status === "error");
      const busy = status === "loading";
      loadBtn.disabled = busy;
      applySheetBtn.disabled = busy || !live;
      applyToolBtn.disabled = busy || !live;
      if (!busy) refresh(); // re-derive field content + correct enabled/disabled from live state
    });

    return row;
  }

  /** One field row (label + read-only box + hover-revealed Apply button) for either column. */
  private fieldEl(
    label: string,
    side: "sheet" | "tool",
    onApply: () => void,
  ): { element: HTMLElement; box: HTMLElement; applyBtn: HTMLButtonElement } {
    const box = el("div", { class: "remote-box" }, []);
    const applyBtn = button("Apply", onApply, {
      class: "small-btn remote-field-apply",
      title: side === "sheet" ? `Apply this sheet value to the tool (${label})` : `Apply this tool value to the sheet (${label})`,
    }) as HTMLButtonElement;
    const element = el("div", { class: "remote-field" }, [
      el("div", { class: "remote-field-label" }, [label]),
      el("div", { class: "remote-field-content" }, [box, applyBtn]),
    ]);
    return { element, box, applyBtn };
  }

  private async withToken<T>(action: () => Promise<T>): Promise<T | null> {
    try {
      return await action();
    } catch (err) {
      if (err instanceof SheetPermissionError) {
        showSheetPermissionDialog({ sheetId: this.getSheetId() });
      } else if (err instanceof SheetAuthRequiredError) {
        alert("Google sign-in required — click the action again to sign in.");
      } else {
        alert(`Remote Data request failed: ${(err as Error).message}`);
      }
      return null;
    }
  }

  private async loadRow(entry: LevelEntry): Promise<void> {
    const setStatus = this.setRowStatusByKey.get(entry.key);
    setStatus?.("loading");
    const rows = await this.ensureRows(true);
    if (rows === null) {
      setStatus?.("error", "load failed");
      return;
    }
    setStatus?.("idle");
    // The refresh happened for every currently-open row via setStatus above
    // only for THIS row — the fetch refreshed the whole cache, so bring
    // every other rendered row's display up to date too.
    for (const refresh of this.refreshRowByKey.values()) refresh();
  }

  /** Pushes every field from the sheet onto the tool's live level — no network (reads the cache). */
  private applyLevelSheetToTool(entry: LevelEntry): void {
    if (!this.isLive(entry)) return;
    const row = this.currentRows()?.get(entry.key);
    if (!row) {
      alert("Load the sheet first.");
      return;
    }
    for (const f of REMOTE_LEVEL_FIELDS) this.setToolField(entry, f.key, row.fields[f.key] ?? "");
    this.onLevelChanged();
    this.refreshRowByKey.get(entry.key)?.();
  }

  /** Pushes every field from the tool's live level onto the sheet, in one batched request. */
  private async applyLevelToolToSheet(entry: LevelEntry): Promise<void> {
    const sheetId = this.getSheetId();
    if (!sheetId.trim()) {
      alert("Paste a spreadsheet ID into the Sheet ID field first.");
      return;
    }
    if (!this.isLive(entry)) return;
    const setStatus = this.setRowStatusByKey.get(entry.key);
    setStatus?.("loading");
    const rows = await this.ensureRows(false);
    if (rows === null) {
      setStatus?.("error", "apply failed");
      return;
    }
    const row = rows.get(entry.key);
    if (!row) {
      setStatus?.("error", "no sheet row for this level yet");
      return;
    }
    const updates: CellUpdate[] = REMOTE_LEVEL_FIELDS.map((f) => ({
      row: row.rowNumber,
      col: columnOverrides[f.key],
      value: this.toolField(entry, f.key) ?? "",
    }));
    const ok = await this.withToken(() => batchUpdateCells(sheetId, tabName, updates));
    if (ok === null) {
      setStatus?.("error", "apply failed");
      return;
    }
    for (const f of REMOTE_LEVEL_FIELDS) row.fields[f.key] = this.toolField(entry, f.key) ?? "";
    setStatus?.("idle");
  }

  /** Pushes one sheet field onto the tool's corresponding LevelData property — no network (reads the cache). */
  private applyFieldSheetToTool(entry: LevelEntry, fieldKey: FieldKey): void {
    if (!this.isLive(entry)) return;
    const row = this.currentRows()?.get(entry.key);
    if (!row) return;
    this.setToolField(entry, fieldKey, row.fields[fieldKey] ?? "");
    this.onLevelChanged();
    this.refreshRowByKey.get(entry.key)?.();
  }

  /** Pushes one tool field onto the sheet — a single-cell batched write. */
  private async applyFieldToolToSheet(entry: LevelEntry, fieldKey: FieldKey): Promise<void> {
    const sheetId = this.getSheetId();
    if (!sheetId.trim()) {
      alert("Paste a spreadsheet ID into the Sheet ID field first.");
      return;
    }
    const value = this.toolField(entry, fieldKey);
    if (value === null) return;
    const setStatus = this.setRowStatusByKey.get(entry.key);
    setStatus?.("loading");
    const rows = await this.ensureRows(false);
    if (rows === null) {
      setStatus?.("error", "apply failed");
      return;
    }
    const row = rows.get(entry.key);
    if (!row) {
      setStatus?.("error", "no sheet row for this level yet");
      return;
    }
    const ok = await this.withToken(() =>
      batchUpdateCells(sheetId, tabName, [{ row: row.rowNumber, col: columnOverrides[fieldKey], value }]),
    );
    if (ok === null) {
      setStatus?.("error", "apply failed");
      return;
    }
    row.fields[fieldKey] = value;
    setStatus?.("idle");
  }

  private async runAll(action: "load" | "sheet-to-tool" | "tool-to-sheet", group?: Group): Promise<void> {
    const entries = group ? group.entries : this.groups.flatMap((g) => g.entries);
    const statusEl = group ? this.groupStatusByTitle.get(group.title) : this.pageStatusEl;
    if (statusEl) statusEl.textContent = "Working…";

    if (action === "load") {
      const rows = await this.ensureRows(true);
      if (statusEl) statusEl.textContent = rows === null ? "Load failed" : "Done (1 request)";
      for (const refresh of this.refreshRowByKey.values()) refresh();
      return;
    }

    const rows = await this.ensureRows(false);
    if (rows === null) {
      if (statusEl) statusEl.textContent = "Load failed";
      return;
    }

    if (action === "sheet-to-tool") {
      let applied = 0;
      for (const e of entries) {
        if (!this.isLive(e)) continue;
        const row = rows.get(e.key);
        if (!row) continue;
        for (const f of REMOTE_LEVEL_FIELDS) this.setToolField(e, f.key, row.fields[f.key] ?? "");
        applied++;
      }
      if (applied > 0) this.onLevelChanged();
      for (const e of entries) this.refreshRowByKey.get(e.key)?.();
      if (statusEl) statusEl.textContent = `Applied ${applied} level(s)`;
      return;
    }

    // tool-to-sheet: gather every changed cell across every live entry, then
    // write them all in exactly one request.
    const sheetId = this.getSheetId();
    if (!sheetId.trim()) {
      alert("Paste a spreadsheet ID into the Sheet ID field first.");
      if (statusEl) statusEl.textContent = "";
      return;
    }
    const updates: CellUpdate[] = [];
    const touched: { entry: LevelEntry; row: LevelSheetRow }[] = [];
    for (const e of entries) {
      if (!this.isLive(e)) continue;
      const row = rows.get(e.key);
      if (!row) continue;
      for (const f of REMOTE_LEVEL_FIELDS) {
        updates.push({ row: row.rowNumber, col: columnOverrides[f.key], value: this.toolField(e, f.key) ?? "" });
      }
      touched.push({ entry: e, row });
    }
    if (updates.length === 0) {
      if (statusEl) statusEl.textContent = "Nothing to apply";
      return;
    }
    const ok = await this.withToken(() => batchUpdateCells(sheetId, tabName, updates));
    if (ok === null) {
      if (statusEl) statusEl.textContent = "Apply failed";
      return;
    }
    for (const { entry, row } of touched) {
      for (const f of REMOTE_LEVEL_FIELDS) row.fields[f.key] = this.toolField(entry, f.key) ?? "";
    }
    for (const e of entries) this.refreshRowByKey.get(e.key)?.();
    if (statusEl) statusEl.textContent = `Applied ${touched.length} level(s) in 1 request`;
  }
}
