// The customer section, forked for the bracket dish format.
//
// This is the one Design section the new format genuinely changes. A legacy
// dish was a flat chip list, so the editor was a flat chip list. A node dish is
// a TREE — a composite, its slots, and what fills each — and that tree is what
// makes INV-DISH-SINGLE-ORDERABLE hold BY CONSTRUCTION: the designer picks the
// orderable first, and each slot then offers only its own options. No gesture
// produces a dish mixing two composites.
//
// The tree is nevertheless NOT what a designer reads day to day. A card shows
// each dish as ONE LINE — the composite, then a flat run of ingredient icons,
// repeated for quantity and tinted by which slot they fill. Structure is
// visible as colour rather than as nesting, which keeps twenty customers
// scannable; the full per-slot editor is one right-click away.
//
// Everything else — history, the unsaved badge, Save, the kebab, the inline
// string preview — comes from the shared `Section` shell unchanged.

import { showContextMenu } from "../contextMenu.ts";
import { button, el } from "../dom.ts";
import { cookedIconEl, customerTypeIconEl } from "../icon.ts";
import { Section } from "../design/section.ts";
import { customerColor } from "../design/customerColors.ts";
import { difficultyColor, difficultyRatio } from "../design/estimateDifficulty.ts";
import type { EstimateResult } from "../design/estimateDifficulty.ts";
import { parseNodeCustomers, serializeNodeCustomers } from "../../core/nodeParser.ts";
import type { DishNode, NodeCustomerConfig, NodeDish } from "../../core/nodeParser.ts";
import type { GraphIndex, IndexedSlot } from "../../core/nodeIndex.ts";
import { describeIssue, orderIdIndex, resolveOrder } from "../../core/nodeOrder.ts";
import type { IdIndex } from "../../data/nodeIdTable.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import type { GlobalDefs } from "../../core/types.ts";
import { CUSTOMER_STAFF } from "../../core/effects.ts";
import { WEATHER } from "../../data/configLoader.ts";

export interface NodeCustomerSectionDeps {
  ix: GraphIndex;
  defs: GlobalDefs;
  level: LevelData;
  /** Dense ingredient index -> data id, for writing ids back into the tree. */
  dataIdOf: Map<number, number>;
  onSaved(): void;
  onCommit?(): void;
  /** Latest Estimate Difficulty run, for the per-customer cost badges. */
  currentEstimate?(): EstimateResult | null;
  /** Opens the customer auto-generate dialog (the level bar wires this up). */
  onAutoGenerate?(): void;
}

export function createNodeCustomerSection(
  deps: NodeCustomerSectionDeps,
): Section<NodeCustomerConfig[]> {
  const ids: IdIndex = orderIdIndex(deps.ix);

  const section: Section<NodeCustomerConfig[]> = new Section<NodeCustomerConfig[]>({
    title: "Customers",
    saveLabel: "Save Customers",
    initial: parseSafely(deps.level.customerString),
    renderBody: (draft, body) => renderBody(section, deps, ids, draft, body),
    onCommit: () => deps.onCommit?.(),
    save: (draft) => {
      deps.level.customerString = serializeNodeCustomers(draft);
      deps.onSaved();
    },
    stringPreview: (draft) => serializeNodeCustomers(draft),
    headerButtons: (self) => [
      button("＋ Customer", () => {
        self.draft.push(newCustomer(deps.ix, ids));
        self.commit("Add customer", 1, 0);
      }),
      ...(deps.onAutoGenerate
        ? [button("🎲 Auto Generate", () => deps.onAutoGenerate!(), {
            title: "Generate a whole customer list from weights and a complexity curve",
          })]
        : []),
    ],
  });
  return section;
}

/** A malformed stored string must open the editor, not blank the page. */
function parseSafely(text: string): NodeCustomerConfig[] {
  try {
    return parseNodeCustomers(text);
  } catch (err) {
    console.warn("Customer string could not be parsed — starting empty", err);
    return [];
  }
}

