import Sortable from "sortablejs";
import { EFFECT_FREEZE, EFFECT_HIDDEN, EFFECT_HOLDING_KEY } from "../../core/effects.ts";
import type { GraphIndex } from "../../core/nodeIndex.ts";
import { KEY_COLORS } from "../../data/configLoader.ts";
import {
  artifactHash,
  type QueueArtifact,
  type QueueArtifactSlot,
} from "../../generation/queue-first/index.ts";
import { showContextMenu } from "../contextMenu.ts";
import { button, el } from "../dom.ts";
import { iconEl, statusIconEl } from "../icon.ts";
import { appendLine, createOverlay, railColor, railSegments } from "../queueGroupVisuals.ts";

export interface QueueArtifactCanvasOptions {
  artifact: QueueArtifact;
  ix: GraphIndex;
  selected: Set<string>;
  readOnly?: boolean;
  legalActionBySlot?: ReadonlyMap<string, string>;
  freezeBySlot?: ReadonlyMap<string, number>;
  /** Runtime row for each slot; preserves holes created by rigid combined movement. */
  rowBySlot?: ReadonlyMap<string, number>;
  rowCount?: number;
  onSelectionChange?(selected: Set<string>): void;
  onPick?(actionId: string): void;
  onChange?(artifact: QueueArtifact, description: string): void;
}

const effect = (slot: QueueArtifactSlot, id: number) => slot.effects.find((item) => item.effectId === id);

export function refreshQueueArtifact(artifact: QueueArtifact): QueueArtifact {
  const contentHash = artifactHash({
    contextHash: artifact.contextHash,
    vectorHash: artifact.vectorHash,
    lanes: artifact.lanes,
    groups: artifact.groups,
  });
  return {
    ...artifact,
    id: `queue-${contentHash.slice(0, 12)}`,
    contentHash,
    status: "draft",
  };
}

export function createQueueArtifactTile(
  slot: QueueArtifactSlot,
  ix: GraphIndex,
  groupKind: "combined" | "linked" | undefined,
  selected: boolean,
  legal: boolean,
  freezeOverride?: number,
): HTMLElement {
  const frozen = effect(slot, EFFECT_FREEZE);
  const hidden = effect(slot, EFFECT_HIDDEN);
  const key = effect(slot, EFFECT_HOLDING_KEY);
  const freeze = freezeOverride ?? frozen?.params[0] ?? 0;
  const vertex = ix.doc.vertices.ingredient[slot.ingredient];
  const tile = el("div", {
    class: `queue-tile${freeze > 0 ? " frozen" : ""}${hidden ? " hidden-slot" : ""}${selected ? " selected" : ""}${groupKind ? ` group-${groupKind}` : ""}${legal ? " qf-pickable" : ""}`,
    "data-slot-id": slot.id,
    title: `${vertex?.displayName ?? vertex?.name ?? slot.ingredient} · ${slot.id}`,
  });
  tile.append(el("span", { class: "tile-main" }, [iconEl(vertex ? {
    name: vertex.displayName || vertex.name,
    emoji: vertex.emoji ?? "❔",
    localImage: vertex.localImage,
    imageURL: vertex.imageURL,
    fileId: vertex.fileId,
  } : undefined, { className: "icon-ingredient" })]));
  if (freeze > 0) {
    tile.append(el("span", { class: "tile-corner" }, [statusIconEl(EFFECT_FREEZE, 22)]));
    tile.append(el("span", { class: "tile-freeze-count" }, [String(freeze)]));
  }
  if (hidden) tile.append(el("span", { class: "tile-hidden" }, [statusIconEl(EFFECT_HIDDEN, 20)]));
  if (key) {
    const color = KEY_COLORS.find((item) => item.id === (key.params[0] ?? 0));
    const badge = el("span", { class: "tile-key", title: color?.name ?? "Holding key" }, [statusIconEl(EFFECT_HOLDING_KEY, 20)]);
    badge.style.backgroundColor = color?.hex ?? "transparent";
    tile.append(badge);
  }
  if (slot.amount > 1) tile.append(el("span", { class: "tile-amount" }, [String(slot.amount)]));
  return tile;
}

