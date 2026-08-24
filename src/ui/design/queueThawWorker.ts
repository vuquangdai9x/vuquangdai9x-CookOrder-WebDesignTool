// Worker host for the ice audit's full run — see queueThawCheck.ts.
//
// The quick audit the Validate Ice button runs is time-boxed, so a big frozen
// queue (five lanes of twenty-odd slots is over a million reachable states)
// comes back truncated: "no dead end found YET" rather than "none exists".
// Finishing that walk takes tens of seconds, which would freeze the editor on
// the main thread, so the panel's "Run full check" hands it here instead.

import { checkQueueThaw } from "./queueThawCheck.ts";
import type { ThawCheckOptions } from "./queueThawCheck.ts";
import type { QueueGroup, QueueItem } from "../../core/types.ts";

export interface ThawWorkerRequest {
  queues: QueueItem[][];
  groups: QueueGroup[];
  opts: ThawCheckOptions;
}

self.onmessage = (event: MessageEvent<ThawWorkerRequest>) => {
  const { queues, groups, opts } = event.data;
  try {
    self.postMessage({ ok: true, report: checkQueueThaw(queues, groups, opts) });
  } catch (err) {
    self.postMessage({ ok: false, error: (err as Error).message });
  }
};
