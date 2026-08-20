import { button, el } from "../dom.ts";

/** Read-only conversion result popup shared by Customers and Ingredient Queues. */
export function openStringConversionDialog(title: string, convert: () => string): void {
  let value = "";
  let error = "";
  try {
    value = convert();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const close = () => overlay.remove();
  const field = el("textarea", {
    class: "conversion-string-field",
    readonly: "true",
    rows: "6",
  }) as HTMLTextAreaElement;
  field.value = value;

  const copy = button("Copy", async () => {
    await navigator.clipboard.writeText(field.value);
    copy.textContent = "✓ Copied";
  }, { class: "primary" });
  copy.disabled = !!error;

  const panel = el("div", { class: "conversion-dialog" }, [
    error
      ? el("div", { class: "conversion-error" }, [error])
      : el("label", { class: "field" }, ["New string format", field]),
    el("div", { class: "auto-generate-actions" }, [copy, button("Close", close)]),
  ]);
  const overlay = el("div", { class: "overlay-panel" }, [
    el("div", { class: "definitions-head" }, [el("h2", {}, [title]), button("✕ Close", close)]),
    panel,
  ]);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.body.append(overlay);
  if (!error) {
    field.focus();
    field.select();
  }
}
