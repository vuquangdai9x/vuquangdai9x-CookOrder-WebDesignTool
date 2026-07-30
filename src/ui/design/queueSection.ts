// Ingredient Queue Reorder — bottom tier of the Design page.
// See docs/ToolDesign.md "Ingredient Queue Reorder window".

import Sortable from "sortablejs";
import {
  CELL_COLOR_LOCK,
  EFFECT_FREEZE,
  EFFECT_HOLDING_KEY,
  EFFECT_LINK,
} from "../../core/effects.ts";
import { serializeQueues, SWEEPER_ID } from "../../core/parser.ts";
import type {
  CustomerConfig,
  GlobalDefs,
  GridCellConfig,
  MapDef,
  QueueItem,
} from "../../core/types.ts";
import { KEY_COLORS } from "../../data/configLoader.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import { numberField, pickerGrid, showContextMenu, swatchRow } from "../contextMenu.ts";
import type { MenuItem } from "../contextMenu.ts";
import { button, el } from "../dom.ts";
import { ingredientIconEl, statusIconEl } from "../icon.ts";
import { changeClass, cidOf, leafStatus, tagAllNew, tagNew } from "./changeTracking.ts";
import type { ChangeStatus } from "./changeTracking.ts";
import { Section } from "./section.ts";

export interface QueueSectionDeps {
  map: MapDef;
  defs: GlobalDefs;
  level: LevelData;
  parse(): QueueItem[][];
  /** Live view of the other two sections' drafts, for the Recipe Pieces foldout. */
  currentCustomers(): CustomerConfig[];
  currentGrid(): GridCellConfig[];
  onSaved(): void;
}

interface QueueUiState {
  activeLane: number;
  zoom: number;
  removeMode: boolean;
  /** Items deleted during the current Remove Mode session, for "Undo All Removes". */
  removedSnapshot: QueueItem[][] | null;
  foldoutOpen: boolean;
  drawerOpen: boolean;
}

/** Tags every lane (container identity) and every item within it (leaf identity). */
function tagQueues(queues: QueueItem[][]): QueueItem[][] {
  tagAllNew(queues);
  for (const lane of queues) tagAllNew(lane);
  return queues;
}

const sameQueueItem = (a: QueueItem, b: QueueItem) =>
  a.kind === b.kind && a.id === b.id && JSON.stringify(a.effects) === JSON.stringify(b.effects);