// ---------- tree helpers ----------

const dataIdOfComposite = (ids: IdIndex, name: string) => ids.byNode.composite.get(name);
const dataIdOfGroup = (ids: IdIndex, name: string) => ids.byNode.group.get(name);

/**
 * How many members a slot may hold. A fixed slot holds one; a group holds its
 * `maxQuantity`, with -1 meaning unlimited. This single number replaces the old
 * SINGLE/MULTIPLE distinction — "exactly one" is simply a cap of 1.
 */
export function slotCapacity(slot: IndexedSlot): number {
  if (slot.kind === "fixed") return 1;
  return slot.maxQuantity < 0 ? Number.POSITIVE_INFINITY : Math.max(1, slot.maxQuantity);
}

/** The bracket node a slot's members live in — the root for a fixed slot, a `{gN:…}` for a group. */
function containerFor(
  ids: IdIndex,
  ix: GraphIndex,
  root: DishNode,
  slot: IndexedSlot,
  create: boolean,
): DishNode | null {
  if (slot.group === -1) return root;
  const groupId = dataIdOfGroup(ids, ix.groupName[slot.group]);
  if (groupId === undefined) return null;
  const existing = root.members.find((m): m is DishNode => m.kind === "group" && m.id === groupId);
  if (existing) return existing;
  if (!create) return null;
  const fresh: DishNode = { kind: "group", id: groupId, members: [] };
  root.members.push(fresh);
  return fresh;
}

/** Members of one slot, in dish order, as dense ingredient indices. */
function membersOf(
  ix: GraphIndex,
  ids: IdIndex,
  root: DishNode,
  orderable: number,
  slotIndex: number,
): number[] {
  const slot = ix.slotsOfComposite[orderable]?.[slotIndex];
  if (!slot) return [];
  const container = containerFor(ids, ix, root, slot, false);
  if (!container) return [];
  const out: number[] = [];
  for (const member of container.members) {
    if (member.kind !== "ingredient") continue;
    const name = ids.byId.ingredient.get(member.id);
    const ing = name === undefined ? undefined : ix.ingByName.get(name);
    if (ing !== undefined && slot.options.includes(ing)) out.push(ing);
  }
  return out;
}

export function addToSlot(
  ix: GraphIndex,
  ids: IdIndex,
  root: DishNode,
  orderable: number,
  slotIndex: number,
  ing: number,
): void {
  const slot = ix.slotsOfComposite[orderable]?.[slotIndex];
  if (!slot) return;
  const container = containerFor(ids, ix, root, slot, true);
  if (!container) return;
  const dataId = ids.byNode.ingredient.get(ix.ingName[ing]);
  if (dataId === undefined) return;

  // At capacity, the oldest member makes room. For a cap of 1 that reads as
  // "picking a new option replaces the current one", which is what a
  // choose-exactly-one slot should do.
  const capacity = slotCapacity(slot);
  let held = membersOf(ix, ids, root, orderable, slotIndex).length;
  while (held >= capacity) {
    const at = container.members.findIndex((m) => m.kind === "ingredient");
    if (at === -1) break;
    container.members.splice(at, 1);
    held--;
  }
  container.members.push({ kind: "ingredient", id: dataId });
}

export function removeFromSlot(
  ix: GraphIndex,
  ids: IdIndex,
  root: DishNode,
  orderable: number,
  slotIndex: number,
  ing: number,
): void {
  const slot = ix.slotsOfComposite[orderable]?.[slotIndex];
  if (!slot) return;
  const container = containerFor(ids, ix, root, slot, false);
  if (!container) return;
  const dataId = ids.byNode.ingredient.get(ix.ingName[ing]);
  const at = container.members.findIndex((m) => m.kind === "ingredient" && m.id === dataId);
  if (at !== -1) container.members.splice(at, 1);
  // An emptied group bracket is removed rather than left as `{g0:}`, which the
  // grammar cannot round-trip.
  if (container !== root && container.members.length === 0) {
    const index = root.members.indexOf(container);
    if (index !== -1) root.members.splice(index, 1);
  }
}

