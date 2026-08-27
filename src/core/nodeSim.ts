// Graph-native gameplay simulation — the node-graph counterpart of sim.ts.
//
// Same shape, same guarantees: pure TS, no DOM, no timers of its own; the host
// drives it with tick(dt) and lands every hand-off through completeFlight(), so
// a view can animate transfers and the next logic step only runs once an item
// arrives. The flight model, the settle() fixpoint, gravity, reservations,
// dirty stacking, staff clearing, the backpack and all four lose reasons are
// ported ALGORITHM-FOR-ALGORITHM from sim.ts. `sim.ts` itself is never touched.
//
// What actually differs, and why:
//
//   legacy                                    | here
//   ------------------------------------------|-------------------------------
//   raw ids and cooked ids, mirrored by hand   | ONE dense ingredient index
//   findToolRecipe() scanning every tool       | ix.recipeForInput[ing]
//   map.cookedIngredients.find(...) per serve  | ix.usageNum[ing], ix.servable[ing]
//   baseId: Id | Id[], re-scanned per serve    | a per-slot gate, resolved once
//                                             |   when the order is bound
//   dirtyTypesFor() scanning sourceCookedId    | ix.dirtyOf[order.orderable]
//   tool.def.cookingTime for every item        | the producing step's duration
//
// A serve now targets `(customer, dish, slot)` rather than `(customer, dish,
// cookedId)`. That single change deletes legacy's `inFlightToDish` wanted-
// counting: a flight claims one slot, so double-booking is impossible by
// construction rather than by arithmetic.
//
// The one genuinely NEW mechanic is intermediate forwarding in advanceTools().
// The graph spells a two-tool route two different ways and they are NOT
// interchangeable:
//
//   potato   — ONE process edge carrying chainTools: ["fryer"]. No intermediate
//              vertex exists; the item hops tool-to-tool carrying its chain
//              state and nothing ever lands on the grid mid-route. Verbatim
//              legacy behaviour.
//   chicken  — TWO process edges through a real `*-flour-coated` vertex,
//              because the coating IS an item state a designer can see and
//              wire. The coated piece is a genuine output that simply must not
//              stop at the grid. Rule: an output auto-forwards iff it is
//              NON-SERVABLE and something consumes it.
//
// Both spellings produce exactly one grid landing. Getting this wrong is the
// most error-prone part of the port, so each branch is commented at the point
// it dispatches.

import "./effects.ts"; // registers built-in behaviors
import { CUSTOMER_STAFF, DIRTY_DISH_ID, EFFECT_FREEZE, EFFECT_HIDDEN } from "./effects.ts";
import type { EffectContext } from "./registry.ts";
import { getCellEffect, getQueueEffect } from "./registry.ts";
import type { FlightKind, LoseReason, SimEvent, SimStatus } from "./simTypes.ts";
import type {
  EffectInstance,
  GridCellConfig,
  Id,
  OutOfSlotPolicy,
  QueueGroup,
  QueueGroupKind,
  QueueItem,
} from "./types.ts";
import type { GraphIndex, ProcessStep, ToolSlotLayout } from "./nodeIndex.ts";
import { flatSlot, inputPoint, reachesAny } from "./nodeIndex.ts";
import type { NodeCustomerConfig } from "./nodeParser.ts";
import type { OrderIssue, ResolvedOrder } from "./nodeOrder.ts";
import { describeIssue, orderIdIndex, resolveOrder } from "./nodeOrder.ts";
import type { IdIndex } from "../data/nodeIdTable.ts";

// The status/reason/event vocabulary is deliberately IMPORTED rather than
// redeclared, so the two simulations cannot drift apart on the one surface a
// forked view reads most.
export { DIRTY_DISH_ID };
export type { FlightKind, LoseReason, SimEvent, SimStatus };

export const SAVE_ME_BAG_CAPACITY = 5;
export const SAVE_ME_SHUFFLE_DEPTH = 3;

/** A level whose strings speak the node graph's id space. */
export interface NodeLevelConfig {
  id: Id;
  name: string;
  weather: string;
  levelTag: string;
  featureUnlock: string;
  shuffleDistance: number;
  serveableSlots: number;
  /** `QueueItem.id` is a DATA id, resolved through the map's id table. */
  queues: QueueItem[][];
  queueGroups?: QueueGroup[];
  grid: GridCellConfig[];
  customers: NodeCustomerConfig[];
  outOfSlotPolicy?: OutOfSlotPolicy;
  boosterCharges?: number[];
}

/** One occupied tool slot. */
export interface NodeToolSlotState {
  /** null when the slot is free. */
  item: {
    uid: number;
    /** Dense ingredient index currently cooking. */
    ing: number;
    elapsed: number;
    /** Seconds this particular item needs here — the step's duration, or the tool's default on a chain hop. */
    duration: number;
    /**
     * Set only for a chainTools route — the still-remaining tool indices to hop
     * through plus the final output, decided once at the first tool and threaded
     * through every hop, since later tools own no recipe for this input.
     */
    chain?: { remaining: number[]; out: number; amount: number };
    /** Finished recipe output retained in its producer until the next tool accepts it. */
    completed?: { out: number; amount: number };
  } | null;
}

export interface NodeToolState {
  /** Dense tool index. */
  index: number;
  name: string;
  displayName: string;
  /**
   * Total addressable positions — every lane of every slot point. Still one
   * flat array, exactly as when a tool was a bare `numSlots`; `layout` says
   * what each index means.
   */
  numSlots: number;
  /** Prefix of `slots` used for recipes; preservation buffers follow it. */
  processSlotCount: number;
  preservationSlotCount: number;
  slots: NodeToolSlotState[];
  /** The tool's slot points and the flat index of each point/lane pair. */
  layout: ToolSlotLayout;
}

export type NodeCellContent =
  | { kind: "empty" }
  /** A finished ingredient waiting to be served. `usesLeft` only for usageNum > 1. */
  | { kind: "cooked"; ing: number; usesLeft?: number }
  /** A pickup parked because its tool was full (park-on-grid policy). */
  | { kind: "raw"; ing: number }
  /** dirtyId is a dense dirty index, or DIRTY_DISH_ID for the generic dish. Stacks never mix types. */
  | { kind: "dirty"; dirtyId: number; count: number }
  /** The Save Me booster's collapsed grid — items retain their current processing state. */
  | { kind: "backpack"; items: number[] };

/**
 * One customer dish, bound to the graph.
 *
 * `filled` is per RESOLVED SLOT, not per ingredient id: two patties are two
 * slots, and filling one says nothing about the other. `remaining` survives as
 * a derived getter so call sites that only care about "what is still wanted"
 * read the same as they did against legacy.
 */
export class NodeDishState {
  readonly order: ResolvedOrder;
  readonly effects: EffectInstance[];
  readonly filled: boolean[];
  /**
   * Indices into `order.slots` that fill the composite's base slot — what every
   * gated slot waits on. Empty when the dish ordered no base at all, which
   * leaves the gated slots permanently shut; that is a data error the validator
   * reports, and stalling loudly beats serving a topping onto nothing.
   */
  readonly baseIndices: number[];

  constructor(order: ResolvedOrder, effects: EffectInstance[]) {
    this.order = order;
    this.effects = effects;
    this.filled = order.slots.map(() => false);
    const baseSlot = order.slots.find((s) => s.gate === -1)?.slot ?? -1;
    this.baseIndices = order.slots
      .map((s, i) => (s.slot === baseSlot && s.gate === -1 ? i : -1))
      .filter((i) => i !== -1);
  }

  /** Dense ingredient indices still wanted, one entry per unfilled slot. */
  get remaining(): number[] {
    const out: number[] = [];
    this.order.slots.forEach((s, i) => {
      if (!this.filled[i]) out.push(s.ing);
    });
    return out;
  }

  get complete(): boolean {
    return this.filled.every(Boolean);
  }

  /** True when slot `i` may be served right now — its base is already in the dish. */
  gateOpen(i: number): boolean {
    if (this.order.slots[i].gate === -1) return true;
    return this.baseIndices.some((b) => this.filled[b]);
  }

  /** True when this dish already holds `ing` in some filled slot. */
  holds(ing: number): boolean {
    return this.order.slots.some((s, i) => this.filled[i] && s.ing === ing);
  }
}

export interface NodeCustomerState {
  index: number;
  config: NodeCustomerConfig;
  dishes: NodeDishState[];
  timeLeft: number;
  isStaff: boolean;
  /** Set the moment the last dish completes, for the celebration animation. */
  justCompleted?: boolean;
}

/**
 * One occupied cell of the runtime queue grid — column x = queue index, row
 * y = 0 is the pickable front row. `item` is shared by reference with
 * `level.queues` (never mutated) so per-item state can be keyed by identity;
 * `ing` is its resolved dense ingredient index (-1 for the sweeper, or for a
 * data id the table could not resolve); `group` indexes `groupKinds`, or -1.
 */
export interface NodeQueueCell {
  item: QueueItem;
  ing: number;
  group: number;
}

/** Where one picked item ends up, decided by planDispatch(). */
type Dispatch =
  | { kind: "sweeper" }
  | { kind: "tool"; tool: number; slot: number; step?: ProcessStep }
  | { kind: "grid"; cell: number; raw: boolean };

export interface NodeFlight {
  id: number;
  kind: FlightKind;
  /** Dense ingredient index being carried; -1 for a dirty dish. */
  ing: number;
  fromCell?: number;
  fromTool?: { tool: number; slot: number };
  toTool?: { tool: number; slot: number };
  toCell?: number;
  /** Destination customer — now including WHICH SLOT, so a flight claims exactly one. */
  toCustomer?: { index: number; dish: number; slot: number };
  fromCustomer?: number;
  /** queue-to-grid only: true when the item is parked raw, awaiting a tool slot. */
  raw?: boolean;
  /** customer-to-grid / dirty-to-staff only: dense dirty index, or DIRTY_DISH_ID. */
  dirtyId?: number;
  /** tool-to-tool only, chainTools spelling: the chain state to install at the destination. */
  chain?: { remaining: number[]; out: number; amount: number };
  /** Exact process selected when one ingredient can enter more than one recipe. */
  step?: ProcessStep;
}

