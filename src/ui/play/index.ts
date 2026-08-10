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
import type { BotBatchResult, BotType } from "../../core/bot.ts";
import { runBotTrials } from "../../core/bot.ts";
import { DIRTY_DISH_ID, Simulation } from "../../core/sim.ts";
import type { CustomerState, Flight, QueueCell } from "../../core/sim.ts";
import type {
  Id,
  LevelConfig,
  MapDef,
  OutOfSlotPolicy,
  QueueGroupKind,
  QueueItem,
} from "../../core/types.ts";
import { resolveCookedId } from "../../core/types.ts";

/**
 * Flight kinds that land on (and fill) a customer's dish chip: the two
 * grid/backpack-sourced kinds, plus the two direct-serve kinds that skip the
 * grid entirely (a freshly cooked or picked item flying straight to a
 * customer already waiting for it — see GDD.md §2.2.1). All four need the
 * same specific-chip targeting and arrival flash, not just a generic
 * card-center landing.
 */
function fillsDishChip(kind: Flight["kind"]): boolean {
  return (
    kind === "grid-to-customer" ||
    kind === "backpack-to-customer" ||
    kind === "tool-to-customer" ||
    kind === "queue-to-customer"
  );
}
import { BOOSTER_PARAMS, GLOBAL_DEFS, KEY_COLORS } from "../../data/configLoader.ts";
import { button, clear, el } from "../dom.ts";
import {
  backpackIconEl,
  boosterIconEl,
  cellIconEl,
  cookedIconEl,
  customerTypeIconEl,
  dirtyIconEl,
  ingredientIconEl,
  statusIconEl,
  toolIconEl,
} from "../icon.ts";
import { localImageUrl } from "../localImages.ts";
import { appendLine, createOverlay, railColor, railSegments } from "../queueGroupVisuals.ts";
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

