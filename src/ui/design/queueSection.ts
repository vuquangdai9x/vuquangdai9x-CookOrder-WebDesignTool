// Ingredient Queue Reorder — bottom tier of the Design page.
// See docs/ToolDesign.md "Ingredient Queue Reorder window".
//
// The lanes form a real grid now: column x = queue index, row y = position
// (0 = front). Short lanes are padded with filler `.queue-tile.empty` cells so
// rows line up across columns — that's what gives a "combined-slot"/
// "linked-slot" group a meaningful (x,y) coordinate to reference.

import Sortable from "sortablejs";
import { CELL_COLOR_LOCK, EFFECT_FREEZE, EFFECT_HIDDEN, EFFECT_HOLDING_KEY } from "../../core/effects.ts";
import { parseQueueGroups, parseQueues, serializeQueues, SWEEPER_ID } from "../../core/parser.ts";
import type {
  CustomerConfig,
  EffectInstance,
  GlobalDefs,
  GridCellConfig,
  Id,
  MapDef,
  QueueGroup,
  QueueGroupKind,
  QueueItem,
} from "../../core/types.ts";
import { KEY_COLORS } from "../../data/configLoader.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import {
  closeContextMenu,
  importField,
  numberField,
  pickerGrid,
  showContextContent,
  showContextMenu,
  swatchRow,
} from "../contextMenu.ts";
import type { MenuItem } from "../contextMenu.ts";
import { button, el } from "../dom.ts";
import { ingredientIconEl, statusIconEl } from "../icon.ts";
import { appendLine, createOverlay, railColor, railSegments } from "../queueGroupVisuals.ts";
import type { Point } from "../queueGroupVisuals.ts";
import { changeClass, cidOf, leafStatus, tagAllNew, tagNew } from "./changeTracking.ts";
import type { ChangeStatus } from "./changeTracking.ts";
import { openAutoGenerateQueueDialog } from "./autoGenerateQueueDialog.ts";
import { defaultCurve, openCurveDialog, parseCurve, serializeCurve } from "./curveEditor.ts";
import { customerColor } from "./customerColors.ts";
import type { EstimateResult } from "./estimateDifficulty.ts";
import { generateQueueLanes } from "./queueGenerate.ts";
import { demandByRaw, rawYieldAmounts, supplyByRaw } from "../../data/recipeDemand.ts";
import type { RawDemand } from "../../data/recipeDemand.ts";
import type { ShuffleRangeSpec } from "./queueGenerate.ts";
import { Section } from "./section.ts";

const MIN_COLUMNS = 1;
const MAX_COLUMNS = 5;

export interface QueueSectionDeps {
  map: MapDef;
  defs: GlobalDefs;
  level: LevelData;
  parse(): { queues: QueueItem[][]; groups: QueueGroup[] };
  /** Live view of the other two sections' drafts, for the Recipe Pieces foldout. */
  currentCustomers(): CustomerConfig[];
  currentGrid(): GridCellConfig[];
  onSaved(): void;
  onCommit?(): void;
  /**
   * Latest Estimate Difficulty run for this level, or null if it hasn't been
   * run (or an edit invalidated it) — see estimateDifficulty.ts. Drives the
   * "Show pickup order" overlay.
   */
  currentEstimate?(): EstimateResult | null;
  /**
   * Replaces lane generation for Auto Generate. Omitted by legacy Design, which
   * keeps `generateQueueLanes` and its exact behaviour.
   *
   * The node editor supplies one because a MapDef recipe has a single `in`: a
   * multi-input recipe has already collapsed to its first ingredient by the
   * time it reaches here, so generating from `deps.map` would queue ground
   * coffee and no cups. It reuses this SECTION wholesale — the button, the
   * dialog, the draft plumbing — so the generator is the one part that has to
   * be swappable rather than forked.
   */
  generateLanes?(laneCount: number, shuffleRange: ShuffleRangeSpec): Id[][];
  /**
   * Replaces legacy single-input recipe demand. The node editor supplies a
   * graph-aware walk so Recipe Pieces includes every input of a process.
   */
  recipeDemand?(): Map<Id, RawDemand>;
}

/**
 * A combined/linked group tracked by item identity (`_cid`) while editing,
 * not by coordinate. A drag, insert, delete or column reorder then keeps
 * membership correct automatically — coordinates are only computed (from
 * each cid's *current* position) at save/preview/write time.
 */
interface WorkingGroup {
  kind: QueueGroupKind;
  cids: string[];
}

export interface QueueDraft {
  queues: QueueItem[][];
  groups: WorkingGroup[];
}

interface QueueUiState {
  activeLane: number;
  zoom: number;
  removeMode: boolean;
  /** Items deleted during the current Remove Mode session, for "Undo All Removes". */
  removedSnapshot: QueueItem[][] | null;
  foldoutOpen: boolean;
  drawerOpen: boolean;
  /** Shift-click multi-select for Combine/Link — UI-only, not an undo step. */
  selection: Set<string>;
  /**
   * "Show pickup order" — overlays each tile with the customer colour and
   * pickup number from the last Estimate Difficulty run. View-only, never
   * saved; does nothing until the estimate has been run at least once.
   */
  showPickup: boolean;
}

/** Tags every lane (container identity) and every item within it (leaf identity). */
function tagQueues(queues: QueueItem[][]): QueueItem[][] {
  tagAllNew(queues);
  for (const lane of queues) tagAllNew(lane);
  return queues;
}

const sameQueueItem = (a: QueueItem, b: QueueItem) =>
  a.kind === b.kind && a.id === b.id && JSON.stringify(a.effects) === JSON.stringify(b.effects);

// ---------- cid <-> coordinate ----------

function coordsByCid(queues: QueueItem[][]): Map<string, { x: number; y: number }> {
  const map = new Map<string, { x: number; y: number }>();
  queues.forEach((lane, x) => {
    lane.forEach((item, y) => {
      const cid = cidOf(item);
      if (cid) map.set(cid, { x, y });
    });
  });
  return map;
}

/** Live item references keyed by cid — lets a menu action mutate every selected tile's `effects` in place. */
function itemsByCid(queues: QueueItem[][]): Map<string, QueueItem> {
  const map = new Map<string, QueueItem>();
  for (const lane of queues) {
    for (const item of lane) {
      const cid = cidOf(item);
      if (cid) map.set(cid, item);
    }
  }
  return map;
}

