// A small Unity-AnimationCurve-style Bezier curve editor: draggable
// keyframes with a single symmetric tangent handle each (free-smooth mode —
// in/out tangent share one slope, one handle to drag), click-empty-space to
// add a keyframe, right-click a keyframe to remove it, and editable min/max
// per axis. Used by autoGenerate.ts for the "complexity curve", but nothing
// here is specific to that use — `evaluateCurve`/`createCurveEditor` work on
// any CurveState.

import { button, el } from "../dom.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface CurveKeyframe {
  /** Normalized 0..1 position along the curve's X domain. */
  x: number;
  /** Normalized 0..1 position along the curve's Y domain. */
  y: number;
  /** Slope (dy/dx in normalized space), shared by both the in and out side. */
  tangent: number;
}

export interface CurveRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface CurveState {
  range: CurveRange;
  /** At least 2, sorted ascending by x. */
  keyframes: CurveKeyframe[];
}

export function defaultCurve(minY: number, maxY: number): CurveState {
  return {
    range: { minX: 0, maxX: 1, minY, maxY },
    keyframes: [
      { x: 0, y: 0.5, tangent: 0 },
      { x: 1, y: 0.5, tangent: 0 },
    ],
  };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const cubicBezier = (p0: number, p1: number, p2: number, p3: number, t: number) => {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
};

/**
 * Cubic Bezier control points (normalized space) for the segment between two
 * adjacent keyframes, converting each side's tangent slope the standard way
 * (control point offset = dx/3 along the tangent). X control points are
 * always strictly between the endpoints regardless of tangent value, so the
 * segment's X(t) is always monotonic — `evaluateNormalized`'s binary search
 * never has to worry about a non-invertible curve.
 */
function segmentControlPoints(
  a: CurveKeyframe,
  b: CurveKeyframe,
): { p1x: number; p1y: number; p2x: number; p2y: number } {
  const dx = b.x - a.x;
  return {
    p1x: a.x + dx / 3,
    p1y: a.y + (a.tangent * dx) / 3,
    p2x: b.x - dx / 3,
    p2y: b.y - (b.tangent * dx) / 3,
  };
}

function evaluateNormalized(keyframes: CurveKeyframe[], nx: number): number {
  if (keyframes.length === 0) return 0.5;
  const sorted = keyframes;
  if (nx <= sorted[0].x) return sorted[0].y;
  const last = sorted[sorted.length - 1];
  if (nx >= last.x) return last.y;

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (nx < a.x || nx > b.x) continue;
    const { p1x, p1y, p2x, p2y } = segmentControlPoints(a, b);
    let lo = 0;
    let hi = 1;
    for (let iter = 0; iter < 40; iter++) {
      const t = (lo + hi) / 2;
      const x = cubicBezier(a.x, p1x, p2x, b.x, t);
      if (x < nx) lo = t;
      else hi = t;
    }
    return cubicBezier(a.y, p1y, p2y, b.y, (lo + hi) / 2);
  }
  return last.y;
}

/** Evaluates the curve at a real-units X (within `curve.range`), returning a real-units Y. */
export function evaluateCurve(curve: CurveState, realX: number): number {
  const { minX, maxX, minY, maxY } = curve.range;
  const nx = maxX === minX ? 0 : clamp01((realX - minX) / (maxX - minX));
  const ny = clamp01(evaluateNormalized(curve.keyframes, nx));
  return minY + ny * (maxY - minY);
}

const VB_W = 480;
const VB_H = 220;
const PAD = { left: 42, right: 12, top: 12, bottom: 12 };
const PLOT_W = VB_W - PAD.left - PAD.right;
const PLOT_H = VB_H - PAD.top - PAD.bottom;
const HANDLE_LEN = 30;

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * Builds the curve editor widget. `onChange` fires (with a deep-cloned
 * snapshot) after every edit — keyframe add/move/remove, tangent drag, or a
 * range field change.
 */
