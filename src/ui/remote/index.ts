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

import type { LevelSheetRow, RemoteSheetColumns, RemoteSheetMapAliases } from "../../data/sheetSource.ts";
import {
  columnLetter,
  fetchTabValues,
  fetchLevelProgressRows,
  letterToColumn,
  REMOTE_LEVEL_FIELDS,
  REMOTE_NUMERIC_FIELDS,
  REMOTE_SHEET_COLUMNS,
  REMOTE_SHEET_DEFAULT_TAB,
  SheetAuthRequiredError,
  SheetPermissionError,
} from "../../data/sheetSource.ts";
import { REMOTE_KEYS } from "../../data/configLoader.ts";
import {
  applyGraphLookupRows,
  GRAPH_LOOKUP_DEFAULT_COLUMNS,
  GRAPH_LOOKUP_START_ROW,
  GRAPH_LOOKUP_TAB,
  graphLookupRows,
  parseGraphLookupRows,
  type GraphLookupColumns,
  type GraphLookupMap,
} from "../../data/graphLookupData.ts";
import type { LevelData, MapData } from "../../data/mapLoader.ts";
import { requestAccessTokenInteractive } from "../../data/googleAuth.ts";
import { batchUpdateCells } from "../../data/sheetWrite.ts";
import type { CellUpdate } from "../../data/sheetWrite.ts";
import {
  FirebaseAuthRequiredError,
  FirebasePermissionError,
  pushRemoteConfigParameter,
  restoreRemoteConfigParameter,
} from "../../data/remoteConfigWrite.ts";
import { showSheetPermissionDialog } from "../sheetPermissionDialog.ts";
import { button, el } from "../dom.ts";
import { bindUndoRedoKeys } from "../history.ts";

interface LevelEntry {
  key: string;
  mapId: string;
  levelIndex: number;
}

interface Group {
  title: string;
  entries: LevelEntry[];
}

export interface RemoteDataViewOptions {
  /** Keeps sheet cache, folds, and editable column settings independent between systems. */
  scope: string;
  mapId?: string;
  tabName?: string;
  columns?: RemoteSheetColumns;
  startRow?: number;
  /** Node Remote shows the current graph's real level list instead of legacy's configured 25-level catalog. */
  currentMapOnly?: boolean;
  /** Makes every supplied map a live foldout with independently editable local level data. */
  mapSources?: { id: string; title: string; map: MapData }[];
  /** Maps sheet cells such as numeric map indexes onto this view's semantic ids. */
  sheetMapAliases?: RemoteSheetMapAliases;
  /** Allows applying a sheet row to create a missing local level. */
  createLevel?: (mapId: string, levelId: number) => LevelData | null;
  onMapLevelChanged?: (mapId: string) => void;
  onOpenMapInDesign?: (mapId: string, levelId: number) => void;
  /** Node graphs addressable by the numeric Map key in GraphLookupData. */
  graphLookupMaps?: GraphLookupMap[];
  onGraphLookupChanged?: (mapIndex: number) => void;
}

interface RemoteHistoryAction {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

interface RemoteViewState {
  rowsCache: { cacheKey: string; rows: Map<string, LevelSheetRow> } | null;
  openGroups: Set<string>;
  openLevels: Set<string>;
  tabName: string;
  columnOverrides: RemoteSheetColumns;
  startRow: number;
  graphTabName: string;
  graphColumnOverrides: GraphLookupColumns;
  graphStartRow: number;
  configOpen: boolean;
  /** Project id for the "Push Remote Config" button — blank until the designer pastes one in. */
  firebaseProjectId: string;
}

const scopedStates = new Map<string, RemoteViewState>();

type RowStatus = "idle" | "loading" | "error";
type FieldKey = (typeof REMOTE_LEVEL_FIELDS)[number]["key"];

/**
 * Module-level so it survives RemoteDataView being recreated on every
 * main.ts render() (mode switch, sheet reload, etc.) — the whole reason we
 * cache is to avoid a fresh fetch per action; losing it on every tab switch
 * would defeat that. Keyed by sheetId+tabName so switching either invalidates
 * it correctly.
 */
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

export type LevelSyncStatus = "Local" | "Synced" | "Edited";

/** Sorted union used by Remote Data foldouts; driven by row Map/Level values, never a configured count. */
export function remoteLevelIds(
  mapId: string,
  localLevelIds: Iterable<number>,
  rows: Iterable<LevelSheetRow>,
): number[] {
  const ids = new Set(localLevelIds);
  for (const row of rows) {
    if (row.mapId === mapId) ids.add(row.level);
  }
  return [...ids].sort((a, b) => a - b);
}

/** The three-state contract shown on every level header. */
export function levelSyncStatus(
  sheetLoaded: boolean,
  row: LevelSheetRow | null,
  level: LevelData | undefined,
): LevelSyncStatus {
  if (!sheetLoaded) return "Local";
  if (!row || !level) return "Edited";
  return REMOTE_LEVEL_FIELDS.every(
    (field) => (row.fields[field.key] ?? "") === String((level as unknown as Record<string, unknown>)[field.key] ?? ""),
  )
    ? "Synced"
    : "Edited";
}

export class RemoteDataView {
  private root: HTMLElement;
  private map: MapData;
  private getSheetId: () => string;
  private setSheetId: (id: string) => void;
  private onLevelChanged: () => void;
  private onOpenInDesign: (levelId: number) => void;
  private groups: Group[];
  private mapId: string;
  private state: RemoteViewState;
  private defaultTabName: string;
  private options: RemoteDataViewOptions;
  private refreshRowByKey = new Map<string, () => void>();
  private setRowStatusByKey = new Map<string, (status: RowStatus, error?: string) => void>();
  private groupStatusByTitle = new Map<string, HTMLElement>();
  private pageStatusEl!: HTMLElement;
  private undoStack: RemoteHistoryAction[] = [];
  private redoStack: RemoteHistoryAction[] = [];
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private historyBusy = false;