/** True when every cell forms one 4-connected block (shared edge, not just a corner). */
function isFourConnected(cells: { x: number; y: number }[]): boolean {
  if (cells.length === 0) return true;
  const key = (x: number, y: number) => `${x}:${y}`;
  const set = new Set(cells.map((c) => key(c.x, c.y)));
  const seen = new Set([key(cells[0].x, cells[0].y)]);
  const queue = [cells[0]];
  while (queue.length > 0) {
    const { x, y } = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const k = key(x + dx, y + dy);
      if (set.has(k) && !seen.has(k)) {
        seen.add(k);
        queue.push({ x: x + dx, y: y + dy });
      }
    }
  }
  return seen.size === set.size;
}

/** Coordinate groups (the on-disk shape) computed from the working cid-based groups. */
export function toCoordGroups(draft: QueueDraft): QueueGroup[] {
  const coords = coordsByCid(draft.queues);
  const result: QueueGroup[] = [];
  for (const g of draft.groups) {
    const cells = g.cids
      .map((cid) => coords.get(cid))
      .filter((c): c is { x: number; y: number } => !!c);
    if (cells.length < 2) continue; // a cid that no longer exists shrank it below meaning
    if (g.kind === "combined" && !isFourConnected(cells)) continue; // a drag broke adjacency
    result.push({ kind: g.kind, cells });
  }
  return result;
}

/** Working (cid-based) groups computed from the on-disk coordinate groups, once at load. */
function toWorkingGroups(queues: QueueItem[][], groups: QueueGroup[]): WorkingGroup[] {
  return groups
    .map((g) => ({
      kind: g.kind,
      cids: g.cells
        .map(({ x, y }) => cidOf(queues[x]?.[y]))
        .filter((c): c is string => !!c),
    }))
    .filter((g) => g.cids.length >= 2);
}

/** Drops cids no longer present in `queues` (an item was deleted/a lane removed) and any group left under 2 cells. */
function pruneGroups(draft: QueueDraft): void {
  const live = new Set<string>();
  for (const lane of draft.queues) {
    for (const item of lane) {
      const cid = cidOf(item);
      if (cid) live.add(cid);
    }
  }
  draft.groups = draft.groups
    .map((g) => ({ kind: g.kind, cids: g.cids.filter((cid) => live.has(cid)) }))
    .filter((g) => g.cids.length >= 2);
}

function groupsTouching(draft: QueueDraft, selection: Set<string>, kind: QueueGroupKind): boolean {
  return draft.groups.some((g) => g.kind === kind && g.cids.some((cid) => selection.has(cid)));
}

function selectionAlreadyGrouped(draft: QueueDraft, selection: Set<string>): boolean {
  return draft.groups.some((g) => g.cids.some((cid) => selection.has(cid)));
}

/**
 * Tags a freshly-parsed `{queues, groups}` pair (the on-disk coordinate-group
 * shape) into a draft the section can edit — item identities assigned and
 * groups rekeyed by cid. Used for both the section's initial load and a
 * level switch (`Section.reset()`), which both start from the same parsed shape.
 */
export function toQueueDraft(parsed: { queues: QueueItem[][]; groups: QueueGroup[] }): QueueDraft {
  const queues = tagQueues(parsed.queues);
  return { queues, groups: toWorkingGroups(queues, parsed.groups) };
}

export function createQueueSection(deps: QueueSectionDeps): Section<QueueDraft> {
  const ui: QueueUiState = {
    activeLane: 0,
    zoom: 1,
    removeMode: false,
    removedSnapshot: null,
    foldoutOpen: true,
    drawerOpen: false,
    selection: new Set(),
    showPickup: false,
  };

  const section: Section<QueueDraft> = new Section<QueueDraft>({
    title: "Ingredient Queues",
    saveLabel: "Save Order",
    initial: toQueueDraft(deps.parse()),
    renderBody: (draft, body) => renderBody(section, deps, ui, draft, body),
    onCommit: () => deps.onCommit?.(),
    save: (draft) => {
      deps.level.queueString = serializeQueues(draft.queues, toCoordGroups(draft));
      deps.onSaved();
    },
    stringPreview: (draft) => serializeQueues(draft.queues, toCoordGroups(draft)),
    headerButtons: (sec) => [
      button("＋ Queue", () => {
        if (sec.draft.queues.length >= MAX_COLUMNS) return;
        sec.draft.queues.push(tagNew([]));
        sec.commit("Add queue");
      }, { class: "add-queue-btn", title: `Append a new queue (max ${MAX_COLUMNS})` }),
      button("✨ Auto Generate", () => startQueueAutoGenerate(sec, deps), {
        title: "Fill every lane from the customer orders' ingredient demand",
      }),
    ],
    menuItems: (draft) => [
      {
        label: ui.drawerOpen ? "Hide Quick Add" : "＋ Quick Add",
        onSelect: () => {
          ui.drawerOpen = !ui.drawerOpen;
          section.render();
        },
      },
      {
        label: ui.removeMode ? "Exit Remove Mode" : "Remove Mode",
        separator: true,
        onSelect: () => {
          ui.removeMode = !ui.removeMode;
          ui.removedSnapshot = ui.removeMode ? structuredClone(draft.queues) : null;
          section.render();
        },
      },
      {
        label: "Import from string…",
        expand: (close) =>
          importField("0,1%1,0$0-0,1-0", (text) => {
            const next = toQueueDraft({ queues: parseQueues(text), groups: parseQueueGroups(text) });
            draft.queues = next.queues;
            draft.groups = next.groups;
            section.commit("Import queues from string");
            close();
          }),
      },
      {
        label: "Shuffle Queue",
        onSelect: () => shuffle(section, deps, draft),
      },
      {
        label: "Clear All",
        danger: true,
        separator: true,
        onSelect: () => {
          if (!confirm("Empty every lane?")) return;
          const removed = draft.queues.reduce((n, q) => n + q.length, 0);
          draft.queues.forEach((lane) => (lane.length = 0));
          draft.groups = [];
          section.commit("Clear all lanes", 0, removed);
        },
      },
    ],
  });
  section.render();
  return section;
}

// ---------- body ----------

