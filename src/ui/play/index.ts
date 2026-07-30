// Play mode. Mirrors the Design page's three tiers — Customers on top, Grid in
// the middle, Ingredient queues on the bottom — with the middle tier being one
// panel split left/right: grid left, cooking tools right, so the cook → grid
// hand-off reads as a single flow. See docs/ToolDesign.md "Play Mode".
//
// Every hand-off the sim reports as a "flight" is animated here; the sim only
// applies it once the animation lands, so cooking starts when an ingredient
// actually arrives in the slot and matching runs when an item reaches the grid.

import {
  CELL_COLOR_LOCK,
  CELL_INGREDIENT_SLOT,
  EFFECT_FREEZE,
  EFFECT_HOLDING_KEY,
} from "../../core/effects.ts";
import { DIRTY_DISH_ID, Simulation } from "../../core/sim.ts";
import type { CustomerState, Flight } from "../../core/sim.ts";
import type {
  LevelConfig,
  MapDef,
  OutOfSlotPolicy,
  QueueItem,
} from "../../core/types.ts";
import { findToolRecipe } from "../../core/types.ts";
import { KEY_COLORS } from "../../data/configLoader.ts";
import { button, clear, el } from "../dom.ts";
import {
  cellIconEl,
  cookedIconEl,
  customerTypeIconEl,
  ingredientIconEl,
  statusIconEl,
  toolIconEl,
} from "../icon.ts";
import { centerOf, EffectsLayer } from "./effectsLayer.ts";
import type { Point } from "./effectsLayer.ts";
import { customersStructureKey, middleStructureKey, queuesStructureKey } from "./structureKey.ts";

/** ×1/×2/×3 and Skip are one option group; Skip resolves everything instantly. */
const SPEED_OPTIONS = [
  { id: "x1", label: "×1", rate: 1 },
  { id: "x2", label: "×2", rate: 2 },
  { id: "x3", label: "×3", rate: 3 },
  { id: "skip", label: "⏭ Skip", rate: 0 },
] as const;

type SpeedId = (typeof SPEED_OPTIONS)[number]["id"];

/** Cycled by position so adjacent tools always read as visually distinct. */
const TOOL_COLORS = ["#3a4a5c", "#4a3a5c", "#3a5c4a", "#5c4a3a", "#5c3a4a", "#3a5c5c"];

export class PlayView {
  private root: HTMLElement;
  private map: MapDef;
  private level: LevelConfig;
  private sim: Simulation;
  private speedId: SpeedId = "x1";
  private paused = false;
  private rafId = 0;
  private lastFrame = 0;
  private page!: HTMLElement;
  private onSelectLevel: (levelId: number) => void;
  private fx: EffectsLayer;
  /** The map/level/speed/policy group in the toolbar; foldable to save space. */
  private configGroupEl!: HTMLElement;
  private foldBtn!: HTMLButtonElement;
  private toolbarFolded = false;

