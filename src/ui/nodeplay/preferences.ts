import type { PackingMode, ToolProcessBehavior } from "../../core/types.ts";

export const DEFAULT_PLAY_PACKING_MODE: PackingMode = "packing-raw";
export const DEFAULT_PLAY_TOOL_PROCESS_BEHAVIOR: ToolProcessBehavior = "auto";
const STORAGE_KEY = "cookorder-play-behaviors";

let selectedPackingMode: PackingMode = DEFAULT_PLAY_PACKING_MODE;
let selectedToolProcessBehavior: ToolProcessBehavior = DEFAULT_PLAY_TOOL_PROCESS_BEHAVIOR;

// Play is reconstructed whenever its map or level changes. Browser storage
// keeps both choices across those rebuilds and a full page refresh; defensive
// parsing leaves tests/private browsing on the stable defaults.
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const stored = JSON.parse(raw) as Record<string, unknown>;
    if (stored.packingMode === "packing-raw" || stored.packingMode === "unpacked-raw") {
      selectedPackingMode = stored.packingMode;
    }
    if (stored.toolProcessBehavior === "auto" || stored.toolProcessBehavior === "wait-order") {
      selectedToolProcessBehavior = stored.toolProcessBehavior;
    }
  }
} catch {
  // localStorage is unavailable or malformed — keep the defaults.
}

function persist(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      packingMode: selectedPackingMode,
      toolProcessBehavior: selectedToolProcessBehavior,
    }));
  } catch (err) {
    console.warn("Could not persist Play behavior settings", err);
  }
}

export function playPackingMode(): PackingMode {
  return selectedPackingMode;
}

export function setPlayPackingMode(mode: PackingMode): void {
  selectedPackingMode = mode;
  persist();
}

export function playToolProcessBehavior(): ToolProcessBehavior {
  return selectedToolProcessBehavior;
}

export function setPlayToolProcessBehavior(behavior: ToolProcessBehavior): void {
  selectedToolProcessBehavior = behavior;
  persist();
}
