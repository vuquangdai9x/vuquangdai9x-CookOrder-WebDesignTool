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
// Transfers ANIMATE, exactly as legacy does: `instantFlights` is off, so every
// hand-off is a flight the view flies cell-to-cell and only commits on arrival
// (see dispatchFlights). The end-of-level panel, the Save Me offer and the
// booster bar are all here too, driven straight off `NodeSimulation`'s
// already-compatible surface.
//
// Still out of scope: the bot runner, which is a playtesting panel rather than
// gameplay, and the queue-group rope overlay.

import { button, el } from "../dom.ts";
import {
  backpackIconEl,
  cellIconEl,
  dirtyIconEl,
  iconEl,
  ingredientIconEl,
  statusIconEl,
  toolIconEl,
  customerTypeIconEl,
  boosterIconEl,
} from "../icon.ts";
import { localImageUrl } from "../localImages.ts";
import { CELL_COLOR_LOCK, CELL_INGREDIENT_SLOT, EFFECT_FREEZE, EFFECT_HOLDING_KEY } from "../../core/effects.ts";
import { BOOSTER_PARAMS, GLOBAL_DEFS, KEY_COLORS } from "../../data/configLoader.ts";
import { DIRTY_DISH_ID } from "../../core/sim.ts";
import { NodeSimulation } from "../../core/nodeSim.ts";
import type { NodeCustomerState, NodeQueueCell } from "../../core/nodeSim.ts";
import { buildIndex } from "../../core/nodeIndex.ts";
import type { GraphIndex, ProcessStep } from "../../core/nodeIndex.ts";
import type { OutOfSlotPolicy, QueueGroupKind, QueueItem } from "../../core/types.ts";
import { nodeAsMapDef } from "../../data/nodeGraphToMapDef.ts";
import type { ProjectedMap } from "../../data/nodeGraphToMapDef.ts";
import { toNodeLevelConfig } from "../../data/nodeLevel.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import { listNodeMaps, type NodeProjectState } from "../../data/nodeProject.ts";
import { customersStructureKey, middleStructureKey, queuesStructureKey } from "./structureKey.ts";
import { renderGroupOverlay } from "./groupOverlay.ts";
import { centerOf, EffectsLayer } from "../play/effectsLayer.ts";
import type { Point } from "../play/effectsLayer.ts";
import type { NodeFlight } from "../../core/nodeSim.ts";

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

/**
 * Flight kinds that land on (and fill) a customer's dish chip: the two
 * grid/backpack-sourced kinds, plus the two direct-serve kinds that skip the
 * grid entirely. All four need chip-specific targeting and an arrival flash
 * rather than a generic landing at the card's centre.
 */
function fillsDishChip(kind: NodeFlight["kind"]): boolean {
  return (
    kind === "grid-to-customer" ||
    kind === "backpack-to-customer" ||
    kind === "tool-to-customer" ||
    kind === "queue-to-customer"
  );
}

export class NodePlayView {
  private root: HTMLElement;
  private project: NodeProjectState;
  private onSelectLevel: (levelId: number) => void;
  private onSelectMap: (docId: string) => void;

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

  // ---------- flight animation ----------
  //
  // The sim gates every hand-off behind completeFlight(), so a view can either
  // resolve them instantly (what this did) or animate the trip and commit on
  // arrival (what legacy does, and what this does now). `instantFlights` is
  // off, so nothing moves in the model until the animation lands — which is
  // exactly what makes the movement readable rather than a teleport.
  private fx = new EffectsLayer();
  /** Flight ids already being animated, so a frame never launches one twice. */
  private animating = new Set<number>();
  /**
   * Where the tiles a pick just consumed actually were. They leave the DOM
   * before the flights are dispatched, so the click handler stashes their
   * positions — one per flight, in dispatch order, so a group pick's N flights
   * each start from their own tile instead of all sharing the first.
   */
  private pendingPickOrigins: Point[] = [];