/** A dish holding just the first orderable's base slot, filled with its first option. */
function newDish(ix: GraphIndex, ids: IdIndex): NodeDish | null {
  const orderable = ix.orderables[0];
  if (orderable === undefined) return null;
  const compositeId = dataIdOfComposite(ids, ix.compositeName[orderable]);
  if (compositeId === undefined) return null;
  const dish: NodeDish = { root: { kind: "composite", id: compositeId, members: [] }, effects: [] };
  seedRequiredSlots(ix, ids, dish, orderable);
  return dish;
}

/**
 * Fills the base, and the topping too when the composite requires one. A dish
 * that opens already violating `toppingRequired` would just be a warning the
 * designer has to clear by hand.
 */
function seedRequiredSlots(ix: GraphIndex, ids: IdIndex, dish: NodeDish, orderable: number): void {
  const slots = ix.slotsOfComposite[orderable] ?? [];
  slots.forEach((slot, index) => {
    const required = slot.isBase || (!slot.isBase && ix.doc.vertices.composite[orderable]?.toppingRequired);
    if (!required) return;
    const option = slot.options[0];
    if (option !== undefined) addToSlot(ix, ids, dish.root, orderable, index, option);
  });
}

function newCustomer(ix: GraphIndex, ids: IdIndex): NodeCustomerConfig {
  const dish = newDish(ix, ids);
  return { typeId: 0, waitTime: 0, weatherEff: 0, dishes: dish ? [dish] : [] };
}

/** Replaces a dish's composite wholesale — every slot is re-seeded from the new one. */
function retargetDish(ix: GraphIndex, ids: IdIndex, dish: NodeDish, orderable: number): void {
  const compositeId = dataIdOfComposite(ids, ix.compositeName[orderable]);
  if (compositeId === undefined) return;
  dish.root = { kind: "composite", id: compositeId, members: [] };
  seedRequiredSlots(ix, ids, dish, orderable);
}

const orderableOf = (ix: GraphIndex, ids: IdIndex, dish: NodeDish): number => {
  const name = ids.byId.composite.get(dish.root.id);
  return name === undefined ? -1 : (ix.compositeByName.get(name) ?? -1);
};

// ---------- rendering ----------

function renderBody(
  section: Section<NodeCustomerConfig[]>,
  deps: NodeCustomerSectionDeps,
  ids: IdIndex,
  draft: NodeCustomerConfig[],
  body: HTMLElement,
): void {
  const { ix } = deps;
  const estimate = deps.currentEstimate?.() ?? null;

  const list = el("div", { class: "node-customer-row", "data-scroll-key": "node-customers" });
  draft.forEach((customer, index) => {
    list.append(customerCard(section, deps, ids, customer, index, estimate));
  });
  if (draft.length === 0) {
    list.append(el("p", { class: "muted" }, ["No customers yet — use ＋ Customer."]));
  }

  // Live validation. Every dish is resolved against the graph, so a dish that
  // leaves a required topping empty, or names an id the graph no longer offers,
  // says so here rather than at play time.
  const problems: string[] = [];
  draft.forEach((customer, ci) => {
    customer.dishes.forEach((dish, di) => {
      for (const issue of resolveOrder(ix, dish, ids).issues) {
        problems.push(`Customer ${ci + 1}, dish ${di + 1}: ${describeIssue(issue)}`);
      }
    });
  });

  body.replaceChildren(
    list,
    ...(problems.length
      ? [
          el("div", { class: "warnings" }, [
            el("strong", {}, [`${problems.length} dish issue(s)`]),
            ...problems.slice(0, 12).map((p) => el("div", {}, [p])),
          ]),
        ]
      : []),
  );
}

