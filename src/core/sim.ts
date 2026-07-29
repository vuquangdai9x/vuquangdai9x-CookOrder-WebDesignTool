// Deterministic gameplay simulation. Pure TS: no DOM, no timers of its own —
// the host drives it with tick(dt). See docs/GDD.md §2.
//
// Ingredients are processed by cooking tools with a fixed number of slots.
// Every hand-off between places (queue → tool, tool → grid, grid → customer…)
// is a *flight*: the sim parks it in `flights` and does not apply its effect
// until the host calls completeFlight(). That lets the view animate an item
// travelling and guarantees the next logic step only runs once it lands.

import "./effects.ts"; // registers built-in behaviors
import { CUSTOMER_STAFF, EFFECT_HOLDING_KEY } from "./effects.ts";
import type { EffectContext } from "./registry.ts";
import { getCellEffect, getCustomerType, getQueueEffect } from "./registry.ts";
import type {
  CookingToolDef,
  CustomerConfig,
  Dish,
  Id,
  LevelConfig,
  MapDef,
  OutOfSlotPolicy,
  QueueItem,
} from "./types.ts";
import { findToolRecipe } from "./types.ts";

export type SimStatus = "playing" | "won" | "lost";

/** Sentinel itemId for a dirty dish in flight — it is not an ingredient. */
export const DIRTY_DISH_ID = -99;

export type LoseReason =
  | "grid-overflow"
  | "dirty-overflow"
  | "out-of-ingredient"
  | "customer-timeout";

/** One occupied tool slot. */
export interface ToolSlotState {
  /** null when the slot is free. */
  item: { uid: number; rawId: Id; elapsed: number } | null;
}

export interface ToolState {
  def: CookingToolDef;
  slots: ToolSlotState[];
}

export type CellContent =
  | { kind: "empty" }
  /** A finished ingredient waiting to be served. */
  | { kind: "cooked"; cookedId: Id }
  /** A raw ingredient parked because its tool was full (park-on-grid policy). */
  | { kind: "raw"; rawId: Id }
  | { kind: "dirty"; count: number };

export interface DishState {
  remaining: Id[];
  filled: Id[];
  effects: Dish["effects"];
}

export interface CustomerState {
  index: number;
  config: CustomerConfig;
  dishes: DishState[];
  timeLeft: number;
  isStaff: boolean;
  /** Set the moment the last dish completes, for the celebration animation. */
  justCompleted?: boolean;
}

// ---------- flights ----------

export type FlightKind =
  | "queue-to-tool"
  | "queue-to-grid"
  | "tool-to-grid"
  | "grid-to-tool"
  | "grid-to-customer"
  /** The dirty dish a departing customer leaves behind. */
  | "customer-to-grid";

export interface Flight {
  id: number;
  kind: FlightKind;
  /** Ingredient id being carried (raw id for the *-to-tool kinds, cooked otherwise). */
  itemId: Id;
  /** Source grid cell, for flights that start on the grid. */
  fromCell?: number;
  /** Source tool/slot, for tool-to-grid. */
  fromTool?: { toolId: Id; slot: number };
  /** Destination tool/slot, for the *-to-tool kinds. */
  toTool?: { toolId: Id; slot: number };
  /** Destination grid cell, for flights that end on the grid. */
  toCell?: number;
  /** Destination customer, for grid-to-customer. */
  toCustomer?: { index: number; dish: number };
  /** Source customer, for customer-to-grid (the dirty dish). */
  fromCustomer?: number;
  /** queue-to-grid only: true when the item is parked raw, awaiting a tool slot. */
  raw?: boolean;
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
  /** Customer index, for events the view wants to animate. */
  customerIndex?: number;
}

export interface SimOptions {
  /** Fires when queues run dry with orders outstanding. Default: lose. */
  onOutOfIngredient?(sim: Simulation): void;
  /** What to do when a picked ingredient's tool is full. */
  outOfSlotPolicy?: OutOfSlotPolicy;
  /**
   * When true (the default) flights land the moment they are created, so the
   * sim runs standalone — headless validation and tests need no host. A view
   * that animates transfers passes false and calls completeFlight() itself.
   */
  instantFlights?: boolean;
}

const isStaffCustomer = (c: CustomerConfig) => c.dishes.length === 0;

export class Simulation {
  readonly level: LevelConfig;
  readonly map: MapDef;

  status: SimStatus = "playing";
  loseReason: LoseReason | null = null;
  time = 0;

