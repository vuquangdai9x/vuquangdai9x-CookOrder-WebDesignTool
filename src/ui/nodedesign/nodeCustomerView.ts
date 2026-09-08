export type CustomerCardViewMode = "full" | "composite" | "auto";

export function isCompositeCustomerView(mode: CustomerCardViewMode, reordering: boolean): boolean {
  return mode === "composite" || (mode === "auto" && reordering);
}

/** Stable, distinct badge colour for every practical integer footprint. */
export function customerSpaceWidthColor(width: number): string {
  const wholeWidth = Math.max(0, Math.round(width));
  return `hsl(${(wholeWidth * 67 + 208) % 360} 72% 42%)`;
}