/** Particle palette for a Freeze break burst — icy blues/whites instead of the default warm palette. */
const ICE_BURST_COLORS = ["#bfe8ff", "#eaffff", "#8fd1ff", "#ffffff", "#5ec8ff"];

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
  /** Ambient background weather effect (rain/snow/sun rays), built once per level load from level.weather. */
  private weatherEl!: HTMLElement;
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
  /** Countdown progress bar fill, per timed customer — see patchLiveValues(). */
  private timerBarEls = new Map<number, HTMLElement>();
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
  /** Each customer's randomly-drawn avatar, cached so it doesn't reshuffle on every re-render. */
  private customerAvatarByIndex = new Map<number, string>();
  /**
   * Origins of the tiles a group pick just removed, captured before
   * `sim.pick()` removes them from the queue and the tier re-renders — FIFO,
   * one per flight the pick is about to launch (sweepers excluded, since they
   * launch no flight), in the same order the sim dispatches them. Without
   * this, a queue-originating flight had no way to know which of the 5+
   * lanes' `.top` tiles it came from — `flightOrigin` fell back to whichever
   * `.queue-tile.top` happened to be first in the DOM, so the flight always
   * appeared to launch from lane 1 regardless of which lane was picked. A
   * single-item pick is just the N=1 case of this same queue.
   */
  private pendingPickOrigins: Point[] = [];
  /** Customer/mystery indices rendered in the customers tier last build, so a
   *  rebuild can tell which card(s) are newly appearing and slide them in
   *  instead of just cutting straight to the finished layout. */
  private lastCustomerIndices = new Set<number>();
  /**
   * Column -> how many rows it lost, from the pick just made, consumed by the
   * next queues-tier rebuild: each touched lane's remaining tiles animate
   * sliding up by that many rows (and the newly revealed bottom row(s) fade
   * in) instead of the lane just snapping to its post-pick state. A combined
   * block can vacate more than one row of a column at once (a vertical run
   * within it), and a single pick can touch several columns at once.
   */
  private lastPickedLanes = new Map<number, number>();

  /**
   * Auto-play bot playtesting panel state — independent of the live game
   * session. Lives in the toolbar as its own foldout, collapsed by default.
   */
  private botType: BotType = "greedy";
  private botTrialCount = 10;
  private botRunning = false;
  private lastBotBatchResult: BotBatchResult | null = null;
  private botGroupEl!: HTMLElement;
  private botFoldBtn!: HTMLButtonElement;
  private botFolded = true;

  /**
   * Boosters: remaining-charge count per GLOBAL_DEFS.boosters index (Shift-up
   * Row, Ingredient Pick, Clean Table, Auto Complete). Ingredient Pick's armed
   * state expands `windowRows` and makes every visible tile pickable — see
   * queuesTier(). Both reset in restart(), same as other per-run state.
   */
  private boosterCharges: number[] = [];
  private ingredientPickMode = false;
  private boostersEl!: HTMLElement;
  /** Set once the player picks "Give Up" on the Save Me offer, so the plain failure overlay shows instead — reset on restart(). */
  private saveMeDeclined = false;

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
    this.boosterCharges = [...(level.boosterCharges ?? [3, 3, 3, 3])];
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

  /**
   * Queue rows shown per column: the map's configured default, unless the
   * Ingredient Pick booster is armed, in which case every row up to
   * BOOSTER_PARAMS.numRowPick is shown and pickable — see queuesTier().
   */
  private get windowRows(): number {
    return this.ingredientPickMode ? BOOSTER_PARAMS.numRowPick : this.map.visibleRows;
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
    this.pendingPickOrigins = [];
    this.lastPickedLanes = new Map();
    this.boosterCharges = [...(this.level.boosterCharges ?? [3, 3, 3, 3])];
    this.ingredientPickMode = false;
    this.saveMeDeclined = false;
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
    // it can wrongly consume that pick's captured origin (see pendingPickOrigins)
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
      if (fillsDishChip(flight.kind)) {
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
        ? dirtyIconEl(flight.dirtyId ?? DIRTY_DISH_ID, 96)
        : isRaw
          ? ingredientIconEl(flight.itemId, 96)
          : cookedIconEl(flight.itemId, 96);
      const payload = el("div", { class: `fx-item${isDirty ? " dirty" : ""}` }, [icon]);

      // The exact chip a dish-filling flight is landing on, captured now
      // (flightTarget already resolved it) — needed so the arrival flash can
      // be applied to *that* element once the flight lands.
      const targetChip = fillsDishChip(flight.kind)
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

    if (fillsDishChip(flight.kind) && targetChip) {
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
    // Queue flights start where the picked tile(s) actually were; they're
    // already gone from the DOM by the time we get here, so the click
    // handler stashed their positions beforehand, one per flight this pick
    // is launching, in dispatch order. Shift one off per flight so a group
    // pick's N flights each get their own origin instead of all reusing the
    // first tile's position.
    if (this.pendingPickOrigins.length > 0) {
      return this.pendingPickOrigins.shift()!;
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
      if (fillsDishChip(flight.kind)) {
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
    this.boostersEl = this.boostersBar();
    this.weatherEl = this.weatherLayer();
    // Weather is appended first (behind everything, position:fixed so it
    // takes no layout space) and the boosters bar is a sibling of .play-page,
    // not a child: the page's height/tiers are fixed (see .play-page in
    // style.css), so a 4th child inside it would shrink the existing three
    // tiers instead of the player just scrolling further.
    this.root.append(this.weatherEl, this.toolbar(), this.page, this.boostersEl);
    this.renderPage();
  }

  /**
   * Full-viewport ambient background effect matching the level's weather —
   * Rainy: falling rain streaks (Stormy: the same, at 2x density), Freeze:
   * falling snow, Sunny: diagonal light rays. Normal gets no effect. Pure CSS
   * keyframe loops (see style.css), so this costs nothing per animation
   * frame and doesn't compete with the sim's own rAF loop. Kept faint
   * (see .weather-drop/.weather-flake opacity in style.css) so it reads as
   * ambience, not something competing with the board for attention.
   */
  private weatherLayer(): HTMLElement {
    const layer = el("div", { class: "weather-layer" });
    const weather = this.level.weather;
    if (weather === "Rainy" || weather === "Stormy") {
      layer.classList.add("weather-rain");
      this.appendRain(layer, weather === "Stormy" ? 80 : 40);
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

  private appendRain(layer: HTMLElement, count: number): void {
    for (let i = 0; i < count; i++) {
      const drop = el("div", { class: "weather-drop" });
      drop.style.left = `${Math.random() * 100}%`;
      drop.style.animationDelay = `-${(Math.random() * 1).toFixed(2)}s`;
      drop.style.animationDuration = `${(0.5 + Math.random() * 0.4).toFixed(2)}s`;
      layer.append(drop);
    }
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

    this.botGroupEl = this.botGroup();
    this.botFoldBtn = button("", () => {
      this.botFolded = !this.botFolded;
      this.applyBotFoldState();
    }, { class: "fold-toggle", title: "Show/hide the auto-play bot playtesting panel" });

    const bar = el("div", { class: "play-toolbar" }, [
      this.foldBtn,
      this.configGroupEl,
      this.botFoldBtn,
      this.botGroupEl,
      el("span", { class: "spacer" }),
      el("div", { class: "hud", id: "play-hud" }),
    ]);
    this.applyFoldState();
    this.applyBotFoldState();
    return bar;
  }

  private applyFoldState(): void {
    this.configGroupEl.style.display = this.toolbarFolded ? "none" : "";
    this.foldBtn.textContent = this.toolbarFolded ? "▸ Config" : "▾ Config";
  }

  private applyBotFoldState(): void {
    this.botGroupEl.style.display = this.botFolded ? "none" : "";
    this.botFoldBtn.textContent = this.botFolded ? "▸ Bot" : "▾ Bot";
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
    this.timerBarEls.clear();
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
    this.refreshQueueGroupOverlay();
    this.syncOverlay();
    this.patchLiveValues();
  }

  /**
   * Draws the linked-rope/combined-rail overlay for the queues tier. Must run
   * only after `this.queuesEl` is actually attached to the document —
   * getBoundingClientRect() on a still-detached tree returns all zeros, which
   * is why this isn't done inside queuesTier() itself.
   */
  private refreshQueueGroupOverlay(): void {
    const lanes = this.queuesEl.querySelector<HTMLElement>(".queue-lanes");
    if (lanes) renderGroupOverlay(lanes, this.sim, this.windowRows);
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
      this.rebuildQueuesTier();
      this.animatePickedLaneShift();
    }

    if (this.pendingExits.size === 0) {
      const nextCustomers = customersStructureKey(this.sim);
      if (nextCustomers !== this.customersKey) {
        this.timerEls.clear(); // only customerCard() populates this
        this.timerBarEls.clear();
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
   * Rebuilds the queues tier unconditionally — used both by syncPage() (when
   * queuesStructureKey changed) and by useBooster() when arming/disarming
   * Ingredient Pick, which changes `windowRows` without changing any sim
   * state the structure key would otherwise notice.
   */
  private rebuildQueuesTier(): void {
    const next = this.queuesTier();
    this.queuesEl.replaceWith(next);
    this.queuesEl = next;
    this.queuesKey = queuesStructureKey(this.sim);
    this.refreshQueueGroupOverlay();
  }

  /**
   * After a pick rebuilds the queues tier, a touched lane's tiles don't just
   * snap into place: the picked cell(s) are already gone (they left as
   * flights), so every remaining tile starts however many rows lower —
   * wherever it visually was a moment ago — and slides up into its new
   * position. Whichever tile(s) just scrolled into the window (the new
   * bottom row(s)) additionally fade in, reading as "added at the bottom"
   * rather than having always been there. A pick can touch several lanes at
   * once (a combined/linked group spanning columns), and a single lane can
   * lose more than one row at once (a vertical run within a combined block).
   */
  private animatePickedLaneShift(): void {
    const perLane = this.lastPickedLanes;
    this.lastPickedLanes = new Map();
    if (perLane.size === 0 || this.skipMode) return;

    for (const [lane, vacated] of perLane) {
      const laneEl = this.queuesEl.querySelector(`[data-lane="${lane}"]`);
      if (!laneEl) continue; // the pick emptied the queue; the lane is gone entirely
      const tiles = [...laneEl.querySelectorAll<HTMLElement>(".queue-tile")];
      if (tiles.length === 0) continue;

      // One slot's travel = distance between two adjacent tiles in the new
      // layout (covers tile height + gap); single-tile lanes fall back to the
      // tile's own height plus the 0.25rem gap. Scaled by how many rows this
      // lane actually vacated.
      const rowHeight =
        tiles.length > 1
          ? tiles[1].getBoundingClientRect().top - tiles[0].getBoundingClientRect().top
          : tiles[0].getBoundingClientRect().height + 4;
      const step = rowHeight * vacated;

      tiles.forEach((tile, i) => {
        // Only a full window has newly revealed tiles: the last `vacated`
        // rows were previously outside the window. With fewer tiles (the
        // lane is shorter than the window), everything shown was already
        // visible.
        const revealed = tiles.length === this.windowRows && i >= this.windowRows - vacated;
        tile.animate(
          [
            { transform: `translateY(${step}px)`, opacity: revealed ? 0 : 1 },
            { transform: "translateY(0)", opacity: 1 },
          ],
          { duration: 240, easing: "cubic-bezier(.2,.8,.3,1)", delay: i * 25 },
        );
      });
    }
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
      this.overlayEl = this.canOfferSaveMe() ? this.saveMeOverlay() : this.overlay();
      this.page.append(this.overlayEl);
    } else if (!shouldShow && this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
  }

  /** Whether the Save Me offer, rather than the plain failure overlay, should show on this loss. `saveMeCount < 0` means unlimited (same "-1 = no cap" convention as Clean Table's numCleanStack). */
  private canOfferSaveMe(): boolean {
    return (
      this.sim.status === "lost" &&
      !this.saveMeDeclined &&
      (BOOSTER_PARAMS.saveMeCount < 0 || this.sim.saveMeUsed < BOOSTER_PARAMS.saveMeCount)
    );
  }

  /** Timers, cook progress and the HUD move every frame but never restructure. */
  private patchLiveValues(): void {
    this.renderHud();
    for (const c of this.sim.active) {
      const node = this.timerEls.get(c.index);
      if (node) node.textContent = this.timerText(c);
      const fill = this.timerBarEls.get(c.index);
      if (fill) this.setWaitProgress(fill, c);
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

  /**
   * A timed customer's full patience duration — mirrors Simulation's private
   * customerTime() (waitTime, halved when weatherEff and the level's weather
   * isn't Normal) — needed here only to turn the live timeLeft into a 0-100%
   * countdown-bar width; the sim itself never needs this after construction.
   */
  private fullWaitTime(c: CustomerState): number {
    const bad = this.level.weather !== "Normal";
    return c.config.weatherEff === 1 && bad ? c.config.waitTime / 2 : c.config.waitTime;
  }

  /** Sizes and colors a customer's countdown-bar fill from their live timeLeft. */
  private setWaitProgress(fill: HTMLElement, c: CustomerState): void {
    const full = this.fullWaitTime(c);
    const pct = full > 0 ? Math.max(0, Math.min(100, (c.timeLeft / full) * 100)) : 0;
    fill.style.width = `${pct}%`;
    fill.classList.toggle("low", pct <= 33);
    fill.classList.toggle("mid", pct > 33 && pct <= 66);
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

  /**
   * Reorders a dish's cooked-ingredient ids so a "base" (e.g. Sliced Bun,
   * Soda Cup) displays before whatever needs it already in the dish (e.g.
   * toppings, Ice) — see CookedIngredientDef.baseId. Ids in neither role
   * keep their original relative position (Array.sort is stable).
   */
  private sortByBase(ids: Id[]): Id[] {
    const needsBase = (id: Id) =>
      this.map.cookedIngredients.find((c) => c.id === id)?.baseId !== undefined;
    return [...ids].sort((a, b) => Number(needsBase(a)) - Number(needsBase(b)));
  }

  private customerCard(c: CustomerState, servable: boolean): HTMLElement {
    const card = el("div", {
      class: `customer-card${servable ? " servable" : " waiting"}${c.isStaff ? " staff" : ""}`,
      "data-customer": String(c.index),
    });
    this.appendAvatar(card, c.index);
    if (servable && !c.isStaff && c.timeLeft !== Infinity) {
      const fill = el("div", { class: "wait-progress-fill" });
      card.append(el("div", { class: "wait-progress" }, [fill]));
      this.timerBarEls.set(c.index, fill);
      this.setWaitProgress(fill, c);
    }
    const content = el("div", { class: "customer-content" });
    const timer = el("span", { class: "wait-badge" }, [this.timerText(c)]);
    if (servable) this.timerEls.set(c.index, timer);
    content.append(
      el("div", { class: "customer-head" }, [
        c.isStaff
          ? el("span", { class: "cust-index" }, [customerTypeIconEl(c.config.typeId, 48)])
          : el("span", { class: "cust-index" }, [`#${c.index + 1}`]),
        timer,
      ]),
    );
    if (c.isStaff) {
      content.append(el("div", { class: "staff-note" }, ["Clears dirty stacks"]));
      card.append(content);
      return card;
    }
    for (const dish of c.dishes) {
      const row = el("div", { class: "dish-row" });
      for (const id of this.sortByBase(dish.filled)) {
        row.append(el("span", {
          class: "chip icon-chip dish-chip filled",
          "data-dish-ingredient": String(id),
        }, [cookedIconEl(id, 64)]));
      }
      for (const id of this.sortByBase(dish.remaining)) {
        row.append(el("span", {
          class: "chip icon-chip dish-chip",
          "data-dish-ingredient": String(id),
        }, [cookedIconEl(id, 64)]));
      }
      content.append(row);
    }
    card.append(content);
    return card;
  }

  /** The next customer in line: present, but their order is not revealed yet. */
  private mysteryCard(c: CustomerState): HTMLElement {
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

  /**
   * Draws a random avatar covering the whole card, behind its content —
   * stable per customer index for as long as this PlayView lives (picked
   * once, cached, not re-rolled on every re-render). No-op for maps that
   * define no avatars, or if the chosen path isn't a bundled local image.
   */
  private appendAvatar(card: HTMLElement, index: number): void {
    const avatars = this.map.customerAvatars;
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
        if (content.usesLeft && content.usesLeft > 1) {
          cell.append(el("small", { class: "cell-badge uses-left" }, [`×${content.usesLeft}`]));
        }
      } else if (content.kind === "raw") {
        // Parked raw waiting for a tool slot — dimmed so it reads as unfinished.
        cell.append(el("span", { class: "cell-main parked" }, [ingredientIconEl(content.rawId, 96)]));
        cell.append(el("small", { class: "cell-badge" }, ["waiting"]));
      } else if (content.kind === "dirty") {
        cell.append(
          el("span", { class: "cell-main dirty" }, [dirtyIconEl(content.dirtyId, 96)]),
          el("span", { class: "cell-badge" }, [`×${content.count}`]),
        );
      } else if (content.kind === "backpack") {
        // The Save Me booster's collapsed grid — autoServe()/autoCompleteDish()
        // draw from this before the grid itself, so it needs to read as a
        // distinct source, not just another occupied cell.
        cell.append(
          el("span", { class: "cell-main backpack" }, [backpackIconEl(96)]),
          el("small", { class: "cell-badge" }, [`×${content.items.length}`]),
        );
      }
      grid.append(cell);
    }
    return grid;
  }

  /**
   * Raw ingredient ids this level's queues actually contain — used to grey
   * out tools that no ingredient in this level will ever need (e.g. Fryer
   * and Flour, which have no recipes yet at all).
   */
  private usedRawIds(): Set<Id> {
    const ids = new Set<Id>();
    for (const lane of this.level.queues) {
      for (const item of lane) {
        if (item.kind === "ingredient") ids.add(item.id);
      }
    }
    return ids;
  }

  /** Only the tools this map actually defines are drawn, each with its slots. */
  private toolsEl(): HTMLElement {
    const wrap = el("div", { class: "tools" });
    if (this.sim.tools.length === 0) {
      wrap.append(el("small", { class: "muted" }, ["This map defines no cooking tools."]));
      return wrap;
    }
    const usedRawIds = this.usedRawIds();
    this.sim.tools.forEach((tool, toolIndex) => {
      const unused = !tool.def.recipes.some((r) => usedRawIds.has(r.in));
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
        class: `tool${unused ? " unused" : ""}`,
        title:
          `${tool.def.name} — ${tool.def.numSlots} slot(s) · ${tool.def.cookingTime}s` +
          (unused ? " — no ingredient in this level needs it" : ""),
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

  /**
   * Bottom tier: a fixed window of the top `this.windowRows` rows, aligned
   * across every column (short columns show blank filler cells) — that's
   * what gives a combined block its visible shape and lets the player see
   * how close a linked chain's members are to the front. Normally only row 0
   * is clickable: `sim.pick(x)` always resolves "the instance fronting
   * column x", whether that's a plain item, a combined block (pickable once
   * any of its cells reaches row 0), or a linked chain (pickable once every
   * member does). While the Ingredient Pick booster is armed
   * (`ingredientPickMode`), every rendered tile is clickable instead —
   * `sim.pickAt(x,y)` resolves the instance at that exact cell with no
   * front-row gate.
   */
  private queuesTier(): HTMLElement {
    const sim = this.sim;
    const needed = sim.neededCookedIds();
    // An ingredient is "wanted" when its tool output (or itself) is on an order.
    const wantedRaw = new Set<number>();
    for (const raw of this.map.rawIngredients) {
      if (needed.has(resolveCookedId(this.map.tools, this.map.rawIngredients, raw.id))) wantedRaw.add(raw.id);
    }

    const windowRows = this.windowRows;
    const lanes = el("div", { class: "queue-lanes play" });
    // Static CSS can't read a per-map/booster JS value — the --tile clamp's
    // row divisor reads this custom property instead (style.css).
    lanes.style.setProperty("--window-rows", String(windowRows));
    for (let x = 0; x < sim.columnCount; x++) {
      // An emptied queue disappears entirely rather than lingering as a blank
      // lane — the remaining lanes then re-center as a group (see the
      // .queue-lanes.play justify-content:center rule).
      if (sim.remainingIn(x) === 0) continue;
      const check = sim.canPick(x);
      const lane = el("div", { class: "queue-lane", "data-lane": String(x) }, [
        el("div", { class: "lane-head" }, [
          el("span", {}, [`Queue ${x + 1}`]),
          el("small", {}, [`${sim.remainingIn(x)}`]),
        ]),
      ]);
      const tiles = el("div", { class: "lane-tiles" });

      for (let y = 0; y < windowRows; y++) {
        const cell: QueueCell | null = sim.queueGrid[x]?.[y] ?? null;
        if (!cell) {
          tiles.append(el("div", { class: "queue-tile empty" }));
          continue;
        }
        const isTop = y === 0;
        const groupKind: QueueGroupKind | undefined =
          cell.group !== -1 ? sim.groupKinds[cell.group] : undefined;
        const tile = this.queueTile(cell.item, {
          top: isTop,
          preview: !isTop && !this.ingredientPickMode,
          wanted: wantedRaw.has(cell.item.id),
          disabled: isTop && !this.ingredientPickMode && !check.ok,
          group: groupKind,
        });
        tile.dataset.qx = String(x);
        tile.dataset.qy = String(y);
        if (this.ingredientPickMode) {
          tile.title = "Pick this ingredient";
          tile.addEventListener("click", () => this.performPickAt(x, y));
        } else if (isTop) {
          tile.title = check.reason ?? "Pick this ingredient";
          if (check.ok) {
            tile.addEventListener("click", () => this.performPick(x));
          }
        }
        tiles.append(tile);
      }
      lane.append(tiles);
      lanes.append(lane);
    }

    // Not rendered here: getBoundingClientRect() on `lanes` would return all
    // zeros until this section is actually attached to the document, which
    // only happens after queuesTier() returns. Callers draw it themselves
    // right after attaching — see refreshQueueGroupOverlay().
    return el("section", { class: "play-section queues-tier" }, [
      el("h2", {}, [
        this.ingredientPickMode
          ? "Ingredient queues — Ingredient Pick armed: click any tile"
          : "Ingredient queues — click the top tile to pick",
      ]),
      lanes,
    ]);
  }

  /**
   * Picks the instance fronting lane x — capturing every flight-bound tile's
   * screen position first (sweepers excluded, they launch no flight), since
   * `sim.pick()` removes them from the queue before this frame's flights get
   * dispatched. See `pendingPickOrigins`/`lastPickedLanes`.
   */
  private performPick(x: number): void {
    const sim = this.sim;
    const cells = sim.pickTargets(x);

    const perLane = new Map<number, number>();
    for (const c of cells) perLane.set(c.x, (perLane.get(c.x) ?? 0) + 1);
    this.lastPickedLanes = perLane;

    this.pendingPickOrigins = cells
      .filter((c) => sim.queueGrid[c.x][c.y]?.item.kind !== "sweeper")
      .map((c) => {
        const tileEl = this.queuesEl.querySelector<HTMLElement>(`[data-qx="${c.x}"][data-qy="${c.y}"]`);
        return tileEl ? centerOf(tileEl) : null;
      })
      .filter((p): p is Point => p !== null);

    const frozenBefore = this.snapshotFrozenItems();
    sim.pick(x);
    this.playFreezeBreakBursts(frozenBefore);
    this.dispatchFlights();
    this.playCelebrations();
    this.syncPage();
  }

  /**
   * Every currently-frozen item (thaw count > 0) paired with its on-screen
   * tile center, captured right before a pick — an adjacent pick can thaw a
   * frozen neighbor without ever picking it directly, so comparing a
   * before/after snapshot by item identity is what tells
   * playFreezeBreakBursts() which one(s) just broke.
   */
  private snapshotFrozenItems(): Map<QueueItem, Point> {
    const snapshot = new Map<QueueItem, Point>();
    this.sim.queueGrid.forEach((col, x) => {
      col.forEach((cell, y) => {
        if (!cell || this.sim.freezeCount(cell.item) <= 0) return;
        const tileEl = this.queuesEl.querySelector<HTMLElement>(`[data-qx="${x}"][data-qy="${y}"]`);
        if (tileEl) snapshot.set(cell.item, centerOf(tileEl));
      });
    });
    return snapshot;
  }

  /** Plays a small ice-colored particle burst at every item a pick just thawed, per snapshotFrozenItems(). */
  private playFreezeBreakBursts(before: Map<QueueItem, Point>): void {
    if (this.skipMode || before.size === 0) return;
    for (const [item, point] of before) {
      if (this.sim.freezeCount(item) === 0) this.fx.burst(point, 10, ICE_BURST_COLORS);
    }
  }

  /**
   * Ingredient Pick booster: picks the instance at an arbitrary (x,y) instead
   * of a lane's front — same origin-capture dance as performPick(), keyed by
   * pickTargetsAt() instead of pickTargets(). Consumes one Ingredient Pick
   * charge and returns to normal mode only on a successful pick; a blocked
   * pick (e.g. frozen) leaves the booster armed so the player can try another
   * tile.
   */
  private performPickAt(x: number, y: number): void {
    const sim = this.sim;
    const cells = sim.pickTargetsAt(x, y);

    const perLane = new Map<number, number>();
    for (const c of cells) perLane.set(c.x, (perLane.get(c.x) ?? 0) + 1);
    this.lastPickedLanes = perLane;

    this.pendingPickOrigins = cells
      .filter((c) => sim.queueGrid[c.x][c.y]?.item.kind !== "sweeper")
      .map((c) => {
        const tileEl = this.queuesEl.querySelector<HTMLElement>(`[data-qx="${c.x}"][data-qy="${c.y}"]`);
        return tileEl ? centerOf(tileEl) : null;
      })
      .filter((p): p is Point => p !== null);

    const frozenBefore = this.snapshotFrozenItems();
    if (!sim.pickAt(x, y)) {
      this.pendingPickOrigins = [];
      this.lastPickedLanes = new Map();
      return;
    }
    this.playFreezeBreakBursts(frozenBefore);
    this.boosterCharges[1] = Math.max(0, (this.boosterCharges[1] ?? 0) - 1);
    this.ingredientPickMode = false;
    this.dispatchFlights();
    this.playCelebrations();
    this.syncPage();
    this.refreshBoosters();
  }

  /**
   * The four boosters, rendered below the play page as a scroll-only panel —
   * see mount(). Each button shows its icon, name and remaining-charge badge;
   * disabled once its charges reach 0, while the level isn't playing, or
   * (except Ingredient Pick itself, which becomes a "cancel" button) while
   * Ingredient Pick is armed. Charges only decrement on a successful use —
   * see useBooster().
   */
  private boostersBar(): HTMLElement {
    const row = el("div", { class: "boosters-row" });
    GLOBAL_DEFS.boosters.forEach((def, id) => {
      const charges = this.boosterCharges[id] ?? 0;
      const armed = id === 1 && this.ingredientPickMode;
      const btn = button("", () => this.useBooster(id), {
        class: `booster-btn${armed ? " armed" : ""}`,
        title: armed ? "Cancel Ingredient Pick" : def.description,
      }) as HTMLButtonElement;
      btn.disabled =
        !armed &&
        (charges <= 0 || this.sim.status !== "playing" || this.ingredientPickMode);
      btn.append(
        boosterIconEl(id, 48),
        el("span", { class: "booster-name" }, [armed ? "Cancel pick" : def.name]),
        el("span", { class: "booster-charge" }, [`×${charges}`]),
      );
      row.append(btn);
    });
    return el("section", { class: "play-section boosters-bar" }, [
      el("h2", {}, ["Boosters"]),
      row,
    ]);
  }

  /** Rebuild-and-replace: the boosters bar only changes on its own clicks or a pick, never per frame. */
  private refreshBoosters(): void {
    const next = this.boostersBar();
    this.boostersEl.replaceWith(next);
    this.boostersEl = next;
  }

  /**
   * Dispatches a booster button click. Shift-up Row/Clean Table/Auto Complete
   * fire immediately and consume a charge only if they actually changed
   * something; Ingredient Pick just arms/disarms pick mode (see
   * `ingredientPickMode`/queuesTier()) — its charge is spent by
   * performPickAt() once a pick actually lands.
   */
  private useBooster(id: number): void {
    if (this.sim.status !== "playing") return;

    if (id === 1) {
      if (this.ingredientPickMode) {
        this.ingredientPickMode = false;
      } else {
        if ((this.boosterCharges[1] ?? 0) <= 0) return;
        this.ingredientPickMode = true;
      }
      this.rebuildQueuesTier();
      this.refreshBoosters();
      return;
    }

    if ((this.boosterCharges[id] ?? 0) <= 0) return;
    let ok = false;
    switch (id) {
      case 0:
        ok = this.sim.forceShiftUp();
        break;
      case 2:
        ok = this.sim.clearDirtyStacks(BOOSTER_PARAMS.numCleanStack) > 0;
        break;
      case 3:
        ok = this.sim.autoCompleteDish();
        break;
    }
    if (ok) this.boosterCharges[id]--;
    this.dispatchFlights();
    this.playCelebrations();
    this.syncPage();
    this.refreshBoosters();
  }

  /**
   * Playtesting panel content: runs a headless bot (no animation) against the
   * currently-loaded level many times and reports a win/lose tally. Fully
   * independent of the live `this.sim` session — each trial builds its own
   * fresh Simulation, so running a batch never disturbs the game on screen.
   * Lives in the toolbar as its own foldout (see toolbar()/applyBotFoldState()),
   * collapsed by default since it's a playtesting tool, not everyday HUD state.
   */
  private botGroup(): HTMLElement {
    const BOT_OPTIONS: { id: BotType; label: string; title: string }[] = [
      { id: "random", label: "Random", title: "Picks any currently-pickable ingredient at random" },
      { id: "greedy", label: "Greedy", title: "Always picks whatever the current orders need right now" },
    ];

    const botBar = el("div", { class: "speed-bar", role: "radiogroup" });
    for (const option of BOT_OPTIONS) {
      const b = button(
        option.label,
        () => {
          this.botType = option.id;
          this.refreshBotGroup();
        },
        {
          class: this.botType === option.id ? "active" : "",
          role: "radio",
          "data-bot-type": option.id,
          title: option.title,
        },
      );
      botBar.append(b);
    }

    const trialsInput = el("input", {
      type: "number",
      value: String(this.botTrialCount),
      min: "1",
    }) as HTMLInputElement;
    trialsInput.addEventListener("change", () => {
      this.botTrialCount = Math.max(1, Number(trialsInput.value) || 1);
      trialsInput.value = String(this.botTrialCount);
    });

    const playBtn = button(
      this.botRunning ? "Running…" : "▶ Play",
      () => void this.runBotBatch(),
      { class: "primary" },
    );
    playBtn.disabled = this.botRunning;

    const resultsEl = el("div", { class: "bot-results" });
    this.renderBotResults(resultsEl);

    return el("div", { class: "toolbar-bot" }, [
      botBar,
      el("label", { class: "field small" }, ["Trials", trialsInput]),
      playBtn,
      resultsEl,
    ]);
  }

  private renderBotResults(target: HTMLElement): void {
    clear(target);
    const result = this.lastBotBatchResult;
    if (!result) {
      target.append(el("small", { class: "muted" }, ["No runs yet."]));
      return;
    }
    target.append(
      el("span", {}, [`${result.type}: ${result.wins} win${result.wins === 1 ? "" : "s"} / ${result.losses} loss${result.losses === 1 ? "" : "es"} (${result.trials.length} trials)`]),
    );
    if (result.zeroWins) {
      target.append(
        el("span", { class: "warn-badge bad" }, ["⚠ This bot never won a single trial — the level may be unsolvable, or this bot isn't smart enough"]),
      );
    }
  }

  /** Rebuild-and-replace: the bot group only changes on its own clicks, never per frame. */
  private refreshBotGroup(): void {
    const next = this.botGroup();
    this.botGroupEl.replaceWith(next);
    this.botGroupEl = next;
    this.applyBotFoldState();
  }

  /**
   * Runs trials in time-boxed chunks (rather than one at a time) so a small
   * default batch finishes in a single chunk with no perceptible delay, while
   * a user-inflated trial-count/N still yields regularly instead of freezing
   * the tab or stalling the live animated game loop. `bot.ts`'s
   * `runBotTrials` itself stays a plain synchronous function per chunk,
   * simplest to unit-test — the chunking lives here, at the UI boundary.
   */
  private async runBotBatch(): Promise<void> {
    if (this.botRunning) return;
    this.botRunning = true;
    this.refreshBotGroup();

    const type = this.botType;
    const opts = { type };
    const total = this.botTrialCount;
    const CHUNK_BUDGET_MS = 32;
    const trials: BotBatchResult["trials"] = [];

    let i = 0;
    while (i < total) {
      const chunkStart = performance.now();
      let ran = 0;
      // Always run at least one trial per chunk, even if it alone blows the
      // budget, so a single very slow trial can't spin this loop forever.
      do {
        runBotTrials(this.map, this.level, opts, 1).trials.forEach((t) => trials.push(t));
        i++;
        ran++;
      } while (i < total && ran < total && performance.now() - chunkStart < CHUNK_BUDGET_MS);
      // setTimeout, not requestAnimationFrame: rAF never fires for a hidden/
      // backgrounded tab, which would stall the batch indefinitely if the
      // user switches away mid-run.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    const wins = trials.filter((t) => t.status === "won").length;
    this.lastBotBatchResult = {
      type,
      trials,
      wins,
      losses: trials.length - wins,
      zeroWins: wins === 0,
    };
    this.botRunning = false;
    this.refreshBotGroup();
  }

  private queueTile(
    item: QueueItem,
    opts: {
      top?: boolean;
      wanted?: boolean;
      disabled?: boolean;
      preview?: boolean;
      /** Combined-slot cells get a shared tint; linked-slot cells too (their rope is drawn separately). */
      group?: QueueGroupKind;
    },
  ): HTMLElement {
    // The item keeps carrying its Freeze effect for its whole life in the
    // queue (level data is authored/immutable) — whether it still BLOCKS the
    // pick is a separate, decrementing runtime count (see
    // Simulation.freezeCount()/decrementAdjacentFreezes()), so "frozen" here
    // means remaining > 0, not just "has a Freeze effect".
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
      ]
        .filter(Boolean)
        .join(" "),
    });
    tile.append(
      item.kind === "sweeper"
        ? el("span", { class: "tile-main" }, ["🧹"])
        : el("span", { class: "tile-main" }, [ingredientIconEl(item.id, 96)]),
    );
    if (frozen) {
      tile.append(
        el("span", { class: "tile-corner" }, [statusIconEl(EFFECT_FREEZE, 48)]),
        // Bottom-right: how many more ADJACENT picks (see the Freeze
        // mechanic in sim.ts) still needed to break the ice — distinct from
        // the top-left corner's plain "this is frozen" icon.
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
    const nextLevel = won ? this.nextLevel() : null;
    return el("div", { class: `overlay ${won ? "won" : "lost"}` }, [
      el("h2", {}, [won ? "🎉 Level complete" : "💥 Level failed"]),
      el("p", {}, [sim.events.at(-1)?.message ?? ""]),
      el("p", { class: "sub" }, [
        `Served ${sim.servedCount}/${sim.totalCustomers} · ${sim.time.toFixed(1)}s`,
      ]),
      el("div", { class: "overlay-actions" }, [
        ...(nextLevel
          ? [
              button(
                `▶ Next Level: ${nextLevel.name}`,
                () => this.onSelectLevel(nextLevel.id),
                { class: "primary" },
              ),
            ]
          : []),
        button("⟲ Restart", () => this.restart(), { class: nextLevel ? "" : "primary" }),
      ]),
    ]);
  }

  /** The level right after the current one in this map's level list, or null if this is the last one. */
  private nextLevel(): LevelConfig | null {
    const i = this.map.levels.findIndex((l) => l.id === this.level.id);
    return i !== -1 ? (this.map.levels[i + 1] ?? null) : null;
  }

  /** One-more-chance offer on loss — see canOfferSaveMe()/handleSaveMe(). */
  private saveMeOverlay(): HTMLElement {
    const sim = this.sim;
    return el("div", { class: "overlay lost save-me" }, [
      el("h2", {}, ["💥 Level failed"]),
      el("p", {}, [sim.events.at(-1)?.message ?? ""]),
      backpackIconEl(64),
      el("p", { class: "sub" }, [
        "Save Me: collapse the grid's ingredients into your backpack and keep playing.",
      ]),
      el("div", { class: "overlay-actions" }, [
        button("🎒 Save Me", () => this.handleSaveMe(), { class: "primary" }),
        button("Give Up", () => {
          this.saveMeDeclined = true;
          this.overlayEl?.remove();
          this.overlayEl = null;
          this.syncOverlay();
        }),
      ]),
    ]);
  }

  /**
   * Captures every swept grid cell's on-screen position *before* calling
   * sim.saveMe() (which clears them synchronously), then — once the page has
   * re-rendered with the new backpack cell in place — flies a copy of the
   * backpack icon from each captured origin into it. Purely cosmetic: the
   * state change already happened synchronously in saveMe(), so this doesn't
   * gate on Flight/dispatchFlights() like normal transfers do.
   */
  private handleSaveMe(): void {
    const origins: Point[] = [];
    for (let i = 0; i < this.sim.grid.length; i++) {
      const content = this.sim.grid[i];
      if (content.kind !== "cooked" && content.kind !== "raw") continue;
      const cellMain = this.page.querySelector(`[data-cell="${i}"] .cell-main`);
      if (cellMain) origins.push(centerOf(cellMain));
    }

    if (!this.sim.saveMe(BOOSTER_PARAMS.saveMeCount)) return;

    this.renderPage();
    this.refreshBoosters();

    const backpackIndex = this.sim.grid.findIndex((c) => c.kind === "backpack");
    const backpackEl =
      backpackIndex !== -1 ? this.page.querySelector(`[data-cell="${backpackIndex}"]`) : null;
    if (!backpackEl || origins.length === 0 || this.skipMode) return;
    const to = centerOf(backpackEl);
    for (const from of origins) {
      void this.fx.fly(el("div", { class: "fx-item" }, [backpackIconEl(64)]), from, to, {
        durationMs: 480,
      });
    }
    this.fx.burst(to, 12);
  }
}

// ---------- queue-group connectors: linked ropes, combined rails ----------

/** Vertical pitch between two adjacent rows in a lane, measured from its own tiles (real or filler alike). */
function tilePitch(laneEl: HTMLElement): number {
  const tiles = [...laneEl.querySelectorAll<HTMLElement>(".queue-tile")];
  if (tiles.length > 1) {
    return tiles[1].getBoundingClientRect().top - tiles[0].getBoundingClientRect().top;
  }
  return tiles.length === 1 ? tiles[0].getBoundingClientRect().height + 4 : 0;
}

/** Screen-space center of an on-screen (x,y) cell, relative to `host`. */
function realPoint(lanes: HTMLElement, host: DOMRect, x: number, y: number): Point | null {
  const t = lanes.querySelector<HTMLElement>(`[data-qx="${x}"][data-qy="${y}"]`);
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: r.left + r.width / 2 - host.left, y: r.top + r.height / 2 - host.top };
}

/**
 * A straight-line extrapolation of where an off-window row *would* render in
 * lane x, continuing at the lane's own row pitch below its last visible row —
 * this is what lets the rope leave the window at the correct angle instead of
 * just aiming at some arbitrary point.
 */
function virtualPoint(lanes: HTMLElement, host: DOMRect, x: number, y: number): Point | null {
  const laneEl = lanes.querySelector<HTMLElement>(`[data-lane="${x}"]`);
  if (!laneEl) return null;
  const tiles = [...laneEl.querySelectorAll<HTMLElement>(".queue-tile")];
  if (tiles.length === 0) return null;
  const last = tiles[tiles.length - 1];
  const r = last.getBoundingClientRect();
  const pitch = tilePitch(laneEl);
  const rowsBeyond = y - (tiles.length - 1);
  return {
    x: r.left + r.width / 2 - host.left,
    y: r.top + r.height / 2 - host.top + rowsBeyond * pitch,
  };
}

/** Shortens the segment (x1,y1)-(x2,y2) so its (x2,y2) end lands exactly on the window's bottom edge, preserving the true angle. */
function clipToBottom(x1: number, y1: number, x2: number, y2: number, maxY: number): Point {
  if (y2 <= maxY) return { x: x2, y: y2 };
  const t = (maxY - y1) / (y2 - y1);
  return { x: x1 + t * (x2 - x1), y: maxY };
}

/** Adjacent (x,y) cell pairs within the same combined group, both inside the window — checked right/down only so each shared edge is counted once. Carries the group index along so each block can be drawn in its own color (see railColor()). */
function combinedAdjacentPairs(
  sim: Simulation,
  windowRows: number,
): { a: Point; b: Point; group: number }[] {
  const pairs: { a: Point; b: Point; group: number }[] = [];
  for (let x = 0; x < sim.queueGrid.length; x++) {
    for (let y = 0; y < Math.min(sim.queueGrid[x].length, windowRows); y++) {
      const cell = sim.queueGrid[x][y];
      if (!cell || cell.group === -1 || sim.groupKinds[cell.group] !== "combined") continue;
      const right = sim.queueGrid[x + 1]?.[y];
      if (right?.group === cell.group) pairs.push({ a: { x, y }, b: { x: x + 1, y }, group: cell.group });
      const down = y + 1 < windowRows ? sim.queueGrid[x][y + 1] : undefined;
      if (down?.group === cell.group) pairs.push({ a: { x, y }, b: { x, y: y + 1 }, group: cell.group });
    }
  }
  return pairs;
}

/**
 * Draws linked-slot ropes (dashed) and combined-slot rails (solid double
 * lines, one color per combined group — see railColor()) as one SVG overlay,
 * layered above each lane's own panel background but below the tile frames
 * (see .queue-link-overlay's z-index in style.css) so only the gap between
 * two tiles actually shows a line.
 *
 * A linked rope connects each consecutive pair of a group's current cells
 * (sorted front-to-back — the sim itself doesn't preserve an authored chain
 * order beyond membership, since ordering has no gameplay effect) — but only
 * when the pair sits in two ADJACENT columns; a pair two or more columns
 * apart (or in the same column) draws nothing, so a rope never reads as a
 * long diagonal across the board. A partner outside the visible window still
 * gets a segment drawn toward it, clipped at the window edge but at the true
 * angle, so the player can judge how many rows away it is — see
 * virtualPoint()/clipToBottom(). A pair with neither endpoint on screen also
 * draws nothing. A combined rail only connects cells that are both inside
 * the window — a block extending past it just shows its visible part, with
 * no off-window extrapolation (unlike a rope, a rail has no "how far away"
 * question to answer).
 */
function renderGroupOverlay(lanes: HTMLElement, sim: Simulation, windowRows: number): void {
  const linkedGroupIndices = new Set<number>();
  for (const col of sim.queueGrid) {
    for (const cell of col) {
      if (cell && cell.group !== -1 && sim.groupKinds[cell.group] === "linked") {
        linkedGroupIndices.add(cell.group);
      }
    }
  }
  const combinedPairs = combinedAdjacentPairs(sim, windowRows);
  if (linkedGroupIndices.size === 0 && combinedPairs.length === 0) return;

  const host = lanes.getBoundingClientRect();
  const svg = createOverlay(host);

  for (const gi of linkedGroupIndices) {
    const cells: Point[] = [];
    sim.queueGrid.forEach((col, x) => {
      col.forEach((cell, y) => {
        if (cell?.group === gi) cells.push({ x, y });
      });
    });
    // Sorted by COLUMN, not row: Design mode only allows authoring a chain
    // with one member per column in one contiguous run, so column order is
    // the chain's real edge order. Row order would break for a 3+ member
    // chain the instant its members drift onto different rows — linking
    // never restricts movement, so each member rises independently, and a
    // row-based sort would then pair up whichever members happen to share a
    // row rather than whichever are actually adjacent in the chain.
    cells.sort((a, b) => a.x - b.x || a.y - b.y);

    for (let i = 0; i < cells.length - 1; i++) {
      const a = cells[i];
      const b = cells[i + 1];
      if (Math.abs(a.x - b.x) !== 1) continue; // rope only spans two adjacent columns
      const aVisible = a.y < windowRows;
      const bVisible = b.y < windowRows;
      if (!aVisible && !bVisible) continue; // neither endpoint is on screen

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
    for (const [s, e] of railSegments(p1, p2)) {
      appendLine(svg, s, e, "queue-combine-rail", color);
    }
  }

  // Prepended, not appended: paired with .queue-link-overlay's z-index: 0 in
  // style.css, this puts the overlay first in tree order among this stacking
  // context's z-index:0 layer, so it paints under every .queue-tile (which
  // are nested deeper, later in tree order) while still painting over each
  // .queue-lane's own opaque panel background (an unpositioned element,
  // always painted before any z-index:0 layer regardless of DOM position).
  lanes.prepend(svg);
}
