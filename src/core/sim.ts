// Deterministic gameplay simulation. Pure TS: no DOM, no timers of its own —
// the host drives it with tick(dt). See docs/GDD.md §2.

import "./effects.ts"; // registers built-in behaviors
import {
  CUSTOMER_STAFF,
  EFFECT_HOLDING_KEY,
} from "./effects.ts";
import type { EffectContext } from "./registry.ts";
import { getCellEffect, getCustomerType, getQueueEffect } from "./registry.ts";
import type {
  CustomerConfig,
  Dish,
  Id,
  LevelConfig,
  MapDef,
  QueueItem,
} from "./types.ts";

export type SimStatus = "playing" | "won" | "lost";

export type LoseReason =
  | "grid-overflow"
  | "dirty-overflow"
  | "out-of-ingredient"
  | "customer-timeout";

/** One item moving through prepare -> cook. */
export interface PipelineItem {
  uid: number;
  rawId: Id;
  /** Seconds elapsed in the current stage. */
  elapsed: number;
  stage: "prepare" | "cook";
  prepareTime: number;
  cookTime: number;
}

export type CellContent =
  | { kind: "empty" }
  | { kind: "cooked"; cookedId: Id }
  | { kind: "dirty"; count: number };

export interface DishState {
  /** Cooked ingredient ids still needed, in order. */
  remaining: Id[];
  /** Ids already delivered. */
  filled: Id[];
  effects: Dish["effects"];
}

export interface CustomerState {
  index: number;
  config: CustomerConfig;
  dishes: DishState[];
  /** Seconds left on the patience timer; Infinity when waitTime is 0. */
  timeLeft: number;
  isStaff: boolean;
}

export interface SimEvent {
  type:
    | "pick"
    | "cooked"
    | "served"
    | "customer-arrived"
    | "customer-timeout"
    | "dirty-added"
    | "dirty-cleared"
    | "won"
    | "lost";
  message: string;
  atTime: number;
}

export interface SimOptions {
  /** Fires whenever queues run dry with orders outstanding. Default: lose. */
  onOutOfIngredient?(sim: Simulation): void;
}

/** A customer with no dishes is a staff member (clears dirty stacks). */
function isStaffCustomer(c: CustomerConfig): boolean {
  return c.dishes.length === 0;
}

export class Simulation {
  readonly level: LevelConfig;
  readonly map: MapDef;

  status: SimStatus = "playing";
  loseReason: LoseReason | null = null;
  time = 0;

  /** Remaining items per queue; index 0 is the pickable top. */
  queues: QueueItem[][];
  pipeline: PipelineItem[] = [];
  grid: CellContent[];
  /** Customers not yet in a serve slot. */
  pending: CustomerState[];
  /** Customers currently occupying serve slots. */
  active: CustomerState[] = [];
  servedCount = 0;
  events: SimEvent[] = [];

  private ctx: EffectContext = {
    picksMade: 0,
    picksByIngredient: {},
    ordersCompleted: 0,
    keysByColor: {},
  };
  private nextUid = 1;
  private options: SimOptions;
  /** Insertion order of dirty stacks, as grid indices (oldest first). */
  private dirtyOrder: number[] = [];

  constructor(map: MapDef, level: LevelConfig, options: SimOptions = {}) {
    this.map = map;
    this.level = level;
    this.options = options;
    this.queues = level.queues.map((q) => [...q]);
    this.grid = level.grid.map(() => ({ kind: "empty" }) as CellContent);
    this.pending = level.customers.map((config, index) => ({
      index,
      config,
      dishes: config.dishes.map((d) => ({
        remaining: [...d.cookedIds],
        filled: [],
        effects: d.effects,
      })),
      timeLeft: this.customerTime(config),
      isStaff: isStaffCustomer(config),
    }));
    this.fillSlots();
  }

  // ---------- public API ----------

  get totalCustomers(): number {
    return this.level.customers.length;
  }

  get effectContext(): Readonly<EffectContext> {
    return this.ctx;
  }

  /** True when a queue's top item may be picked right now. */
  canPick(queueIndex: number): { ok: boolean; reason?: string } {
    if (this.status !== "playing") return { ok: false, reason: "Level finished" };
    const item = this.queues[queueIndex]?.[0];
    if (!item) return { ok: false, reason: "Queue empty" };
    for (const effect of item.effects) {
      const check = getQueueEffect(effect.effectId).canPick?.(effect, this.ctx);
      if (check && !check.ok) return check;
    }
    return { ok: true };
  }

  /** Pick the top item of a queue. Returns false when the pick is not allowed. */
  pick(queueIndex: number): boolean {
    if (!this.canPick(queueIndex).ok) return false;
    const item = this.queues[queueIndex].shift()!;

    for (const effect of item.effects) {
      getQueueEffect(effect.effectId).onPick?.(effect, this.ctx);
    }

    if (item.kind === "sweeper") {
      const cleared = this.clearDirtyStacks(1);
      this.log("pick", `Sweeper used (${cleared} stack cleared)`);
      return true;
    }

    this.ctx.picksMade++;
    this.ctx.picksByIngredient[item.id] = (this.ctx.picksByIngredient[item.id] ?? 0) + 1;
    const def = this.map.rawIngredients.find((r) => r.id === item.id);
    this.pipeline.push({
      uid: this.nextUid++,
      rawId: item.id,
      elapsed: 0,
      stage: (def?.prepareTime ?? 0) > 0 ? "prepare" : "cook",
      prepareTime: def?.prepareTime ?? 0,
      cookTime: def?.cookTime ?? 0,
    });
    this.log("pick", `Picked ${def?.name ?? item.id}`);
    return true;
  }