function customerCard(
  section: Section<NodeCustomerConfig[]>,
  deps: NodeCustomerSectionDeps,
  ids: IdIndex,
  customer: NodeCustomerConfig,
  index: number,
  estimate: EstimateResult | null,
): HTMLElement {
  const { ix, defs } = deps;
  const isStaff = customer.typeId === CUSTOMER_STAFF;
  const timed = customer.weatherEff !== 0 || customer.waitTime > 0;
  const card = el("div", {
    class: `customer-card node-cust${isStaff ? " staff" : ""}${timed ? " timed" : ""}`,
  });
  card.style.setProperty("--customer-color", customerColor(index));

  const cost = estimate?.perCustomer.find((c) => c.index === index);
  if (cost && estimate) {
    const bar = el("div", {
      class: "difficulty-bar",
      title: `Peak grid pressure: ${cost.gridOccupied} cell(s); ${cost.gridWaste} of ingredients this order doesn't need.`,
    });
    bar.style.background = difficultyColor(difficultyRatio(cost.gridOccupied, estimate.perCustomer));
    card.append(bar);
  }

  const typeSelect = el("select", { class: "cust-type", title: "Customer type" }) as HTMLSelectElement;
  for (const type of defs.customerTypes) {
    typeSelect.append(el("option", { value: String(type.id) }, [`${type.icon || ""} ${type.name}`.trim()]));
  }
  typeSelect.value = String(customer.typeId);
  typeSelect.addEventListener("change", () => {
    customer.typeId = Number(typeSelect.value);
    if (customer.typeId === CUSTOMER_STAFF) customer.dishes = [];
    section.commit("Change customer type");
  });

  const waitInput = el("input", {
    type: "number",
    class: "cust-wait",
    value: String(customer.waitTime),
    title: "Patience timer in seconds (0 = no limit)",
  }) as HTMLInputElement;
  waitInput.addEventListener("change", () => {
    customer.waitTime = Number(waitInput.value) || 0;
    section.commit("Set wait time");
  });

  const head = el("div", { class: "customer-head" }, [
    el("span", { class: "cust-index" }, [`#${index + 1}`]),
    customerTypeIconEl(customer.typeId, 20),
    typeSelect,
    waitInput,
    weatherSelect(section, customer, deps.level.weather),
    button("✕", () => {
      section.draft.splice(index, 1);
      section.commit("Remove customer", 0, 1);
    }, { class: "danger cust-remove", title: "Remove this customer" }),
  ]);
  head.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(
      e,
      [
        {
          label: "⧉ Duplicate customer",
          onSelect: () => {
            section.draft.splice(index + 1, 0, structuredClone(customer));
            section.commit("Duplicate customer", 1, 0);
          },
        },
        {
          label: "✕ Remove customer",
          danger: true,
          onSelect: () => {
            section.draft.splice(index, 1);
            section.commit("Remove customer", 0, 1);
          },
        },
      ],
      { title: `Customer #${index + 1}` },
    );
  });
  card.append(head);

  if (isStaff) {
    const amount = el("input", {
      type: "number",
      min: "1",
      class: "cust-wait",
      value: String(customer.staffAmount ?? 1),
    }) as HTMLInputElement;
    amount.addEventListener("change", () => {
      customer.staffAmount = Math.max(1, Number(amount.value) || 1);
      section.commit("Set staff stack amount");
    });
    card.append(el("div", { class: "staff-note" }, ["🧹 clears ", amount, " stack(s)"]));
    return card;
  }

  customer.dishes.forEach((dish, dishIndex) => {
    card.append(dishLine(section, deps, ids, customer, dish, dishIndex));
  });
  card.append(
    button("＋ Dish", () => {
      const fresh = newDish(ix, ids);
      if (!fresh) return;
      customer.dishes.push(fresh);
      section.commit("Add dish", 1, 0);
    }, { class: "add-dish" }),
  );
  return card;
}

