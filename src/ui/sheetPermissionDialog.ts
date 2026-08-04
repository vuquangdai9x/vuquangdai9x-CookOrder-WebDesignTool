// Shown when the linked Google Sheet fetch fails for permission reasons (see
// SheetPermissionError in data/sheetSource.ts). Since this tool never handles
// Google credentials itself, the only way through is to let the user sign in
// / request access in their own browser tab.

import { SHEET_ID } from "../data/sheetSource.ts";
import { button, el } from "./dom.ts";

interface DialogOptions {
  sheetId?: string;
  message?: string;
  dismissLabel?: string;
}

export function showSheetPermissionDialog(opts: DialogOptions = {}): void {
  const sheetId = opts.sheetId ?? SHEET_ID;
  const editUrl = sheetId.trim() ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit` : null;
  const message =
    opts.message ??
    "The linked sheet couldn't be read — this usually means the signed-in " +
      "Google account doesn't have access yet. Open the sheet to sign in " +
      "with the right account or request access, then try again.";

  let dialog: HTMLElement;
  const close = () => dialog.remove();

  const actions = [
    // No sheetId at all (SHEET_ID has no baked-in default) — nothing to open.
    ...(editUrl
      ? [
          button(
            "Open Google Sheet ↗",
            () => {
              window.open(editUrl, "_blank", "noopener");
            },
            { class: "full-btn" },
          ),
        ]
      : []),
    button(opts.dismissLabel ?? "Continue with local data", close, {}),
  ];

  dialog = el("div", { class: "preload-overlay sheet-permission-overlay" }, [
    el("div", { class: "preload-panel sheet-permission-panel" }, [
      el("h3", {}, ["Google Sheet access needed"]),
      el("p", {}, [message]),
      el("div", { class: "sheet-permission-actions" }, actions),
    ]),
  ]);
  document.body.append(dialog);
}
