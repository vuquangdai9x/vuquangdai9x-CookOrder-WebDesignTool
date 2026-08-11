// Grid Config — middle tier of the Design page.
// See docs/ToolDesign.md "Grid Config window".

import {
  CELL_COLOR_LOCK,
  CELL_INGREDIENT_SLOT,
} from "../../core/effects.ts";
import { parseGrid, serializeGrid } from "../../core/parser.ts";
import type { GlobalDefs, GridCellConfig, MapDef } from "../../core/types.ts";
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
import { cellIconEl, ingredientIconEl } from "../icon.ts";
import { changeClass } from "./changeTracking.ts";
import type { ChangeStatus } from "./changeTracking.ts";
import { Section } from "./section.ts";

export interface GridSectionDeps {
  map: MapDef;
  defs: GlobalDefs;
  level: LevelData;
  parse(): GridCellConfig[];
  onSaved(): void;
  /** Lets the queue section's key/lock counts follow ColorLock edits live. */
  onCommit?(): void;
}

export function createGridSection(deps: GridSectionDeps): Section<GridCellConfig[]> {
  const section: Section<GridCellConfig[]> = new Section<GridCellConfig[]>({
    title: "Grid",
    saveLabel: "Save Grid",
    initial: deps.parse(),
    renderBody: (draft, body) => renderBody(section, deps, draft, body),
    onCommit: () => deps.onCommit?.(),
    save: (draft) => {
      deps.level.gridString = serializeGrid(draft);
      deps.onSaved();
    },
    stringPreview: (draft) => serializeGrid(draft),
    menuItems: (draft) => [
      {
        label: "Import from string…",
        expand: (close) =>
          importField(",,#4:1:1,,,,,#3,,", (text) => {
            const parsed = parseGrid(text);
            const want = deps.map.gridWidth * deps.map.gridHeight;
            if (parsed.length !== want) {
              throw new Error(`Expected ${want} cells (${deps.map.gridWidth}×${deps.map.gridHeight}), got ${parsed.length}`);
            }
            draft.length = 0;
            draft.push(...parsed);
            section.commit("Import grid from string");
            close();
          }),
      },
      {
        label: "Clear All",
        danger: true,
        separator: true,
        onSelect: () => {
          if (!confirm("Reset every cell to empty?")) return;
          const removed = draft.filter((c) => c.effects.length > 0).length;
          draft.forEach((cell) => (cell.effects = []));
          section.commit("Clear all cells", 0, removed);
        },
      },
    ],
  });
  section.render();
  return section;
}

function renderBody(
  section: Section<GridCellConfig[]>,
  deps: GridSectionDeps,
  draft: GridCellConfig[],
  body: HTMLElement,
): void {
  // Cols/Rows are fixed per map (see DesignView's Map Settings bar), not
  // editable here — every level in a map shares one board shape.
  const { gridWidth } = deps.map;

  const grid = el("div", { class: "grid editable" });
  grid.style.gridTemplateColumns = `repeat(${gridWidth}, 1fr)`;

  // Cells are positional (no reordering is possible), so the saved baseline
  // compares index-for-index — no identity tagging needed, unlike queues/customers.
  const savedGrid = section.savedState;
  draft.forEach((cell, index) => {
    grid.append(cellEl(section, deps, draft, cell, index, savedGrid[index]));
  });

  body.append(grid);
}

/**
 * Resizes a grid string to `width * height` cells, keeping existing cells at
 * their same flat index (row-major) where the new size still has that index,
 * padding new cells blank or truncating extras. Used when a map's Cols/Rows
 * setting changes, across every level in the map at once.
 */
export function resizeGridString(gridString: string, width: number, height: number): string {
  const cells = parseGrid(gridString);
  const want = width * height;
  while (cells.length < want) cells.push({ effects: [] });
  cells.length = want;
  return serializeGrid(cells);
}

/**
 * blank -> has an effect: added. had an effect -> different one (or params):
 * modified. had an effect -> blank now: removed-inside (the cell lost its
 * content). Resized-in cells with no saved counterpart count as added.
 */
function cellChangeStatus(
  current: GridCellConfig,
  saved: GridCellConfig | undefined,
): ChangeStatus | null {
  const now = current.effects[0];
  const before = saved?.effects[0];
  if (now && !before) return "added";
  if (!now && before) return "removed-inside";
  if (now && before) {
    if (now.effectId !== before.effectId || JSON.stringify(now.params) !== JSON.stringify(before.params)) {
      return "modified";
    }
  }
  return null;
}

