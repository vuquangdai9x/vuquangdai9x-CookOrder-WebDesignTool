// Independent graph readouts for Design mode. These live at the page level so
// changing between Current and Split layout never moves either analysis into a
// section column.

import { button, el } from "../dom.ts";
import type { EstimateResult } from "../design/estimateDifficulty.ts";
import { occupancyChartEl } from "../design/occupancyChart.ts";
import type { ChartVisibility } from "../design/occupancyChart.ts";

export type AnalysisKind = "estimate" | "solvability";

export type AnalysisFoldoutUi = { open: boolean } & ChartVisibility;

export function defaultAnalysisFoldoutUi(): AnalysisFoldoutUi {
  return { open: false, scoredTint: true, randomTint: true, completeLines: true };
}

export function analysisFoldout(
  result: EstimateResult | null,
  kind: AnalysisKind,
  ui: AnalysisFoldoutUi,
  onReplay: () => void,
  onChange: () => void,
): HTMLElement {
  const label = kind === "solvability" ? "Check Solvable" : "Estimate Difficulty";
  const toggle = button(ui.open ? "▾" : "▸", () => {
    if (!result) return;
    ui.open = !ui.open;
    onChange();
  }, {
    class: "icon-btn",
    title: result ? `Show ${label.toLowerCase()} grid occupancy` : `Run ${label} to create this graph`,
  }) as HTMLButtonElement;
  toggle.disabled = !result;
  const replay = button("▶ Replay", onReplay, {
    class: "analysis-replay-btn",
    title: kind === "solvability"
      ? "Replay the most recent omniscient solvability run"
      : "Replay the most recent difficulty estimate",
  }) as HTMLButtonElement;
  replay.disabled = !(result?.replaySteps.length);

  if (!result) {
    return el("section", { class: "design-analysis-foldout empty" }, [
      el("div", { class: "estimate-bar" }, [
        toggle,
        el("strong", {}, [label]),
        el("span", { class: "estimate-reason" }, ["Not run yet."]),
        replay,
      ]),
    ]);
  }

  const peakWaste = result.perCustomer.reduce((n, customer) => Math.max(n, customer.gridWaste), 0);
  const detours = result.perCustomer.reduce((n, customer) => n + customer.detours, 0);
  const inconclusive = kind === "solvability" && result.searchLimitReached;
  const summary = inconclusive
    ? `inconclusive — bounded branches pruned after ${result.searchStatesExplored ?? 0} states`
    : result.solvable
    ? `solvable — ${result.totalPicks} picks for ${result.servedCount} customers`
    : `unsolvable — served ${result.servedCount} of ${result.totalCustomers} after ${result.totalPicks} picks`;
  const parts: Array<string | HTMLElement> = [
    toggle,
    el("strong", {}, [`${result.solvable ? "✓" : "⚠"} ${label}: ${summary}`]),
  ];

  if ((result.attemptCount ?? 1) > 1) {
    const learned = result.learnedFromFailures ?? 0;
    const attempted = result.attemptedStrategyNames ?? [];
    parts.push(el("span", {
      class: "estimate-metric",
      ...(attempted.length > 0 ? { title: `Attempt order: ${attempted.join(" → ")}` } : {}),
    }, [
      `${result.strategyName ?? "alternate"} strategy · ${result.attemptCount} attempts` +
      (learned > 0 ? ` · learned from ${learned} failure${learned === 1 ? "" : "s"}` : ""),
    ]));
  }
  if (result.reason) parts.push(el("span", { class: "estimate-reason" }, [result.reason]));

  const timedOutCustomers = result.timedOutCustomers ?? [];
  if (timedOutCustomers.length > 0) {
    const timeoutNote = kind === "solvability"
      ? " Solvability ignores customer patience; this does not change the verdict."
      : "";
    parts.push(el("span", { class: "estimate-warning" }, [
      `Warning: customer${timedOutCustomers.length === 1 ? "" : "s"} ` +
      `${timedOutCustomers.join(", ")} timed out during this run.${timeoutNote}`,
    ]));
  }
  parts.push(
    el("span", { class: "estimate-metric" }, [`peak waste ${peakWaste}`]),
    el("span", { class: "estimate-metric" }, [`${detours} detour${detours === 1 ? "" : "s"}`]),
    replay,
  );

  const bar = el("div", { class: `estimate-bar${result.solvable ? "" : " unsolvable"}` }, parts);
  const children: HTMLElement[] = [bar];
  if (ui.open) {
    children.push(occupancyChartEl(result.occupancyHistory, result.gridCapacity, ui, (key) => {
      ui[key] = !ui[key];
      onChange();
    }));
  }
  return el("section", { class: `design-analysis-foldout${ui.open ? " open" : ""}` }, children);
}
