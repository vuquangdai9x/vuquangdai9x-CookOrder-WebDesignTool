// Customer Config — top tier of the Design page.
// Ordered arrival sequence of customers and the dish(es) each one orders.
// See docs/ToolDesign.md "Customer Config window".

import Sortable from "sortablejs";
import { serializeCustomers } from "../../core/parser.ts";
import type { CustomerConfig, GlobalDefs, MapDef } from "../../core/types.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import { numberField, pickerGrid, showContextMenu } from "../contextMenu.ts";
import type { MenuItem } from "../contextMenu.ts";
import { button, el } from "../dom.ts";
import { ingredientIconEl, statusIconEl } from "../icon.ts";
import { Section } from "./section.ts";

export interface CustomerSectionDeps {
  map: MapDef;
  defs: GlobalDefs;
  level: LevelData;
  parse(): CustomerConfig[];
  onSaved(): void;
  /** Lets the queue section's Recipe Pieces counts follow order edits live. */
  onCommit?(): void;
}

const isStaff = (c: CustomerConfig) => c.dishes.length === 0;

export function createCustomerSection(deps: CustomerSectionDeps): Section<CustomerConfig[]> {
  const section: Section<CustomerConfig[]> = new Section<CustomerConfig[]>({
    title: "Customers",
    saveLabel: "Save Customers",
    initial: deps.parse(),
    renderBody: (draft, body) => renderBody(section, deps, draft, body),
    onCommit: () => deps.onCommit?.(),
    save: (draft) => {
      deps.level.customerString = serializeCustomers(draft);
      deps.onSaved();
    },
    menuItems: (draft) => [
      {
        label: "Clear All",
        danger: true,
        separator: true,
        onSelect: () => {
          if (!confirm("Remove every customer from this level?")) return;
          const removed = draft.length;
          draft.length = 0;
          section.commit("Clear all customers", 0, removed);
        },
      },
    ],
  });
  section.render();
  return section;
}

function renderBody(
  section: Section<CustomerConfig[]>,
  deps: CustomerSectionDeps,
  draft: CustomerConfig[],
  body: HTMLElement,
): void {
  const row = el("div", { class: "customer-cards" });

  draft.forEach((customer, index) => {
    row.append(customerCard(section, deps, draft, customer, index));
  });

  const addCard = el("div", { class: "customer-card add-card" }, ["＋"]);
  addCard.title = "Append a customer";
  addCard.addEventListener("click", () => {
    draft.push({ waitTime: 0, weatherEff: 0, dishes: [{ cookedIds: [], effects: [] }] });
    section.commit("Add customer", 1);
  });
  row.append(addCard);

  Sortable.create(row, {
    animation: 150,
    draggable: ".customer-card:not(.add-card)",
    handle: ".customer-head",
    onEnd: (evt) => {
      if (evt.oldIndex === undefined || evt.newIndex === undefined) return;
      if (evt.oldIndex === evt.newIndex) return;
      const [moved] = draft.splice(evt.oldIndex, 1);
      draft.splice(Math.min(evt.newIndex, draft.length), 0, moved);
      section.commit("Reorder customers");
    },
  });

  body.append(row);
}

function customerCard(
  section: Section<CustomerConfig[]>,
  deps: CustomerSectionDeps,
  draft: CustomerConfig[],
  customer: CustomerConfig,
  index: number,
): HTMLElement {
  const staff = isStaff(customer);
  const card = el("div", { class: `customer-card${staff ? " staff" : ""}` });

  const waitInput = el("input", {
    type: "number",
    value: String(customer.waitTime),
    title: "Patience timer in seconds (0 = no limit)",
  }) as HTMLInputElement;
  waitInput.addEventListener("change", () => {
    customer.waitTime = Number(waitInput.value) || 0;
    section.commit("Set wait time");
  });

  const weatherToggle = button(
    customer.weatherEff ? "🌧" : "☁",
    () => {
      customer.weatherEff = customer.weatherEff ? 0 : 1;
      section.commit("Toggle weather effect");
    },
    {
      class: `weather-toggle${customer.weatherEff ? " on" : ""}`,
      title: "Weather-affected: bad weather halves this customer's patience",
    },
  );

  const head = el("div", { class: "customer-head" }, [
    el("span", { class: "cust-index" }, [staff ? `#${index + 1} 🧑‍🍳` : `#${index + 1}`]),
    el("span", { class: "wait-badge" }, [
      customer.waitTime === 0 ? "∞" : "", waitInput,
    ]),
    weatherToggle,
  ]);
  head.addEventListener("contextmenu", (e) =>
    showContextMenu(e, cardMenu(section, deps, draft, customer, index), {
      title: `Customer #${index + 1}`,
    }),
  );
  card.append(head);

  if (staff) {
    card.append(el("div", { class: "staff-note" }, ["Staff — clears dirty stacks"]));
  } else {
    customer.dishes.forEach((dish, di) => {
      const dishRow = el("div", { class: "dish-row" }, [
        el("span", { class: "dish-label" }, [`D${di + 1}`]),
      ]);

      dish.cookedIds.forEach((cookedId, ci) => {
        const chip = el("span", { class: "chip icon-chip" }, [ingredientIconEl(cookedId, 64)]);
        chip.title = deps.map.cookedIngredients.find((c) => c.id === cookedId)?.name ?? "";
        chip.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          dish.cookedIds.splice(ci, 1);
          section.commit("Remove ingredient from dish", 0, 1);
        });
        dishRow.append(chip);
      });

      const addChip = button(
        "＋",
        (e) =>
          showContextMenu(
            e,
            [
              {
                label: "Add cooked ingredient",
                expand: (close) =>
                  pickerGrid(
                    deps.map.cookedIngredients.map((c) => ({
                      id: c.id,
                      label: c.name,
                      icon: ingredientIconEl(c.id, 64),
                    })),
                    (id) => {
                      dish.cookedIds.push(id);
                      section.commit("Add ingredient to dish", 1);
                      close();
                    },
                  ),
              },
            ],
            { title: `Dish ${di + 1}` },
          ),
        { class: "chip add-chip" },
      );
      dishRow.append(addChip);

      for (const effect of dish.effects) {
        dishRow.append(
          el("span", { class: "chip effect-chip" }, [
            statusIconEl(effect.effectId, 48),
            ...(effect.params.length ? [el("small", {}, [effect.params.join(":")])] : []),
          ]),
        );
      }

      dishRow.addEventListener("contextmenu", (e) =>
        showContextMenu(e, dishMenu(section, deps, customer, di), { title: `Dish ${di + 1}` }),
      );
      card.append(dishRow);
    });

    card.append(
      button(
        "+ Dish",
        () => {
          customer.dishes.push({ cookedIds: [], effects: [] });
          section.commit("Add dish", 1);
        },
        { class: "small-btn add-dish" },
      ),
    );
  }

  return card;
}

