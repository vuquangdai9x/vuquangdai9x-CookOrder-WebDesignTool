import { describe, expect, it } from "vitest";

import { quantizeScrub } from "./scrubInput.ts";

describe("scrub input quantization", () => {
  it("never leaks fractional values from integer-only fields", () => {
    expect(quantizeScrub(3.49, 0)).toBe(3);
    expect(quantizeScrub(3.5, 0)).toBe(4);
  });
});