  constructor(
    root: HTMLElement,
    map: MapData,
    getSheetId: () => string,
    setSheetId: (id: string) => void,
    onLevelChanged: () => void,
    onOpenInDesign: (levelId: number) => void,
    options: RemoteDataViewOptions = { scope: "legacy" },
  ) {
    this.root = root;
    this.map = map;
    this.getSheetId = getSheetId;
    this.setSheetId = setSheetId;
    this.onLevelChanged = onLevelChanged;
    this.onOpenInDesign = onOpenInDesign;
    this.options = options;
    this.mapId = options.mapId ?? map.name;
    this.defaultTabName = options.tabName ?? REMOTE_SHEET_DEFAULT_TAB;
    const existing = scopedStates.get(options.scope);
    this.state = existing ?? {
      rowsCache: null,
      openGroups: new Set<string>(),
      openLevels: new Set<string>(),
      tabName: this.defaultTabName,
      columnOverrides: { ...(options.columns ?? REMOTE_SHEET_COLUMNS) },
      startRow: options.startRow ?? 4,
      graphTabName: GRAPH_LOOKUP_TAB,
      graphColumnOverrides: { ...GRAPH_LOOKUP_DEFAULT_COLUMNS },
      graphStartRow: GRAPH_LOOKUP_START_ROW,
      configOpen: false,
      firebaseProjectId: "",
    };
    this.state.graphTabName ??= GRAPH_LOOKUP_TAB;
    this.state.graphColumnOverrides ??= { ...GRAPH_LOOKUP_DEFAULT_COLUMNS };
    this.state.graphStartRow ??= GRAPH_LOOKUP_START_ROW;
    this.state.configOpen ??= false;
    if (!existing) scopedStates.set(options.scope, this.state);
    this.groups = this.buildGroups();
    this.build();
  }

  /**
   * Builds each foldout from actual Level cells found in the loaded sheet,
   * unioned with levels that already exist locally. No row range or per-map
   * level count is assumed; sparse, reordered, or newly-added levels work.
   */
  private buildGroups(): Group[] {
    const sheetRows = [...(this.currentRows()?.values() ?? [])];
    const entries = (mapId: string, localLevels: LevelData[]): LevelEntry[] => {
      return remoteLevelIds(mapId, localLevels.map((level) => level.id), sheetRows)
        .map((levelIndex) => ({
          key: `map_config_${mapId}_lv_${levelIndex}`,
          mapId,
          levelIndex,
        }));
    };

    if (this.options.mapSources) {
      return this.options.mapSources.map((source) => ({
        title: source.title,
        entries: entries(source.id, source.map.levels),
      }));
    }
    if (this.options.currentMapOnly) {
      return [{ title: this.mapId, entries: entries(this.mapId, this.map.levels) }];
    }
    return REMOTE_KEYS.maps.map((configured) => ({
      title: configured.mapId,
      entries: entries(configured.mapId, configured.mapId === this.mapId ? this.map.levels : []),
    }));
  }

  private groupSignature(groups: Group[]): string {
    return groups.map((group) => `${group.title}:${group.entries.map((entry) => entry.key).join(",")}`).join("|");
  }

  /** Rebuilds the foldouts only when a sheet load discovered new/removed level rows. */
  private rebuildGroupsFromRows(): void {
    const next = this.buildGroups();
    if (this.groupSignature(next) === this.groupSignature(this.groups)) return;
    this.groups = next;
    this.build();
  }

  private isLive(entry: LevelEntry): boolean {
    return this.mapFor(entry)?.levels.some((l) => l.id === entry.levelIndex) ?? false;
  }

  private level(entry: LevelEntry): LevelData | undefined {
    return this.mapFor(entry)?.levels.find((l) => l.id === entry.levelIndex);
  }

  private mapFor(entry: LevelEntry): MapData | undefined {
    if (this.options.mapSources) return this.options.mapSources.find((source) => source.id === entry.mapId)?.map;
    return entry.mapId === this.mapId ? this.map : undefined;
  }

  private canApplySheet(entry: LevelEntry): boolean {
    return this.isLive(entry) || this.options.createLevel !== undefined;
  }

  /**
   * Bulk applies overwrite one side wholesale, so make the destination explicit
   * before anything moves. Per-level buttons stay unguarded — they touch one row.
   */
  private confirmOverwrite(action: "sheet-to-tool" | "tool-to-sheet", group?: Group): boolean {
    const scope = group ? `map "${group.title}"` : "EVERY map";
    const message = action === "tool-to-sheet"
      ? `This OVERWRITES the Google Sheet with tool data for ${scope}.\n\nSheet values that differ will be lost. Continue?`
      : `This OVERWRITES local tool data with sheet data for ${scope}.\n\nUnsaved local level changes will be lost. Continue?`;
    return confirm(message);
  }

  private ensureLevel(entry: LevelEntry): LevelData | undefined {
    const existing = this.level(entry);
    if (existing) return existing;
    const map = this.mapFor(entry);
    const created = this.options.createLevel?.(entry.mapId, entry.levelIndex) ?? null;
    if (!map || !created) return undefined;
    map.levels.push(created);
    map.levels.sort((a, b) => a.id - b.id);
    return created;
  }

  private notifyLevelChanged(entry: LevelEntry): void {
    if (this.options.onMapLevelChanged) this.options.onMapLevelChanged(entry.mapId);
    else this.onLevelChanged();
  }

