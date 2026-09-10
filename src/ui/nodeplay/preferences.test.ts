import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PLAY_OUT_OF_SLOT_POLICY,
  playOutOfSlotPolicy,
  setPlayOutOfSlotPolicy,
} from "./preferences.ts";

describe("Play preferences", () => {
  beforeEach(() => setPlayOutOfSlotPolicy(DEFAULT_PLAY_OUT_OF_SLOT_POLICY));

  it("defaults full tools to parking raw ingredients on the grid", () => {
    expect(playOutOfSlotPolicy()).toBe("park-on-grid");
  });

  it("retains a changed policy for the next Play view", () => {
    setPlayOutOfSlotPolicy("block-pick");
    expect(playOutOfSlotPolicy()).toBe("block-pick");
  });
});
