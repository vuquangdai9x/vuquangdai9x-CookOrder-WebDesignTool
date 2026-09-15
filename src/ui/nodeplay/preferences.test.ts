import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PLAY_PACKING_MODE,
  DEFAULT_PLAY_TOOL_PROCESS_BEHAVIOR,
  playPackingMode,
  playToolProcessBehavior,
  setPlayPackingMode,
  setPlayToolProcessBehavior,
} from "./preferences.ts";

describe("Play preferences", () => {
  beforeEach(() => {
    setPlayPackingMode(DEFAULT_PLAY_PACKING_MODE);
    setPlayToolProcessBehavior(DEFAULT_PLAY_TOOL_PROCESS_BEHAVIOR);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("defaults to the two historical behaviors", () => {
    expect(playPackingMode()).toBe("packing-raw");
    expect(playToolProcessBehavior()).toBe("auto");
  });

  it("retains changed behaviors for the next Play view", () => {
    setPlayPackingMode("unpacked-raw");
    setPlayToolProcessBehavior("wait-order");
    expect(playPackingMode()).toBe("unpacked-raw");
    expect(playToolProcessBehavior()).toBe("wait-order");
  });

  it("restores both selections after the module is reloaded", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });

    vi.resetModules();
    const firstLoad = await import("./preferences.ts");
    firstLoad.setPlayPackingMode("unpacked-raw");
    firstLoad.setPlayToolProcessBehavior("wait-order");

    vi.resetModules();
    const refreshed = await import("./preferences.ts");
    expect(refreshed.playPackingMode()).toBe("unpacked-raw");
    expect(refreshed.playToolProcessBehavior()).toBe("wait-order");
  });
});
