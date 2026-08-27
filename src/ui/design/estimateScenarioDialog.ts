// "Scoring Scenario" modal — shown by Node Design right before an Estimate
// Difficulty run (see nodedesign/index.ts's runEstimate). Every solver knob in
// estimateScenario.ts gets one row: a toggle, and a number input that can be
// drag-scrubbed left/right as well as typed into. The scrubber gesture itself
// lives in ui/scrubInput.ts, shared with the Level Path config bar.

import { button, el } from "../dom.ts";
import { formatScrub, makeScrubber } from "../scrubInput.ts";
import {
  SCENARIO_FIELDS,
  SCENARIO_GROUPS,
  defaultScenario,
} from "./estimateScenario.ts";
import type { EstimateScenario, ScenarioFieldSpec } from "./estimateScenario.ts";

export interface EstimateScenarioDeps {
  /** Scenario to open with — usually the last one the designer ran. */
  scenario: EstimateScenario;
  /** Called with the edited scenario when the designer hits Run. */
  onRun(scenario: EstimateScenario): void;
}

export function openEstimateScenarioDialog(deps: EstimateScenarioDeps): void {
  let scenario: EstimateScenario = structuredClone(deps.scenario);
  const close = (): void => overlay.remove();

  const body = el("div", { class: "scenario-body" });

  /**
   * One collapsible group. Status assumptions is the only one open on load —
   * the weight tables are long, and most runs only touch the assumptions.
   */
  const foldout = (title: string, open: boolean, rows: HTMLElement[]): HTMLElement =>
    el("details", open ? { class: "scenario-group", open: "" } : { class: "scenario-group" }, [
      el("summary", {}, [title]),
      el("div", { class: "scenario-group-body" }, rows),
    ]);

  /** Rebuilt wholesale on Reset — cheap, and keeps every row in one place. */
  const render = (): void => {
    body.replaceChildren();

    body.append(
      foldout("Status assumptions", true, [
        toggleRow(
          "Hidden slot status",
          "ON: hidden slots stay hidden to the solver. OFF: the queue is treated as fully revealed, so buried rows are scored normally.",
          scenario.hiddenStatus,
          (on) => (scenario.hiddenStatus = on),
        ),
      ]),
    );

    for (const group of SCENARIO_GROUPS) {
      const rows: HTMLElement[] = [];
      for (const spec of SCENARIO_FIELDS) {
        if (spec.group === group) rows.push(fieldRow(spec));
      }
      body.append(foldout(group, false, rows));
    }
  };

  const toggleRow = (
    label: string,
    hint: string,
    value: boolean,
    onToggle: (on: boolean) => void,
  ): HTMLElement => {
    const box = el("input", { type: "checkbox" }) as HTMLInputElement;
    box.checked = value;
    box.addEventListener("change", () => onToggle(box.checked));
    return el("div", { class: "scenario-row", title: hint }, [
      el("label", { class: "scenario-toggle" }, [box, label]),
      el("span", { class: "scenario-hint" }, [hint]),
    ]);
  };

  const fieldRow = (spec: ScenarioFieldSpec): HTMLElement => {
    const field = scenario.fields[spec.key];
    const box = el("input", { type: "checkbox" }) as HTMLInputElement;
    box.checked = field.enabled;

    const input = el("input", {
      type: "number",
      step: String(10 ** -spec.decimals),
      min: String(spec.min),
      ...(spec.max === undefined ? {} : { max: String(spec.max) }),
    }) as HTMLInputElement;
    input.value = formatScrub(field.value, spec.decimals);
    makeScrubber(input, spec, (value) => (field.value = value));

    const offNote = el("span", { class: "scenario-off" }, [`off = ${formatScrub(spec.off, spec.decimals)}`]);
    const sync = (): void => {
      input.disabled = !box.checked;
      row.classList.toggle("disabled", !box.checked);
    };
    box.addEventListener("change", () => {
      field.enabled = box.checked;
      sync();
    });

    const row = el("div", { class: "scenario-row", title: spec.hint }, [
      el("label", { class: "scenario-toggle" }, [box, spec.label]),
      el("span", { class: "scenario-hint" }, [spec.hint]),
      offNote,
      input,
    ]);
    sync();
    return row;
  };

  render();

  const panel = el("div", { class: "scenario-panel" }, [
    el("p", { class: "scenario-lead" }, [
      "Drag any value left/right to scrub it — the step scales with the number (Shift = 10x, Alt = 0.1x). Untick a row to disable that term.",
    ]),
    body,
    el("div", { class: "auto-generate-actions" }, [
      button("Reset to defaults", () => {
        scenario = defaultScenario();
        render();
      }),
      button("Cancel", close),
      button(
        "Run Estimate",
        () => {
          close();
          deps.onRun(structuredClone(scenario));
        },
        { class: "primary" },
      ),
    ]),
  ]);

  const overlay = el("div", { class: "overlay-panel" }, [
    el("div", { class: "definitions-head" }, [
      el("h2", {}, ["Scoring Scenario"]),
      button("✕ Close", close, { class: "primary" }),
    ]),
    panel,
  ]);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.body.append(overlay);
}