function renderBody(
  section: Section<QueueDraft>,
  deps: QueueSectionDeps,
  ui: QueueUiState,
  draft: QueueDraft,
  body: HTMLElement,
): void {
  body.append(shuffleCurveBar(section, deps));
  body.append(recipeFoldout(section, deps, ui, draft));
  body.append(toolbar(section, deps, ui));

  const lanes = el("div", { class: `queue-lanes${ui.removeMode ? " remove-mode" : ""}` });
  lanes.style.setProperty("--tile-zoom", String(ui.zoom));

  // Read fresh on every render so it tracks the latest Estimate Difficulty
  // run (the customers section re-renders this one via onCommit's
  // refreshQueueReadout) — see estimateDifficulty.ts.
  const estimate = ui.showPickup ? (deps.currentEstimate?.() ?? null) : null;

  // Compared against once per render — reordering/adding/removing during a
  // render doesn't shift this baseline out from under the diff.
  const savedQueues = section.savedState.queues;
  const maxRows = draft.queues.reduce((h, q) => Math.max(h, q.length), 0);
  draft.queues.forEach((lane, laneIndex) => {
    lanes.append(laneEl(section, deps, ui, draft, lane, laneIndex, savedQueues, maxRows, estimate));
  });

  // Lane reordering: drag a lane by its header.
  Sortable.create(lanes, {
    animation: 150,
    draggable: ".queue-lane",
    handle: ".lane-head",
    onEnd: (evt) => {
      if (evt.oldIndex === undefined || evt.newIndex === undefined) return;
      if (evt.oldIndex === evt.newIndex) return;
      const [moved] = draft.queues.splice(evt.oldIndex, 1);
      draft.queues.splice(Math.min(evt.newIndex, draft.queues.length), 0, moved);
      section.commit("Reorder lanes");
    },
  });

  body.append(lanes);
  renderGroupOverlay(lanes, draft);

  const addBtn = section.element.querySelector<HTMLButtonElement>(".add-queue-btn");
  if (addBtn) addBtn.disabled = draft.queues.length >= MAX_COLUMNS;

  if (ui.removeMode) body.append(removeModeBar(section, ui, draft));
  if (ui.drawerOpen) body.append(quickAddDrawer(section, deps, ui, draft));

  // Ctrl+scroll zoom over the lanes.
  lanes.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      ui.zoom = clampZoom(ui.zoom + (e.deltaY < 0 ? 0.1 : -0.1));
      lanes.style.setProperty("--tile-zoom", String(ui.zoom));
    },
    { passive: false },
  );
}

const clampZoom = (z: number) => Math.min(2.5, Math.max(0.5, Math.round(z * 10) / 10));

function toolbar(
  section: Section<QueueDraft>,
  deps: QueueSectionDeps,
  ui: QueueUiState,
): HTMLElement {
  const pickupCheckbox = el("input", { type: "checkbox" }) as HTMLInputElement;
  pickupCheckbox.checked = ui.showPickup;
  pickupCheckbox.addEventListener("change", () => {
    ui.showPickup = pickupCheckbox.checked;
    section.render();
  });

  const hasEstimate = !!deps.currentEstimate?.();
  const label = el(
    "label",
    {
      class: "pickup-toggle",
      title: hasEstimate
        ? "Design-view only — colours each tile by the customer it gets picked for and numbers it in pickup order. Never saved."
        : "Run Estimate Difficulty on the Customers panel first",
    },
    [pickupCheckbox, "Show pickup order"],
  );
  if (!hasEstimate) label.classList.add("disabled");

  return el("div", { class: "queue-toolbar" }, [
    label,
    el("span", { class: "spacer" }),
    button("−", () => {
      ui.zoom = clampZoom(ui.zoom - 0.1);
      section.render();
    }, { class: "icon-btn", title: "Zoom out" }),
    el("span", { class: "zoom-label" }, [`${Math.round(ui.zoom * 100)}%`]),
    button("＋", () => {
      ui.zoom = clampZoom(ui.zoom + 0.1);
      section.render();
    }, { class: "icon-btn", title: "Zoom in" }),
  ]);
}

/**
 * Read-only record of the curve used the last time Auto Generate ran in
 * Curve mode — an Edit button opens a standalone dialog for it. Editing here
 * only updates the stored string on deps.level; it doesn't re-shuffle the
 * live queues (re-running Auto Generate is what applies it).
 */
function shuffleCurveBar(section: Section<QueueDraft>, deps: QueueSectionDeps): HTMLElement {
  const input = el("input", {
    type: "text",
    value: deps.level.shuffleCurve ?? "",
    readonly: "true",
  }) as HTMLInputElement;

  const edit = button(
    "Edit",
    () => {
      const initial = deps.level.shuffleCurve
        ? parseCurve(deps.level.shuffleCurve, defaultCurve(0, 5))
        : defaultCurve(0, 5);
      openCurveDialog("Shuffle Curve", initial, (curve) => {
        deps.level.shuffleCurve = serializeCurve(curve);
        deps.onSaved();
        section.render();
      });
    },
    { class: "small-btn" },
  );

  return el("label", { class: "field level-param-field" }, [
    "Shuffle Curve",
    el("div", { class: "level-param-row" }, [input, edit]),
  ]);
}

// ---------- lanes & tiles ----------

/**
 * Lanes have no scalar fields of their own — only membership — so they only
 * ever show "added" (a brand-new lane) or "removed-inside" (lost a tile,
 * whether it was deleted outright or just dragged to another lane).
 */
function laneStatus(lane: QueueItem[], savedQueues: QueueItem[][]): ChangeStatus | null {
  const cid = cidOf(lane);
  const saved = savedQueues.find((l) => cidOf(l) === cid);
  if (!saved) return "added";
  const currentCids = new Set(lane.map(cidOf));
  return saved.some((item) => !currentCids.has(cidOf(item))) ? "removed-inside" : null;
}

/** Search every saved lane, not just the same-position one — a tile may have moved lanes. */
function tileStatus(item: QueueItem, savedQueues: QueueItem[][]): ChangeStatus | null {
  return leafStatus(item, savedQueues, sameQueueItem);
}

