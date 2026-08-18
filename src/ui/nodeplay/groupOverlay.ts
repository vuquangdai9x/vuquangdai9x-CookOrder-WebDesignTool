// Linked-slot ropes and combined-slot rails for the node Play queue.
//
// Ported from legacy `play/index.ts`, which owns the same renderer privately —
// it is not exported, and that file may not be edited, so node Play had no way
// to reach it and simply drew nothing. The geometry and the class names are
// deliberately identical, since the look comes from `style.css`, which both
// modes share.
//
// The one deliberate change is the seam: legacy's version takes a
// `Simulation`, this one takes the two fields it actually reads. That makes the
// pairing rules testable without a sim or a DOM — `linkedChains` and
// `combinedAdjacentPairs` below are pure — which matters because every rule
// here is a "which cells connect" decision, and those are exactly what a silent
// geometry bug gets wrong.

import { appendLine, createOverlay, railColor, railSegments } from "../queueGroupVisuals.ts";
import type { Point } from "../queueGroupVisuals.ts";
import type { QueueGroupKind } from "../../core/types.ts";

/** All the overlay needs to know about a simulation. */
export interface GroupedQueue {
  /** Column-major; a null cell is a hole, and `group` is -1 when ungrouped. */
  queueGrid: ({ group: number } | null)[][];
  groupKinds: QueueGroupKind[];
}

/**
 * Adjacent cell pairs inside one combined group, both within the window.
 *
 * Right and down only, so each shared edge is produced once rather than twice.
 * Carries the group index so each block can take its own colour.
 */
export function combinedAdjacentPairs(
  sim: GroupedQueue,
  windowRows: number,
): { a: Point; b: Point; group: number }[] {
  const pairs: { a: Point; b: Point; group: number }[] = [];
  for (let x = 0; x < sim.queueGrid.length; x++) {
    for (let y = 0; y < Math.min(sim.queueGrid[x].length, windowRows); y++) {
      const cell = sim.queueGrid[x][y];
      if (!cell || cell.group === -1 || sim.groupKinds[cell.group] !== "combined") continue;
      const right = sim.queueGrid[x + 1]?.[y];
      if (right?.group === cell.group) {
        pairs.push({ a: { x, y }, b: { x: x + 1, y }, group: cell.group });
      }
      const down = y + 1 < windowRows ? sim.queueGrid[x][y + 1] : undefined;
      if (down?.group === cell.group) {
        pairs.push({ a: { x, y }, b: { x, y: y + 1 }, group: cell.group });
      }
    }
  }
  return pairs;
}

/**
 * Each linked group's cells, in chain order.
 *
 * Sorted by COLUMN, not row. Design mode only allows authoring a chain with one
 * member per column in one contiguous run, so column order IS the chain's edge
 * order. Row order breaks for a 3+ member chain the moment its members drift
 * onto different rows — linking never restricts movement, so each member rises
 * independently, and a row-first sort would then pair whichever members happen
 * to share a row rather than whichever are actually adjacent in the chain.
 */
export function linkedChains(sim: GroupedQueue): Point[][] {
  const byGroup = new Map<number, Point[]>();
  sim.queueGrid.forEach((col, x) => {
    col.forEach((cell, y) => {
      if (!cell || cell.group === -1 || sim.groupKinds[cell.group] !== "linked") return;
      const list = byGroup.get(cell.group) ?? [];
      list.push({ x, y });
      byGroup.set(cell.group, list);
    });
  });
  for (const cells of byGroup.values()) cells.sort((a, b) => a.x - b.x || a.y - b.y);
  return [...byGroup.values()];
}

/** Vertical pitch between adjacent rows of a lane, measured from its own tiles. */
function tilePitch(laneEl: HTMLElement): number {
  const tiles = [...laneEl.querySelectorAll<HTMLElement>(".queue-tile")];
  if (tiles.length > 1) {
    return tiles[1].getBoundingClientRect().top - tiles[0].getBoundingClientRect().top;
  }
  return tiles.length === 1 ? tiles[0].getBoundingClientRect().height + 4 : 0;
}

/** Screen-space centre of an on-screen cell, relative to `host`. */
function realPoint(lanes: HTMLElement, host: DOMRect, x: number, y: number): Point | null {
  const tile = lanes.querySelector<HTMLElement>(`[data-qx="${x}"][data-qy="${y}"]`);
  if (!tile) return null;
  const r = tile.getBoundingClientRect();
  return { x: r.left + r.width / 2 - host.left, y: r.top + r.height / 2 - host.top };
}

