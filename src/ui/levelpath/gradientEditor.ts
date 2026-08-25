// The per-column colour-ramp editor, opened by right-clicking a statistic
// column's header.
//
// It lives in the context menu rather than in a modal on purpose: changing a
// ramp is a look-at-it-while-you-drag decision, and a modal would cover the
// very column being tuned. Every control applies live, so the menu is a set of
// handles on the table behind it rather than a form with an OK button.

import { el, button } from "../dom.ts";
import { showContextMenu } from "../contextMenu.ts";
import { currentTheme } from "../theme.ts";
import { gradientPreviewCss, hueOfHex, hexOfHue, isMonochromatic, wrapHue } from "./metricColor.ts";
import type { ColumnGradient } from "./metricColor.ts";

export interface GradientEditorDeps {
  /** Column label, for the menu title. */
  title: string;
  gradient: ColumnGradient;
  /** Fires on every drag frame — repaint the column, do not re-render the table. */
  onChange(next: ColumnGradient): void;
  /** The drag ended or a button was pressed: persist. */
  onCommit(): void;
}

/**
 * One end of the ramp: a rainbow slider and a colour picker, both writing the
 * same hue.
 *
 * The two coexist because they answer different questions. The slider is for
 * sweeping until the column looks right against the ones beside it; the picker
 * is for "make it exactly the blue from the style guide". Only the HUE of a
 * picked colour is kept — its saturation and lightness are what the ramp itself
 * has to spend to show low versus high, so honouring them would flatten the
 * very signal the colour is carrying.
 */
function hueEnd(label: string, value: number, onInput: (hue: number) => void, onCommit: () => void): {
  row: HTMLElement;
  set(hue: number): void;
} {
  const slider = el("input", {
    type: "range",
    min: "0",
    max: "359",
    step: "1",
    value: String(Math.round(wrapHue(value))),
    class: "lp-hue-slider",
  }) as HTMLInputElement;

  const picker = el("input", {
    type: "color",
    value: hexOfHue(value),
    class: "lp-hue-picker",
    title: "Pick this end's colour — its hue is what the ramp keeps",
  }) as HTMLInputElement;

  const set = (hue: number): void => {
    slider.value = String(Math.round(wrapHue(hue)));
    picker.value = hexOfHue(hue);
  };

  slider.addEventListener("input", () => {
    picker.value = hexOfHue(Number(slider.value));
    onInput(Number(slider.value));
  });
  slider.addEventListener("change", () => onCommit());

  picker.addEventListener("input", () => {
    const hue = hueOfHex(picker.value);
    if (hue === null) return; // an achromatic pick names no hue to move to
    slider.value = String(Math.round(hue));
    onInput(hue);
  });
  picker.addEventListener("change", () => onCommit());

  return {
    row: el("label", { class: "lp-gradient-row" }, [el("span", {}, [label]), slider, picker]),
    set,
  };
}

/**
 * Opens the editor for one column.
 *
 * `gradient` is copied, not aliased: the live edits go out through `onChange`,
 * so the caller stays the single owner of where a column's ramp is stored.
 */
export function openGradientEditor(event: MouseEvent, deps: GradientEditorDeps): void {
  const state: ColumnGradient = { ...deps.gradient };
  const swatch = el("div", { class: "lp-gradient-swatch" });
  const modeNote = el("div", { class: "lp-gradient-note" });

  const refresh = (): void => {
    // Previewed under the live theme, so the swatch is what the column will
    // actually look like rather than what it would look like in the other one.
    swatch.style.background = gradientPreviewCss(state, 1, currentTheme());
    modeNote.textContent = isMonochromatic(state)
      ? `Monochromatic · hue ${Math.round(wrapHue(state.fromHue))}°`
      : `${Math.round(wrapHue(state.fromHue))}° → ${Math.round(wrapHue(state.toHue))}°`;
    deps.onChange({ ...state });
  };

  const from = hueEnd("Low", state.fromHue, (hue) => {
    // Dragging the low hue of a monochromatic ramp moves BOTH ends: a ramp that
    // silently split in two the first time it was touched would be a surprise,
    // and "make this column green" is the common intent by far.
    const mono = isMonochromatic(state);
    state.fromHue = hue;
    if (mono) {
      state.toHue = hue;
      to.set(hue);
    }
    refresh();
  }, deps.onCommit);

  const to = hueEnd("High", state.toHue, (hue) => {
    state.toHue = hue;
    refresh();
  }, deps.onCommit);

  const actions = el("div", { class: "lp-gradient-actions" }, [
    button("Monochromatic", () => {
      state.toHue = state.fromHue;
      to.set(state.toHue);
      refresh();
      deps.onCommit();
    }, { class: "small-btn", title: "Collapse the ramp to one hue, dim to bright" }),
    button("Randomize", () => {
      const hue = Math.floor(Math.random() * 360);
      state.fromHue = hue;
      state.toHue = hue;
      from.set(hue);
      to.set(hue);
      refresh();
      deps.onCommit();
    }, { class: "small-btn", title: "Pick a new hue for this column" }),
  ]);

  refresh();

  showContextMenu(
    event,
    [
      { label: "", content: swatch },
      { label: "", content: modeNote },
      { label: "", content: from.row },
      { label: "", content: to.row },
      { label: "", content: actions },
    ],
    { title: `Colour scale — ${deps.title}` },
  );
}