function laneEl(
  section: Section<QueueDraft>,
  deps: QueueSectionDeps,
  ui: QueueUiState,
  draft: QueueDraft,
  lane: QueueItem[],
  laneIndex: number,
  savedQueues: QueueItem[][],
  maxRows: number,
  estimate: EstimateResult | null,
): HTMLElement {
  const node = el("div", {
    class: `queue-lane${ui.activeLane === laneIndex ? " active" : ""} ${changeClass(laneStatus(lane, savedQueues))}`,
  });
  node.addEventListener("click", () => {
    const changed = ui.activeLane !== laneIndex || ui.selection.size > 0;
    ui.activeLane = laneIndex;
    ui.selection.clear();
    if (changed) section.render();
  });

  node.append(
    el("div", { class: "lane-head" }, [
      el("span", {}, [`Queue ${laneIndex + 1}`]),
      el("small", {}, [`${lane.length}`]),
    ]),
  );

  const tiles = el("div", { class: "lane-tiles" });
  lane.forEach((item, itemIndex) => {
    tiles.append(tileEl(section, deps, ui, draft, lane, item, itemIndex, savedQueues, estimate));
  });

  const addTile = el("div", { class: "queue-tile add-tile" }, ["＋"]);
  addTile.addEventListener("click", (e) => {
    e.stopPropagation();
    ui.activeLane = laneIndex;
    showContextContent(e, ingredientPickerGrid(deps, (id) => {
      lane.push(tagNew({ kind: id < 0 ? "sweeper" : "ingredient", id, effects: [] }));
      section.commit("Add ingredient", 1);
    }), { title: `Queue ${laneIndex + 1}` });
  });
  tiles.append(addTile);

  // Filler cells so every column reaches the same row count — that's what
  // gives a combined/linked group's coordinates a consistent meaning across
  // lanes. Placed after the add-tile so they never shift Sortable's index
  // space for the real tiles above them.
  for (let y = lane.length; y < maxRows; y++) {
    tiles.append(el("div", { class: "queue-tile empty" }));
  }

  // Tiles drag within and between lanes (shared group).
  Sortable.create(tiles, {
    group: "queue-tiles",
    animation: 150,
    disabled: ui.removeMode,
    draggable: ".queue-tile:not(.add-tile):not(.empty)",
    onEnd: (evt) => {
      const from = Number((evt.from.closest(".queue-lane") as HTMLElement)?.dataset.lane);
      const to = Number((evt.to.closest(".queue-lane") as HTMLElement)?.dataset.lane);
      if (Number.isNaN(from) || Number.isNaN(to)) return;
      if (evt.oldIndex === undefined || evt.newIndex === undefined) return;
      if (from === to && evt.oldIndex === evt.newIndex) return;
      const [moved] = draft.queues[from].splice(evt.oldIndex, 1);
      if (!moved) return;
      draft.queues[to].splice(Math.min(evt.newIndex, draft.queues[to].length), 0, moved);
      section.commit(from === to ? "Reorder ingredients" : "Move ingredient between queues");
    },
  });

  node.dataset.lane = String(laneIndex);
  node.append(tiles);
  node.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest(".queue-tile")) return;
    showContextMenu(e, laneMenu(section, draft, laneIndex), {
      title: `Queue ${laneIndex + 1}`,
    });
  });
  return node;
}

function tileEl(
  section: Section<QueueDraft>,
  deps: QueueSectionDeps,
  ui: QueueUiState,
  draft: QueueDraft,
  lane: QueueItem[],
  item: QueueItem,
  itemIndex: number,
  savedQueues: QueueItem[][],
  estimate: EstimateResult | null,
): HTMLElement {
  const freeze = item.effects.find((e) => e.effectId === EFFECT_FREEZE);
  const key = item.effects.find((e) => e.effectId === EFFECT_HOLDING_KEY);
  const hidden = item.effects.some((e) => e.effectId === EFFECT_HIDDEN);
  const cid = cidOf(item);
  const group = cid ? draft.groups.find((g) => g.cids.includes(cid)) : undefined;
  const selected = !!cid && ui.selection.has(cid);
  // Every member of a combined/linked group shares one pickup number, because
  // the solver stamps all of a pick's cells with the same counter value.
  const slot = cid ? estimate?.byCid.get(cid) : undefined;
  const autoColor = slot ? customerColor(slot.customerIndex) : undefined;

  const tile = el("div", {
    class: [
      "queue-tile",
      freeze ? "frozen" : "",
      item.kind === "sweeper" ? "sweeper" : "",
      selected ? "selected" : "",
      group ? `group-${group.kind}` : "",
      hidden ? "hidden-slot" : "",
      autoColor ? "auto-color" : "",
      slot?.detour ? "pickup-detour" : "",
      changeClass(tileStatus(item, savedQueues)),
    ]
      .filter(Boolean)
      .join(" "),
  });
  if (cid) tile.dataset.cid = cid;
  if (autoColor) tile.style.setProperty("--auto-color", autoColor);

  tile.append(
    item.kind === "sweeper"
      ? el("span", { class: "tile-main" }, ["🧹"])
      : el("span", { class: "tile-main" }, [ingredientIconEl(item.id, 96)]),
  );

  if (slot) {
    tile.append(
      el(
        "span",
        { class: "pickup-customer", title: `Assigned to customer ${slot.customerIndex + 1}` },
        [`#${slot.customerIndex + 1}`],
      ),
      el(
        "span",
        {
          class: "pickup-order",
          title: slot.detour
            ? `Pick #${slot.order} — taken to dig toward customer ${slot.customerIndex + 1}'s order, or at random`
            : `Pick #${slot.order} — for customer ${slot.customerIndex + 1}`,
        },
        [String(slot.order)],
      ),
    );
  }

  // Statuses other than the ones with dedicated badges show as a corner icon.
  // Both HoldingKey and Hidden are excluded because .tile-corner only ever
  // renders cornerEffects[0] — sharing that one slot would make them mutually
  // exclusive with Freeze on a single tile, when in practice a slot can
  // legitimately be frozen AND hidden AND hold a key at once.
  const cornerEffects = item.effects.filter(
    (e) => e.effectId !== EFFECT_HOLDING_KEY && e.effectId !== EFFECT_HIDDEN,
  );
  if (cornerEffects.length) {
    tile.append(
      el("span", { class: "tile-corner" }, [
        statusIconEl(cornerEffects[0].effectId, 48),
        ...(cornerEffects[0].params.length
          ? [el("small", {}, [String(cornerEffects[0].params[0])])]
          : []),
      ]),
    );
  }
  // Design mode never masks the ingredient — a designer has to see what they
  // authored. The badge + tint just mark that the PLAYER won't see it until it
  // fronts (see Simulation.isHidden()).
  if (hidden) {
    tile.append(
      el(
        "span",
        { class: "tile-hidden", title: "Hidden — shows as ? in play until it reaches the top row" },
        [statusIconEl(EFFECT_HIDDEN, 48)],
      ),
    );
  }
  if (key) {
    const badge = el("span", { class: "tile-key" }, [statusIconEl(EFFECT_HOLDING_KEY, 48)]);
    badge.style.background = KEY_COLORS[key.params[0] ?? 0]?.hex ?? "transparent";
    badge.title = `Holds a ${KEY_COLORS[key.params[0] ?? 0]?.name ?? ""} key`;
    tile.append(badge);
  }

  const remove = button(
    "✕",
    (e) => {
      e.stopPropagation();
      lane.splice(itemIndex, 1);
      pruneGroups(draft);
      section.commit("Remove ingredient", 0, 1);
    },
    { class: "tile-remove", title: "Remove" },
  );
  tile.append(remove);

  tile.addEventListener("click", (e) => {
    e.stopPropagation();
    if (ui.removeMode) {
      lane.splice(itemIndex, 1);
      pruneGroups(draft);
      section.commit("Remove ingredient", 0, 1);
      return;
    }
    if (!cid) return;
    if (e.shiftKey) {
      if (ui.selection.has(cid)) ui.selection.delete(cid);
      else ui.selection.add(cid);
    } else {
      ui.selection = new Set([cid]);
    }
    section.render();
  });

  tile.addEventListener("contextmenu", (e) => {
    e.stopPropagation();
    showContextMenu(e, tileMenu(section, deps, ui, draft, lane, item, itemIndex), {
      title: deps.map.rawIngredients.find((r) => r.id === item.id)?.name ?? "Item",
    });
  });
  return tile;
}