function cardMenu(
  section: Section<CustomerConfig[]>,
  _deps: CustomerSectionDeps,
  draft: CustomerConfig[],
  customer: CustomerConfig,
  index: number,
): MenuItem[] {
  const blank = (): CustomerConfig => ({
    waitTime: 0,
    weatherEff: 0,
    dishes: [{ cookedIds: [], effects: [] }],
  });
  return [
    {
      label: "Insert Before",
      onSelect: () => {
        draft.splice(index, 0, blank());
        section.commit("Insert customer before", 1);
      },
    },
    {
      label: "Insert After",
      onSelect: () => {
        draft.splice(index + 1, 0, blank());
        section.commit("Insert customer after", 1);
      },
    },
    {
      label: "Duplicate",
      onSelect: () => {
        draft.splice(index + 1, 0, structuredClone(customer));
        section.commit("Duplicate customer", 1);
      },
    },
    {
      label: isStaff(customer) ? "Convert to Customer" : "Mark as Staff",
      separator: true,
      onSelect: () => {
        if (isStaff(customer)) customer.dishes = [{ cookedIds: [], effects: [] }];
        else customer.dishes = []; // dish-less customer == staff
        section.commit("Toggle staff");
      },
    },
    {
      label: "Remove",
      danger: true,
      separator: true,
      onSelect: () => {
        draft.splice(index, 1);
        section.commit("Remove customer", 0, 1);
      },
    },
  ];
}

function dishMenu(
  section: Section<CustomerConfig[]>,
  deps: CustomerSectionDeps,
  customer: CustomerConfig,
  dishIndex: number,
): MenuItem[] {
  const dish = customer.dishes[dishIndex];
  const items: MenuItem[] = deps.defs.effects
    .filter((def) => def.id !== 0)
    .map((def) => {
      const active = dish.effects.some((e) => e.effectId === def.id);
      return {
        label: def.name,
        icon: statusIconEl(def.id, 48),
        active,
        expand: (close: () => void) => {
          const wrap = el("div", { class: "ctx-sub" });
          const existing = dish.effects.find((e) => e.effectId === def.id);
          const params = existing ? [...existing.params] : def.paramDefs.map(() => 1);
          def.paramDefs.forEach((p, i) => {
            wrap.append(
              numberField(p.name, params[i] ?? 1, (v) => {
                params[i] = v;
              }),
            );
          });
          wrap.append(
            button(active ? "Update" : "Apply", () => {
              dish.effects = dish.effects.filter((e) => e.effectId !== def.id);
              dish.effects.push({ effectId: def.id, params });
              section.commit(`Set dish effect ${def.name}`);
              close();
            }),
            ...(active
              ? [
                  button(
                    "Remove",
                    () => {
                      dish.effects = dish.effects.filter((e) => e.effectId !== def.id);
                      section.commit(`Clear dish effect ${def.name}`);
                      close();
                    },
                    { class: "danger" },
                  ),
                ]
              : []),
          );
          return wrap;
        },
      };
    });

  items.push({
    label: "Remove Dish",
    danger: true,
    separator: true,
    onSelect: () => {
      customer.dishes.splice(dishIndex, 1);
      section.commit("Remove dish", 0, 1);
    },
  });
  return items;
}
