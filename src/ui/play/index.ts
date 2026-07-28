// Play mode. Mirrors the Design page's three tiers — Customers on top, Grid in
// the middle, Ingredient queues on the bottom — with the middle tier being one
// panel split left/right: grid left, Preparing/Cooking right, so the cook →
// grid hand-off reads as a single flow. See docs/ToolDesign.md "Play Mode".

import {
  CELL_COLOR_LOCK,
  CELL_INGREDIENT_SLOT,
  EFFECT_FREEZE,
  EFFECT_HOLDING_KEY,
} from "../../core/effects.ts";
import { Simulation } from "../../core/sim.ts";
import type { CustomerState } from "../../core/sim.ts";
import type { LevelConfig, MapDef, QueueItem } from "../../core/types.ts";
import { KEY_COLORS } from "../../data/initialData.ts";
import { button, clear, el } from "../dom.ts";
import { cellIconEl, ingredientIconEl, statusIconEl } from "../icon.ts";
import { playStructureKey } from "./structureKey.ts";

const SPEEDS = [1, 2, 3] as const;

export class PlayView {
  private root: HTMLElement;
  private map: MapDef;
  private level: LevelConfig;
  private sim: Simulation;
  private speed = 1;
  private paused = false;
  private rafId = 0;
  private lastFrame = 0;
  private page!: HTMLElement;
  private onSelectLevel: (levelId: number) => void;
  /**
   * The DOM is rebuilt only when this signature changes. Rebuilding every frame
   * would destroy a tile between its mousedown and mouseup, making it
   * impossible to actually click one.
   */
  private structureKey = "";
  /** Live values patched in place each frame, keyed by customer index / pipeline uid. */
  private timerEls = new Map<number, HTMLElement>();
  private barEls = new Map<number, HTMLElement>();

  constructor(
    root: HTMLElement,
    map: MapDef,
    level: LevelConfig,
    onSelectLevel: (levelId: number) => void,
  ) {
    this.root = root;
    this.map = map;
    this.level = level;
    this.onSelectLevel = onSelectLevel;
    this.sim = new Simulation(map, level);
    this.mount();
    this.start();
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
  }

  // ---------- lifecycle ----------

