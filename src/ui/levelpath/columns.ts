// The Level Path table's column model.
//
// One list, in display order, with the group each column belongs to — the four
// visibility toggles in the config bar are nothing more than a filter over this
// list, so adding a column never means touching the toggles, and a toggle can
// never disagree with what is on screen.
//
// The statistic columns for slot and cell statuses are DERIVED from the
// definition tables rather than hand-listed: a status added to
// ingredient-statuses.json or cell-statuses.json has to appear here on its own,
// or the "num of each status" the designer asked for silently stops being
// "each".

import type { GlobalDefs } from "../../core/types.ts";
import type { LevelStats } from "./levelStats.ts";

export type ColumnGroup = "info" | "generator" | "statistic" | "action" | "status";

export interface ColumnDef {
  id: string;
  group: ColumnGroup;
  /** Header text. Kept short — the header is the narrowest thing in the column. */
  label: string;
  /** Header tooltip, for the columns whose label had to be abbreviated. */
  title?: string;
  /** Base width in px, before the config bar's width scale multiplies it. */
  width: number;
  /**
   * Statistic columns only: the number this column shows, which is also what
   * the colour ramp normalizes across every level on screen.
   */
  metric?: (stats: LevelStats) => number;
}

/** Status ids that mean "nothing here" and would only ever show a column of zeroes. */
const NEUTRAL_STATUS_ID = 0;

const INFO_COLUMNS: ColumnDef[] = [
  { id: "index", group: "info", label: "Level", width: 96, title: "#index, weather and difficulty tag. Drag to reorder; right-click for the row menu." },
  { id: "weather", group: "info", label: "Weather", width: 110 },
  { id: "tag", group: "info", label: "Tag", width: 110 },
  { id: "unlock", group: "info", label: "Unlock", width: 130, title: "featureUnlock string" },
  { id: "note", group: "info", label: "Designer note", width: 180 },
];

const GENERATOR_COLUMNS: ColumnDef[] = [
  { id: "weights", group: "generator", label: "Ingredient weights", width: 220, title: "Click to edit the generator's per-ingredient weights" },
  { id: "dishes", group: "generator", label: "Dish sequence", width: 150, title: "Dish count per customer — click to edit" },
  { id: "complexity", group: "generator", label: "Complexity", width: 130, title: "Total ingredients per customer, by order position — click to edit" },
  { id: "shuffle", group: "generator", label: "Shuffle", width: 130, title: "Queue displacement by lane position — click to edit" },
  { id: "obstacles", group: "generator", label: "Obstacles", width: 190, title: "How many blocked cells, frozen slots, bosses… a generate should build in. Click to edit." },
  { id: "seed", group: "generator", label: "Seed", width: 110, title: "Random seed — the same seed rebuilds the same level. Blank lets the generator pick and pin one." },
];

const CORE_STAT_COLUMNS: ColumnDef[] = [
  { id: "stat-customers", group: "statistic", label: "Cust.", title: "Num Customers", width: 62, metric: (s) => s.numCustomers },
  { id: "stat-dishes", group: "statistic", label: "Dishes", title: "Num Dishes", width: 62, metric: (s) => s.numDishes },
  { id: "stat-ingredients", group: "statistic", label: "Ingr.", title: "Num Ingredients ordered", width: 62, metric: (s) => s.numIngredients },
  { id: "stat-coin", group: "statistic", label: "Coin", title: "Total coin collected across every ordered ingredient", width: 68, metric: (s) => s.totalCoin },
  { id: "stat-price", group: "statistic", label: "Price", title: "Sum of concrete ingredient prices in every ordered dish combination", width: 72, metric: (s) => s.totalPrice },
  { id: "stat-types", group: "statistic", label: "Types", title: "Distinct item types in the queue", width: 62, metric: (s) => s.itemTypes },
];

const GROUP_STAT_COLUMNS: ColumnDef[] = [
  { id: "stat-linked", group: "statistic", label: "Linked", title: "Queue slots belonging to a linked group", width: 66, metric: (s) => s.linkedSlots },
  { id: "stat-combined", group: "statistic", label: "Comb.", title: "Queue slots belonging to a combined block", width: 66, metric: (s) => s.combinedSlots },
  { id: "stat-lockkey", group: "statistic", label: "Lock&Key", title: "Key-carrying queue slots plus colour-locked grid cells", width: 78, metric: (s) => s.lockAndKey },
];

const TAIL_STAT_COLUMNS: ColumnDef[] = [
  { id: "stat-timed", group: "statistic", label: "Timed", title: "Customers with a patience timer", width: 66, metric: (s) => s.numTimedCustomers },
];

const TRAILING_COLUMNS: ColumnDef[] = [
  { id: "actions", group: "action", label: "Actions", width: 210 },
  { id: "status", group: "status", label: "Status", width: 280 },
];

export const slotStatusColumnId = (id: number): string => `stat-slot-${id}`;
export const cellStatusColumnId = (id: number): string => `stat-cell-${id}`;

/**
 * Every column, in display order.
 *
 * `defs` supplies the status tables, so this is a function rather than a
 * constant — the two "num of each status" runs are as long as the tables are.
 */
export function buildColumns(defs: GlobalDefs): ColumnDef[] {
  const slotStatuses: ColumnDef[] = defs.effects
    .filter((status) => status.id !== NEUTRAL_STATUS_ID)
    .map((status) => ({
      id: slotStatusColumnId(status.id),
      group: "statistic" as const,
      label: `${status.icon || "•"}`,
      title: `Queue slots with status ${status.name}`,
      width: 56,
      metric: (s: LevelStats) => s.slotStatus.get(status.id) ?? 0,
    }));

  const cellStatuses: ColumnDef[] = defs.cellTypes
    .filter((status) => status.id !== NEUTRAL_STATUS_ID)
    .map((status) => ({
      id: cellStatusColumnId(status.id),
      group: "statistic" as const,
      label: `${status.icon || "•"}`,
      title: `Grid cells with status ${status.name}`,
      width: 56,
      metric: (s: LevelStats) => s.cellStatus.get(status.id) ?? 0,
    }));

  return [
    ...INFO_COLUMNS,
    ...GENERATOR_COLUMNS,
    ...CORE_STAT_COLUMNS,
    ...slotStatuses,
    ...GROUP_STAT_COLUMNS,
    ...cellStatuses,
    ...TAIL_STAT_COLUMNS,
    ...TRAILING_COLUMNS,
  ];
}

/** CSS custom property one column's resolved width is published under. */
export const widthVar = (columnId: string): string => `--lp-w-${columnId}`;
