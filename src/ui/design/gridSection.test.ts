import { describe, expect, it } from "vitest";

import { resizeGridString } from "./gridSection.ts";

describe("resizeGridString", () => {
  it("pads every level grid to the configured map capacity", () => {
    expect(resizeGridString(",,", 3, 2).split(",")).toHaveLength(6);
  });

  it("truncates trailing cells when the map capacity shrinks", () => {
    expect(resizeGridString(",,,,", 2, 1)).toBe(",");
  });
});