  queues: QueueItem[][];
  tools: ToolState[];
  grid: CellContent[];
  pending: CustomerState[];
  active: CustomerState[] = [];
  servedCount = 0;
  events: SimEvent[] = [];

  /** Items in transit. The host animates these and calls completeFlight(). */
  flights: Flight[] = [];

  outOfSlotPolicy: OutOfSlotPolicy;
  /** See SimOptions.instantFlights. */
  readonly instantFlights: boolean;

  private ctx: EffectContext = {
    picksMade: 0,
    picksByIngredient: {},
    ordersCompleted: 0,
    keysByColor: {},
  };
  private nextUid = 1;
  private nextFlightId = 1;
  private options: SimOptions;
  private dirtyOrder: number[] = [];
  /** Dirty dishes already heading for a cell, so stack capacity accounts for them. */
  private pendingDirty = new Map<number, number>();
  /** Grid cells reserved by an in-flight item so two flights can't target one cell. */
  private reservedCells = new Set<number>();
  /** Tool slots reserved by an in-flight item. */
  private reservedSlots = new Set<string>();

  constructor(map: MapDef, level: LevelConfig, options: SimOptions = {}) {
    this.map = map;
    this.level = level;
    this.options = options;
    this.outOfSlotPolicy = options.outOfSlotPolicy ?? "block-pick";
    this.instantFlights = options.instantFlights ?? true;
    this.queues = level.queues.map((q) => [...q]);
    this.tools = map.tools.map((def) => ({
      def,
      slots: Array.from({ length: def.numSlots }, () => ({ item: null }) as ToolSlotState),
    }));
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

  /** How many items are cooking right now (for HUD/labels). */
  get cookingCount(): number {
    return this.tools.reduce((n, t) => n + t.slots.filter((s) => s.item).length, 0);
  }

  setOutOfSlotPolicy(policy: OutOfSlotPolicy): void {
    this.outOfSlotPolicy = policy;
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

    if (item.kind === "sweeper") return { ok: true };

    const match = findToolRecipe(this.map.tools, item.id);
    if (!match) {
      // No tool needed — it only has to fit on the grid.
      return this.findFreeCell() === -1
        ? { ok: false, reason: "No free grid cell" }
        : { ok: true };
    }
    if (this.freeSlot(match.tool.id) !== -1) return { ok: true };

    if (this.outOfSlotPolicy === "block-pick") {
      return { ok: false, reason: `${match.tool.name} is full` };
    }
    return this.findFreeCell() === -1
      ? { ok: false, reason: `${match.tool.name} is full and the grid has no space` }
      : { ok: true };
  }

  /**
   * Picks the top item of a queue. The item leaves the queue immediately and
   * becomes a flight; it only reaches its destination on completeFlight().
   */
  pick(queueIndex: number): boolean {
    if (!this.canPick(queueIndex).ok) return false;
    const item = this.queues[queueIndex].shift()!;

    for (const effect of item.effects) {
      getQueueEffect(effect.effectId).onPick?.(effect, this.ctx);
    }

    if (item.kind === "sweeper") {
      const cleared = this.clearDirtyStacks(1);
      this.log("pick", `Sweeper used (${cleared} stack cleared)`);
      if (this.instantFlights) this.settle();
      return true;
    }

    this.ctx.picksMade++;
    this.ctx.picksByIngredient[item.id] = (this.ctx.picksByIngredient[item.id] ?? 0) + 1;
    const def = this.map.rawIngredients.find((r) => r.id === item.id);
    this.log("pick", `Picked ${def?.name ?? item.id}`);

    const match = findToolRecipe(this.map.tools, item.id);
    if (!match) {
      // Needs no cooking: fly straight to the grid as a finished item.
      this.launch({ kind: "queue-to-grid", itemId: item.id, toCell: this.reserveCell() });
      if (this.instantFlights) this.completeAllFlights();
      return true;
    }
    const slot = this.freeSlot(match.tool.id);
    if (slot !== -1) {
      this.launch({
        kind: "queue-to-tool",
        itemId: item.id,
        toTool: this.reserveSlot(match.tool.id, slot),
      });
    } else {
      // park-on-grid: the raw ingredient waits on the grid for a slot.
      this.launch({ kind: "queue-to-grid", itemId: item.id, toCell: this.reserveCell(), raw: true });
    }
    if (this.instantFlights) this.completeAllFlights();
    return true;
  }

  /** Advance the simulation by `dt` seconds. */
  tick(dt: number): void {
    if (this.status !== "playing") return;
    // Without a host animating them, transfers resolve as they are created.
    if (this.instantFlights) this.completeAllFlights();
    this.time += dt;
    this.advanceTools(dt);
    this.settle();
    if (this.instantFlights) this.completeAllFlights();
    this.advanceCustomers(dt);
    this.checkEnd();
  }

  /**
   * Applies a flight's effect at its destination and runs the next logic step.
   * The host calls this when the corresponding animation finishes.
   */
  completeFlight(flightId: number): void {
    const index = this.flights.findIndex((f) => f.id === flightId);
    if (index === -1) return;
    const [flight] = this.flights.splice(index, 1);

    switch (flight.kind) {
      case "queue-to-tool":
      case "grid-to-tool": {
        const { toolId, slot } = flight.toTool!;
        this.releaseSlot(toolId, slot);
        const tool = this.tools.find((t) => t.def.id === toolId);
        if (tool) {
          tool.slots[slot].item = { uid: this.nextUid++, rawId: flight.itemId, elapsed: 0 };
        }
        if (flight.fromCell !== undefined) this.grid[flight.fromCell] = { kind: "empty" };
        break;
      }
      case "queue-to-grid": {
        const cell = flight.toCell!;
        this.releaseCell(cell);
        this.grid[cell] = flight.raw
          ? { kind: "raw", rawId: flight.itemId }
          : { kind: "cooked", cookedId: flight.itemId };
        break;
      }
      case "tool-to-grid": {
        const cell = flight.toCell!;
        this.releaseCell(cell);
        this.grid[cell] = { kind: "cooked", cookedId: flight.itemId };
        const def = this.map.cookedIngredients.find((c) => c.id === flight.itemId);
        this.log("cooked", `${def?.name ?? flight.itemId} ready`);
        break;
      }
      case "customer-to-grid": {
        const cell = flight.toCell!;
        this.releaseCell(cell);
        const left = (this.pendingDirty.get(cell) ?? 1) - 1;
        if (left > 0) this.pendingDirty.set(cell, left);
        else this.pendingDirty.delete(cell);
        this.placeDirtyAt(cell);
        break;
      }
      case "grid-to-customer": {
        const { index, dish } = flight.toCustomer!;
        if (flight.fromCell !== undefined) {
          this.releaseCell(flight.fromCell);
          this.grid[flight.fromCell] = { kind: "empty" };
        }
        const customer = this.active.find((c) => c.index === index);
        const dishState = customer?.dishes[dish];
        if (dishState) {
          const at = dishState.remaining.indexOf(flight.itemId);
          if (at !== -1) dishState.remaining.splice(at, 1);
          dishState.filled.push(flight.itemId);
        }
        if (customer && customer.dishes.every((d) => d.remaining.length === 0)) {
          this.completeCustomer(customer);
        }
        break;
      }
    }

    if (this.status === "playing") {
      this.settle();
      this.checkEnd();
    }
  }

  /** Completes every in-flight item at once (skip mode). */
  completeAllFlights(): void {
    let guard = 0;
    while (this.flights.length > 0 && guard++ < 500) {
      this.completeFlight(this.flights[0].id);
    }
  }

  /**
   * Fast-forwards everything already in motion and stops as soon as the level
   * needs another pick. Flights resolve instantly here.
   */
  fastForward(maxSeconds = 600): number {
    const start = this.time;
    let guard = 0;
    while (this.status === "playing" && guard++ < 2000) {
      this.completeAllFlights();
      if (this.cookingCount === 0) break;
      if (this.time - start >= maxSeconds) break;
      const completion = this.nextCompletionIn();
      const timeout = Math.min(...this.active.map((c) => c.timeLeft), Infinity);
      const step = Math.min(completion ?? Infinity, timeout);
      this.tick(Number.isFinite(step) && step > 0 ? step : 0.05);
    }
    this.completeAllFlights();
    return this.time - start;
  }

  /** Run until the level resolves. Used by tests and headless validation. */
  runToEnd(step = 0.25, maxSeconds = 3600): void {
    let elapsed = 0;
    while (this.status === "playing" && elapsed < maxSeconds) {
      this.completeAllFlights();
      this.tick(step);
      elapsed += step;
    }
    this.completeAllFlights();
  }

  /** Seconds until the next tool slot finishes, or null when nothing is cooking. */
  nextCompletionIn(): number | null {
    let best: number | null = null;
    for (const tool of this.tools) {
      for (const slot of tool.slots) {
        if (!slot.item) continue;
        const left = tool.def.cookingTime - slot.item.elapsed;
        if (best === null || left < best) best = left;
      }
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

  isCellUsable(index: number): boolean {
    const config = this.level.grid[index];
    if (!config) return false;
    return config.effects.every((e) => getCellEffect(e.effectId).isUsable(e, this.ctx));
  }

  cellLockLabel(index: number): string | null {
    const config = this.level.grid[index];
    if (!config) return null;
    for (const e of config.effects) {
      const handler = getCellEffect(e.effectId);
      if (!handler.isUsable(e, this.ctx)) {
        return handler.progressLabel?.(e, this.ctx) ?? "locked";
      }
    }
    return null;
  }

  // ---------- internals ----------

  private launch(spec: Omit<Flight, "id">): Flight {
    const flight: Flight = { id: this.nextFlightId++, ...spec };
    this.flights.push(flight);
    return flight;
  }

  private freeSlot(toolId: Id): number {
    const tool = this.tools.find((t) => t.def.id === toolId);
    if (!tool) return -1;
    for (let i = 0; i < tool.slots.length; i++) {
      if (!tool.slots[i].item && !this.reservedSlots.has(`${toolId}:${i}`)) return i;
    }
    return -1;
  }

  private reserveSlot(toolId: Id, slot: number): { toolId: Id; slot: number } {
    this.reservedSlots.add(`${toolId}:${slot}`);
    return { toolId, slot };
  }

  private releaseSlot(toolId: Id, slot: number): void {
    this.reservedSlots.delete(`${toolId}:${slot}`);
  }

  private findFreeCell(): number {
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i].kind === "empty" && !this.reservedCells.has(i) && this.isCellUsable(i)) {
        return i;
      }
    }
    return -1;
  }