export function createQueueSection(deps: QueueSectionDeps): Section<QueueItem[][]> {
  const ui: QueueUiState = {
    activeLane: 0,
    zoom: 1,
    removeMode: false,
    removedSnapshot: null,
    foldoutOpen: true,
    drawerOpen: false,
  };

  const section: Section<QueueItem[][]> = new Section<QueueItem[][]>({
    title: "Ingredient Queues",
    saveLabel: "Save Order",
    initial: tagQueues(deps.parse()),
    renderBody: (draft, body) => renderBody(section, deps, ui, draft, body),
    save: (draft) => {
      deps.level.queueString = serializeQueues(draft);
      deps.onSaved();
    },
    stringPreview: (draft) => serializeQueues(draft),
    headerButtons: (sec) => [
      button("＋ Queue", () => {
        sec.draft.push(tagNew([]));
        sec.commit("Add queue");
      }, { class: "small-btn", title: "Append a new queue" }),
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
          ui.removedSnapshot = ui.removeMode ? structuredClone(draft) : null;
          section.render();
        },
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
          const removed = draft.reduce((n, q) => n + q.length, 0);
          draft.forEach((lane) => (lane.length = 0));
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
  section: Section<QueueItem[][]>,
  deps: QueueSectionDeps,
  ui: QueueUiState,
  draft: QueueItem[][],
  body: HTMLElement,
): void {
  body.append(recipeFoldout(section, deps, ui, draft));
  body.append(toolbar(section, ui));

  const lanes = el("div", { class: `queue-lanes${ui.removeMode ? " remove-mode" : ""}` });
  lanes.style.setProperty("--tile-zoom", String(ui.zoom));

  // Compared against once per render — reordering/adding/removing during a
  // render doesn't shift this baseline out from under the diff.
  const savedQueues = section.savedState;
  draft.forEach((lane, laneIndex) => {
    lanes.append(laneEl(section, deps, ui, draft, lane, laneIndex, savedQueues));
  });

  // Lane reordering: drag a lane by its header.
  Sortable.create(lanes, {
    animation: 150,
    draggable: ".queue-lane",
    handle: ".lane-head",
    onEnd: (evt) => {
      if (evt.oldIndex === undefined || evt.newIndex === undefined) return;
      if (evt.oldIndex === evt.newIndex) return;
      const [moved] = draft.splice(evt.oldIndex, 1);
      draft.splice(Math.min(evt.newIndex, draft.length), 0, moved);
      section.commit("Reorder lanes");
    },
  });

  body.append(lanes);

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

function toolbar(section: Section<QueueItem[][]>, ui: QueueUiState): HTMLElement {
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
  section: Section<QueueItem[][]>,
  deps: QueueSectionDeps,
  ui: QueueUiState,
  draft: QueueItem[][],
  lane: QueueItem[],
  laneIndex: number,
  savedQueues: QueueItem[][],
): HTMLElement {
  const node = el("div", {
    class: `queue-lane${ui.activeLane === laneIndex ? " active" : ""} ${changeClass(laneStatus(lane, savedQueues))}`,
  });
  node.addEventListener("click", () => {
    if (ui.activeLane === laneIndex) return;
    ui.activeLane = laneIndex;
    section.render();
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
    showContextMenu(e, [ingredientPickerItem(deps, (id) => {
      lane.push(tagNew({ kind: id < 0 ? "sweeper" : "ingredient", id, effects: [] }));
      section.commit("Add ingredient", 1);
    })], { title: `Queue ${laneIndex + 1}` });
  });
  tiles.append(addTile);

  // Tiles drag within and between lanes (shared group).
  Sortable.create(tiles, {
    group: "queue-tiles",
    animation: 150,
    disabled: ui.removeMode,
    draggable: ".queue-tile:not(.add-tile)",
    onEnd: (evt) => {
      const from = Number((evt.from.closest(".queue-lane") as HTMLElement)?.dataset.lane);
      const to = Number((evt.to.closest(".queue-lane") as HTMLElement)?.dataset.lane);
      if (Number.isNaN(from) || Number.isNaN(to)) return;
      if (evt.oldIndex === undefined || evt.newIndex === undefined) return;
      if (from === to && evt.oldIndex === evt.newIndex) return;
      const [moved] = draft[from].splice(evt.oldIndex, 1);
      if (!moved) return;
      draft[to].splice(Math.min(evt.newIndex, draft[to].length), 0, moved);
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
  section: Section<QueueItem[][]>,
  deps: QueueSectionDeps,
  ui: QueueUiState,
  draft: QueueItem[][],
  lane: QueueItem[],
  item: QueueItem,
  itemIndex: number,
  savedQueues: QueueItem[][],
): HTMLElement {
  const freeze = item.effects.find((e) => e.effectId === EFFECT_FREEZE);
  const link = item.effects.find((e) => e.effectId === EFFECT_LINK);
  const key = item.effects.find((e) => e.effectId === EFFECT_HOLDING_KEY);
  // param 0 = continue the link (draw the connector), 1 = broken. Only needs
  // a next item to exist in the lane — the next item's own effects don't matter.
  const linkBridges = !!link && !link.params[0] && itemIndex + 1 < lane.length;

  const tile = el("div", {
    class: [
      "queue-tile",
      freeze ? "frozen" : "",
      linkBridges ? "linked" : "",
      item.kind === "sweeper" ? "sweeper" : "",
      changeClass(tileStatus(item, savedQueues)),
    ]
      .filter(Boolean)
      .join(" "),
  });

  tile.append(
    item.kind === "sweeper"
      ? el("span", { class: "tile-main" }, ["🧹"])
      : el("span", { class: "tile-main" }, [ingredientIconEl(item.id, 96)]),
  );

  // Statuses other than the three with dedicated visuals show as a corner icon.
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
      section.commit("Remove ingredient", 0, 1);
    },
    { class: "tile-remove", title: "Remove" },
  );
  tile.append(remove);

  if (ui.removeMode) {
    tile.addEventListener("click", (e) => {
      e.stopPropagation();
      lane.splice(itemIndex, 1);
      section.commit("Remove ingredient", 0, 1);
    });
  }

  tile.addEventListener("contextmenu", (e) => {
    e.stopPropagation();
    showContextMenu(e, tileMenu(section, deps, draft, lane, item, itemIndex), {
      title: deps.map.rawIngredients.find((r) => r.id === item.id)?.name ?? "Item",
    });
  });
  return tile;
}

// ---------- menus ----------

function ingredientPickerItem(
  deps: QueueSectionDeps,
  onPick: (id: number) => void,
): MenuItem {
  return {
    label: "Pick ingredient",
    expand: (close) =>
      pickerGrid(
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
          close();
        },
      ),
  };
}

function laneMenu(
  section: Section<QueueItem[][]>,
  draft: QueueItem[][],
  laneIndex: number,
): MenuItem[] {
  return [
    {
      label: "Insert Queue Left",
      onSelect: () => {
        draft.splice(laneIndex, 0, tagNew([]));
        section.commit("Insert queue left");
      },
    },
    {
      label: "Insert Queue Right",
      onSelect: () => {
        draft.splice(laneIndex + 1, 0, tagNew([]));
        section.commit("Insert queue right");
      },
    },
    {
      label: "Clear Queue",
      separator: true,
      onSelect: () => {
        // Empty it in place (not a fresh array) so the lane keeps its identity —
        // it's the same lane with everything removed, not a new empty one.
        const removed = draft[laneIndex].length;
        draft[laneIndex].length = 0;
        section.commit("Clear queue", 0, removed);
      },
    },
    {
      label: "Remove Queue",
      danger: true,
      disabled: draft.length <= 1,
      onSelect: () => {
        if (draft[laneIndex].length && !confirm("This queue still has items. Remove it?")) return;
        const removed = draft[laneIndex].length;
        draft.splice(laneIndex, 1);
        section.commit("Remove queue", 0, removed);
      },
    },
  ];
}

function tileMenu(
  section: Section<QueueItem[][]>,
  deps: QueueSectionDeps,
  _draft: QueueItem[][],
  lane: QueueItem[],
  item: QueueItem,
  itemIndex: number,
): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: "Insert Before",
      expand: (close) =>
        pickerGrid(
          deps.map.rawIngredients.map((r) => ({
            id: r.id,
            label: r.name,
            icon: ingredientIconEl(r.id, 64),
          })),
          (id) => {
            lane.splice(itemIndex, 0, tagNew({ kind: "ingredient", id, effects: [] }));
            section.commit("Insert ingredient before", 1);
            close();
          },
        ),
    },
    {
      label: "Insert After",
      expand: (close) =>
        pickerGrid(
          deps.map.rawIngredients.map((r) => ({
            id: r.id,
            label: r.name,
            icon: ingredientIconEl(r.id, 64),
          })),
          (id) => {
            lane.splice(itemIndex + 1, 0, tagNew({ kind: "ingredient", id, effects: [] }));
            section.commit("Insert ingredient after", 1);
            close();
          },
        ),
    },
  ];

  for (const def of deps.defs.effects.filter((d) => d.id !== 0)) {
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
      section.commit("Remove ingredient", 0, 1);
    },
  });
  return items;
}

