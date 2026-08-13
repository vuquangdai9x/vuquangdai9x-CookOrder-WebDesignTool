import { describe, expect, it } from "vitest";
import { PALETTE, customerColor } from "./customerColors.ts";

describe("customerColor", () => {
  it("never repeats between consecutive indices", () => {
    for (let i = 0; i < 20; i++) {
      expect(customerColor(i)).not.toBe(customerColor(i + 1));
    }
  });

  it("cycles the palette", () => {
    expect(customerColor(0)).toBe(PALETTE[0]);
    expect(customerColor(PALETTE.length)).toBe(PALETTE[0]);
  });
});
