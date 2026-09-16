// Third page-level Design analysis: cheap authored-level counts plus the MCP
// evaluation catalog, rendered with a representation suited to each value.

import type { GlobalDefs } from "../../core/types.ts";
import { listConstraintMetrics, type ConstraintMetricDefinition } from "../../mcp/constraintCatalog.ts";
import type { ConstraintValue } from "../../mcp/types.ts";
import { button, el } from "../dom.ts";
import type { EstimateProgress } from "../design/estimateDifficulty.ts";
import type { StatisticReport } from "../design/statisticsReport.ts";

export interface StatisticsFoldoutUi { open: boolean }

interface StaticMetric {
  label: string;
  value: number | string;
  title: string;
}

const formatNumber = (value: number): string => {
  if (Number.isInteger(value)) return value.toLocaleString();
  if (Math.abs(value) >= 100) return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
};

function staticMetrics(report: StatisticReport, defs: GlobalDefs): StaticMetric[] {
  const stats = report.levelStats;
  const base: StaticMetric[] = [
    { label: "Customers", value: stats.numCustomers, title: "Customers in the authored arrival sequence." },
    { label: "Timed customers", value: stats.numTimedCustomers, title: "Customers whose wait time is above zero." },
    { label: "Dishes", value: stats.numDishes, title: "Total dishes ordered by all customers." },
    { label: "Ordered ingredients", value: stats.numIngredients, title: "Resolved ingredient slots across all ordered dishes." },
    { label: "Total coin", value: stats.totalCoin, title: "Sum of prices for all resolved ordered ingredient slots." },
    { label: "Concrete ingredient price", value: stats.totalPrice, title: "Price sum of concrete ingredients written directly in dish combinations." },
    { label: "Queue item types", value: stats.itemTypes, title: "Distinct ingredient IDs present in the queues." },
    { label: "Queue lanes", value: stats.numLanes, title: "Number of authored queue lanes." },
    { label: "Queue slots", value: stats.numQueueItems, title: "Number of authored queue slots before amount expansion." },
    { label: "Expanded queue pieces", value: stats.numQueuePieces, title: "Physical queue pieces after expanding amount values." },
    { label: "Linked slots", value: stats.linkedSlots, title: "Queue slots that belong to linked groups." },
    { label: "Combined slots", value: stats.combinedSlots, title: "Queue slots that belong to combined groups." },
    { label: "Lock & Key", value: stats.lockAndKey, title: "Key-carrying queue slots plus color-locked grid cells." },
    { label: "Parse errors", value: stats.parseErrors.length, title: stats.parseErrors.length ? stats.parseErrors.join("\n") : "No customer, queue, or grid parse errors." },
  ];
  for (const status of defs.effects.filter((row) => row.id !== 0)) {
    base.push({
      label: `${status.icon || "•"} Queue: ${status.name}`,
      value: stats.slotStatus.get(status.id) ?? 0,
      title: `Queue slots carrying ${status.name} (status ${status.id}).`,
    });
  }
  for (const status of defs.cellTypes.filter((row) => row.id !== 0)) {
    base.push({
      label: `${status.icon || "•"} Grid: ${status.name}`,
      value: stats.cellStatus.get(status.id) ?? 0,
      title: `Grid cells carrying ${status.name} (status ${status.id}).`,
    });
  }
  return base;
}

function valueCard(metric: StaticMetric): HTMLElement {
  return el("div", { class: "stat-value-card", title: metric.title }, [
    el("span", { class: "stat-value-label" }, [metric.label]),
    el("strong", { class: "stat-value" }, [String(metric.value)]),
  ]);
}

function distributionRows(value: ConstraintValue): HTMLElement {
  let rows: Array<[string, number]> = [];
  try {
    const parsed = typeof value === "string"
      ? JSON.parse(value) as Record<string, number>
      : !Array.isArray(value) && typeof value === "object" ? value : {};
    rows = Object.entries(parsed).sort((left, right) => right[1] - left[1]);
  } catch { /* an invalid distribution is displayed as empty */ }
  if (!rows.length) return el("span", { class: "stat-empty" }, ["No stuck reasons"]);
  const maximum = Math.max(1, ...rows.map((row) => row[1]));
  return el("div", { class: "stat-distribution" }, rows.map(([label, count]) => {
    const row = el("div", { class: "stat-distribution-row", title: `${label}: ${count} sampled case(s)` }, [
      el("span", { class: "stat-distribution-label" }, [label]),
      el("span", { class: "stat-distribution-track" }, [
        el("span", { class: "stat-distribution-fill", "aria-hidden": "true" }),
      ]),
      el("strong", {}, [String(count)]),
    ]);
    row.style.setProperty("--stat-ratio", `${count / maximum * 100}%`);
    return row;
  }));
}

