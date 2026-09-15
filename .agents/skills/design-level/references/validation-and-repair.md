# Evidence-led validation and repair

Use confirmed constraint gaps and comparable evidence to choose a local repair; never auto-apply
suggestions. Keep picking-order deadlock, grid pressure, timeout, supply, and the legacy tool/grid
diagnostic as separate evidence domains.

## Supply and dishes

- Missing pickup: add the named raw pickup count, or simplify the dishes causing demand.
- Excess pickup: remove or replace a slot while preserving authorized geometry and flow.
- Invalid piece or quantity: inspect the dish and use a valid option within its cap.
- Missing prerequisite: add the required base before its dependent piece.
- Provisional supply: create matching demand or replace/remove it, then clear the provisional marker.

## Queue and board

- Broken combined geometry: reconnect through four-neighbor cells.
- Group overlap: keep each stable slot ID in at most one group.
- Picking-order deadlock: inspect a retained sequence/state and move, unfreeze, or unlink the exact
  Queue X, line Y slots. Do not count grid state in the picking deadlock rate.
- Missing key: add matching key supply early enough, or reduce authorized lock demand.
- Legacy tool/grid diagnostic: preserve it as supporting evidence; change ordering, lane distribution,
  concurrent demand, or dish complexity only when the confirmed requirements make that relevant.
- Early grid pressure: split/move dormant amounts, move unlock progress earlier, simplify concurrent
  work, or restore ordinary capacity.

## Amounts

- Early dormant ordinary bag: split it and move the refill nearer its later customer wave.
- Long-lived reusable object: split reusable serves across waves unless the brief prefers persistence.
- Low amount utilization: merge nearby same-ingredient demand within `stackRange`, then simulate.
- Unused amount: reduce/split the slot or correct demand/yield provenance; never hide excess in totals.
- Amount-caused occupancy spike: prefer later refills or smaller partitions without changing supply.

## Customers and difficulty

- Admission pressure: account for the two-customer cap and abstract order width.
- Boss barrier: report the preview consequence; never silently move the boss.
- Timeout: a win still fails fundamental validity. Repair timing, demand, or ordering.
- Difficulty miss: adjust ordinary controls first. Propose a special mechanic only after evidence shows they are insufficient.

Re-run supply demand after changing customers, dishes, yields, amounts, or queues. Use a shared seed
set for candidate comparisons. A complete tuning cycle ends with structural validation, constraint
evaluation, and instant/batch playtest appropriate to the current phase.
