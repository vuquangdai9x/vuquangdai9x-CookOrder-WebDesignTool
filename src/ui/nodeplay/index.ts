// Play mode on the node graph — the LEGACY page, driven by graph rules.
//
// The DOM is a 1-1 copy of ui/play/index.ts's three tiers: `.play-page`, the
// same `.play-toolbar`, `.customers-tier` with its fixed-column card grid,
// avatars, mystery lookahead card and `.chip.icon-chip.dish-chip` at 64px; the
// same `.middle-tier` with its `.middle-split` grid/tools panels, `.cell` /
// `.cell-main` / `.cell-badge` markup and `TOOL_COLORS` strip; and the same
// `.queues-tier` with `.queue-lane` / `.lane-head` / `.lane-tiles` and the
// windowed `.queue-tile` including its frozen, wanted, preview and hidden
// states. Every size and colour therefore comes from the legacy stylesheet.
//
// What differs is entirely underneath: this drives `NodeSimulation`, so a dish
// chip is a resolved SLOT rather than a cooked id, tool slots hold dense
// ingredient indices, and "wanted" is computed from the graph's terminal
// output instead of `resolveCookedId`.
//
// Scope, stated plainly: transfers resolve instantly here (`instantFlights`)
// rather than being animated cell-to-cell, and the booster bar, Save Me and the
// bot runner are not wired up. Those were on the plan's cut list; each is
// reachable through `NodeSimulation`'s already-compatible surface.

import { button, el } from "../dom.ts";
import {
  backpackIconEl,
  cellIconEl,
  cookedIconEl,
  dirtyIconEl,
  ingredientIconEl,
  statusIconEl,
  toolIconEl,
  customerTypeIconEl,
} from "../icon.ts";
import { localImageUrl } from "../localImages.ts";
import { CELL_COLOR_LOCK, CELL_INGREDIENT_SLOT, EFFECT_FREEZE, EFFECT_HOLDING_KEY } from "../../core/effects.ts";
import { KEY_COLORS } from "../../data/configLoader.ts";
import { NodeSimulation } from "../../core/nodeSim.ts";
import type { NodeCustomerState, NodeQueueCell } from "../../core/nodeSim.ts";
import { buildIndex } from "../../core/nodeIndex.ts";
import type { GraphIndex, ProcessStep } from "../../core/nodeIndex.ts";
import type { OutOfSlotPolicy, QueueGroupKind, QueueItem } from "../../core/types.ts";
import { nodeAsMapDef } from "../../data/nodeGraphToMapDef.ts";
import type { ProjectedMap } from "../../data/nodeGraphToMapDef.ts";
import { toNodeLevelConfig } from "../../data/nodeLevel.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import type { NodeProjectState } from "../../data/nodeProject.ts";
import { customersStructureKey, middleStructureKey, queuesStructureKey } from "./structureKey.ts";

/** Same per-tool tints the legacy tool strip uses, so the two read identically. */
const TOOL_COLORS = [
  "rgba(240, 164, 65, 0.16)",
  "rgba(107, 191, 89, 0.16)",
  "rgba(90, 167, 224, 0.16)",
  "rgba(224, 90, 90, 0.16)",
  "rgba(154, 139, 208, 0.16)",
];

