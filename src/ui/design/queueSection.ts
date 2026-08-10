// Ingredient Queue Reorder — bottom tier of the Design page.
// See docs/ToolDesign.md "Ingredient Queue Reorder window".
//
// The lanes form a real grid now: column x = queue index, row y = position
// (0 = front). Short lanes are padded with filler `.queue-tile.empty` cells so
// rows line up across columns — that's what gives a "combined-slot"/
// "linked-slot" group a meaningful (x,y) coordinate to reference.

import Sortable from "sortablejs";
import { CELL_COLOR_LOCK, EFFECT_FREEZE, EFFECT_HOLDING_KEY, EFFECT_LINK } from "../../core/effects.ts";
import { parseQueueGroups, parseQueues, serializeQueues, SWEEPER_ID } from "../../core/parser.ts";
import type {
  CustomerConfig,
  GlobalDefs,
  GridCellConfig,
  MapDef,
  QueueGroup,
  QueueGroupKind,
  QueueItem,
} from "../../core/types.ts";
import { KEY_COLORS } from "../../data/configLoader.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import { writeRowToSheet } from "../../data/sheetWrite.ts";
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
    writeToSheet: {
      write: (draft) =>
        writeRowToSheet(
          {
            mapIndex: deps.map.id,
            levelIndex: deps.level.id,
            weather: deps.level.weather,
            tag: deps.level.levelTag,
            unlock: deps.level.featureUnlock,
          },
          { ingredientQueue: serializeQueues(draft.queues, toCoordGroups(draft)) },
        ),
    },
    headerButtons: (sec) => [
      button("＋ Queue", () => {
        if (sec.draft.queues.length >= MAX_COLUMNS) return;
        sec.draft.queues.push(tagNew([]));
        sec.commit("Add queue");
      }, { class: "small-btn add-queue-btn", title: `Append a new queue (max ${MAX_COLUMNS})` }),
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
        label: "Auto-Generate Queue",
        onSelect: () => autoGenerate(section, deps, draft),
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
  body.append(recipeFoldout(section, deps, ui, draft));
  body.append(toolbar(section, ui));

  const lanes = el("div", { class: `queue-lanes${ui.removeMode ? " remove-mode" : ""}` });
  lanes.style.setProperty("--tile-zoom", String(ui.zoom));

  // Compared against once per render — reordering/adding/removing during a
  // render doesn't shift this baseline out from under the diff.
  const savedQueues = section.savedState.queues;
  const maxRows = draft.queues.reduce((h, q) => Math.max(h, q.length), 0);
  draft.queues.forEach((lane, laneIndex) => {
    lanes.append(laneEl(section, deps, ui, draft, lane, laneIndex, savedQueues, maxRows));
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

function toolbar(section: Section<QueueDraft>, ui: QueueUiState): HTMLElement {
  return el("div", { class: "queue-toolbar" }, [
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
    tiles.append(tileEl(section, deps, ui, draft, lane, item, itemIndex, savedQueues));
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
): HTMLElement {
  const freeze = item.effects.find((e) => e.effectId === EFFECT_FREEZE);
  const key = item.effects.find((e) => e.effectId === EFFECT_HOLDING_KEY);
  const cid = cidOf(item);
  const group = cid ? draft.groups.find((g) => g.cids.includes(cid)) : undefined;
  const selected = !!cid && ui.selection.has(cid);

  const tile = el("div", {
    class: [
      "queue-tile",
      freeze ? "frozen" : "",
      item.kind === "sweeper" ? "sweeper" : "",
      selected ? "selected" : "",
      group ? `group-${group.kind}` : "",
      changeClass(tileStatus(item, savedQueues)),
    ]
      .filter(Boolean)
      .join(" "),
  });
  if (cid) tile.dataset.cid = cid;

  tile.append(
    item.kind === "sweeper"
      ? el("span", { class: "tile-main" }, ["🧹"])
      : el("span", { class: "tile-main" }, [ingredientIconEl(item.id, 96)]),
  );

  // Statuses other than the two with dedicated visuals show as a corner icon.
  // EFFECT_LINK is retired (real linked groups supersede its old adjacency
  // bridge) but stays registered as a no-op so pre-existing strings parse —
  // it's excluded here so a stale marker doesn't draw a dead corner badge.
  const cornerEffects = item.effects.filter(
    (e) => e.effectId !== EFFECT_HOLDING_KEY && e.effectId !== EFFECT_LINK,
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

  for (const def of deps.defs.effects.filter((d) => d.id !== 0 && d.id !== EFFECT_LINK)) {
    const existing = item.effects.find((e) => e.effectId === def.id);
    items.push({
      label: def.name,
      icon: statusIconEl(def.id, 48),
      active: !!existing,
      separator: def.id === deps.defs.effects[1]?.id,
      expand: (close) => {
        const params = existing ? [...existing.params] : def.paramDefs.map(() => 1);
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
              params[0],
            ),
          );
        } else {
          def.paramDefs.forEach((p, i) =>
            wrap.append(numberField(p.name, params[i] ?? 1, (v) => (params[i] = v))),
          );
        }

        wrap.append(
          button(existing ? "Update" : "Apply", () => {
            item.effects = item.effects.filter((e) => e.effectId !== def.id);
            item.effects.push({ effectId: def.id, params });
            section.commit(`Set ${def.name}`);
            close();
          }),
          ...(existing
            ? [
                button(
                  "Remove",
                  () => {
                    item.effects = item.effects.filter((e) => e.effectId !== def.id);
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
 * Raw-ingredient demand implied by the customer orders. A tool recipe can yield
 * several pieces per raw unit (1 tomato → 2 slices), so demand is divided by
 * the yield and rounded up.
 */
function demandByRaw(deps: QueueSectionDeps): Map<number, number> {
  const cookedToRaw = new Map<number, { rawId: number; amount: number }>();
  for (const tool of deps.map.tools) {
    for (const recipe of tool.recipes) {
      cookedToRaw.set(recipe.out, { rawId: recipe.in, amount: recipe.amount });
    }
  }
  const pieces = new Map<number, number>();
  for (const customer of deps.currentCustomers()) {
    for (const dish of customer.dishes) {
      for (const cookedId of dish.cookedIds) {
        pieces.set(cookedId, (pieces.get(cookedId) ?? 0) + 1);
      }
    }
  }
  const demand = new Map<number, number>();
  for (const [cookedId, count] of pieces) {
    const via = cookedToRaw.get(cookedId);
    // No tool: the ingredient passes through as itself, one for one.
    const rawId = via?.rawId ?? cookedId;
    const need = Math.ceil(count / (via?.amount ?? 1));
    demand.set(rawId, (demand.get(rawId) ?? 0) + need);
  }
  return demand;
}

function autoGenerate(
  section: Section<QueueDraft>,
  deps: QueueSectionDeps,
  draft: QueueDraft,
): void {
  if (!confirm("Auto-generate overwrites every lane. Continue?")) return;
  const demand = demandByRaw(deps);
  const pool: QueueItem[] = [];
  for (const [rawId, count] of demand) {
    for (let i = 0; i < count; i++) pool.push(tagNew({ kind: "ingredient", id: rawId, effects: [] }));
  }
  // Interleave so no lane is a run of one ingredient.
  pool.sort(() => Math.random() - 0.5);

  const laneCount = Math.max(1, draft.queues.length);
  const before = draft.queues.reduce((n, q) => n + q.length, 0);
  draft.queues.length = 0;
  for (let i = 0; i < laneCount; i++) draft.queues.push(tagNew([]));
  pool.forEach((item, i) => draft.queues[i % laneCount].push(item));
  draft.groups = []; // authored groups don't survive a full regeneration
  section.commit("Auto-generate queue", pool.length, before);
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
  const demand = demandByRaw(deps);
  const supply = new Map<number, number>();
  for (const lane of draft.queues) {
    for (const item of lane) {
      if (item.kind !== "ingredient") continue;
      supply.set(item.id, (supply.get(item.id) ?? 0) + 1);
    }
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

  const shortPieces = [...demand].filter(([id, need]) => (supply.get(id) ?? 0) < need);
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
  ]);

  const foldout = el("section", { class: "foldout" }, [head]);
  if (!ui.foldoutOpen) return foldout;

  const pieceRows = el("div", { class: "piece-rows" });
  const rawIds = new Set([...demand.keys(), ...supply.keys()]);
  for (const rawId of [...rawIds].sort((a, b) => a - b)) {
    const need = demand.get(rawId) ?? 0;
    const have = supply.get(rawId) ?? 0;
    pieceRows.append(
      el("div", { class: `piece-row${have < need ? " short" : ""}` }, [
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
      el("div", {}, [el("small", {}, ["Ingredients (have / need)"]), pieceRows]),
      ...(colorIds.size
        ? [el("div", {}, [el("small", {}, ["Keys (held / locks)"]), keyRows])]
        : []),
    ]),
  );
  return foldout;
}
