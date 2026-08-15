// Play mode on the node graph.
//
// The legacy PlayView is ~1900 lines, most of it flight-animation bookkeeping.
// Rather than fork all of it, this drives `NodeSimulation` through the SAME
// stylesheet and the same class names — `.play-page`, `.play-section`,
// `.queue-lane`, `.queue-tile`, `.tool-slots`, `.grid-cell`, `.customer-card` —
// so the look is the legacy look because it is literally the legacy CSS.
//
// The scope difference from legacy, stated plainly: transfers resolve instantly
// here (`instantFlights`) rather than being animated cell-to-cell, and the
// booster bar, the Save Me flow and the bot runner are not wired up. Those were
// on the plan's cut list; every one of them is reachable through
// `NodeSimulation`'s already-compatible surface (`forceShiftUp`, `pickAt`,
// `clearDirtyStacks`, `autoCompleteDish`, `saveMe`) when they are wanted.
//
// What this DOES prove is the thing worth proving: a migrated level plays end
// to end on graph rules, with coated chicken hopping flour → fryer and never
// touching the grid.

import { button, el } from "../dom.ts";
import { cookedIconEl, dirtyIconEl, ingredientIconEl, toolIconEl } from "../icon.ts";
import { NodeSimulation } from "../../core/nodeSim.ts";
import type { NodeCellContent } from "../../core/nodeSim.ts";
import { buildIndex } from "../../core/nodeIndex.ts";
import type { GraphIndex } from "../../core/nodeIndex.ts";
import { nodeAsMapDef } from "../../data/nodeGraphToMapDef.ts";
import type { ProjectedMap } from "../../data/nodeGraphToMapDef.ts";
import { toNodeLevelConfig } from "../../data/nodeLevel.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import type { NodeProjectState } from "../../data/nodeProject.ts";

const TICK_MS = 100;

export class NodePlayView {
  private root: HTMLElement;
  private project: NodeProjectState;
  private onSelectLevel: (levelId: number) => void;

  private ix: GraphIndex;
  private projected: ProjectedMap;
  private level!: LevelData;
  private sim!: NodeSimulation;

  private page = el("div", { class: "play-page" });
  private timer: number | null = null;
  private speed = 1;

  constructor(
    root: HTMLElement,
    project: NodeProjectState,
    levelId: number,
    onSelectLevel: (levelId: number) => void,
  ) {
    this.root = root;
    this.project = project;
    this.onSelectLevel = onSelectLevel;
    this.ix = buildIndex(project.doc);
    this.projected = nodeAsMapDef(project.doc, this.ix);
    this.level = project.levels.find((l) => l.id === levelId) ?? project.levels[0];
    this.root.replaceChildren(this.page);
    this.restart();
  }

  destroy(): void {
    this.stopClock();
  }

  // ---------- lifecycle ----------

  private restart(): void {
    this.stopClock();
    if (!this.level) {
      this.page.replaceChildren(el("p", {}, ["This graph has no levels yet."]));
      return;
    }
    this.sim = new NodeSimulation(this.ix, toNodeLevelConfig(this.level));
    this.render();
    this.startClock();
  }