function metricCard(definition: ConstraintMetricDefinition, value: ConstraintValue | undefined, report: StatisticReport): HTMLElement {
  const note = report.notes[definition.id];
  const interval = report.confidenceIntervals[definition.id];
  const tooltip = [definition.description, note, interval ? `95% interval: ${interval.map((n) => `${Math.round(n * 100)}%`).join("–")}.` : ""]
    .filter(Boolean).join("\n");
  if (value === undefined) {
    return el("div", { class: "stat-metric-card unavailable", title: tooltip }, [
      el("span", { class: "stat-value-label" }, [definition.id.split(".").at(-1) ?? definition.id]),
      el("strong", {}, ["N/A"]),
    ]);
  }
  if (definition.valueType === "distribution") {
    return el("div", { class: "stat-metric-card distribution", title: tooltip }, [
      el("span", { class: "stat-value-label" }, [definition.id.split(".").at(-1) ?? definition.id]),
      distributionRows(value),
    ]);
  }
  if (definition.valueType === "boolean") {
    const yes = value === true;
    return el("div", { class: `stat-metric-card boolean ${yes ? "pass" : "fail"}`, title: tooltip }, [
      el("span", { class: "stat-value-label" }, [definition.id.split(".").at(-1) ?? definition.id]),
      el("strong", {}, [yes ? "✓ Yes" : "✕ No"]),
    ]);
  }
  if (definition.valueType === "ratio" && typeof value === "number") {
    const percent = Math.max(0, Math.min(100, value * 100));
    const card = el("div", { class: "stat-metric-card ratio", title: tooltip }, [
      el("div", { class: "stat-metric-line" }, [
        el("span", { class: "stat-value-label" }, [definition.id.split(".").at(-1) ?? definition.id]),
        el("strong", {}, [`${formatNumber(value * 100)}%`]),
      ]),
      el("span", { class: "stat-ratio-track" }, [el("span", { class: "stat-ratio-fill", "aria-hidden": "true" })]),
    ]);
    card.style.setProperty("--stat-ratio", `${percent}%`);
    return card;
  }
  const rendered = typeof value === "number" ? formatNumber(value) : String(value);
  return el("div", { class: "stat-metric-card", title: tooltip }, [
    el("span", { class: "stat-value-label" }, [definition.id.split(".").at(-1) ?? definition.id]),
    el("strong", {}, [rendered]),
    el("small", {}, [definition.unit]),
  ]);
}

function reportBody(report: StatisticReport, defs: GlobalDefs): HTMLElement {
  const root = el("div", { class: "statistics-report" });
  const outcome = el("div", { class: `statistics-outcome ${report.passed ? "pass" : "fail"}` }, [
    el("strong", {}, [report.passed ? "✓ Evaluation passed" : "⛔ Evaluation failed"]),
    el("span", {}, [`Tuning profile · ${report.runs} simulations · ${report.referenceSampleCount} saved reference level(s)`]),
  ]);
  root.append(outcome);
  if (report.hardFailures.length) {
    root.append(el("div", { class: "statistics-failures" }, report.hardFailures.map((failure) =>
      el("div", { title: failure.code }, [`${failure.code}: ${failure.message}`]))));
  }
  const failReasons = Object.entries(report.failReasons).sort((left, right) => right[1] - left[1]);
  if (failReasons.length) {
    root.append(el("div", { class: "statistics-failures muted" }, failReasons.map(([reason, count]) =>
      el("div", { title: "Simulation failure reason and occurrence count" }, [`${count}× ${reason}`]))));
  }

  root.append(
    el("section", { class: "statistics-dimension" }, [
      el("h3", {}, ["Level statistics"]),
      el("div", { class: "stat-card-grid static" }, staticMetrics(report, defs).map(valueCard)),
    ]),
  );
  const definitions = listConstraintMetrics();
  const dimensions = [...new Set(definitions.map((row) => row.dimension))];
  for (const dimension of dimensions) {
    const rows = definitions.filter((row) => row.dimension === dimension);
    root.append(el("section", { class: "statistics-dimension" }, [
      el("h3", {}, [dimension.replace(/(^|-)([a-z])/g, (_all, dash, letter) => `${dash ? " " : ""}${letter.toUpperCase()}`)]),
      el("div", { class: "stat-card-grid" }, rows.map((definition) =>
        metricCard(definition, report.metrics[definition.id], report))),
    ]));
  }
  return root;
}