/**
 * Where an off-window row WOULD render, extrapolated at the lane's own pitch.
 * This is what lets a rope leave the window at the true angle instead of aiming
 * at an arbitrary point.
 */
function virtualPoint(lanes: HTMLElement, host: DOMRect, x: number, y: number): Point | null {
  const laneEl = lanes.querySelector<HTMLElement>(`[data-lane="${x}"]`);
  if (!laneEl) return null;
  const tiles = [...laneEl.querySelectorAll<HTMLElement>(".queue-tile")];
  if (tiles.length === 0) return null;
  const r = tiles[tiles.length - 1].getBoundingClientRect();
  const rowsBeyond = y - (tiles.length - 1);
  return {
    x: r.left + r.width / 2 - host.left,
    y: r.top + r.height / 2 - host.top + rowsBeyond * tilePitch(laneEl),
  };
}

/** Shortens a segment so its second end lands on the window's bottom edge, keeping the angle. */
function clipToBottom(x1: number, y1: number, x2: number, y2: number, maxY: number): Point {
  if (y2 <= maxY) return { x: x2, y: y2 };
  const t = (maxY - y1) / (y2 - y1);
  return { x: x1 + t * (x2 - x1), y: maxY };
}

/**
 * Draws linked ropes (dashed) and combined rails (solid doubles, one colour per
 * group) as a single SVG overlay.
 *
 * A rope connects consecutive members of a chain, but only across ADJACENT
 * columns — a pair two or more columns apart, or in the same column, draws
 * nothing, so a rope never reads as a long diagonal across the board. A partner
 * below the window still gets a segment at the true angle, clipped at the edge,
 * so the player can judge how far away it is. A pair with neither end on screen
 * draws nothing.
 *
 * A rail only joins cells both inside the window: unlike a rope it has no "how
 * far away" question to answer, so a block extending past the window just shows
 * its visible part.
 */
export function renderGroupOverlay(
  lanes: HTMLElement,
  sim: GroupedQueue,
  windowRows: number,
): void {
  const chains = linkedChains(sim);
  const combinedPairs = combinedAdjacentPairs(sim, windowRows);
  if (chains.length === 0 && combinedPairs.length === 0) return;

  const host = lanes.getBoundingClientRect();
  const svg = createOverlay(host);

  for (const cells of chains) {
    for (let i = 0; i < cells.length - 1; i++) {
      const a = cells[i];
      const b = cells[i + 1];
      if (Math.abs(a.x - b.x) !== 1) continue; // adjacent columns only
      const aVisible = a.y < windowRows;
      const bVisible = b.y < windowRows;
      if (!aVisible && !bVisible) continue;

      const p1 = aVisible ? realPoint(lanes, host, a.x, a.y) : virtualPoint(lanes, host, a.x, a.y);
      const p2 = bVisible ? realPoint(lanes, host, b.x, b.y) : virtualPoint(lanes, host, b.x, b.y);
      if (!p1 || !p2) continue;

      const start = aVisible ? p1 : clipToBottom(p2.x, p2.y, p1.x, p1.y, host.height);
      const end = bVisible ? p2 : clipToBottom(p1.x, p1.y, p2.x, p2.y, host.height);
      appendLine(svg, start, end, "queue-link-rope");
    }
  }

  for (const { a, b, group } of combinedPairs) {
    const p1 = realPoint(lanes, host, a.x, a.y);
    const p2 = realPoint(lanes, host, b.x, b.y);
    if (!p1 || !p2) continue;
    const color = railColor(group);
    for (const [s, e] of railSegments(p1, p2)) appendLine(svg, s, e, "queue-combine-rail", color);
  }

  // Prepended, not appended. Paired with .queue-link-overlay's `z-index: 0`,
  // this puts the overlay first in tree order within that layer, so it paints
  // UNDER every .queue-tile (nested deeper, later in tree order) while still
  // painting over each lane's own opaque panel background — an unpositioned
  // element, always painted before any z-index:0 layer regardless of position.
  // Appending instead would draw the lines on top of the tiles.
  lanes.prepend(svg);
}
