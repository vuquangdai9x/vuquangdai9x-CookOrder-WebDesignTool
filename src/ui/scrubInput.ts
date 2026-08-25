// A number <input> that can also be drag-scrubbed left/right.
//
// Extracted from the Scoring Scenario modal, which invented the gesture, so
// the Level Path config bar's width/intensity sliders behave identically —
// same acceleration, same modifier keys, same "a click still focuses the
// field" rule. One implementation because two would drift, and a scrubber that
// feels different in two places reads as a bug rather than a second widget.

/**
 * Drag step for a value, sized relative to its own magnitude so one mouse
 * sweep means about the same *proportion* everywhere: 1000 moves in steps of
 * 10, 0.5 in steps of 0.001. Snapped to a power of ten so the numbers stay
 * round, and floored at what the field's decimals can even represent.
 */
export function dragStep(value: number, decimals: number): number {
  const floor = 10 ** -decimals;
  const magnitude = Math.abs(value);
  if (!Number.isFinite(magnitude) || magnitude < floor) return floor;
  return Math.max(floor, 10 ** (Math.floor(Math.log10(magnitude)) - 2));
}

export const roundTo = (value: number, decimals: number): number =>
  Number(value.toFixed(Math.min(10, decimals + 2)));

export const formatScrub = (value: number, decimals: number): string =>
  decimals === 0 ? String(Math.round(value)) : String(roundTo(value, decimals));

export interface ScrubSpec {
  min: number;
  /** Absent = unbounded above. */
  max?: number;
  /** Digits kept while scrubbing; also what the input displays. */
  decimals: number;
  /**
   * Whether a BLANK field is a legal value rather than zero.
   *
   * Level Path's random seed needs it: blank there means "the generator picks
   * one", which is a different instruction from the seed 0. Without this, the
   * change handler's `Number("") || 0` quietly turns "let it pick" into "pin
   * it to zero" the moment the field is cleared and blurred.
   */
  allowEmpty?: boolean;
}

/**
 * Turn a number input into a scrubber: press and drag sideways to change it,
 * click without moving to type as usual. The step is recomputed from the
 * *current* value on every pointer move, so a field crossing an order of
 * magnitude speeds up or slows down with it instead of crawling or exploding.
 * Shift drags 10x coarser, Alt 10x finer.
 *
 * `onChange` fires on every scrub frame — a caller for whom that is too
 * expensive should also pass `onCommit`, which fires only when the drag ends
 * (and on a typed edit), and do the cheap work in one and the costly work in
 * the other.
 */
export function makeScrubber(
  input: HTMLInputElement,
  spec: ScrubSpec,
  onChange: (value: number) => void,
  onCommit?: (value: number | null) => void,
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

  const clamp = (value: number): number => {
    const rounded = roundTo(value, spec.decimals);
    const floored = Math.max(spec.min, rounded);
    return spec.max === undefined ? floored : Math.min(spec.max, floored);
  };

  const apply = (value: number): number => {
    const clamped = clamp(value);
    input.value = formatScrub(clamped, spec.decimals);
    onChange(clamped);
    return clamped;
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
    accumulated = clamp(accumulated);
    apply(accumulated);
  });

  const stop = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    input.classList.remove("scrubbing");
    if (input.hasPointerCapture(event.pointerId)) input.releasePointerCapture(event.pointerId);
    if (moved) onCommit?.(clamp(Number(input.value) || 0));
  };
  input.addEventListener("pointerup", stop);
  input.addEventListener("pointercancel", stop);

  input.addEventListener("change", () => {
    if (spec.allowEmpty && input.value.trim() === "") {
      onCommit?.(null);
      return;
    }
    onCommit?.(apply(Number(input.value) || 0));
  });
}
