// Icon rendering. Every definition row carries its own `fileId` (Google Drive)
// plus an emoji fallback, so icons come straight from the config tree under
// src/data/config/. All tiles/chips/cells render through here, which means a
// missing or blocked image degrades to the emoji in exactly one place.

import type { CookingToolDef, ElementDef, MapDef } from "../core/types.ts";
import { GLOBAL_DEFS, MAP1_DATA } from "../data/configLoader.ts";
import { el } from "./dom.ts";

export interface IconSpec {
  name: string;
  emoji: string;
  fileId?: string;
}

/** Drive's thumbnail endpoint serves images cross-origin; `uc?export=view` does not. */
export function driveThumbUrl(fileId: string, size = 128): string {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${size}`;
}

/**
 * Renders an icon as a Drive <img>, keeping the emoji fallback in place until
 * the image actually loads (and restoring it if the load fails).
 */
export function iconEl(
  spec: IconSpec | undefined,
  opts: { size?: number; className?: string } = {},
): HTMLElement {
  const fallback = spec?.emoji || "❔";
  const wrap = el("span", { class: `icon ${opts.className ?? ""}` }, [fallback]);
  wrap.title = spec?.name ?? "";
  if (!spec?.fileId) return wrap;

  const img = el("img", {
    src: driveThumbUrl(spec.fileId, opts.size ?? 128),
    alt: spec.name,
    loading: "lazy",
  }) as HTMLImageElement;
  img.addEventListener("error", () => {
    img.remove();
    wrap.classList.add("icon-fallback");
  });
  img.addEventListener("load", () => {
    wrap.textContent = "";
    wrap.append(img);
  });
  return wrap;
}

// ---------- lookups ----------
//
// The active map is set once by the app shell so the section renderers can ask
// for an icon by id without threading the map through every call.

let activeMap: MapDef | { rawIngredients: MapDef["rawIngredients"]; cookedIngredients: MapDef["cookedIngredients"]; tools: CookingToolDef[] } =
  MAP1_DATA as unknown as MapDef;

export function setIconMap(map: MapDef): void {
  activeMap = map;
}

const specOf = (def: { name: string; icon: string; fileId?: string } | undefined): IconSpec | undefined =>
  def ? { name: def.name, emoji: def.icon, fileId: def.fileId } : undefined;

const defSpec = (defs: ElementDef[], id: number) => specOf(defs.find((d) => d.id === id));

export const ingredientIconEl = (id: number, size?: number) =>
  iconEl(specOf(activeMap.rawIngredients.find((r) => r.id === id)), {
    size,
    className: "icon-ingredient",
  });

export const cookedIconEl = (id: number, size?: number) =>
  iconEl(specOf(activeMap.cookedIngredients.find((c) => c.id === id)), {
    size,
    className: "icon-ingredient",
  });

export const statusIconEl = (id: number, size?: number) =>
  iconEl(defSpec(GLOBAL_DEFS.effects, id), { size, className: "icon-status" });

export const cellIconEl = (id: number, size?: number) =>
  iconEl(defSpec(GLOBAL_DEFS.cellTypes, id), { size, className: "icon-cell" });

export const toolIconEl = (tool: CookingToolDef, size?: number) =>
  iconEl({ name: tool.name, emoji: tool.icon ?? "🍳", fileId: tool.fileId }, {
    size,
    className: "icon-tool",
  });
