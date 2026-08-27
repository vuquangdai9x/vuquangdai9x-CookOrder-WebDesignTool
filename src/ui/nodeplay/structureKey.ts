// Signature of everything in the node play view that decides *which elements
// exist* — the node-graph counterpart of ui/play/structureKey.ts. Same
// contract, same reason: the render loop should rebuild a tier only when this
// string changes for it, never on every tick.
//
// It deliberately excludes values that move every frame (elapsed time,
// patience countdowns, cook progress) — those are patched in place via
// refreshHud(). Folding them in here would rebuild the DOM ~10 times a second
// (this view's TICK_MS), and a real mouse click could never complete, because
// the tile that received mousedown would be gone by mouseup — this is what
// produced the "most of the time I cannot pick" report: the fix is not to the
// simulation, which is parity-correct with legacy, but to how often the DOM
// underneath a pointer gets torn down.
//
// Split per tier, mirroring ui/play/structureKey.ts, so the view rebuilds only
// the tier that actually changed.

import type { NodeSimulation } from "../../core/nodeSim.ts";

export function customersStructureKey(sim: NodeSimulation): string {
  const customers = [
    ...sim.active.map(
      (c) =>
        `a${c.index}:${c.dishes
          .map((d) => `${d.filled.map((f) => (f ? 1 : 0)).join(".")}/${d.remaining.join(".")}`)
          .join(",")}`,
    ),
    // The next three customers reveal orderable composite identities only.
    // Include those identities so a pending-order edit/replay state rebuilds
    // the compact preview cards without exposing ingredient combinations.
    ...sim.pending.slice(0, 3).map(
      (c) => `p${c.index}:${c.dishes.map((dish) => dish.order.orderable).join(".")}`,
    ),
  ].join("|");
  return `${sim.status}|${customers}`;
}

export function middleStructureKey(sim: NodeSimulation): string {
  const grid = sim.grid
    .map((cell, i) => {
      const lock = sim.cellLockLabel(i);
      if (lock) return `L${lock}`;
      // usesLeft must be part of the key: a multi-use ingredient (e.g. a
      // shared sauce) keeps the same ingredient index across a serve that
      // only decrements its remaining uses — without a key change here, the
      // grid tier never rebuilds to show the new count.
      if (cell.kind === "cooked") {
        return `c${cell.ing}${cell.usesLeft !== undefined ? `x${cell.usesLeft}` : ""}`;
      }
      if (cell.kind === "raw") return `r${cell.ing}`;
      if (cell.kind === "dirty") return `d${cell.dirtyId}:${cell.count}`;
      if (cell.kind === "backpack") return `b${cell.items.join(".")}`;
      return "-";
    })
    .join(",");

  // Which slots are occupied and by what — not how far along they are.
  const tools = sim.tools
    .map((t) => `${t.index}[${t.slots.map((s) => (s.item ? s.item.ing : "-")).join("")}]`)
    .join(",");

  return `${sim.status}|${grid}|${tools}`;
}

export function queuesStructureKey(sim: NodeSimulation): string {
  // Column occupancy — not just length/front-id — because a combined block
  // that finally moves can change which cells hold what without changing the
  // column's item *count* (the items behind it just slide up into the same
  // total). Encoding id + group per cell also covers a hole appearing (the
  // block stalled) and any group's shape changing, plus per-column pickability.
  const queues = sim.queueGrid
    .map((col, x) => {
      const cells = col
        .map((cell) => {
          if (!cell) return "-";
          // A frozen item's remaining thaw count decrements from an ADJACENT
          // pick, which may not touch this cell's own lane at all (so
          // canPick(x) below wouldn't change) — include it explicitly so a
          // buried, still-frozen preview tile's badge stays live instead of
          // going stale until something else rebuilds the tier.
          const freeze = sim.freezeCount(cell.item);
          return `${cell.item.id}/${cell.group}${freeze > 0 ? `f${freeze}` : ""}`;
        })
        .join(".");
      return `${cells}:${sim.canPick(x).ok ? 1 : 0}`;
    })
    .join(",");
  // neededIngredients() already returns each dish slot's resolved (servable)
  // ingredient index directly — the same ids queuesTier() compares a tile's
  // terminal output against — so no further resolution belongs here.
  const needed = [...sim.neededIngredients()].sort((a, b) => a - b).join(".");
  return `${sim.status}|${queues}|${needed}`;
}

/** Combined key, for callers that just want "did anything structural change". */
export function playStructureKey(sim: NodeSimulation): string {
  return [customersStructureKey(sim), middleStructureKey(sim), queuesStructureKey(sim)].join("‖");
}