export function createCurveEditor(initial: CurveState, onChange: (next: CurveState) => void): HTMLElement {
  const state: CurveState = structuredClone(initial);
  const wrap = el("div", { class: "curve-editor" });

  const toSvgX = (nx: number) => PAD.left + nx * PLOT_W;
  const toSvgY = (ny: number) => PAD.top + (1 - ny) * PLOT_H;
  const fromSvgX = (px: number) => clamp01((px - PAD.left) / PLOT_W);
  const fromSvgY = (py: number) => clamp01(1 - (py - PAD.top) / PLOT_H);

  const svg = svgEl("svg", { viewBox: `0 0 ${VB_W} ${VB_H}`, class: "curve-svg" });

  function svgPoint(e: PointerEvent): { x: number; y: number } {
    const rect = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * VB_W,
      y: ((e.clientY - rect.top) / rect.height) * VB_H,
    };
  }

  function notify(): void {
    onChange(structuredClone(state));
  }

  /** Runs `onDrag` for each pointermove until the button is released. */
  function beginDrag(target: SVGElement, e: PointerEvent, onDrag: (p: { x: number; y: number }) => void): void {
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => onDrag(svgPoint(ev));
    const onUp = () => {
      target.releasePointerCapture(e.pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function render(): void {
    state.keyframes.sort((a, b) => a.x - b.x);
    svg.replaceChildren();

    // Quarter gridlines + plot border.
    for (let i = 0; i <= 4; i++) {
      const f = i / 4;
      svg.append(
        svgEl("line", { x1: String(toSvgX(0)), y1: String(toSvgY(f)), x2: String(toSvgX(1)), y2: String(toSvgY(f)), class: "curve-grid" }),
        svgEl("line", { x1: String(toSvgX(f)), y1: String(toSvgY(0)), x2: String(toSvgX(f)), y2: String(toSvgY(1)), class: "curve-grid" }),
      );
    }
    svg.append(
      svgEl("rect", {
        x: String(toSvgX(0)),
        y: String(toSvgY(1)),
        width: String(PLOT_W),
        height: String(PLOT_H),
        class: "curve-border",
      }),
    );

    // Curve path — exact cubic segments, no sampling.
    if (state.keyframes.length >= 2) {
      let d = `M ${toSvgX(state.keyframes[0].x)} ${toSvgY(state.keyframes[0].y)} `;
      for (let i = 0; i < state.keyframes.length - 1; i++) {
        const a = state.keyframes[i];
        const b = state.keyframes[i + 1];
        const { p1x, p1y, p2x, p2y } = segmentControlPoints(a, b);
        d += `C ${toSvgX(p1x)} ${toSvgY(p1y)}, ${toSvgX(p2x)} ${toSvgY(p2y)}, ${toSvgX(b.x)} ${toSvgY(b.y)} `;
      }
      svg.append(svgEl("path", { d, class: "curve-path" }));
    }

    state.keyframes.forEach((k, idx) => {
      const px = toSvgX(k.x);
      const py = toSvgY(k.y);
      const dirX = PLOT_W;
      const dirY = -k.tangent * PLOT_H;
      const len = Math.hypot(dirX, dirY) || 1;
      const ux = dirX / len;
      const uy = dirY / len;
      const hx = px + ux * HANDLE_LEN;
      const hy = py + uy * HANDLE_LEN;
      const hx2 = px - ux * HANDLE_LEN;
      const hy2 = py - uy * HANDLE_LEN;

      svg.append(svgEl("line", { x1: String(hx2), y1: String(hy2), x2: String(hx), y2: String(hy), class: "curve-tangent-line" }));

      const handle = svgEl("circle", { cx: String(hx), cy: String(hy), r: "4", class: "curve-tangent-handle" });
      handle.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        beginDrag(handle, e, (p) => {
          const ddx = (p.x - px) / PLOT_W;
          const ddy = -(p.y - py) / PLOT_H;
          if (Math.abs(ddx) > 1e-4) k.tangent = ddy / ddx;
          render();
          notify();
        });
      });
      svg.append(handle);

      const point = svgEl("circle", { cx: String(px), cy: String(py), r: "6", class: "curve-point" });
      point.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        beginDrag(point, e, (p) => {
          const nx = fromSvgX(p.x);
          const ny = fromSvgY(p.y);
          const prev = state.keyframes[idx - 1];
          const next = state.keyframes[idx + 1];
          const minX = prev ? prev.x + 0.002 : 0;
          const maxXBound = next ? next.x - 0.002 : 1;
          k.x = Math.max(minX, Math.min(maxXBound, nx));
          k.y = ny;
          render();
          notify();
        });
      });
      point.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state.keyframes.length <= 2) return; // always keep at least 2 keyframes
        state.keyframes.splice(idx, 1);
        render();
        notify();
      });
      svg.append(point);
    });
  }

  svg.addEventListener("pointerdown", (e) => {
    const p = svgPoint(e);
    if (p.x < PAD.left || p.x > VB_W - PAD.right || p.y < PAD.top || p.y > VB_H - PAD.bottom) return;
    state.keyframes.push({ x: fromSvgX(p.x), y: fromSvgY(p.y), tangent: 0 });
    render();
    notify();
  });

  render();
  wrap.append(svg);

  const numField = (label: string, value: number, onSet: (v: number) => void) => {
    const input = el("input", { type: "number", value: String(value), step: "any" }) as HTMLInputElement;
    input.addEventListener("change", () => {
      onSet(Number(input.value) || 0);
      render();
      notify();
    });
    return el("label", { class: "field small" }, [label, input]);
  };
  wrap.append(
    el("div", { class: "curve-range-row" }, [
      numField("Min X", state.range.minX, (v) => (state.range.minX = v)),
      numField("Max X", state.range.maxX, (v) => (state.range.maxX = v)),
      numField("Min Y", state.range.minY, (v) => (state.range.minY = v)),
      numField("Max Y", state.range.maxY, (v) => (state.range.maxY = v)),
    ]),
  );

  return wrap;
}