function cellEl(
  section: Section<GridCellConfig[]>,
  deps: GridSectionDeps,
  draft: GridCellConfig[],
  cell: GridCellConfig,
  index: number,
  savedCell: GridCellConfig | undefined,
): HTMLElement {
  const effect = cell.effects[0];
  const typeDef = effect ? deps.defs.cellTypes.find((d) => d.id === effect.effectId) : undefined;
  const x = index % deps.map.gridWidth;
  const y = Math.floor(index / deps.map.gridWidth);
  const status = cellChangeStatus(cell, savedCell);

  const node = el("div", { class: `cell${effect ? " typed" : ""} ${changeClass(status)}` });
  node.append(el("small", { class: "cell-coord" }, [`${x},${y}`]));

  if (effect) {
    if (effect.effectId === CELL_INGREDIENT_SLOT) {
      // Corner type icon + centered ingredient thumbnail + amount badge.
      const [ingredientId = 0, amount = 1] = effect.params;
      node.append(
        el("span", { class: "cell-corner" }, [cellIconEl(effect.effectId, 48)]),
        el("span", { class: "cell-main" }, [ingredientIconEl(ingredientId, 96)]),
        el("span", { class: "cell-badge" }, [`×${amount}`]),
      );
    } else if (effect.effectId === CELL_COLOR_LOCK) {
      // Colour swatch behind the type icon + lock-amount badge.
      const [colorId = 0, amount = 1] = effect.params;
      const swatch = el("span", { class: "cell-swatch" }, [cellIconEl(effect.effectId, 64)]);
      swatch.style.background = KEY_COLORS[colorId]?.hex ?? "transparent";
      node.append(swatch, el("span", { class: "cell-badge" }, [`×${amount}`]));
    } else {
      node.append(el("span", { class: "cell-main" }, [cellIconEl(effect.effectId, 64)]));
      if (effect.params.length) {
        node.append(el("span", { class: "cell-badge" }, [effect.params.join(":")]));
      }
    }
    node.title = `${typeDef?.name ?? effect.effectId}${
      effect.params.length ? ` (${effect.params.join(":")})` : ""
    }`;
  } else {
    node.title = "Normal";
  }

  const open = (e: MouseEvent) =>
    showContextMenu(e, cellMenu(section, deps, draft, index), { title: `Cell ${x},${y}` });
  node.addEventListener("click", open);
  // Right-clicking a cell that's already an ingredient slot jumps straight to
  // swapping its ingredient — the full cell-type menu (left-click) is still
  // there for changing the cell's type itself.
  node.addEventListener("contextmenu", (e) => {
    if (effect?.effectId === CELL_INGREDIENT_SLOT) {
      const [ingredientId = 0, amount = 1] = effect.params;
      showContextContent(
        e,
        pickerGrid(
          deps.map.rawIngredients.map((r) => ({
            id: r.id,
            label: r.name,
            icon: ingredientIconEl(r.id, 64),
          })),
          (id) => {
            draft[index] = { effects: [{ effectId: CELL_INGREDIENT_SLOT, params: [id, amount] }] };
            section.commit("Swap cell ingredient");
            closeContextMenu();
          },
          ingredientId,
        ),
        { title: `Cell ${x},${y} — swap ingredient` },
      );
      return;
    }
    open(e);
  });
  return node;
}

function cellMenu(
  section: Section<GridCellConfig[]>,
  deps: GridSectionDeps,
  draft: GridCellConfig[],
  index: number,
): MenuItem[] {
  const current = draft[index].effects[0];
  const setCell = (effectId: number, params: number[]) => {
    draft[index] = { effects: effectId === 0 ? [] : [{ effectId, params }] };
    section.commit("Set cell type");
  };

  const items: MenuItem[] = deps.defs.cellTypes
    .filter((def) => def.id !== 0)
    .map((def) => {
      const active = current?.effectId === def.id;

      if (def.id === CELL_INGREDIENT_SLOT) {
        return {
          label: def.name,
          icon: cellIconEl(def.id, 48),
          active,
          expand: (close: () => void) => {
            const params = active ? [...current.params] : [0, 1];
            const wrap = el("div", { class: "ctx-sub" });
            wrap.append(
              pickerGrid(
                deps.map.rawIngredients.map((r) => ({
                  id: r.id,
                  label: r.name,
                  icon: ingredientIconEl(r.id, 64),
                })),
                (id) => {
                  params[0] = id;
                  wrap.querySelectorAll(".ctx-pick").forEach((b, i) => {
                    b.classList.toggle("active", deps.map.rawIngredients[i].id === id);
                  });
                },
                params[0],
              ),
              numberField("amount", params[1] ?? 1, (v) => (params[1] = v)),
              button(active ? "Update" : "Apply", () => {
                setCell(def.id, params);
                close();
              }),
            );
            return wrap;
          },
        };
      }

      if (def.id === CELL_COLOR_LOCK) {
        return {
          label: def.name,
          icon: cellIconEl(def.id, 48),
          active,
          expand: (close: () => void) => {
            const params = active ? [...current.params] : [1, 1];
            const wrap = el("div", { class: "ctx-sub" });
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
              numberField("keys", params[1] ?? 1, (v) => (params[1] = v)),
              button(active ? "Update" : "Apply", () => {
                setCell(def.id, params);
                close();
              }),
            );
            return wrap;
          },
        };
      }

      // Types with declared params get inputs; parameterless types apply directly.
      if (def.paramDefs.length === 0) {
        return {
          label: def.name,
          icon: cellIconEl(def.id, 48),
          active,
          onSelect: () => setCell(def.id, []),
        };
      }
      return {
        label: def.name,
        icon: cellIconEl(def.id, 48),
        active,
        expand: (close: () => void) => {
          const params = active ? [...current.params] : def.paramDefs.map(() => 1);
          const wrap = el("div", { class: "ctx-sub" });
          def.paramDefs.forEach((p, i) =>
            wrap.append(numberField(p.name, params[i] ?? 1, (v) => (params[i] = v))),
          );
          wrap.append(
            button(active ? "Update" : "Apply", () => {
              setCell(def.id, params);
              close();
            }),
          );
          return wrap;
        },
      };
    });

  items.push({
    label: "Empty (0)",
    active: !current,
    separator: true,
    onSelect: () => setCell(0, []),
  });
  return items;
}