/**
 * The weather control, drawn as icons rather than words.
 *
 * The DATA is a flag — `weatherEff` is 0 or 1 — so the options are "unaffected"
 * and "affected", labelled with real entries from the weather table: the Normal
 * glyph, and the glyph of whatever weather this level actually runs. Listing
 * all five would imply a per-customer weather the level format cannot store.
 */
function weatherSelect(
  section: Section<NodeCustomerConfig[]>,
  customer: NodeCustomerConfig,
  levelWeather: string,
): HTMLElement {
  const normal = WEATHER.find((w) => w.id === "Normal") ?? WEATHER[0];
  const active = WEATHER.find((w) => w.id === levelWeather && w.id !== "Normal") ??
    WEATHER.find((w) => w.id !== "Normal") ?? normal;

  const select = el("select", {
    class: "cust-weather",
    title:
      `Weather-affected: in bad weather this customer's patience is halved. ` +
      `This level's weather is "${levelWeather}".`,
  }) as HTMLSelectElement;
  select.append(
    el("option", { value: "0" }, [`${normal.emoji} ${normal.id}`]),
    el("option", { value: "1" }, [`${active.emoji} affected`]),
  );
  select.value = customer.weatherEff ? "1" : "0";
  select.addEventListener("change", () => {
    customer.weatherEff = Number(select.value) ? 1 : 0;
    section.commit("Set weather effect");
  });
  return select;
}

/**
 * One dish, one line: the composite picker, then a FLAT run of ingredient
 * icons. Each icon carries the colour of the slot it fills, so base, topping
 * and any nested group read apart at a glance without the line ever nesting.
 * Repeats are drawn once per copy, so quantity is visible as quantity.
 */
function dishLine(
  section: Section<NodeCustomerConfig[]>,
  deps: NodeCustomerSectionDeps,
  ids: IdIndex,
  customer: NodeCustomerConfig,
  dish: NodeDish,
  dishIndex: number,
): HTMLElement {
  const { ix } = deps;
  const orderable = orderableOf(ix, ids, dish);
  const line = el("div", { class: "dish-line" });

  const picker = el("select", { class: "dish-composite" }) as HTMLSelectElement;
  for (const composite of ix.orderables) {
    picker.append(
      el("option", { value: String(composite) }, [
        ix.doc.vertices.composite[composite]?.displayName ?? ix.compositeName[composite],
      ]),
    );
  }
  picker.value = String(orderable);
  picker.addEventListener("change", () => {
    retargetDish(ix, ids, dish, Number(picker.value));
    section.commit("Change dish type");
  });
  line.append(picker);

  if (orderable === -1) {
    line.append(el("span", { class: "nodegraph-bad" }, [`unknown composite ${dish.root.id}`]));
    return line;
  }

  const icons = el("div", { class: "dish-ings" });
  const slots = ix.slotsOfComposite[orderable] ?? [];
  slots.forEach((slot, slotIndex) => {
    for (const ing of membersOf(ix, ids, dish.root, orderable, slotIndex)) {
      const dataId = ids.byNode.ingredient.get(ix.ingName[ing]);
      const chip = el("span", {
        // slot-N drives the background tint; the base always lands on slot-0's
        // colour because the base slot is emitted first.
        class: `dish-ing slot-${slotIndex % 6}${slot.isBase ? " is-base" : ""}`,
        title: `${ix.doc.vertices.ingredient[ing]?.displayName ?? ix.ingName[ing]} — ${
          slot.isBase ? "base" : slot.group === -1 ? "item" : ix.groupName[slot.group]
        }`,
      });
      chip.append(dataId === undefined ? el("span", { class: "icon" }, ["❔"]) : cookedIconEl(dataId, 34));
      icons.append(chip);
    }
  });
  if (icons.children.length === 0) icons.append(el("span", { class: "muted" }, ["(empty)"]));
  line.append(icons);

  // The full per-slot editor lives here rather than on the line, so the line
  // stays a readout and the card stays narrow.
  line.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e, dishMenu(section, deps, ids, customer, dish, dishIndex, orderable), {
      title: ix.doc.vertices.composite[orderable]?.displayName ?? ix.compositeName[orderable],
    });
  });
  return line;
}