/** Adjacent (cid, cid) pairs within the same combined group — one per shared edge, checked right/down only so each edge is counted once. Carries the group's index in draft.groups so each block gets its own color (see railColor()). */
function combinedAdjacentCidPairs(draft: QueueDraft): { a: string; b: string; group: number }[] {
  const coords = coordsByCid(draft.queues);
  const byCoord = new Map<string, string>();
  for (const [cid, c] of coords) byCoord.set(`${c.x}:${c.y}`, cid);

  const pairs: { a: string; b: string; group: number }[] = [];
  draft.groups.forEach((g, groupIndex) => {
    if (g.kind !== "combined") return;
    const members = new Set(g.cids);
    for (const cid of g.cids) {
      const c = coords.get(cid);
      if (!c) continue;
      const right = byCoord.get(`${c.x + 1}:${c.y}`);
      if (right && members.has(right)) pairs.push({ a: cid, b: right, group: groupIndex });
      const down = byCoord.get(`${c.x}:${c.y + 1}`);
      if (down && members.has(down)) pairs.push({ a: cid, b: down, group: groupIndex });
    }
  });
  return pairs;
}

function tileCenter(lanes: HTMLElement, host: DOMRect, cid: string): Point | null {
  const t = lanes.querySelector<HTMLElement>(`.queue-tile[data-cid="${cid}"]`);
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: r.left + r.width / 2 - host.left, y: r.top + r.height / 2 - host.top };
}

/**
 * Draws linked-slot ropes (dashed, one line per consecutive pair whose
 * columns are adjacent — a pair two or more columns apart, or in the same
 * column, draws nothing, so a rope never reads as a long diagonal across the
 * board) and combined-slot rails (solid double lines across each shared
 * edge, one color per combined group — see railColor()) as one SVG overlay
 * positioned over the whole lanes grid. Reads tile centers via
 * getBoundingClientRect() right after the lanes are appended — cheap, and
 * always current since the tier is fully rebuilt on every render rather than
 * patched. The overlay is layered above each lane's own panel background but
 * below the tile frames (see .queue-link-overlay's z-index in style.css), so
 * only the gap between two tiles actually shows a line.
 */
function renderGroupOverlay(lanes: HTMLElement, draft: QueueDraft): void {
  const linked = draft.groups.filter((g) => g.kind === "linked");
  const combinedPairs = combinedAdjacentCidPairs(draft);
  if (linked.length === 0 && combinedPairs.length === 0) return;

  const host = lanes.getBoundingClientRect();
  const svg = createOverlay(host);
  const coords = coordsByCid(draft.queues);

  for (const g of linked) {
    // Sorted by COLUMN, not authored/selection order: Link only accepts one
    // member per column in one contiguous run, so column order is the
    // chain's real edge order regardless of the order the cids were shift-
    // clicked in — see the matching comment in play/index.ts's
    // renderGroupOverlay().
    const orderedCids = [...g.cids].sort((a, b) => (coords.get(a)?.x ?? 0) - (coords.get(b)?.x ?? 0));
    for (let i = 0; i < orderedCids.length - 1; i++) {
      const cidA = orderedCids[i];
      const cidB = orderedCids[i + 1];
      const ca = coords.get(cidA);
      const cb = coords.get(cidB);
      if (!ca || !cb || Math.abs(ca.x - cb.x) !== 1) continue;
      const p1 = tileCenter(lanes, host, cidA);
      const p2 = tileCenter(lanes, host, cidB);
      if (!p1 || !p2) continue;
      appendLine(svg, p1, p2, "queue-link-rope");
    }
  }

  for (const { a: cidA, b: cidB, group } of combinedPairs) {
    const p1 = tileCenter(lanes, host, cidA);
    const p2 = tileCenter(lanes, host, cidB);
    if (!p1 || !p2) continue;
    const color = railColor(group);
    for (const [a, b] of railSegments(p1, p2)) {
      appendLine(svg, a, b, "queue-combine-rail", color);
    }
  }

  // Prepended, not appended — see the matching comment in play/index.ts's
  // renderGroupOverlay() for why this ordering (paired with
  // .queue-link-overlay's z-index: 0) is what puts the overlay above each
  // lane's panel background but below every tile frame.
  lanes.prepend(svg);
}

// ---------- menus ----------

function ingredientPickerGrid(
  deps: QueueSectionDeps,
  onPick: (id: number) => void,
): HTMLElement {
  return pickerGrid(
    [
      ...deps.map.rawIngredients.map((r) => ({
        id: r.id,
        label: r.name,
        icon: ingredientIconEl(r.id, 64),
      })),
      { id: SWEEPER_ID, label: "Sweeper", icon: el("span", {}, ["🧹"]) },
    ],
    (id) => {
      onPick(id);
      closeContextMenu();
    },
  );
}

