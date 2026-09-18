import type { GraphIndex } from "../../core/nodeIndex.ts";
import {
  replayPickupSteps,
  type PickupPlanArtifact,
  type QueueArtifact,
} from "../../generation/queue-first/index.ts";
import { button, el } from "../dom.ts";
import { appendLine, createOverlay, railColor, railSegments } from "../queueGroupVisuals.ts";
import { createQueueArtifactCanvas, createQueueArtifactTile } from "./queueArtifactCanvas.ts";

export interface PickupCanvasOptions {
  queue: QueueArtifact;
  pickup?: PickupPlanArtifact;
  cursor: number;
  ix: GraphIndex;
  onStartManual(): void;
  onCursor(cursor: number): void;
  onPick(actionId: string): void;
  onAutoComplete(): void;
}

export function queueArtifactAtPickupCursor(
  queue: QueueArtifact,
  pickup: PickupPlanArtifact,
  cursor: number,
): { artifact: QueueArtifact; freezeBySlot: Map<string, number>; rowBySlot: Map<string, number>; rowCount: number; remaining: number } {
  const prefix = pickup.steps.slice(0, Math.max(0, Math.min(cursor, pickup.steps.length)));
  const replay = replayPickupSteps(queue, prefix);
  const sourceByCoordinate = new Map<string, QueueArtifact["lanes"][number]["slots"][number]>();
  queue.lanes.forEach((lane, x) => lane.slots.forEach((slot, y) => sourceByCoordinate.set(`${x}:${y}`, slot)));
  const artifact: QueueArtifact = {
    ...structuredClone(queue),
    lanes: replay.snapshot.cells.map((cells, x) => ({
      id: queue.lanes[x]?.id ?? `lane-${x}`,
      slots: cells.flatMap((cell) => {
        if (!cell) return [];
        const slot = sourceByCoordinate.get(`${cell.sourceX}:${cell.sourceY}`);
        return slot ? [structuredClone(slot)] : [];
      }),
    })),
  };
  const freezeBySlot = new Map<string, number>();
  const rowBySlot = new Map<string, number>();
  replay.snapshot.cells.forEach((cells) => cells.forEach((cell, y) => {
    if (!cell) return;
    const slot = sourceByCoordinate.get(`${cell.sourceX}:${cell.sourceY}`);
    if (slot) {
      freezeBySlot.set(slot.id, cell.freeze);
      rowBySlot.set(slot.id, y);
    }
  }));
  return { artifact, freezeBySlot, rowBySlot, rowCount: replay.snapshot.cells[0]?.length ?? 0, remaining: replay.remaining };
}

function drawTimelineGroup(row: HTMLElement, kind: "combined" | "linked", groupIndex: number): void {
  const tiles = [...row.querySelectorAll<HTMLElement>(".queue-tile")];
  if (tiles.length < 2) return;
  const bounds = row.getBoundingClientRect();
  const overlay = createOverlay(bounds);
  const points = tiles.map((tile) => {
    const rect = tile.getBoundingClientRect();
    return { x: rect.left - bounds.left + rect.width / 2, y: rect.top - bounds.top + rect.height / 2 };
  });
  for (let index = 1; index < points.length; index++) {
    if (kind === "linked") appendLine(overlay, points[index - 1], points[index], "queue-link-rope");
    else for (const [a, b] of railSegments(points[index - 1], points[index])) {
      appendLine(overlay, a, b, "queue-combine-rail", railColor(groupIndex));
    }
  }
  row.prepend(overlay);
}

