// Generic blocking "please wait" overlay, shared by any operation that
// replaces app data out from under the user (currently: loading from the
// Google Sheet). Reuses the preload overlay's look (see preloadOverlay.ts /
// style.css) but has no progress bar or Skip — just a message.

import { el } from "./dom.ts";

let overlayEl: HTMLElement | null = null;
let labelEl: HTMLElement | null = null;

export function showBlockingOverlay(message: string): void {
  if (overlayEl) {
    labelEl!.textContent = message;
    return;
  }
  labelEl = el("div", { class: "preload-label" }, [message]);
  const panel = el("div", { class: "preload-panel" }, [labelEl]);
  overlayEl = el("div", { class: "preload-overlay" }, [panel]);
  document.body.append(overlayEl);
}

export function hideBlockingOverlay(): void {
  overlayEl?.remove();
  overlayEl = null;
  labelEl = null;
}