function laneMenu(
  section: Section<QueueDraft>,
  draft: QueueDraft,
  laneIndex: number,
): MenuItem[] {
  const atMax = draft.queues.length >= MAX_COLUMNS;
  const atMin = draft.queues.length <= MIN_COLUMNS;
  return [
    {
      label: `Insert Column Left${atMax ? ` (max ${MAX_COLUMNS})` : ""}`,
      disabled: atMax,
      onSelect: () => {
        draft.queues.splice(laneIndex, 0, tagNew([]));
        section.commit("Insert queue left");
      },
    },
    {
      label: `Insert Column Right${atMax ? ` (max ${MAX_COLUMNS})` : ""}`,
      disabled: atMax,
      onSelect: () => {
        draft.queues.splice(laneIndex + 1, 0, tagNew([]));
        section.commit("Insert queue right");
      },
    },
    {
      label: "Clear Queue",
      separator: true,
      onSelect: () => {
        // Empty it in place (not a fresh array) so the lane keeps its identity —
        // it's the same lane with everything removed, not a new empty one.
        const removed = draft.queues[laneIndex].length;
        draft.queues[laneIndex].length = 0;
        pruneGroups(draft);
        section.commit("Clear queue", 0, removed);
      },
    },
    {
      label: `Remove Column${atMin ? ` (min ${MIN_COLUMNS})` : ""}`,
      danger: true,
      disabled: atMin,
      onSelect: () => {
        if (draft.queues[laneIndex].length && !confirm("This queue still has items. Remove it?")) return;
        const removed = draft.queues[laneIndex].length;
        draft.queues.splice(laneIndex, 1);
        pruneGroups(draft);
        section.commit("Remove queue", 0, removed);
      },
    },
  ];
}

function tileMenu(
  section: Section<QueueDraft>,
  deps: QueueSectionDeps,
  ui: QueueUiState,
  draft: QueueDraft,
  lane: QueueItem[],
  item: QueueItem,
  itemIndex: number,
): MenuItem[] {
  const rawList = deps.map.rawIngredients.map((r) => ({
    id: r.id,
    label: r.name,
    icon: ingredientIconEl(r.id, 64),
  }));

  const items: MenuItem[] = [
    {
      label: "Insert Top",
      expand: (close) =>
        pickerGrid(rawList, (id) => {
          lane.splice(0, 0, tagNew({ kind: "ingredient", id, effects: [] }));
          section.commit("Insert ingredient at top", 1);
          close();
        }),
    },
    {
      label: "Insert Bottom",
      expand: (close) =>
        pickerGrid(rawList, (id) => {
          lane.push(tagNew({ kind: "ingredient", id, effects: [] }));
          section.commit("Insert ingredient at bottom", 1);
          close();
        }),
    },
  ];

  // Combined/linked-slot grouping — acts on the current shift-click
  // selection, not necessarily the right-clicked tile itself.
  const selection = ui.selection;
  if (selection.size >= 2) {
    const coords = coordsByCid(draft.queues);
    const selectedCells = [...selection]
      .map((cid) => coords.get(cid))
      .filter((c): c is { x: number; y: number } => !!c);
    const alreadyGrouped = selectionAlreadyGrouped(draft, selection);

    items.push({
      label: "Combine",
      separator: true,
      disabled: alreadyGrouped || !isFourConnected(selectedCells),
      onSelect: () => {
        draft.groups.push({ kind: "combined", cids: [...selection] });
        selection.clear();
        section.commit("Combine slots");
      },
    });
    // A link is a chain of 2+ slots, at most one per column, whose columns
    // form one unbroken adjacent run — never two slots sharing a column,
    // never a gap between columns (unlike Combine's arbitrary 4-connected
    // block, which can be any shape and even stack several cells in one
    // column).
    const linkColumns = selectedCells.map((c) => c.x);
    const uniqueLinkColumns = new Set(linkColumns);
    const linkable =
      selectedCells.length >= 2 &&
      uniqueLinkColumns.size === linkColumns.length && // no two cells share a column
      Math.max(...linkColumns) - Math.min(...linkColumns) + 1 === uniqueLinkColumns.size; // contiguous run
    items.push({
      label: "Link",
      disabled: alreadyGrouped || !linkable,
      onSelect: () => {
        draft.groups.push({ kind: "linked", cids: [...selection] });
        selection.clear();
        section.commit("Link slots");
      },
    });
  }
  if (groupsTouching(draft, selection, "combined")) {
    items.push({
      label: "Uncombine",
      onSelect: () => {
        draft.groups = draft.groups.filter(
          (g) => !(g.kind === "combined" && g.cids.some((cid) => selection.has(cid))),
        );
        selection.clear();
        section.commit("Uncombine slots");
      },
    });
  }
  if (groupsTouching(draft, selection, "linked")) {
    items.push({
      label: "Break Link",
      onSelect: () => {
        draft.groups = draft.groups.filter(
          (g) => !(g.kind === "linked" && g.cids.some((cid) => selection.has(cid))),
        );
        selection.clear();
        section.commit("Break link");
      },
    });
  }

  // Effect toggles act on every selected tile at once when 2+ are selected —
  // NOT just the right-clicked one, matching Combine/Link/Uncombine/Break
  // Link above. With a single tile (no multi-select), this is exactly the
  // one-item behavior it always was.
  const selectedItems = itemsByCid(draft.queues);
  const targetItems: QueueItem[] =
    selection.size >= 2
      ? [...selection].map((cid) => selectedItems.get(cid)).filter((it): it is QueueItem => !!it)
      : [item];

  for (const def of deps.defs.effects.filter((d) => d.id !== 0)) {
    const existingList = targetItems.map((it) => it.effects.find((e) => e.effectId === def.id));
    const allActive = targetItems.length > 0 && existingList.every((e) => !!e);
    const anyActive = existingList.some((e) => !!e);

    // A status with no params (Hidden) has nothing to configure, so an
    // expansion panel would be an empty box with a lone Apply button. Make it
    // a plain one-click on/off toggle instead. Priority "apply": as long as
    // ANY target lacks the effect, clicking applies it to every target;
    // toggling off only happens once every target already has it.
    if (def.paramDefs.length === 0) {
      items.push({
        label: def.name,
        icon: statusIconEl(def.id, 48),
        active: allActive,
        separator: def.id === deps.defs.effects[1]?.id,
        onSelect: () => {
          const apply = !allActive;
          for (const it of targetItems) {
            it.effects = it.effects.filter((e) => e.effectId !== def.id);
            if (apply) it.effects.push({ effectId: def.id, params: [] });
          }
          section.commit(apply ? `Set ${def.name}` : `Clear ${def.name}`);
        },
      });
      continue;
    }

    // Per-param: the shared value if every target that already carries this
    // effect agrees, else null ("-", differs across the selection). A target
    // with no effect yet doesn't count toward disagreement — only existing
    // instances need to agree for the field to show a real value.
    const existingParams = existingList.filter((e): e is EffectInstance => !!e);
    const seedParams: (number | null)[] = def.paramDefs.map((_, i) => {
      const values = existingParams.map((e) => e.params[i] ?? 1);
      if (values.length === 0) return 1;
      return values.every((v) => v === values[0]) ? values[0] : null;
    });
    // Fallback for a "-" field the designer never touches: reuse whatever the
    // first already-carrying target has, rather than silently zeroing every
    // target's param out from under it.
    const fallbackParams: number[] = def.paramDefs.map((_, i) => existingParams[0]?.params[i] ?? 1);

    items.push({
      label: def.name,
      icon: statusIconEl(def.id, 48),
      active: allActive,
      separator: def.id === deps.defs.effects[1]?.id,
      expand: (close) => {
        const params: (number | null)[] = [...seedParams];
        const wrap = el("div", { class: "ctx-sub" });

        if (def.id === EFFECT_HOLDING_KEY) {
          wrap.append(
            swatchRow(
              KEY_COLORS.filter((c) => c.id !== 0),
              (id) => {
                params[0] = id;
                wrap.querySelectorAll(".ctx-swatch").forEach((b, i) => {
                  b.classList.toggle("active", KEY_COLORS[i + 1].id === id);
                });
              },
              params[0] ?? undefined,
            ),
          );
        } else {
          def.paramDefs.forEach((p, i) =>
            wrap.append(numberField(p.name, params[i], (v) => (params[i] = v))),
          );
        }

        wrap.append(
          button(allActive ? "Update" : "Apply", () => {
            const finalParams = params.map((p, i) => p ?? fallbackParams[i]);
            for (const it of targetItems) {
              it.effects = it.effects.filter((e) => e.effectId !== def.id);
              it.effects.push({ effectId: def.id, params: finalParams });
            }
            section.commit(`Set ${def.name}`);
            close();
          }),
          ...(anyActive
            ? [
                button(
                  "Remove",
                  () => {
                    for (const it of targetItems) {
                      it.effects = it.effects.filter((e) => e.effectId !== def.id);
                    }
                    section.commit(`Clear ${def.name}`);
                    close();
                  },
                  { class: "danger" },
                ),
              ]
            : []),
        );
        return wrap;
      },
    });
  }

  items.push({
    label: "Remove",
    danger: true,
    separator: true,
    onSelect: () => {
      lane.splice(itemIndex, 1);
      pruneGroups(draft);
      section.commit("Remove ingredient", 0, 1);
    },
  });
  return items;
}

