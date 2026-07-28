// Icon rendering. Icons live in Google Drive; the JSON tables under
// src/data/icons/ map each element id to its Drive fileId (harvested from the
// sheet's ConfigTables IMAGE() formulas). Every tile/chip/cell renders through
// here so a missing or blocked image degrades to the emoji fallback in one place.

import cellStatusesJson from "../data/icons/cellStatuses.json";
import ingredientStatusesJson from "../data/icons/ingredientStatuses.json";
import ingredientsJson from "../data/icons/ingredients.json";
import { el } from "./dom.ts";

export interface IconEntry {
  id: number;
  name: string;
  emoji: string;
  fileId: string;
  code?: string;
}

interface IconTable {
  icons: IconEntry[];
}

export const INGREDIENT_ICONS = (ingredientsJson as IconTable).icons;
export const INGREDIENT_STATUS_ICONS = (ingredientStatusesJson as IconTable).icons;
export const CELL_STATUS_ICONS = (cellStatusesJson as IconTable).icons;

function find(table: IconEntry[], id: number): IconEntry | undefined {
  return table.find((i) => i.id === id);
}

export const ingredientIcon = (id: number) => find(INGREDIENT_ICONS, id);
export const ingredientStatusIcon = (id: number) => find(INGREDIENT_STATUS_ICONS, id);
export const cellStatusIcon = (id: number) => find(CELL_STATUS_ICONS, id);

/** Drive's thumbnail endpoint serves images cross-origin; `uc?export=view` does not. */
export function driveThumbUrl(fileId: string, size = 128): string {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${size}`;
}

/**
 * Renders an icon as a Drive <img>, swapping in the emoji fallback if the image
 * fails to load (Drive permissions, offline, or no fileId recorded).
 */
export function iconEl(
  entry: IconEntry | undefined,
  opts: { size?: number; className?: string } = {},
): HTMLElement {
  const fallback = entry?.emoji ?? "❔";
  const wrap = el("span", { class: `icon ${opts.className ?? ""}` }, [fallback]);
  wrap.title = entry?.name ?? "";
  if (!entry?.fileId) return wrap;

  const img = el("img", {
    src: driveThumbUrl(entry.fileId, opts.size ?? 128),
    alt: entry.name,
    loading: "lazy",
  }) as HTMLImageElement;
  img.addEventListener("error", () => {
    // Keep the emoji that is already in the wrapper.
    img.remove();
    wrap.classList.add("icon-fallback");
  });
  img.addEventListener("load", () => {
    wrap.textContent = "";
    wrap.append(img);
  });
  return wrap;
}

/** Convenience wrappers used by the sections. */
export const ingredientIconEl = (id: number, size?: number) =>
  iconEl(ingredientIcon(id), { size, className: "icon-ingredient" });

export const statusIconEl = (id: number, size?: number) =>
  iconEl(ingredientStatusIcon(id), { size, className: "icon-status" });

export const cellIconEl = (id: number, size?: number) =>
  iconEl(cellStatusIcon(id), { size, className: "icon-cell" });
