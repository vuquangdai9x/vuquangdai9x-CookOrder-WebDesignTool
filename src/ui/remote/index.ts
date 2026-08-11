// "Remote Data" mode: a side-by-side sheet/tool diff view for level data,
// backed by the same Google Sheet tab Unity's
// RemoteConfigDefaultSetterCakeOrder.cs reads (RemoteConfigData, columns
// D/E — see data/sheetSource.ts's REMOTE_CONFIG_TAB). Global config blocks
// and per-map definition tables (tool/recipe_piece/etc.) are NOT shown here
// — this tab is scoped to level content only (map_config_{map}_lv_{n}).
//
// Each level's sheet cell is a single "~"-joined string covering 7 fields, in
// this fixed order — see FIELDS below: the four design-time Auto Generate
// records (ingredientWeights/customerDishesSequence/complexityCurve/
// shuffleCurve, added alongside the Customer/Queue section "level params
// bar") followed by the three canonical customer/grid/queue strings that
// were always here. Each level renders as two columns — sheet data (left)
// and tool data (right) — one read-only field per FIELDS entry, each with
// its own hover-revealed Apply button that pushes just that one field across
// (sheet field -> tool, or tool field -> sheet, preserving the other 6
// fields on whichever side is being written to).

import { REMOTE_KEYS } from "../../data/configLoader.ts";
import type { LevelData, MapData } from "../../data/mapLoader.ts";
import { requestAccessTokenInteractive } from "../../data/googleAuth.ts";
import {
  fetchRemoteConfigRows,
  SheetAuthRequiredError,
  SheetPermissionError,
} from "../../data/sheetSource.ts";
import { updateRemoteConfigValue } from "../../data/sheetWrite.ts";
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

/** One "~"-joined slot in a level's combined sheet value, in on-sheet order. */
interface FieldSpec {
  label: string;
  key: keyof Pick<
    LevelData,
    "ingredientWeights" | "customerDishesSequence" | "complexityCurve" | "shuffleCurve" | "customerString" | "gridString" | "queueString"
  >;
}

const FIELDS: FieldSpec[] = [
  { label: "Ingredient Weights", key: "ingredientWeights" },
  { label: "Customer Dishes Sequence", key: "customerDishesSequence" },
  { label: "Complexity Curve", key: "complexityCurve" },
  { label: "Shuffle Curve", key: "shuffleCurve" },
  { label: "Customers", key: "customerString" },
  { label: "Grid", key: "gridString" },
  { label: "Queues", key: "queueString" },
];

/** Splits a combined "~"-joined value into exactly FIELDS.length parts, padding with "" if short. */
function splitFields(value: string): string[] {
  const parts = value.split("~");
  while (parts.length < FIELDS.length) parts.push("");
  return parts;
}

