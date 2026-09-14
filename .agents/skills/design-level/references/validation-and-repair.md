# Evidence-led validation and repair

Use findings to choose a local repair; never auto-apply suggestions.

## Supply and dishes

- Missing pickup: add the named raw pickup count, or simplify the dishes causing demand.
- Excess pickup: remove or replace a slot while preserving authorized geometry and flow.
- Invalid piece or quantity: inspect the dish and use a valid option within its cap.
- Missing prerequisite: add the required base before its dependent piece.
- Provisional supply: create matching demand or replace/remove it, then clear the provisional marker.

## Queue and board

- Broken combined geometry: reconnect through four-neighbor cells.
- Group overlap: keep each stable slot ID in at most one group.
- Freeze deadlock: move a thaw-enabling pickup earlier or reduce the authorized freeze parameter.
- Missing key: add matching key supply early enough, or reduce authorized lock demand.
- Capacity or tool deadlock: change ordering, lane distribution, concurrent demand, or dish complexity so work can drain.
- Early grid pressure: move unlock progress earlier, simplify concurrent work, or restore ordinary capacity.

## Customers and difficulty

- Admission pressure: account for the two-customer cap and abstract order width.
- Boss barrier: report the preview consequence; never silently move the boss.
- Timeout: a win still fails fundamental validity. Repair timing, demand, or ordering.
- Difficulty miss: adjust ordinary controls first. Propose a special mechanic only after evidence shows they are insufficient.

Re-run supply demand after changing customers, dishes, yields, or queues. Run full validation after structural or mechanic changes. A complete tuning cycle ends with validation, estimate, and instant playtest.
