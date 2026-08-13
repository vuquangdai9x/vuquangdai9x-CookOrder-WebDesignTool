// One stable colour per customer index, shared by the customer cards and the
// queue tiles so a designer can read "this tile is for that customer" at a
// glance. Used by the Estimate Difficulty readout (see estimateDifficulty.ts).

/** Cycled by customer index — consecutive indices always land on different colors. */
export const PALETTE: readonly string[] = [
  "#e05a5a",
  "#f0a441",
  "#e0d34a",
  "#6bbf59",
  "#4ad0b0",
  "#5aa7e0",
  "#8f7ae0",
  "#e05ac0",
];

export function customerColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}
