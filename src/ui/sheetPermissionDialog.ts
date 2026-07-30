// Shown when the linked Google Sheet fetch fails for permission reasons (see
// SheetPermissionError in data/sheetSource.ts). Since this tool never handles
// Google credentials itself, the only way through is to let the user sign in
// / request access in their own browser tab.

import { SHEET_ID } from "../data/sheetSource.ts";
import { button, el } from "./dom.ts";

const SHEET_EDIT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;

export function showSheetPermissionDialog(): void {
  let dialog: HTMLElement;
  const close = () => dialog.remove();

  dialog = el("div", { class: "preload-overlay sheet-permission-overlay" }, [
    el("div", { class: "preload-panel sheet-permission-panel" }, [
      el("h3", {}, ["Google Sheet access needed"]),
      el("p", {}, [
        "The linked sheet couldn't be read — this usually means the signed-in " +
          "Google account doesn't have access yet. Open the sheet to sign in " +
          "with the right account or request access, then try again.",
      ]),
      el("div", { class: "sheet-permission-actions" }, [
        button(
          "Open Google Sheet ↗",
          () => {
            window.open(SHEET_EDIT_URL, "_blank", "noopener");
          },
          { class: "full-btn" },
        ),
        button("Continue with local data", close, {}),
      ]),
    ]),
  ]);
  document.body.append(dialog);
}
