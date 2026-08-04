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
import { getCellEffect, getQueueEffect } from "./registry.ts";
import type {
  CookingToolDef,
  CustomerConfig,
  Dish,
  Id,
  LevelConfig,
  MapDef,
  OutOfSlotPolicy,
  QueueGroupKind,
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
  /** dirtyId indexes MapDef.dirtyObjects; stacks of different types never mix. */
  | { kind: "dirty"; dirtyId: Id; count: number };

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

// ---------- queue grid ----------

/**
 * One occupied cell of the runtime queue grid — column x = queue index,
 * row y = 0 is the pickable front row. `item` is shared by reference with
 * `level.queues` (never mutated); `group` indexes `Simulation.groupKinds`,
 * or is -1 for a plain single slot.
 */
export interface QueueCell {
  item: QueueItem;
  group: number;
}

/** Where one picked item ends up, decided by planDispatch(). */
type Dispatch =
  | { kind: "sweeper" }
  | { kind: "tool"; toolId: Id; slot: number }
  | { kind: "grid"; cell: number; raw: boolean };

// ---------- flights ----------

export type FlightKind =
  | "queue-to-tool"
  | "queue-to-grid"
  | "tool-to-grid"
  | "grid-to-tool"
  | "grid-to-customer"
  /** The dirty dish a departing customer leaves behind. */
  | "customer-to-grid"
  /** One dirty stack flying into a staff customer as they clear it. */
  | "dirty-to-staff";

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
  /** customer-to-grid / dirty-to-staff only: which MapDef.dirtyObjects entry this is. */
  dirtyId?: Id;
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

/**
 * Type is explicit now (first element of the customer string), not inferred
 * from an empty dish list. Unknown future type ids fall through to normal
 * customer behavior until a handler is added for them (see fillSlots).
 */
const isStaffCustomer = (c: CustomerConfig) => c.typeId === CUSTOMER_STAFF;

export class Simulation {
  readonly level: LevelConfig;
  readonly map: MapDef;

  status: SimStatus = "playing";
  loseReason: LoseReason | null = null;
  time = 0;

  /**
   * queueGrid[x][y] — column x (= queue index), row y (0 = pickable front).
   * Rectangular: every column has `queueHeight` entries; null = no item
   * there. Unlike the authored `level.queues`, this permits holes: a
   * combined block that can't rise leaves empty cells in front of whatever
   * is behind it. The only writer is advanceQueues()'s moveUp() and pick().
   */
  queueGrid: (QueueCell | null)[][];
  /** Kind of each group index, derived once from level.queueGroups. */
  readonly groupKinds: QueueGroupKind[];
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
  /** Staff customer index -> dirty stacks still flying in before they finish. */
  private pendingStaffClears = new Map<number, number>();
  /** Dirty dishes already heading for a cell, so stack capacity accounts for them. */
  private pendingDirty = new Map<number, { count: number; dirtyId: Id }>();
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
    this.groupKinds = (level.queueGroups ?? []).map((g) => g.kind);
    this.queueGrid = buildQueueGrid(level);
    this.advanceQueues(); // settle any authored misalignment before turn 1 (cheap: dense authored data is already a fixpoint)
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

  /**
   * A fully independent deep copy, sharing only the immutable `map`/`level`
   * (never mutated after construction) and `options` (may hold a callback,
   * never mutated either — safe to share by reference). Used by bot.ts's
   * lookahead search to fork state at each candidate branch cheaply, instead
   * of replaying pick-history from scratch for every branch.
   */
  clone(): Simulation {
    const c = new Simulation(this.map, this.level, this.options);
    c.status = this.status;
    c.loseReason = this.loseReason;
    c.time = this.time;
    c.queueGrid = structuredClone(this.queueGrid);
    c.tools = this.tools.map((t) => ({
      def: t.def,
      slots: t.slots.map((s) => ({ item: s.item ? { ...s.item } : null })),
    }));
    c.grid = this.grid.map((cell) => ({ ...cell }));
    c.pending = structuredClone(this.pending);
    c.active = structuredClone(this.active);
    c.servedCount = this.servedCount;
    c.events = [...this.events];
    c.flights = this.flights.map((f) => ({ ...f }));
    c.outOfSlotPolicy = this.outOfSlotPolicy;
    c.ctx = {
      ...this.ctx,
      picksByIngredient: { ...this.ctx.picksByIngredient },
      keysByColor: { ...this.ctx.keysByColor },
    };
    c.nextUid = this.nextUid;
    c.nextFlightId = this.nextFlightId;
    c.dirtyOrder = [...this.dirtyOrder];
    c.pendingStaffClears = new Map(this.pendingStaffClears);
    c.pendingDirty = new Map([...this.pendingDirty].map(([k, v]) => [k, { ...v }]));
    c.reservedCells = new Set(this.reservedCells);
    c.reservedSlots = new Set(this.reservedSlots);
    return c;
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

  /** Number of queue columns (lanes). */
  get columnCount(): number {
    return this.queueGrid.length;
  }

  /** Row count every column is padded to. Derived, not stored — clone() needs nothing extra. */
  get queueHeight(): number {
    return this.queueGrid[0]?.length ?? 0;
  }

  /** Total items still sitting in the queue grid, across every column. */
  get remainingItems(): number {
    let n = 0;
    for (const col of this.queueGrid) for (const cell of col) if (cell) n++;
    return n;
  }

  /** The cell fronting a lane (row 0), or null for an empty column or a hole. */
  frontCell(x: number): QueueCell | null {
    return this.queueGrid[x]?.[0] ?? null;
  }

  /** Items still in a column, for the lane's counter badge. */
  remainingIn(x: number): number {
    return this.queueGrid[x]?.reduce((n, c) => n + (c ? 1 : 0), 0) ?? 0;
  }

  /** Every cell a click on lane x would pick right now (for a hover highlight). */
  pickTargets(x: number): { x: number; y: number }[] {
    return this.pickInstanceCells(x) ?? [];
  }

  setOutOfSlotPolicy(policy: OutOfSlotPolicy): void {
    this.outOfSlotPolicy = policy;
  }

  /** True when the instance fronting this lane may be picked right now. */
  canPick(queueIndex: number): { ok: boolean; reason?: string } {
    const r = this.evaluatePick(queueIndex, false);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }

  /**
   * Picks the instance fronting a lane — a plain item, a whole combined
   * block, or a whole linked chain. Every item leaves the queue immediately
   * and becomes its own flight; they only reach their destinations on
   * completeFlight().
   */
  pick(queueIndex: number): boolean {
    const r = this.evaluatePick(queueIndex, true); // reservations are now held
    if (!r.ok) return false;

    // Clear the picked cells and let gravity settle *before* dispatching, so
    // nothing re-entrant (an onPick hook, a log line) can observe a
    // half-picked instance or the same cell twice.
    for (const c of r.cells) this.queueGrid[c.x][c.y] = null;
    this.advanceQueues();

    for (const item of r.items) {
      for (const effect of item.effects) {
        getQueueEffect(effect.effectId).onPick?.(effect, this.ctx);
      }
    }
    r.items.forEach((item, i) => this.dispatchPicked(item, r.plan[i]));

    if (this.instantFlights) {
      // settle() unconditionally, THEN resolve flights: an all-sweeper pick
      // launches no flight at all, so completeAllFlights() alone would be a
      // no-op and never trigger reclaimParkedRaws()/autoServe() off the
      // stack the sweeper just cleared. A non-sweeper pick's flights each
      // settle again internally via completeFlight() — harmless, settle()
      // is idempotent once nothing changes.
      this.settle();
      this.completeAllFlights();
    }
    return true;
  }

  /**
   * Resolves what picking lane `x` would do: which cells make up the fronting
   * instance, its items, and where each item would go. `canPick` calls this
   * with commit=false (a pure query — any reservations are rolled back
   * before returning); `pick` calls it with commit=true and keeps the
   * reservations for the flights it's about to launch. Because both go
   * through the same planDispatch(), a "canPick weaker than the actual
   * placement" bug — which would let pick() write a `-1` cell/slot and
   * corrupt state — isn't possible: the placement loop *is* the check.
   */
  private evaluatePick(
    queueIndex: number,
    commit: boolean,
  ):
    | { ok: true; cells: { x: number; y: number }[]; items: QueueItem[]; plan: Dispatch[] }
    | { ok: false; reason: string } {
    if (this.status !== "playing") return { ok: false, reason: "Level finished" };

    const cells = this.pickInstanceCells(queueIndex);
    if (!cells) {
      const front = this.queueGrid[queueIndex]?.[0];
      return {
        ok: false,
        reason: front ? "Linked items are not all at the front" : "Queue empty",
      };
    }
    const items = cells.map((c) => this.queueGrid[c.x][c.y]!.item);

    // Any member's canPick effect (e.g. Freeze) blocks the whole instance.
    for (const item of items) {
      for (const effect of item.effects) {
        const check = getQueueEffect(effect.effectId).canPick?.(effect, this.ctx);
        if (check && !check.ok) return { ok: false, reason: check.reason ?? "Blocked" };
      }
    }

    const planned = this.planDispatch(items, commit);
    if (!planned.ok) return planned;
    return { ok: true, cells, items, plan: planned.plan };
  }

  /**
   * Cells of the instance a click on lane x would pick, or null when nothing
   * is pickable there yet.
   *   ungrouped — just the front cell.
   *   combined  — the whole block. No extra check needed: a cell of the
   *               block sitting at row 0 already proves its min-y is 0.
   *   linked    — every member, but only once ALL of them are at row 0.
   */
  private pickInstanceCells(x: number): { x: number; y: number }[] | null {
    const front = this.queueGrid[x]?.[0];
    if (!front) return null; // empty column, or a hole
    if (front.group === -1) return [{ x, y: 0 }];
    const cells = this.groupCells(front.group);
    if (this.groupKinds[front.group] === "linked" && cells.some((c) => c.y !== 0)) return null;
    return cells;
  }

  /** Every live cell carrying group index g, sorted by (y, x). */
  private groupCells(g: number): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (let x = 0; x < this.queueGrid.length; x++) {
      const col = this.queueGrid[x];
      for (let y = 0; y < col.length; y++) {
        if (col[y]?.group === g) out.push({ x, y });
      }
    }
    return out.sort((a, b) => a.y - b.y || a.x - b.x);
  }

  /**
   * Works out where every item of a pick would go, using the same
   * freeSlot()/reserveCell() helpers pick() uses, in the same order.
   * commit=false rolls every reservation it made back before returning (a
   * pure query); commit=true keeps them, and the caller must launch exactly
   * one flight per Dispatch (releasing them on landing).
   *
   * A pick of more than one item (a combined block or linked chain) may
   * always spill onto the grid, even under "Block the pick" — parking the
   * overflow is inherent to those mechanics. A single plain item still
   * honors outOfSlotPolicy exactly as before.
   */
  private planDispatch(
    items: QueueItem[],
    commit: boolean,
  ): { ok: true; plan: Dispatch[] } | { ok: false; reason: string } {
    const plan: Dispatch[] = [];
    const reservedSlots: { toolId: Id; slot: number }[] = [];
    const reservedCells: number[] = [];
    const rollback = () => {
      for (const s of reservedSlots) this.releaseSlot(s.toolId, s.slot);
      for (const c of reservedCells) this.releaseCell(c);
    };

    const allowPark = this.outOfSlotPolicy === "park-on-grid" || items.length > 1;

    for (const item of items) {
      if (item.kind === "sweeper") {
        plan.push({ kind: "sweeper" });
        continue;
      }

      const match = findToolRecipe(this.map.tools, item.id);
      if (!match) {
        // No tool needed — it only has to fit on the grid.
        const cell = this.reserveCell();
        if (cell === -1) {
          rollback();
          return { ok: false, reason: "No free grid cell" };
        }
        reservedCells.push(cell);
        plan.push({ kind: "grid", cell, raw: false });
        continue;
      }

      const slot = this.freeSlot(match.tool.id);
      if (slot !== -1) {
        this.reserveSlot(match.tool.id, slot);
        reservedSlots.push({ toolId: match.tool.id, slot });
        plan.push({ kind: "tool", toolId: match.tool.id, slot });
        continue;
      }

      if (!allowPark) {
        rollback();
        return { ok: false, reason: `${match.tool.name} is full` };
      }
      const cell = this.reserveCell();
      if (cell === -1) {
        rollback();
        return { ok: false, reason: `${match.tool.name} is full and the grid has no space` };
      }
      reservedCells.push(cell);
      plan.push({ kind: "grid", cell, raw: true });
    }

    if (!commit) rollback();
    return { ok: true, plan };
  }

  /** Routes one already-planned item to its destination, logging/counting it. */
  private dispatchPicked(item: QueueItem, d: Dispatch): void {
    if (d.kind === "sweeper") {
      const cleared = this.clearDirtyStacks(1);
      this.log("pick", `Sweeper used (${cleared} stack cleared)`);
      return;
    }
    this.ctx.picksMade++;
    this.ctx.picksByIngredient[item.id] = (this.ctx.picksByIngredient[item.id] ?? 0) + 1;
    const def = this.map.rawIngredients.find((r) => r.id === item.id);
    this.log("pick", `Picked ${def?.name ?? item.id}`);
    if (d.kind === "tool") {
      this.launch({ kind: "queue-to-tool", itemId: item.id, toTool: { toolId: d.toolId, slot: d.slot } });
    } else {
      this.launch({ kind: "queue-to-grid", itemId: item.id, toCell: d.cell, raw: d.raw });
    }
  }

  /**
   * Gravity. Every instance (a lone cell, or a whole "combined" group — a
   * "linked" group is NOT a movement instance, its members move
   * independently) rises toward row 0 until nothing can move. Only ever
   * called at construction and right after pick() clears cells — nothing
   * else changes queue geometry, and keeping that invariant is what keeps
   * the queues' structure key cheap to compute.
   * Postcondition: canMoveUp() is false for every instance.
   */
  private advanceQueues(): void {
    const height = this.queueHeight;
    const cols = this.queueGrid.length;
    // +1 so the final pass can run and prove stability (no move happened).
    for (let pass = 0; pass <= height; pass++) {
      const byGroup = new Map<number, { x: number; y: number }[]>();
      for (let x = 0; x < cols; x++) {
        for (let y = 0; y < height; y++) {
          const g = this.queueGrid[x][y]?.group ?? -1;
          if (g === -1 || this.groupKinds[g] !== "combined") continue;
          if (!byGroup.has(g)) byGroup.set(g, []);
          byGroup.get(g)!.push({ x, y });
        }
      }
      for (const cells of byGroup.values()) cells.sort((a, b) => a.y - b.y || a.x - b.x);

      let moved = false;
      for (let y = 1; y < height; y++) {
        for (let x = 0; x < cols; x++) {
          const cell = this.queueGrid[x][y];
          if (!cell) continue;
          const g = cell.group;
          const inst = g !== -1 && this.groupKinds[g] === "combined" ? byGroup.get(g)! : [{ x, y }];
          // Enumerate a multi-cell instance exactly once, from its anchor
          // (min-y then min-x, per the sort above) — every other cell of it
          // is skipped when the outer scan reaches it.
          if (inst[0].x !== x || inst[0].y !== y) continue;
          if (!this.canMoveUp(inst)) continue;
          this.moveUp(inst);
          moved = true;
        }
      }
      if (!moved) return;
    }
  }

  /** True when every cell of `inst` (sorted by y ascending) may rise one row. */
  private canMoveUp(inst: { x: number; y: number }[]): boolean {
    const own = new Set(inst.map((c) => `${c.x}:${c.y}`));
    for (const c of inst) {
      if (c.y === 0) return false;
      if (own.has(`${c.x}:${c.y - 1}`)) continue; // vacated by this same instance
      if (this.queueGrid[c.x][c.y - 1] !== null) return false;
    }
    return true;
  }

  /**
   * Precondition: canMoveUp(inst). `inst` must be sorted by y ascending — the
   * front-most cell of a multi-row-same-column instance has to vacate its
   * slot before the cell behind it writes into that slot.
   */
  private moveUp(inst: { x: number; y: number }[]): void {
    for (const c of inst) {
      this.queueGrid[c.x][c.y - 1] = this.queueGrid[c.x][c.y];
      this.queueGrid[c.x][c.y] = null;
    }
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
        if (flight.fromCell !== undefined) {
          // reclaimParkedRaws() reserved this cell when it launched the
          // flight (see there) — release it now the raw has actually left,
          // or it leaks forever and findFreeCell() silently shrinks by one
          // usable cell every time park-on-grid reclaims a parked raw.
          this.releaseCell(flight.fromCell);
          this.grid[flight.fromCell] = { kind: "empty" };
        }
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
        const left = (this.pendingDirty.get(cell)?.count ?? 1) - 1;
        if (left > 0) this.pendingDirty.set(cell, { count: left, dirtyId: flight.dirtyId! });
        else this.pendingDirty.delete(cell);
        this.placeDirtyAt(cell, flight.dirtyId!);
        break;
      }
      case "dirty-to-staff": {
        const cell = flight.fromCell!;
        this.releaseCell(cell);
        this.grid[cell] = { kind: "empty" };
        const at = this.dirtyOrder.indexOf(cell);
        if (at !== -1) this.dirtyOrder.splice(at, 1);

        const staffIndex = flight.toCustomer!.index;
        const remaining = (this.pendingStaffClears.get(staffIndex) ?? 1) - 1;
        if (remaining > 0) {
          this.pendingStaffClears.set(staffIndex, remaining);
        } else {
          this.pendingStaffClears.delete(staffIndex);
          const staff = this.active.find((c) => c.index === staffIndex);
          if (staff) this.completeStaffCustomer(staff);
        }
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

          // Some cooked ingredients can't be served until their "base" is
          // already in this dish (toppings need the bun there first, ice
          // needs the cup there first) — see CookedIngredientDef.baseId.
          const baseId = this.map.cookedIngredients.find((c) => c.id === needed)?.baseId;
          if (baseId !== undefined && !dish.filled.includes(baseId)) continue;

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
    for (const dirtyId of this.dirtyTypesFor(customer)) {
      this.addDirtyDish(customer.index, dirtyId);
    }
  }

  /**
   * Which dirty object(s) a served customer leaves behind: one per dish that
   * contains a defined dirty object's source cooked ingredient (see
   * DirtyObjectDef.sourceCookedId) — so a customer who got a burger AND a
   * soda leaves both a dirty plate and a dirty cup. Maps that don't define
   * any dirty objects keep the old behavior: exactly one generic dirty dish
   * per served customer.
   */
  private dirtyTypesFor(customer: CustomerState): Id[] {
    if (this.map.dirtyObjects.length === 0) return [DIRTY_DISH_ID];
    const ids: Id[] = [];
    for (const dish of customer.dishes) {
      for (const def of this.map.dirtyObjects) {
        if (dish.filled.includes(def.sourceCookedId)) ids.push(def.id);
      }
    }
    return ids;
  }

  /**
   * Sends the departing customer's dirty dish to the grid. The target stack is
   * claimed now (so simultaneous dishes don't overfill it) but only becomes
   * visible when the flight lands. Stacks never mix types — a dirty plate and
   * a dirty cup always occupy separate cells.
   */
  private addDirtyDish(fromCustomer: number, dirtyId: Id): void {
    const height = this.map.dirtyStackHeight || 1;
    const openStack = this.dirtyOrder.find((i) => {
      const cell = this.grid[i];
      const pendingEntry = this.pendingDirty.get(i);
      const pending = pendingEntry?.count ?? 0;
      const count = cell.kind === "dirty" ? cell.count : 0;
      const existingType = cell.kind === "dirty" ? cell.dirtyId : pendingEntry?.dirtyId;
      // A cell claimed by an in-flight dish counts as a stack already. A cell
      // reserved by a staff customer's in-flight clearing is excluded — it's
      // about to disappear, so a new dish shouldn't target it mid-flight.
      return (
        (cell.kind === "dirty" || pending > 0) &&
        existingType === dirtyId &&
        count + pending < height &&
        !this.reservedCells.has(i)
      );
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
      this.placeDirtyAt(target, dirtyId);
      return;
    }

    const prevPending = this.pendingDirty.get(target);
    this.pendingDirty.set(target, { count: (prevPending?.count ?? 0) + 1, dirtyId });
    this.launch({
      kind: "customer-to-grid",
      itemId: DIRTY_DISH_ID,
      dirtyId,
      fromCustomer,
      toCell: target,
    });
  }

  private placeDirtyAt(cell: number, dirtyId: Id): void {
    const existing = this.grid[cell];
    if (existing.kind === "dirty" && existing.dirtyId === dirtyId) {
      existing.count++;
    } else {
      // The stack may have been swept (or fully cleared) while this dish was
      // travelling — or it just never mixes with a different-typed stack.
      this.grid[cell] = { kind: "dirty", dirtyId, count: 1 };
      if (!this.dirtyOrder.includes(cell)) this.dirtyOrder.push(cell);
    }
    const def = this.map.dirtyObjects.find((d) => d.id === dirtyId);
    this.log("dirty-added", `Dirty ${def?.name ?? this.map.dirtyDishName} stacked`);
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
        // Visible in `active` (like a normal customer) while their stacks fly
        // in, so the view has a card to animate the dirty dishes toward and
        // to play the same completion celebration on once they're done.
        this.active.push(customer);
        this.startStaffClearing(customer);
        continue;
      }
      this.active.push(customer);
      this.log("customer-arrived", `Customer ${customer.index + 1} is ordering`);
    }
  }

  /**
   * Launches one flight per dirty stack a staff customer will clear (oldest
   * first; even a not-full stack counts). The customer only actually finishes
   * once every one of those flights has landed — see the "dirty-to-staff"
   * case in completeFlight().
   *
   * This bypasses the customer-type registry's synchronous `onArrive` (still
   * registered for CUSTOMER_STAFF, still what the Definitions table describes)
   * because clearing is now animated and can span multiple flights rather than
   * happening in one synchronous call.
   */
  private startStaffClearing(customer: CustomerState): void {
    const amount = customer.config.staffAmount ?? 1;
    const stacks = this.dirtyOrder.slice(0, Math.max(0, amount));
    if (stacks.length === 0) {
      this.completeStaffCustomer(customer);
      return;
    }
    this.pendingStaffClears.set(customer.index, stacks.length);
    this.log("customer-arrived", `Staff clearing ${stacks.length} dirty stack(s)`);
    for (const cell of stacks) {
      this.reservedCells.add(cell);
      const content = this.grid[cell];
      this.launch({
        kind: "dirty-to-staff",
        itemId: DIRTY_DISH_ID,
        dirtyId: content.kind === "dirty" ? content.dirtyId : undefined,
        fromCell: cell,
        toCustomer: { index: customer.index, dish: 0 },
      });
    }
  }

  private completeStaffCustomer(customer: CustomerState): void {
    const at = this.active.indexOf(customer);
    if (at !== -1) this.active.splice(at, 1);
    this.servedCount++;
    this.events.push({
      type: "served",
      message: "Staff finished clearing dirty stacks",
      atTime: this.time,
      customerIndex: customer.index,
    });
  }

  private checkEnd(): void {
    if (this.status !== "playing") return;
    if (this.servedCount >= this.totalCustomers) {
      this.status = "won";
      this.log("won", `All ${this.totalCustomers} customers served`);
      return;
    }
    const queuesEmpty = this.remainingItems === 0;
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

/**
 * Expands the authored, dense `level.queues` into the runtime queue grid,
 * padding every column to the tallest queue's length and stamping each
 * cell's group index from `level.queueGroups`. Out-of-range or empty group
 * coordinates are ignored rather than thrown — a malformed string must not
 * crash Play mode; `data/validate.ts` warns about it instead.
 */
function buildQueueGrid(level: LevelConfig): (QueueCell | null)[][] {
  const height = level.queues.reduce((h, q) => Math.max(h, q.length), 0);
  const grid: (QueueCell | null)[][] = level.queues.map((lane) =>
    Array.from({ length: height }, (_, y) => (lane[y] ? { item: lane[y], group: -1 } : null)),
  );
  const groups = level.queueGroups ?? [];
  for (let gi = 0; gi < groups.length; gi++) {
    for (const { x, y } of groups[gi].cells) {
      const cell = grid[x]?.[y];
      if (cell) cell.group = gi;
    }
  }
  return grid;
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
