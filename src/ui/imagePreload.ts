// Preloads every Drive image a map uses (ingredient/status/tool icons) so the
// tool can render images from the very first paint instead of the normal
// emoji-then-swap flash. Triggered on app start and whenever the active map
// changes — see main.ts and preloadOverlay.ts.

import type {
  CookedIngredientDef,
  CookingToolDef,
  DirtyObjectDef,
  GlobalDefs,
  RawIngredientDef,
} from "../core/types.ts";
import { driveThumbUrl, preloadedFileIds } from "./icon.ts";

/** The subset of MapDef/MapData this module needs — both satisfy it structurally. */
export interface ImageBearingMap {
  rawIngredients: RawIngredientDef[];
  cookedIngredients: CookedIngredientDef[];
  dirtyObjects: DirtyObjectDef[];
  tools: CookingToolDef[];
}

/** Every distinct, non-empty Drive fileId reachable from this map + the global defs. */
export function collectMapFileIds(map: ImageBearingMap, defs: GlobalDefs): string[] {
  const ids = new Set<string>();
  const add = (fileId: string | undefined) => {
    if (fileId) ids.add(fileId);
  };
  for (const d of defs.effects) add(d.fileId);
  for (const d of defs.cellTypes) add(d.fileId);
  for (const d of defs.customerTypes) add(d.fileId);
  for (const r of map.rawIngredients) add(r.fileId);
  for (const c of map.cookedIngredients) add(c.fileId);
  for (const d of map.dirtyObjects) add(d.fileId);
  for (const t of map.tools) add(t.fileId);
  return [...ids];
}

export interface PreloadHandle {
  /** Resolves once every image has settled (loaded or failed) — never rejects. */
  promise: Promise<void>;
  /**
   * Stops reporting progress and lets the promise resolve immediately (the
   * caller is bailing, e.g. the user hit Skip). Images already in flight keep
   * loading in the background — anything that finishes still benefits from
   * the no-flash render path, it's just no longer blocking anyone's wait.
   */
  cancel(): void;
}

/**
 * Starts loading every image `map` (+ the global definition tables) uses.
 * fileIds that finish successfully are added to `preloadedFileIds`.
 */
export function preloadMapImages(
  map: ImageBearingMap,
  defs: GlobalDefs,
  onProgress?: (loaded: number, total: number) => void,
): PreloadHandle {
  const fileIds = collectMapFileIds(map, defs);
  const total = fileIds.length;
  if (total === 0) return { promise: Promise.resolve(), cancel: () => {} };

  let cancelled = false;
  let settled = 0;

  const promise = new Promise<void>((resolve) => {
    for (const fileId of fileIds) {
      const img = new Image();
      const settle = () => {
        settled++;
        if (!cancelled) onProgress?.(settled, total);
        if (settled === total) resolve();
      };
      img.onload = () => {
        preloadedFileIds.add(fileId); // kept even after cancel — free win for later renders
        settle();
      };
      img.onerror = () => settle();
      img.src = driveThumbUrl(fileId, 128);
    }
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
    },
  };
}