export function createPickupCanvas(options: PickupCanvasOptions): HTMLElement {
  if (!options.pickup) {
    return el("div", { class: "qf-pickup-empty" }, [
      el("p", { class: "muted" }, ["Choose manual pickup to author the route directly, or auto-generate it from the same initial queue state."]),
      button("Start manual pickup", options.onStartManual),
      button("Auto-generate pickup path", options.onAutoComplete),
    ]);
  }
  const cursor = Math.max(0, Math.min(options.cursor, options.pickup.steps.length));
  const prefix = options.pickup.steps.slice(0, cursor);
  const replay = replayPickupSteps(options.queue, prefix);
  const sourceByCoordinate = new Map<string, QueueArtifact["lanes"][number]["slots"][number]>();
  const laneBySlot = new Map<string, number>();
  options.queue.lanes.forEach((lane, x) => lane.slots.forEach((slot, y) => {
    sourceByCoordinate.set(`${x}:${y}`, slot);
    laneBySlot.set(slot.id, x);
  }));
  const projected = queueArtifactAtPickupCursor(options.queue, options.pickup, cursor);
  const legalActionBySlot = new Map(replay.legalActions.flatMap((action) => action.slotIds.map((id) => [id, action.id] as const)));
  const selectedStep = options.pickup.steps[cursor];
  const board = createQueueArtifactCanvas({
    artifact: projected.artifact,
    ix: options.ix,
    selected: new Set(selectedStep?.slotIds ?? []),
    readOnly: true,
    legalActionBySlot,
    freezeBySlot: projected.freezeBySlot,
    rowBySlot: projected.rowBySlot,
    rowCount: projected.rowCount,
    onPick: options.onPick,
  });
  const slider = el("input", {
    type: "range",
    min: "0",
    max: String(options.pickup.steps.length),
    value: String(cursor),
    "aria-label": "Pickup timeline position",
    title: "Move backward or forward through the authored pickup path.",
  }) as HTMLInputElement;
  slider.addEventListener("input", () => {
    const maximum = Math.max(1, options.pickup!.steps.length);
    slider.style.setProperty("--field-ratio", `${Number(slider.value) / maximum * 100}%`);
  });
  slider.addEventListener("change", () => options.onCursor(Number(slider.value)));

  const timeline = el("div", { class: "qf-pickup-timeline" });
  options.pickup.steps.forEach((step, index) => {
    const groupIndex = options.queue.groups.findIndex((group) => step.slotIds.every((id) => group.slotIds.includes(id)));
    const group = groupIndex >= 0 ? options.queue.groups[groupIndex] : undefined;
    const row = el("div", {
      class: `qf-pickup-step-row${index < cursor ? " passed" : index > cursor ? " future" : " selected"}`,
      title: `${step.reason ?? step.actionId}. Select to preview the queue before this pick.`,
      role: "button",
      tabindex: "0",
      "aria-label": `Preview pickup step ${index + 1}`,
    }, [
      el("span", { class: "qf-pickup-step-number" }, [String(index + 1)]),
    ]);
    row.addEventListener("click", () => options.onCursor(index));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      options.onCursor(index);
    });
    step.slotIds.forEach((slotId) => {
      const slot = options.queue.lanes.flatMap((lane) => lane.slots).find((item) => item.id === slotId);
      if (!slot) return;
      const tile = createQueueArtifactTile(slot, options.ix, group?.kind, false, false);
      tile.append(el("span", { class: "qf-queue-number" }, [`Q${(laneBySlot.get(slotId) ?? 0) + 1}`]));
      row.append(tile);
    });
    timeline.append(row);
    if (group) requestAnimationFrame(() => drawTimelineGroup(row, group.kind, groupIndex));
  });

  return el("div", { class: "qf-pickup-workspace" }, [
    el("div", { class: "qf-pickup-toolbar" }, [
      el("span", { class: "status-chip" }, [options.pickup.mode === "auto" ? "Auto path" : "Manual path"]),
      button("Manual pickup", options.onStartManual, { class: options.pickup.mode !== "auto" ? "selected" : "" }),
      button(cursor < options.pickup.steps.length ? "Auto-generate from this point" : "Auto-generate remaining", options.onAutoComplete),
      el("span", { class: "spacer" }),
      el("span", {}, [`${cursor}/${options.pickup.steps.length} picks · ${replay.remaining} slots remain`]),
    ]),
    el("div", { class: "qf-timeline-scrubber" }, [slider]),
    el("div", { class: "qf-pickup-split" }, [
      el("div", { class: "qf-pickup-board" }, [el("h4", {}, ["Queue at timeline position"]), board]),
      el("div", { class: "qf-pickup-history" }, [el("h4", {}, ["Pickup timeline"]), timeline]),
    ]),
  ]);
}
