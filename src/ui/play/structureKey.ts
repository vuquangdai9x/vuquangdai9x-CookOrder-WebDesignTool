// Signature of everything in the play view that decides *which elements exist*.
//
// The play loop rebuilds the DOM only when this string changes. It deliberately
// excludes values that move every frame (elapsed time, patience countdowns,
// cook progress) — those are patched in place. If they were included, the DOM
// would be replaced ~60 times a second and a real mouse click could never
// complete, because the tile that received mousedown would be gone by mouseup.

import type { Simulation } from "../../core/sim.ts";

export function playStructureKey(sim: Simulation): string {
  const customers = [
    ...sim.active.map(
      (c) =>
        `a${c.index}:${c.dishes
          .map((d) => `${d.filled.join(".")}/${d.remaining.join(".")}`)
          .join(",")}`,
    ),
    ...sim.pending.slice(0, 4).map((c) => `p${c.index}`),
  ].join("|");

  const grid = sim.grid
    .map((cell, i) => {
      const lock = sim.cellLockLabel(i);
      if (lock) return `L${lock}`;
      if (cell.kind === "cooked") return `c${cell.cookedId}`;
      if (cell.kind === "dirty") return `d${cell.count}`;
      return "-";
    })
    .join(",");

  // Stage, not elapsed: a bar filling up is a live value, not a new element.
  const pipeline = sim.pipeline.map((p) => `${p.uid}${p.stage}`).join(",");

  const queues = sim.queues
    .map((q, i) => `${q.length}:${q[0]?.id ?? "x"}:${sim.canPick(i).ok ? 1 : 0}`)
    .join(",");

  const needed = [...sim.neededCookedIds()].sort((a, b) => a - b).join(".");

  return `${sim.status}|${customers}|${grid}|${pipeline}|${queues}|${needed}`;
}
