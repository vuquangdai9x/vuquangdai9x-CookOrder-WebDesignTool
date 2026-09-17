import type { NodeCustomerConfig } from "../../core/nodeParser.ts";
import type { GraphIndex } from "../../core/nodeIndex.ts";
import type { IdIndex } from "../../data/nodeIdTable.ts";
import type { LevelData } from "../../data/mapLoader.ts";
import type { ProjectedMap } from "../../data/nodeGraphToMapDef.ts";
import {
  applyWorkspaceEnvelopeToLevel,
  decodeCustomerPhaseData,
  decodePickupPhaseData,
  decodeQueuePhaseData,
  workspaceEnvelopeFromLevel,
  type GeneratorWorkspaceEnvelopeV2,
} from "../../data/generatorPersistence/index.ts";
import type { EstimateScenario } from "../design/estimateScenario.ts";
import type { GenerateLevelResult } from "../levelpath/generateLevel.ts";
import { openQueueFirstWorkspace } from "../queue-first/index.ts";
import { openCustomerFirstWorkspace } from "./customerFirstWorkspace.ts";

export interface UnifiedGeneratorWorkspaceOptions {
  mapId: string;
  level: LevelData;
  ix: GraphIndex;
  ids: IdIndex;
  projected: ProjectedMap;
  currentCustomers(): NodeCustomerConfig[];
  scenario?: EstimateScenario;
  onGenerated(result: GenerateLevelResult): void;
  onChanged(): void;
  onClosed?(): void;
}

/** Owns the one persisted envelope while each strategy owns its specialized draft and canvas. */
export function openUnifiedGeneratorWorkspace(options: UnifiedGeneratorWorkspaceOptions): void {
  let envelope = workspaceEnvelopeFromLevel(options.level, options.ix, options.ids, options.projected);
  let finallyClosed = false;

  const persist = (next: GeneratorWorkspaceEnvelopeV2): void => {
    const hashes: GeneratorWorkspaceEnvelopeV2["queueFirst"] = {};
    try { if (options.level.queuePhaseData) hashes.queuePhaseHash = decodeQueuePhaseData(options.level.queuePhaseData).contentHash; } catch { /* surfaced by Queue-first recovery */ }
    try { if (options.level.pickupPhaseData) hashes.pickupPhaseHash = decodePickupPhaseData(options.level.pickupPhaseData).contentHash; } catch { /* surfaced by Queue-first recovery */ }
    try { if (options.level.customerPhaseData) hashes.customerPhaseHash = decodeCustomerPhaseData(options.level.customerPhaseData).contentHash; } catch { /* surfaced by Queue-first recovery */ }
    next.queueFirst = hashes;
    envelope = applyWorkspaceEnvelopeToLevel(options.level, next, options.ix, options.ids, options.projected);
    options.onChanged();
  };
  const close = (): void => {
    if (finallyClosed) return;
    finallyClosed = true;
    options.onClosed?.();
  };
  const open = (strategy: "customer-first" | "queue-first"): void => {
    envelope.activeStrategy = strategy;
    persist(envelope);
    if (strategy === "customer-first") {
      openCustomerFirstWorkspace({
        ...options,
        envelope,
        onEnvelopeChanged: persist,
        onSwitchToQueue: () => open("queue-first"),
        onClosed: close,
      });
    } else {
      openQueueFirstWorkspace({
        mapId: options.mapId,
        level: options.level,
        ix: options.ix,
        ids: options.ids,
        projected: options.projected,
        sharedProfile: envelope.shared,
        onSharedProfileChanged: (profile) => {
          envelope.shared = profile;
          persist(envelope);
        },
        onSwitchToCustomer: () => open("customer-first"),
        // Queue-first writes its phase cell first; refreshing the envelope here
        // records the new phase hashes without translating either strategy's draft.
        onChanged: () => persist(envelope),
        onClosed: close,
      });
    }
  };
  open(envelope.activeStrategy);
}