  // ---------- boosters ----------
  private boostersEl!: HTMLElement;
  private boosterCharges: number[] = [];
  /** Ingredient Pick armed: every row becomes pickable until one is spent. */
  private ingredientPickMode = false;
  /** Set once the player declines Save Me, so the plain failure overlay takes over. */
  private saveMeDeclined = false;

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
    onSelectMap: (docId: string) => void,
  ) {
    this.root = root;
    this.project = project;
    this.onSelectLevel = onSelectLevel;
    this.onSelectMap = onSelectMap;
    this.ix = buildIndex(project.doc);
    this.projected = nodeAsMapDef(project.doc, this.ix);
    this.level = project.levels.find((l) => l.id === levelId) ?? project.levels[0];
    this.restart();
  }

  destroy(): void {
    this.stopClock();
  }

  /**
   * Queue rows shown per column: the map's default, unless Ingredient Pick is
   * armed — which widens the window so any row can be taken.
   */
  private get windowRows(): number {
    return this.ingredientPickMode
      ? BOOSTER_PARAMS.numRowPick
      : this.project.doc.map.visibleRows || 3;
  }

  private get speedFactor(): number {
    return SPEEDS.find((s) => s.id === this.speedId)?.factor ?? 1;
  }

  /**
   * Skip is instant, not merely fast: flights are committed the moment they
   * are created rather than animated. Animating at 30x would be a blur nobody
   * can read, and each 420ms trip would still gate the hand-off behind it.
   */
  private get skipMode(): boolean {
    return this.speedId === "skip";
  }

  /**
   * The id `dirtyIconEl` wants for a flight's dirty object.
   *
   * The dense dirty index is passed straight through, matching how the grid
   * cell renderer already draws a dirty stack — the icon layer's dirty list is
   * built in the same order, so the two agree. A missing id falls back to the
   * generic dish, which is what the sim itself uses for a composite with no
   * `leavesDirty` edge.
   */
  private dirtyDataId(dense: number | undefined): number {
    return dense === undefined || dense < 0 ? DIRTY_DISH_ID : dense;
  }

  // ---------- lifecycle ----------

  private restart(): void {
    this.stopClock();
    if (!this.level) {
      this.root.replaceChildren(el("p", {}, ["This graph has no levels yet."]));
      return;
    }
    // instantFlights OFF: this view animates every transfer and commits it in
    // the landing callback. With it on, the sim would resolve each hand-off
    // the moment it was created and there would be nothing left to animate.
    this.sim = new NodeSimulation(this.ix, toNodeLevelConfig(this.level), { instantFlights: false });
    this.animating.clear();
    this.pendingPickOrigins = [];
    this.boosterCharges = [...(this.level.boosterCharges ?? [3, 3, 3, 3])];
    this.ingredientPickMode = false;
    this.saveMeDeclined = false;
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
    this.boostersEl = this.boostersBar();
    // The boosters bar is a SIBLING of `.play-page`, not a child: the page has
    // a fixed height with three sized tiers, so a fourth child would shrink
    // them instead of sitting below.
    this.root.replaceChildren(this.weatherLayer(), this.toolbar(), this.page, this.boostersEl);
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
    this.refreshQueueGroupOverlay();
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
        // Keep draining flights after the verdict: the last serve's item is
        // still mid-air, and stopping here would leave it frozen on screen.
        this.dispatchFlights();
        if (this.animating.size === 0) this.stopClock();
        this.syncPage();
        return;
      }
      this.sim.tick((TICK_MS / 1000) * this.speedFactor);
      this.dispatchFlights();
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
      this.refreshQueueGroupOverlay();
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

  /**
   * Launches an animation for every flight the sim has created and not yet
   * had committed. The sim's own state does not change until `.then()` calls
   * `completeFlight`, so what the player sees and what the model believes stay
   * in step.
   */
  private dispatchFlights(): void {
    // A snapshot, not a live view: completeFlight() splices sim.flights, and
    // iterating the array being spliced skips whichever flight shifts into the
    // just-visited slot — which would then linger unresolved into a later tick.
    for (const flight of [...this.sim.flights]) {
      if (this.animating.has(flight.id)) continue;

      // A customer can be promoted from pending and served in the same tick,
      // before syncPage() has rebuilt the tier — until then their card is
      // still the masked "?" one. Hold the flight rather than land an
      // ingredient on a mystery card; this retries every tick.
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
        // Nothing on screen to fly between — commit directly rather than
        // stall the hand-off on a missing element.
        this.sim.completeFlight(flight.id);
        this.animating.delete(flight.id);
        continue;
      }

      const payload = el("div", { class: `fx-item${flight.ing < 0 ? " dirty" : ""}` }, [
        this.flightIcon(flight),
      ]);

      // The exact chip this flight fills, captured now so the arrival flash
      // can be applied to THAT element once it lands.
      const dataId = flight.ing >= 0 ? this.projected.dataIdOf.get(flight.ing) : undefined;
      const targetChip =
        fillsDishChip(flight.kind) && dataId !== undefined
          ? this.page.querySelector<HTMLElement>(
              `[data-customer="${flight.toCustomer!.index}"] [data-dish-ingredient="${dataId}"]:not(.filled)`,
            )
          : null;

      // The sim only clears the source cell when the flight lands, but
      // visually the item should leave the grid as it takes off — otherwise it
      // sits in the cell for the whole trip beside its own flying copy.
      if (flight.kind === "grid-to-customer" && flight.fromCell !== undefined) {
        this.page.querySelector(`[data-cell="${flight.fromCell}"] .cell-main`)?.remove();
      }

      const durationMs = 420 / Math.max(1, this.speedFactor);
      void this.settled(this.fx.fly(payload, from, to, { durationMs }), durationMs + 400)
        .then(() => this.onFlightLanded(flight, to, targetChip))
        .then(() => {
          this.sim.completeFlight(flight.id);
          this.animating.delete(flight.id);
          this.syncPage();
        });
    }
  }

  /**
   * Resolves when `work` does, or when `afterMs` elapses — whichever is first.
   *
   * A flight's arrival is what COMMITS the hand-off, so an animation that
   * never finishes is not a cosmetic problem: the item is stuck in transit,
   * its tool slot stays reserved, and picks that need that slot are refused
   * forever. `Element.animate()` does not advance while the page is not being
   * composited (a background tab, a hidden pane), and `anim.finished` then
   * never settles — so the timeout is the difference between "the animation
   * was skipped" and "the game deadlocked".
   */
  private settled(work: Promise<void>, afterMs: number): Promise<void> {
    return Promise.race([
      work,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          // fly() removes its own flier in the `finished` handler, which never
          // runs in this case — so sweep the ones that are provably not moving.
          // Checked per element rather than clearing the layer, so a flight
          // that IS animating normally is never yanked off screen.
          this.sweepStalledFliers();
          resolve();
        }, Math.max(50, afterMs)),
      ),
    ]);
  }

  /** Removes fliers with no running animation — see `settled`. */
  private sweepStalledFliers(): void {
    for (const flier of document.querySelectorAll<HTMLElement>(".fx-layer .fx-flier")) {
      const running = flier.getAnimations().some((a) => a.playState === "running");
      if (!running) flier.remove();
    }
  }

  /** The artwork a flight carries, resolved from its graph vertex. */
  private flightIcon(flight: NodeFlight): HTMLElement {
    if (flight.ing < 0) return dirtyIconEl(this.dirtyDataId(flight.dirtyId), 96);
    return this.ingredientIconForDense(flight.ing, 96);
  }

  /**
   * Simulation items use dense graph indices, while the shared raw/cooked
   * helpers use positional level-data ids. Intermediate ingredients are not
   * addressable by level strings and therefore intentionally have no such id.
   * Resolve their artwork from the graph vertex so they still retain their
   * local image while waiting on the grid, sitting in a tool, or flying.
   */
  private ingredientIconForDense(ing: number, size: number): HTMLElement {
    const name = this.ix.ingName[ing];
    const vertex = this.project.doc.vertices.ingredient.find((value) => value.name === name);
    return iconEl(
      vertex
        ? {
            name: vertex.displayName || vertex.name,
            emoji: vertex.emoji ?? "\u2754",
            fileId: vertex.fileId,
            localImage: vertex.localImage,
            imageURL: vertex.imageURL,
          }
        : undefined,
      { size, className: "icon-ingredient" },
    );
  }

  /**
   * Per-kind landing feedback, played BEFORE the flight is committed — so it
   * marks this arrival (the chip is still unfilled, the stack still on the
   * grid) rather than reading as a generic after-the-fact effect.
   */
  private onFlightLanded(flight: NodeFlight, at: Point, targetChip: HTMLElement | null): Promise<void> {
    if (this.skipMode) return Promise.resolve();
    if (fillsDishChip(flight.kind) && targetChip) {
      this.fx.burst(at, 8);
      targetChip.classList.add("arrival-flash");
      // Flash while still unfilled, then let completeFlight dim it.
      return new Promise((resolve) => setTimeout(resolve, 160));
    }
    if (flight.kind === "dirty-to-staff") this.fx.burst(at, 8);
    return Promise.resolve();
  }

  private flightOrigin(flight: NodeFlight): Point | null {
    if (flight.fromCustomer !== undefined) {
      const card = this.page.querySelector(`[data-customer="${flight.fromCustomer}"]`);
      return card ? centerOf(card) : null;
    }
    if (flight.fromCell !== undefined) {
      const cell = this.page.querySelector(`[data-cell="${flight.fromCell}"]`);
      return cell ? centerOf(cell) : null;
    }
    if (flight.fromTool) {
      const slot = this.page.querySelector(`[data-slot="${flight.fromTool.tool}:${flight.fromTool.slot}"]`);
      return slot ? centerOf(slot) : null;
    }
    // A queue flight starts at the tile the pick consumed — already gone from
    // the DOM, so the click handler stashed its position.
    if (this.pendingPickOrigins.length > 0) return this.pendingPickOrigins.shift()!;
    const lane = this.page.querySelector(".queue-lanes.play .queue-tile.top");
    return lane ? centerOf(lane) : null;
  }

  private flightTarget(flight: NodeFlight): Point | null {
    if (flight.toTool) {
      const slot = this.page.querySelector(`[data-slot="${flight.toTool.tool}:${flight.toTool.slot}"]`);
      return slot ? centerOf(slot) : null;
    }
    if (flight.toCell !== undefined) {
      const cell = this.page.querySelector(`[data-cell="${flight.toCell}"]`);
      return cell ? centerOf(cell) : null;
    }
    if (flight.toCustomer) {
      const card = this.page.querySelector(`[data-customer="${flight.toCustomer.index}"]`);
      if (!card) return null;
      const dataId = flight.ing >= 0 ? this.projected.dataIdOf.get(flight.ing) : undefined;
      if (fillsDishChip(flight.kind) && dataId !== undefined) {
        // Aim at the specific unfilled chip this item satisfies, so the flash
        // and burst land exactly on the matching ingredient position.
        const chip = card.querySelector(`[data-dish-ingredient="${dataId}"]:not(.filled)`);
        if (chip) return centerOf(chip);
      }
      return centerOf(card);
    }
    return null;
  }

  private syncOverlay(): void {
    // Wait for every still-flying item to land: the panel is opaque and
    // full-page, so popping it up the instant the verdict lands would hide
    // whatever is mid-air behind it instead of letting it arrive.
    const shouldShow = this.sim.status !== "playing" && this.animating.size === 0;
    if (shouldShow && !this.overlayEl) {
      this.overlayEl = this.canOfferSaveMe() ? this.saveMeOverlay() : this.overlay();
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
    const mapPicker = el("select", { class: "map-picker" }) as HTMLSelectElement;
    for (const map of listNodeMaps()) {
      const opt = el("option", { value: map.id }, [map.name]);
      if (map.id === this.project.docId) (opt as HTMLOptionElement).selected = true;
      mapPicker.append(opt);
    }
    mapPicker.addEventListener("change", () => this.onSelectMap(mapPicker.value));

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
      el("label", { class: "field small" }, ["Map", mapPicker]),
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
        }, [this.ingredientIconForDense(ing, 64)]);
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
        cell.append(el("span", { class: "cell-main" }, [this.ingredientIconForDense(content.ing, 96)]));
        if (content.usesLeft && content.usesLeft > 1) {
          cell.append(el("small", { class: "cell-badge uses-left" }, [`×${content.usesLeft}`]));
        }
      } else if (content.kind === "raw") {
        cell.append(
          el("span", { class: "cell-main parked" }, [this.ingredientIconForDense(content.ing, 96)]),
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

      // Slot POINTS are visible when a tool has more than one: a coffee machine
      // that needs a cup should say so, or a half-filled machine reads as
      // broken rather than waiting. A single-point tool renders exactly as
      // before — an unlabelled row of slots.
      const multiPoint = tool.layout.points.length > 1;
      const slots = el("div", { class: `tool-slots${multiPoint ? " multi-point" : ""}` });
      tool.layout.points.forEach((point, pointIndex) => {
        const group = multiPoint ? el("div", { class: "slot-point" }) : slots;
        if (multiPoint) {
          group.append(el("span", { class: "slot-point-name" }, [point.name]));
          slots.append(group);
        }
        for (let lane = 0; lane < point.lanes; lane++) {
          const i = tool.layout.flat.findIndex((a) => a.point === pointIndex && a.lane === lane);
          if (i === -1) continue;
          const slot = tool.slots[i];
          const bar = el("div", { class: "bar" });
          if (slot.item) {
            bar.style.width = `${Math.min(100, (slot.item.elapsed / slot.item.duration) * 100)}%`;
          }
          this.barEls.set(`${tool.index}:${i}`, bar);
          const node = el("div", {
            class: `tool-slot${slot.item ? " busy" : ""}`,
            "data-slot": `${tool.index}:${i}`,
            title: multiPoint ? `${point.name} · lane ${lane + 1}` : "",
          });
          if (slot.item) {
            node.append(
              el("span", { class: "slot-item" }, [this.ingredientIconForDense(slot.item.ing, 96)]),
            );
          }
          node.append(el("div", { class: "bar-track" }, [bar]));
          group.append(node);
        }
      });

      const def = this.projected.map.tools.find((t) => t.name === tool.displayName);
      const toolEl = el("div", {
        class: `tool${unused ? " unused" : ""}`,
        title:
          `${tool.displayName} — ${tool.layout.points.map((p) => `${p.name} ×${p.lanes}`).join(", ")}` +
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
          // With Ingredient Pick armed every row is live, so nothing is a
          // greyed-out "preview" and nothing is disabled.
          preview: !isTop && !this.ingredientPickMode,
          wanted,
          disabled: isTop && !this.ingredientPickMode && !check.ok,
          group: groupKind,
          hidden,
        });
        tile.dataset.qx = String(x);
        tile.dataset.qy = String(y);
        if (this.ingredientPickMode) {
          tile.title = "Pick this ingredient";
          tile.addEventListener("click", () => this.performPick(x, y, true));
        } else if (isTop) {
          tile.title = check.reason ?? "Pick this ingredient";
          if (check.ok) tile.addEventListener("click", () => this.performPick(x, y, false));
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

  /**
   * One pick, from the top row or — with Ingredient Pick armed — from any row.
   *
   * The tiles' on-screen positions are captured BEFORE the pick, because the
   * pick removes them and a flight's origin has to be where the player
   * actually clicked. The booster's charge is spent here rather than when it
   * was armed, so arming and cancelling costs nothing.
   */
  private performPick(x: number, y: number, viaBooster: boolean): void {
    const cells = viaBooster ? this.sim.pickTargetsAt(x, y) : this.sim.pickTargets(x);
    this.pendingPickOrigins = cells
      .map((c) => this.page.querySelector(`.queue-tile[data-qx="${c.x}"][data-qy="${c.y}"]`))
      .filter((node): node is Element => node !== null)
      .map(centerOf);

    const ok = viaBooster ? this.sim.pickAt(x, y) : this.sim.pick(x);
    if (!ok) {
      this.pendingPickOrigins = [];
      return;
    }
    if (viaBooster) {
      this.boosterCharges[1] = Math.max(0, (this.boosterCharges[1] ?? 0) - 1);
      this.ingredientPickMode = false;
      this.rebuildQueuesTier();
      this.refreshBoosters();
    }
    this.dispatchFlights();
    this.syncPage();
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
    tile.append(
      opts.hidden
        ? el("span", { class: "tile-main" }, [el("span", { class: "hidden-mark" }, ["?"])])
        : item.kind === "sweeper"
          ? el("span", { class: "tile-main" }, ["🧹"])
          : el("span", { class: "tile-main" }, [this.ingredientIconForDense(cell.ing, 96)]),
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

  /**
   * The end-of-level panel, matching the legacy one button for button: the
   * last event's message, the served/time line, "Next Level" when one exists
   * and the level was won, and Restart.
   */
  private overlay(): HTMLElement {
    const sim = this.sim;
    const won = sim.status === "won";
    const next = won ? this.nextLevel() : null;
    return el("div", { class: `overlay ${won ? "won" : "lost"}` }, [
      el("h2", {}, [won ? "\u{1F389} Level complete" : "\u{1F4A5} Level failed"]),
      el("p", {}, [sim.events.at(-1)?.message ?? ""]),
      el("p", { class: "sub" }, [
        `Served ${sim.servedCount}/${sim.totalCustomers} \u00b7 ${sim.time.toFixed(1)}s`,
      ]),
      el("div", { class: "overlay-actions" }, [
        ...(next
          ? [button(`\u25B6 Next Level: ${next.name}`, () => this.onSelectLevel(next.id), { class: "primary" })]
          : []),
        button("\u27F2 Restart", () => this.restart(), { class: next ? "" : "primary" }),
      ]),
    ]);
  }

  /** The level after this one in the project's list, or null if this is the last. */
  private nextLevel(): LevelData | null {
    const i = this.project.levels.findIndex((l) => l.id === this.level.id);
    return i !== -1 ? (this.project.levels[i + 1] ?? null) : null;
  }

  /** One-more-chance offer on loss — see canOfferSaveMe()/handleSaveMe(). */
  private saveMeOverlay(): HTMLElement {
    const sim = this.sim;
    return el("div", { class: "overlay lost save-me" }, [
      el("h2", {}, ["\u{1F4A5} Level failed"]),
      el("p", {}, [sim.events.at(-1)?.message ?? ""]),
      backpackIconEl(64),
      el("p", { class: "sub" }, [
        "Save Me: collapse the grid's ingredients into your backpack and keep playing.",
      ]),
      el("div", { class: "overlay-actions" }, [
        button("\u{1F392} Save Me", () => this.handleSaveMe(), { class: "primary" }),
        button("Give Up", () => {
          this.saveMeDeclined = true;
          this.overlayEl?.remove();
          this.overlayEl = null;
          this.syncOverlay();
        }),
      ]),
    ]);
  }

  /** Whether the Save Me offer, rather than the plain failure panel, shows on this loss. */
  private canOfferSaveMe(): boolean {
    const cap = BOOSTER_PARAMS.saveMeCount;
    return this.sim.status === "lost" && !this.saveMeDeclined && (cap < 0 || this.sim.saveMeUsed < cap);
  }

  /**
   * Captures every swept cell's on-screen position BEFORE `saveMe()` clears
   * them, then flies a backpack icon from each into the new backpack cell.
   * Purely cosmetic — the state change already happened synchronously, so this
   * does not gate on a Flight the way a normal transfer does.
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

    this.fullRender();
    this.refreshBoosters();
    this.startClock();

    const at = this.sim.grid.findIndex((c) => c.kind === "backpack");
    const backpack = at !== -1 ? this.page.querySelector(`[data-cell="${at}"]`) : null;
    if (!backpack || origins.length === 0 || this.skipMode) return;
    const to = centerOf(backpack);
    for (const from of origins) {
      void this.fx.fly(el("div", { class: "fx-item" }, [backpackIconEl(64)]), from, to, {
        durationMs: 480,
      });
    }
  }

  // ---------- boosters ----------

  private boostersBar(): HTMLElement {
    const row = el("div", { class: "boosters-row" });
    GLOBAL_DEFS.boosters.forEach((def, id) => {
      const charges = this.boosterCharges[id] ?? 0;
      const armed = id === 1 && this.ingredientPickMode;
      const btn = button("", () => this.useBooster(id), {
        class: `booster-btn${armed ? " armed" : ""}`,
        title: armed ? "Cancel Ingredient Pick" : def.description,
      }) as HTMLButtonElement;
      btn.disabled = !armed && (charges <= 0 || this.sim.status !== "playing" || this.ingredientPickMode);
      btn.append(
        boosterIconEl(id, 48),
        el("span", { class: "booster-name" }, [armed ? "Cancel pick" : def.name]),
        el("span", { class: "booster-charge" }, [`\u00d7${charges}`]),
      );
      row.append(btn);
    });
    return el("section", { class: "play-section boosters-bar" }, [el("h2", {}, ["Boosters"]), row]);
  }

  /** Rebuild-and-replace: the bar changes on its own clicks or a pick, never per tick. */
  private refreshBoosters(): void {
    const next = this.boostersBar();
    this.boostersEl.replaceWith(next);
    this.boostersEl = next;
  }

  /**
   * Shift-up Row, Clean Table and Auto Complete fire immediately and spend a
   * charge only if they actually changed something. Ingredient Pick instead
   * ARMS pick mode — its charge is spent by the pick that follows, because
   * arming and then cancelling should cost nothing.
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
    this.syncPage();
    this.refreshBoosters();
  }

  /** Rebuilds the queues tier unconditionally — arming Ingredient Pick changes `windowRows` without changing sim state. */
  private rebuildQueuesTier(): void {
    const next = this.queuesTier();
    this.queuesEl.replaceWith(next);
    this.queuesEl = next;
    this.queuesKey = queuesStructureKey(this.sim);
    this.refreshQueueGroupOverlay();
  }

  /**
   * Draws the linked-rope / combined-rail overlay for the queues tier.
   *
   * Must run only once `this.queuesEl` is actually IN the document: the
   * geometry comes from getBoundingClientRect(), which returns all zeros on a
   * detached tree, so doing this inside queuesTier() would silently produce an
   * overlay of zero-length lines. That is why every caller sits immediately
   * after the attach, not before it.
   */
  private refreshQueueGroupOverlay(): void {
    const lanes = this.queuesEl.querySelector<HTMLElement>(".queue-lanes");
    if (lanes) renderGroupOverlay(lanes, this.sim, this.windowRows);
  }

}