  private toolField(entry: LevelEntry, key: FieldKey): string | null {
    if (!this.isLive(entry)) return null;
    const value = (this.level(entry) as unknown as Record<string, unknown>)[key];
    return value === undefined || value === null ? "" : String(value);
  }

  /**
   * A sheet cell is always text; a few level fields are not (see
   * REMOTE_NUMERIC_FIELDS). Coercing here rather than at every call site keeps
   * "what type does this field hold" one fact, and an unparseable numeric cell
   * CLEARS the field rather than storing NaN — an absent seed is a state the
   * generator understands, and NaN is not.
   */
  private setToolField(entry: LevelEntry, key: FieldKey, value: string): void {
    const level = this.level(entry);
    if (!level) return;
    const target = level as unknown as Record<string, unknown>;
    if (REMOTE_NUMERIC_FIELDS.has(key)) {
      const trimmed = value.trim();
      if (trimmed === "" || !Number.isFinite(Number(trimmed))) delete target[key];
      else target[key] = Math.trunc(Number(trimmed));
      return;
    }
    target[key] = value;
  }

  private cacheKeyNow(): string {
    return `${this.getSheetId()}::${this.state.tabName}::${this.state.startRow}::${JSON.stringify(this.state.columnOverrides)}::${JSON.stringify(this.options.sheetMapAliases ?? {})}`;
  }