  /**
   * Each tier rebuilds only when its own signature changes — rebuilding every
   * frame would destroy a tile between its mousedown and mouseup, making tiles
   * impossible to click. Tiers are independent so, e.g., a grid update doesn't
   * have to wait on a customer-exit animation, and vice versa.
   */
  private customersKey = "";
  private middleKey = "";
  private queuesKey = "";
  private customersEl!: HTMLElement;
  private middleEl!: HTMLElement;
  private queuesEl!: HTMLElement;
  private overlayEl: HTMLElement | null = null;
  private timerEls = new Map<number, HTMLElement>();
  private barEls = new Map<string, HTMLElement>();
  /** Flights already handed to the animation layer, so we never double-animate. */
  private animating = new Set<number>();
  /** Customers whose completion burst has already played. */
  private celebrated = new Set<number>();
  /**
   * Customer indices currently mid exit-animation. While non-empty, the
   * customers tier holds its current DOM — even though the sim has already
   * moved them out of `active` — so "old card shrinks away" finishes before
   * "new card appears" starts, instead of the two overlapping.
   */
  private pendingExits = new Set<number>();
  /** Bumped by restart()/mount() so a stale exit-animation callback is a no-op. */
  private renderGeneration = 0;
  /**
   * Where the tile the player just clicked actually was, captured before
   * `sim.pick()` removes it from the queue and the tier re-renders. Without
   * this, a queue-originating flight had no way to know which of the 5+
   * lanes' `.top` tiles it came from — `flightOrigin` fell back to whichever
   * `.queue-tile.top` happened to be first in the DOM, so the flight always
   * appeared to launch from lane 1 regardless of which lane was picked.
   */
  private lastPickOrigin: Point | null = null;
  /** Customer/mystery indices rendered in the customers tier last build, so a
   *  rebuild can tell which card(s) are newly appearing and slide them in
   *  instead of just cutting straight to the finished layout. */
  private lastCustomerIndices = new Set<number>();
  /**
   * Queue index the player just picked from, consumed by the next queues-tier
   * rebuild: that lane's remaining tiles animate sliding up into their new
   * positions (and the newly revealed bottom preview fades in) instead of the
   * lane just snapping to its post-pick state.
   */
  private lastPickedLane: number | null = null;

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
    this.sim = new Simulation(map, level, {
      outOfSlotPolicy: level.outOfSlotPolicy ?? "block-pick",
      instantFlights: false, // this view animates every transfer
    });
    this.fx = new EffectsLayer();
    this.mount();
    this.start();
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.fx.destroy();
  }

  private get skipMode(): boolean {
    return this.speedId === "skip";
  }

  private get rate(): number {
    return SPEED_OPTIONS.find((s) => s.id === this.speedId)?.rate ?? 1;
  }

  // ---------- lifecycle ----------

  private start(): void {
    this.lastFrame = performance.now();
    const frame = (now: number) => {
      const dt = Math.min((now - this.lastFrame) / 1000, 0.25);
      this.lastFrame = now;
      if (!this.paused && this.sim.status === "playing") {
        if (this.skipMode) {
          // Skip is instant, not just fast: fastForward() jumps cooking
          // straight to each completion rather than approximating it with an
          // accelerated tick, then stops the moment the level needs a pick.
          this.sim.fastForward();
        } else {
          this.sim.tick(dt * this.rate);
        }
      }
      this.dispatchFlights();
      this.playCelebrations(); // before syncPage, while the served card still exists
      this.syncPage();
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  private restart(): void {
    this.sim = new Simulation(this.map, this.level, {
      outOfSlotPolicy: this.sim.outOfSlotPolicy,
      instantFlights: false, // this view animates every transfer — see the constructor above
    });
    this.paused = false;
    this.animating.clear();
    this.celebrated.clear();
    this.pendingExits.clear();
    this.renderGeneration++; // orphans any exit-animation callback still pending
    this.renderPage();
  }

  // ---------- flights ----------

  /** Starts an animation for every new flight; the sim commits it on arrival. */
  private dispatchFlights(): void {
    // A snapshot, not a live view: completeFlight() below splices sim.flights,
    // and iterating the array being spliced mid-for-of skips whichever flight
    // shifts into the just-visited slot. Left unresolved, it lingers into a
    // later call — including the very next pick after switching modes, where
    // it can wrongly consume that pick's captured origin (see lastPickOrigin)
    // and leave the real new flight to fall back to a stale position. This is
    // the root cause of "switch to skip, back to x1, next fly doesn't play".
    for (const flight of [...this.sim.flights]) {
      if (this.animating.has(flight.id)) continue;

      // fillSlots() can promote a pending customer straight to active and
      // autoServe() can launch a flight to them in that very same tick — all
      // before this frame's syncPage() has rebuilt the customers tier. Until
      // that rebuild happens, their card is still the masked "?" mystery
      // card (same data-customer index as the real one); hold the flight
      // rather than fly an ingredient onto it. Retried every frame, so it
      // goes the moment the reveal lands.
      if (flight.kind === "grid-to-customer") {
        const card = this.page.querySelector(`[data-customer="${flight.toCustomer!.index}"]`);
        if (card?.classList.contains("mystery")) continue;
      }

      this.animating.add(flight.id);

      if (this.skipMode) {
        this.sim.completeFlight(flight.id);
        this.animating.delete(flight.id);
        continue;
      }

      const from = this.flightOrigin(flight);
      const to = this.flightTarget(flight);
      if (!from || !to) {
        // Nothing on screen to fly between (offscreen/hidden) — commit directly.
        this.sim.completeFlight(flight.id);
        this.animating.delete(flight.id);
        continue;
      }

      const isRaw =
        flight.kind === "queue-to-tool" ||
        flight.kind === "grid-to-tool" ||
        (flight.kind === "queue-to-grid" && flight.raw);
      const isDirty = flight.itemId === DIRTY_DISH_ID;
      const icon = isDirty
        ? el("span", { class: "icon" }, ["🍽"])
        : isRaw
          ? ingredientIconEl(flight.itemId, 96)
          : cookedIconEl(flight.itemId, 96);
      const payload = el("div", { class: `fx-item${isDirty ? " dirty" : ""}` }, [icon]);

      // The exact chip a grid-to-customer flight is landing on, captured now
      // (flightTarget already resolved it) — needed so the arrival flash can
      // be applied to *that* element once the flight lands.
      const targetChip =
        flight.kind === "grid-to-customer"
          ? this.page.querySelector<HTMLElement>(
              `[data-customer="${flight.toCustomer!.index}"] [data-dish-ingredient="${flight.itemId}"]:not(.filled)`,
            )
          : null;

      // The sim only clears the source cell once this flight lands (see
      // Simulation.completeFlight), but visually the item should leave the
      // grid the moment it takes off — otherwise it sits duplicated in the
      // cell for the whole flight, next to its own flying copy.
      if (flight.kind === "grid-to-customer" && flight.fromCell !== undefined) {
        this.page
          .querySelector(`[data-cell="${flight.fromCell}"] .cell-main`)
          ?.remove();
      }

      void this.fx
        .fly(payload, from, to, { durationMs: 420 / Math.max(1, this.rate) })
        .then(() => this.onFlightLanded(flight, to, targetChip))
        .then(() => {
          this.sim.completeFlight(flight.id);
          this.animating.delete(flight.id);
        });
    }
  }

  /**
   * Per-kind landing feedback, played on the still-pre-completion state (the
   * chip is still "unfilled", the stack is still on the grid) so it reads as
   * marking *this* arrival rather than a generic after-the-fact effect.
   * Resolves once any such feedback has had a moment to be seen; the caller
   * commits the flight's real state change only after this settles.
   */
  private onFlightLanded(
    flight: Flight,
    at: Point,
    targetChip: HTMLElement | null,
  ): Promise<void> {
    if (this.skipMode) return Promise.resolve();

    if (flight.kind === "grid-to-customer" && targetChip) {
      this.fx.burst(at, 8);
      targetChip.classList.add("arrival-flash");
      // Flash while still unfilled, *then* let completeFlight dim it — a
      // fixed short beat is enough to read as "this one just arrived".
      return new Promise((resolve) => setTimeout(resolve, 160));
    }
    if (flight.kind === "dirty-to-staff") {
      this.fx.burst(at, 8);
    }
    return Promise.resolve();
  }

  private flightOrigin(flight: Flight) {
    if (flight.fromCustomer !== undefined) {
      // The served customer's card is still on screen this frame.
      const card = this.page.querySelector(`[data-customer="${flight.fromCustomer}"]`);
      return card ? centerOf(card) : null;
    }
    if (flight.fromCell !== undefined) {
      const cell = this.page.querySelector(`[data-cell="${flight.fromCell}"]`);
      return cell ? centerOf(cell) : null;
    }
    if (flight.fromTool) {
      const slot = this.page.querySelector(
        `[data-slot="${flight.fromTool.toolId}:${flight.fromTool.slot}"]`,
      );
      return slot ? centerOf(slot) : null;
    }
    // Queue flights start where the picked tile actually was; it's already
    // gone from the DOM by the time we get here, so the click handler stashed
    // its position beforehand. Consume it once so a later queue flight
    // (e.g. a parked raw's own eventual pick) doesn't reuse a stale point.
    if (this.lastPickOrigin) {
      const origin = this.lastPickOrigin;
      this.lastPickOrigin = null;
      return origin;
    }
    // Fallback (e.g. a flight created without going through the click handler):
    // best-effort, first visible top tile.
    const lane = this.page.querySelector(".queue-lanes.play .queue-tile.top");
    return lane ? centerOf(lane) : null;
  }

  private flightTarget(flight: Flight) {
    if (flight.toTool) {
      const slot = this.page.querySelector(
        `[data-slot="${flight.toTool.toolId}:${flight.toTool.slot}"]`,
      );
      return slot ? centerOf(slot) : null;
    }
    if (flight.toCell !== undefined) {
      const cell = this.page.querySelector(`[data-cell="${flight.toCell}"]`);
      return cell ? centerOf(cell) : null;
    }
    if (flight.toCustomer) {
      const card = this.page.querySelector(`[data-customer="${flight.toCustomer.index}"]`);
      if (!card) return null;
      if (flight.kind === "grid-to-customer") {
        // Aim at the specific unfilled chip this item satisfies, not just the
        // card in general — that's what lets the arrival flash/burst land
        // exactly on "the matching ingredient position".
        const chip = card.querySelector(
          `[data-dish-ingredient="${flight.itemId}"]:not(.filled)`,
        );
        if (chip) return centerOf(chip);
      }
      return centerOf(card);
    }
    return null;
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

    // One radio-style group: picking any option deselects the others.
    const speedBar = el("div", { class: "speed-bar", role: "radiogroup" });
    for (const option of SPEED_OPTIONS) {
      const b = button(
        option.label,
        () => {
          this.speedId = option.id;
          this.paused = false;
          this.refreshToolbar();
        },
        {
          class: this.speedId === option.id ? "active" : "",
          role: "radio",
          "data-speed": option.id,
          title:
            option.id === "skip"
              ? "Resolve everything instantly, with no animation"
              : `Run at ${option.label} speed`,
        },
      );
      speedBar.append(b);
    }

    const policy = el("select", { class: "policy-picker" }) as HTMLSelectElement;
    policy.append(
      el("option", { value: "block-pick" }, ["Block the pick"]),
      el("option", { value: "park-on-grid" }, ["Park raw on the grid"]),
    );
    policy.value = this.sim.outOfSlotPolicy;
    policy.title =
      "What happens when every slot of the ingredient's tool is busy:\n" +
      "• Block the pick — the queue tile cannot be picked until a slot frees.\n" +
      "• Park raw on the grid — the raw ingredient waits on the grid and moves " +
      "into the tool as soon as a slot opens (checked before new picks).";
    policy.addEventListener("change", () => {
      this.sim.setOutOfSlotPolicy(policy.value as OutOfSlotPolicy);
      this.level.outOfSlotPolicy = policy.value as OutOfSlotPolicy;
      this.renderPage();
    });

    // Map/level/speed/policy are "config" and fold away; the HUD is live game
    // state, not config, so it stays visible either way.
    this.configGroupEl = el("div", { class: "toolbar-config" }, [
      el("label", { class: "field small" }, ["Level", picker]),
      speedBar,
      button("⏸ Pause", () => {
        this.paused = !this.paused;
        this.refreshToolbar();
      }, { id: "btn-pause" }),
      button("⟲ Restart", () => this.restart()),
      el("label", { class: "field small" }, ["When tool is full", policy]),
    ]);

    this.foldBtn = button("", () => {
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
    this.configGroupEl.style.display = this.toolbarFolded ? "none" : "";
    this.foldBtn.textContent = this.toolbarFolded ? "▸ Config" : "▾ Config";
  }

  private refreshToolbar(): void {
    this.root.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach((b) => {
      b.classList.toggle("active", b.dataset.speed === this.speedId);
    });
    const pause = this.root.querySelector<HTMLButtonElement>("#btn-pause");
    if (pause) pause.textContent = this.paused ? "▶ Resume" : "⏸ Pause";
  }

  // ---------- page ----------

  /** Full build — used on mount/restart, when every tier needs a fresh element. */
  private renderPage(): void {
    this.timerEls.clear();
    this.barEls.clear();
    clear(this.page);
    this.customersEl = this.customersTier();
    this.lastCustomerIndices = this.currentCustomerIndices();
    this.middleEl = this.middleTier();
    this.queuesEl = this.queuesTier();
    this.customersKey = customersStructureKey(this.sim);
    this.middleKey = middleStructureKey(this.sim);
    this.queuesKey = queuesStructureKey(this.sim);
    this.page.append(this.customersEl, this.middleEl, this.queuesEl);
    this.syncOverlay();
    this.patchLiveValues();
  }

  /**
   * Rebuilds only the tier(s) whose structure actually changed. The customers
   * tier is skipped entirely while an exit animation is playing — see
   * `pendingExits` — so the row doesn't jump to its new layout mid-shrink.
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
      this.animatePickedLaneShift();
    }

    if (this.pendingExits.size === 0) {
      const nextCustomers = customersStructureKey(this.sim);
      if (nextCustomers !== this.customersKey) {
        this.timerEls.clear(); // only customerCard() populates this
        const previousIndices = this.lastCustomerIndices;
        const next = this.customersTier();
        this.customersEl.replaceWith(next);
        this.customersEl = next;
        this.customersKey = nextCustomers;
        this.lastCustomerIndices = this.currentCustomerIndices();
        this.slideInNewCustomers(previousIndices);
      }
    }

    this.syncOverlay();
    this.patchLiveValues();
  }

  /**
   * After a pick rebuilds the queues tier, the picked lane's tiles don't just
   * snap into place: the picked item is already gone (it left as the flight),
   * so every remaining tile starts one slot lower — where it visually was a
   * moment ago — and slides up into its new position. The tile that just
   * scrolled into the preview window (the new bottom item) additionally fades
   * in, reading as "added at the bottom" rather than having always been there.
   */
  private animatePickedLaneShift(): void {
    const lane = this.lastPickedLane;
    this.lastPickedLane = null;
    if (lane === null || this.skipMode) return;

    const laneEl = this.queuesEl.querySelector(`[data-lane="${lane}"]`);
    if (!laneEl) return; // the pick emptied the queue; the lane is gone entirely
    const tiles = [...laneEl.querySelectorAll<HTMLElement>(".queue-tile")];
    if (tiles.length === 0) return;

    // One slot's travel = distance between two adjacent tiles in the new
    // layout (covers tile height + gap); single-tile lanes fall back to the
    // tile's own height plus the 0.25rem gap.
    const step =
      tiles.length > 1
        ? tiles[1].getBoundingClientRect().top - tiles[0].getBoundingClientRect().top
        : tiles[0].getBoundingClientRect().height + 4;

    tiles.forEach((tile, i) => {
      // Only a full window (top + 2 previews) has a newly revealed tile: the
      // new 3rd tile was the old 4th item, previously outside the preview
      // window. With fewer tiles, everything shown was already visible.
      const revealed = tiles.length === 3 && i === 2;
      tile.animate(
        [
          { transform: `translateY(${step}px)`, opacity: revealed ? 0 : 1 },
          { transform: "translateY(0)", opacity: 1 },
        ],
        { duration: 240, easing: "cubic-bezier(.2,.8,.3,1)", delay: i * 25 },
      );
    });
  }

  /** Every customer/mystery index currently rendered in the customers tier. */
  private currentCustomerIndices(): Set<number> {
    return new Set(
      [...this.customersEl.querySelectorAll<HTMLElement>("[data-customer]")].map((el) =>
        Number(el.dataset.customer),
      ),
    );
  }

  /**
   * "When a customer/staff disappears, don't just remove and redraw — play
   * an animation moving the next customer/staff in": whichever card(s) are
   * newly present compared to the previous build slide in from the side and
   * fade up, instead of the whole row just appearing in its finished state.
   */
  private slideInNewCustomers(previousIndices: Set<number>): void {
    const cards = this.customersEl.querySelectorAll<HTMLElement>("[data-customer]");
    for (const card of cards) {
      const idx = Number(card.dataset.customer);
      if (previousIndices.has(idx)) continue; // already on screen before this rebuild
      card.animate(
        [
          { transform: "translateX(24px) scale(0.9)", opacity: 0 },
          { transform: "translateX(0) scale(1)", opacity: 1 },
        ],
        { duration: 320, easing: "cubic-bezier(.2,.8,.3,1)" },
      );
    }
  }

  private syncOverlay(): void {
    // Wait for every still-flying item to land first — the overlay is opaque
    // and full-screen, so popping it up the instant the sim ends would hide
    // whatever's mid-flight behind it instead of letting it finish landing.
    const shouldShow = this.sim.status !== "playing" && this.animating.size === 0;
    if (shouldShow && !this.overlayEl) {
      this.overlayEl = this.overlay();
      this.page.append(this.overlayEl);
    } else if (!shouldShow && this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
  }

  /** Timers, cook progress and the HUD move every frame but never restructure. */
  private patchLiveValues(): void {
    this.renderHud();
    for (const c of this.sim.active) {
      const node = this.timerEls.get(c.index);
      if (node) node.textContent = this.timerText(c);
    }
    for (const tool of this.sim.tools) {
      tool.slots.forEach((slot, i) => {
        const bar = this.barEls.get(`${tool.def.id}:${i}`);
        if (!bar) return;
        const pct = slot.item
          ? Math.min(100, (slot.item.elapsed / tool.def.cookingTime) * 100)
          : 0;
        bar.style.width = `${pct}%`;
      });
    }
  }

  /**
   * Starts the celebrate-then-shrink sequence for any customer served since the
   * last check, and holds the customers tier (via `pendingExits`) until it
   * finishes — that's what makes "old card shrinks to zero" complete strictly
   * before "next card / mystery card appears", rather than the two overlapping.
   *
   * Must run *before* the page re-renders: the served customer has already left
   * `active`, so their card only exists in the DOM until the next render. That
   * is what lets the effect target their own frame rather than the whole row.
   */
  private playCelebrations(): void {
    for (const event of this.sim.events) {
      if (event.type !== "served" || event.customerIndex === undefined) continue;
      const idx = event.customerIndex; // narrowed here; keep as a local for the closure below
      if (this.celebrated.has(idx)) continue;
      this.celebrated.add(idx);

      const card = this.page.querySelector<HTMLElement>(`[data-customer="${idx}"]`);
      if (!card) continue;

      if (this.skipMode) continue; // nothing to hold — the row updates on the next sync

      const generation = this.renderGeneration;
      this.pendingExits.add(idx);
      void this.fx.celebrateAndRemove(card).then(() => {
        if (generation !== this.renderGeneration) return; // restarted mid-animation
        this.pendingExits.delete(idx);
      });
    }
  }

  private timerText(c: CustomerState): string {
    return c.timeLeft === Infinity
      ? "∞"
      : `${Math.max(0, c.timeLeft).toFixed(0)}s${c.config.weatherEff ? " 🌧" : ""}`;
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

  /**
   * Top tier, left to right in arrival order: the serveable customers, then a
   * single masked card for whoever is next. Only the serveable orders are
   * readable — the one behind them is deliberately hidden as "?".
   */
  private customersTier(): HTMLElement {
    const sim = this.sim;
    const row = el("div", { class: "customer-cards play" });
    for (const c of sim.active) row.append(this.customerCard(c, true));
    // Exactly one lookahead card, and its order stays secret.
    const next = sim.pending[0];
    if (next) row.append(this.mysteryCard(next));
    // Fixed column count = always every card fits, never needs horizontal
    // scrolling to see the 2nd/3rd card (a flex+overflow row let that happen).
    const count = sim.active.length + (next ? 1 : 0);
    row.style.gridTemplateColumns = `repeat(${Math.max(1, count)}, 1fr)`;
    return el("section", { class: "play-section customers-tier" }, [
      el("h2", {}, [`Customers — ${sim.level.serveableSlots} serve slot(s)`]),
      row,
    ]);
  }

  private customerCard(c: CustomerState, servable: boolean): HTMLElement {
    const card = el("div", {
      class: `customer-card${servable ? " servable" : " waiting"}${c.isStaff ? " staff" : ""}`,
      "data-customer": String(c.index),
    });
    const timer = el("span", { class: "wait-badge" }, [this.timerText(c)]);
    if (servable) this.timerEls.set(c.index, timer);
    card.append(
      el("div", { class: "customer-head" }, [
        c.isStaff
          ? el("span", { class: "cust-index" }, [customerTypeIconEl(c.config.typeId, 48)])
          : el("span", { class: "cust-index" }, [`#${c.index + 1}`]),
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
        row.append(el("span", {
          class: "chip icon-chip dish-chip filled",
          "data-dish-ingredient": String(id),
        }, [cookedIconEl(id, 64)]));
      }
      for (const id of dish.remaining) {
        row.append(el("span", {
          class: "chip icon-chip dish-chip",
          "data-dish-ingredient": String(id),
        }, [cookedIconEl(id, 64)]));
      }
      card.append(row);
    }
    return card;
  }

  /** The next customer in line: present, but their order is not revealed yet. */
  private mysteryCard(c: CustomerState): HTMLElement {
    const card = el("div", {
      class: "customer-card mystery",
      "data-customer": String(c.index),
      title: "Next in line — their order is revealed when a serve slot frees up",
    });
    card.append(
      el("div", { class: "customer-head" }, [
        el("span", { class: "cust-index" }, [`#${c.index + 1}`]),
      ]),
      el("div", { class: "mystery-mark" }, ["?"]),
    );
    return card;
  }

  /** Middle tier: one panel, grid left + cooking tools right. */
  private middleTier(): HTMLElement {
    return el("section", { class: "play-section middle-tier" }, [
      el("div", { class: "middle-split" }, [
        el("div", { class: "middle-left" }, [
          el("h2", {}, [`Grid ${this.map.gridWidth}×${this.map.gridHeight}`]),
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
    grid.style.gridTemplateColumns = `repeat(${sim.map.gridWidth}, 1fr)`;

    for (let i = 0; i < sim.grid.length; i++) {
      const content = sim.grid[i];
      const lock = sim.cellLockLabel(i);
      const typeEffect = sim.level.grid[i]?.effects[0];
      const cell = el("div", {
        class: `cell${lock ? " locked" : ""}`,
        "data-cell": String(i),
      });

      if (lock && typeEffect) {
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
        cell.append(el("span", { class: "cell-main" }, [cookedIconEl(content.cookedId, 96)]));
      } else if (content.kind === "raw") {
        // Parked raw waiting for a tool slot — dimmed so it reads as unfinished.
        cell.append(el("span", { class: "cell-main parked" }, [ingredientIconEl(content.rawId, 96)]));
        cell.append(el("small", { class: "cell-badge" }, ["waiting"]));
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

  /** Only the tools this map actually defines are drawn, each with its slots. */
  private toolsEl(): HTMLElement {
    const wrap = el("div", { class: "tools" });
    if (this.sim.tools.length === 0) {
      wrap.append(el("small", { class: "muted" }, ["This map defines no cooking tools."]));
      return wrap;
    }
    this.sim.tools.forEach((tool, toolIndex) => {
      const slots = el("div", { class: "tool-slots" });
      tool.slots.forEach((slot, i) => {
        const bar = el("div", { class: "bar" });
        this.barEls.set(`${tool.def.id}:${i}`, bar);
        const node = el("div", {
          class: `tool-slot${slot.item ? " busy" : ""}`,
          "data-slot": `${tool.def.id}:${i}`,
        });
        if (slot.item) {
          node.append(el("span", { class: "slot-item" }, [ingredientIconEl(slot.item.rawId, 96)]));
        }
        node.append(el("div", { class: "bar-track" }, [bar]));
        slots.append(node);
      });
      // Compact: name + slot/time detail live in the tooltip, not on screen —
      // this row is meant to take as little vertical space as possible.
      const toolEl = el("div", {
        class: "tool",
        title: `${tool.def.name} — ${tool.def.numSlots} slot(s) · ${tool.def.cookingTime}s`,
      }, [
        el("div", { class: "tool-head" }, [
          toolIconEl(tool.def, 64),
          el("span", { class: "tool-name" }, [tool.def.name]),
        ]),
        slots,
      ]);
      // Width share proportional to slot count (a 2-slot tool gets twice a
      // 1-slot tool's width of the full-width strip); a distinct background
      // per tool so adjacent ones are visually distinct at a glance.
      toolEl.style.flexGrow = String(Math.max(1, tool.def.numSlots));
      toolEl.style.background = TOOL_COLORS[toolIndex % TOOL_COLORS.length];
      wrap.append(toolEl);
    });
    return wrap;
  }

  /** Bottom tier: lanes; the top tile is the pick button. */
  private queuesTier(): HTMLElement {
    const sim = this.sim;
    const needed = sim.neededCookedIds();
    // An ingredient is "wanted" when its tool output (or itself) is on an order.
    const wantedRaw = new Set<number>();
    for (const raw of this.map.rawIngredients) {
      const match = findToolRecipe(this.map.tools, raw.id);
      if (needed.has(match ? match.recipe.out : raw.id)) wantedRaw.add(raw.id);
    }

    const lanes = el("div", { class: "queue-lanes play" });
    sim.queues.forEach((queue, qi) => {
      // An emptied queue disappears entirely rather than lingering as a blank
      // lane — the remaining lanes then re-center as a group (see the
      // .queue-lanes.play justify-content:center rule).
      if (queue.length === 0) return;
      const check = sim.canPick(qi);
      const lane = el("div", { class: "queue-lane", "data-lane": String(qi) }, [
        el("div", { class: "lane-head" }, [
          el("span", {}, [`Queue ${qi + 1}`]),
          el("small", {}, [`${queue.length}`]),
        ]),
      ]);
      const tiles = el("div", { class: "lane-tiles" });

      // queue.length === 0 already returned above, so there's always a top item.
      const top = queue[0];
      const tile = this.queueTile(top, {
        top: true,
        wanted: wantedRaw.has(top.id),
        disabled: !check.ok,
      });
      tile.title = check.reason ?? "Pick this ingredient";
      if (check.ok) {
        tile.addEventListener("click", () => {
          // Capture before pick() removes this tile from the queue and the
          // tier re-renders — this is the only moment its real position exists.
          this.lastPickOrigin = centerOf(tile);
          this.lastPickedLane = qi;
          this.sim.pick(qi);
          this.dispatchFlights();
          this.playCelebrations();
          this.syncPage();
        });
      }
      tiles.append(tile);
      for (const item of queue.slice(1, 3)) {
        tiles.append(this.queueTile(item, { preview: true }));
      }
      lane.append(tiles);
      lanes.append(lane);
    });

    return el("section", { class: "play-section queues-tier" }, [
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