// ---------- named presets ----------
// A shared, named library of curve shapes — saved explicitly, persisted in
// localStorage so it survives reloads, and reused across every dialog that
// embeds a curve editor (customer complexity, queue shuffle distance, ...).

export interface CurvePreset {
  name: string;
  curve: CurveState;
}

const CURVE_PRESETS_KEY = "cookorder-curve-presets";

/**
 * Built-in shapes, always available (no saving required) — defined purely in
 * normalized 0..1 keyframe space so picking one applies the SHAPE while
 * keeping whatever min/max range the current dialog already has (e.g.
 * "Constant (Max)" means "flat at this curve's own max", not a hardcoded
 * value). See createCurveWithPresets's change handler for how that merge
 * happens; contrast with a saved CurvePreset, which restores its own range
 * too since the user chose that range when they saved it.
 */
export interface BuiltInCurvePreset {
  name: string;
  keyframes: CurveKeyframe[];
}

export const BUILT_IN_CURVE_PRESETS: BuiltInCurvePreset[] = [
  { name: "Linear", keyframes: [{ x: 0, y: 0, tangent: 1 }, { x: 1, y: 1, tangent: 1 }] },
  { name: "Ease In Out Sine", keyframes: [{ x: 0, y: 0, tangent: 0 }, { x: 1, y: 1, tangent: 0 }] },
  { name: "Ease In Sine", keyframes: [{ x: 0, y: 0, tangent: 0 }, { x: 1, y: 1, tangent: 2 }] },
  { name: "Ease Out Quad", keyframes: [{ x: 0, y: 0, tangent: 2 }, { x: 1, y: 1, tangent: 0 }] },
  { name: "Constant (Max)", keyframes: [{ x: 0, y: 1, tangent: 0 }, { x: 1, y: 1, tangent: 0 }] },
  {
    name: "Parabola",
    keyframes: [{ x: 0, y: 0, tangent: 2 }, { x: 0.5, y: 1, tangent: 0 }, { x: 1, y: 0, tangent: -2 }],
  },
  {
    name: "Upside-Down Parabola",
    keyframes: [{ x: 0, y: 1, tangent: -2 }, { x: 0.5, y: 0, tangent: 0 }, { x: 1, y: 1, tangent: 2 }],
  },
];

export function loadCurvePresets(): CurvePreset[] {
  try {
    const raw = localStorage.getItem(CURVE_PRESETS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CurvePreset[]) : [];
  } catch {
    return [];
  }
}

function saveCurvePresets(presets: CurvePreset[]): void {
  try {
    localStorage.setItem(CURVE_PRESETS_KEY, JSON.stringify(presets));
  } catch (err) {
    console.warn("Could not persist curve presets", err);
  }
}

/**
 * A curve editor plus a "Saved curves" row (select a preset to load it,
 * Save As… to name and store the current shape, Delete to remove one) — the
 * one widget every "pick or shape a curve" dialog embeds. `onChange` fires
 * on every edit, same as `createCurveEditor` alone.
 */