/** One expandable menu section per slot, plus the dish-level actions. */
function dishMenu(
  section: Section<NodeCustomerConfig[]>,
  deps: NodeCustomerSectionDeps,
  ids: IdIndex,
  customer: NodeCustomerConfig,
  dish: NodeDish,
  dishIndex: number,
  orderable: number,
) {
  const { ix } = deps;
  const slots = ix.slotsOfComposite[orderable] ?? [];

  const slotItems = slots.map((slot, slotIndex) => {
    const label = slot.isBase
      ? "Base"
      : slot.group === -1
        ? "Item"
        : (ix.doc.vertices.group[slot.group]?.displayName ?? ix.groupName[slot.group]);
    const capacity = slotCapacity(slot);
    const held = membersOf(ix, ids, dish.root, orderable, slotIndex).length;
    const cap = capacity === Number.POSITIVE_INFINITY ? "∞" : String(capacity);
    return {
      label: `${label} (${held}/${cap})`,
      expand: () => slotEditor(section, deps, ids, dish, orderable, slotIndex),
    };
  });

  return [
    ...slotItems,
    {
      label: "⧉ Duplicate dish",
      separator: true,
      onSelect: () => {
        customer.dishes.splice(dishIndex + 1, 0, structuredClone(dish));
        section.commit("Duplicate dish", 1, 0);
      },
    },
    {
      label: "✕ Remove dish",
      danger: true,
      onSelect: () => {
        customer.dishes.splice(dishIndex, 1);
        section.commit("Remove dish", 0, 1);
      },
    },
  ];
}

/** The option grid for one slot: click to add, right-click a held chip to remove. */
function slotEditor(
  section: Section<NodeCustomerConfig[]>,
  deps: NodeCustomerSectionDeps,
  ids: IdIndex,
  dish: NodeDish,
  orderable: number,
  slotIndex: number,
): HTMLElement {
  const { ix } = deps;
  const slot = ix.slotsOfComposite[orderable]?.[slotIndex];
  const wrap = el("div", { class: "slot-editor" });
  if (!slot) return wrap;

  const rerender = () => {
    const held = membersOf(ix, ids, dish.root, orderable, slotIndex);
    const capacity = slotCapacity(slot);
    grid.replaceChildren(
      ...slot.options.map((option) => {
        const count = held.filter((m) => m === option).length;
        const dataId = ids.byNode.ingredient.get(ix.ingName[option]);
        const chip = el("button", {
          class: `dish-chip${count > 0 ? " on" : ""}`,
          title: `${ix.ingName[option]} — click to add, right-click to remove one`,
        });
        chip.append(
          dataId === undefined ? el("span", { class: "icon" }, ["❔"]) : cookedIconEl(dataId, 30),
          el("span", {}, [ix.doc.vertices.ingredient[option]?.displayName ?? ix.ingName[option]]),
          ...(count > 1 ? [el("span", { class: "dish-chip-count" }, [`×${count}`])] : []),
        );
        chip.addEventListener("click", () => {
          addToSlot(ix, ids, dish.root, orderable, slotIndex, option);
          section.commit(`Add ${ix.ingName[option]}`);
          rerender();
        });
        chip.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          removeFromSlot(ix, ids, dish.root, orderable, slotIndex, option);
          section.commit(`Remove ${ix.ingName[option]}`);
          rerender();
        });
        return chip;
      }),
    );
    caption.textContent =
      `${held.length}/${capacity === Number.POSITIVE_INFINITY ? "∞" : capacity} filled` +
      (slot.isBase ? " · base (required)" : "");
  };

  const caption = el("small", { class: "muted" });
  const grid = el("div", { class: "slot-editor-grid" });
  wrap.append(caption, grid);
  rerender();
  return wrap;
}
