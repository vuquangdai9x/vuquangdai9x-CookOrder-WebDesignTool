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
// other action (a field apply or sheet push) reads from
// that cache instead of re-fetching. Writes for one action (a level's 7
// fields, or every level in "Apply All") go out as a single batched request
// — see data/sheetWrite.ts's batchUpdateCells — so a bulk action never turns
// into one HTTP request per cell. This is what keeps the tab from tripping
// the Sheets API's per-minute rate limit ("Too Many Requests").
//
// Each level renders as two columns — sheet data (left) and tool data
// (right) — one read-only field per REMOTE_LEVEL_FIELDS entry, each with its
// own hover-revealed Apply/Push button that moves just that one field across.
// Whole-level buttons move all configured fields at once. Both
// maps and individual levels fold out (collapsed by default); fold state is
// module-level so it survives switching to Design/Play and back.

import type { LevelSheetRow, RemoteSheetColumns, RemoteSheetMapAliases } from "../../data/sheetSource.ts";
import {
  columnLetter,
  fetchTabValues,
  fetchLevelProgressRows,
  letterToColumn,
  REMOTE_LEVEL_FIELDS,
  REMOTE_SHEET_COLUMNS,
  REMOTE_SHEET_DEFAULT_TAB,
  SheetAuthRequiredError,
  SheetPermissionError,
} from "../../data/sheetSource.ts";
import { REMOTE_KEYS } from "../../data/configLoader.ts";
import {
  canEmailWriteRemoteAuthor,
  CUSTOM_REMOTE_AUTHOR,
  pushedAuthorValue,
  REMOTE_AUTHORS,
  remoteAuthorAssignedLevels,
  remoteAuthorForTable,
} from "../../data/remoteAuthors.ts";
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
import { decompressLevelString, remoteLevelValue } from "../../data/levelCompression.ts";
import { applyRemoteField, applyRemoteFields, tryApplyRemoteFields } from "../../data/remoteLevelFields.ts";
import {
  fetchGoogleAccountIdentity,
  requestAccessTokenInteractive,
  type GoogleAccountIdentity,
} from "../../data/googleAuth.ts";
import { batchUpdateCells } from "../../data/sheetWrite.ts";
import type { CellUpdate } from "../../data/sheetWrite.ts";
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
  /** Set by a successful sheet load from the same OAuth token used for that load. */
  googleAccount: GoogleAccountIdentity | null;
}

const scopedStates = new Map<string, RemoteViewState>();

type RowStatus = "idle" | "loading" | "error";
type FieldKey = (typeof REMOTE_LEVEL_FIELDS)[number]["key"];

/** Each compressed sheet column's readable counterpart, for the sheet-side mismatch notice below. */
const COMPRESSED_RAW_FIELD: Partial<Record<FieldKey, FieldKey>> = {
  customerCompressed: "customerString",
  gridCompressed: "gridString",
  queuesCompressed: "queueString",
};

/** A per-field Push on customers/queues carries its compressed column along, so the sheet's pair never drifts apart. */
const RAW_COMPRESSED_FIELD: Partial<Record<FieldKey, FieldKey>> = {
  customerString: "customerCompressed",
  gridString: "gridCompressed",
  queueString: "queuesCompressed",
};

/**
 * True when a sheet's own compressed cell doesn't decode back to its own
 * readable cell. Display-only: this never touches sheet data (see
 * applyRemoteFields, which already refuses to apply a mismatched pair) —
 * the tool side can't go stale the same way since remoteLevelValue always
 * regenerates it from the current customer/queue strings on read.
 */
function sheetCompressedMismatch(row: LevelSheetRow, rawKey: FieldKey, compressedKey: FieldKey): boolean {
  const raw = row.fields[rawKey];
  const compressed = row.fields[compressedKey];
  if (!raw || !compressed) return false;
  try {
    return decompressLevelString(compressed) !== raw;
  } catch {
    return true;
  }
}

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

/** Identifies local levels that a sheet push cannot update because no destination row exists. */
export function missingRemoteLevelKeys(
  entryKeys: Iterable<string>,
  rows: ReadonlyMap<string, unknown>,
): string[] {
  return [...entryKeys].filter((key) => !rows.has(key));
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
    (field) => (row.fields[field.key] ?? "") === remoteLevelValue(level, field.key),
  )
    ? "Synced"
    : "Edited";
}

