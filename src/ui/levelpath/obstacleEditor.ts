// The obstacle-budget editor: one drag-scrubbable count per obstacle, grouped
// the way a designer thinks about them (what's on the board, what's in the
// queue, who walks in).
//
// A widget rather than a dialog, because it is embedded in the Auto Generate
// modal beside the weights and curves — an obstacle budget is one more
// generator input, not a separate act.

import { el } from "../dom.ts";
import { makeScrubber } from "../scrubInput.ts";
import {
  OBSTACLE_FIELDS,
  OBSTACLE_GROUPS,
  obstacleValue,
  setObstacleValue,
} from "./obstacles.ts";
import type { ObstacleConfig } from "./obstacles.ts";

export interface ObstacleEditor {
  element: HTMLElement;
  /** The live config — mutated in place as the designer scrubs. */
  config: ObstacleConfig;
}

/**
 * Builds the editor over a COPY of `initial`, so a cancelled dialog leaves the
 * level's own budget untouched. `onChange` fires on every scrub frame.
 */
export function createObstacleEditor(
  initial: ObstacleConfig,
  onChange?: (config: ObstacleConfig) => void,
): ObstacleEditor {
  const config: ObstacleConfig = structuredClone(initial);

  const groups = OBSTACLE_GROUPS.map((group) => {
    const fields = OBSTACLE_FIELDS.filter((field) => field.group === group).map((field) => {
      const input = el("input", {
        type: "number",
        min: "0",
        step: "1",
        value: String(obstacleValue(config, field.key)),
      }) as HTMLInputElement;
      input.title = field.hint;
      makeScrubber(
        input,
        { min: 0, decimals: 0 },
        (value) => {
          setObstacleValue(config, field.key, value);
          onChange?.(config);
        },
        () => onChange?.(config),
      );
      return el("label", { class: "field small obstacle-field", title: field.hint }, [
        field.label,
        input,
      ]);
    });

    return el("div", { class: "obstacle-group" }, [
      el("div", { class: "obstacle-group-title" }, [`${group} obstacles`]),
      el("div", { class: "obstacle-group-body" }, fields),
    ]);
  });

  return {
    config,
    element: el("div", { class: "obstacle-editor" }, [
      ...groups,
      el("p", { class: "muted" }, [
        "Counts, not placements — the generator decides where each one lands, under the game's own rules: " +
          "a combined block is a straight run of 2-3 adjacent slots, a linked pair straddles two adjacent " +
          "columns, and every colour lock gets exactly one key in the queue.",
      ]),
    ]),
  };
}
