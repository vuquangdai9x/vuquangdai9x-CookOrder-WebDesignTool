// The obstacle-budget editor: one vertical slider per obstacle, grouped the
// way a designer thinks about them (what's on the board, what's in the queue,
// who walks in).
//
// Deliberately the SAME control as the ingredient weight grid — drag a bar,
// read the number off the top. The two sit in the same dialog, and giving them
// different gestures would make the modal feel like two dialogs stapled
// together. It also makes the ceilings visible: a bar that is nearly full is a
// budget close to what this map can hold, which a bare number field never says.
//
// The ceilings are real limits, not taste. A grid obstacle count above the
// number of cells is unplaceable by definition, and the placer would just warn
// about the surplus every single run.

import { button, el } from "../dom.ts";
import {
  OBSTACLE_FIELDS,
  OBSTACLE_GROUPS,
  obstacleValue,
  setObstacleValue,
} from "./obstacles.ts";
import type { ObstacleConfig, ObstacleFieldKey } from "./obstacles.ts";

/** Queue slot obstacles: a queue is long, but a hundred of anything is already a wall. */
export const QUEUE_OBSTACLE_MAX = 100;
export const TIMED_CUSTOMER_MAX = 20;
export const SHIPPER_MAX = 10;
/** One boss. A level with two finales has no finale. */
export const BOSS_MAX = 1;

/**
 * The ceiling for one field.
 *
 * Grid obstacles are capped by the board itself — there is nowhere to put the
 * n+1th. `gridCells` is the map's own width × height, so the same budget means
 * different things on a 4×4 and a 6×6, which is correct.
 */
export function obstacleMax(key: ObstacleFieldKey, gridCells: number): number {
  switch (key) {
    case "blocked":
    case "orderLock":
    case "ingredientLock":
    case "lockKey":
      return Math.max(1, gridCells);
    case "timed":
      return TIMED_CUSTOMER_MAX;
    case "shipper":
      return SHIPPER_MAX;
    case "boss":
      return BOSS_MAX;
    default:
      return QUEUE_OBSTACLE_MAX;
  }
}

export interface ObstacleEditor {
  element: HTMLElement;
  /** The live config — mutated in place as the designer drags. */
  config: ObstacleConfig;
}

export interface ObstacleEditorDeps {
  initial: ObstacleConfig;
  /** Cells on this map's board, for the grid ceilings. */
  gridCells: number;
  onChange?(config: ObstacleConfig): void;
}

/**
 * Builds the editor over a COPY of `initial`, so a cancelled dialog leaves the
 * level's own budget untouched. `onChange` fires on every drag frame.
 */
export function createObstacleEditor(deps: ObstacleEditorDeps): ObstacleEditor {
  const config: ObstacleConfig = structuredClone(deps.initial);
  const bars: { set(value: number): void }[] = [];

  const groups = OBSTACLE_GROUPS.map((group) => {
    const columns = OBSTACLE_FIELDS.filter((field) => field.group === group).map((field) => {
      const max = obstacleMax(field.key, deps.gridCells);
      const value = Math.min(max, obstacleValue(config, field.key));
      const fill = el("div", { class: "weight-fill" });
      const label = el("div", { class: "weight-value" }, [String(value)]);
      const track = el("div", { class: "weight-track" }, [fill]);
      const column = el("div", { class: `weight-col obstacle-col${value === 0 ? " zero" : ""}` }, [
        label,
        track,
        el("div", { class: "weight-icon obstacle-icon" }, [field.icon]),
        el("div", { class: "dish-name" }, [field.label]),
        el("div", { class: "obstacle-max" }, [`/${max}`]),
      ]);
      column.title = `${field.label} — ${field.hint} (max ${max})`;
      fill.style.height = `${(value / max) * 100}%`;

      const set = (raw: number): void => {
        const clamped = Math.max(0, Math.min(max, Math.round(raw)));
        setObstacleValue(config, field.key, clamped);
        fill.style.height = `${(clamped / max) * 100}%`;
        label.textContent = String(clamped);
        column.classList.toggle("zero", clamped === 0);
        deps.onChange?.(config);
      };
      // A stored budget above this map's ceiling is written back down, so what
      // the dialog shows and what it will save are the same number.
      if (value !== obstacleValue(config, field.key)) setObstacleValue(config, field.key, value);

      const applyFromPointer = (clientY: number): void => {
        const rect = track.getBoundingClientRect();
        set((1 - (clientY - rect.top) / rect.height) * max);
      };
      track.addEventListener("pointerdown", (e) => {
        track.setPointerCapture(e.pointerId);
        applyFromPointer(e.clientY);
        const onMove = (ev: PointerEvent) => applyFromPointer(ev.clientY);
        const onUp = () => {
          track.releasePointerCapture(e.pointerId);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });

      bars.push({ set });
      return column;
    });

    return el("div", { class: "obstacle-group" }, [
      el("div", { class: "obstacle-group-title" }, [`${group} obstacles`]),
      el("div", { class: "weight-grid obstacle-grid" }, columns),
    ]);
  });

  return {
    config,
    element: el("div", { class: "obstacle-editor" }, [
      el("div", { class: "ingredient-toggle-actions" }, [
        button("Clear All", () => bars.forEach((bar) => bar.set(0)), { class: "small-btn" }),
      ]),
      ...groups,
      el("p", { class: "muted" }, [
        "Counts, not placements — the generator decides where each one lands, under the game's own rules: " +
          "a combined block is a straight run of 2-3 adjacent slots, a linked pair straddles two adjacent " +
          "columns, and every colour lock gets exactly one key in the queue.",
      ]),
    ]),
  };
}