export interface LevelAuthorChip {
  prefix: "sheet" | "local" | "sync";
  author: string | null;
}

/** A synced row needs one ownership badge; every other state shows both sides. */
export function levelAuthorChips(
  status: LevelSyncStatus,
  sheetAuthor: string | null | undefined,
  localAuthor: string | null | undefined,
): LevelAuthorChip[] {
  const normalize = (value: string | null | undefined) => value?.trim() || null;
  const sheet = normalize(sheetAuthor);
  const local = normalize(localAuthor);
  return status === "Synced"
    ? [{ prefix: "sync", author: local }]
    : [{ prefix: "sheet", author: sheet }, { prefix: "local", author: local }];
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
  private accountStatusEl!: HTMLElement;
  private toolWriteButtons: HTMLButtonElement[] = [];
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
      googleAccount: null,
    };
    this.state.graphTabName ??= GRAPH_LOOKUP_TAB;
    this.state.graphColumnOverrides ??= { ...GRAPH_LOOKUP_DEFAULT_COLUMNS };
    this.state.graphStartRow ??= GRAPH_LOOKUP_START_ROW;
    this.state.configOpen ??= false;
    this.state.googleAccount ??= null;
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
      ? `This PUSHES tool data to the Google Sheet for ${scope}.\n\nSheet values that differ will be overwritten. Continue?`
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
    return remoteLevelValue(this.level(entry)!, key);
  }

  /** Value sent to a sheet. Author is claimed by named profiles, cleared for custom, and preserved for default. */
  private pushedToolField(entry: LevelEntry, key: FieldKey): string | null {
    const value = this.toolField(entry, key);
    if (value === null || key !== "author") return value;
    return pushedAuthorValue(this.state.tabName, this.level(entry)?.author);
  }

  private toolWritePermissionError(): string | null {
    const account = this.state.googleAccount;
    if (!account) return "Load from sheet first so Google can verify your email.";
    if (!account.emailVerified) return `Google has not verified ${account.email}; tool data cannot be written.`;
    const profile = remoteAuthorForTable(this.state.tabName);
    if (profile && !canEmailWriteRemoteAuthor(profile, account.email)) {
      return `${account.email} is not allowed to write to ${profile.name}'s sheet.`;
    }
    return null;
  }

  private refreshToolWritePermission(): void {
    if (!this.accountStatusEl) return;
    const account = this.state.googleAccount;
    const error = this.toolWritePermissionError();
    this.accountStatusEl.textContent = account ? `Google: ${account.email}` : "Google email: load sheet to verify";
    this.accountStatusEl.className = `remote-account-status${error ? " denied" : " allowed"}`;
    this.accountStatusEl.title = error ?? "This verified Google account may write to the selected author sheet.";
    for (const writeButton of this.toolWriteButtons) {
      writeButton.disabled = error !== null;
      writeButton.title = error ?? writeButton.dataset.allowedTitle ?? writeButton.title;
    }
    // Row/field buttons have extra eligibility rules (live level, available value).
    for (const refresh of this.refreshRowByKey.values()) refresh();
  }

  private requireToolWritePermission(): boolean {
    const error = this.toolWritePermissionError();
    if (!error) return true;
    alert(error);
    return false;
  }

  private registerToolWriteButton(buttonEl: HTMLButtonElement): HTMLButtonElement {
    buttonEl.dataset.allowedTitle = buttonEl.title;
    this.toolWriteButtons.push(buttonEl);
    return buttonEl;
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
    const map = this.mapFor(entry)!;
    applyRemoteField(level, key, value, map.gridWidth * map.gridHeight);
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
      const [rows, account] = await Promise.all([
        fetchLevelProgressRows(
          sheetId,
          token,
          this.state.tabName,
          this.state.columnOverrides,
          this.state.startRow,
          this.options.sheetMapAliases,
        ),
        fetchGoogleAccountIdentity(token),
      ]);
      return { rows, account };
    });
    if (result === null) return null;
    this.state.googleAccount = result.account;
    this.state.rowsCache = { cacheKey: key, rows: result.rows };
    this.refreshToolWritePermission();
    this.rebuildGroupsFromRows();
    return result.rows;
  }

  private build(): void {
    this.toolWriteButtons = [];
    this.refreshRowByKey.clear();
    this.setRowStatusByKey.clear();
    this.groupStatusByTitle.clear();
    const page = el("div", { class: "remote-page" });
    page.tabIndex = 0;
    bindUndoRedoKeys(page, { undo: () => void this.runHistory("undo"), redo: () => void this.runHistory("redo") });

    this.pageStatusEl = el("span", { class: "remote-status" }, []);
    this.accountStatusEl = el("span", { class: "remote-account-status" }, []);
    const sheetIdInput = el("input", {
      type: "text",
      value: this.getSheetId(),
      placeholder: "Paste a spreadsheet ID…",
      class: "sheet-id-input remote-long-input",
    }) as HTMLInputElement;
    sheetIdInput.addEventListener("change", () => {
      this.setSheetId(sheetIdInput.value.trim());
      sheetIdInput.value = this.getSheetId();
      for (const refresh of this.refreshRowByKey.values()) refresh();
    });
    const tabNameInput = el("input", { type: "text", value: this.state.tabName, class: "sheet-id-input remote-long-input" }) as HTMLInputElement;
    const authorSelect = el("select", {
      class: "remote-author-select",
      "aria-label": "Author",
    }) as HTMLSelectElement;
    for (const author of REMOTE_AUTHORS) {
      const option = el("option", { value: author.author }, [`${author.emoji} ${author.name}`]) as HTMLOptionElement;
      option.style.color = author.colorTheme;
      authorSelect.append(option);
    }
    authorSelect.append(el("option", { value: CUSTOM_REMOTE_AUTHOR }, ["🎨 Custom"]));
    const syncAuthorSelect = (table: string) => {
      const author = remoteAuthorForTable(table);
      authorSelect.value = author?.author ?? CUSTOM_REMOTE_AUTHOR;
      authorSelect.style.setProperty("--remote-author-color", author?.colorTheme ?? "var(--muted)");
      authorSelect.title = author ? `${author.emoji} ${author.name} — ${author.table}` : "Custom sheet name";
    };
    syncAuthorSelect(this.state.tabName);
    authorSelect.addEventListener("change", () => {
      const author = REMOTE_AUTHORS.find((candidate) => candidate.author === authorSelect.value);
      if (!author) {
        syncAuthorSelect(tabNameInput.value);
        return;
      }
      this.state.tabName = author.table;
      tabNameInput.value = author.table;
      syncAuthorSelect(author.table);
      this.refreshToolWritePermission();
      for (const refresh of this.refreshRowByKey.values()) refresh();
    });
    tabNameInput.addEventListener("input", () => syncAuthorSelect(tabNameInput.value));
    tabNameInput.addEventListener("change", () => {
      this.state.tabName = tabNameInput.value.trim() || this.defaultTabName;
      tabNameInput.value = this.state.tabName;
      syncAuthorSelect(this.state.tabName);
      this.refreshToolWritePermission();
      for (const refresh of this.refreshRowByKey.values()) refresh();
    });
    const graphTabNameInput = el("input", {
      type: "text",
      value: this.state.graphTabName,
      class: "sheet-id-input remote-long-input",
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
        "Column letters and data start rows are editable when the remote sheet layout differs.",
      ]),
      el("h3", { class: "remote-config-heading" }, ["MapLevelProgress"]),
      el("div", { class: "remote-sheet-config" }, [
        el("label", { class: "field small" }, ["Start row", startRowInput]),
        ...columnFields,
      ]),
    ];
    if (this.options.graphLookupMaps) {
      configChildren.push(
        el("h3", { class: "remote-config-heading" }, ["GraphLookupData"]),
        el("div", { class: "remote-sheet-config" }, [
          el("label", { class: "field small" }, ["Sheet name", graphTabNameInput]),
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
          button("⬇ Fetch Assigned Level", () => void this.fetchAssignedLevels(), {
            class: "small-btn",
            title: "Load Tan and Linh assigned levels using the default sheet as the level roster",
          }),
          this.undoBtn,
          this.redoBtn,
        ]),
        el("div", { class: "remote-sheet-config" }, [
          el("label", { class: "field small" }, ["Sheet ID", sheetIdInput]),
          el("label", { class: "field small" }, ["Author", authorSelect]),
          el("label", { class: "field small" }, ["MapLevelProgress sheet name", tabNameInput]),
        ]),
        configDetails,
        el("div", { class: "remote-buttons" }, [
          button("⬇ Load All from sheet", () => void this.runAll("load"), { class: "full-btn" }),
          button("→ Apply All sheet data", () => void this.runAll("sheet-to-tool"), { class: "full-btn" }),
          this.registerToolWriteButton(button("↑ Push all data to sheet", () => void this.runAll("tool-to-sheet"), {
            class: "full-btn",
            title: "Write tool data to the selected author sheet",
          })),
          ...graphButtons,
          this.pageStatusEl,
          this.accountStatusEl,
        ]),
      ]),
    );

    for (const group of this.groups) page.append(this.groupEl(group));
    this.refreshToolWritePermission();
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
      this.registerToolWriteButton(button("↑ Push data to sheet", () => void this.runAll("tool-to-sheet", group), {
        title: `Write tool data for ${group.title} to the selected author sheet`,
      })),
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
    const authorChipsEl = el("span", { class: "remote-author-chips" }, []);
    let rowElement: HTMLElement | null = null;

    const loadBtn = button("Fetch", () => void this.loadRow(entry), {
      class: "small-btn",
      title: "Re-fetch the whole sheet and refresh this level (and every other open one)",
    });
    const openBtn = button("Design", () => {
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
    const applyToolBtn = this.registerToolWriteButton(button("Push to sheet", () => void this.applyLevelToolToSheet(entry), {
      class: "small-btn",
      title: "Write every field from this level's live draft to the sheet, in one request",
    }) as HTMLButtonElement);

    const sheetFields = REMOTE_LEVEL_FIELDS.map((f) =>
      this.fieldEl(f.label, "sheet", () => this.applyFieldSheetToTool(entry, f.key), !(f.key in COMPRESSED_RAW_FIELD)),
    );
    const toolFields = REMOTE_LEVEL_FIELDS.map((f) =>
      this.fieldEl(f.label, "tool", () => void this.applyFieldToolToSheet(entry, f.key), !(f.key in COMPRESSED_RAW_FIELD)),
    );

    const refresh = () => {
      const row = this.currentRows()?.get(entry.key) ?? null;
      const liveNow = this.isLive(entry);
      rowElement?.classList.toggle("live", liveNow);
      openBtn.disabled = !liveNow;

      REMOTE_LEVEL_FIELDS.forEach((f, i) => {
        const sf = sheetFields[i];
        sf.box.classList.toggle("remote-box-empty", row === null);
        const rawKey = COMPRESSED_RAW_FIELD[f.key];
        const mismatched = row && rawKey ? sheetCompressedMismatch(row, rawKey, f.key) : false;
        sf.box.classList.toggle("remote-box-mismatch", mismatched);
        sf.box.title = mismatched ? `${f.label} doesn't decode to match the sheet's readable field — sheet left unchanged.` : "";
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
        tf.applyBtn.disabled = row === null || toolVal === null || this.toolWritePermissionError() !== null;
      });

      applySheetBtn.disabled = row === null || !this.canApplySheet(entry);
      applyToolBtn.disabled = row === null || !liveNow || this.toolWritePermissionError() !== null;

      const loadedRows = this.currentRows();
      const syncStatus = levelSyncStatus(loadedRows !== null, row, this.level(entry));
      syncStatusEl.textContent = syncStatus;
      syncStatusEl.className = `remote-sync-status ${syncStatus.toLowerCase()}`;
      authorChipsEl.replaceChildren(...levelAuthorChips(
        syncStatus,
        row?.fields.author,
        this.level(entry)?.author,
      ).map(({ prefix, author }) => {
        const profile = REMOTE_AUTHORS.find((candidate) => candidate.author.toLowerCase() === author?.toLowerCase());
        const chip = el("span", { class: "remote-author-chip" }, [
          `${prefix}: ${profile?.emoji ?? (author ? "✍️" : "—")} ${profile?.name ?? author ?? ""}`.trim(),
        ]);
        chip.style.setProperty("--remote-author-chip-color", profile?.colorTheme ?? "#94a3b8");
        chip.title = `${prefix === "sheet" ? "Sheet" : prefix === "local" ? "Local tool" : "Synced"} author: ${profile?.name ?? author ?? "none"}`;
        return chip;
      }));
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
      el("code", { title: entry.key }, [`Lv.${entry.levelIndex}`]),
      syncStatusEl,
      authorChipsEl,
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
    rowElement = row;

    this.setRowStatusByKey.set(entry.key, (status, error) => {
      statusEl.textContent = status === "loading" ? "…" : status === "error" ? "⚠" : "";
      statusEl.title = error ?? "";
      row.classList.toggle("remote-row-error", status === "error");
      const busy = status === "loading";
      loadBtn.disabled = busy;
      applySheetBtn.disabled = busy || !this.canApplySheet(entry);
      applyToolBtn.disabled = busy || !this.currentRows()?.has(entry.key)
        || !this.isLive(entry) || this.toolWritePermissionError() !== null;
      if (!busy) refresh(); // re-derive field content + correct enabled/disabled from live state
    });

    return row;
  }

  /**
   * One field row (label + read-only box + hover-revealed Apply button) for
   * either column. Compressed columns get no Apply button of their own —
   * they're display-only and only ever move alongside their readable
   * counterpart (see RAW_COMPRESSED_FIELD / applyFieldToolToSheet and the
   * refreshLevelCompression call inside applyRemoteField).
   */
  private fieldEl(
    label: string,
    side: "sheet" | "tool",
    onApply: () => void,
    allowApply: boolean,
  ): { element: HTMLElement; box: HTMLElement; applyBtn: HTMLButtonElement } {
    const box = el("div", { class: "remote-box" }, []);
    const applyBtn = button(side === "sheet" ? "Apply" : "Push", onApply, {
      class: "small-btn remote-field-apply",
      title: side === "sheet" ? `Apply this sheet value to the tool (${label})` : `Push this tool value to the sheet (${label})`,
    }) as HTMLButtonElement;
    if (side === "tool") this.registerToolWriteButton(applyBtn);
    const element = el("div", { class: "remote-field" }, [
      el("div", { class: "remote-field-label" }, [label]),
      el("div", { class: "remote-field-content" }, allowApply ? [box, applyBtn] : [box]),
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
    levelsBefore?: Record<string, LevelData[]>,
  ): void {
    const sheetChanged = !before.every((cell, index) => cell.value === after[index]?.value);
    const levelsAfter = levelsBefore ? this.captureLevels() : undefined;
    const levelsChanged = levelsBefore !== undefined && JSON.stringify(levelsBefore) !== JSON.stringify(levelsAfter);
    if (!sheetChanged && !levelsChanged) return;
    const apply = async (updates: CellUpdate[], levels?: Record<string, LevelData[]>) => {
      if (sheetChanged) {
        await batchUpdateCells(sheetId, tabName, updates);
        this.updateCachedLevelCells(updates, rows);
      }
      if (levels) this.restoreLevels(levels);
    };
    this.recordHistory({
      label,
      undo: () => apply(before, levelsBefore),
      redo: () => apply(after, levelsAfter),
    });
  }

  /** Mirror the author value claimed by a successful sheet push back into live tool data. */
  private applyPushedAuthorsToTool(entries: readonly LevelEntry[]): void {
    const profile = remoteAuthorForTable(this.state.tabName);
    if (profile?.author === "default") return;
    const nextAuthor = profile?.author ?? null;
    const changedMaps = new Set<string>();
    for (const entry of entries) {
      const level = this.level(entry);
      if (!level || level.author === nextAuthor) continue;
      level.author = nextAuthor;
      changedMaps.add(entry.mapId);
    }
    for (const mapId of changedMaps) {
      const representative = entries.find((entry) => entry.mapId === mapId);
      if (representative) this.notifyLevelChanged(representative);
    }
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

  /** Resolve a semantic map id back to the numeric map used by author assignments. */
  private assignmentMapNumber(mapId: string): number | null {
    const numericAlias = Object.entries(this.options.sheetMapAliases ?? {}).find(([key, value]) =>
      /^\d+$/.test(key) && value.toLowerCase() === mapId.toLowerCase()
    );
    if (numericAlias) return Number(numericAlias[0]);
    const configuredIndex = REMOTE_KEYS.maps.findIndex((map) => map.mapId.toLowerCase() === mapId.toLowerCase());
    return configuredIndex >= 0 ? configuredIndex + 1 : null;
  }

  /**
   * The default sheet is the roster: only map/level rows that exist there are
   * eligible. Their assigned content is then loaded from Tan's or Linh's sheet.
   */
  private async fetchAssignedLevels(): Promise<void> {
    const sheetId = this.getSheetId().trim();
    if (!sheetId) {
      alert("Paste a spreadsheet ID into the Sheet ID field first.");
      return;
    }
    const defaultProfile = REMOTE_AUTHORS.find((author) => author.author === "default");
    const assignedProfiles = REMOTE_AUTHORS.filter((author) => author.author === "tantd" || author.author === "linhnth");
    if (!defaultProfile || assignedProfiles.length !== 2) {
      alert("Default, Tan, or Linh author configuration is missing.");
      return;
    }
    this.pageStatusEl.textContent = "Fetching assigned levels…";
    const loaded = await this.withToken(async () => {
      const token = await requestAccessTokenInteractive();
      const [account, defaultRows, ...assignedRows] = await Promise.all([
        fetchGoogleAccountIdentity(token),
        fetchLevelProgressRows(
          sheetId,
          token,
          defaultProfile.table,
          this.state.columnOverrides,
          this.state.startRow,
          this.options.sheetMapAliases,
        ),
        ...assignedProfiles.map((profile) => fetchLevelProgressRows(
          sheetId,
          token,
          profile.table,
          this.state.columnOverrides,
          this.state.startRow,
          this.options.sheetMapAliases,
        )),
      ]);
      return { account, defaultRows, assignedRows };
    });
    if (!loaded) {
      this.pageStatusEl.textContent = "Assigned-level fetch failed";
      return;
    }
    this.state.googleAccount = loaded.account;
    const rowsByAuthor = new Map(assignedProfiles.map((profile, index) => [profile.author, loaded.assignedRows[index]]));
    const before = this.captureLevels();
    const changedMapIds = new Set<string>();
    let applied = 0;
    let missing = 0;
    const invalid: string[] = [];
    for (const [key, rosterRow] of loaded.defaultRows) {
      const mapNumber = this.assignmentMapNumber(rosterRow.mapId);
      if (mapNumber === null) continue;
      const owner = assignedProfiles.find((profile) => remoteAuthorAssignedLevels(profile, mapNumber).has(rosterRow.level));
      if (!owner) continue;
      const assignedRow = rowsByAuthor.get(owner.author)?.get(key);
      if (!assignedRow) {
        missing++;
        continue;
      }
      const entry: LevelEntry = { key, mapId: rosterRow.mapId, levelIndex: rosterRow.level };
      const existed = this.isLive(entry);
      if (!this.ensureLevel(entry)) continue;
      const map = this.mapFor(entry)!;
      const result = tryApplyRemoteFields(this.level(entry)!, assignedRow.fields, map.gridWidth * map.gridHeight);
      if (!result.ok) {
        if (!existed) {
          const index = map.levels.findIndex((level) => level.id === entry.levelIndex);
          if (index >= 0) map.levels.splice(index, 1);
        }
        invalid.push(`${owner.name} · ${entry.mapId} Lv.${entry.levelIndex}: ${result.error.message}`);
        continue;
      }
      changedMapIds.add(entry.mapId);
      applied++;
    }
    for (const mapId of changedMapIds) {
      const representative = this.groups.flatMap((group) => group.entries).find((entry) => entry.mapId === mapId)
        ?? { key: "", mapId, levelIndex: 1 };
      this.notifyLevelChanged(representative);
    }
    this.recordLevelHistory("fetch assigned levels", before);
    this.groups = this.buildGroups();
    this.build();
    this.pageStatusEl.textContent = `Fetched ${applied} assigned level(s)${
      missing ? ` · ${missing} missing assigned row(s)` : ""
    }${invalid.length ? ` · skipped ${invalid.length} invalid row(s)` : ""}`;
    this.pageStatusEl.title = invalid.join("\n");
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
    try {
      const map = this.mapFor(entry)!;
      applyRemoteFields(this.level(entry)!, row.fields, map.gridWidth * map.gridHeight);
    } catch (err) {
      this.restoreLevels(before);
      this.showRequestError("Could not apply level", err);
      return;
    }
    this.notifyLevelChanged(entry);
    this.refreshRowByKey.get(entry.key)?.();
    this.recordLevelHistory(`apply sheet to ${entry.key}`, before);
  }

  /** Pushes every field from the tool's live level onto the sheet, in one batched request. */
  private async applyLevelToolToSheet(entry: LevelEntry): Promise<void> {
    if (!this.requireToolWritePermission()) return;
    const sheetId = this.getSheetId();
    if (!sheetId.trim()) {
      alert("Paste a spreadsheet ID into the Sheet ID field first.");
      return;
    }
    if (!this.isLive(entry)) return;
    const levelsBefore = this.captureLevels();
    this.setRowStatusByKey.get(entry.key)?.("loading");
    const rows = await this.ensureRows(false);
    if (rows === null) {
      this.setRowStatusByKey.get(entry.key)?.("error", "push failed");
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
      value: this.pushedToolField(entry, f.key) ?? "",
    }));
    const before: CellUpdate[] = REMOTE_LEVEL_FIELDS.map((f) => ({
      row: row.rowNumber,
      col: this.state.columnOverrides[f.key],
      value: row.fields[f.key] ?? "",
    }));
    const ok = await this.withToken(() => batchUpdateCells(sheetId, this.state.tabName, updates));
    if (ok === null) {
      this.setRowStatusByKey.get(entry.key)?.("error", "push failed");
      return;
    }
    for (const f of REMOTE_LEVEL_FIELDS) row.fields[f.key] = this.pushedToolField(entry, f.key) ?? "";
    this.applyPushedAuthorsToTool([entry]);
    this.setRowStatusByKey.get(entry.key)?.("idle");
    this.recordSheetHistory(`push ${entry.key} to sheet`, sheetId, this.state.tabName, rows, before, updates, levelsBefore);
  }

  /** Pushes one sheet field onto the tool's corresponding LevelData property — no network (reads the cache). */
  private applyFieldSheetToTool(entry: LevelEntry, fieldKey: FieldKey): void {
    const row = this.currentRows()?.get(entry.key);
    if (!row) return;
    const before = this.captureLevels();
    if (!this.ensureLevel(entry)) return;
    try {
      this.setToolField(entry, fieldKey, row.fields[fieldKey] ?? "");
    } catch (err) {
      this.restoreLevels(before);
      this.showRequestError("Could not apply field", err);
      return;
    }
    this.notifyLevelChanged(entry);
    this.refreshRowByKey.get(entry.key)?.();
    this.recordLevelHistory(`apply ${fieldKey} to ${entry.key}`, before);
  }

  /**
   * Pushes one tool field onto the sheet — a single batched write. Customers
   * and queues carry their compressed column along (see RAW_COMPRESSED_FIELD)
   * so the sheet's readable/compressed pair never drifts apart.
   */
  private async applyFieldToolToSheet(entry: LevelEntry, fieldKey: FieldKey): Promise<void> {
    if (!this.requireToolWritePermission()) return;
    const sheetId = this.getSheetId();
    if (!sheetId.trim()) {
      alert("Paste a spreadsheet ID into the Sheet ID field first.");
      return;
    }
    const value = this.pushedToolField(entry, fieldKey);
    if (value === null) return;
    const levelsBefore = this.captureLevels();
    this.setRowStatusByKey.get(entry.key)?.("loading");
    const rows = await this.ensureRows(false);
    if (rows === null) {
      this.setRowStatusByKey.get(entry.key)?.("error", "push failed");
      return;
    }
    const row = rows.get(entry.key);
    if (!row) {
      this.setRowStatusByKey.get(entry.key)?.("error", "no sheet row for this level yet");
      return;
    }
    const compressedKey = RAW_COMPRESSED_FIELD[fieldKey];
    const keys = [...new Set<FieldKey>(compressedKey ? [fieldKey, compressedKey, "author"] : [fieldKey, "author"])];
    const updates = keys.map((key) => ({ row: row.rowNumber, col: this.state.columnOverrides[key], value: this.pushedToolField(entry, key) ?? "" }));
    const before = keys.map((key) => ({ row: row.rowNumber, col: this.state.columnOverrides[key], value: row.fields[key] ?? "" }));
    const ok = await this.withToken(() => batchUpdateCells(sheetId, this.state.tabName, updates));
    if (ok === null) {
      this.setRowStatusByKey.get(entry.key)?.("error", "push failed");
      return;
    }
    for (const key of keys) row.fields[key] = this.pushedToolField(entry, key) ?? "";
    this.applyPushedAuthorsToTool([entry]);
    this.setRowStatusByKey.get(entry.key)?.("idle");
    this.recordSheetHistory(`push ${fieldKey} from ${entry.key} to sheet`, sheetId, this.state.tabName, rows, before, updates, levelsBefore);
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
    if (action === "tool-to-sheet" && !this.requireToolWritePermission()) return;
    if (action === "sheet-to-tool" && !this.confirmOverwrite(action, group)) return;
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
      const invalid: string[] = [];
      const appliedMapIds = new Set<string>();
      for (const e of entries) {
        const row = rows.get(e.key);
        if (!row) continue;
        const existed = this.isLive(e);
        if (!this.ensureLevel(e)) continue;
        const map = this.mapFor(e)!;
        const result = tryApplyRemoteFields(this.level(e)!, row.fields, map.gridWidth * map.gridHeight);
        if (!result.ok) {
          // ensureLevel may have inserted a new draft for this row. Do not
          // leave that empty shell behind when the sheet data is invalid.
          if (!existed) {
            const index = map.levels.findIndex((level) => level.id === e.levelIndex);
            if (index >= 0) map.levels.splice(index, 1);
          }
          invalid.push(`${e.mapId} Lv.${e.levelIndex}: ${result.error.message}`);
          continue;
        }
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
      if (currentStatus) {
        currentStatus.textContent = `Applied ${applied} level(s)${invalid.length ? ` · skipped ${invalid.length} invalid row(s)` : ""}`;
        currentStatus.title = invalid.join("\n");
      }
      this.recordLevelHistory(`apply sheet data to ${groupTitle ?? "all maps"}`, before);
      return;
    }

    // tool-to-sheet: gather every changed cell across every live entry, then
    // write them all in exactly one request.
    const liveEntries = entries.filter((entry) => this.isLive(entry));
    const missingKeys = missingRemoteLevelKeys(liveEntries.map((entry) => entry.key), rows);
    if (!this.confirmOverwrite("tool-to-sheet", group)) {
      const cancelledStatus = statusEl();
      if (cancelledStatus) cancelledStatus.textContent = "";
      return;
    }
    const sheetId = this.getSheetId();
    if (!sheetId.trim()) {
      alert("Paste a spreadsheet ID into the Sheet ID field first.");
      const currentStatus = statusEl();
      if (currentStatus) currentStatus.textContent = "";
      return;
    }
    const updates: CellUpdate[] = [];
    const before: CellUpdate[] = [];
    const levelsBefore = this.captureLevels();
    const touched: { entry: LevelEntry; row: LevelSheetRow }[] = [];
    for (const e of liveEntries) {
      const row = rows.get(e.key);
      if (!row) continue;
      for (const f of REMOTE_LEVEL_FIELDS) {
        updates.push({ row: row.rowNumber, col: this.state.columnOverrides[f.key], value: this.pushedToolField(e, f.key) ?? "" });
        before.push({ row: row.rowNumber, col: this.state.columnOverrides[f.key], value: row.fields[f.key] ?? "" });
      }
      touched.push({ entry: e, row });
    }
    if (updates.length === 0) {
      const currentStatus = statusEl();
      if (currentStatus) currentStatus.textContent = missingKeys.length
        ? `Nothing pushed · skipped ${missingKeys.length} missing row(s)`
        : "Nothing to push";
      return;
    }
    const ok = await this.withToken(() => batchUpdateCells(sheetId, this.state.tabName, updates));
    if (ok === null) {
      const currentStatus = statusEl();
      if (currentStatus) currentStatus.textContent = "Apply failed";
      return;
    }
    for (const { entry, row } of touched) {
      for (const f of REMOTE_LEVEL_FIELDS) row.fields[f.key] = this.pushedToolField(entry, f.key) ?? "";
    }
    this.applyPushedAuthorsToTool(touched.map(({ entry }) => entry));
    for (const e of entries) this.refreshRowByKey.get(e.key)?.();
    const currentStatus = statusEl();
    if (currentStatus) currentStatus.textContent = `Pushed ${touched.length} level(s) in 1 request${
      missingKeys.length ? ` · skipped ${missingKeys.length} missing row(s)` : ""
    }`;
    this.recordSheetHistory(
      `push ${groupTitle ?? "all map"} tool data to sheet`,
      sheetId,
      this.state.tabName,
      rows,
      before,
      updates,
      levelsBefore,
    );
  }
}