  private reserveCell(): number {
    const cell = this.findFreeCell();
    if (cell !== -1) this.reservedCells.add(cell);
    return cell;
  }

  private releaseCell(cell: number): void {
    this.reservedCells.delete(cell);
  }

  private customerTime(c: CustomerConfig): number {
    if (c.waitTime <= 0) return Infinity;
    const bad = this.level?.weather && this.level.weather !== "Normal";
    return c.weatherEff === 1 && bad ? c.waitTime / 2 : c.waitTime;
  }

  private advanceTools(dt: number): void {
    for (const tool of this.tools) {
      tool.slots.forEach((slot, slotIndex) => {
        if (!slot.item) return;
        slot.item.elapsed += dt;
        if (slot.item.elapsed < tool.def.cookingTime) return;

        const recipe = tool.def.recipes.find((r) => r.in === slot.item!.rawId);
        const outId = recipe?.out ?? slot.item.rawId;
        const amount = recipe?.amount ?? 1;
        // The slot empties as the output leaves; each unit flies separately.
        for (let n = 0; n < amount; n++) {
          const cell = this.reserveCell();
          if (cell === -1) {
            this.lose("grid-overflow", "No free grid cell for a cooked ingredient");
            return;
          }
          this.launch({
            kind: "tool-to-grid",
            itemId: outId,
            fromTool: { toolId: tool.def.id, slot: slotIndex },
            toCell: cell,
          });
        }
        slot.item = null;
      });
      if (this.status !== "playing") return;
    }
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

  /** Fills serve slots, launches matches and reclaims parked raws, until settled. */
  private settle(): void {
    for (let guard = 0; guard < 100; guard++) {
      const before = `${this.servedCount}:${this.flights.length}`;
      this.fillSlots();
      this.autoServe();
      this.reclaimParkedRaws();
      if (this.status !== "playing") return;
      if (`${this.servedCount}:${this.flights.length}` === before) return;
    }
  }

  /** Launches grid → customer flights for cooked items that match an order (FCFS). */
  private autoServe(): void {
    for (const customer of this.active) {
      customer.dishes.forEach((dish, dishIndex) => {
        for (const needed of [...dish.remaining]) {
          // Don't double-book: an item already flying to this dish counts.
          const inFlight = this.flights.filter(
            (f) =>
              f.kind === "grid-to-customer" &&
              f.toCustomer?.index === customer.index &&
              f.toCustomer.dish === dishIndex &&
              f.itemId === needed,
          ).length;
          const wanted = dish.remaining.filter((id) => id === needed).length;
          if (inFlight >= wanted) continue;

          const cell = this.grid.findIndex(
            (c, i) =>
              c.kind === "cooked" && c.cookedId === needed && !this.reservedCells.has(i),
          );
          if (cell === -1) continue;
          this.reservedCells.add(cell);
          this.launch({
            kind: "grid-to-customer",
            itemId: needed,
            fromCell: cell,
            toCustomer: { index: customer.index, dish: dishIndex },
          });
        }
      });
    }
  }

  /** Moves raw ingredients parked on the grid into a tool slot as soon as one frees. */
  private reclaimParkedRaws(): void {
    for (let cell = 0; cell < this.grid.length; cell++) {
      const content = this.grid[cell];
      if (content.kind !== "raw" || this.reservedCells.has(cell)) continue;
      const match = findToolRecipe(this.map.tools, content.rawId);
      if (!match) continue;
      const slot = this.freeSlot(match.tool.id);
      if (slot === -1) continue;
      this.reservedCells.add(cell);
      this.launch({
        kind: "grid-to-tool",
        itemId: content.rawId,
        fromCell: cell,
        toTool: this.reserveSlot(match.tool.id, slot),
      });
    }
  }

  private completeCustomer(customer: CustomerState): void {
    this.active.splice(this.active.indexOf(customer), 1);
    customer.justCompleted = true;
    this.servedCount++;
    this.ctx.ordersCompleted++;
    this.events.push({
      type: "served",
      message: `Customer ${customer.index + 1} served`,
      atTime: this.time,
      customerIndex: customer.index,
    });
    this.addDirtyDish(customer.index);
  }

  /**
   * Sends the departing customer's dirty dish to the grid. The target stack is
   * claimed now (so simultaneous dishes don't overfill it) but only becomes
   * visible when the flight lands.
   */
  private addDirtyDish(fromCustomer: number): void {
    const height = this.level.dirtyStackHeight || 1;
    const openStack = this.dirtyOrder.find((i) => {
      const cell = this.grid[i];
      const pending = this.pendingDirty.get(i) ?? 0;
      const count = cell.kind === "dirty" ? cell.count : 0;
      // A cell claimed by an in-flight dish counts as a stack already.
      return (cell.kind === "dirty" || pending > 0) && count + pending < height;
    });

    let target: number;
    if (openStack !== undefined) {
      target = openStack;
    } else {
      const free = this.reserveCell();
      if (free === -1) {
        this.lose("dirty-overflow", "No free grid cell for a dirty dish");
        return;
      }
      target = free;
      this.dirtyOrder.push(free);
    }

    // Headless: land it now, so the next customer is only seated after the
    // table is cleared (a staff member must not sweep a plate mid-air).
    if (this.instantFlights) {
      this.releaseCell(target);
      this.placeDirtyAt(target);
      return;
    }

    this.pendingDirty.set(target, (this.pendingDirty.get(target) ?? 0) + 1);
    this.launch({
      kind: "customer-to-grid",
      itemId: DIRTY_DISH_ID,
      fromCustomer,
      toCell: target,
    });
  }

  private placeDirtyAt(cell: number): void {
    const existing = this.grid[cell];
    if (existing.kind === "dirty") {
      existing.count++;
    } else {
      // The stack may have been swept while this dish was travelling.
      this.grid[cell] = { kind: "dirty", count: 1 };
      if (!this.dirtyOrder.includes(cell)) this.dirtyOrder.push(cell);
    }
    this.log("dirty-added", `Dirty ${this.map.dirtyDishName} stacked`);
  }

  /** Removes up to `count` oldest dirty stacks. Returns how many were cleared. */
  clearDirtyStacks(count: number): number {
    let cleared = 0;
    while (cleared < count && this.dirtyOrder.length > 0) {
      const index = this.dirtyOrder.shift()!;
      if (this.grid[index].kind === "dirty") {
        this.grid[index] = { kind: "empty" };
        this.pendingDirty.delete(index);
        cleared++;
      }
    }
    if (cleared > 0) this.log("dirty-cleared", `Cleared ${cleared} dirty stack(s)`);
    return cleared;
  }

  private fillSlots(): void {
    while (this.active.length < this.level.serveableSlots && this.pending.length > 0) {
      const customer = this.pending.shift()!;
      if (customer.isStaff) {
        getCustomerType(CUSTOMER_STAFF).onArrive?.([1], {
          clearDirtyStacks: (n) => void this.clearDirtyStacks(n),
        });
        this.servedCount++;
        this.log("customer-arrived", "Staff cleared dirty stacks");
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
    const nothingMoving =
      this.cookingCount === 0 &&
      this.flights.length === 0 &&
      !this.grid.some((c) => c.kind === "raw");
    if (queuesEmpty && nothingMoving && this.active.length > 0) {
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
