// Signature of everything in the play view that decides *which elements exist*.
//
// The play loop rebuilds the DOM only when this string changes. It deliberately
// excludes values that move every frame (elapsed time, patience countdowns,
// cook progress) — those are patched in place. If they were included, the DOM
// would be replaced ~60 times a second and a real mouse click could never
// complete, because the tile that received mousedown would be gone by mouseup.
//
// Split per tier (rather than one page-wide key) so PlayView can rebuild only
// the tier that actually changed — most importantly, so the customers tier can
// be held back mid-exit-animation without freezing the grid/tools/queues too.

import type { Simulation } from "../../core/sim.ts";

export function customersStructureKey(sim: Simulation): string {
  const customers = [
    ...sim.active.map(
      (c) =>
        `a${c.index}:${c.dishes
          .map((d) => `${d.filled.join(".")}/${d.remaining.join(".")}`)
          .join(",")}`,
    ),
    // Only the next customer is shown, and only as a masked "?" card.
    ...sim.pending.slice(0, 1).map((c) => `p${c.index}`),
  ].join("|");
  return `${sim.status}|${customers}`;
}

export function middleStructureKey(sim: Simulation): string {
  const grid = sim.grid
    .map((cell, i) => {
      const lock = sim.cellLockLabel(i);
      if (lock) return `L${lock}`;
      if (cell.kind === "cooked") return `c${cell.cookedId}`;
      if (cell.kind === "raw") return `r${cell.rawId}`;
      if (cell.kind === "dirty") return `d${cell.dirtyId}:${cell.count}`;
      return "-";
    })
    .join(",");

  // Which slots are occupied and by what — not how far along they are.
  const tools = sim.tools
    .map((t) => `${t.def.id}[${t.slots.map((s) => (s.item ? s.item.rawId : "-")).join("")}]`)
    .join(",");

  return `${sim.status}|${grid}|${tools}`;
}

export function queuesStructureKey(sim: Simulation): string {
  // Column occupancy — not just length/front-id — because a combined block
  // that finally moves can change which cells hold what without changing the
  // column's item *count* (the items behind it just slide up into the same
  // total). Encoding id + group per cell also covers a hole appearing (the
  // block stalled) and any group's shape changing, plus per-column pickability.
  const queues = sim.queueGrid
    .map((col, x) => {
      const cells = col.map((cell) => (cell ? `${cell.item.id}/${cell.group}` : "-")).join(".");
      return `${cells}:${sim.canPick(x).ok ? 1 : 0}`;
    })
    .join(",");
  const needed = [...sim.neededCookedIds()].sort((a, b) => a - b).join(".");
  return `${sim.status}|${queues}|${needed}`;
}

/** Combined key, kept for callers that just want "did anything structural change". */
export function playStructureKey(sim: Simulation): string {
  return [customersStructureKey(sim), middleStructureKey(sim), queuesStructureKey(sim)].join("‖");
}
