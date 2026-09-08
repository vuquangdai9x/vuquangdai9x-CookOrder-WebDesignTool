import type { CustomerSpaceHeight } from "../../core/nodeCustomerSpace.ts";

export type CustomerCardViewMode = "full" | "composite" | "auto";
export type CustomerCardDragKind = "customer" | "dish" | null;

export function isCompositeCustomerView(mode: CustomerCardViewMode, dragKind: CustomerCardDragKind): boolean {
  return mode === "composite" || (mode === "auto" && dragKind === "customer");
}

export interface CompositeSlotItem<T> {
  height: CustomerSpaceHeight;
  value: T;
}

export interface PackedCompositeColumn<T> {
  height: CustomerSpaceHeight;
  values: T[];
}

/** Full dishes get individual columns; Half dishes are repacked two per column. */
export function packCompositeSlots<T>(items: readonly CompositeSlotItem<T>[]): PackedCompositeColumn<T>[] {
  const full = items
    .filter((item) => item.height === "Full")
    .map((item) => ({ height: "Full" as const, values: [item.value] }));
  const half = items.filter((item) => item.height === "Half").map((item) => item.value);
  const halfColumns: PackedCompositeColumn<T>[] = [];
  for (let index = 0; index < half.length; index += 2) {
    halfColumns.push({ height: "Half", values: half.slice(index, index + 2) });
  }
  return [...full, ...halfColumns];
}

/** Stable, distinct badge colour for every practical integer footprint. */
export function customerSpaceWidthColor(width: number): string {
  const wholeWidth = Math.max(0, Math.round(width));
  return `hsl(${(wholeWidth * 67 + 208) % 360} 72% 42%)`;
}