export function createCurveWithPresets(initial: CurveState, onChange: (next: CurveState) => void): HTMLElement {
  let curveState = initial;
  let presets = loadCurvePresets();

  // Swapped wholesale on preset load — createCurveEditor owns a fixed SVG
  // bound to its `initial` state, so loading a different curve means
  // mounting a fresh instance rather than pushing an update into it.
  const curveHost = el("div", { class: "curve-host" });
  const mount = (state: CurveState) => {
    curveHost.replaceChildren(
      createCurveEditor(state, (next) => {
        curveState = next;
        onChange(next);
      }),
    );
  };
  mount(curveState);

  // Option values are namespaced ("builtin:"/"saved:") so a saved preset can
  // never collide with a built-in one of the same name.
  const presetSelect = el("select", { class: "curve-preset-select" }) as HTMLSelectElement;
  const refreshOptions = (selectValue?: string) => {
    presetSelect.replaceChildren(
      el("option", { value: "" }, ["— Load a curve —"]),
      el(
        "optgroup",
        { label: "Presets" },
        BUILT_IN_CURVE_PRESETS.map((p) => el("option", { value: `builtin:${p.name}` }, [p.name])),
      ),
      ...(presets.length
        ? [
            el(
              "optgroup",
              { label: "Saved" },
              presets.map((p) => el("option", { value: `saved:${p.name}` }, [p.name])),
            ),
          ]
        : []),
    );
    if (selectValue) presetSelect.value = selectValue;
  };
  refreshOptions();
  presetSelect.addEventListener("change", () => {
    const [ns, ...rest] = presetSelect.value.split(":");
    const name = rest.join(":");
    if (ns === "builtin") {
      const preset = BUILT_IN_CURVE_PRESETS.find((p) => p.name === name);
      if (!preset) return;
      // Shape only — keeps whatever min/max range this dialog is already using.
      curveState = { range: curveState.range, keyframes: structuredClone(preset.keyframes) };
    } else if (ns === "saved") {
      const preset = presets.find((p) => p.name === name);
      if (!preset) return;
      curveState = structuredClone(preset.curve);
    } else {
      return;
    }
    onChange(curveState);
    mount(curveState);
  });

  const presetRow = el("div", { class: "curve-preset-row" }, [
    el("label", { class: "field small" }, ["Curves", presetSelect]),
    button(
      "Save As…",
      () => {
        const [ns, ...rest] = presetSelect.value.split(":");
        const defaultName = ns === "saved" ? rest.join(":") : "";
        const name = prompt("Name this curve", defaultName)?.trim();
        if (!name) return;
        const existingIndex = presets.findIndex((p) => p.name === name);
        if (existingIndex !== -1 && !confirm(`Overwrite the saved curve "${name}"?`)) return;
        const entry: CurvePreset = { name, curve: structuredClone(curveState) };
        if (existingIndex !== -1) presets[existingIndex] = entry;
        else presets.push(entry);
        saveCurvePresets(presets);
        refreshOptions(`saved:${name}`);
      },
      { class: "small-btn", title: "Save the current curve shape under a name for reuse" },
    ),
    button(
      "Delete",
      () => {
        if (!presetSelect.value.startsWith("saved:")) return; // built-in presets can't be deleted
        const name = presetSelect.value.slice("saved:".length);
        if (!confirm(`Delete the saved curve "${name}"?`)) return;
        presets = presets.filter((p) => p.name !== name);
        saveCurvePresets(presets);
        refreshOptions();
      },
      { class: "small-btn danger" },
    ),
  ]);

  return el("div", { class: "curve-with-presets" }, [curveHost, presetRow]);
}

// ---------- string encoding ----------
// JSON is deliberately used instead of a terse custom grammar (unlike the
// customer/grid/queue strings) — a curve is design-tool-only data (never sent
// through the Sheet's single-cell row format), so there's no size pressure,
// and JSON avoids reinventing float-precision-safe parsing for keyframe
// x/y/tangent values.

export function serializeCurve(curve: CurveState): string {
  return JSON.stringify(curve);
}

/** Falls back to `fallback` on missing/invalid input rather than throwing — this is read-back design metadata, not canonical level data. */
export function parseCurve(s: string, fallback: CurveState): CurveState {
  if (!s || !s.trim()) return structuredClone(fallback);
  try {
    const parsed: unknown = JSON.parse(s);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as CurveState).keyframes) &&
      (parsed as CurveState).range
    ) {
      return parsed as CurveState;
    }
  } catch {
    // fall through to fallback
  }
  return structuredClone(fallback);
}

/**
 * Standalone "edit just this curve" popup — the curve editor + presets, an
 * Apply/Cancel footer, nothing else.
 *
 * `onClear` is optional and adds a Clear button. It exists for callers where an
 * ABSENT curve is meaningful rather than an error — Level Path's generator
 * columns, where clearing one hands the choice back to the generator — and is
 * left off where a curve must always be present.
 */
export function openCurveDialog(
  title: string,
  initial: CurveState,
  onApply: (curve: CurveState) => void,
  onClear?: () => void,
): void {
  const close = () => overlay.remove();
  let curveState = structuredClone(initial);

  const panel = el("div", { class: "auto-generate-panel" }, [
    createCurveWithPresets(curveState, (next) => (curveState = next)),
    el("div", { class: "auto-generate-actions" }, [
      button("Cancel", close),
      ...(onClear
        ? [
            button("Clear", () => { onClear(); close(); }, {
              class: "danger",
              title: "Remove this curve — the generator will roll a fresh one from the seed",
            }),
          ]
        : []),
      button("Apply", () => { onApply(curveState); close(); }, { class: "primary" }),
    ]),
  ]);

  const overlay = el("div", { class: "overlay-panel" }, [
    el("div", { class: "definitions-head" }, [
      el("h2", {}, [title]),
      button("✕ Close", close, { class: "primary" }),
    ]),
    panel,
  ]);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.body.append(overlay);
}