// ---------- Remove Mode / Quick Add ----------

function removeModeBar(
  section: Section<QueueItem[][]>,
  ui: QueueUiState,
  draft: QueueItem[][],
): HTMLElement {
  return el("div", { class: "remove-bar" }, [
    el("span", {}, ["Remove Mode — click tiles to delete"]),
    button("Undo All Removes", () => {
      if (!ui.removedSnapshot) return;
      draft.length = 0;
      draft.push(...structuredClone(ui.removedSnapshot));
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
  section: Section<QueueItem[][]>,
  deps: QueueSectionDeps,
  ui: QueueUiState,
  draft: QueueItem[][],
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
    (draft[ui.activeLane] ?? draft[0]).push(
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
  section: Section<QueueItem[][]>,
  deps: QueueSectionDeps,
  draft: QueueItem[][],
): void {
  if (!confirm("Auto-generate overwrites every lane. Continue?")) return;
  const demand = demandByRaw(deps);
  const pool: QueueItem[] = [];
  for (const [rawId, count] of demand) {
    for (let i = 0; i < count; i++) pool.push(tagNew({ kind: "ingredient", id: rawId, effects: [] }));
  }
  // Interleave so no lane is a run of one ingredient.
  pool.sort(() => Math.random() - 0.5);

  const laneCount = Math.max(1, draft.length);
  const before = draft.reduce((n, q) => n + q.length, 0);
  draft.length = 0;
  for (let i = 0; i < laneCount; i++) draft.push(tagNew([]));
  pool.forEach((item, i) => draft[i % laneCount].push(item));
  section.commit("Auto-generate queue", pool.length, before);
}

function shuffle(
  section: Section<QueueItem[][]>,
  deps: QueueSectionDeps,
  draft: QueueItem[][],
): void {
  const answer = prompt("Max shuffle distance", String(deps.level.shuffleDistance || 3));
  if (answer === null) return;
  const distance = Math.max(0, Number(answer) || 0);
  if (distance === 0) return;
  deps.level.shuffleDistance = distance;
  // Local jitter only: items never cross lanes.
  for (const lane of draft) {
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
  section: Section<QueueItem[][]>,
  deps: QueueSectionDeps,
  ui: QueueUiState,
  draft: QueueItem[][],
): HTMLElement {
  const demand = demandByRaw(deps);
  const supply = new Map<number, number>();
  for (const lane of draft) {
    for (const item of lane) {
      if (item.kind !== "ingredient") continue;
      supply.set(item.id, (supply.get(item.id) ?? 0) + 1);
    }
  }

  // Keys held by queue items vs. ColorLock demand on the grid.
  const keysHeld = new Map<number, number>();
  for (const lane of draft) {
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
