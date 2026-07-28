// Grid Config — middle tier of the Design page.
// See docs/ToolDesign.md "Grid Config window".

import {
  CELL_COLOR_LOCK,
  CELL_INGREDIENT_SLOT,
} from "../../core/effects.ts";
import { serializeGrid } from "../../core/parser.ts";
import type { GlobalDefs, GridCellConfig, MapDef } from "../../core/types.ts";
import { KEY_COLORS } from "../../data/initialData.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import { numberField, pickerGrid, showContextMenu, swatchRow } from "../contextMenu.ts";
import type { MenuItem } from "../contextMenu.ts";
import { button, el } from "../dom.ts";
import { cellIconEl, ingredientIconEl } from "../icon.ts";
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
    menuItems: (draft) => [
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
  const { gridWidth, gridHeight } = deps.level;

  const sizeRow = el("div", { class: "grid-size" });
  const sizeField = (label: string, value: number, apply: (v: number) => void) => {
    const input = el("input", { type: "number", value: String(value), min: "1" }) as HTMLInputElement;
    input.addEventListener("change", () => {
      apply(Math.max(1, Number(input.value) || 1));
      resizeDraft(draft, deps.level.gridWidth * deps.level.gridHeight);
      section.commit(`Resize grid`);
    });
    return el("label", { class: "field small" }, [label, input]);
  };
  sizeRow.append(
    sizeField("Cols", gridWidth, (v) => (deps.level.gridWidth = v)),
    sizeField("Rows", gridHeight, (v) => (deps.level.gridHeight = v)),
  );

  const grid = el("div", { class: "grid editable" });
  grid.style.gridTemplateColumns = `repeat(${gridWidth}, 1fr)`;

  draft.forEach((cell, index) => {
    grid.append(cellEl(section, deps, draft, cell, index));
  });

  body.append(sizeRow, grid);
}

function resizeDraft(draft: GridCellConfig[], want: number): void {
  while (draft.length < want) draft.push({ effects: [] });
  draft.length = want;
}

function cellEl(
  section: Section<GridCellConfig[]>,
  deps: GridSectionDeps,
  draft: GridCellConfig[],
  cell: GridCellConfig,
  index: number,
): HTMLElement {
  const effect = cell.effects[0];
  const typeDef = effect ? deps.defs.cellTypes.find((d) => d.id === effect.effectId) : undefined;
  const x = index % deps.level.gridWidth;
  const y = Math.floor(index / deps.level.gridWidth);

  const node = el("div", { class: `cell${effect ? " typed" : ""}` });
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
  node.addEventListener("contextmenu", open);
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
