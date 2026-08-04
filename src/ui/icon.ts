// Icon rendering. Every definition row can carry a bundled local image
// (src/assets/, see localImages.ts), a Google Drive `fileId`, and an emoji.
// Load order is local -> Drive -> emoji: try the tool's own art first (it's
// bundled, so there's nothing to wait on), fall back to Drive if there's no
// local image or it fails to load, and fall back to the emoji if that fails
// too. All tiles/chips/cells render through here, which means a missing or
// blocked image degrades gracefully in exactly one place.

import type { CookingToolDef, ElementDef, MapDef } from "../core/types.ts";
import { BOOSTER_PARAMS, GLOBAL_DEFS, MAP1_DATA } from "../data/configLoader.ts";
import { el } from "./dom.ts";
import { localImageUrl } from "./localImages.ts";

export interface IconSpec {
  name: string;
  emoji: string;
  fileId?: string;
  /** Path relative to src/assets/, e.g. "Map1-burger/ingredients/foo.png". */
  localImage?: string;
}

/** Drive's thumbnail endpoint serves images cross-origin; `uc?export=view` does not. */
export function driveThumbUrl(fileId: string, size = 128): string {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${size}`;
}

/**
 * fileIds confirmed already loaded, populated by imagePreload.ts. iconEl()
 * consults this so a preloaded icon renders its image on the very first
 * paint instead of the emoji-then-swap flash — the whole point of preloading.
 */
export const preloadedFileIds = new Set<string>();

/**
 * Renders an icon: local bundled image first (if the row has one and it
 * resolved to a real bundled asset), then the Drive `fileId` fallback, then
 * the emoji. Each tier only takes over if the previous one is missing or
 * fails to load, so a bad/missing local path or a blocked Drive thumbnail
 * degrade gracefully instead of showing a broken image.
 */
export function iconEl(
  spec: IconSpec | undefined,
  opts: { size?: number; className?: string } = {},
): HTMLElement {
  const fallback = spec?.emoji || "❔";
  const wrap = el("span", { class: `icon ${opts.className ?? ""}` }, [fallback]);
  wrap.title = spec?.name ?? "";

  const localUrl = localImageUrl(spec?.localImage);
  if (localUrl) {
    const img = el("img", { src: localUrl, alt: spec?.name ?? "" }) as HTMLImageElement;
    img.addEventListener("error", () => {
      // The bundled asset itself failed to load — drop to the Drive/emoji
      // chain exactly as if there had been no local image at all.
      img.remove();
      wrap.textContent = fallback;
      attachDriveFallback(wrap, spec, opts, fallback);
    });
    wrap.textContent = "";
    wrap.append(img);
    return wrap;
  }

  attachDriveFallback(wrap, spec, opts, fallback);
  return wrap;
}

function attachDriveFallback(
  wrap: HTMLElement,
  spec: IconSpec | undefined,
  opts: { size?: number },
  fallback: string,
): void {
  if (!spec?.fileId) return;

  const preloaded = preloadedFileIds.has(spec.fileId);
  const img = el("img", {
    src: driveThumbUrl(spec.fileId, opts.size ?? 128),
    alt: spec.name,
    loading: preloaded ? "eager" : "lazy",
  }) as HTMLImageElement;
  img.addEventListener("error", () => {
    img.remove();
    wrap.classList.add("icon-fallback");
    wrap.textContent = fallback;
  });

  if (preloaded) {
    wrap.textContent = "";
    wrap.append(img);
    return;
  }

  img.addEventListener("load", () => {
    wrap.textContent = "";
    wrap.append(img);
  });
}

// ---------- lookups ----------
//
// The active map is set once by the app shell so the section renderers can ask
// for an icon by id without threading the map through every call.

interface IconMapSource {
  rawIngredients: MapDef["rawIngredients"];
  cookedIngredients: MapDef["cookedIngredients"];
  dirtyObjects: MapDef["dirtyObjects"];
  tools: CookingToolDef[];
}

let activeMap: IconMapSource = MAP1_DATA as unknown as MapDef;

/** Called whenever the active map is established or changes (see main.ts). */
export function setIconMap(map: IconMapSource): void {
  activeMap = map;
}

const specOf = (
  def: { name: string; icon: string; fileId?: string; localImage?: string } | undefined,
): IconSpec | undefined =>
  def ? { name: def.name, emoji: def.icon, fileId: def.fileId, localImage: def.localImage } : undefined;

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

export const customerTypeIconEl = (id: number, size?: number) =>
  iconEl(defSpec(GLOBAL_DEFS.customerTypes, id), { size, className: "icon-customer-type" });

export const boosterIconEl = (id: number, size?: number) =>
  iconEl(defSpec(GLOBAL_DEFS.boosters, id), { size, className: "icon-status" });

export const backpackIconEl = (size?: number) =>
  iconEl(BOOSTER_PARAMS.backpack, { size, className: "icon-status" });

export const toolIconEl = (tool: CookingToolDef, size?: number) =>
  iconEl(
    { name: tool.name, emoji: tool.icon ?? "🍳", fileId: tool.fileId, localImage: tool.localImage },
    { size, className: "icon-tool" },
  );

/**
 * A dirty object left behind by a served customer. `id` not matching any of
 * the active map's dirtyObjects (e.g. the legacy DIRTY_DISH_ID sentinel, on
 * maps that don't define typed dirty objects) falls back to the plain plate
 * emoji — the tool's original one-size-fits-all dirty dish.
 */
export const dirtyIconEl = (id: number, size?: number) => {
  const def = activeMap.dirtyObjects.find((d) => d.id === id);
  return iconEl(def ? specOf(def) : { name: "Dirty dish", emoji: "🍽" }, {
    size,
    className: "icon-dirty",
  });
};