// ---------- Remove Mode / Quick Add ----------

function removeModeBar(
  section: Section<QueueDraft>,
  ui: QueueUiState,
  draft: QueueDraft,
): HTMLElement {
  return el("div", { class: "remove-bar" }, [
    el("span", {}, ["Remove Mode — click tiles to delete"]),
    button("Undo All Removes", () => {
      if (!ui.removedSnapshot) return;
      draft.queues.length = 0;
      draft.queues.push(...structuredClone(ui.removedSnapshot));
      section.commit("Undo all removes");
    }),
    button("Done", () => {
      ui.removeMode = false;
      ui.removedSnapshot = null;
      section.render();
    }, { class: "primary" }),
  ]);
}

function quickAddDrawer(
  section: Section<QueueDraft>,
  deps: QueueSectionDeps,
  ui: QueueUiState,
  draft: QueueDraft,
): HTMLElement {
  const drawer = el("div", { class: "quick-add" }, [
    el("div", { class: "quick-add-head" }, [
      el("span", {}, [`Quick Add → Queue ${ui.activeLane + 1}`]),
      button("✕", () => {
        ui.drawerOpen = false;
        section.render();
      }, { class: "icon-btn" }),
    ]),
  ]);
  const pool = el("div", { class: "quick-add-pool" });
  const add = (id: number) => {
    (draft.queues[ui.activeLane] ?? draft.queues[0]).push(
      tagNew({ kind: id < 0 ? "sweeper" : "ingredient", id, effects: [] }),
    );
    section.commit("Quick add ingredient", 1);
  };
  for (const raw of deps.map.rawIngredients) {
    const tile = button("", () => add(raw.id), { class: "queue-tile", title: raw.name });
    tile.replaceChildren(ingredientIconEl(raw.id, 96));
    pool.append(tile);
  }
  const sweeper = button("🧹", () => add(SWEEPER_ID), {
    class: "queue-tile sweeper",
    title: "Sweeper",
  });
  pool.append(sweeper);
  drawer.append(pool);
  return drawer;
}

// ---------- generation / shuffle ----------

/**
 * Opens the queue's Auto Generate dialog (fixed/curve shuffle) against the
 * section's current draft. `skipOverwriteConfirm` lets a caller that already
 * got the designer's intent some other way (see customerSection.ts's
 * "generate customers, then offer to also regenerate the queue" chain) skip
 * straight to the dialog — its own Cancel button still covers "changed my
 * mind", so nothing is lost by skipping the generic confirm() here.
 */
export function startQueueAutoGenerate(
  section: Section<QueueDraft>,
  deps: QueueSectionDeps,
  skipOverwriteConfirm = false,
): void {
  if (!skipOverwriteConfirm && !confirm("Auto-generate overwrites every lane. Continue?")) return;
  const draft = section.draft;
  openAutoGenerateQueueDialog({
    level: deps.level,
    onGenerate: (shuffleRange) => {
      runAutoGenerate(section, deps, draft, shuffleRange);
      deps.onSaved(); // curve mode also wrote deps.level.shuffleCurve — flag the app-level change
    },
  });
}

function runAutoGenerate(
  section: Section<QueueDraft>,
  deps: QueueSectionDeps,
  draft: QueueDraft,
  shuffleRange: ShuffleRangeSpec,
): void {
  const laneCount = Math.max(1, draft.queues.length);
  const lanes = deps.generateLanes
    ? deps.generateLanes(laneCount, shuffleRange)
    : generateQueueLanes({
        customers: deps.currentCustomers(),
        tools: deps.map.tools,
        // usageNum lives here: a multi-use item needs fewer pickups than it has
        // dish slots, and leaving this out over-supplies the level.
        cookedIngredients: deps.map.cookedIngredients,
        laneCount,
        shuffleRange,
      });

  const before = draft.queues.reduce((n, q) => n + q.length, 0);
  const after = lanes.reduce((n, l) => n + l.length, 0);
  draft.queues = lanes.map((lane) => tagNew(lane.map((id) => tagNew({ kind: "ingredient", id, effects: [] }))));
  draft.groups = []; // authored groups don't survive a full regeneration
  const label = shuffleRange.kind === "fixed" ? `shuffle range ${shuffleRange.value}` : "curve shuffle";
  section.commit(`Auto-generate queue (${label})`, after, before);
}