  /** The cache, but only if it's actually for the currently-configured sheet+tab — otherwise `null` (not stale data). */
  private currentRows(): Map<string, LevelSheetRow> | null {
    return this.state.rowsCache && this.state.rowsCache.cacheKey === this.cacheKeyNow() ? this.state.rowsCache.rows : null;
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
      return fetchLevelProgressRows(
        sheetId,
        token,
        this.state.tabName,
        this.state.columnOverrides,
        this.state.startRow,
        this.options.sheetMapAliases,
      );
    });
    if (result === null) return null;
    this.state.rowsCache = { cacheKey: key, rows: result };
    this.rebuildGroupsFromRows();
    return result;
  }

  private build(): void {
    this.refreshRowByKey.clear();
    this.setRowStatusByKey.clear();
    this.groupStatusByTitle.clear();
    const page = el("div", { class: "remote-page" });
    page.tabIndex = 0;
    bindUndoRedoKeys(page, { undo: () => void this.runHistory("undo"), redo: () => void this.runHistory("redo") });

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
      for (const refresh of this.refreshRowByKey.values()) refresh();
    });
    const tabNameInput = el("input", { type: "text", value: this.state.tabName, class: "sheet-id-input" }) as HTMLInputElement;
    tabNameInput.addEventListener("change", () => {
      this.state.tabName = tabNameInput.value.trim() || this.defaultTabName;
      tabNameInput.value = this.state.tabName;
      for (const refresh of this.refreshRowByKey.values()) refresh();
    });
    const graphTabNameInput = el("input", {
      type: "text",
      value: this.state.graphTabName,
      class: "sheet-id-input",
    }) as HTMLInputElement;
    graphTabNameInput.addEventListener("change", () => {
      this.state.graphTabName = graphTabNameInput.value.trim() || GRAPH_LOOKUP_TAB;
      graphTabNameInput.value = this.state.graphTabName;
    });
    const startRowInput = el("input", {
      type: "number",
      min: "1",
      value: String(this.state.startRow),
      class: "sheet-id-input column-letter-input",
    }) as HTMLInputElement;
    startRowInput.addEventListener("change", () => {
      this.state.startRow = Math.max(1, Number(startRowInput.value) || 1);
      startRowInput.value = String(this.state.startRow);
      for (const refresh of this.refreshRowByKey.values()) refresh();
    });
    const graphStartRowInput = el("input", {
      type: "number",
      min: "1",
      value: String(this.state.graphStartRow),
      class: "sheet-id-input column-letter-input",
    }) as HTMLInputElement;
    graphStartRowInput.addEventListener("change", () => {
      this.state.graphStartRow = Math.max(1, Number(graphStartRowInput.value) || 1);
      graphStartRowInput.value = String(this.state.graphStartRow);
    });
    const firebaseProjectIdInput = el("input", {
      type: "text",
      value: this.state.firebaseProjectId,
      placeholder: "your-firebase-project-id",
      class: "sheet-id-input",
    }) as HTMLInputElement;
    firebaseProjectIdInput.addEventListener("change", () => {
      this.state.firebaseProjectId = firebaseProjectIdInput.value.trim();
      firebaseProjectIdInput.value = this.state.firebaseProjectId;
    });

    // One column-letter override per field, defaulting to remote-sheet-columns.json's
    // values — lets a designer point at the real sheet's actual layout without a code change.
    const levelColumnDefs: { label: string; key: keyof RemoteSheetColumns }[] = [
      { label: "Map", key: "map" },
      { label: "Level", key: "level" },
      ...REMOTE_LEVEL_FIELDS,
    ];
    const columnFields = levelColumnDefs.map((f) => {
      const input = el("input", {
        type: "text",
        value: columnLetter(this.state.columnOverrides[f.key]),
        class: "sheet-id-input column-letter-input",
      }) as HTMLInputElement;
      input.addEventListener("change", () => {
        const col = letterToColumn(input.value);
        if (col >= 0) this.state.columnOverrides[f.key] = col;
        input.value = columnLetter(this.state.columnOverrides[f.key]); // normalize case / revert if invalid
        for (const refresh of this.refreshRowByKey.values()) refresh();
      });
      return el("label", { class: "field small" }, [f.label, input]);
    });

    const graphColumnDefs: { label: string; key: keyof GraphLookupColumns }[] = [
      { label: "Map", key: "map" },
      { label: "Category", key: "category" },
      { label: "Index Data", key: "indexData" },
      { label: "Price", key: "price" },
      { label: "Speed Mul", key: "speedMul" },
      { label: "Max Stack", key: "maxStack" },
    ];
    const graphColumnFields = graphColumnDefs.map((field) => {
      const input = el("input", {
        type: "text",
        value: columnLetter(this.state.graphColumnOverrides[field.key]),
        class: "sheet-id-input column-letter-input",
      }) as HTMLInputElement;
      input.addEventListener("change", () => {
        const col = letterToColumn(input.value);
        if (col >= 0) this.state.graphColumnOverrides[field.key] = col;
        input.value = columnLetter(this.state.graphColumnOverrides[field.key]);
      });
      return el("label", { class: "field small" }, [field.label, input]);
    });

    this.undoBtn = button("↶ Undo", () => void this.runHistory("undo"), { class: "small-btn" });
    this.redoBtn = button("↷ Redo", () => void this.runHistory("redo"), { class: "small-btn" });
    this.refreshHistoryButtons();
    const graphButtons = this.options.graphLookupMaps ? [
      button("Write all graph lookup data", () => void this.writeAllGraphLookupData(), { class: "full-btn" }),
      button("Load graph data", () => void this.loadGraphLookupData(), { class: "full-btn" }),
    ] : [];

    const configDetails = el("details", { class: "remote-config-foldout" }) as HTMLDetailsElement;
    configDetails.open = this.state.configOpen;
    configDetails.addEventListener("toggle", () => {
      this.state.configOpen = configDetails.open;
    });
    const configChildren: HTMLElement[] = [
      el("p", { class: "remote-hint" }, [
        "Column letters and data start rows are editable when the remote sheet layout differs. Firebase Project ID is used only by each level's Push Remote Config action.",
      ]),
      el("h3", { class: "remote-config-heading" }, ["MapLevelProgress"]),
      el("div", { class: "remote-sheet-config" }, [
        el("label", { class: "field small" }, ["Start row", startRowInput]),
        ...columnFields,
      ]),
      el("label", { class: "field small remote-firebase-config" }, ["Firebase Project ID", firebaseProjectIdInput]),
    ];
    if (this.options.graphLookupMaps) {
      configChildren.push(
        el("h3", { class: "remote-config-heading" }, ["GraphLookupData"]),
        el("div", { class: "remote-sheet-config" }, [
          el("label", { class: "field small" }, ["Start row", graphStartRowInput]),
          ...graphColumnFields,
        ]),
      );
    }
    configDetails.append(el("summary", {}, ["Config"]), el("div", { class: "remote-config-body" }, configChildren));

    page.append(
      el("div", { class: "remote-page-actions" }, [
        el("div", { class: "remote-title-row" }, [
          el("h2", {}, ["Remote Data"]),
          this.undoBtn,
          this.redoBtn,
        ]),
        el("div", { class: "remote-sheet-config" }, [
          el("label", { class: "field small" }, ["Sheet ID", sheetIdInput]),
          el("label", { class: "field small" }, ["MapLevelProgress sheet name", tabNameInput]),
          ...(this.options.graphLookupMaps
            ? [el("label", { class: "field small" }, ["GraphLookupData sheet name", graphTabNameInput])]
            : []),
        ]),
        configDetails,
        el("div", { class: "remote-buttons" }, [
          button("⬇ Load All from sheet", () => void this.runAll("load"), { class: "full-btn" }),
          button("→ Apply All sheet data", () => void this.runAll("sheet-to-tool"), { class: "full-btn" }),
          button("← Apply All tool data", () => void this.runAll("tool-to-sheet"), { class: "full-btn" }),
          ...graphButtons,
          this.pageStatusEl,
        ]),
      ]),
    );

    for (const group of this.groups) page.append(this.groupEl(group));
    this.root.replaceChildren(page);
    page.focus({ preventScroll: true });
  }

  private groupEl(group: Group): HTMLElement {
    const statusEl = el("span", { class: "remote-status" }, []);
    this.groupStatusByTitle.set(group.title, statusEl);

    const open = this.state.openGroups.has(group.title);
    const rows = el("div", { class: "remote-rows" }, group.entries.map((entry) => this.rowEl(entry)));
    rows.style.display = open ? "" : "none";

    const caret = el("span", { class: "foldout-caret" }, [open ? "▾" : "▸"]);
    const toggle = () => {
      const next = !this.state.openGroups.has(group.title);
      if (next) this.state.openGroups.add(group.title);
      else this.state.openGroups.delete(group.title);
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
    const syncStatusEl = el("span", { class: "remote-sync-status local" }, ["Local"]);
    const liveBadge = el("span", { class: "remote-live-badge" }, ["live level"]);
    liveBadge.hidden = !live;
    let rowElement: HTMLElement | null = null;

    const loadBtn = button("⬇ Load", () => void this.loadRow(entry), {
      class: "small-btn",
      title: "Re-fetch the whole sheet and refresh this level (and every other open one)",
    });
    const openBtn = button("✏ Open in Design", () => {
      if (this.options.onOpenMapInDesign) this.options.onOpenMapInDesign(entry.mapId, entry.levelIndex);
      else this.onOpenInDesign(entry.levelIndex);
    }, {
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
    const pushConfigBtn = button("↪ Push Remote Config", () => void this.pushLevelRemoteConfig(entry), {
      class: "small-btn",
      title: "Write this level's customers~grid~queue strings to Firebase Remote Config",
    }) as HTMLButtonElement;

    const sheetFields = REMOTE_LEVEL_FIELDS.map((f) => this.fieldEl(f.label, "sheet", () => this.applyFieldSheetToTool(entry, f.key)));
    const toolFields = REMOTE_LEVEL_FIELDS.map((f) => this.fieldEl(f.label, "tool", () => void this.applyFieldToolToSheet(entry, f.key)));

    const refresh = () => {
      const row = this.currentRows()?.get(entry.key) ?? null;
      const liveNow = this.isLive(entry);
      liveBadge.hidden = !liveNow;
      rowElement?.classList.toggle("live", liveNow);
      openBtn.disabled = !liveNow;

      REMOTE_LEVEL_FIELDS.forEach((f, i) => {
        const sf = sheetFields[i];
        sf.box.classList.toggle("remote-box-empty", row === null);
        sf.box.textContent = row ? row.fields[f.key] || "(empty)" : "(not loaded)";
        sf.applyBtn.disabled = row === null || !this.canApplySheet(entry);

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

      applySheetBtn.disabled = row === null || !this.canApplySheet(entry);
      applyToolBtn.disabled = !liveNow;
      pushConfigBtn.disabled = !liveNow;

      const loadedRows = this.currentRows();
      const syncStatus = levelSyncStatus(loadedRows !== null, row, this.level(entry));
      syncStatusEl.textContent = syncStatus;
      syncStatusEl.className = `remote-sync-status ${syncStatus.toLowerCase()}`;
    };
    refresh();
    this.refreshRowByKey.set(entry.key, refresh);

    const open = this.state.openLevels.has(entry.key);
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
      const next = !this.state.openLevels.has(entry.key);
      if (next) this.state.openLevels.add(entry.key);
      else this.state.openLevels.delete(entry.key);
      caret.textContent = next ? "▾" : "▸";
      body.style.display = next ? "" : "none";
    };

    const rowLabel = el("div", { class: "remote-row-label foldable-header" }, [
      caret,
      el("code", {}, [entry.key]),
      liveBadge,
      syncStatusEl,
      el("span", { class: "spacer" }, []),
      openBtn,
      loadBtn,
      applySheetBtn,
      applyToolBtn,
      pushConfigBtn,
      statusEl,
    ]);
    // Same click-anywhere-but-a-button toggle as the group header — see groupEl.
    rowLabel.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      toggle();
    });

    const row = el("div", { class: `remote-row${live ? " live" : ""}` }, [rowLabel, body]);
    rowElement = row;

    this.setRowStatusByKey.set(entry.key, (status, error) => {
      statusEl.textContent = status === "loading" ? "…" : status === "error" ? "⚠" : "";
      statusEl.title = error ?? "";
      row.classList.toggle("remote-row-error", status === "error");
      const busy = status === "loading";
      loadBtn.disabled = busy;
      applySheetBtn.disabled = busy || !this.canApplySheet(entry);
      applyToolBtn.disabled = busy || !this.isLive(entry);
      pushConfigBtn.disabled = busy || !this.isLive(entry);
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

  private refreshHistoryButtons(): void {
    if (!this.undoBtn || !this.redoBtn) return;
    this.undoBtn.disabled = this.historyBusy || this.undoStack.length === 0;
    this.redoBtn.disabled = this.historyBusy || this.redoStack.length === 0;
    this.undoBtn.title = this.undoStack.length ? `Undo — ${this.undoStack.at(-1)?.label}` : "Nothing to undo";
    this.redoBtn.title = this.redoStack.length ? `Redo — ${this.redoStack.at(-1)?.label}` : "Nothing to redo";
  }

  private recordHistory(action: RemoteHistoryAction): void {
    this.undoStack.push(action);
    this.redoStack.length = 0;
    this.refreshHistoryButtons();
  }

  private async runHistory(direction: "undo" | "redo"): Promise<void> {
    if (this.historyBusy) return;
    const from = direction === "undo" ? this.undoStack : this.redoStack;
    const to = direction === "undo" ? this.redoStack : this.undoStack;
    const action = from.at(-1);
    if (!action) return;
    this.historyBusy = true;
    this.refreshHistoryButtons();
    this.pageStatusEl.textContent = `${direction === "undo" ? "Undoing" : "Redoing"} ${action.label}…`;
    try {
      await action[direction]();
      from.pop();
      to.push(action);
      this.pageStatusEl.textContent = `${direction === "undo" ? "Undid" : "Redid"} ${action.label}`;
    } catch (err) {
      this.showRequestError(`Could not ${direction}`, err);
      this.pageStatusEl.textContent = `${direction === "undo" ? "Undo" : "Redo"} failed`;
    } finally {
      this.historyBusy = false;
      this.refreshHistoryButtons();
    }
  }

  private showRequestError(prefix: string, err: unknown): void {
    if (err instanceof SheetPermissionError) showSheetPermissionDialog({ sheetId: this.getSheetId() });
    else if (err instanceof SheetAuthRequiredError) alert("Google sign-in required — try the action again to sign in.");
    else if (err instanceof FirebasePermissionError || err instanceof FirebaseAuthRequiredError) alert(`${prefix}: ${err.message}`);
    else alert(`${prefix}: ${(err as Error).message}`);
  }

  private captureLevels(): Record<string, LevelData[]> {
    const sources = this.options.mapSources ?? [{ id: this.mapId, title: this.mapId, map: this.map }];
    return Object.fromEntries(sources.map((source) => [source.id, structuredClone(source.map.levels)]));
  }

  private restoreLevels(snapshot: Record<string, LevelData[]>): void {
    const sources = this.options.mapSources ?? [{ id: this.mapId, title: this.mapId, map: this.map }];
    for (const source of sources) {
      const levels = snapshot[source.id];
      if (!levels) continue;
      source.map.levels.splice(0, source.map.levels.length, ...structuredClone(levels));
      const representative = { key: "", mapId: source.id, levelIndex: source.map.levels[0]?.id ?? 1 };
      this.notifyLevelChanged(representative);
    }
    this.groups = this.buildGroups();
    this.build();
  }

  private recordLevelHistory(label: string, before: Record<string, LevelData[]>): void {
    const after = this.captureLevels();
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.recordHistory({
      label,
      undo: async () => this.restoreLevels(before),
      redo: async () => this.restoreLevels(after),
    });
  }

  private updateCachedLevelCells(updates: readonly CellUpdate[], rows: Map<string, LevelSheetRow>): void {
    for (const update of updates) {
      const row = [...rows.values()].find((candidate) => candidate.rowNumber === update.row);
      const field = REMOTE_LEVEL_FIELDS.find((candidate) => this.state.columnOverrides[candidate.key] === update.col);
      if (row && field) row.fields[field.key] = update.value;
    }
    for (const refresh of this.refreshRowByKey.values()) refresh();
  }

  private recordSheetHistory(
    label: string,
    sheetId: string,
    tabName: string,
    rows: Map<string, LevelSheetRow>,
    before: CellUpdate[],
    after: CellUpdate[],
  ): void {
    if (before.every((cell, index) => cell.value === after[index]?.value)) return;
    const apply = async (updates: CellUpdate[]) => {
      await batchUpdateCells(sheetId, tabName, updates);
      this.updateCachedLevelCells(updates, rows);
    };
    this.recordHistory({ label, undo: () => apply(before), redo: () => apply(after) });
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
    this.setRowStatusByKey.get(entry.key)?.("loading");
    const rows = await this.ensureRows(true);
    if (rows === null) {
      this.setRowStatusByKey.get(entry.key)?.("error", "load failed");
      return;
    }
    this.setRowStatusByKey.get(entry.key)?.("idle");
    // The refresh happened for every currently-open row via setStatus above
    // only for THIS row — the fetch refreshed the whole cache, so bring
    // every other rendered row's display up to date too.
    for (const refresh of this.refreshRowByKey.values()) refresh();
  }

  /** Pushes every field from the sheet onto the tool's live level — no network (reads the cache). */
  private applyLevelSheetToTool(entry: LevelEntry): void {
    const row = this.currentRows()?.get(entry.key);
    if (!row) {
      alert("Load the sheet first.");
      return;
    }
    const before = this.captureLevels();
    if (!this.ensureLevel(entry)) return;
    for (const f of REMOTE_LEVEL_FIELDS) this.setToolField(entry, f.key, row.fields[f.key] ?? "");
    this.notifyLevelChanged(entry);
    this.refreshRowByKey.get(entry.key)?.();
    this.recordLevelHistory(`apply sheet to ${entry.key}`, before);
  }

  /** Pushes every field from the tool's live level onto the sheet, in one batched request. */
  private async applyLevelToolToSheet(entry: LevelEntry): Promise<void> {
    const sheetId = this.getSheetId();
    if (!sheetId.trim()) {
      alert("Paste a spreadsheet ID into the Sheet ID field first.");
      return;
    }
    if (!this.isLive(entry)) return;
    this.setRowStatusByKey.get(entry.key)?.("loading");
    const rows = await this.ensureRows(false);
    if (rows === null) {
      this.setRowStatusByKey.get(entry.key)?.("error", "apply failed");
      return;
    }
    const row = rows.get(entry.key);
    if (!row) {
      this.setRowStatusByKey.get(entry.key)?.("error", "no sheet row for this level yet");
      return;
    }
    const updates: CellUpdate[] = REMOTE_LEVEL_FIELDS.map((f) => ({
      row: row.rowNumber,
      col: this.state.columnOverrides[f.key],
      value: this.toolField(entry, f.key) ?? "",
    }));
    const before: CellUpdate[] = REMOTE_LEVEL_FIELDS.map((f) => ({
      row: row.rowNumber,
      col: this.state.columnOverrides[f.key],
      value: row.fields[f.key] ?? "",
    }));
    const ok = await this.withToken(() => batchUpdateCells(sheetId, this.state.tabName, updates));
    if (ok === null) {
      this.setRowStatusByKey.get(entry.key)?.("error", "apply failed");
      return;
    }
    for (const f of REMOTE_LEVEL_FIELDS) row.fields[f.key] = this.toolField(entry, f.key) ?? "";
    this.setRowStatusByKey.get(entry.key)?.("idle");
    this.recordSheetHistory(`apply ${entry.key} to sheet`, sheetId, this.state.tabName, rows, before, updates);
  }

  /**
   * Writes this level's tool data — customers, grid, and queue strings,
   * `~`-joined — to Firebase Remote Config under this level's own key, in
   * one GET-modify-PUT template round trip (see remoteConfigWrite.ts).
   * Reads the live draft, same source "← Apply Tool" pushes to the sheet.
   */
  private async pushLevelRemoteConfig(entry: LevelEntry): Promise<void> {
    const projectId = this.state.firebaseProjectId.trim();
    if (!projectId) {
      alert("Paste a Firebase Project ID into the Firebase Project ID field first.");
      return;
    }
    if (!this.isLive(entry)) return;
    const customers = this.toolField(entry, "customerString") ?? "";
    const grid = this.toolField(entry, "gridString") ?? "";
    const queue = this.toolField(entry, "queueString") ?? "";
    const value = `${customers}~${grid}~${queue}`;
    this.setRowStatusByKey.get(entry.key)?.("loading");
    try {
      const previous = await pushRemoteConfigParameter(projectId, entry.key, value);
      const after = { ...(previous ?? {}), defaultValue: { value } };
      this.recordHistory({
        label: `push ${entry.key} to Remote Config`,
        undo: () => restoreRemoteConfigParameter(projectId, entry.key, previous),
        redo: () => restoreRemoteConfigParameter(projectId, entry.key, after),
      });
      this.setRowStatusByKey.get(entry.key)?.("idle");
    } catch (err) {
      if (err instanceof FirebasePermissionError) {
        alert(`Firebase Remote Config: ${err.message}`);
      } else if (err instanceof FirebaseAuthRequiredError) {
        alert("Google sign-in required for Firebase — click Push Remote Config again to sign in.");
      } else {
        alert(`Push Remote Config failed: ${(err as Error).message}`);
      }
      this.setRowStatusByKey.get(entry.key)?.("error", "push failed");
    }
  }

  /** Pushes one sheet field onto the tool's corresponding LevelData property — no network (reads the cache). */
  private applyFieldSheetToTool(entry: LevelEntry, fieldKey: FieldKey): void {
    const row = this.currentRows()?.get(entry.key);
    if (!row) return;
    const before = this.captureLevels();
    if (!this.ensureLevel(entry)) return;
    this.setToolField(entry, fieldKey, row.fields[fieldKey] ?? "");
    this.notifyLevelChanged(entry);
    this.refreshRowByKey.get(entry.key)?.();
    this.recordLevelHistory(`apply ${fieldKey} to ${entry.key}`, before);
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
    this.setRowStatusByKey.get(entry.key)?.("loading");
    const rows = await this.ensureRows(false);
    if (rows === null) {
      this.setRowStatusByKey.get(entry.key)?.("error", "apply failed");
      return;
    }
    const row = rows.get(entry.key);
    if (!row) {
      this.setRowStatusByKey.get(entry.key)?.("error", "no sheet row for this level yet");
      return;
    }
    const update = { row: row.rowNumber, col: this.state.columnOverrides[fieldKey], value };
    const before = { ...update, value: row.fields[fieldKey] ?? "" };
    const ok = await this.withToken(() => batchUpdateCells(sheetId, this.state.tabName, [update]));
    if (ok === null) {
      this.setRowStatusByKey.get(entry.key)?.("error", "apply failed");
      return;
    }
    row.fields[fieldKey] = value;
    this.setRowStatusByKey.get(entry.key)?.("idle");
    this.recordSheetHistory(`apply ${fieldKey} from ${entry.key} to sheet`, sheetId, this.state.tabName, rows, [before], [update]);
  }

  private graphMatrixUpdates(rows: readonly (readonly string[])[], rowCount: number): CellUpdate[] {
    const updates: CellUpdate[] = [];
    const columns: (keyof GraphLookupColumns)[] = ["map", "category", "indexData", "price", "speedMul", "maxStack"];
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
      columns.forEach((key, valueIndex) => {
        updates.push({
          row: this.state.graphStartRow + rowIndex,
          col: this.state.graphColumnOverrides[key],
          value: String(rows[rowIndex]?.[valueIndex] ?? ""),
        });
      });
    }
    return updates;
  }

  private async writeAllGraphLookupData(): Promise<void> {
    const maps = this.options.graphLookupMaps;
    if (!maps) return;
    const sheetId = this.getSheetId().trim();
    if (!sheetId) {
      alert("Paste a spreadsheet ID into the Sheet ID field first.");
      return;
    }
    const graphTabName = this.state.graphTabName;
    if (!confirm(`This OVERWRITES all data rows in the ${graphTabName} sheet with values from every graph.\n\nContinue?`)) return;
    this.pageStatusEl.textContent = "Writing graph lookup data…";

    const raw = await this.withToken(async () => {
      const token = await requestAccessTokenInteractive();
      return fetchTabValues(graphTabName, token, sheetId);
    });
    if (raw === null) {
      this.pageStatusEl.textContent = "Graph lookup write failed";
      return;
    }
    const graphColumns: (keyof GraphLookupColumns)[] = ["map", "category", "indexData", "price", "speedMul", "maxStack"];
    const beforeRows = raw.slice(this.state.graphStartRow - 1).map((row) =>
      graphColumns.map((key) => String(row[this.state.graphColumnOverrides[key]] ?? "")),
    );
    const afterRows = graphLookupRows(maps);
    const rowCount = Math.max(beforeRows.length, afterRows.length);
    const before = this.graphMatrixUpdates(beforeRows, rowCount);
    const after = this.graphMatrixUpdates(afterRows, rowCount);
    const ok = await this.withToken(() => batchUpdateCells(sheetId, graphTabName, after));
    if (ok === null) {
      this.pageStatusEl.textContent = "Graph lookup write failed";
      return;
    }
    const apply = (updates: CellUpdate[]) => batchUpdateCells(sheetId, graphTabName, updates);
    this.recordHistory({
      label: "write all graph lookup data",
      undo: () => apply(before),
      redo: () => apply(after),
    });
    this.pageStatusEl.textContent = `Wrote ${afterRows.length} graph lookup row(s)`;
  }

  private captureGraphs(): Record<number, GraphLookupMap["doc"]> {
    return Object.fromEntries((this.options.graphLookupMaps ?? []).map((source) => [source.index, structuredClone(source.doc)]));
  }

  private restoreGraphs(snapshot: Record<number, GraphLookupMap["doc"]>, mapIndexes: readonly number[]): void {
    for (const source of this.options.graphLookupMaps ?? []) {
      if (!mapIndexes.includes(source.index)) continue;
      const saved = snapshot[source.index];
      if (!saved) continue;
      for (const key of Object.keys(source.doc)) delete (source.doc as unknown as Record<string, unknown>)[key];
      Object.assign(source.doc, structuredClone(saved));
      this.options.onGraphLookupChanged?.(source.index);
    }
  }

  private async loadGraphLookupData(): Promise<void> {
    const maps = this.options.graphLookupMaps;
    if (!maps) return;
    const sheetId = this.getSheetId().trim();
    if (!sheetId) {
      alert("Paste a spreadsheet ID into the Sheet ID field first.");
      return;
    }
    const graphTabName = this.state.graphTabName;
    if (!confirm(`This OVERWRITES matching graph values using [Map, Category, Index Data] rows from ${graphTabName}.\n\nContinue?`)) return;
    this.pageStatusEl.textContent = "Loading graph lookup data…";
    const raw = await this.withToken(async () => {
      const token = await requestAccessTokenInteractive();
      return fetchTabValues(graphTabName, token, sheetId);
    });
    if (raw === null) {
      this.pageStatusEl.textContent = "Graph lookup load failed";
      return;
    }
    const before = this.captureGraphs();
    const result = applyGraphLookupRows(
      maps,
      parseGraphLookupRows(raw, this.state.graphStartRow, this.state.graphColumnOverrides),
    );
    const after = this.captureGraphs();
    const changedMapIndexes: number[] = [];
    for (const source of maps) {
      if (JSON.stringify(before[source.index]) !== JSON.stringify(after[source.index])) {
        changedMapIndexes.push(source.index);
        this.options.onGraphLookupChanged?.(source.index);
      }
    }
    if (result.changed > 0) {
      this.recordHistory({
        label: "load graph lookup data",
        undo: async () => this.restoreGraphs(before, changedMapIndexes),
        redo: async () => this.restoreGraphs(after, changedMapIndexes),
      });
    }
    this.pageStatusEl.textContent = `Matched ${result.matched} row(s), changed ${result.changed}${result.invalid ? `, skipped ${result.invalid} invalid value(s)` : ""}`;
  }

  private async runAll(action: "load" | "sheet-to-tool" | "tool-to-sheet", group?: Group): Promise<void> {
    const groupTitle = group?.title;
    if (action !== "load" && !this.confirmOverwrite(action, group)) return;
    const statusEl = () => groupTitle ? this.groupStatusByTitle.get(groupTitle) : this.pageStatusEl;
    const initialStatus = statusEl();
    if (initialStatus) initialStatus.textContent = "Working…";

    if (action === "load") {
      const rows = await this.ensureRows(true);
      const currentStatus = statusEl();
      if (currentStatus) currentStatus.textContent = rows === null ? "Load failed" : "Done (1 request)";
      for (const refresh of this.refreshRowByKey.values()) refresh();
      return;
    }

    const rows = await this.ensureRows(false);
    const currentGroup = groupTitle ? this.groups.find((candidate) => candidate.title === groupTitle) : undefined;
    const entries = currentGroup ? currentGroup.entries : groupTitle ? [] : this.groups.flatMap((candidate) => candidate.entries);
    if (rows === null) {
      const currentStatus = statusEl();
      if (currentStatus) currentStatus.textContent = "Load failed";
      return;
    }

    if (action === "sheet-to-tool") {
      const before = this.captureLevels();
      let applied = 0;
      const appliedMapIds = new Set<string>();
      for (const e of entries) {
        const row = rows.get(e.key);
        if (!row) continue;
        if (!this.ensureLevel(e)) continue;
        for (const f of REMOTE_LEVEL_FIELDS) this.setToolField(e, f.key, row.fields[f.key] ?? "");
        applied++;
        appliedMapIds.add(e.mapId);
      }
      if (applied > 0) {
        for (const mapId of appliedMapIds) {
          const representative = entries.find((entry) => entry.mapId === mapId);
          if (representative) this.notifyLevelChanged(representative);
        }
      }
      for (const e of entries) this.refreshRowByKey.get(e.key)?.();
      const currentStatus = statusEl();
      if (currentStatus) currentStatus.textContent = `Applied ${applied} level(s)`;
      this.recordLevelHistory(`apply sheet data to ${groupTitle ?? "all maps"}`, before);
      return;
    }

    // tool-to-sheet: gather every changed cell across every live entry, then
    // write them all in exactly one request.
    const sheetId = this.getSheetId();
    if (!sheetId.trim()) {
      alert("Paste a spreadsheet ID into the Sheet ID field first.");
      const currentStatus = statusEl();
      if (currentStatus) currentStatus.textContent = "";
      return;
    }
    const updates: CellUpdate[] = [];
    const before: CellUpdate[] = [];
    const touched: { entry: LevelEntry; row: LevelSheetRow }[] = [];
    for (const e of entries) {
      if (!this.isLive(e)) continue;
      const row = rows.get(e.key);
      if (!row) continue;
      for (const f of REMOTE_LEVEL_FIELDS) {
        updates.push({ row: row.rowNumber, col: this.state.columnOverrides[f.key], value: this.toolField(e, f.key) ?? "" });
        before.push({ row: row.rowNumber, col: this.state.columnOverrides[f.key], value: row.fields[f.key] ?? "" });
      }
      touched.push({ entry: e, row });
    }
    if (updates.length === 0) {
      const currentStatus = statusEl();
      if (currentStatus) currentStatus.textContent = "Nothing to apply";
      return;
    }
    const ok = await this.withToken(() => batchUpdateCells(sheetId, this.state.tabName, updates));
    if (ok === null) {
      const currentStatus = statusEl();
      if (currentStatus) currentStatus.textContent = "Apply failed";
      return;
    }
    for (const { entry, row } of touched) {
      for (const f of REMOTE_LEVEL_FIELDS) row.fields[f.key] = this.toolField(entry, f.key) ?? "";
    }
    for (const e of entries) this.refreshRowByKey.get(e.key)?.();
    const currentStatus = statusEl();
    if (currentStatus) currentStatus.textContent = `Applied ${touched.length} level(s) in 1 request`;
    this.recordSheetHistory(`apply ${groupTitle ?? "all map"} tool data to sheet`, sheetId, this.state.tabName, rows, before, updates);
  }
}
