import type { PackingMode, ToolProcessBehavior } from "../core/types.ts";

export const PRODUCTION_BEHAVIOR_SEMANTICS_VERSION = "2026-09-15-default-v1";

export const PRODUCTION_BEHAVIOR: Readonly<{
  packingMode: PackingMode;
  toolProcessBehavior: ToolProcessBehavior;
  outOfSlotPolicy: "park-on-grid";
}> = Object.freeze({
  packingMode: "unpacked-raw",
  toolProcessBehavior: "auto",
  outOfSlotPolicy: "park-on-grid",
});

export function productionBehaviorEvidence(): Record<string, string> {
  return {
    ...PRODUCTION_BEHAVIOR,
    semanticsVersion: PRODUCTION_BEHAVIOR_SEMANTICS_VERSION,
  };
}