function drawGroups(host: HTMLElement, artifact: QueueArtifact): void {
  host.querySelector(".queue-link-overlay")?.remove();
  const bounds = host.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const overlay = createOverlay(bounds);
  artifact.groups.forEach((group, groupIndex) => {
    const points = group.slotIds.map((id) => {
      const tile = host.querySelector<HTMLElement>(`[data-slot-id="${CSS.escape(id)}"]`);
      if (!tile) return undefined;
      const rect = tile.getBoundingClientRect();
      return { x: rect.left - bounds.left + rect.width / 2, y: rect.top - bounds.top + rect.height / 2 };
    }).filter((point): point is { x: number; y: number } => !!point);
    for (let index = 1; index < points.length; index++) {
      if (group.kind === "linked") appendLine(overlay, points[index - 1], points[index], "queue-link-rope");
      else for (const [a, b] of railSegments(points[index - 1], points[index])) {
        appendLine(overlay, a, b, "queue-combine-rail", railColor(groupIndex));
      }
    }
  });
  host.prepend(overlay);
}

export function createQueueArtifactCanvas(options: QueueArtifactCanvasOptions): HTMLElement {
  const artifact = structuredClone(options.artifact);
  const host = el("div", { class: `queue-lanes qf-queue-editor${options.readOnly ? " read-only" : ""}` });
  const selected = new Set([...options.selected].filter((id) => artifact.lanes.some((lane) => lane.slots.some((slot) => slot.id === id))));
  const groupBySlot = new Map(artifact.groups.flatMap((group) => group.slotIds.map((id) => [id, group.kind] as const)));

  const commit = (description: string): void => options.onChange?.(refreshQueueArtifact(artifact), description);
  const updateSelection = (): void => options.onSelectionChange?.(new Set(selected));
  const removeFromGroups = (ids: ReadonlySet<string>): void => {
    artifact.groups = artifact.groups
      .map((group) => ({ ...group, slotIds: group.slotIds.filter((id) => !ids.has(id)) }))
      .filter((group) => group.slotIds.length >= 2);
  };
  const editSlots = (ids: ReadonlySet<string>, mutate: (slot: QueueArtifactSlot) => void): void => {
    artifact.lanes.forEach((lane) => lane.slots.forEach((slot) => { if (ids.has(slot.id)) mutate(slot); }));
  };
  const menuFor = (event: MouseEvent, slot: QueueArtifactSlot): void => {
    if (options.readOnly) return;
    if (!selected.has(slot.id)) {
      selected.clear();
      selected.add(slot.id);
      updateSelection();
    }
    const targets = new Set(selected);
    const linkedColumns = artifact.lanes.flatMap((lane, x) => lane.slots
      .filter((item) => targets.has(item.id))
      .map(() => x)).sort((a, b) => a - b);
    const legalLinkedSelection = targets.size >= 2
      && targets.size <= 5
      && new Set(linkedColumns).size === targets.size
      && linkedColumns.every((column, index) => index === 0 || column === linkedColumns[index - 1] + 1);
    const frozen = effect(slot, EFFECT_FREEZE);
    const hidden = effect(slot, EFFECT_HIDDEN);
    showContextMenu(event, [
      {
        label: `Amount (${slot.amount})`,
        expand: (close) => {
          const input = el("input", { type: "number", min: "1", value: String(slot.amount) }) as HTMLInputElement;
          const apply = button("Apply", () => {
            const amount = Math.max(1, Math.trunc(Number(input.value) || 1));
            editSlots(targets, (item) => { item.amount = amount; item.provenance = "manual"; });
            close(); commit("Changed queue slot amount.");
          }, { class: "primary" });
          return el("div", { class: "ctx-field" }, [input, apply]);
        },
      },
      {
        label: frozen ? "Remove Freeze" : "Add Freeze",
        active: !!frozen,
        onSelect: () => {
          editSlots(targets, (item) => {
            item.effects = item.effects.filter((value) => value.effectId !== EFFECT_FREEZE);
            if (!frozen) item.effects.push({ effectId: EFFECT_FREEZE, params: [1] });
          });
          commit("Changed Freeze effect.");
        },
      },
      {
        label: hidden ? "Remove Hidden" : "Add Hidden",
        active: !!hidden,
        onSelect: () => {
          editSlots(targets, (item) => {
            item.effects = item.effects.filter((value) => value.effectId !== EFFECT_HIDDEN);
            if (!hidden) item.effects.push({ effectId: EFFECT_HIDDEN, params: [] });
          });
          commit("Changed Hidden effect.");
        },
      },
      {
        label: "Holding key color",
        expand: (close) => el("div", { class: "qf-color-key-list" }, KEY_COLORS.map((color) => button(color.name, () => {
          editSlots(targets, (item) => {
            item.effects = item.effects.filter((value) => value.effectId !== EFFECT_HOLDING_KEY);
            if (color.id !== 0) item.effects.push({ effectId: EFFECT_HOLDING_KEY, params: [color.id] });
          });
          close(); commit("Changed Holding Key color.");
        }, { style: `--key-color:${color.hex}` }))),
      },
      {
        label: "Combine selection",
        disabled: targets.size < 2 || targets.size > 5,
        onSelect: () => {
          removeFromGroups(targets);
          artifact.groups.push({ id: `manual-combined-${Date.now()}`, kind: "combined", slotIds: [...targets] });
          commit("Combined selected queue slots.");
        },
      },
      {
        label: "Link selection",
        disabled: !legalLinkedSelection,
        onSelect: () => {
          removeFromGroups(targets);
          artifact.groups.push({ id: `manual-linked-${Date.now()}`, kind: "linked", slotIds: [...targets] });
          commit("Linked selected queue slots.");
        },
      },
      { label: "Ungroup selection", onSelect: () => { removeFromGroups(targets); commit("Ungrouped selected slots."); } },
      {
        label: "Delete selection",
        danger: true,
        separator: true,
        onSelect: () => {
          removeFromGroups(targets);
          artifact.lanes.forEach((lane) => { lane.slots = lane.slots.filter((item) => !targets.has(item.id)); });
          selected.clear(); updateSelection(); commit("Deleted selected queue slots.");
        },
      },
    ], { title: targets.size > 1 ? `${targets.size} selected slots` : slot.id });
  };

  artifact.lanes.forEach((lane, laneIndex) => {
    const laneEl = el("div", { class: "queue-lane", "data-lane-id": lane.id }, [
      el("div", { class: "lane-head" }, [el("span", {}, [`Queue ${laneIndex + 1}`]), el("span", {}, ["⠿"])]),
    ]);
    const tiles = el("div", { class: `lane-tiles${options.rowBySlot ? " positioned" : ""}` });
    if (options.rowBySlot) {
      tiles.style.gridTemplateRows = `repeat(${Math.max(1, options.rowCount ?? lane.slots.length)}, calc(var(--tile) * var(--tile-zoom)))`;
    }
    lane.slots.forEach((slot) => {
      const action = options.legalActionBySlot?.get(slot.id);
      const tile = createQueueArtifactTile(slot, options.ix, groupBySlot.get(slot.id), selected.has(slot.id), !!action, options.freezeBySlot?.get(slot.id));
      const runtimeRow = options.rowBySlot?.get(slot.id);
      if (runtimeRow !== undefined) tile.style.gridRow = String(runtimeRow + 1);
      tile.addEventListener("click", (event) => {
        if (action && options.onPick) { options.onPick(action); return; }
        if (options.readOnly) return;
        if (!(event as MouseEvent).shiftKey) selected.clear();
        if (selected.has(slot.id) && (event as MouseEvent).shiftKey) selected.delete(slot.id);
        else selected.add(slot.id);
        updateSelection();
        tile.classList.toggle("selected", selected.has(slot.id));
      });
      tile.addEventListener("contextmenu", (event) => menuFor(event, slot));
      tiles.append(tile);
    });
    laneEl.append(tiles);
    host.append(laneEl);
    if (!options.readOnly) new Sortable(tiles, {
      group: "qf-queue-slots",
      draggable: ".queue-tile",
      animation: 140,
      onEnd: (event) => {
        const source = artifact.lanes.find((item) => item.id === (event.from.closest(".queue-lane") as HTMLElement)?.dataset.laneId);
        const target = artifact.lanes.find((item) => item.id === (event.to.closest(".queue-lane") as HTMLElement)?.dataset.laneId);
        if (!source || !target || event.oldIndex === undefined || event.newIndex === undefined) return;
        const [moved] = source.slots.splice(event.oldIndex, 1);
        if (moved) target.slots.splice(event.newIndex, 0, moved);
        commit("Reordered queue slots.");
      },
    });
  });
  if (!options.readOnly) new Sortable(host, {
    animation: 140,
    handle: ".lane-head",
    draggable: ".queue-lane",
    onEnd: (event) => {
      if (event.oldIndex === undefined || event.newIndex === undefined) return;
      const [moved] = artifact.lanes.splice(event.oldIndex, 1);
      if (moved) artifact.lanes.splice(event.newIndex, 0, moved);
      commit("Reordered queue lanes.");
    },
  });
  requestAnimationFrame(() => drawGroups(host, artifact));
  return el("div", { class: "queue-lanes-shell qf-queue-shell" }, [host]);
}
