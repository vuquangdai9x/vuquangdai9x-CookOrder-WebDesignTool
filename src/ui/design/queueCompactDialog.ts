import { button, el } from "../dom.ts";
import type { QueueCompactOptions } from "./queueCompact.ts";

export interface QueueCompactDialogDeps {
  onCompact(options: QueueCompactOptions): void;
}

function selectField(
  label: string,
  hint: string,
  options: readonly (readonly [string, string])[],
): { element: HTMLElement; select: HTMLSelectElement } {
  const select = el("select", {}) as HTMLSelectElement;
  for (const [value, optionLabel] of options) {
    select.append(el("option", { value }, [optionLabel]));
  }
  return {
    select,
    element: el("label", { class: "field compact-queue-field" }, [
      label,
      select,
      el("small", { class: "compact-queue-hint" }, [hint]),
    ]),
  };
}

export function openQueueCompactDialog(deps: QueueCompactDialogDeps): void {
  const close = (): void => overlay.remove();
  const capping = selectField(
    "Capping",
    "Random chooses a new target inside each ingredient's stack range for every bag. Max uses stackMax. All ignores the range.",
    [["random", "Random"], ["max", "Max"], ["all", "All"]],
  );
  const scope = selectField(
    "Grouping",
    "Group nearly merges adjacent chains. Collapse all queue also merges matching slots separated by other ingredients, within each lane.",
    [["nearby", "Group nearly"], ["all-in-lane", "Collapse all queue"]],
  );
  const effects = selectField(
    "Effects",
    "Keep effect treats every effect-bearing slot as distinct. Break effect lets it merge and removes its effects from the merged bag.",
    [["keep", "Keep effect"], ["break", "Break effect"]],
  );

  const panel = el("div", { class: "auto-generate-panel compact-queue-panel" }, [
    capping.element,
    scope.element,
    effects.element,
    el("div", { class: "auto-generate-actions" }, [
      button("Cancel", close),
      button("Compact", () => {
        deps.onCompact({
          capping: capping.select.value as QueueCompactOptions["capping"],
          scope: scope.select.value as QueueCompactOptions["scope"],
          effects: effects.select.value as QueueCompactOptions["effects"],
        });
        close();
      }, { class: "primary" }),
    ]),
  ]);

  const overlay = el("div", { class: "overlay-panel" }, [
    el("div", { class: "definitions-head" }, [
      el("h2", {}, ["Compact Ingredient Queue"]),
      button("\u2715 Close", close, { class: "primary" }),
    ]),
    panel,
  ]);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.body.append(overlay);
}