const SPEEDS = [
  { id: "x1", label: "×1", factor: 1 },
  { id: "x2", label: "×2", factor: 2 },
  { id: "x3", label: "×3", factor: 3 },
  { id: "skip", label: "⏭ Skip", factor: 30 },
];

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
  private configGroupEl: HTMLElement | null = null;
  private foldBtn: HTMLElement | null = null;
  private timer: number | null = null;
  private speedId = "x1";
  private paused = false;
  private toolbarFolded = false;
  private customerAvatarByIndex = new Map<number, string>();

  // ---------- tier diffing ----------
  //
  // Each tier is rebuilt ONLY when its structure key changes, not on every
  // clock tick. TICK_MS is 100 — rebuilding all three tiers unconditionally
  // there means tearing down and recreating every tile, card and slot in the
  // page ten times a second, which is both the visible "play-page refreshes
  // intensively" symptom and a real hazard for clicking: a tile that receives
  // mousedown can be gone from the DOM by the time mouseup fires. Mirrors
  // ui/play/index.ts's syncPage()/structureKey.ts, scoped down for a view that
  // has no flight animation to hold a tier back for.
  private customersEl!: HTMLElement;
  private middleEl!: HTMLElement;
  private queuesEl!: HTMLElement;
  private customersKey = "";
  private middleKey = "";
  private queuesKey = "";
  private overlayEl: HTMLElement | null = null;
  /** Populated by customerCard(); patched every tick without touching the DOM tree. */
  private timerEls = new Map<number, HTMLElement>();
  private timerBarEls = new Map<number, HTMLElement>();
  /** Populated by toolsEl(); keyed "toolIndex:slotIndex". */
  private barEls = new Map<string, HTMLElement>();

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
    this.restart();
  }

  destroy(): void {
    this.stopClock();
  }

  private get windowRows(): number {
    return this.project.doc.map.visibleRows || 3;
  }

  private get speedFactor(): number {
    return SPEEDS.find((s) => s.id === this.speedId)?.factor ?? 1;
  }

  // ---------- lifecycle ----------

  private restart(): void {
    this.stopClock();
    if (!this.level) {
      this.root.replaceChildren(el("p", {}, ["This graph has no levels yet."]));
      return;
    }
    this.sim = new NodeSimulation(this.ix, toNodeLevelConfig(this.level));
    this.paused = false;
    this.mount();
    this.startClock();
  }

  /**
   * The legacy mount order, and it matters: the weather layer is appended
   * first (position:fixed, so it takes no layout space) and the TOOLBAR IS A
   * SIBLING of `.play-page`, not a child. `.play-page` has a fixed height with
   * three sized tiers, so a fourth child inside it would shrink the tiers
   * instead of sitting above them.
   */
  private mount(): void {
    this.page = el("div", { class: "play-page" });
    this.root.replaceChildren(this.weatherLayer(), this.toolbar(), this.page);
    this.fullRender();
  }

  /** Builds every tier from scratch and records their structure keys. Called once per mount/restart. */
  private fullRender(): void {
    this.timerEls.clear();
    this.timerBarEls.clear();
    this.barEls.clear();
    this.overlayEl = null;
    this.customersEl = this.customersTier();
    this.middleEl = this.middleTier();
    this.queuesEl = this.queuesTier();
    this.customersKey = customersStructureKey(this.sim);
    this.middleKey = middleStructureKey(this.sim);
    this.queuesKey = queuesStructureKey(this.sim);
    this.page.replaceChildren(this.customersEl, this.middleEl, this.queuesEl);
    this.syncOverlay();
    this.patchLiveValues();
  }

  /**
   * Full-viewport ambient background matching the level's weather. Pure CSS
   * keyframes (see style.css), so it costs nothing per frame.
   */
  private weatherLayer(): HTMLElement {
    const layer = el("div", { class: "weather-layer" });
    const weather = this.level.weather;
    if (weather === "Rainy" || weather === "Stormy") {
      layer.classList.add("weather-rain");
      const count = weather === "Stormy" ? 80 : 40;
      for (let i = 0; i < count; i++) {
        const drop = el("div", { class: "weather-drop" });
        drop.style.left = `${Math.random() * 100}%`;
        drop.style.animationDelay = `-${(Math.random() * 1).toFixed(2)}s`;
        drop.style.animationDuration = `${(0.5 + Math.random() * 0.4).toFixed(2)}s`;
        layer.append(drop);
      }
    } else if (weather === "Freeze") {
      layer.classList.add("weather-snow");
      for (let i = 0; i < 30; i++) {
        const flake = el("div", { class: "weather-flake" });
        flake.style.left = `${Math.random() * 100}%`;
        flake.style.animationDelay = `-${(Math.random() * 6).toFixed(2)}s`;
        flake.style.animationDuration = `${(4 + Math.random() * 3).toFixed(2)}s`;
        flake.style.opacity = `${(0.15 + Math.random() * 0.25).toFixed(2)}`;
        layer.append(flake);
      }
    } else if (weather === "Sunny") {
      layer.classList.add("weather-sun");
      for (let i = 0; i < 5; i++) {
        const ray = el("div", { class: "weather-ray" });
        ray.style.left = `${i * 22 - 10}%`;
        ray.style.animationDelay = `-${(i * 0.9).toFixed(2)}s`;
        layer.append(ray);
      }
    }
    return layer;
  }

  private startClock(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => {
      if (this.paused) return;
      if (this.sim.status !== "playing") {
        this.stopClock();
        this.syncPage();
        return;
      }
      this.sim.tick((TICK_MS / 1000) * this.speedFactor);
      this.syncPage();
    }, TICK_MS);
  }

  private stopClock(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- rendering ----------

  /**
   * Rebuilds only the tier(s) whose structure actually changed, then patches
   * the values that move every tick (timers, cook bars, the HUD) in place.
   * The toolbar and weather layer persist untouched, as before.
   */
  private syncPage(): void {
    const nextMiddle = middleStructureKey(this.sim);
    if (nextMiddle !== this.middleKey) {
      this.barEls.clear(); // only toolsEl() (part of the middle tier) populates this
      const next = this.middleTier();
      this.middleEl.replaceWith(next);
      this.middleEl = next;
      this.middleKey = nextMiddle;
    }

    const nextQueues = queuesStructureKey(this.sim);
    if (nextQueues !== this.queuesKey) {
      const next = this.queuesTier();
      this.queuesEl.replaceWith(next);
      this.queuesEl = next;
      this.queuesKey = nextQueues;
    }

    const nextCustomers = customersStructureKey(this.sim);
    if (nextCustomers !== this.customersKey) {
      this.timerEls.clear(); // only customerCard() populates these
      this.timerBarEls.clear();
      const next = this.customersTier();
      this.customersEl.replaceWith(next);
      this.customersEl = next;
      this.customersKey = nextCustomers;
    }

    this.syncOverlay();
    this.patchLiveValues();
  }

  private syncOverlay(): void {
    const shouldShow = this.sim.status !== "playing";
    if (shouldShow && !this.overlayEl) {
      this.overlayEl = this.overlay();
      this.page.append(this.overlayEl);
    } else if (!shouldShow && this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
  }

  /** Timers, cook progress and the HUD move every tick but never restructure. */
  private patchLiveValues(): void {
    this.refreshHud();
    for (const c of this.sim.active) {
      const badge = this.timerEls.get(c.index);
      if (badge) badge.textContent = this.timerText(c);
      const fill = this.timerBarEls.get(c.index);
      if (fill) {
        const total = c.config.waitTime || 1;
        fill.style.width = `${Math.max(0, Math.min(100, (c.timeLeft / total) * 100))}%`;
      }
    }
    for (const tool of this.sim.tools) {
      tool.slots.forEach((slot, i) => {
        const bar = this.barEls.get(`${tool.index}:${i}`);
        if (!bar) return;
        bar.style.width = slot.item
          ? `${Math.min(100, (slot.item.elapsed / slot.item.duration) * 100)}%`
          : "0%";
      });
    }
  }

  private timerText(c: NodeCustomerState): string {
    return c.timeLeft === Infinity ? "∞" : `${Math.max(0, c.timeLeft).toFixed(0)}s`;
  }

  private refreshHud(): void {
    const hud = this.root.querySelector("#play-hud");
    if (!hud) return;
    hud.replaceChildren(
      el("span", {}, [`⏱ ${this.sim.time.toFixed(1)}s`]),
      el("span", {}, [`🧾 ${this.sim.servedCount}/${this.sim.totalCustomers}`]),
      el("span", {}, [`📦 ${this.sim.remainingItems}`]),
      ...(this.sim.issues.length
        ? [el("span", { class: "play-stat warn", title: this.sim.issues.join("\n") }, [
            `⚠ ${this.sim.issues.length}`,
          ])]
        : []),
    );
  }

  private toolbar(): HTMLElement {
    const picker = el("select", { class: "level-picker" }) as HTMLSelectElement;
    for (const l of this.project.levels) {
      const opt = el("option", { value: String(l.id) }, [
        `${l.name}${l.levelTag ? ` (${l.levelTag})` : ""} — ${
          toNodeLevelConfig(l).customers.length
        } customers`,
      ]);
      if (l.id === this.level.id) (opt as HTMLOptionElement).selected = true;
      picker.append(opt);
    }
    picker.addEventListener("change", () => this.onSelectLevel(Number(picker.value)));

    // One radio-style group: picking any option deselects the others.
    const speedBar = el("div", { class: "speed-bar", role: "radiogroup" });
    for (const option of SPEEDS) {
      speedBar.append(
        button(option.label, () => {
          this.speedId = option.id;
          this.paused = false;
          this.refreshToolbar();
        }, {
          class: this.speedId === option.id ? "active" : "",
          "data-speed": option.id,
          role: "radio",
          title: `Run at ${option.label} speed`,
        }),
      );
    }

    const policy = el("select", { class: "policy-picker" }) as HTMLSelectElement;
    for (const [value, label] of [
      ["block-pick", "Block the pick"],
      ["park-on-grid", "Park raw on the grid"],
    ] as const) {
      const opt = el("option", { value }, [label]);
      if ((this.level.outOfSlotPolicy ?? "block-pick") === value) (opt as HTMLOptionElement).selected = true;
      policy.append(opt);
    }
    policy.addEventListener("change", () => {
      this.sim.setOutOfSlotPolicy(policy.value as OutOfSlotPolicy);
      this.level.outOfSlotPolicy = policy.value as OutOfSlotPolicy;
      this.syncPage();
    });

    // Map/level/speed/policy are "config" and fold away; the HUD is live game
    // state, not config, so it stays visible either way.
    this.configGroupEl = el("div", { class: "toolbar-config" }, [
      el("label", { class: "field small" }, ["Level", picker]),
      speedBar,
      button(this.paused ? "▶ Resume" : "⏸ Pause", () => {
        this.paused = !this.paused;
        this.refreshToolbar();
      }, { id: "btn-pause" }),
      button("⟲ Restart", () => this.restart()),
      el("label", { class: "field small" }, ["When tool is full", policy]),
    ]);

    this.foldBtn = button(this.toolbarFolded ? "▸ Config" : "▾ Config", () => {
      this.toolbarFolded = !this.toolbarFolded;
      this.applyFoldState();
    }, { class: "fold-toggle", title: "Show/hide level, speed and tool-full settings" });

    const bar = el("div", { class: "play-toolbar" }, [
      this.foldBtn,
      this.configGroupEl,
      el("span", { class: "spacer" }),
      el("div", { class: "hud", id: "play-hud" }),
    ]);
    this.applyFoldState();
    return bar;
  }

  private applyFoldState(): void {
    if (this.configGroupEl) this.configGroupEl.style.display = this.toolbarFolded ? "none" : "";
    if (this.foldBtn) this.foldBtn.textContent = this.toolbarFolded ? "▸ Config" : "▾ Config";
  }

  /** Rebuilds just the toolbar in place, leaving the tiers untouched. */
  private refreshToolbar(): void {
    const existing = this.root.querySelector(".play-toolbar");
    if (existing) existing.replaceWith(this.toolbar());
    this.refreshHud();
  }

  private customersTier(): HTMLElement {
    const sim = this.sim;
    const row = el("div", { class: "customer-cards play" });
    for (const c of sim.active) row.append(this.customerCard(c, true));
    const next = sim.pending[0];
    if (next) row.append(this.mysteryCard(next));
    const count = sim.active.length + (next ? 1 : 0);
    row.style.gridTemplateColumns = `repeat(${Math.max(1, count)}, 1fr)`;
    return el("section", { class: "play-section customers-tier" }, [
      el("h2", {}, [`Customers — ${sim.level.serveableSlots} serve slot(s)`]),
      row,
    ]);
  }

  private customerCard(c: NodeCustomerState, servable: boolean): HTMLElement {
    const card = el("div", {
      class: `customer-card${servable ? " servable" : " waiting"}${c.isStaff ? " staff" : ""}`,
      "data-customer": String(c.index),
    });
    this.appendAvatar(card, c.index);
    if (servable && !c.isStaff && c.timeLeft !== Infinity) {
      const fill = el("div", { class: "wait-progress-fill" });
      const total = c.config.waitTime || 1;
      fill.style.width = `${Math.max(0, Math.min(100, (c.timeLeft / total) * 100))}%`;
      card.append(el("div", { class: "wait-progress" }, [fill]));
      this.timerBarEls.set(c.index, fill);
    }

    const badge = el("span", { class: "wait-badge" }, [this.timerText(c)]);
    if (servable) this.timerEls.set(c.index, badge);

    const content = el("div", { class: "customer-content" });
    content.append(
      el("div", { class: "customer-head" }, [
        c.isStaff
          ? el("span", { class: "cust-index" }, [customerTypeIconEl(c.config.typeId, 48)])
          : el("span", { class: "cust-index" }, [`#${c.index + 1}`]),
        badge,
      ]),
    );

    if (c.isStaff) {
      content.append(el("div", { class: "staff-note" }, ["Clears dirty stacks"]));
      card.append(content);
      return card;
    }

    // A FLAT chip list, exactly as legacy: filled first, then still-wanted.
    // Slot structure is the designer's concern; the player is reading "what do
    // I still owe this customer".
    for (const dish of c.dishes) {
      const row = el("div", { class: "dish-row" });
      const chip = (slotIndex: number, filled: boolean) => {
        const ing = dish.order.slots[slotIndex].ing;
        const dataId = this.projected.dataIdOf.get(ing);
        const gated = !filled && !dish.gateOpen(slotIndex);
        return el("span", {
          class: `chip icon-chip dish-chip${filled ? " filled" : ""}${gated ? " gated" : ""}`,
          "data-dish-ingredient": String(dataId ?? -1),
          title: `${this.ix.ingName[ing]}${gated ? " — waiting for the base" : ""}`,
        }, [dataId === undefined ? el("span", { class: "icon" }, ["❔"]) : cookedIconEl(dataId, 64)]);
      };
      dish.order.slots.forEach((_, i) => {
        if (dish.filled[i]) row.append(chip(i, true));
      });
      dish.order.slots.forEach((_, i) => {
        if (!dish.filled[i]) row.append(chip(i, false));
      });
      content.append(row);
    }
    card.append(content);
    return card;
  }

  private mysteryCard(c: NodeCustomerState): HTMLElement {
    const card = el("div", {
      class: "customer-card mystery",
      "data-customer": String(c.index),
      title: "Next in line — their order is revealed when a serve slot frees up",
    });
    this.appendAvatar(card, c.index);
    card.append(
      el("div", { class: "customer-content" }, [
        el("div", { class: "customer-head" }, [
          el("span", { class: "cust-index" }, [`#${c.index + 1}`]),
        ]),
        el("div", { class: "mystery-mark" }, ["?"]),
      ]),
    );
    return card;
  }

  private appendAvatar(card: HTMLElement, index: number): void {
    const avatars = this.projected.map.customerAvatars;
    if (avatars.length === 0) return;
    let path = this.customerAvatarByIndex.get(index);
    if (!path) {
      path = avatars[Math.floor(Math.random() * avatars.length)];
      this.customerAvatarByIndex.set(index, path);
    }
    const url = localImageUrl(path);
    if (!url) return;
    card.append(el("img", { src: url, alt: "", class: "customer-avatar" }));
  }

  private middleTier(): HTMLElement {
    const map = this.project.doc.map;
    return el("section", { class: "play-section middle-tier" }, [
      el("div", { class: "middle-split" }, [
        el("div", { class: "middle-left" }, [
          el("h2", {}, [`Grid ${map.gridWidth}×${map.gridHeight}`]),
          this.gridEl(),
        ]),
        el("div", { class: "middle-right" }, [
          el("h2", {}, [`Cooking tools (${this.sim.cookingCount} busy)`]),
          this.toolsEl(),
        ]),
      ]),
    ]);
  }

  private gridEl(): HTMLElement {
    const sim = this.sim;
    const grid = el("div", { class: "grid" });
    grid.style.gridTemplateColumns = `repeat(${this.project.doc.map.gridWidth}, 1fr)`;

    for (let i = 0; i < sim.grid.length; i++) {
      const content = sim.grid[i];
      const lock = sim.cellLockLabel(i);
      const typeEffect = sim.level.grid[i]?.effects[0];
      const cell = el("div", { class: `cell${lock ? " locked" : ""}`, "data-cell": String(i) });

      if (lock && typeEffect) {
        if (typeEffect.effectId === CELL_INGREDIENT_SLOT) {
          cell.append(
            el("span", { class: "cell-corner" }, [cellIconEl(typeEffect.effectId, 48)]),
            el("span", { class: "cell-main" }, [ingredientIconEl(typeEffect.params[0] ?? 0, 96)]),
          );
        } else if (typeEffect.effectId === CELL_COLOR_LOCK) {
          const swatch = el("span", { class: "cell-swatch" }, [cellIconEl(typeEffect.effectId, 64)]);
          swatch.style.background = KEY_COLORS[typeEffect.params[0] ?? 0]?.hex ?? "transparent";
          cell.append(swatch);
        } else {
          cell.append(el("span", { class: "cell-main" }, [cellIconEl(typeEffect.effectId, 64)]));
        }
        cell.append(el("small", { class: "cell-badge" }, [lock]));
      } else if (content.kind === "cooked") {
        const dataId = this.projected.dataIdOf.get(content.ing);
        cell.append(el("span", { class: "cell-main" }, [
          dataId === undefined ? el("span", { class: "icon" }, ["❔"]) : cookedIconEl(dataId, 96),
        ]));
        if (content.usesLeft && content.usesLeft > 1) {
          cell.append(el("small", { class: "cell-badge uses-left" }, [`×${content.usesLeft}`]));
        }
      } else if (content.kind === "raw") {
        const dataId = this.projected.dataIdOf.get(content.ing);
        cell.append(
          el("span", { class: "cell-main parked" }, [
            dataId === undefined ? el("span", { class: "icon" }, ["❔"]) : ingredientIconEl(dataId, 96),
          ]),
          el("small", { class: "cell-badge" }, ["waiting"]),
        );
      } else if (content.kind === "dirty") {
        cell.append(
          el("span", { class: "cell-main dirty" }, [dirtyIconEl(content.dirtyId, 96)]),
          el("span", { class: "cell-badge" }, [`×${content.count}`]),
        );
      } else if (content.kind === "backpack") {
        cell.append(
          el("span", { class: "cell-main backpack" }, [backpackIconEl(96)]),
          el("small", { class: "cell-badge" }, [`×${content.items.length}`]),
        );
      }
      grid.append(cell);
    }
    return grid;
  }

  /** Dense ingredient indices this level's queues actually contain. */
  private usedIngredients(): Set<number> {
    const ids = new Set<number>();
    for (const col of this.sim.queueGrid) {
      for (const cell of col) if (cell && cell.ing >= 0) ids.add(cell.ing);
    }
    return ids;
  }

  private toolsEl(): HTMLElement {
    const wrap = el("div", { class: "tools" });
    if (this.sim.tools.length === 0) {
      wrap.append(el("small", { class: "muted" }, ["This map defines no cooking tools."]));
      return wrap;
    }
    const used = this.usedIngredients();
    this.sim.tools.forEach((tool, toolIndex) => {
      // A tool is "unused" when nothing this level queues ever reaches it —
      // read off the graph's recipeForInput rather than a recipe id scan.
      const unused = ![...used].some((ing) => {
        // Follow the whole chain, not one hop: the fryer is used by a level
        // that only queues raw chicken, because that is where the chain ends.
        let current = ing;
        const seen = new Set<number>();
        while (!seen.has(current)) {
          seen.add(current);
          const step: ProcessStep | null = this.ix.recipeForInput[current];
          if (!step) return false;
          if (step.tool === tool.index || step.chainTools.includes(tool.index)) return true;
          current = step.out;
        }
        return false;
      });

      const slots = el("div", { class: "tool-slots" });
      tool.slots.forEach((slot, i) => {
        const bar = el("div", { class: "bar" });
        if (slot.item) {
          bar.style.width = `${Math.min(100, (slot.item.elapsed / slot.item.duration) * 100)}%`;
        }
        this.barEls.set(`${tool.index}:${i}`, bar);
        const node = el("div", {
          class: `tool-slot${slot.item ? " busy" : ""}`,
          "data-slot": `${tool.index}:${i}`,
        });
        if (slot.item) {
          const dataId = this.projected.dataIdOf.get(slot.item.ing);
          node.append(el("span", { class: "slot-item" }, [
            dataId === undefined ? el("span", { class: "icon" }, ["❔"]) : ingredientIconEl(dataId, 96),
          ]));
        }
        node.append(el("div", { class: "bar-track" }, [bar]));
        slots.append(node);
      });

      const def = this.projected.map.tools.find((t) => t.name === tool.displayName);
      const toolEl = el("div", {
        class: `tool${unused ? " unused" : ""}`,
        title:
          `${tool.displayName} — ${tool.numSlots} slot(s)` +
          (unused ? " — no ingredient in this level needs it" : ""),
      }, [
        el("div", { class: "tool-head" }, [
          def ? toolIconEl(def, 64) : el("span", { class: "icon" }, ["🍳"]),
          el("span", { class: "tool-name" }, [tool.displayName]),
        ]),
        slots,
      ]);
      toolEl.style.flexGrow = String(Math.max(1, tool.numSlots));
      toolEl.style.background = TOOL_COLORS[toolIndex % TOOL_COLORS.length];
      wrap.append(toolEl);
    });
    return wrap;
  }

  private queuesTier(): HTMLElement {
    const sim = this.sim;
    const needed = sim.neededIngredients();

    const lanes = el("div", { class: "queue-lanes play" });
    lanes.style.setProperty("--window-rows", String(this.windowRows));

    for (let x = 0; x < sim.columnCount; x++) {
      if (sim.remainingIn(x) === 0) continue;
      const check = sim.canPick(x);
      const lane = el("div", { class: "queue-lane", "data-lane": String(x) }, [
        el("div", { class: "lane-head" }, [
          el("span", {}, [`Queue ${x + 1}`]),
          el("small", {}, [`${sim.remainingIn(x)}`]),
        ]),
      ]);
      const tiles = el("div", { class: "lane-tiles" });

      for (let y = 0; y < this.windowRows; y++) {
        const cell: NodeQueueCell | null = sim.queueGrid[x]?.[y] ?? null;
        if (!cell) {
          tiles.append(el("div", { class: "queue-tile empty" }));
          continue;
        }
        const isTop = y === 0;
        const hidden = sim.isHidden(x, y);
        const groupKind: QueueGroupKind | undefined =
          cell.group !== -1 ? sim.groupKinds[cell.group] : undefined;
        // "Wanted" via the graph's whole chain, not one hop — a raw chicken
        // breast is wanted when a customer needs the FRIED piece.
        const wanted =
          !hidden && cell.ing >= 0 && needed.has(this.ix.terminalOutput[cell.ing]);
        const tile = this.queueTile(cell, {
          top: isTop,
          preview: !isTop,
          wanted,
          disabled: isTop && !check.ok,
          group: groupKind,
          hidden,
        });
        tile.dataset.qx = String(x);
        tile.dataset.qy = String(y);
        if (isTop) {
          tile.title = check.reason ?? "Pick this ingredient";
          if (check.ok) {
            tile.addEventListener("click", () => {
              if (sim.pick(x)) this.syncPage();
            });
          }
        }
        tiles.append(tile);
      }
      lane.append(tiles);
      lanes.append(lane);
    }

    return el("section", { class: "play-section queues-tier" }, [
      el("h2", {}, ["Ingredient queues — click the top tile to pick"]),
      lanes,
    ]);
  }

  private queueTile(
    cell: NodeQueueCell,
    opts: {
      top?: boolean;
      preview?: boolean;
      wanted?: boolean;
      disabled?: boolean;
      group?: QueueGroupKind;
      hidden?: boolean;
    },
  ): HTMLElement {
    const item: QueueItem = cell.item;
    const freezeRemaining = this.sim.freezeCount(item);
    const frozen = freezeRemaining > 0;
    const key = item.effects.find((e) => e.effectId === EFFECT_HOLDING_KEY);
    const tile = el("div", {
      class: [
        "queue-tile",
        opts.top ? "top" : "",
        opts.preview ? "preview" : "",
        opts.wanted ? "wanted" : "",
        opts.disabled ? "disabled" : "",
        frozen ? "frozen" : "",
        item.kind === "sweeper" ? "sweeper" : "",
        opts.group ? `group-${opts.group}` : "",
        opts.hidden ? "hidden-slot" : "",
      ]
        .filter(Boolean)
        .join(" "),
    });

    // The mask is checked FIRST: a hidden sweeper must read as "?" like any
    // other hidden slot, or its broom gives the slot away.
    const dataId = cell.ing >= 0 ? this.projected.dataIdOf.get(cell.ing) : undefined;
    tile.append(
      opts.hidden
        ? el("span", { class: "tile-main" }, [el("span", { class: "hidden-mark" }, ["?"])])
        : item.kind === "sweeper"
          ? el("span", { class: "tile-main" }, ["🧹"])
          : el("span", { class: "tile-main" }, [
              dataId === undefined ? el("span", { class: "icon" }, ["❔"]) : ingredientIconEl(dataId, 96),
            ]),
    );
    if (frozen) {
      tile.append(
        el("span", { class: "tile-corner" }, [statusIconEl(EFFECT_FREEZE, 48)]),
        el("span", { class: "tile-freeze-count" }, [String(freezeRemaining)]),
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
    return el("div", { class: `play-overlay ${won ? "won" : "lost"}` }, [
      el("div", { class: "overlay-panel" }, [
        el("h2", {}, [won ? "🎉 Level complete" : "💥 Level failed"]),
        el("p", {}, [
          won
            ? `All ${sim.totalCustomers} customers served in ${sim.time.toFixed(1)}s.`
            : `${sim.loseReason ?? "unknown"} — ${sim.servedCount}/${sim.totalCustomers} served.`,
        ]),
        button("⟲ Try again", () => this.restart(), { class: "primary" }),
      ]),
    ]);
  }
}
