// Initial data: global definition tables (from the sheet's ConfigTables tab)
// and the bundled Map 1 (burger) snapshot converted from the sheet.

import type { GlobalDefs } from "../core/types.ts";
import type { MapData } from "./mapLoader.ts";
import map1Json from "./map1_burger.json";

/** From ConfigTables: ingredient statuses, grid cell statuses, colors. */
export const GLOBAL_DEFS: GlobalDefs = {
  effects: [
    { id: 0, name: "None", icon: "", description: "", paramDefs: [] },
    {
      id: 1, name: "Freeze", icon: "🧊",
      description: "Frozen ingredient; param = number of picks to thaw.",
      paramDefs: [{ name: "thawCount", dataType: "int" }],
    },
    {
      id: 2, name: "Link", icon: "🔗",
      description: "Linked to another item.",
      paramDefs: [{ name: "linkId", dataType: "int" }],
    },
    {
      id: 3, name: "HoldingKey", icon: "🗝️",
      description: "Carries a colored key that unlocks matching locked cells.",
      paramDefs: [{ name: "colorId", dataType: "int" }],
    },
  ],
  cellTypes: [
    { id: 0, name: "Normal", icon: "", description: "", paramDefs: [] },
    {
      id: 1, name: "Blocked", icon: "⛔",
      description: "Fully locked; unusable for the whole level.",
      paramDefs: [],
    },
    {
      id: 2, name: "OrderLock", icon: "🔒",
      description: "Locked until X orders are completed.",
      paramDefs: [{ name: "orderCount", dataType: "int" }],
    },
    {
      id: 3, name: "IngredientSlot", icon: "🍽",
      description:
        "Keyed to one ingredient: opens once X of that specific ingredient have been used.",
      paramDefs: [
        { name: "ingredientId", dataType: "int" },
        { name: "amount", dataType: "int" },
      ],
    },
    {
      id: 4, name: "ColorLock", icon: "🎨",
      description:
        "Color-locked; serve X key-holding ingredients of the matching color to open.",
      paramDefs: [
        { name: "colorId", dataType: "int" },
        { name: "keyCount", dataType: "int" },
      ],
    },
  ],
  customerTypes: [
    { id: 0, name: "Normal", icon: "🙂", description: "Orders dishes.", paramDefs: [] },
    {
      id: 1, name: "Staff", icon: "🧑‍🍳",
      description: "Clears X oldest dirty stacks, needs no dishes.",
      paramDefs: [{ name: "stackCount", dataType: "int" }],
    },
  ],
};

/** Colors table from ConfigTables (used by HoldingKey / ColorLock params). */
export const KEY_COLORS = [
  { id: 0, name: "None", hex: "#00000000" },
  { id: 1, name: "Red", hex: "#FF0000FF" },
  { id: 2, name: "Yellow", hex: "#FFFF00FF" },
  { id: 3, name: "Green", hex: "#008000FF" },
  { id: 4, name: "Blue", hex: "#0000FFFF" },
  { id: 5, name: "Purple", hex: "#800080FF" },
];

export const MAP1_DATA = map1Json as MapData;