export interface NodeSimOptions {
  /** Fires when queues run dry with orders outstanding. Default: lose. */
  onOutOfIngredient?(sim: NodeSimulation): void;
  outOfSlotPolicy?: OutOfSlotPolicy;
  /** When true (the default) flights land the moment they are created. */
  instantFlights?: boolean;
  /**
   * "wanted-only" refuses any pick that cannot reach something a waiting
   * customer still needs — the strict reading of "only combine ingredients if
   * they can create the desired dish". DEFAULT "any", deliberately: the
   * estimator makes queue-flow picks on purpose, and migrated levels queue
   * items ahead of the customer who wants them, so switching this on by
   * default would make correct data unplayable. `unsatisfiableSlots()` is the
   * non-hot-loop query for the same question.
   */
  pickPolicy?: "any" | "wanted-only";
  /** Play-mode loss classification; audits inspect the resting state themselves. */
  detectDeadlockLoss?: boolean;
}

const isStaffCustomer = (c: NodeCustomerConfig) => c.typeId === CUSTOMER_STAFF;

const isServeFlight = (f: NodeFlight): boolean =>
  f.kind === "grid-to-customer" ||
  f.kind === "backpack-to-customer" ||
  f.kind === "tool-to-customer" ||
  f.kind === "queue-to-customer";

export class NodeSimulation {
  readonly ix: GraphIndex;
  readonly level: NodeLevelConfig;
  readonly ids: IdIndex;

  status: SimStatus = "playing";
  loseReason: LoseReason | null = null;
  time = 0;
  saveMeUsed = 0;

  /** queueGrid[x][y] — column x, row y (0 = pickable front). Rectangular; null = no item. */
  queueGrid: (NodeQueueCell | null)[][];
  readonly groupKinds: QueueGroupKind[];
  tools: NodeToolState[];
  grid: NodeCellContent[];
  pending: NodeCustomerState[];
  active: NodeCustomerState[] = [];
  servedCount = 0;
  events: SimEvent[] = [];

  /** Items in transit. The host animates these and calls completeFlight(). */
  flights: NodeFlight[] = [];

  outOfSlotPolicy: OutOfSlotPolicy;
  readonly instantFlights: boolean;
  readonly pickPolicy: "any" | "wanted-only";

  /**
   * Data problems found while binding the level to the graph — an unresolvable
   * queue id, a dish naming a retired ingredient. Collected rather than thrown:
   * this runs on data a designer may be halfway through editing.
   */
  readonly issues: string[] = [];

  private ctx: EffectContext = {
    picksMade: 0,
    picksByIngredient: {},
    ordersCompleted: 0,
    keysByColor: {},
  };
  private nextUid = 1;
  private nextFlightId = 1;
  private options: NodeSimOptions;
  private dirtyOrder: number[] = [];
  private pendingStaffClears = new Map<number, number>();
  private pendingDirty = new Map<number, { count: number; dirtyId: number }>();
  private reservedCells = new Set<number>();
  private reservedSlots = new Set<string>();
  /** Auto Complete: units of an ingredient already drawn from a still-queued multi-yield pickup. */
  private partialYield = new Map<number, number>();
  /** Freeze: adjacent picks still needed to thaw, keyed by QueueItem identity. */
  private freezeRemaining = new Map<QueueItem, number>();

