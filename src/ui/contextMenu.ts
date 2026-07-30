// Reusable right-click context menu with inline expanding sub-editors.
// Used by the grid cells, queue tiles/lanes, and customer cards.
// See docs/ToolDesign.md.

import { el } from "./dom.ts";

export interface MenuItem {
  label: string;
  /** Optional leading icon element (Drive image or emoji span). */
  icon?: HTMLElement;
  /** Renders the item highlighted (e.g. the cell's current type). */
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Runs and closes the menu. Omit when using `expand`. */
  onSelect?(): void;
  /**
   * Inline sub-editor: returns the element shown under the item when clicked
   * (ingredient picker, colour swatches, number inputs). Call `close()` from
   * inside once the designer commits.
   */
  expand?(close: () => void): HTMLElement;
  /** Separator line above this item. */
  separator?: boolean;
}

let openMenu: HTMLElement | null = null;

export function closeContextMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

document.addEventListener("click", (e) => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeContextMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeContextMenu();
});

export function showContextMenu(
  event: MouseEvent,
  items: MenuItem[],
  opts: { title?: string } = {},
): void {
  event.preventDefault();
  event.stopPropagation();
  closeContextMenu();

  const menu = el("div", { class: "ctx-menu" });
  if (opts.title) menu.append(el("div", { class: "ctx-title" }, [opts.title]));

  for (const item of items) {
    if (item.separator) menu.append(el("div", { class: "ctx-sep" }));
    const row = el("div", {
      class: `ctx-item${item.active ? " active" : ""}${item.danger ? " danger" : ""}${
        item.disabled ? " disabled" : ""
      }`,
    });
    if (item.icon) row.append(item.icon);
    row.append(el("span", { class: "ctx-label" }, [item.label]));

    let expansion: HTMLElement | null = null;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (item.disabled) return;
      if (item.expand) {
        if (expansion) {
          expansion.remove();
          expansion = null;
          return;
        }
        expansion = item.expand(closeContextMenu);
        expansion.classList.add("ctx-expansion");
        row.after(expansion);
      } else {
        item.onSelect?.();
        closeContextMenu();
      }
    });
    menu.append(row);
  }

  document.body.append(menu);
  openMenu = menu;

  // Keep the menu inside the viewport.
  const rect = menu.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - rect.width - 8);
  const y = Math.min(event.clientY, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(4, x)}px`;
  menu.style.top = `${Math.max(4, y)}px`;
}

/** Number input row for an inline sub-editor. */
export function numberField(
  label: string,
  value: number,
  onCommit: (v: number) => void,
): HTMLElement {
  const input = el("input", { type: "number", value: String(value) }) as HTMLInputElement;
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("change", () => onCommit(Number(input.value) || 0));
  return el("label", { class: "ctx-field" }, [label, input]);
}

/** Grid of clickable thumbnails for an inline sub-editor. */
export function pickerGrid(
  entries: { id: number; label: string; icon: HTMLElement }[],
  onPick: (id: number) => void,
  selectedId?: number,
): HTMLElement {
  const grid = el("div", { class: "ctx-picker" });
  for (const entry of entries) {
    const cell = el("button", {
      class: `ctx-pick${entry.id === selectedId ? " active" : ""}`,
      title: entry.label,
    });
    cell.append(entry.icon);
    cell.addEventListener("click", (e) => {
      e.stopPropagation();
      onPick(entry.id);
    });
    grid.append(cell);
  }
  return grid;
}

/**
 * Multi-select toggle grid: clicking an entry adds/removes its id from
 * `selectedIds` in place and re-renders the active states — it does NOT close
 * the menu (the caller passes this as a MenuItem's `expand`, and the menu's
 * existing click-outside/Escape handling is what closes it, matching "keep
 * the window open, toggle on/off, click outside to close"). Each id can only
 * be selected once, so re-clicking a selected entry removes it rather than
 * adding a duplicate.
 */
export function toggleGrid(
  entries: { id: number; label: string; icon: HTMLElement }[],
  selectedIds: number[],
  onToggle: (id: number, nowSelected: boolean) => void,
): HTMLElement {
  const grid = el("div", { class: "ctx-picker" });
  for (const entry of entries) {
    const cell = el("button", {
      class: `ctx-pick${selectedIds.includes(entry.id) ? " active" : ""}`,
      title: entry.label,
    });
    cell.append(entry.icon);
    cell.addEventListener("click", (e) => {
      e.stopPropagation();
      const nowSelected = !cell.classList.contains("active");
      cell.classList.toggle("active", nowSelected);
      onToggle(entry.id, nowSelected);
    });
    grid.append(cell);
  }
  return grid;
}

/** Colour swatch row (used by ColorLock cells and HoldingKey statuses). */
export function swatchRow(
  colors: { id: number; name: string; hex: string }[],
  onPick: (id: number) => void,
  selectedId?: number,
): HTMLElement {
  const row = el("div", { class: "ctx-swatches" });
  for (const color of colors) {
    const swatch = el("button", {
      class: `ctx-swatch${color.id === selectedId ? " active" : ""}`,
      title: color.name,
    });
    // Sheet stores #RRGGBBAA; CSS accepts it directly.
    swatch.style.background = color.hex;
    swatch.addEventListener("click", (e) => {
      e.stopPropagation();
      onPick(color.id);
    });
    row.append(swatch);
  }
  return row;
}
