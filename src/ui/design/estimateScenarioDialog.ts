// "Scoring Scenario" modal — shown by Node Design right before an Estimate
// Difficulty run (see nodedesign/index.ts's runEstimate). Every solver knob in
// estimateScenario.ts gets one row: a toggle, and a number input that can be
// drag-scrubbed left/right as well as typed into.

import { button, el } from "../dom.ts";
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

/**
 * Drag step for a value, sized relative to its own magnitude so one mouse
 * sweep means about the same *proportion* everywhere: 1000 moves in steps of
 * 10, 0.5 in steps of 0.001. Snapped to a power of ten so the numbers stay
 * round, and floored at what the field's decimals can even represent.
 */
function dragStep(value: number, decimals: number): number {
  const floor = 10 ** -decimals;
  const magnitude = Math.abs(value);
  if (!Number.isFinite(magnitude) || magnitude < floor) return floor;
  return Math.max(floor, 10 ** (Math.floor(Math.log10(magnitude)) - 2));
}

const roundTo = (value: number, decimals: number): number =>
  Number(value.toFixed(Math.min(10, decimals + 2)));

const format = (value: number, decimals: number): string =>
  decimals === 0 ? String(Math.round(value)) : String(roundTo(value, decimals));

/**
 * Turn a number input into a scrubber: press and drag sideways to change it,
 * click without moving to type as usual. The step is recomputed from the
 * *current* value on every pointer move, so a field crossing an order of
 * magnitude speeds up or slows down with it instead of crawling or exploding.
 * Shift drags 10x coarser, Alt 10x finer.
 */
function makeScrubber(
  input: HTMLInputElement,
  spec: ScenarioFieldSpec,
  onChange: (value: number) => void,
): void {
  input.classList.add("scrub-input");
  let dragging = false;
  let moved = false;
  let startX = 0;
  /**
   * Previous pointer x — deltas come from this rather than movementX, which
   * some browsers zero out while a pointer is captured.
   */
  let lastX = 0;
  let accumulated = 0;

  const commit = (value: number): void => {
    const clamped = Math.max(spec.min, roundTo(value, spec.decimals));
    input.value = format(clamped, spec.decimals);
    onChange(clamped);
  };

  input.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = true;
    moved = false;
    startX = event.clientX;
    lastX = event.clientX;
    accumulated = Number(input.value) || 0;
  });

  input.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const delta = event.clientX - startX;
    if (!moved) {
      if (Math.abs(delta) < 3) return;
      moved = true;
      // Only capture once it is clearly a drag, so a plain click still focuses
      // the field for typing.
      input.setPointerCapture(event.pointerId);
      input.classList.add("scrubbing");
      input.blur();
    }
    event.preventDefault();
    const scale = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
    const pixels = event.clientX - lastX;
    lastX = event.clientX;
    accumulated += pixels * dragStep(accumulated, spec.decimals) * scale;
    accumulated = Math.max(spec.min, accumulated);
    commit(accumulated);
  });

  const stop = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    input.classList.remove("scrubbing");
    if (input.hasPointerCapture(event.pointerId)) input.releasePointerCapture(event.pointerId);
  };
  input.addEventListener("pointerup", stop);
  input.addEventListener("pointercancel", stop);

  input.addEventListener("change", () => {
    commit(Number(input.value) || 0);
  });
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
    }) as HTMLInputElement;
    input.value = format(field.value, spec.decimals);
    makeScrubber(input, spec, (value) => (field.value = value));

    const offNote = el("span", { class: "scenario-off" }, [`off = ${format(spec.off, spec.decimals)}`]);
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