  private startClock(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => {
      if (this.sim.status !== "playing") {
        this.stopClock();
        this.render();
        return;
      }
      this.sim.tick((TICK_MS / 1000) * this.speed);
      this.render();
    }, TICK_MS);
  }

  private stopClock(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- rendering ----------

  private render(): void {
    this.page.replaceChildren(
      this.toolbar(),
      this.customersTier(),
      this.middleTier(),
      this.queuesTier(),
      ...(this.sim.status === "playing" ? [] : [this.endOverlay()]),
    );
  }

  private toolbar(): HTMLElement {
    const picker = el("select", {}) as HTMLSelectElement;
    for (const level of this.project.levels) {
      picker.append(el("option", { value: String(level.id) }, [level.name]));
    }
    picker.value = String(this.level.id);
    picker.addEventListener("change", () => this.onSelectLevel(Number(picker.value)));

    const speedBtn = button(`⏩ ×${this.speed}`, () => {
      this.speed = this.speed === 1 ? 4 : this.speed === 4 ? 16 : 1;
      this.render();
    }, { title: "Playback speed" });

    return el("div", { class: "play-toolbar" }, [
      picker,
      button("↻ Restart", () => this.restart()),
      speedBtn,
      el("span", { class: "play-stat" }, [`⏱ ${this.sim.time.toFixed(1)}s`]),
      el("span", { class: "play-stat" }, [
        `🧾 ${this.sim.servedCount}/${this.sim.totalCustomers}`,
      ]),
      el("span", { class: "play-stat" }, [`📦 ${this.sim.remainingItems} left`]),
      ...(this.sim.issues.length
        ? [el("span", { class: "play-stat warn" }, [`⚠ ${this.sim.issues.length} data issue(s)`])]
        : []),
    ]);
  }

  private customersTier(): HTMLElement {
    const row = el("div", { class: "customer-cards play" });
    for (const customer of this.sim.active) {
      const card = el("div", { class: `customer-card${customer.isStaff ? " staff" : ""}` });
      const head = el("div", { class: "customer-head" }, [
        el("span", { class: "customer-index" }, [`#${customer.index + 1}`]),
        el("span", { class: "customer-timer" }, [
          customer.timeLeft === Infinity ? "∞" : `${customer.timeLeft.toFixed(0)}s`,
        ]),
      ]);
      const content = el("div", { class: "customer-content" }, [head]);

      if (customer.isStaff) {
        content.append(el("div", { class: "customer-dish" }, ["🧹 clearing"]));
      }
      // A FLAT list of ingredient chips, exactly as legacy Play draws a dish:
      // the player is reading "what do I still owe this customer", and slot
      // structure is the designer's concern, not theirs. It survives only as
      // the served/gated styling and the tooltip.
      customer.dishes.forEach((dish) => {
        const dishEl = el("div", { class: "customer-dish" });
        dish.order.slots.forEach((slot, i) => {
          const dataId = this.projected.dataIdOf.get(slot.ing);
          const chip = el("span", {
            class: `chip icon-chip dish-chip${dish.filled[i] ? " filled" : dish.gateOpen(i) ? "" : " gated"}`,
            title: `${this.ix.ingName[slot.ing]}${dish.gateOpen(i) ? "" : " — waiting for the base"}`,
          });
          chip.append(dataId === undefined ? el("span", { class: "icon" }, ["❔"]) : cookedIconEl(dataId, 48));
          dishEl.append(chip);
        });
        content.append(dishEl);
      });
      card.append(content);
      row.append(card);
    }
    return el("section", { class: "play-section customers-tier" }, [row]);
  }

  private middleTier(): HTMLElement {
    const tools = el("div", { class: "tool-row" });
    for (const tool of this.sim.tools) {
      const slots = el("div", { class: "tool-slots" });
      for (const slot of tool.slots) {
        const cell = el("div", { class: `tool-slot${slot.item ? " busy" : ""}` });
        if (slot.item) {
          const dataId = this.projected.dataIdOf.get(slot.item.ing);
          cell.append(
            dataId === undefined ? el("span", { class: "icon" }, ["❔"]) : ingredientIconEl(dataId, 28),
            el("span", { class: "tool-progress" }, [
              `${Math.min(100, Math.round((slot.item.elapsed / slot.item.duration) * 100))}%`,
            ]),
          );
        }
        slots.append(cell);
      }
      const def = this.projected.map.tools.find((t) => t.name === tool.displayName);
      tools.append(
        el("div", { class: "tool-card" }, [
          el("div", { class: "tool-head" }, [
            def ? toolIconEl(def, 28) : el("span", { class: "icon" }, ["🍳"]),
            el("span", { class: "tool-name" }, [tool.displayName]),
          ]),
          slots,
        ]),
      );
    }

    const grid = el("div", { class: "play-grid" });
    grid.style.gridTemplateColumns = `repeat(${this.project.doc.map.gridWidth}, 1fr)`;
    this.sim.grid.forEach((cell, index) => {
      grid.append(this.gridCell(cell, index));
    });

    return el("section", { class: "play-section middle-tier" }, [tools, grid]);
  }

  private gridCell(cell: NodeCellContent, index: number): HTMLElement {
    const usable = this.sim.isCellUsable(index);
    const node = el("div", { class: `grid-cell${usable ? "" : " locked"}` });
    if (!usable) {
      node.append(el("span", { class: "grid-lock" }, [this.sim.cellLockLabel(index) ?? "🔒"]));
      return node;
    }
    if (cell.kind === "cooked" || cell.kind === "raw") {
      const dataId = this.projected.dataIdOf.get(cell.ing);
      node.append(
        dataId === undefined
          ? el("span", { class: "icon" }, ["❔"])
          : cell.kind === "raw"
            ? ingredientIconEl(dataId, 32)
            : cookedIconEl(dataId, 32),
      );
      if (cell.kind === "cooked" && cell.usesLeft && cell.usesLeft > 1) {
        node.append(el("span", { class: "uses-left" }, [`×${cell.usesLeft}`]));
      }
      if (cell.kind === "raw") node.classList.add("parked");
    } else if (cell.kind === "dirty") {
      node.append(dirtyIconEl(cell.dirtyId, 32), el("span", { class: "dirty-count" }, [`×${cell.count}`]));
    } else if (cell.kind === "backpack") {
      node.append(el("span", { class: "icon" }, ["🎒"]), el("span", {}, [`×${cell.items.length}`]));
    }
    return node;
  }

  private queuesTier(): HTMLElement {
    const lanes = el("div", { class: "queue-lanes play" });
    const visibleRows = this.project.doc.map.visibleRows || 3;

    for (let x = 0; x < this.sim.columnCount; x++) {
      const tiles = el("div", { class: "queue-tiles" });
      for (let y = 0; y < visibleRows; y++) {
        const cell = this.sim.queueGrid[x]?.[y] ?? null;
        if (!cell) {
          tiles.append(el("div", { class: "queue-tile empty" }));
          continue;
        }
        const hidden = this.sim.isHidden(x, y);
        const frozen = this.sim.freezeCount(cell.item);
        const tile = el("div", {
          class: `queue-tile${y === 0 ? " front" : ""}${hidden ? " hidden-slot" : ""}${
            frozen > 0 ? " frozen" : ""
          }${cell.group !== -1 ? " grouped" : ""}`,
        });
        if (hidden) {
          tile.append(el("span", { class: "icon" }, ["❓"]));
        } else if (cell.item.kind === "sweeper") {
          tile.append(el("span", { class: "icon" }, ["🧹"]));
        } else {
          const dataId = this.projected.dataIdOf.get(cell.ing);
          tile.append(
            dataId === undefined ? el("span", { class: "icon" }, ["❔"]) : ingredientIconEl(dataId, 32),
          );
        }
        if (frozen > 0) tile.append(el("span", { class: "freeze-badge" }, [String(frozen)]));
        tiles.append(tile);
      }

      const check = this.sim.canPick(x);
      const lane = el("div", { class: "queue-lane", "data-lane": String(x) }, [
        tiles,
        el("span", { class: "queue-count" }, [String(this.sim.remainingIn(x))]),
      ]);
      if (!check.ok && check.reason) lane.title = check.reason;
      lane.classList.toggle("blocked", !check.ok);
      lane.addEventListener("click", () => {
        if (!this.sim.pick(x)) return;
        this.render();
      });
      lanes.append(lane);
    }

    return el("section", { class: "play-section queues-tier" }, [lanes]);
  }

  private endOverlay(): HTMLElement {
    const won = this.sim.status === "won";
    return el("div", { class: `play-overlay ${won ? "won" : "lost"}` }, [
      el("div", { class: "overlay-panel" }, [
        el("h2", {}, [won ? "🎉 Level complete" : "💥 Level failed"]),
        el("p", {}, [
          won
            ? `All ${this.sim.totalCustomers} customers served in ${this.sim.time.toFixed(1)}s.`
            : `${this.sim.loseReason ?? "unknown"} — ${this.sim.servedCount}/${this.sim.totalCustomers} served.`,
        ]),
        button("↻ Try again", () => this.restart(), { class: "primary" }),
      ]),
    ]);
  }
}
