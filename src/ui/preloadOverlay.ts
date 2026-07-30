// Blocking "loading images" overlay shown on app start and on genuine map
// changes. Sits above everything (including .overlay-panel) so nothing below
// it is interactable while images preload; the user can bail via Skip, which
// falls back to the tool's normal lazy icon rendering (see icon.ts).

import { el } from "./dom.ts";
import { preloadMapImages, type ImageBearingMap } from "./imagePreload.ts";
import type { GlobalDefs } from "../core/types.ts";

/** Runs the preload for `map`, showing a blocking overlay until it finishes or the user skips. */
export function preloadMapWithOverlay(map: ImageBearingMap, defs: GlobalDefs): Promise<void> {
  const handle = preloadMapImages(map, defs, (loaded, total) => {
    bar.style.width = `${(loaded / total) * 100}%`;
    label.textContent = `Loading images… ${loaded}/${total}`;
  });

  const label = el("div", { class: "preload-label" }, ["Loading images…"]);
  const bar = el("div", { class: "preload-bar-fill" });
  const skipBtn = el("button", { class: "preload-skip" }, ["Skip"]);
  const panel = el("div", { class: "preload-panel" }, [
    label,
    el("div", { class: "preload-bar-track" }, [bar]),
    skipBtn,
  ]);
  const overlay = el("div", { class: "preload-overlay" }, [panel]);
  document.body.append(overlay);

  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      overlay.remove();
      resolve();
    };
    skipBtn.addEventListener("click", () => {
      handle.cancel();
      finish();
    });
    handle.promise.then(finish);
  });
}