export function openStatisticsModal(report: StatisticReport, defs: GlobalDefs): void {
  const close = (): void => overlay.remove();
  const overlay = el("div", { class: "overlay-panel statistics-modal" }, [
    el("div", { class: "definitions-head statistics-modal-head" }, [
      el("h2", {}, ["Level Statistic & MCP Evaluation"]),
      button("✕ Close", close, { class: "primary" }),
    ]),
    el("div", { class: "auto-generate-panel auto-generate-sheet statistics-modal-sheet" }, [reportBody(report, defs)]),
  ]);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  document.body.append(overlay);
}

export function statisticsFoldout(
  report: StatisticReport | null,
  defs: GlobalDefs,
  ui: StatisticsFoldoutUi,
  onOpenModal: () => void,
  onChange: () => void,
  progress: EstimateProgress | null,
): HTMLElement {
  const toggle = button(ui.open ? "▾" : "▸", () => {
    if (!report) return;
    ui.open = !ui.open;
    onChange();
  }, { class: "icon-btn", title: report ? "Show or hide the statistic report" : "Run Statistic to create this report" });
  toggle.disabled = !report;
  const details = button("↗ Details", onOpenModal, {
    class: "analysis-replay-btn",
    title: "Open the full statistic and MCP evaluation report in a modal",
  });
  details.disabled = !report;

  if (progress) {
    const percentage = Math.round(progress.percentage);
    const bar = el("div", { class: "estimate-bar analysis-running" }, [
      el("span", { class: "analysis-progress-fill", "aria-hidden": "true" }),
      toggle,
      el("strong", {}, ["Statistic: running…"]),
      el("span", { class: "analysis-progress-label" }, [
        `${percentage}% · run ${progress.run}/${progress.runTotal} · ${progress.pickedItems}/${progress.totalItems} queue items`,
      ]),
      details,
    ]);
    bar.style.setProperty("--analysis-progress", `${progress.percentage}%`);
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(percentage));
    return el("section", { class: `design-analysis-foldout running${ui.open && report ? " open" : ""}`, "data-analysis-kind": "statistics" }, [
      bar,
      ...(ui.open && report ? [reportBody(report, defs)] : []),
    ]);
  }

  if (!report) {
    return el("section", { class: "design-analysis-foldout empty", "data-analysis-kind": "statistics" }, [
      el("div", { class: "estimate-bar" }, [
        toggle,
        el("strong", {}, ["Statistic"]),
        el("span", { class: "estimate-reason" }, ["Not run yet."]),
        details,
      ]),
    ]);
  }
  const winRate = Number(report.metrics["experience.winRate"] ?? 0);
  const bar = el("div", { class: `estimate-bar${report.passed ? "" : " unsolvable"}` }, [
    toggle,
    el("strong", {}, [`${report.passed ? "✓" : "⚠"} Statistic: ${report.passed ? "passed" : "issues found"}`]),
    el("span", { class: "estimate-metric", title: report.confidenceIntervals["experience.winRate"]
      ? `95% interval: ${report.confidenceIntervals["experience.winRate"].map((n) => `${Math.round(n * 100)}%`).join("–")}`
      : "" }, [`${Math.round(winRate * 100)}% win rate · ${report.runs} runs`]),
    el("span", { class: "estimate-metric" }, [`${report.hardFailures.length} hard failure(s)`]),
    details,
  ]);
  return el("section", { class: `design-analysis-foldout${ui.open ? " open" : ""}`, "data-analysis-kind": "statistics" }, [
    bar,
    ...(ui.open ? [reportBody(report, defs)] : []),
  ]);
}