function joinFields(parts: string[]): string {
  return parts.join("~");
}

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
  private onLevelChanged: () => void;
  private groups: Group[];
  /** Last full combined value fetched from the sheet per key — undefined until a Load runs once. */
  private sheetValueByKey = new Map<string, string>();
  private refreshRowByKey = new Map<string, () => void>();
  private setRowStatusByKey = new Map<string, (status: RowStatus, error?: string) => void>();
  private groupStatusByTitle = new Map<string, HTMLElement>();
  private pageStatusEl!: HTMLElement;

  constructor(root: HTMLElement, map: MapData, getSheetId: () => string, onLevelChanged: () => void) {
    this.root = root;
    this.map = map;
    this.getSheetId = getSheetId;
    this.onLevelChanged = onLevelChanged;
    this.groups = buildGroups();
    this.build();
  }

  private isLive(entry: LevelEntry): boolean {
    return entry.mapId === this.map.name && this.map.levels.some((l) => l.id === entry.levelIndex);
  }

  private level(entry: LevelEntry): LevelData | undefined {
    return this.map.levels.find((l) => l.id === entry.levelIndex);
  }

  /** The live tool-side combined value, or null when this map/level isn't the one currently loaded. */
  private toolValue(entry: LevelEntry): string | null {
    if (!this.isLive(entry)) return null;
    const level = this.level(entry)!;
    return joinFields(FIELDS.map((f) => level[f.key] ?? ""));
  }

  private applyToolValue(entry: LevelEntry, value: string): void {
    const level = this.level(entry);
    if (!level) return;
    const parts = splitFields(value);
    FIELDS.forEach((f, i) => {
      (level as unknown as Record<string, string>)[f.key] = parts[i] ?? "";
    });
  }

  private build(): void {
    const page = el("div", { class: "remote-page" });

    this.pageStatusEl = el("span", { class: "remote-status" }, []);
    page.append(
      el("div", { class: "remote-page-actions" }, [
        el("h2", {}, ["Remote Data"]),
        el("p", { class: "remote-hint" }, [
          "Level data, diffed against the \"RemoteConfigData\" tab of the linked Google Sheet — the same tab Unity's RemoteConfigDefaultSetterCakeOrder.cs reads. Only ",
          this.map.name,
          "'s levels have live tool data to compare against; other maps can still be loaded from the sheet for reference. Hover a field to apply just that one.",
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
    const header = el("div", { class: "remote-group-header" }, [
      el("h3", {}, [group.title]),
      button("⬇ Load All", () => void this.runAll("load", group), {}),
      button("→ Apply sheet data", () => void this.runAll("sheet-to-tool", group), {}),
      button("← Apply tool data", () => void this.runAll("tool-to-sheet", group), {}),
      statusEl,
    ]);
    const rows = el("div", { class: "remote-rows" }, group.entries.map((entry) => this.rowEl(entry)));
    return el("div", { class: "remote-group" }, [header, rows]);
  }

  private rowEl(entry: LevelEntry): HTMLElement {
    const live = this.isLive(entry);
    const statusEl = el("span", { class: "remote-status" }, []);

    const loadBtn = button("⬇ Load", () => void this.loadFromSheet(entry), {
      class: "small-btn",
      title: "Fetch this level's combined value from the sheet",
    });

    const sheetFields = FIELDS.map((f, i) => this.fieldEl(f, "sheet", () => this.applyFieldSheetToTool(entry, i)));
    const toolFields = FIELDS.map((f, i) => this.fieldEl(f, "tool", () => void this.applyFieldToolToSheet(entry, i)));

    const refresh = () => {
      const sheetVal = this.sheetValueByKey.get(entry.key);
      const toolVal = this.toolValue(entry);
      const sheetParts = sheetVal !== undefined ? splitFields(sheetVal) : null;
      const toolParts = toolVal !== null ? splitFields(toolVal) : null;

      FIELDS.forEach((_, i) => {
        const sf = sheetFields[i];
        sf.box.classList.toggle("remote-box-empty", sheetParts === null);
        sf.box.textContent = sheetParts ? sheetParts[i] || "(empty)" : "(not loaded)";
        sf.applyBtn.disabled = sheetParts === null || !live;

        const tf = toolFields[i];
        tf.box.classList.remove("remote-box-empty", "remote-box-diff");
        if (toolParts === null) {
          tf.box.classList.add("remote-box-empty");
          tf.box.textContent = "(not this map)";
        } else if (sheetParts === null || sheetParts[i] === toolParts[i]) {
          tf.box.textContent = toolParts[i] || "(empty)";
        } else {
          tf.box.classList.add("remote-box-diff");
          tf.box.replaceChildren(
            ...diffChars(sheetParts[i], toolParts[i]).map((seg) =>
              seg.changed ? el("span", { class: "remote-diff-changed" }, [seg.text]) : seg.text,
            ),
          );
        }
        tf.applyBtn.disabled = toolParts === null;
      });
    };
    refresh();
    this.refreshRowByKey.set(entry.key, refresh);

    const row = el("div", { class: `remote-row${live ? " live" : ""}` }, [
      el("div", { class: "remote-row-label" }, [
        el("code", {}, [entry.key]),
        live ? el("span", { class: "remote-live-badge" }, ["live level"]) : "",
        el("span", { class: "spacer" }, []),
        loadBtn,
        statusEl,
      ]),
      el("div", { class: "remote-row-columns" }, [
        el("div", { class: "remote-col" }, [
          el("div", { class: "remote-col-label" }, ["Sheet data"]),
          ...sheetFields.map((f) => f.element),
        ]),
        el("div", { class: "remote-col" }, [
          el("div", { class: "remote-col-label" }, ["Tool data"]),
          ...toolFields.map((f) => f.element),
        ]),
      ]),
    ]);

    this.setRowStatusByKey.set(entry.key, (status, error) => {
      statusEl.textContent = status === "loading" ? "…" : status === "error" ? "⚠" : "";
      statusEl.title = error ?? "";
      row.classList.toggle("remote-row-error", status === "error");
      const busy = status === "loading";
      loadBtn.disabled = busy;
      if (!busy) refresh(); // re-derive field content + correct enabled/disabled from live state
    });

    return row;
  }

  /** One field row (label + read-only box + hover-revealed Apply button) for either column. */
  private fieldEl(
    field: FieldSpec,
    side: "sheet" | "tool",
    onApply: () => void,
  ): { element: HTMLElement; box: HTMLElement; applyBtn: HTMLButtonElement } {
    const box = el("div", { class: "remote-box" }, []);
    const applyBtn = button("Apply", onApply, {
      class: "small-btn remote-field-apply",
      title: side === "sheet" ? `Apply this sheet value to the tool (${field.label})` : `Apply this tool value to the sheet (${field.label})`,
    }) as HTMLButtonElement;
    const element = el("div", { class: "remote-field" }, [
      el("div", { class: "remote-field-label" }, [field.label]),
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

  private async loadFromSheet(entry: LevelEntry): Promise<void> {
    const sheetId = this.getSheetId();
    if (!sheetId.trim()) {
      alert("Paste a spreadsheet ID into the Sheet ID field first.");
      return;
    }
    const setStatus = this.setRowStatusByKey.get(entry.key);
    setStatus?.("loading");
    const result = await this.withToken(async () => {
      const token = await requestAccessTokenInteractive();
      const rows = await fetchRemoteConfigRows(sheetId, token);
      const row = rows.get(entry.key);
      if (!row) throw new Error(`Key "${entry.key}" not found in the sheet`);
      return row.value;
    });
    if (result === null) {
      setStatus?.("error", "load failed");
      return;
    }
    this.sheetValueByKey.set(entry.key, result);
    setStatus?.("idle");
  }

  /** Applies every field from the sheet's last-loaded value onto the tool's live level. */
  private applySheetToTool(entry: LevelEntry): void {
    const sheetVal = this.sheetValueByKey.get(entry.key);
    if (sheetVal === undefined || !this.isLive(entry)) return;
    this.applyToolValue(entry, sheetVal);
    this.onLevelChanged();
    this.refreshRowByKey.get(entry.key)?.();
  }

  /** Applies every field from the tool's live level onto the sheet, in one write. */
  private async applyToolToSheet(entry: LevelEntry): Promise<void> {
    const sheetId = this.getSheetId();
    if (!sheetId.trim()) {
      alert("Paste a spreadsheet ID into the Sheet ID field first.");
      return;
    }
    const toolVal = this.toolValue(entry);
    if (toolVal === null) return;
    const setStatus = this.setRowStatusByKey.get(entry.key);
    setStatus?.("loading");
    const ok = await this.withToken(async () => {
      const token = await requestAccessTokenInteractive();
      const rows = await fetchRemoteConfigRows(sheetId, token);
      const row = rows.get(entry.key);
      if (!row) throw new Error(`Key "${entry.key}" not found in the sheet`);
      await updateRemoteConfigValue(sheetId, row.row, toolVal);
    });
    if (ok === null) {
      setStatus?.("error", "apply failed");
      return;
    }
    // The sheet now equals what we just pushed — reflect that without a re-fetch.
    this.sheetValueByKey.set(entry.key, toolVal);
    setStatus?.("idle");
  }

  /** Pushes one sheet field onto the tool's corresponding LevelData property, leaving the other 6 untouched. */
  private applyFieldSheetToTool(entry: LevelEntry, fieldIndex: number): void {
    const sheetVal = this.sheetValueByKey.get(entry.key);
    const level = this.level(entry);
    if (sheetVal === undefined || !this.isLive(entry) || !level) return;
    const parts = splitFields(sheetVal);
    (level as unknown as Record<string, string>)[FIELDS[fieldIndex].key] = parts[fieldIndex] ?? "";
    this.onLevelChanged();
    this.refreshRowByKey.get(entry.key)?.();
  }

  /**
   * Pushes one tool field onto the sheet, splicing it into a freshly-fetched
   * copy of the sheet's current combined value so the other 6 fields on the
   * sheet side are preserved rather than overwritten.
   */
  private async applyFieldToolToSheet(entry: LevelEntry, fieldIndex: number): Promise<void> {
    const sheetId = this.getSheetId();
    if (!sheetId.trim()) {
      alert("Paste a spreadsheet ID into the Sheet ID field first.");
      return;
    }
    const toolVal = this.toolValue(entry);
    if (toolVal === null) return;
    const toolParts = splitFields(toolVal);
    const setStatus = this.setRowStatusByKey.get(entry.key);
    setStatus?.("loading");
    const ok = await this.withToken(async () => {
      const token = await requestAccessTokenInteractive();
      const rows = await fetchRemoteConfigRows(sheetId, token);
      const row = rows.get(entry.key);
      if (!row) throw new Error(`Key "${entry.key}" not found in the sheet`);
      const sheetParts = splitFields(row.value);
      sheetParts[fieldIndex] = toolParts[fieldIndex];
      const newValue = joinFields(sheetParts);
      await updateRemoteConfigValue(sheetId, row.row, newValue);
      this.sheetValueByKey.set(entry.key, newValue);
    });
    if (ok === null) {
      setStatus?.("error", "apply failed");
      return;
    }
    setStatus?.("idle");
  }

  private async runAll(action: "load" | "sheet-to-tool" | "tool-to-sheet", group?: Group): Promise<void> {
    const entries = group ? group.entries : this.groups.flatMap((g) => g.entries);
    const statusEl = group ? this.groupStatusByTitle.get(group.title) : this.pageStatusEl;
    const label = action === "load" ? "Loading" : action === "sheet-to-tool" ? "Applying sheet data" : "Applying tool data";
    for (let i = 0; i < entries.length; i++) {
      if (statusEl) statusEl.textContent = `${label} ${i + 1}/${entries.length}…`;
      // Sequential: no batch cell-update on the Sheets API here, and each
      // call re-fetches row numbers fresh so a stale index can't misfire.
      if (action === "load") await this.loadFromSheet(entries[i]);
      else if (action === "sheet-to-tool") this.applySheetToTool(entries[i]);
      else await this.applyToolToSheet(entries[i]);
    }
    if (statusEl) statusEl.textContent = "Done";
  }
}