  /** Advance the simulation by `dt` seconds. */
  tick(dt: number): void {
    if (this.status !== "playing") return;
    this.time += dt;
    this.advancePipeline(dt);
    // Settle before checking patience: food that lands this step counts as
    // delivered in time, and a customer entering a freed slot gets their turn
    // at the grid in the same step.
    this.settle();
    this.advanceCustomers(dt);
    this.checkEnd();
  }

  /**
   * Fast-forwards everything already in motion — cooking finishes, matching
   * customers are served — and stops as soon as the level needs another pick.
   * Time still advances realistically so patience timers stay honest.
   */
  fastForward(maxSeconds = 600): number {
    const start = this.time;
    while (
      this.status === "playing" &&
      this.pipeline.length > 0 &&
      this.time - start < maxSeconds
    ) {
      // Step only as far as the next thing that can change the outcome, so a
      // customer never times out inside a step that would have served them.
      const completion = this.nextCompletionIn();
      const timeout = Math.min(...this.active.map((c) => c.timeLeft), Infinity);
      const step = Math.min(completion ?? Infinity, timeout);
      this.tick(Number.isFinite(step) && step > 0 ? step : 0.05);
    }
    return this.time - start;
  }

  /** Run until the level resolves. Used by tests and headless validation. */
  runToEnd(step = 0.25, maxSeconds = 3600): void {
    let elapsed = 0;
    while (this.status === "playing" && elapsed < maxSeconds) {
      this.tick(step);
      elapsed += step;
    }
  }

  /** Seconds until the next pipeline item finishes, or null when idle. */
  nextCompletionIn(): number | null {
    let best: number | null = null;
    for (const item of this.pipeline) {
      const total = item.stage === "prepare" ? item.prepareTime : item.cookTime;
      const left = total - item.elapsed + (item.stage === "prepare" ? item.cookTime : 0);
      if (best === null || left < best) best = left;
    }
    return best;
  }

  /** Cooked ingredients the currently serveable customers still need. */
  neededCookedIds(): Set<Id> {
    const set = new Set<Id>();
    for (const customer of this.active) {
      for (const dish of customer.dishes) for (const id of dish.remaining) set.add(id);
    }
    return set;
  }

  /** Whether a grid cell can currently hold an item (per its cell effects). */
  isCellUsable(index: number): boolean {
    const config = this.level.grid[index];
    if (!config) return false;
    return config.effects.every((e) => getCellEffect(e.effectId).isUsable(e, this.ctx));
  }

  /** UI label for a locked cell, e.g. "2/3 orders". */
  cellLockLabel(index: number): string | null {
    const config = this.level.grid[index];
    if (!config) return null;
    for (const e of config.effects) {
      const handler = getCellEffect(e.effectId);
      if (!handler.isUsable(e, this.ctx)) return handler.progressLabel?.(e, this.ctx) ?? "locked";
    }
    return null;
  }

  // ---------- internals ----------

  private customerTime(c: CustomerConfig): number {
    if (c.waitTime <= 0) return Infinity;
    // Weather-affected customers are impatient when the level has bad weather.
    const bad = this.level?.weather && this.level.weather !== "Normal";
    return c.weatherEff === 1 && bad ? c.waitTime / 2 : c.waitTime;
  }

  private advancePipeline(dt: number): void {
    for (const item of [...this.pipeline]) {
      item.elapsed += dt;
      if (item.stage === "prepare" && item.elapsed >= item.prepareTime) {
        item.elapsed -= item.prepareTime;
        item.stage = "cook";
      }
      if (item.stage === "cook" && item.elapsed >= item.cookTime) {
        this.pipeline.splice(this.pipeline.indexOf(item), 1);
        this.outputCooked(item.rawId);
        if (this.status !== "playing") return;
      }
    }
  }

  private outputCooked(rawId: Id): void {
    const mapping = this.map.cookMappings.find((m) => m.rawId === rawId);
    const cookedIds = mapping?.cookedIds ?? [rawId];
    for (const cookedId of cookedIds) {
      const cell = this.findFreeCell();
      if (cell === -1) {
        this.lose("grid-overflow", "No free grid cell for a cooked ingredient");
        return;
      }
      this.grid[cell] = { kind: "cooked", cookedId };
      const def = this.map.cookedIngredients.find((c) => c.id === cookedId);
      this.log("cooked", `${def?.name ?? cookedId} ready`);
    }
  }

