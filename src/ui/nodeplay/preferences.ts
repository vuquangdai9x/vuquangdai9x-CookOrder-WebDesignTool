import type { OutOfSlotPolicy } from "../../core/types.ts";

export const DEFAULT_PLAY_OUT_OF_SLOT_POLICY: OutOfSlotPolicy = "park-on-grid";

// Play is reconstructed whenever its map or level changes. Keep this preference
// at module scope so the next view inherits the user's current selection.
let selectedOutOfSlotPolicy: OutOfSlotPolicy = DEFAULT_PLAY_OUT_OF_SLOT_POLICY;

export function playOutOfSlotPolicy(): OutOfSlotPolicy {
  return selectedOutOfSlotPolicy;
}

export function setPlayOutOfSlotPolicy(policy: OutOfSlotPolicy): void {
  selectedOutOfSlotPolicy = policy;
}