  constructor(ix: GraphIndex, level: NodeLevelConfig, options: NodeSimOptions = {}) {
    this.ix = ix;
    this.level = level;
    this.ids = orderIdIndex(ix);
    this.options = options;
    this.outOfSlotPolicy = options.outOfSlotPolicy ?? "block-pick";
    this.instantFlights = options.instantFlights ?? true;
    this.pickPolicy = options.pickPolicy ?? "any";
    this.groupKinds = (level.queueGroups ?? []).map((g) => g.kind);
    this.queueGrid = this.buildQueueGrid(level);
    this.advanceQueues(); // settle authored misalignment before turn 1
    this.tools = ix.doc.vertices.tool.map((def, index) => ({
      index,
      name: def.name,
      displayName: def.displayName,
      numSlots: ix.toolSlots[index].flat.length + ix.preservationSlots[index],
      processSlotCount: ix.toolSlots[index].flat.length,
      preservationSlotCount: ix.preservationSlots[index],
      slots: Array.from(
        { length: ix.toolSlots[index].flat.length + ix.preservationSlots[index] },
        () => ({ item: null }) as NodeToolSlotState,
      ),
      layout: ix.toolSlots[index],
    }));
    this.grid = level.grid.map(() => ({ kind: "empty" }) as NodeCellContent);
    this.pending = level.customers.map((config, index) => ({
      index,
      config,
      dishes: config.dishes.map((dish, di) => {
        const { order, issues } = resolveOrder(ix, dish, this.ids);
        for (const issue of issues) this.noteIssue(index, di, issue);
        return new NodeDishState(order, dish.effects);
      }),
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

  get cookingCount(): number {
    return this.tools.reduce(
      (n, tool) => n + tool.slots.slice(0, tool.processSlotCount).filter((slot) => slot.item).length,
      0,
    );
  }

  get columnCount(): number {
    return this.queueGrid.length;
  }

  get queueHeight(): number {
    return this.queueGrid[0]?.length ?? 0;
  }

  get remainingItems(): number {
    let n = 0;
    for (const col of this.queueGrid) for (const cell of col) if (cell) n++;
    return n;
  }

  /** The cell fronting a lane (row 0), or null for an empty column or a hole. */
  frontCell(x: number): NodeQueueCell | null {
    return this.queueGrid[x]?.[0] ?? null;
  }

  remainingIn(x: number): number {
    return this.queueGrid[x]?.reduce((n, c) => n + (c ? 1 : 0), 0) ?? 0;
  }

  pickTargets(x: number): { x: number; y: number }[] {
    return this.pickInstanceCells(x) ?? [];
  }

  pickTargetsAt(x: number, y: number): { x: number; y: number }[] {
    return this.instanceAt(x, y) ?? [];
  }

  setOutOfSlotPolicy(policy: OutOfSlotPolicy): void {
    this.outOfSlotPolicy = policy;
  }

  /** Display name of a dense ingredient index, for logs and the view. */
  ingredientName(ing: number): string {
    return this.ix.doc.vertices.ingredient[ing]?.displayName ?? `#${ing}`;
  }

  canPick(queueIndex: number): { ok: boolean; reason?: string } {
    const r = this.evaluatePick(queueIndex, 0, false);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }

  pick(queueIndex: number): boolean {
    const r = this.evaluatePick(queueIndex, 0, true); // reservations are now held
    if (!r.ok) return false;
    this.applyPick(r);
    return true;
  }

  /** Ingredient Pick booster: picks the instance at an arbitrary (x,y). */
  pickAt(x: number, y: number): boolean {
    const r = this.evaluatePick(x, y, true, true);
    if (!r.ok) return false;
    this.applyPick(r);
    return true;
  }

  /** Remaining side-adjacent picks needed to thaw a frozen queue item. */
  freezeCount(item: QueueItem): number {
    const freeze = item.effects.find((e) => e.effectId === EFFECT_FREEZE);
    if (!freeze) return 0;
    let remaining = this.freezeRemaining.get(item);
    if (remaining === undefined) {
      remaining = freeze.params[0] ?? 0;
      this.freezeRemaining.set(item, remaining);
    }
    return remaining;
  }

  /**
   * True when the slot at (x,y) carries the Hidden status and hasn't been
   * revealed yet. Deliberately GEOMETRIC, not a canPick() test — canPick also
   * fails on Freeze and on a full grid, so a canPick-based rule would let an
   * already-revealed slot flip back to "?" when the board fills up. Reveal must
   * be monotonic. Ported unchanged from sim.ts.
   */
  isHidden(x: number, y: number): boolean {
    const cell = this.queueGrid[x]?.[y];
    if (!cell) return false;
    if (!cell.item.effects.some((e) => e.effectId === EFFECT_HIDDEN)) return false;
    if (y === 0) return false;
    if (cell.group !== -1 && this.groupKinds[cell.group] === "combined") {
      for (const col of this.queueGrid) {
        const front = col[0];
        if (front && front.group === cell.group) return false;
      }
    }
    return true;
  }

  /**
   * Advance gameplay by `dt` seconds and customer patience by `customerDt`.
   * Headless callers keep the original one-clock behavior; Play mode passes
   * real elapsed time as the second argument so speed-up affects cooking but
   * never makes customers less patient.
   */
  tick(dt: number, customerDt = dt): void {
    if (this.status !== "playing") return;
    if (this.instantFlights) this.completeAllFlights();
    this.time += dt;
    this.advanceTools(dt);
    this.settle();
    if (this.instantFlights) this.completeAllFlights();
    this.advanceCustomers(customerDt);
    this.checkEnd();
  }

  /** Applies a flight's effect at its destination and runs the next logic step. */
  completeFlight(flightId: number): void {
    const index = this.flights.findIndex((f) => f.id === flightId);
    if (index === -1) return;
    const [flight] = this.flights.splice(index, 1);

    switch (flight.kind) {
      case "queue-to-tool":
      case "grid-to-tool":
      case "backpack-to-tool":
      case "tool-to-tool": {
        const { tool: toolIndex, slot } = flight.toTool!;
        this.releaseSlot(toolIndex, slot);
        const tool = this.tools[toolIndex];
        if (tool) {
          // A chainTools hop carries its chain state explicitly (a later tool
          // owns no recipe for this input); the first hop looks it up fresh.
          // An intermediate FORWARD (the chicken spelling) carries none, because
          // its destination owns a real recipe for the coated piece.
          const step = flight.step ?? this.ix.recipeForInput[flight.ing];
          const chain =
            flight.chain ??
            (step && step.chainTools.length > 0
              ? { remaining: step.chainTools, out: step.out, amount: step.amount }
              : undefined);
          tool.slots[slot].item = {
            uid: this.nextUid++,
            ing: flight.ing,
            elapsed: 0,
            // A chain hop cooks for the destination tool's own time; a fresh
            // item cooks for its producing step's duration.
            duration: flight.chain ? this.toolTime(toolIndex) : (step?.duration ?? this.toolTime(toolIndex)),
            chain,
          };
        }
        if (flight.kind === "grid-to-tool" && flight.fromCell !== undefined) {
          // reclaimProcessableGridItems() reserved this cell when it launched the flight —
          // release it now the pickup has actually left, or it leaks forever.
          this.releaseCell(flight.fromCell);
          this.grid[flight.fromCell] = { kind: "empty" };
        }
        if (flight.kind === "backpack-to-tool" && flight.fromCell !== undefined) {
          this.releaseCell(flight.fromCell);
          const content = this.grid[flight.fromCell];
          if (content.kind === "backpack") {
            const at = content.items.indexOf(flight.ing);
            if (at !== -1) content.items.splice(at, 1);
            if (content.items.length === 0) this.grid[flight.fromCell] = { kind: "empty" };
          }
        }
        break;
      }
      case "queue-to-grid": {
        const cell = flight.toCell!;
        this.releaseCell(cell);
        this.grid[cell] = flight.raw
          ? { kind: "raw", ing: flight.ing }
          : { kind: "cooked", ing: flight.ing, usesLeft: this.initialUsesLeft(flight.ing) };
        break;
      }
      case "tool-to-grid": {
        const cell = flight.toCell!;
        this.releaseCell(cell);
        this.grid[cell] = { kind: "cooked", ing: flight.ing, usesLeft: this.initialUsesLeft(flight.ing) };
        this.log("cooked", `${this.ingredientName(flight.ing)} ready`);
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
        const { index, dish, slot } = flight.toCustomer!;
        if (flight.fromCell !== undefined) {
          this.releaseCell(flight.fromCell);
          this.consumeCookedCell(flight.fromCell);
        }
        this.fillDish(index, dish, slot);
        break;
      }
      case "tool-to-customer":
      case "queue-to-customer": {
        const { index, dish, slot } = flight.toCustomer!;
        this.fillDish(index, dish, slot);
        break;
      }
      case "backpack-to-customer": {
        const { index, dish, slot } = flight.toCustomer!;
        const cell = flight.fromCell!;
        this.releaseCell(cell);
        const content = this.grid[cell];
        if (content.kind === "backpack") {
          const at = content.items.indexOf(flight.ing);
          if (at !== -1) content.items.splice(at, 1);
          if (content.items.length === 0) this.grid[cell] = { kind: "empty" };
        }
        this.fillDish(index, dish, slot);
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

  /** Fast-forwards everything in motion and stops as soon as the level needs another pick. */
  fastForward(maxSeconds = 600): number {
    const start = this.time;
    let guard = 0;
    while (this.status === "playing" && guard++ < 2000) {
      this.completeAllFlights();
      if (this.cookingCount === 0) break;
      if (this.time - start >= maxSeconds) break;
      const completion = this.nextCompletionIn();
      if (completion === null) break;
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

  /** Seconds until the next READY lane finishes; partial multi-input lanes are waiting, not cooking. */
  nextCompletionIn(): number | null {
    let best: number | null = null;
    for (const tool of this.tools) {
      for (let lane = 0; lane < tool.layout.laneCount; lane++) {
        const filled = this.laneSlots(tool, lane).filter((flat) => tool.slots[flat].item);
        if (filled.length === 0) continue;
        const lead = tool.slots[filled[0]].item!;
        if (lead.completed) continue;
        const step = lead.chain ? null : this.stepForLane(tool, lane);
        if (!lead.chain && (!step || !this.laneReady(tool, lane, step))) continue;
        const left = lead.duration - Math.min(...filled.map((flat) => tool.slots[flat].item!.elapsed));
        // A non-positive lane has finished but cannot currently discharge its
        // output (for example, ground coffee held in the grinder while the
        // coffee machine runs). Time cannot change that state, so it is a
        // resting point rather than another completion to wait for.
        if (left <= 0) continue;
        if (best === null || left < best) best = left;
      }
    }
    return best;
  }

  /** Dense ingredient indices the currently serveable customers still need. */
  neededIngredients(): Set<number> {
    const set = new Set<number>();
    for (const customer of this.active) {
      for (const dish of customer.dishes) for (const ing of dish.remaining) set.add(ing);
    }
    return set;
  }

  /**
   * Slots no remaining source could ever fill — a proof of unsatisfiability,
   * never a proof of satisfiability. This is the non-hot-loop form of "only
   * combine ingredients if they can create the desired dish": it answers the
   * question for the whole board rather than gating one pick, so a level that
   * has become unwinnable can be reported instead of silently timing out.
   *
   * Deliberately an UPPER BOUND on what is still reachable: it ignores tool
   * slot contention, grid space and the clock, so a slot it does NOT flag may
   * still turn out to be unservable in practice.
   */
  unsatisfiableSlots(): { customer: number; dish: number; slot: number; ing: number }[] {
    const out: { customer: number; dish: number; slot: number; ing: number }[] = [];
    for (const customer of this.active) {
      customer.dishes.forEach((dish, dishIndex) => {
        dish.order.slots.forEach((slot, i) => {
          if (dish.filled[i]) return;
          if (this.canStillObtain(slot.ing)) return;
          out.push({ customer: customer.index, dish: dishIndex, slot: i, ing: slot.ing });
        });
      });
    }
    return out;
  }

  /**
   * Auto Complete booster: finishes one dish of the left-most active customer,
   * drawing each unfilled slot from the backpack first, then the grid, then the
   * queues (a still-queued pickup counts as already processed once taken this
   * way, at its TERMINAL yield — following the whole chain, so a raw chicken
   * breast counts toward a fried one rather than a coated one). All-or-nothing.
   * Gates are irrelevant here: the dish completes atomically.
   */
  autoCompleteDish(): boolean {
    if (this.status !== "playing") return false;
    const customer = this.active[0];
    if (!customer) return false;
    const dishIndex = customer.dishes.findIndex((d) => !d.complete);
    if (dishIndex === -1) return false;
    const dish = customer.dishes[dishIndex];
    const needed: { slot: number; ing: number }[] = [];
    dish.order.slots.forEach((s, i) => {
      if (!dish.filled[i]) needed.push({ slot: i, ing: s.ing });
    });

    type Take =
      | { source: "backpack"; cell: number; itemIndex: number }
      | { source: "grid"; cell: number }
      | { source: "queue"; x: number; y: number; amount: number };

    const takenGridCells = new Set<number>();
    const takenQueueCells = new Set<string>();
    const plan: Take[] = [];

    for (const { ing } of needed) {
      const backpackCell = this.grid.findIndex(
        (c, i) => c.kind === "backpack" && c.items.includes(ing) && !takenGridCells.has(i),
      );
      if (backpackCell !== -1) {
        const content = this.grid[backpackCell];
        if (content.kind === "backpack") {
          takenGridCells.add(backpackCell);
          plan.push({ source: "backpack", cell: backpackCell, itemIndex: content.items.indexOf(ing) });
          continue;
        }
      }

      const gridCell = this.grid.findIndex(
        (c, i) => c.kind === "cooked" && c.ing === ing && !takenGridCells.has(i) && !this.reservedCells.has(i),
      );
      if (gridCell !== -1) {
        takenGridCells.add(gridCell);
        plan.push({ source: "grid", cell: gridCell });
        continue;
      }

      let found: { x: number; y: number; amount: number } | null = null;
      for (let x = 0; x < this.queueGrid.length && !found; x++) {
        for (let y = 0; y < this.queueGrid[x].length; y++) {
          if (takenQueueCells.has(`${x}:${y}`)) continue;
          const cell = this.queueGrid[x][y];
          if (!cell || cell.item.kind !== "ingredient" || cell.ing < 0) continue;
          if (this.ix.terminalOutput[cell.ing] !== ing) continue;
          found = { x, y, amount: this.ix.terminalYield[cell.ing] };
          break;
        }
      }
      if (!found) return false; // uncoverable from any source — abort, nothing taken
      takenQueueCells.add(`${found.x}:${found.y}`);
      plan.push({ source: "queue", x: found.x, y: found.y, amount: found.amount });
    }

    // Every slot is covered — commit.
    needed.forEach(({ slot, ing }, i) => {
      const step = plan[i];
      if (step.source === "backpack") {
        const content = this.grid[step.cell];
        if (content.kind === "backpack") {
          content.items.splice(step.itemIndex, 1);
          if (content.items.length === 0) this.grid[step.cell] = { kind: "empty" };
        }
      } else if (step.source === "grid") {
        this.consumeCookedCell(step.cell);
      } else if (step.amount <= 1) {
        this.queueGrid[step.x][step.y] = null;
      } else {
        const tally = (this.partialYield.get(ing) ?? 0) + 1;
        if (tally >= step.amount) {
          this.queueGrid[step.x][step.y] = null;
          this.partialYield.set(ing, 0);
        } else {
          this.partialYield.set(ing, tally);
        }
      }
      dish.filled[slot] = true;
    });

    this.advanceQueues();
    if (customer.dishes.every((d) => d.complete)) this.completeCustomer(customer);
    this.settle();
    this.checkEnd();
    return true;
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

  /** Removes up to `count` oldest dirty stacks (negative = all, for Clean Table). */
  clearDirtyStacks(count: number): number {
    if (count < 0) count = this.dirtyOrder.length;
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

  /**
   * Shift-up Row booster: sends every column's front-row movement instance to
   * the back of its own column(s). Ported unchanged from sim.ts.
   */
  forceShiftUp(): boolean {
    if (this.status !== "playing") return false;
    const seenGroups = new Set<number>();
    const removed: { x: number; cell: NodeQueueCell }[] = [];
    let touchedAny = false;

    for (let x = 0; x < this.queueGrid.length; x++) {
      const front = this.queueGrid[x][0];
      if (!front) continue;
      const isCombined = front.group !== -1 && this.groupKinds[front.group] === "combined";
      if (isCombined) {
        if (seenGroups.has(front.group)) continue; // already collected via an earlier column
        seenGroups.add(front.group);
      }
      touchedAny = true;
      for (const c of this.movementInstanceAt(x, 0)!) {
        removed.push({ x: c.x, cell: this.queueGrid[c.x][c.y]! });
        this.queueGrid[c.x][c.y] = null;
      }
    }
    if (!touchedAny) return false;

    this.advanceQueues();
    for (const { x, cell } of removed) this.appendToColumnBack(x, cell);
    return true;
  }

  /** True when this loss has a reason-specific rescue that can change state. */
  canSaveMe(maxUses: number): boolean {
    if (this.status !== "lost") return false;
    if (maxUses >= 0 && this.saveMeUsed >= maxUses) return false;
    if (this.loseReason === "grid-overflow") {
      return this.grid.some((cell) =>
        cell.kind === "raw" || (cell.kind === "cooked" && (cell.usesLeft ?? 1) <= SAVE_ME_BAG_CAPACITY)
      );
    }
    return this.loseReason === "customer-timeout" || this.loseReason === "deadlock";
  }

  /** Dispatches to one of the three deliberately distinct Save Me rescues. */
  saveMe(
    maxUses: number,
    bagCapacity = SAVE_ME_BAG_CAPACITY,
    shuffleDepth = SAVE_ME_SHUFFLE_DEPTH,
    rng: () => number = Math.random,
  ): boolean {
    if (!this.canSaveMe(maxUses)) return false;
    if (this.loseReason === "grid-overflow") return this.saveGridOverflow(bagCapacity);
    if (this.loseReason === "customer-timeout") return this.saveCustomerTimeout();
    return this.saveDeadlock(shuffleDepth, rng);
  }

  /** Grid overflow: place at most `capacity` non-dirty ingredient units in one bag. */
  private saveGridOverflow(capacity: number): boolean {
    const items: number[] = [];
    let firstClearedCell = -1;
    for (let i = 0; i < this.grid.length && items.length < Math.max(0, capacity); i++) {
      const cell = this.grid[i];
      if (cell.kind === "raw") {
        items.push(cell.ing);
        this.grid[i] = { kind: "empty" };
        if (firstClearedCell === -1) firstClearedCell = i;
        continue;
      }
      if (cell.kind !== "cooked") continue; // dirty objects and existing bags stay put
      const uses = cell.usesLeft ?? 1;
      // Keep a multi-use object whole: the backpack represents each remaining
      // use as one entry, and partially sweeping it would leave no guaranteed
      // free cell for the bag on a completely full board.
      if (uses > capacity - items.length) continue;
      for (let n = 0; n < uses; n++) items.push(cell.ing);
      this.grid[i] = { kind: "empty" };
      if (firstClearedCell === -1) firstClearedCell = i;
    }
    if (items.length === 0) return false;

    const existingBackpack = this.grid.findIndex((cell) => cell.kind === "backpack");
    if (existingBackpack !== -1) {
      const content = this.grid[existingBackpack];
      if (content.kind === "backpack") content.items.push(...items);
    } else {
      const freeCell = this.findFreeCell();
      this.grid[freeCell !== -1 ? freeCell : firstClearedCell] = { kind: "backpack", items };
    }
    return this.finishSaveMe(`Save Me: ${items.length} grid item(s) moved into the backpack`);
  }

  /** Customer timeout: refresh only customers whose patience reached zero. */
  private saveCustomerTimeout(): boolean {
    const expired = this.active.filter((customer) => customer.timeLeft <= 0);
    const targets = expired.length > 0 ? expired : this.active.slice(0, 1);
    if (targets.length === 0) return false;
    for (const customer of targets) customer.timeLeft = this.customerTime(customer.config);
    return this.finishSaveMe("Save Me: customer patience refreshed");
  }

  /**
   * Deadlock: break top-row ice and horizontal combined blocks, promote the
   * first useful pick found in each lane, then randomize the next few ungrouped
   * slots. If no useful item exists, promote one random item and free it from
   * grouping/ice so the run always receives a concrete new option.
   */
  private saveDeadlock(shuffleDepth: number, rng: () => number): boolean {
    const horizontalGroups = new Set<number>();
    for (let group = 0; group < this.groupKinds.length; group++) {
      if (this.groupKinds[group] !== "combined") continue;
      const cells = this.groupCells(group);
      if (cells.some((a) => cells.some((b) => a.y === b.y && a.x !== b.x))) {
        horizontalGroups.add(group);
      }
    }
    for (const column of this.queueGrid) {
      for (const cell of column) {
        if (cell && horizontalGroups.has(cell.group)) cell.group = -1;
      }
      const front = column[0];
      if (front && this.freezeCount(front.item) > 0) this.freezeRemaining.set(front.item, 0);
    }

    const chosenLanes = new Set<number>();
    for (let y = 0; y < this.queueHeight; y++) {
      for (let x = 0; x < this.queueGrid.length; x++) {
        if (chosenLanes.has(x)) continue;
        const cell = this.queueGrid[x][y];
        if (!cell || !this.isDeadlockRescueCandidate(cell)) continue;
        this.promoteQueueCell(x, y);
        chosenLanes.add(x);
      }
    }

    if (chosenLanes.size === 0) {
      const occupied: { x: number; y: number }[] = [];
      for (let y = 0; y < this.queueHeight; y++) {
        for (let x = 0; x < this.queueGrid.length; x++) {
          if (this.queueGrid[x][y]) occupied.push({ x, y });
        }
      }
      if (occupied.length === 0) return false;
      const pick = occupied[Math.min(occupied.length - 1, Math.floor(rng() * occupied.length))];
      const cell = this.queueGrid[pick.x][pick.y]!;
      if (cell.group !== -1) {
        for (const member of this.groupCells(cell.group)) this.queueGrid[member.x][member.y]!.group = -1;
      }
      this.freezeRemaining.set(cell.item, 0);
      this.promoteQueueCell(pick.x, pick.y);
      chosenLanes.add(pick.x);
    }

    for (const x of chosenLanes) this.shuffleBelowTop(x, shuffleDepth, rng);
    return this.finishSaveMe(
      `Save Me: broke queue locks and prioritized ${chosenLanes.size} pickable lane(s)`,
    );
  }

  private isDeadlockRescueCandidate(cell: NodeQueueCell): boolean {
    if (cell.item.kind !== "ingredient" || cell.ing < 0 || cell.group !== -1) return false;
    if (this.freezeCount(cell.item) > 0) return false;
    if (!this.neededIngredients().has(this.ix.terminalOutput[cell.ing])) return false;
    return this.planDispatch([cell], false).ok;
  }

  private promoteQueueCell(x: number, y: number): void {
    if (y <= 0) return;
    const column = this.queueGrid[x];
    const cell = column[y];
    for (let at = y; at > 0; at--) column[at] = column[at - 1];
    column[0] = cell;
  }

  /** Shuffle only loose cells; grouped geometry keeps its authored shape. */
  private shuffleBelowTop(x: number, depth: number, rng: () => number): void {
    const column = this.queueGrid[x];
    const positions: number[] = [];
    for (let y = 1; y <= Math.min(Math.max(0, depth), column.length - 1); y++) {
      if (column[y] && column[y]!.group === -1) positions.push(y);
    }
    for (let i = positions.length - 1; i > 0; i--) {
      const j = Math.min(i, Math.floor(rng() * (i + 1)));
      const a = positions[i];
      const b = positions[j];
      [column[a], column[b]] = [column[b], column[a]];
    }
  }

  private finishSaveMe(message: string): true {
    this.status = "playing";
    this.loseReason = null;
    this.saveMeUsed++;
    this.log("saved", message);
    return true;
  }

  // ---------- internals ----------

  private noteIssue(customer: number, dish: number, issue: OrderIssue): void {
    this.issues.push(`Customer ${customer + 1}, dish ${dish + 1}: ${describeIssue(issue)}`);
  }

  private toolTime(tool: number): number {
    return this.ix.doc.vertices.tool[tool]?.cookingTime ?? 0;
  }

  /**
   * Expands the authored queues into the runtime grid, resolving each data id
   * to a dense ingredient index through the id table and stamping group
   * membership. An id the table can't resolve becomes ing = -1 and an issue,
   * never a throw — a malformed string must not crash Play mode.
   */
  private buildQueueGrid(level: NodeLevelConfig): (NodeQueueCell | null)[][] {
    const height = level.queues.reduce((h, q) => Math.max(h, q.length), 0);
    const resolve = (item: QueueItem): number => {
      if (item.kind !== "ingredient") return -1;
      const name = this.ids.byId.ingredient.get(item.id);
      if (name === undefined) {
        this.issues.push(`Queue references unknown ingredient id ${item.id}`);
        return -1;
      }
      const ing = this.ix.ingByName.get(name);
      if (ing === undefined) {
        this.issues.push(`Queue references "${name}", which is not an ingredient vertex`);
        return -1;
      }
      return ing;
    };

    const grid: (NodeQueueCell | null)[][] = level.queues.map((lane) =>
      Array.from({ length: height }, (_, y) =>
        lane[y] ? { item: lane[y], ing: resolve(lane[y]), group: -1 } : null,
      ),
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

  private launch(spec: Omit<NodeFlight, "id">): NodeFlight {
    const flight: NodeFlight = { id: this.nextFlightId++, ...spec };
    this.flights.push(flight);
    return flight;
  }

  /** Flat slot indices belonging to one lane, in point order. */
  private laneSlots(state: NodeToolState, lane: number): number[] {
    const out: number[] = [];
    state.layout.flat.forEach((addr, flat) => {
      if (addr.lane === lane) out.push(flat);
    });
    return out;
  }

  /**
   * Which recipe a lane is working towards, resolved from EVERY item present.
   *
   * `recipeForInput` cannot answer this on a multi-input tool: ground coffee is
   * the first input of both the hot and the cool drink, so the coffee alone
   * names neither — the cup or teacup beside it decides. So this matches the
   * set of items against the tool's recipes and prefers a fully-satisfied one.
   *
   * Returns null when nothing present fits any recipe, which is what a chain
   * hop looks like: it carries its own route and the destination owns no recipe
   * for it.
   */
  private stepForLane(state: NodeToolState, lane: number): ProcessStep | null {
    const present: { point: number; ing: number }[] = [];
    for (const flat of this.laneSlots(state, lane)) {
      const item = state.slots[flat].item;
      if (item) present.push({ point: state.layout.flat[flat].point, ing: item.ing });
    }
    if (present.length === 0) return null;

    let partial: ProcessStep | null = null;
    for (const step of this.ix.stepsOfTool[state.index] ?? []) {
      const fits = present.every((p) => step.inputs.some((i) => i.ing === p.ing && i.point === p.point));
      if (!fits) continue;
      // Complete beats partial: a lane holding coffee + teacup satisfies the
      // hot recipe outright, while the cool one merely "fits" on the coffee.
      if (step.inputs.every((i) => present.some((p) => p.ing === i.ing && p.point === i.point))) {
        return step;
      }
      partial ??= step;
    }
    return partial;
  }

  /** Whether every point a step names holds its ingredient in this lane. */
  private laneReady(state: NodeToolState, lane: number, step: ProcessStep): boolean {
    return step.inputs.every((input) => {
      const flat = flatSlot(state.layout, input.point, lane);
      return flat !== -1 && state.slots[flat].item?.ing === input.ing;
    });
  }

  /**
   * A free position for `ing` at `tool`, honouring slot points.
   *
   * `point` is where this ingredient belongs — derived from the step for a real
   * recipe, forced to 0 for a chain hop, whose destination owns no recipe for
   * the item it receives.
   *
   * Lane choice is the part that matters. A multi-input tool must PREFER a lane
   * already holding part of the same job: put the coffee in lane 0 and the cup
   * in lane 1 and neither ever completes, even though the machine looks full.
   * So partially-filled compatible lanes are tried first, most-filled first,
   * and only then a completely empty one.
   */
  private freeSlotFor(tool: number, ing: number, point = this.pointFor(tool, ing)): number {
    const state = this.tools[tool];
    if (!state || point < 0) return -1;

    const taken = (flat: number) =>
      Boolean(state.slots[flat].item) || this.reservedSlots.has(`${tool}:${flat}`);

    const candidates: { flat: number; filled: number }[] = [];
    for (let lane = 0; lane < state.layout.laneCount; lane++) {
      const flat = flatSlot(state.layout, point, lane);
      if (flat === -1 || taken(flat)) continue;

      // How much of a job this lane already holds, and whether what is there
      // can coexist with `ing` — a lane committed to a different recipe is not
      // a candidate at all, or the two would deadlock each other.
      //
      // Asked as "does SOME recipe accept all of this together?", including the
      // incoming item. Resolving the lane's recipe first and then testing
      // against it is wrong: ground coffee alone fits both drinks, so picking
      // one arbitrarily would reject the teacup that decides it is the hot one.
      const others = this.laneSlots(state, lane).filter((f) => f !== flat && state.slots[f].item);
      if (others.length > 0) {
        const present = others.map((f) => ({
          point: state.layout.flat[f].point,
          ing: state.slots[f].item!.ing,
        }));
        present.push({ point, ing });
        const fits = (this.ix.stepsOfTool[tool] ?? []).some((step) =>
          present.every((p) => step.inputs.some((i) => i.ing === p.ing && i.point === p.point)),
        );
        if (!fits) continue;
      }
      candidates.push({ flat, filled: others.length });
    }

    candidates.sort((a, b) => b.filled - a.filled || a.flat - b.flat);
    return candidates[0]?.flat ?? -1;
  }

  /** The slot point `ing` enters at `tool`, or 0 when the tool owns no recipe for it. */
  private pointFor(tool: number, ing: number): number {
    for (const step of this.ix.stepsOfTool[tool] ?? []) {
      const at = inputPoint(step, ing);
      if (at !== -1) return at;
    }
    // A chain hop: the destination has no recipe, so the item simply occupies
    // the tool's first point. INV-INPUT-SLOT-STABLE keeps the branch above from
    // being ambiguous when a recipe does exist.
    return 0;
  }

  private reserveSlot(tool: number, slot: number): { tool: number; slot: number } {
    this.reservedSlots.add(`${tool}:${slot}`);
    return { tool, slot };
  }

  private releaseSlot(tool: number, slot: number): void {
    this.reservedSlots.delete(`${tool}:${slot}`);
  }

  /** A free preservation position for one tool, outside its recipe layout. */
  private freePreservationSlot(toolIndex: number): number {
    const tool = this.tools[toolIndex];
    if (!tool) return -1;
    for (let slot = tool.processSlotCount; slot < tool.slots.length; slot++) {
      if (!tool.slots[slot].item && !this.reservedSlots.has(`${toolIndex}:${slot}`)) return slot;
    }
    return -1;
  }

  /** First graph-ordered preservation buffer that accepts this ingredient. */
  private preservationDestination(ing: number): { tool: number; slot: number } | null {
    for (const tool of this.ix.preservationToolsForInput[ing] ?? []) {
      const slot = this.freePreservationSlot(tool);
      if (slot !== -1) return { tool, slot };
    }
    return null;
  }

  private findFreeCell(): number {
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i].kind === "empty" && !this.reservedCells.has(i) && this.isCellUsable(i)) return i;
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

  private initialUsesLeft(ing: number): number | undefined {
    const n = this.ix.usageNum[ing];
    return n && n > 1 ? n : undefined;
  }

  /** Serves one use of a cooked grid cell — decrements usesLeft, or clears the cell. */
  private consumeCookedCell(cell: number): void {
    const content = this.grid[cell];
    if (content.kind === "cooked" && content.usesLeft && content.usesLeft > 1) {
      this.grid[cell] = { kind: "cooked", ing: content.ing, usesLeft: content.usesLeft - 1 };
    } else {
      this.grid[cell] = { kind: "empty" };
    }
  }

  private customerTime(c: NodeCustomerConfig): number {
    if (c.waitTime <= 0) return Infinity;
    const bad = this.level?.weather && this.level.weather !== "Normal";
    return c.weatherEff === 1 && bad ? c.waitTime / 2 : c.waitTime;
  }

  // ---------- picking ----------

  /**
   * Adjacency-based Freeze thaw. Called from applyPick() with the picked
   * cells' PRE-removal coordinates.
   *
   * SIDEWAYS ONLY: picking in the lane to the left or the right breaks ice,
   * picking above or below it in its OWN lane does not. A frozen slot rides
   * its lane down as the items in front of it are taken, so counting those
   * same-lane picks would thaw every frozen slot for free just by emptying its
   * queue — the status would cost the player nothing.
   */
  private decrementAdjacentFreezes(pickedCells: { x: number; y: number }[]): void {
    for (const { x, y } of pickedCells) {
      const neighbors = [
        { x: x - 1, y },
        { x: x + 1, y },
      ];
      for (const n of neighbors) {
        const cell = this.queueGrid[n.x]?.[n.y];
        if (!cell) continue;
        const remaining = this.freezeCount(cell.item);
        if (remaining > 0) this.freezeRemaining.set(cell.item, remaining - 1);
      }
    }
  }

  /**
   * Resolves what picking (x,y) would do. `commit=false` is a pure query (any
   * reservations roll back); `commit=true` keeps them for the flights about to
   * launch. Because canPick and pick share planDispatch(), a "check weaker than
   * placement" bug — which would let a pick write a -1 cell — isn't possible.
   */
  private evaluatePick(
    x: number,
    y: number,
    commit: boolean,
    anyRow = false,
  ):
    | { ok: true; cells: { x: number; y: number }[]; cellsOf: NodeQueueCell[]; plan: Dispatch[] }
    | { ok: false; reason: string } {
    if (this.status !== "playing") return { ok: false, reason: "Level finished" };

    const cells = anyRow ? this.instanceAt(x, y) : this.pickInstanceCells(x);
    if (!cells) {
      const at = this.queueGrid[x]?.[y];
      return { ok: false, reason: at ? "Linked items are not all at the front" : "Queue empty" };
    }
    const cellsOf = cells.map((c) => this.queueGrid[c.x][c.y]!);

    // Any member's canPick effect blocks the whole instance. Freeze is
    // special-cased rather than going through the registry: its remaining count
    // is per-item state, and canPick(effect, ctx) can't identify which item an
    // EffectInstance belongs to.
    for (const cell of cellsOf) {
      for (const effect of cell.item.effects) {
        if (effect.effectId === EFFECT_FREEZE) {
          const remaining = this.freezeCount(cell.item);
          if (remaining > 0) {
            return { ok: false, reason: `Frozen — pick ${remaining} slot(s) beside it (left/right lane) to break the ice` };
          }
          continue;
        }
        const check = getQueueEffect(effect.effectId).canPick?.(effect, this.ctx);
        if (check && !check.ok) return { ok: false, reason: check.reason ?? "Blocked" };
      }
    }

    const planned = this.planDispatch(cellsOf, commit);
    if (!planned.ok) return planned;
    return { ok: true, cells, cellsOf, plan: planned.plan };
  }

  /** Clears the picked cells, settles gravity, dispatches — the shared tail of pick()/pickAt(). */
  private applyPick(r: { cells: { x: number; y: number }[]; cellsOf: NodeQueueCell[]; plan: Dispatch[] }): void {
    // Thaw first, while the picked cells' neighbors are still findable at their
    // pre-pick coordinates.
    this.decrementAdjacentFreezes(r.cells);

    // Clear and let gravity settle BEFORE dispatching, so nothing re-entrant can
    // observe a half-picked instance or the same cell twice.
    for (const c of r.cells) this.queueGrid[c.x][c.y] = null;
    this.advanceQueues();

    for (const cell of r.cellsOf) {
      for (const effect of cell.item.effects) getQueueEffect(effect.effectId).onPick?.(effect, this.ctx);
    }
    r.cellsOf.forEach((cell, i) => this.dispatchPicked(cell, r.plan[i]));

    if (this.instantFlights) {
      // settle() unconditionally, THEN resolve flights: an all-sweeper pick
      // launches nothing, so completeAllFlights() alone would never trigger
      // reclaimProcessableGridItems()/autoServe() off the stack the sweeper just cleared.
      this.settle();
      this.completeAllFlights();
    }
  }

  /** Cells of the instance fronting lane x, or null when nothing is pickable there. */
  private pickInstanceCells(x: number): { x: number; y: number }[] | null {
    const front = this.queueGrid[x]?.[0];
    if (!front) return null; // empty column, or a hole
    const cells = this.instanceAt(x, 0)!;
    if (front.group !== -1 && this.groupKinds[front.group] === "linked" && cells.some((c) => c.y !== 0)) {
      return null;
    }
    return cells;
  }

  /** The whole instance a pick at (x,y) would dispatch, with no row-0 gate. */
  private instanceAt(x: number, y: number): { x: number; y: number }[] | null {
    const cell = this.queueGrid[x]?.[y];
    if (!cell) return null;
    if (cell.group === -1) return [{ x, y }];
    return this.groupCells(cell.group);
  }

  /** The rigid movement unit at (x,y): a whole combined block, or just that cell. */
  private movementInstanceAt(x: number, y: number): { x: number; y: number }[] | null {
    const cell = this.queueGrid[x]?.[y];
    if (!cell) return null;
    if (cell.group !== -1 && this.groupKinds[cell.group] === "combined") return this.groupCells(cell.group);
    return [{ x, y }];
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
   * freeSlotFor()/reserveCell() helpers pick() uses, in the same order. A pick of
   * more than one item (a combined block or a linked chain) may always spill
   * onto the grid, even under "Block the pick" — parking the overflow is
   * inherent to those mechanics.
   */
  private planDispatch(
    cells: NodeQueueCell[],
    commit: boolean,
  ): { ok: true; plan: Dispatch[] } | { ok: false; reason: string } {
    const plan: Dispatch[] = [];
    const reservedSlots: { tool: number; slot: number }[] = [];
    const reservedCells: number[] = [];
    const rollback = () => {
      for (const s of reservedSlots) this.releaseSlot(s.tool, s.slot);
      for (const c of reservedCells) this.releaseCell(c);
    };

    const allowPark = this.outOfSlotPolicy === "park-on-grid" || cells.length > 1;
    const demand = this.pickPolicy === "wanted-only" ? this.demandBits() : null;

    for (const cell of cells) {
      if (cell.item.kind === "sweeper") {
        plan.push({ kind: "sweeper" });
        continue;
      }
      if (cell.ing < 0) {
        rollback();
        return { ok: false, reason: `Unknown ingredient id ${cell.item.id}` };
      }
      if (demand && !reachesAny(this.ix, cell.ing, demand)) {
        rollback();
        return { ok: false, reason: `${this.ingredientName(cell.ing)} can't complete any waiting order` };
      }

      const preservationTools = this.ix.preservationToolsForInput[cell.ing] ?? [];
      if (preservationTools.length > 0) {
        const destination = this.preservationDestination(cell.ing);
        if (!destination) {
          const tool = this.tools[preservationTools[0]];
          rollback();
          return {
            ok: false,
            reason: `${tool?.displayName ?? "Tool"} preservation slots are full`,
          };
        }
        this.reserveSlot(destination.tool, destination.slot);
        reservedSlots.push(destination);
        const step = (this.ix.stepsForInput[cell.ing] ?? []).find(
          (candidate) => candidate.tool === destination.tool,
        );
        plan.push({ kind: "tool", ...destination, step });
        continue;
      }

      const allSteps = this.ix.stepsForInput[cell.ing] ?? [];
      const eligible = allSteps.filter((step) => this.processMayStart(step));
      if (allSteps.length === 0) {
        // No tool needed — it only has to fit on the grid.
        const free = this.reserveCell();
        if (free === -1) {
          rollback();
          return { ok: false, reason: "No free grid cell" };
        }
        reservedCells.push(free);
        plan.push({ kind: "grid", cell: free, raw: false });
        continue;
      }

      let routed: { step: ProcessStep; slot: number } | null = null;
      for (const step of eligible) {
        const slot = this.freeSlotFor(step.tool, cell.ing, inputPoint(step, cell.ing));
        if (slot !== -1) {
          routed = { step, slot };
          break;
        }
      }
      if (routed) {
        this.reserveSlot(routed.step.tool, routed.slot);
        reservedSlots.push({ tool: routed.step.tool, slot: routed.slot });
        plan.push({ kind: "tool", tool: routed.step.tool, slot: routed.slot, step: routed.step });
        continue;
      }

      // A manual process that no active order needs is an intentional wait,
      // not a "tool full" error. Park the pickup so it can be reclaimed when
      // the matching customer appears, even under block-pick policy.
      if (eligible.length === 0) {
        const free = this.reserveCell();
        if (free === -1) {
          rollback();
          return { ok: false, reason: "No free grid cell for a waiting ingredient" };
        }
        reservedCells.push(free);
        plan.push({ kind: "grid", cell: free, raw: true });
        continue;
      }

      const toolName = this.ix.doc.vertices.tool[eligible[0].tool]?.displayName ?? "Tool";
      if (!allowPark) {
        rollback();
        return { ok: false, reason: `${toolName} is full` };
      }
      const free = this.reserveCell();
      if (free === -1) {
        rollback();
        return { ok: false, reason: `${toolName} is full and the grid has no space` };
      }
      reservedCells.push(free);
      plan.push({ kind: "grid", cell: free, raw: true });
    }

    if (!commit) rollback();
    return { ok: true, plan };
  }

  /** Routes one already-planned item to its destination, logging/counting it. */
  private dispatchPicked(cell: NodeQueueCell, d: Dispatch): void {
    if (d.kind === "sweeper") {
      const cleared = this.clearDirtyStacks(1);
      this.log("pick", `Sweeper used (${cleared} stack cleared)`);
      return;
    }
    this.ctx.picksMade++;
    this.ctx.picksByIngredient[cell.item.id] = (this.ctx.picksByIngredient[cell.item.id] ?? 0) + 1;
    this.log("pick", `Picked ${this.ingredientName(cell.ing)}`);
    if (d.kind === "tool") {
      this.launch({ kind: "queue-to-tool", ing: cell.ing, toTool: { tool: d.tool, slot: d.slot }, step: d.step });
      return;
    }
    if (!d.raw) {
      // No tool needed — this pickup already IS servable (ice, a chili bowl).
      // If a customer is already waiting, skip the grid landing entirely.
      const target = this.findServeTarget(cell.ing);
      if (target) {
        this.releaseCell(d.cell);
        this.launch({ kind: "queue-to-customer", ing: cell.ing, toCustomer: target });
        return;
      }
      this.launch({ kind: "queue-to-grid", ing: cell.ing, toCell: d.cell, raw: false });
      return;
    }
    this.launch({ kind: "queue-to-grid", ing: cell.ing, toCell: d.cell, raw: true });
  }

  // ---------- queue gravity ----------

  /**
   * Gravity. Every instance (a lone cell, or a whole "combined" group — a
   * "linked" group is NOT a movement instance) rises toward row 0 until nothing
   * can move. Ported unchanged from sim.ts.
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
          // Enumerate a multi-cell instance exactly once, from its anchor.
          if (inst[0].x !== x || inst[0].y !== y) continue;
          if (!this.canMoveUp(inst)) continue;
          this.moveUp(inst);
          moved = true;
        }
      }
      if (!moved) return;
    }
  }

  private canMoveUp(inst: { x: number; y: number }[]): boolean {
    const own = new Set(inst.map((c) => `${c.x}:${c.y}`));
    for (const c of inst) {
      if (c.y === 0) return false;
      if (own.has(`${c.x}:${c.y - 1}`)) continue; // vacated by this same instance
      if (this.queueGrid[c.x][c.y - 1] !== null) return false;
    }
    return true;
  }

  /** Precondition: canMoveUp(inst), and `inst` sorted by y ascending. */
  private moveUp(inst: { x: number; y: number }[]): void {
    for (const c of inst) {
      this.queueGrid[c.x][c.y - 1] = this.queueGrid[c.x][c.y];
      this.queueGrid[c.x][c.y] = null;
    }
  }

  /** Places `cell` after the last occupied row of column x, growing the grid if full. */
  private appendToColumnBack(x: number, cell: NodeQueueCell): void {
    const col = this.queueGrid[x];
    let y = col.length - 1;
    while (y >= 0 && col[y] === null) y--;
    const target = y + 1;
    if (target >= col.length) {
      // The grid must stay rectangular — grow every column, not just this one.
      for (const c of this.queueGrid) c.push(null);
    }
    this.queueGrid[x][target] = cell;
  }

  // ---------- tools ----------

  /**
   * Cooking runs per LANE, not per slot.
   *
   * That is the whole multi-input rule: a lane holding only the ground coffee
   * does not tick at all — its timer starts when the cup lands beside it, and
   * both items then advance together, so the elapsed values stay equal and the
   * minimum is the job's true age. On completion the lane empties as one.
   *
   * A single-input tool has one point, so every lane holds exactly one item and
   * this reduces to exactly the old per-slot behaviour.
   */
  private advanceTools(dt: number): void {
    for (const tool of this.tools) {
      for (let lane = 0; lane < tool.layout.laneCount; lane++) {
        const filled = this.laneSlots(tool, lane).filter((f) => tool.slots[f].item);
        if (filled.length === 0) continue;

        const lead = tool.slots[filled[0]].item!;
        const leadSlot = filled[0];
        const completed = lead.completed;
        const step = lead.chain || completed ? null : this.stepForLane(tool, lane);

        // Waiting for the other input. Nothing ages, so an ingredient parked
        // in a machine does not silently burn while its partner is in the queue.
        if (!completed && step && !this.laneReady(tool, lane, step)) continue;

        if (!completed) {
          for (const f of filled) tool.slots[f].item!.elapsed += dt;
          const elapsed = Math.min(...filled.map((f) => tool.slots[f].item!.elapsed));
          if (elapsed < lead.duration) continue;
        }

        const clearLane = () => {
          for (const f of filled) tool.slots[f].item = null;
        };

        // --- spelling 1: chainTools. One recipe, several tools, NO intermediate
        // item. Hop to the next tool instead of producing output, waiting for a
        // free slot there if needed (retried every tick). Verbatim legacy.
        const chain = lead.chain;
        if (chain && chain.remaining.length > 0) {
          const nextTool = chain.remaining[0];
          // A chain hop lands at the destination's first point: that tool owns
          // no recipe for what it is receiving.
          const nextSlot = this.freeSlotFor(nextTool, lead.ing, 0);
          if (nextSlot === -1) continue;
          this.reserveSlot(nextTool, nextSlot);
          this.launch({
            kind: "tool-to-tool",
            ing: lead.ing,
            fromTool: { tool: tool.index, slot: leadSlot },
            toTool: { tool: nextTool, slot: nextSlot },
            chain: { remaining: chain.remaining.slice(1), out: chain.out, amount: chain.amount },
          });
          clearLane();
          continue;
        }

        const out = completed?.out ?? chain?.out ?? step?.out ?? lead.ing;
        const amount = completed?.amount ?? chain?.amount ?? step?.amount ?? 1;

        // --- spelling 2: a real intermediate vertex. Forward one produced
        // piece immediately when the next tool has room; surplus pieces park on
        // the grid and reclaimProcessableGridItems() moves them onward as that
        // tool frees. This is the game's potato -> sliced potato (amount 2)
        // behavior: one slice enters the fryer and the other visibly waits.
        const onward = this.forwardStepFor(out);
        if (onward) {
          const nextSlot = this.freeSlotFor(onward.tool, out);
          // A single intermediate keeps the established no-grid behavior: it
          // waits in its producer when the next tool is occupied. Grid parking
          // is specifically the surplus path of a batch output.
          if (amount === 1 && nextSlot === -1) {
            // The recipe is done even though its output cannot advance. A
            // buffered tool keeps the concrete output visible in the producer
            // (ground coffee in the grinder), releases any partner points,
            // and retries only when downstream state changes. Unbuffered tools
            // retain their established source-item representation.
            if (!completed && tool.preservationSlotCount > 0) {
              for (const flat of filled) if (flat !== leadSlot) tool.slots[flat].item = null;
              lead.ing = out;
              lead.elapsed = lead.duration;
              lead.completed = { out, amount };
            }
            continue;
          }
          let remaining = amount;
          if (nextSlot !== -1) {
            this.reserveSlot(onward.tool, nextSlot);
            this.launch({
              kind: "tool-to-tool",
              ing: out,
              fromTool: { tool: tool.index, slot: leadSlot },
              toTool: { tool: onward.tool, slot: nextSlot },
              step: onward,
              // No chain: the destination owns a real recipe for this input.
            });
            remaining--;
          }
          for (let n = 0; n < remaining; n++) {
            const cell = this.reserveCell();
            if (cell === -1) {
              this.lose("grid-overflow", "No free grid cell for a process intermediate");
              return;
            }
            this.launch({
              kind: "tool-to-grid",
              ing: out,
              fromTool: { tool: tool.index, slot: leadSlot },
              toCell: cell,
            });
          }
          clearLane();
          continue;
        }

        // The lane empties as the output leaves; each unit flies separately —
        // straight to a customer already waiting for it when there is one,
        // skipping the grid; otherwise it lands on the grid as usual.
        let overflowed = false;
        for (let n = 0; n < amount; n++) {
          const target = this.findServeTarget(out);
          if (target) {
            this.launch({
              kind: "tool-to-customer",
              ing: out,
              fromTool: { tool: tool.index, slot: leadSlot },
              toCustomer: target,
            });
            continue;
          }
          const cell = this.reserveCell();
          if (cell === -1) {
            this.lose("grid-overflow", "No free grid cell for a cooked ingredient");
            overflowed = true;
            break;
          }
          this.launch({
            kind: "tool-to-grid",
            ing: out,
            fromTool: { tool: tool.index, slot: leadSlot },
            toCell: cell,
          });
        }
        if (overflowed) return;
        clearLane();
      }
      if (this.status !== "playing") return;
    }
  }

  /**
   * The step a freshly produced output must be forwarded into, or null when it
   * should land normally. THE rule for the two-edge chain spelling: forward iff
   * the output is non-servable and something consumes it. A servable output
   * always lands, even when a further recipe exists — it is a real item a
   * customer may want.
   */
  private forwardStepFor(out: number): ProcessStep | null {
    if (this.ix.servable[out]) return null;
    return this.routingStep(out);
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

  // ---------- serving ----------

  /** Fills serve slots, launches matches and reclaims parked pickups, until settled. */
  private settle(): void {
    for (let guard = 0; guard < 100; guard++) {
      const before = `${this.servedCount}:${this.flights.length}`;
      // A flight may have just freed a downstream tool after advanceTools()
      // already visited its upstream producer. Retry completed lanes at zero
      // elapsed time so held intermediates move immediately when space opens.
      this.advanceTools(0);
      this.fillSlots();
      this.autoServe();
      this.reclaimPreservedItems();
      this.reclaimProcessableBackpackItems();
      this.reclaimProcessableGridItems();
      if (this.status !== "playing") return;
      if (`${this.servedCount}:${this.flights.length}` === before) return;
    }
  }

  /**
   * True when a serve flight already claims this exact slot. Legacy had to
   * COUNT in-flight items per cooked id against how many the dish still wanted;
   * because a flight now names its slot, this is a plain identity test and
   * double-booking is impossible by construction.
   */
  private slotClaimed(customer: number, dish: number, slot: number): boolean {
    return this.flights.some(
      (f) =>
        isServeFlight(f) &&
        f.toCustomer!.index === customer &&
        f.toCustomer!.dish === dish &&
        f.toCustomer!.slot === slot,
    );
  }

  /**
   * Finds a customer/dish/slot that wants `ing` right now and isn't already
   * claimed — used to skip landing an item on the grid when someone's waiting.
   * A multi-use ingredient (usageNum > 1) always lands instead, so its remaining
   * uses aren't thrown away on one direct serve.
   */
  private findServeTarget(ing: number): { index: number; dish: number; slot: number } | null {
    if (this.ix.usageNum[ing] > 1) return null;
    for (const customer of this.active) {
      for (let dishIndex = 0; dishIndex < customer.dishes.length; dishIndex++) {
        const dish = customer.dishes[dishIndex];
        for (let slot = 0; slot < dish.order.slots.length; slot++) {
          if (dish.filled[slot]) continue;
          if (dish.order.slots[slot].ing !== ing) continue;
          if (!dish.gateOpen(slot)) continue;
          if (this.slotClaimed(customer.index, dishIndex, slot)) continue;
          return { index: customer.index, dish: dishIndex, slot };
        }
      }
    }
    return null;
  }

  private autoServe(): void {
    for (const customer of this.active) {
      customer.dishes.forEach((dish, dishIndex) => {
        for (let slot = 0; slot < dish.order.slots.length; slot++) {
          if (dish.filled[slot]) continue;
          if (this.slotClaimed(customer.index, dishIndex, slot)) continue;
          // Toppings can't be served until this dish's base slot is filled.
          // Legacy re-derived that from the ingredient's `baseId` list on every
          // attempt; here it is a property of the resolved order.
          if (!dish.gateOpen(slot)) continue;
          const ing = dish.order.slots[slot].ing;

          // The Save Me backpack is checked before the grid — see saveMe().
          const backpackCell = this.grid.findIndex(
            (c, i) => c.kind === "backpack" && c.items.includes(ing) && !this.reservedCells.has(i),
          );
          if (backpackCell !== -1) {
            this.reservedCells.add(backpackCell);
            this.launch({
              kind: "backpack-to-customer",
              ing,
              fromCell: backpackCell,
              toCustomer: { index: customer.index, dish: dishIndex, slot },
            });
            continue;
          }

          const cell = this.grid.findIndex(
            (c, i) => c.kind === "cooked" && c.ing === ing && !this.reservedCells.has(i),
          );
          if (cell === -1) continue;
          this.reservedCells.add(cell);
          this.launch({
            kind: "grid-to-customer",
            ing,
            fromCell: cell,
            toCustomer: { index: customer.index, dish: dishIndex, slot },
          });
        }
      });
    }
  }

  /** Moves parked pickups and non-servable intermediates into a tool as soon as it frees. */
  private reclaimProcessableGridItems(): void {
    for (let cell = 0; cell < this.grid.length; cell++) {
      const content = this.grid[cell];
      if ((content.kind !== "raw" && content.kind !== "cooked") || this.reservedCells.has(cell)) continue;
      if (content.kind === "raw" && (this.ix.preservationToolsForInput[content.ing]?.length ?? 0) > 0) {
        const destination = this.preservationDestination(content.ing);
        if (!destination) continue;
        const step = (this.ix.stepsForInput[content.ing] ?? []).find(
          (candidate) => candidate.tool === destination.tool,
        );
        this.reservedCells.add(cell);
        this.launch({
          kind: "grid-to-tool",
          ing: content.ing,
          fromCell: cell,
          toTool: this.reserveSlot(destination.tool, destination.slot),
          step,
        });
        continue;
      }
      const step = content.kind === "raw" ? this.routingStep(content.ing) : this.forwardStepFor(content.ing);
      if (!step) continue;
      const slot = this.freeSlotFor(step.tool, content.ing, inputPoint(step, content.ing));
      if (slot === -1) continue;
      this.reservedCells.add(cell);
      this.launch({
        kind: "grid-to-tool",
        ing: content.ing,
        fromCell: cell,
        toTool: this.reserveSlot(step.tool, slot),
        step,
      });
    }
  }

  /** Moves processable Save Me items into tools under the same auto/manual gate as the grid. */
  private reclaimProcessableBackpackItems(): void {
    for (let cell = 0; cell < this.grid.length; cell++) {
      const content = this.grid[cell];
      if (content.kind !== "backpack" || this.reservedCells.has(cell)) continue;
      for (const ing of content.items) {
        if ((this.ix.preservationToolsForInput[ing]?.length ?? 0) > 0) {
          const destination = this.preservationDestination(ing);
          if (!destination) continue;
          const step = (this.ix.stepsForInput[ing] ?? []).find(
            (candidate) => candidate.tool === destination.tool,
          );
          this.reservedCells.add(cell);
          this.launch({
            kind: "backpack-to-tool",
            ing,
            fromCell: cell,
            toTool: this.reserveSlot(destination.tool, destination.slot),
            step,
          });
          break;
        }
        const step = this.routingStep(ing);
        if (!step) continue;
        const slot = this.freeSlotFor(step.tool, ing, inputPoint(step, ing));
        if (slot === -1) continue;
        this.reservedCells.add(cell);
        this.launch({
          kind: "backpack-to-tool",
          ing,
          fromCell: cell,
          toTool: this.reserveSlot(step.tool, slot),
          step,
        });
        break;
      }
    }
  }

  /** Moves buffered ingredients into this tool's recipe slots as soon as they are available. */
  private reclaimPreservedItems(): void {
    for (const tool of this.tools) {
      for (let preserved = tool.processSlotCount; preserved < tool.slots.length; preserved++) {
        const item = tool.slots[preserved].item;
        if (!item) continue;
        const step = (this.ix.stepsForInput[item.ing] ?? []).find(
          (candidate) => candidate.tool === tool.index && this.processMayStart(candidate),
        );
        if (!step) continue;
        const slot = this.freeSlotFor(tool.index, item.ing, inputPoint(step, item.ing));
        if (slot === -1) continue;
        this.launch({
          kind: "tool-to-tool",
          ing: item.ing,
          fromTool: { tool: tool.index, slot: preserved },
          toTool: this.reserveSlot(tool.index, slot),
          step,
        });
        tool.slots[preserved].item = null;
      }
    }
  }

  /** Fills one dish slot and completes the customer if that was their last. */
  private fillDish(customerIndex: number, dishIndex: number, slot: number): void {
    const customer = this.active.find((c) => c.index === customerIndex);
    const dish = customer?.dishes[dishIndex];
    if (dish && slot >= 0 && slot < dish.filled.length) dish.filled[slot] = true;
    if (customer && customer.dishes.every((d) => d.complete)) this.completeCustomer(customer);
  }

  private completeCustomer(customer: NodeCustomerState): void {
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
    for (const dirtyId of this.dirtyTypesFor(customer)) this.addDirtyDish(customer.index, dirtyId);
  }

  /**
   * Which dirty object(s) a served customer leaves: one per dish, read straight
   * off the composite's leavesDirty edge. Legacy had to scan every
   * DirtyObjectDef's sourceCookedId list against the dish contents; the graph
   * states it directly. A map defining no dirty objects at all keeps the old
   * behaviour — exactly one generic dirty dish per served customer.
   */
  private dirtyTypesFor(customer: NodeCustomerState): number[] {
    if (this.ix.dirtyName.length === 0) return [DIRTY_DISH_ID];
    const ids: number[] = [];
    for (const dish of customer.dishes) {
      const dirty = this.ix.dirtyOf[dish.order.orderable] ?? -1;
      if (dirty >= 0) ids.push(dirty);
    }
    return ids;
  }

  /**
   * Sends the departing customer's dirty dish to the grid. The target stack is
   * claimed now (so simultaneous dishes don't overfill it) but only becomes
   * visible when the flight lands. Stacks never mix types.
   */
  private addDirtyDish(fromCustomer: number, dirtyId: number): void {
    const configured = dirtyId >= 0 ? this.ix.doc.vertices.dirty[dirtyId]?.maxStack : undefined;
    const height = Math.max(1, configured ?? 5);
    const openStack = this.dirtyOrder.find((i) => {
      const cell = this.grid[i];
      const pendingEntry = this.pendingDirty.get(i);
      const pending = pendingEntry?.count ?? 0;
      const count = cell.kind === "dirty" ? cell.count : 0;
      const existingType = cell.kind === "dirty" ? cell.dirtyId : pendingEntry?.dirtyId;
      // A cell claimed by an in-flight dish counts as a stack already — including
      // another dish from this SAME completeCustomer() call, which is exactly
      // what should stack together. Only a cell being actively cleared by staff
      // is excluded: it's about to disappear.
      const beingCleared = this.flights.some((f) => f.kind === "dirty-to-staff" && f.fromCell === i);
      return (
        (cell.kind === "dirty" || pending > 0) &&
        existingType === dirtyId &&
        count + pending < height &&
        !beingCleared
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

    // Headless: land it now, so the next customer is only seated once the table
    // is cleared (a staff member must not sweep a plate mid-air).
    if (this.instantFlights) {
      this.releaseCell(target);
      this.placeDirtyAt(target, dirtyId);
      return;
    }

    const prevPending = this.pendingDirty.get(target);
    this.pendingDirty.set(target, { count: (prevPending?.count ?? 0) + 1, dirtyId });
    this.launch({ kind: "customer-to-grid", ing: -1, dirtyId, fromCustomer, toCell: target });
  }

  private placeDirtyAt(cell: number, dirtyId: number): void {
    const existing = this.grid[cell];
    if (existing.kind === "dirty" && existing.dirtyId === dirtyId) {
      existing.count++;
    } else {
      // The stack may have been swept while this dish was travelling — or it
      // just never mixes with a different-typed stack.
      this.grid[cell] = { kind: "dirty", dirtyId, count: 1 };
      if (!this.dirtyOrder.includes(cell)) this.dirtyOrder.push(cell);
    }
    const name = dirtyId >= 0 ? (this.ix.doc.vertices.dirty[dirtyId]?.displayName ?? "dish") : "dish";
    this.log("dirty-added", `Dirty ${name} stacked`);
  }

  private fillSlots(): void {
    while (this.active.length < this.level.serveableSlots && this.pending.length > 0) {
      const customer = this.pending.shift()!;
      if (customer.isStaff) {
        // Visible in `active` while their stacks fly in, so the view has a card
        // to animate toward and to celebrate on once they're done.
        this.active.push(customer);
        this.startStaffClearing(customer);
        continue;
      }
      this.active.push(customer);
      this.log("customer-arrived", `Customer ${customer.index + 1} is ordering`);
    }
  }

  /** One flight per dirty stack a staff customer will clear (oldest first). */
  private startStaffClearing(customer: NodeCustomerState): void {
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
        ing: -1,
        dirtyId: content.kind === "dirty" ? content.dirtyId : undefined,
        fromCell: cell,
        toCustomer: { index: customer.index, dish: 0, slot: 0 },
      });
    }
  }

  private completeStaffCustomer(customer: NodeCustomerState): void {
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
      this.cookingCount === 0 && this.flights.length === 0 && !this.grid.some((c) => c.kind === "raw");
    // A non-empty backpack still holds servable items even when everything else
    // is dry — without this, an out-of-ingredient loss could re-fire the instant
    // a Save Me rescue lands, before autoServe() ever draws from it.
    const backpackEmpty = !this.grid.some((c) => c.kind === "backpack" && c.items.length > 0);
    if (queuesEmpty && nothingMoving && backpackEmpty && this.active.length > 0) {
      if (this.options.onOutOfIngredient) this.options.onOutOfIngredient(this);
      else this.lose("out-of-ingredient", "Queues empty with orders outstanding");
      return;
    }

    // No passage of time can change a board with no cooking/flight/raw work in
    // progress. If every non-empty lane is blocked, classify a full usable grid
    // as space overflow; otherwise this is a queue/tool deadlock eligible for
    // the ice/group/prioritization Save Me.
    const noTimedProgress = this.flights.length === 0 && this.nextCompletionIn() === null;
    if (this.options.detectDeadlockLoss && !queuesEmpty && noTimedProgress && this.active.length > 0) {
      const checks = this.queueGrid.map((_, lane) => this.canPick(lane));
      if (!checks.some((check) => check.ok)) {
        if (this.findFreeCell() === -1 && this.grid.some((cell) => cell.kind === "cooked" || cell.kind === "raw")) {
          this.lose("grid-overflow", "No free grid slot and no queue lane can be picked");
        } else {
          this.lose("deadlock", "No queue lane can be picked: ice or tool inputs are locked");
        }
      }
    }
  }

  // ---------- demand ----------

  /** Bitset of every ingredient some active dish still needs. */
  private demandBits(): Uint8Array {
    const bits = new Uint8Array(Math.ceil(this.ix.ingName.length / 8));
    for (const customer of this.active) {
      for (const dish of customer.dishes) {
        for (const ing of dish.remaining) bits[ing >> 3] |= 1 << (ing & 7);
      }
    }
    return bits;
  }

  /** A manual process starts only while an active customer needs its output path. */
  private processMayStart(step: ProcessStep): boolean {
    return step.auto || reachesAny(this.ix, step.out, this.demandBits());
  }

  /** First graph-ordered process for `ing` that is currently permitted to start. */
  private routingStep(ing: number): ProcessStep | null {
    return (this.ix.stepsForInput[ing] ?? []).find((step) => this.processMayStart(step)) ?? null;
  }

  /** Whether any remaining source could still yield `ing` — see unsatisfiableSlots(). */
  private canStillObtain(ing: number): boolean {
    for (const cell of this.grid) {
      if (cell.kind === "cooked" && cell.ing === ing) return true;
      if (cell.kind === "backpack" && cell.items.includes(ing)) return true;
      if (cell.kind === "raw" && this.ix.terminalOutput[cell.ing] === ing) return true;
    }
    for (const flight of this.flights) if (flight.ing === ing) return true;
    for (const tool of this.tools) {
      for (const slot of tool.slots) {
        if (!slot.item) continue;
        const out = slot.item.chain?.out ?? this.ix.terminalOutput[slot.item.ing];
        if (out === ing || this.ix.terminalOutput[out] === ing) return true;
      }
    }
    for (const col of this.queueGrid) {
      for (const cell of col) {
        if (cell && cell.ing >= 0 && this.ix.terminalOutput[cell.ing] === ing) return true;
      }
    }
    return false;
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