  private findFreeCell(): number {
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i].kind === "empty" && this.isCellUsable(i)) return i;
    }
    return -1;
  }

  private advanceCustomers(dt: number): void {
    for (const customer of [...this.active]) {
      if (customer.timeLeft === Infinity) continue;
      customer.timeLeft -= dt;
      if (customer.timeLeft <= 0) {
        this.log("customer-timeout", `Customer ${customer.index + 1} ran out of patience`);
        this.lose("customer-timeout", `Customer ${customer.index + 1} left unserved`);
        return;
      }
    }
  }

  /**
   * Fills serve slots and matches grid items to dishes, repeating while either
   * makes progress — so a chain of completions in one step fully resolves.
   */
  private settle(): void {
    for (let guard = 0; guard < 100; guard++) {
      const before = this.servedCount;
      this.fillSlots();
      this.autoServe();
      if (this.status !== "playing") return;
      if (this.servedCount === before) return;
    }
  }

  /** Moves matching cooked ingredients from the grid into customer dishes (FCFS). */
  private autoServe(): void {
    for (const customer of [...this.active]) {
      for (const dish of customer.dishes) {
        for (const needed of [...dish.remaining]) {
          const cell = this.grid.findIndex(
            (c) => c.kind === "cooked" && c.cookedId === needed,
          );
          if (cell === -1) continue;
          this.grid[cell] = { kind: "empty" };
          dish.remaining.splice(dish.remaining.indexOf(needed), 1);
          dish.filled.push(needed);
        }
      }
      if (customer.dishes.every((d) => d.remaining.length === 0)) {
        this.completeCustomer(customer);
        if (this.status !== "playing") return;
      }
    }
  }

  private completeCustomer(customer: CustomerState): void {
    this.active.splice(this.active.indexOf(customer), 1);
    this.servedCount++;
    this.ctx.ordersCompleted++;
    this.log("served", `Customer ${customer.index + 1} served`);
    this.addDirtyDish();
  }

  /** A departing customer leaves one dirty dish, stacking up to dirtyStackHeight. */
  private addDirtyDish(): void {
    const height = this.level.dirtyStackHeight || 1;
    const openStack = this.dirtyOrder.find((i) => {
      const cell = this.grid[i];
      return cell.kind === "dirty" && cell.count < height;
    });
    if (openStack !== undefined) {
      const cell = this.grid[openStack] as { kind: "dirty"; count: number };
      cell.count++;
      return;
    }
    const free = this.findFreeCell();
    if (free === -1) {
      this.lose("dirty-overflow", "No free grid cell for a dirty dish");
      return;
    }
    this.grid[free] = { kind: "dirty", count: 1 };
    this.dirtyOrder.push(free);
    this.log("dirty-added", `Dirty ${this.map.dirtyDishName} stacked`);
  }

  /** Removes up to `count` oldest dirty stacks. Returns how many were cleared. */
  clearDirtyStacks(count: number): number {
    let cleared = 0;
    while (cleared < count && this.dirtyOrder.length > 0) {
      const index = this.dirtyOrder.shift()!;
      if (this.grid[index].kind === "dirty") {
        this.grid[index] = { kind: "empty" };
        cleared++;
      }
    }
    if (cleared > 0) this.log("dirty-cleared", `Cleared ${cleared} dirty stack(s)`);
    return cleared;
  }

  /** Moves pending customers into free serve slots. */
  private fillSlots(): void {
    while (this.active.length < this.level.serveableSlots && this.pending.length > 0) {
      const customer = this.pending.shift()!;
      if (customer.isStaff) {
        const handler = getCustomerType(CUSTOMER_STAFF);
        handler.onArrive?.([1], { clearDirtyStacks: (n) => void this.clearDirtyStacks(n) });
        this.servedCount++;
        this.log("customer-arrived", `Staff cleared dirty stacks`);
        continue;
      }
      this.active.push(customer);
      this.log("customer-arrived", `Customer ${customer.index + 1} is ordering`);
    }
  }

  private checkEnd(): void {
    if (this.status !== "playing") return;
    if (this.servedCount >= this.totalCustomers) {
      this.status = "won";
      this.log("won", `All ${this.totalCustomers} customers served`);
      return;
    }
    const queuesEmpty = this.queues.every((q) => q.length === 0);
    if (queuesEmpty && this.pipeline.length === 0 && this.active.length > 0) {
      if (this.options.onOutOfIngredient) this.options.onOutOfIngredient(this);
      else this.lose("out-of-ingredient", "Queues empty with orders outstanding");
    }
  }

  private lose(reason: LoseReason, message: string): void {
    if (this.status !== "playing") return;
    this.status = "lost";
    this.loseReason = reason;
    this.log("lost", message);
  }

  private log(type: SimEvent["type"], message: string): void {
    this.events.push({ type, message, atTime: this.time });
    if (this.events.length > 200) this.events.shift();
  }
}

/** Ids of key colors a level's queue items can carry (for UI legends). */
export function keyColorsUsed(level: LevelConfig): number[] {
  const colors = new Set<number>();
  for (const queue of level.queues) {
    for (const item of queue) {
      for (const e of item.effects) {
        if (e.effectId === EFFECT_HOLDING_KEY) colors.add(e.params[0] ?? 0);
      }
    }
  }
  return [...colors].sort((a, b) => a - b);
}