function shuffle(
  section: Section<QueueDraft>,
  deps: QueueSectionDeps,
  draft: QueueDraft,
): void {
  const answer = prompt("Max shuffle distance", String(deps.level.shuffleDistance || 3));
  if (answer === null) return;
  const distance = Math.max(0, Number(answer) || 0);
  if (distance === 0) return;
  deps.level.shuffleDistance = distance;
  // Local jitter only: items never cross lanes.
  for (const lane of draft.queues) {
    for (let i = lane.length - 1; i > 0; i--) {
      const lowest = Math.max(0, i - distance);
      const j = lowest + Math.floor(Math.random() * (i - lowest + 1));
      [lane[i], lane[j]] = [lane[j], lane[i]];
    }
  }
  section.commit(`Shuffle (distance ${distance})`);
}

// ---------- Recipe Pieces foldout ----------

function recipeFoldout(
  section: Section<QueueDraft>,
  deps: QueueSectionDeps,
  ui: QueueUiState,
  draft: QueueDraft,
): HTMLElement {
  const demand = deps.recipeDemand ? deps.recipeDemand() : demandByRaw(deps.map, deps.currentCustomers());
  const rawYield = rawYieldAmounts(deps.map);
  const supply = supplyByRaw(draft.queues);

  // Have/need in USE units, not physical pickup count — need is a straight
  // count of order occurrences; have is pickups × yield × usageNum (how many
  // times the queued pieces can actually be served). For a normal (usageNum
  // 1) ingredient this still hides the same real mismatch a raw pickup count
  // alone would (3 slices needed vs. 2 pickups yielding 4 both "round up" to
  // the same pickup count) — a usageNum ingredient additionally surfaces a
  // landed piece's leftover capacity instead of rounding it away.
  const rawIds = new Set([...demand.keys(), ...supply.keys()]);
  const pieceCounts = new Map<number, { have: number; need: number }>();
  for (const rawId of rawIds) {
    const info = demand.get(rawId);
    const amount = info?.amount ?? rawYield.get(rawId) ?? 1;
    const usageNum = info?.usageNum ?? 1;
    pieceCounts.set(rawId, { have: (supply.get(rawId) ?? 0) * amount * usageNum, need: info?.need ?? 0 });
  }

  // Keys held by queue items vs. ColorLock demand on the grid.
  const keysHeld = new Map<number, number>();
  for (const lane of draft.queues) {
    for (const item of lane) {
      for (const e of item.effects) {
        if (e.effectId !== EFFECT_HOLDING_KEY) continue;
        const color = e.params[0] ?? 0;
        keysHeld.set(color, (keysHeld.get(color) ?? 0) + 1);
      }
    }
  }
  const keysNeeded = new Map<number, number>();
  for (const cell of deps.currentGrid()) {
    for (const e of cell.effects) {
      if (e.effectId !== CELL_COLOR_LOCK) continue;
      const [color = 0, amount = 1] = e.params;
      keysNeeded.set(color, (keysNeeded.get(color) ?? 0) + amount);
    }
  }

  const shortPieces = [...pieceCounts].filter(([, { have, need }]) => have < need);
  const excessPieces = [...pieceCounts].filter(([, { have, need }]) => have > need);
  const shortKeys = [...keysNeeded].filter(
    ([color, need]) => (keysHeld.get(color) ?? 0) < need,
  );
  const keysMismatch = [...keysNeeded].some(
    ([color, need]) => (keysHeld.get(color) ?? 0) !== need,
  );

  const head = el("div", { class: "foldout-head" }, [
    button(ui.foldoutOpen ? "▾" : "▸", () => {
      ui.foldoutOpen = !ui.foldoutOpen;
      section.render();
    }, { class: "icon-btn" }),
    el("strong", {}, ["Recipe Pieces"]),
    ...(shortPieces.length || shortKeys.length
      ? [el("span", { class: "warn-badge bad" }, ["⚠ Queue can't complete the level"])]
      : []),
    ...(!shortPieces.length && !shortKeys.length && keysMismatch
      ? [el("span", { class: "warn-badge soft" }, ["⚠ Key colors don't match the grid's locks"])]
      : []),
    ...(!shortPieces.length && !shortKeys.length && !keysMismatch && excessPieces.length
      ? [el("span", { class: "warn-badge soft" }, ["⚠ Some queued capacity won't be used"])]
      : []),
  ]);

  const foldout = el("section", { class: "foldout" }, [head]);
  if (!ui.foldoutOpen) return foldout;

  const pieceRows = el("div", { class: "piece-rows" });
  for (const rawId of [...rawIds].sort((a, b) => a - b)) {
    const { have, need } = pieceCounts.get(rawId)!;
    pieceRows.append(
      el("div", { class: `piece-row${have < need ? " short" : have > need ? " excess" : ""}` }, [
        ingredientIconEl(rawId, 48),
        el("span", {}, [`${have} / ${need}`]),
      ]),
    );
  }

  const keyRows = el("div", { class: "piece-rows" });
  const colorIds = new Set([...keysHeld.keys(), ...keysNeeded.keys()]);
  for (const colorId of [...colorIds].sort((a, b) => a - b)) {
    const need = keysNeeded.get(colorId) ?? 0;
    const have = keysHeld.get(colorId) ?? 0;
    const swatch = el("span", { class: "key-swatch" });
    swatch.style.background = KEY_COLORS[colorId]?.hex ?? "transparent";
    keyRows.append(
      el("div", { class: `piece-row${have < need ? " short" : ""}` }, [
        swatch,
        el("span", {}, [`${have} / ${need}`]),
      ]),
    );
  }

  foldout.append(
    el("div", { class: "foldout-body" }, [
      el("div", {}, [el("small", {}, ["Uses (have / need)"]), pieceRows]),
      ...(colorIds.size
        ? [el("div", {}, [el("small", {}, ["Keys (held / locks)"]), keyRows])]
        : []),
    ]),
  );
  return foldout;
}