  private start(): void {
    this.lastFrame = performance.now();
    const frame = (now: number) => {
      const dt = Math.min((now - this.lastFrame) / 1000, 0.25);
      this.lastFrame = now;
      if (!this.paused && this.sim.status === "playing") this.sim.tick(dt * this.speed);
      this.syncPage();
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  private restart(): void {
    this.sim = new Simulation(this.map, this.level);
    this.paused = false;
    this.renderPage();
  }

  /** Resolve everything currently cooking, then hand control back to the player. */
  private skip(): void {
    this.sim.fastForward();
    this.renderPage();
  }

  // ---------- layout ----------

  private mount(): void {
    clear(this.root);
    this.page = el("div", { class: "play-page" });
    this.root.append(this.toolbar(), this.page);
    this.renderPage();
  }

  private toolbar(): HTMLElement {
    const picker = el("select", { class: "level-picker" }) as HTMLSelectElement;
    for (const l of this.map.levels) {
      const opt = el("option", { value: String(l.id) }, [
        `${l.name}${l.levelTag ? ` (${l.levelTag})` : ""} — ${l.customers.length} customers`,
      ]);
      if (l.id === this.level.id) (opt as HTMLOptionElement).selected = true;
      picker.append(opt);
    }
    picker.addEventListener("change", () => this.onSelectLevel(Number(picker.value)));

    const speedBar = el("div", { class: "speed-bar" });
    const refresh = () => {
      [...speedBar.querySelectorAll("button")].forEach((b, i) => {
        if (i < SPEEDS.length) b.classList.toggle("active", this.speed === SPEEDS[i]);
      });
      const pause = speedBar.querySelector<HTMLButtonElement>("#btn-pause");
      if (pause) pause.textContent = this.paused ? "▶ Resume" : "⏸ Pause";
    };
    for (const s of SPEEDS) {
      speedBar.append(
        button(`×${s}`, () => {
          this.speed = s;
          this.paused = false;
          refresh();
        }, { class: this.speed === s ? "active" : "" }),
      );
    }
    speedBar.append(
      button("⏭ Skip", () => this.skip(), { title: "Finish what is cooking" }),
      button("⏸ Pause", () => {
        this.paused = !this.paused;
        refresh();
      }, { id: "btn-pause" }),
      button("⟲ Restart", () => this.restart()),
    );

    return el("div", { class: "play-toolbar" }, [
      el("label", { class: "field small" }, ["Level", picker]),
      speedBar,
      el("span", { class: "spacer" }),
      this.hud(),
    ]);
  }

  private hud(): HTMLElement {
    return el("div", { class: "hud", id: "play-hud" });
  }

  private renderHud(): void {
    const sim = this.sim;
    const hud = this.root.querySelector<HTMLElement>("#play-hud");
    if (!hud) return;
    const keys = Object.entries(sim.effectContext.keysByColor).filter(([, n]) => n > 0);
    hud.replaceChildren(
      el("span", {}, [`⏱ ${sim.time.toFixed(1)}s`]),
      el("span", {}, [`🍽 ${sim.servedCount}/${sim.totalCustomers}`]),
      el("span", {}, [`🔪 ${sim.effectContext.picksMade}`]),
      el("span", {}, [`🌤 ${this.level.weather}`]),
      ...keys.map(([color, n]) => {
        const chip = el("span", { class: "hud-key" }, [`×${n}`]);
        chip.style.borderColor = KEY_COLORS[Number(color)]?.hex ?? "";
        chip.title = `${KEY_COLORS[Number(color)]?.name ?? color} keys`;
        return chip;
      }),
    );
  }

  // ---------- page ----------

  /**
   * Rebuilds the page only when the structure changed; otherwise just patches
   * the values that move continuously. Keeping element identity stable between
   * structural changes is what makes tiles clickable while the sim runs.
   */
  private syncPage(): void {
    const key = this.currentStructureKey();
    if (key === this.structureKey) {
      this.patchLiveValues();
      return;
    }
    this.structureKey = key;
    this.renderPage();
  }

  private renderPage(): void {
    this.structureKey = this.currentStructureKey();
    this.timerEls.clear();
    this.barEls.clear();
    clear(this.page);
    this.page.append(this.customersTier(), this.middleTier(), this.queuesTier());
    if (this.sim.status !== "playing") this.page.append(this.overlay());
    this.patchLiveValues();
  }

  private currentStructureKey(): string {
    return playStructureKey(this.sim);
  }

  /** Timers, progress bars and the HUD change every frame but never restructure. */
  private patchLiveValues(): void {
    this.renderHud();
    for (const c of this.sim.active) {
      const node = this.timerEls.get(c.index);
      if (node) node.textContent = this.timerText(c);
    }
    for (const item of this.sim.pipeline) {
      const bar = this.barEls.get(item.uid);
      if (!bar) continue;
      const total = item.stage === "prepare" ? item.prepareTime : item.cookTime;
      const pct = total > 0 ? Math.min(100, (item.elapsed / total) * 100) : 100;
      bar.style.width = `${pct}%`;
    }
  }

  private timerText(c: CustomerState): string {
    return c.timeLeft === Infinity
      ? "∞"
      : `${Math.max(0, c.timeLeft).toFixed(0)}s${c.config.weatherEff ? " 🌧" : ""}`;
  }

  /** Top tier: active (serveable) customers, then a preview of who's next. */
  private customersTier(): HTMLElement {
    const sim = this.sim;
    const row = el("div", { class: "customer-cards" });
    for (const c of sim.active) row.append(this.customerCard(c, true));
    for (const c of sim.pending.slice(0, 4)) row.append(this.customerCard(c, false));
    return el("section", { class: "play-section" }, [
      el("h2", {}, [`Customers — ${sim.level.serveableSlots} serve slot(s)`]),
      row,
    ]);
  }

  private customerCard(c: CustomerState, activeSlot: boolean): HTMLElement {
    const card = el("div", {
      class: `customer-card${activeSlot ? " active" : " waiting"}${c.isStaff ? " staff" : ""}`,
    });
    const timer = el("span", { class: "wait-badge" }, [this.timerText(c)]);
    if (activeSlot) this.timerEls.set(c.index, timer);
    card.append(
      el("div", { class: "customer-head" }, [
        el("span", { class: "cust-index" }, [c.isStaff ? "🧑‍🍳" : `#${c.index + 1}`]),
        timer,
      ]),
    );
    if (c.isStaff) {
      card.append(el("div", { class: "staff-note" }, ["Clears dirty stacks"]));
      return card;
    }
    for (const dish of c.dishes) {
      const row = el("div", { class: "dish-row" });
      for (const id of dish.filled) {
        row.append(el("span", { class: "chip icon-chip filled" }, [ingredientIconEl(id, 64)]));
      }
      for (const id of dish.remaining) {
        row.append(el("span", { class: "chip icon-chip" }, [ingredientIconEl(id, 64)]));
      }
      card.append(row);
    }
    return card;
  }

  /** Middle tier: one panel, grid left + Preparing/Cooking right. */
  private middleTier(): HTMLElement {
    return el("section", { class: "play-section middle-tier" }, [
      el("div", { class: "middle-split" }, [
        el("div", { class: "middle-left" }, [
          el("h2", {}, [`Grid ${this.level.gridWidth}×${this.level.gridHeight}`]),
          this.gridEl(),
        ]),
        el("div", { class: "middle-right" }, [
          el("h2", {}, [`Preparing / Cooking (${this.sim.pipeline.length})`]),
          this.pipelineEl(),
        ]),
      ]),
    ]);
  }

  private gridEl(): HTMLElement {
    const sim = this.sim;
    const grid = el("div", { class: "grid" });
    grid.style.gridTemplateColumns = `repeat(${sim.level.gridWidth}, 1fr)`;

    for (let i = 0; i < sim.grid.length; i++) {
      const content = sim.grid[i];
      const lock = sim.cellLockLabel(i);
      const config = sim.level.grid[i];
      const typeEffect = config?.effects[0];
      const cell = el("div", { class: `cell${lock ? " locked" : ""}` });

      if (lock && typeEffect) {
        // Locked cells keep showing what they are waiting for.
        if (typeEffect.effectId === CELL_INGREDIENT_SLOT) {
          cell.append(
            el("span", { class: "cell-corner" }, [cellIconEl(typeEffect.effectId, 48)]),
            el("span", { class: "cell-main" }, [ingredientIconEl(typeEffect.params[0] ?? 0, 96)]),
          );
        } else if (typeEffect.effectId === CELL_COLOR_LOCK) {
          const swatch = el("span", { class: "cell-swatch" }, [
            cellIconEl(typeEffect.effectId, 64),
          ]);
          swatch.style.background = KEY_COLORS[typeEffect.params[0] ?? 0]?.hex ?? "transparent";
          cell.append(swatch);
        } else {
          cell.append(el("span", { class: "cell-main" }, [cellIconEl(typeEffect.effectId, 64)]));
        }
        cell.append(el("small", { class: "cell-badge" }, [lock]));
      } else if (content.kind === "cooked") {
        cell.append(el("span", { class: "cell-main" }, [ingredientIconEl(content.cookedId, 96)]));
      } else if (content.kind === "dirty") {
        cell.append(
          el("span", { class: "cell-main dirty" }, ["🍽"]),
          el("span", { class: "cell-badge" }, [`×${content.count}`]),
        );
      }
      grid.append(cell);
    }
    return grid;
  }

  private pipelineEl(): HTMLElement {
    const items = this.sim.pipeline.map((item) => {
      const total = item.stage === "prepare" ? item.prepareTime : item.cookTime;
      const pct = total > 0 ? Math.min(100, (item.elapsed / total) * 100) : 100;
      const def = this.map.rawIngredients.find((r) => r.id === item.rawId);
      const bar = el("div", { class: "bar" });
      bar.style.width = `${pct}%`;
      this.barEls.set(item.uid, bar);
      return el("div", { class: "pipe-item" }, [
        ingredientIconEl(item.rawId, 64),
        el("span", { class: "pipe-name" }, [def?.name ?? String(item.rawId)]),
        el("small", { class: "pipe-stage" }, [item.stage]),
        el("div", { class: "bar-track" }, [bar]),
      ]);
    });
    return el(
      "div",
      { class: "pipeline" },
      items.length ? items : [el("small", { class: "muted" }, ["Nothing cooking"])],
    );
  }

  /** Bottom tier: the same lane look as Design mode; top tile is the pick button. */
  private queuesTier(): HTMLElement {
    const sim = this.sim;
    const needed = sim.neededCookedIds();
    const cookedToRaw = new Map(
      this.map.cookMappings.flatMap((m) => m.cookedIds.map((c) => [c, m.rawId] as const)),
    );
    const wantedRaw = new Set([...needed].map((c) => cookedToRaw.get(c)));

    const lanes = el("div", { class: "queue-lanes play" });
    sim.queues.forEach((queue, qi) => {
      const check = sim.canPick(qi);
      const lane = el("div", { class: "queue-lane" }, [
        el("div", { class: "lane-head" }, [
          el("span", {}, [`Queue ${qi + 1}`]),
          el("small", {}, [`${queue.length}`]),
        ]),
      ]);
      const tiles = el("div", { class: "lane-tiles" });

      const top = queue[0];
      if (top) {
        const tile = this.queueTile(top, {
          top: true,
          wanted: wantedRaw.has(top.id),
          disabled: !check.ok,
        });
        tile.title = check.reason ?? "Pick this ingredient";
        if (check.ok) {
          tile.addEventListener("click", () => {
            this.sim.pick(qi);
            this.renderPage();
          });
        }
        tiles.append(tile);
      } else {
        tiles.append(el("div", { class: "queue-tile empty" }, ["—"]));
      }
      // Two look-ahead previews, per the GDD.
      for (const item of queue.slice(1, 3)) {
        tiles.append(this.queueTile(item, { preview: true }));
      }
      lane.append(tiles);
      lanes.append(lane);
    });

    return el("section", { class: "play-section" }, [
      el("h2", {}, ["Ingredient queues — click the top tile to pick"]),
      lanes,
    ]);
  }

  private queueTile(
    item: QueueItem,
    opts: { top?: boolean; wanted?: boolean; disabled?: boolean; preview?: boolean },
  ): HTMLElement {
    const freeze = item.effects.find((e) => e.effectId === EFFECT_FREEZE);
    const key = item.effects.find((e) => e.effectId === EFFECT_HOLDING_KEY);
    const tile = el("div", {
      class: [
        "queue-tile",
        opts.top ? "top" : "",
        opts.preview ? "preview" : "",
        opts.wanted ? "wanted" : "",
        opts.disabled ? "disabled" : "",
        freeze ? "frozen" : "",
        item.kind === "sweeper" ? "sweeper" : "",
      ]
        .filter(Boolean)
        .join(" "),
    });
    tile.append(
      item.kind === "sweeper"
        ? el("span", { class: "tile-main" }, ["🧹"])
        : el("span", { class: "tile-main" }, [ingredientIconEl(item.id, 96)]),
    );
    if (freeze) {
      tile.append(
        el("span", { class: "tile-corner" }, [
          statusIconEl(EFFECT_FREEZE, 48),
          el("small", {}, [String(freeze.params[0] ?? "")]),
        ]),
      );
    }
    if (key) {
      const badge = el("span", { class: "tile-key" }, [statusIconEl(EFFECT_HOLDING_KEY, 48)]);
      badge.style.background = KEY_COLORS[key.params[0] ?? 0]?.hex ?? "transparent";
      tile.append(badge);
    }
    return tile;
  }

  private overlay(): HTMLElement {
    const sim = this.sim;
    const won = sim.status === "won";
    return el("div", { class: `overlay ${won ? "won" : "lost"}` }, [
      el("h2", {}, [won ? "🎉 Level complete" : "💥 Level failed"]),
      el("p", {}, [sim.events.at(-1)?.message ?? ""]),
      el("p", { class: "sub" }, [
        `Served ${sim.servedCount}/${sim.totalCustomers} · ${sim.time.toFixed(1)}s`,
      ]),
      button("⟲ Restart", () => this.restart(), { class: "primary" }),
    ]);
  }
}
