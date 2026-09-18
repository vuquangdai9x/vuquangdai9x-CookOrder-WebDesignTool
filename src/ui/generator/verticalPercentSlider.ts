import { el } from "../dom.ts";

export interface VerticalPercentSliderOptions {
  label: string;
  icon: string;
  value: number;
  formatValue?(value: number): string;
  onInput(value: number): void;
}

/** Ingredient-weight style vertical percentage control shared by all generator coverage fields. */
export function createVerticalPercentSlider(options: VerticalPercentSliderOptions): HTMLElement {
  let value = Math.max(0, Math.min(100, Math.round(options.value)));
  const output = el("output", { class: "weight-value qf-coverage-value" });
  const fill = el("span", { class: "weight-fill" });
  const track = el("div", {
    class: "weight-track qf-coverage-track",
    role: "slider",
    tabindex: "0",
    title: `${options.label} coverage. Drag vertically.`,
    "aria-label": `${options.label} coverage`,
    "aria-valuemin": "0",
    "aria-valuemax": "100",
  }, [fill]);

  const paint = (): void => {
    fill.style.height = `${value}%`;
    output.textContent = options.formatValue?.(value) ?? `${value}%`;
    track.setAttribute("aria-valuenow", String(value));
    track.setAttribute("aria-valuetext", output.textContent);
  };
  const apply = (next: number): void => {
    value = Math.max(0, Math.min(100, Math.round(next)));
    paint();
    options.onInput(value);
  };
  const applyPointer = (clientY: number): void => {
    const rect = track.getBoundingClientRect();
    apply((1 - (clientY - rect.top) / Math.max(1, rect.height)) * 100);
  };
  track.addEventListener("pointerdown", (event) => {
    track.setPointerCapture(event.pointerId);
    applyPointer(event.clientY);
  });
  track.addEventListener("pointermove", (event) => {
    if (track.hasPointerCapture(event.pointerId)) applyPointer(event.clientY);
  });
  track.addEventListener("pointerup", (event) => {
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
  });
  track.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp" || event.key === "ArrowRight") apply(value + (event.shiftKey ? 10 : 1));
    else if (event.key === "ArrowDown" || event.key === "ArrowLeft") apply(value - (event.shiftKey ? 10 : 1));
    else if (event.key === "Home") apply(0);
    else if (event.key === "End") apply(100);
    else return;
    event.preventDefault();
  });
  paint();

  return el("label", { class: "qf-coverage-col", title: `${options.label} coverage` }, [
    output,
    track,
    el("span", { class: "qf-coverage-emoji", "aria-hidden": "true" }, [options.icon]),
    el("span", { class: "qf-coverage-name" }, [options.label]),
  ]);
}
